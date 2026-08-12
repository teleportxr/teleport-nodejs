'use strict';
// End-to-end manifest resolution: address → fetch → the six stages →
// avatar url.
//
// Most tests inject a fake fetcher so the network is never touched. The
// block at the bottom spins a real loopback HTTP server to exercise the
// transport itself, mirroring what test_avatar_validator.js does for the
// asset fetch — the SSRF guards are the part it would be least excusable
// to get wrong.

const test		= require('node:test');
const assert	= require('node:assert');
const http		= require('node:http');

const resolver	= require('../manifest/resolver.js');
const validator	= require('../client/avatar_validator.js');
const mf		= require('../protocol/manifest.js');
const fx		= require('./helpers/manifest_fixtures.js');

const MANIFEST_URL	= 'https://manifests.example/me.jsonld';
const AVATAR_URL	= 'https://assets.example/avatars/beta.glb';

const REQUIREMENTS = {
	accepted:			[mf.CONTEXT_V03],
	avatar_pointers:	['portableIdentity.avatar'],
	requested_facets:	['avatarProfile'],
};

function resolverWith(routes, opts = {})
{
	const fetcher = fx.makeFetcher(routes);
	const r = new resolver.DefaultAvatarManifestResolver(Object.assign({ fetcher }, opts));
	r.fetcherStub = fetcher;
	return r;
}

// Addressing -------------------------------------------------------

test('addressToUrl passes an absolute url through', () => {
	assert.strictEqual(resolver.addressToUrl({ url: MANIFEST_URL }), MANIFEST_URL);
});

test('addressToUrl appends a umid to the resolver base', () => {
	assert.strictEqual(
		resolver.addressToUrl({ umid: 'abc123' }, { resolverBase: 'https://myum.net/' }),
		'https://myum.net/abc123');
	// A base without a trailing slash still produces one separator.
	assert.strictEqual(
		resolver.addressToUrl({ umid: 'abc123' }, { resolverBase: 'https://myum.net' }),
		'https://myum.net/abc123');
});

test('addressToUrl percent-encodes a umid so it cannot escape its path segment', () => {
	const url = resolver.addressToUrl({ umid: '../../etc/passwd' }, { resolverBase: 'https://myum.net/' });
	assert.strictEqual(url, 'https://myum.net/..%2F..%2Fetc%2Fpasswd');
});

test('addressToUrl preserves a b64u: prefix', () => {
	assert.strictEqual(
		resolver.addressToUrl({ umid: 'b64u:YWJj' }, { resolverBase: 'https://myum.net/' }),
		'https://myum.net/b64u:YWJj');
});

test('addressToUrl returns empty for an address with neither form', () => {
	assert.strictEqual(resolver.addressToUrl({}), '');
	assert.strictEqual(resolver.addressToUrl(null), '');
});

test('an address with neither url nor umid is unresolvable', async () => {
	const r = resolverWith({});
	const out = await r.resolve({}, REQUIREMENTS);
	assert.strictEqual(out.ok, false);
	assert.deepStrictEqual(out.reasons, ['manifest_unresolvable']);
});

test('a non-https manifest address is refused before any network call', async () => {
	const r = resolverWith({});
	const out = await r.resolve({ url: 'http://manifests.example/me.jsonld' }, REQUIREMENTS);
	assert.strictEqual(out.ok, false);
	assert.deepStrictEqual(out.reasons, ['scheme_not_allowed']);
	assert.strictEqual(r.fetcherStub.calls.length, 0);
});

// Happy path -------------------------------------------------------

test('a valid manifest resolves to its avatar url', async () => {
	const built = fx.makeManifest({ avatarUrl: AVATAR_URL });
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });

	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(out.ok, true);
	assert.strictEqual(out.avatarUrl, AVATAR_URL);
	assert.strictEqual(out.subject, 'did:web:xr.example:users:beta');
	assert.strictEqual(out.receipt.outcome, 'accepted');
	assert.strictEqual(out.receipt.signatureCheck, 'valid');
	assert.strictEqual(out.receipt.freshnessCheck, 'fresh');
});

