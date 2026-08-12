'use strict';
// Avatar manifest resolution: turn a manifest address supplied in
// avatar-offer into an avatar asset URL, plus whatever app-specific
// facets the deployment asked for.
//
// This is the orchestrator for the Universal Manifest six-stage
// evaluation sequence — Arrive, Verify, Project, Consent, Compose,
// Receipt — running the four modules beside it in order. It sits in
// FRONT of the existing avatar pipeline: everything it produces is an
// ordinary asset URL, which DefaultAvatarValidator then fetches and
// measures exactly as it would a URL the client had supplied directly.
// Nothing downstream of here knows a manifest was involved.
//
// The fetch deserves particular care. It is a server-side HTTPS request
// to a URL the client chose, which is the same SSRF exposure the asset
// fetch has — so it reuses avatar_validator.defaultFetcher rather than
// calling node:https itself. That fetcher already resolves the hostname
// once, refuses private/loopback/link-local/metadata addresses, connects
// to the resolved IP with SNI intact so a rebind cannot slip past,
// re-runs the check on every redirect hop, and aborts mid-stream on the
// byte cap. Reimplementing any of that here would be a bug waiting to
// happen.

const { defaultFetcher, LruCache }	= require('../client/avatar_validator.js');
const { redactUrl }					= require('../utils/redact.js');
const mf							= require('../protocol/manifest.js');
const verify						= require('./verify.js');
const consent						= require('./consent.js');
const receipts						= require('./receipt.js');

// A manifest is a small JSON document. The asset it points at may be
// megabytes; the manifest itself has no business being one, and a
// generous cap here would just be a free amplification primitive.
const DEFAULT_MAX_BYTES		= 256 * 1024;
// Separate from and additional to the asset fetch budget. Two fetches
// now happen before an avatar appears, and their sum has to stay inside
// what a client will wait for.
const DEFAULT_TIMEOUT_MS	= 5000;
const DEFAULT_RESOLVER_BASE	= 'https://myum.net/';

// Extensions a resolved avatar URL may carry. Matches the relay rule in
// protocol/avatars.js — a URL that cannot be relayed is still perfectly
// usable, it just costs the server bandwidth, so this is not enforced
// here. Kept for the projection so callers can see it.
function isAbsoluteUrl(u)
{
	try { new URL(u); return true; }
	catch (e) { return false; }
}

// Build the URL to GET for a manifest address. `url` is used as-is;
// `umid` is appended to the resolver base. The UMID resolver accepts a
// path segment either URL-encoded or prefixed with `b64u:` and
// base64url-encoded; a UMID that already carries the prefix is passed
// through untouched.
function addressToUrl(manifestOffer, opts = {})
{
	const base = (opts.resolverBase || DEFAULT_RESOLVER_BASE);
	if (!manifestOffer || typeof manifestOffer !== 'object')
		return '';
	if (typeof manifestOffer.url === 'string' && manifestOffer.url.length)
		return manifestOffer.url;
	if (typeof manifestOffer.umid === 'string' && manifestOffer.umid.length)
	{
		const umid = manifestOffer.umid;
		const segment = umid.startsWith('b64u:')
			? 'b64u:' + encodeURIComponent(umid.slice('b64u:'.length))
			: encodeURIComponent(umid);
		return base.endsWith('/') ? base + segment : base + '/' + segment;
	}
	return '';
}

class IAvatarManifestResolver
{
	// eslint-disable-next-line no-unused-vars
	async resolve(manifestOffer, requirements)
	{
		throw new Error('IAvatarManifestResolver.resolve is abstract');
	}
}

class DefaultAvatarManifestResolver extends IAvatarManifestResolver
{
	constructor(opts = {})
	{
		super();
		this.fetcher		= opts.fetcher			|| defaultFetcher;
		this.resolverBase	= opts.resolverBase		|| DEFAULT_RESOLVER_BASE;
		this.allowedSchemes	= opts.allowedSchemes	|| ['https:'];
		// Schemes an avatar asset url may use. Deliberately separate from
		// the manifest's: they are different fetches, made by different
		// components, at different times. This one exists only to fail
		// fast with a clear reason — the authoritative check is
		// DefaultAvatarValidator's own allow-list and SSRF guard, which
		// runs when the asset is actually fetched.
		this.assetAllowedSchemes = opts.assetAllowedSchemes || ['https:'];
		this.maxRedirects	= opts.maxRedirects ?? 3;
		this.defaultMaxBytes = opts.maxBytes		|| DEFAULT_MAX_BYTES;
		this.defaultTimeoutMs = opts.timeoutMs		|| DEFAULT_TIMEOUT_MS;
		this.clockSkewMs	= opts.clockSkewMs ?? verify.DEFAULT_CLOCK_SKEW_MS;
		this.cache			= opts.cache			|| new LruCache(opts.cacheEntries || 256, opts.cacheBytes || 8 * 1024 * 1024);
		// Scope and purpose this server claims when gating facets. A
		// deployment that does more than read should say so.
		this.requiredScope	= opts.requiredScope	|| consent.DEFAULT_REQUIRED_SCOPE;
		this.purpose		= opts.purpose			|| '';
	}