test('the requested facet is projected and consented', async () => {
	const built = fx.makeManifest();
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });

	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(out.projection.facets.length, 1);
	assert.strictEqual(out.projection.facets[0].name, 'avatarProfile');
	assert.strictEqual(out.projection.facets[0].entity.skeletonProfile, 'humanoid-v1');
	assert.deepStrictEqual(
		out.receipt.facetStatuses.map((f) => [f.name, f.status]),
		[['avatarProfile', 'processed']]);
});

test('a facet the server did not ask for is recorded as not-projected', async () => {
	// Honest reporting: present in the manifest, deliberately not read.
	// That is a different statement from absent.
	const built = fx.makeManifest({
		facets: [
			{ '@id': 'urn:facet:a', '@type': ['um:Facet'], name: 'avatarProfile', entity: {} },
			{ '@id': 'urn:facet:b', '@type': ['um:Facet'], name: 'medicalHistory', entity: { secret: true } },
		],
		consents: [],
	});
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });

	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(out.ok, true);
	const statuses = Object.fromEntries(out.receipt.facetStatuses.map((f) => [f.name, f.status]));
	assert.strictEqual(statuses['medicalHistory'], 'not-projected');
	// And its contents never reach the host.
	assert.strictEqual(out.projection.facets.length, 0);
});

test('a requested facet with no consent is withheld but the avatar still resolves', async () => {
	const built = fx.makeManifest({ consents: [] });
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });

	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(out.ok, true);
	assert.strictEqual(out.avatarUrl, AVATAR_URL);
	assert.strictEqual(out.projection.facets.length, 0);
	assert.strictEqual(out.receipt.outcome, 'accepted-partial');
	assert.strictEqual(out.receipt.facetStatuses[0].status, 'consent-missing');
});

// Pointer shapes ---------------------------------------------------

test('a v0.1-shaped pointer ({name, url}) resolves', async () => {
	// The published Universal Manifest XR fixtures still use this shape.
	const built = fx.makeManifest({
		pointers: [{ name: 'portableIdentity.avatar', url: AVATAR_URL }],
	});
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(out.ok, true);
	assert.strictEqual(out.avatarUrl, AVATAR_URL);
});

test('a v0.3-shaped pointer ({@type, target}) resolves', async () => {
	const built = fx.makeManifest({
		pointers: [{ '@type': 'xr:AvatarPointer', target: AVATAR_URL }],
	});
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	const out = await r.resolve({ url: MANIFEST_URL }, { accepted: [mf.CONTEXT_V03], avatar_pointers: ['xr:AvatarPointer'] });
	assert.strictEqual(out.ok, true);
	assert.strictEqual(out.avatarUrl, AVATAR_URL);
});

test('the offer pointer hint takes precedence over the policy list', async () => {
	const built = fx.makeManifest({
		pointers: [
			{ name: 'portableIdentity.avatar', target: 'https://assets.example/default.glb' },
			{ name: 'game.avatar',             target: 'https://assets.example/game.glb' },
		],
	});
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	const out = await r.resolve({ url: MANIFEST_URL, pointer: 'game.avatar' }, REQUIREMENTS);
	assert.strictEqual(out.avatarUrl, 'https://assets.example/game.glb');
});

test('a manifest with no matching pointer is rejected', async () => {
	const built = fx.makeManifest({ pointers: [{ name: 'portableIdentity.wearables', target: AVATAR_URL }] });
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(out.ok, false);
	assert.deepStrictEqual(out.reasons, ['manifest_no_avatar_pointer']);
	assert.strictEqual(out.receipt.outcome, 'rejected');
});

test('a relative pointer target resolves against the manifest url', async () => {
	const built = fx.makeManifest({ pointers: [{ name: 'portableIdentity.avatar', target: 'avatars/me.glb' }] });
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(out.avatarUrl, 'https://manifests.example/avatars/me.glb');
});

test('a pointer to a non-https target is refused', async () => {
	const built = fx.makeManifest({ pointers: [{ name: 'portableIdentity.avatar', target: 'file:///etc/passwd' }] });
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(out.ok, false);
	assert.deepStrictEqual(out.reasons, ['manifest_no_avatar_pointer']);
});

test('the asset scheme allow-list is separate from the manifest one', async () => {
	// Two different fetches by two different components. A deployment
	// that resolves manifests over plain http in a test rig must not
	// thereby be forced to accept http avatar assets, nor the reverse.
	const built = fx.makeManifest({ avatarUrl: 'https://assets.example/a.glb' });
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) }, {
		allowedSchemes:			['https:'],
		assetAllowedSchemes:	['http:'],
	});
	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(out.ok, false);
	assert.deepStrictEqual(out.reasons, ['manifest_no_avatar_pointer']);
});

test('a denied avatar pointer is refused', async () => {
	const built = fx.makeManifest({
		consents: [{ '@type': 'um:Consent', name: 'portableIdentity.avatar', value: 'denied' }],
	});
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(out.ok, false);
	assert.deepStrictEqual(out.reasons, ['manifest_consent_missing']);
});

// Arrive stage -----------------------------------------------------

test('a body that is not JSON is malformed', async () => {
	const r = resolverWith({ [MANIFEST_URL]: 'this is not json' });
	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.deepStrictEqual(out.reasons, ['manifest_malformed']);
});

test('a manifest missing a required member is malformed', async () => {
	for (const member of mf.REQUIRED_MEMBERS)
	{
		const built = fx.makeManifest();
		delete built.manifest[member];
		const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
		const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
		assert.deepStrictEqual(out.reasons, ['manifest_malformed'], 'missing ' + member);
	}
});

test('a manifest whose @type is not um:Manifest is malformed', async () => {
	const built = fx.makeManifest({ overrides: { '@type': ['um:Receipt'] } });
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	assert.deepStrictEqual((await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS)).reasons, ['manifest_malformed']);
});

test('a manifest in a context the deployment does not accept is refused', async () => {
	const built = fx.makeManifest({ overrides: { '@context': 'https://universalmanifest.net/ns/v0.1' } });
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.deepStrictEqual(out.reasons, ['manifest_context_not_accepted']);
});

test('a deployment may widen the accepted context list', async () => {
	const built = fx.makeManifest({ overrides: { '@context': ['https://universalmanifest.net/ns/v0.4'] } });
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	const out = await r.resolve({ url: MANIFEST_URL }, Object.assign({}, REQUIREMENTS, { accepted: [mf.CONTEXT_V04] }));
	assert.strictEqual(out.ok, true);
});

// Verify stage -----------------------------------------------------

test('a tampered manifest is rejected with a receipt recording why', async () => {
	const built = fx.makeManifest();
	built.manifest.pointers[0].target = 'https://evil.example/other.glb';
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });

	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(out.ok, false);
	assert.ok(out.reasons.includes('manifest_signature_invalid'));
	assert.strictEqual(out.receipt.signatureCheck, 'invalid');
	assert.strictEqual(out.receipt.outcome, 'rejected');
});

test('an expired manifest is rejected', async () => {
	const built = fx.makeManifest({ expiresAt: new Date(Date.now() - 3600 * 1000).toISOString() });
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(out.ok, false);
	assert.ok(out.reasons.includes('manifest_expired'));
	assert.strictEqual(out.receipt.freshnessCheck, 'expired');
});

// Trust tiers ------------------------------------------------------

test('a manifest requiring a trust tier above tier 0 is refused, never downgraded', async () => {
	const built = fx.makeManifest({ overrides: { requiredTrustTier: 1 } });
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(out.ok, false);
	assert.deepStrictEqual(out.reasons, ['manifest_trust_tier_unsupported']);
});

test('a policy trust-tier floor applies even when the manifest declares none', async () => {
	const built = fx.makeManifest();
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	const out = await r.resolve({ url: MANIFEST_URL }, Object.assign({}, REQUIREMENTS, { required_trust_tier: 1 }));
	assert.deepStrictEqual(out.reasons, ['manifest_trust_tier_unsupported']);
});

test('a facet requiring a higher tier is withheld while the avatar still resolves', async () => {
	// Raise-only: the facet floor lifts above the manifest's, and the
	// facet is dropped rather than the whole document rejected.
	const built = fx.makeManifest({
		facets: [{ '@id': 'urn:facet:a', '@type': ['um:Facet'], name: 'avatarProfile', requiredTrustTier: 2, entity: {} }],
	});
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(out.ok, true);
	assert.strictEqual(out.projection.facets.length, 0);
	assert.strictEqual(out.receipt.facetStatuses[0].status, 'not-projected');
	assert.strictEqual(out.receipt.facetStatuses[0].reason, 'trustTierUnsupported');
});