	// Returns:
	//   { ok, reasons[], manifestUrl, avatarUrl, subject, projection, receipt, expiresAt }
	// `receipt` is always present once the document parsed, even on
	// failure — a rejection is a result the subject is entitled to see.
	async resolve(manifestOffer, requirements = {})
	{
		const req		= requirements || {};
		const maxBytes	= Number.isFinite(req.max_bytes) ? Math.min(req.max_bytes, this.defaultMaxBytes) : this.defaultMaxBytes;
		const timeoutMs	= Number.isFinite(req.timeout_ms) ? req.timeout_ms : this.defaultTimeoutMs;
		const accepted	= Array.isArray(req.accepted) && req.accepted.length ? req.accepted : mf.DEFAULT_ACCEPTED_CONTEXTS;
		const now		= Date.now();

		const manifestUrl = addressToUrl(manifestOffer, { resolverBase: req.resolver || this.resolverBase });
		if (!manifestUrl)
			return this._fail(['manifest_unresolvable'], '');

		if (!isAbsoluteUrl(manifestUrl))
			return this._fail(['manifest_unresolvable'], manifestUrl);

		const scheme = new URL(manifestUrl).protocol;
		if (!this.allowedSchemes.includes(scheme))
			return this._fail(['scheme_not_allowed'], manifestUrl);

		// A cached evaluation is reusable only while the manifest itself
		// is still valid. The UMID resolver serves Cache-Control:
		// max-age=60, but its own contract says consumers MUST enforce
		// expiresAt regardless of HTTP caching, so the manifest's TTL is
		// the hard bound and HTTP freshness can only shorten it.
		const cached = this.cache.get(manifestUrl);
		if (cached && Number.isFinite(cached.expiresAtMs) && cached.expiresAtMs > now)
			return Object.assign({}, cached.result, { fromCache: true });

		const fetched = await this.fetcher({
			url:			manifestUrl,
			maxBytes:		maxBytes,
			timeoutMs:		timeoutMs,
			maxRedirects:	this.maxRedirects,
			allowedSchemes:	this.allowedSchemes,
		});
		if (!fetched.ok)
		{
			// file_too_large is the fetcher's vocabulary for the asset
			// path; say what actually happened here.
			const reason = fetched.reason === 'file_too_large' ? 'manifest_too_large' : (fetched.reason || 'manifest_unresolvable');
			return this._fail([reason], manifestUrl);
		}

		// Stage 1 — Arrive.
		const arrived = mf.parseManifest(fetched.body.toString('utf8'), { accepted });
		if (!arrived.ok)
			return this._fail(arrived.reasons, manifestUrl);

		const manifest	= arrived.manifest;
		const receipt	= new receipts.Receipt(String(manifest['@id'] || ''));

		// Stage 2 — Verify. Signature authenticity and freshness only:
		// `subject` is recorded but never compared to the connecting
		// client, which is the deferred ownership-proof work.
		const verified = await verify.verifyManifest(manifest, {
			now:			now,
			clockSkewMs:	this.clockSkewMs,
			fetcher:		this.fetcher,
			allowedSchemes:	this.allowedSchemes,
			maxRedirects:	this.maxRedirects,
			timeoutMs:		timeoutMs,
		});
		receipt.signatureCheck = verified.signatureCheck;
		receipt.freshnessCheck = verified.freshnessCheck;
		if (verified.signatureCheck !== 'valid' || verified.freshnessCheck !== 'fresh')
		{
			receipts.composeOutcome(receipt, true);
			return this._fail(verified.reasons.length ? verified.reasons : ['manifest_signature_invalid'], manifestUrl, receipt);
		}

		// Trust tier, raise-only. The policy floor and the manifest floor
		// both apply; whichever is higher wins, and an unsupported tier is
		// never quietly downgraded.
		const manifestTier = receipts.effectiveTier(req.required_trust_tier, manifest.requiredTrustTier);
		if (manifestTier > receipts.SUPPORTED_TRUST_TIER)
		{
			receipts.composeOutcome(receipt, true);
			return this._fail(['manifest_trust_tier_unsupported'], manifestUrl, receipt);
		}

		// Stage 3 — Project. The avatar pointer first: without it there is
		// no avatar and nothing else matters.
		const pointerNames = [];
		for (const name of [manifestOffer && manifestOffer.pointer]
			.concat(Array.isArray(req.avatar_pointers) ? req.avatar_pointers : [])
			.concat([mf.DEFAULT_AVATAR_POINTER]))
		{
			if (typeof name === 'string' && name.length && !pointerNames.includes(name))
				pointerNames.push(name);
		}

		const pointer = mf.findPointer(manifest, pointerNames);
		if (!pointer)
		{
			receipts.composeOutcome(receipt, true);
			return this._fail(['manifest_no_avatar_pointer'], manifestUrl, receipt);
		}

		// Stage 4 — Consent, for the pointer.
		const pointerName = mf.pointerName(pointer) || pointerNames[0];
		const pointerGate = consent.gateReference(manifest, pointerName, {
			now:			now,
			requiredScope:	this.requiredScope,
			purpose:		this.purpose,
		});
		if (pointerGate.status !== 'processed')
		{
			receipt.addFacet(pointerName, pointerGate.status, pointerGate.reason);
			receipts.composeOutcome(receipt, true);
			return this._fail(['manifest_consent_missing'], manifestUrl, receipt);
		}
		for (const w of pointerGate.warnings) receipt.addWarning(w);

		// Resolve the target against the manifest URL so a manifest may
		// use a relative reference to an asset hosted beside it.
		let avatarUrl = '';
		try { avatarUrl = new URL(mf.pointerTarget(pointer), manifestUrl).href; }
		catch (e) { avatarUrl = ''; }
		if (!avatarUrl || !this.assetAllowedSchemes.includes(new URL(avatarUrl).protocol))
		{
			receipts.composeOutcome(receipt, true);
			return this._fail(['manifest_no_avatar_pointer'], manifestUrl, receipt);
		}

		// Stages 3 and 4 for the app-specific facets the deployment asked
		// for. Failures here are never fatal: a subject withholding a
		// loadout facet should still get their avatar.
		const requestedFacets = Array.isArray(req.requested_facets) ? req.requested_facets : [];
		const { projected, notProjected } = mf.projectFacets(manifest, requestedFacets);

		const facets = [];
		for (const facet of projected)
		{
			const name	= mf.facetName(facet);
			const tier	= receipts.effectiveTier(manifestTier, facet.requiredTrustTier);
			if (tier > receipts.SUPPORTED_TRUST_TIER)
			{
				receipt.addFacet(name, receipts.STATUS_NOT_PROJECTED, 'trustTierUnsupported');
				continue;
			}
			const gate = consent.gateFacet(manifest, facet, {
				now:			now,
				requiredScope:	this.requiredScope,
				purpose:		this.purpose,
			});
			receipt.addFacet(name, gate.status, gate.reason);
			for (const w of gate.warnings) receipt.addWarning(w);
			if (gate.status === receipts.STATUS_PROCESSED)
				facets.push({ name, entity: facet.entity !== undefined ? facet.entity : null });
		}

		// Recorded honestly: present in the manifest, deliberately not
		// looked at. Distinct from absent.
		for (const facet of notProjected)
			receipt.addFacet(mf.facetName(facet), receipts.STATUS_NOT_PROJECTED);

		const claims = mf.projectClaims(manifest, Array.isArray(req.requested_claims) ? req.requested_claims : []);

		// Stages 5 and 6 — Compose and Receipt.
		receipts.composeOutcome(receipt, false);

		const expiresAtMs = Date.parse(manifest.expiresAt);
		const result = {
			ok:			true,
			reasons:	[],
			manifestUrl,
			avatarUrl,
			subject:	String(manifest.subject || ''),
			projection:	{
				subject:	String(manifest.subject || ''),
				pointer:	pointerName,
				facets,
				claims:		claims.map((c) => ({ name: c && c.name ? String(c.name) : '', value: c ? c.value : null })),
			},
			receipt,
			expiresAt:	Number.isFinite(expiresAtMs) ? expiresAtMs : 0,
		};

		if (Number.isFinite(expiresAtMs) && expiresAtMs > now)
			this.cache.set(manifestUrl, { result, expiresAtMs }, fetched.body.length);

		return result;
	}

	_fail(reasons, manifestUrl, receipt = null)
	{
		if (manifestUrl)
			console.log('avatar manifest ' + redactUrl(manifestUrl) + ' rejected: ' + JSON.stringify(reasons));
		return {
			ok:			false,
			reasons:	Array.isArray(reasons) && reasons.length ? reasons.slice() : ['manifest_unresolvable'],
			manifestUrl: manifestUrl || '',
			avatarUrl:	'',
			subject:	'',
			projection:	null,
			receipt,
			expiresAt:	0,
		};
	}
}

module.exports = {
	DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, DEFAULT_RESOLVER_BASE,
	addressToUrl, isAbsoluteUrl,
	IAvatarManifestResolver, DefaultAvatarManifestResolver,
};