// Caching ----------------------------------------------------------

test('a second resolution of the same url is served from cache', async () => {
	const built = fx.makeManifest();
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });

	const first = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(first.ok, true);
	assert.strictEqual(first.fromCache, undefined);

	const second = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(second.ok, true);
	assert.strictEqual(second.fromCache, true);
	assert.strictEqual(r.fetcherStub.calls.length, 1);
});

test('a cache entry is not served past the manifest expiresAt', async () => {
	// The UMID resolver serves Cache-Control: max-age=60, but its own
	// contract says consumers MUST enforce the manifest TTL regardless.
	//
	// Clock skew is set to zero here so that "past expiresAt" and "not
	// fresh" coincide. With the default 60s allowance the cache (which
	// bounds strictly at expiresAt) would refuse to serve while a fresh
	// evaluation would still accept — conservative, and correct, but it
	// is not what this test is about.
	const expiresAt = new Date(Date.now() + 400).toISOString();
	const built = fx.makeManifest({ expiresAt });
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) }, { clockSkewMs: 0 });

	assert.strictEqual((await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS)).ok, true);
	await new Promise((done) => setTimeout(done, 500));

	// Now past expiresAt: the cached entry must not be reused, and a
	// fresh evaluation correctly rejects it as expired.
	const second = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(second.ok, false);
	assert.ok(second.reasons.includes('manifest_expired'));
	assert.strictEqual(r.fetcherStub.calls.length, 2);
});

// Transport --------------------------------------------------------

test('the manifest byte cap is far smaller than the asset cap', async () => {
	const built = fx.makeManifest();
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.strictEqual(r.fetcherStub.calls[0].maxBytes, resolver.DEFAULT_MAX_BYTES);
	assert.ok(resolver.DEFAULT_MAX_BYTES <= 256 * 1024);
});

test('a policy may tighten the byte cap but not loosen it', async () => {
	const built = fx.makeManifest();
	const r = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	await r.resolve({ url: MANIFEST_URL }, Object.assign({}, REQUIREMENTS, { max_bytes: 1024 }));
	assert.strictEqual(r.fetcherStub.calls[0].maxBytes, 1024);

	const r2 = resolverWith({ [MANIFEST_URL]: JSON.stringify(built.manifest) });
	await r2.resolve({ url: MANIFEST_URL }, Object.assign({}, REQUIREMENTS, { max_bytes: 100 * 1024 * 1024 }));
	assert.strictEqual(r2.fetcherStub.calls[0].maxBytes, resolver.DEFAULT_MAX_BYTES);
});

test('an oversize manifest reports manifest_too_large, not the asset vocabulary', async () => {
	const r = resolverWith({ [MANIFEST_URL]: 'x'.repeat(1024) }, { maxBytes: 128 });
	const out = await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS);
	assert.deepStrictEqual(out.reasons, ['manifest_too_large']);
});

test('transport failures pass through the shared reason vocabulary', async () => {
	for (const reason of ['ssrf_blocked', 'fetch_timeout', 'too_many_redirects', 'http_404'])
	{
		const r = resolverWith({ [MANIFEST_URL]: { reason } });
		assert.deepStrictEqual((await r.resolve({ url: MANIFEST_URL }, REQUIREMENTS)).reasons, [reason]);
	}
});

// Real transport ---------------------------------------------------
// These use the production fetcher against a loopback server, with the
// SSRF resolver stubbed only where the test's whole point is to reach
// loopback. Everything the fetcher does after that — redirect hops,
// byte caps, timeouts — is genuinely exercised.

function loopbackFetcher()
{
	// The scratch server is on 127.0.0.1, which the SSRF guard refuses by
	// design, so tests that must reach it inject a permissive resolver —
	// the same accommodation test_avatar_validator.js makes.
	return (opts) => validator.defaultFetcher(Object.assign({}, opts, { resolver: async (h) => h }));
}

function startServer(handler)
{
	return new Promise((done) => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => done(server));
	});
}

test('real transport: a manifest served over http resolves', async (t) => {
	const built = fx.makeManifest();
	const server = await startServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/ld+json' });
		res.end(JSON.stringify(built.manifest));
	});
	t.after(() => server.close());

	const base = 'http://127.0.0.1:' + server.address().port;
	const r = new resolver.DefaultAvatarManifestResolver({
		fetcher:		loopbackFetcher(),
		allowedSchemes:	['http:'],
	});
	const out = await r.resolve({ url: base + '/me.jsonld' }, REQUIREMENTS);
	assert.strictEqual(out.ok, true);
	assert.strictEqual(out.avatarUrl, AVATAR_URL);
});

test('real transport: an oversize body is aborted mid-stream', async (t) => {
	const server = await startServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/ld+json' });
		// Never ends: if the cap were applied after buffering rather than
		// during, this test would hang instead of failing.
		const timer = setInterval(() => res.write('x'.repeat(4096)), 1);
		res.on('close', () => clearInterval(timer));
	});
	t.after(() => server.close());

	const base = 'http://127.0.0.1:' + server.address().port;
	const r = new resolver.DefaultAvatarManifestResolver({
		fetcher:		loopbackFetcher(),
		allowedSchemes:	['http:'],
		maxBytes:		16 * 1024,
	});
	const out = await r.resolve({ url: base + '/big.jsonld' }, REQUIREMENTS);
	assert.strictEqual(out.ok, false);
	assert.deepStrictEqual(out.reasons, ['manifest_too_large']);
});

test('real transport: a slow response hits the timeout', async (t) => {
	const server = await startServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/ld+json' });
		// Headers sent, body never.
	});
	t.after(() => server.close());

	const base = 'http://127.0.0.1:' + server.address().port;
	const r = new resolver.DefaultAvatarManifestResolver({
		fetcher:		loopbackFetcher(),
		allowedSchemes:	['http:'],
		timeoutMs:		250,
	});
	const out = await r.resolve({ url: base + '/slow.jsonld' }, REQUIREMENTS);
	assert.strictEqual(out.ok, false);
	assert.deepStrictEqual(out.reasons, ['fetch_timeout']);
});

test('real transport: a manifest url resolving to loopback is refused', async (t) => {
	// The production SSRF resolver, not the permissive stub: this is the
	// guard that stops a client aiming the server at its own metadata
	// service or an internal admin endpoint.
	const server = await startServer((req, res) => {
		res.writeHead(200); res.end('{}');
	});
	t.after(() => server.close());

	const base = 'http://127.0.0.1:' + server.address().port;
	const r = new resolver.DefaultAvatarManifestResolver({
		fetcher:		validator.defaultFetcher,
		allowedSchemes:	['http:'],
	});
	const out = await r.resolve({ url: base + '/me.jsonld' }, REQUIREMENTS);
	assert.strictEqual(out.ok, false);
	assert.deepStrictEqual(out.reasons, ['ssrf_blocked']);
});

test('real transport: a redirect to loopback is refused at the hop', async (t) => {
	const target = await startServer((req, res) => { res.writeHead(200); res.end('{}'); });
	t.after(() => target.close());

	const redirector = await startServer((req, res) => {
		res.writeHead(302, { location: 'http://127.0.0.1:' + target.address().port + '/me.jsonld' });
		res.end();
	});
	t.after(() => redirector.close());

	// The first hop is reachable via the permissive resolver; the second
	// must be checked afresh and refused.
	let firstHop = true;
	const fetcher = (opts) => validator.defaultFetcher(Object.assign({}, opts, {
		resolver: async (host) => {
			if (firstHop) { firstHop = false; return host; }
			return validator.resolveAndCheck(host);
		},
	}));

	const r = new resolver.DefaultAvatarManifestResolver({ fetcher, allowedSchemes: ['http:'] });
	const out = await r.resolve({ url: 'http://127.0.0.1:' + redirector.address().port + '/start' }, REQUIREMENTS);
	assert.strictEqual(out.ok, false);
	assert.deepStrictEqual(out.reasons, ['ssrf_blocked']);
});
