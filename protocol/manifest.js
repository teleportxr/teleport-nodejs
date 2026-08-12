'use strict';
// Universal Manifest (https://universalmanifest.net) envelope parsing and
// projection accessors.
//
// A Universal Manifest is a portable, signed, consented JSON-LD document.
// Teleport uses one as an indirection in front of an avatar: rather than
// offering an asset URL, a client offers a manifest address, and the
// server reads the asset URL out of the manifest along with whatever
// app-specific facets that deployment understands.
//
// This module covers stage 1 (Arrive) and stage 3 (Project) of the UM
// six-stage evaluation sequence. Stage 2 is manifest/verify.js, stage 4
// is manifest/consent.js, stages 5-6 are manifest/receipt.js, and
// manifest/resolver.js runs them in order.
//
// Target version is v0.3 (the stable line). Two compatibility rules make
// that workable in practice:
//
//   * Unknown members are ignored but PRESERVED. This is the RFC-level
//     forward-compatibility guarantee: a v0.4 manifest must round-trip
//     through a v0.3 consumer without losing data. It is also load-bearing
//     for signature verification, since the signature covers members we
//     do not understand.
//   * Pointers and consents are accepted in both the v0.1 shape
//     (`{name, url}` / `{name, value}`) and the v0.3 shape
//     (`{@type, target}` / `{@id, facetRef, scope, ...}`). The published
//     XR avatar fixtures are still v0.1-shaped, and v0.3 registers no
//     pointer @type for an avatar, so name matching is the only thing
//     that works across both.

const MANIFEST_TYPE	= 'um:Manifest';
const FACET_TYPE	= 'um:Facet';
const CONSENT_TYPE	= 'um:Consent';
const CLAIM_TYPE	= 'um:Claim';

// The @context values this implementation was written against. A
// deployment narrows or widens this through
// avatar-policy.requirements.manifest.accepted.
const CONTEXT_V03 = 'https://universalmanifest.net/ns/v0.3';
const CONTEXT_V04 = 'https://universalmanifest.net/ns/v0.4';
const DEFAULT_ACCEPTED_CONTEXTS = [CONTEXT_V03];

// The pointer name the Universal Manifest XR fixtures use for an avatar
// asset. Used when a deployment does not name one explicitly.
const DEFAULT_AVATAR_POINTER = 'portableIdentity.avatar';

// Envelope members required by the v0.3 schema. `signature` is included:
// an unsigned manifest cannot be verified, and this implementation does
// not accept one (see manifest/verify.js).
const REQUIRED_MEMBERS = ['@context', '@id', '@type', 'manifestVersion', 'subject', 'issuedAt', 'expiresAt', 'signature'];

// @type may be a bare string or an array of them.
function typeList(value)
{
	if (typeof value === 'string')	return [value];
	if (Array.isArray(value))		return value.filter((t) => typeof t === 'string');
	return [];
}

function hasType(value, wanted)
{
	return typeList(value).includes(wanted);
}

// @context may be a string, an array, or an object with its own members.
// Only the string forms are matched against the accept list; an object
// context is a local term definition and cannot be compared by identity.
function contextList(value)
{
	if (typeof value === 'string')	return [value];
	if (Array.isArray(value))		return value.filter((c) => typeof c === 'string');
	return [];
}

// Stage 1, Arrive. Structural check only — no signature, no freshness,
// no consent. Returns { ok, reasons, manifest } where `manifest` is the
// parsed document with every member intact, including the ones this
// implementation does not understand.
function parseManifest(text, opts = {})
{
	const accepted = Array.isArray(opts.accepted) && opts.accepted.length
		? opts.accepted
		: DEFAULT_ACCEPTED_CONTEXTS;

	let doc;
	try
	{
		doc = typeof text === 'string' || Buffer.isBuffer(text) ? JSON.parse(text) : text;
	}
	catch (e)
	{
		return { ok: false, reasons: ['manifest_malformed'], manifest: null };
	}

	if (!doc || typeof doc !== 'object' || Array.isArray(doc))
		return { ok: false, reasons: ['manifest_malformed'], manifest: null };

	const missing = REQUIRED_MEMBERS.filter((m) => doc[m] === undefined || doc[m] === null);
	if (missing.length)
		return { ok: false, reasons: ['manifest_malformed'], manifest: null, missing };

	if (!hasType(doc['@type'], MANIFEST_TYPE))
		return { ok: false, reasons: ['manifest_malformed'], manifest: null };

	// The accept list is the deployment's statement of which versions it
	// has been tested against. A manifest outside it is well-formed but
	// not something this server is willing to interpret.
	const contexts = contextList(doc['@context']);
	if (!contexts.some((c) => accepted.includes(c)))
		return { ok: false, reasons: ['manifest_context_not_accepted'], manifest: null };

	return { ok: true, reasons: [], manifest: doc };
}

// Pointers ------------------------------------------------------------
// v0.1: { name, url }.  v0.3: { @type, target, @id, label }.

function pointerName(p)
{
	if (!p || typeof p !== 'object') return '';
	if (typeof p.name  === 'string' && p.name.length)  return p.name;
	if (typeof p.label === 'string' && p.label.length) return p.label;
	return '';
}

function pointerTarget(p)
{
	if (!p || typeof p !== 'object') return '';
	if (typeof p.target === 'string' && p.target.length) return p.target;
	if (typeof p.url    === 'string' && p.url.length)    return p.url;
	return '';
}

// True when a pointer answers to `name`, by its name/label or by an
// entry in its @type. The @type arm is what lets a deployment that has
// registered a real JSON-LD term for its avatar pointer name that term
// in `avatar_pointers` and have it match.
function pointerMatches(p, name)
{
	if (!p || !name) return false;
	if (pointerName(p) === name) return true;
	return hasType(p['@type'], name);
}

// First pointer matching any of `names`, tried in order, so a caller can
// express precedence (offer hint first, then the policy's list).
function findPointer(manifest, names)
{
	const pointers = Array.isArray(manifest && manifest.pointers) ? manifest.pointers : [];
	for (const name of (Array.isArray(names) ? names : []))
	{
		if (!name) continue;
		const found = pointers.find((p) => pointerMatches(p, name));
		if (found) return found;
	}
	return null;
}

// Facets and claims ---------------------------------------------------

function facetName(f)
{
	if (!f || typeof f !== 'object') return '';
	if (typeof f.name === 'string' && f.name.length) return f.name;
	if (typeof f['@id'] === 'string' && f['@id'].length) return f['@id'];
	return '';
}

// A facet is identified for consent purposes by its @id where it has
// one, and by its name otherwise. v0.3 requires @id; the v0.1 fixtures
// omit it, and a consent entry in those refers to a name.
function facetRefs(f)
{
	const refs = [];
	if (f && typeof f['@id'] === 'string' && f['@id'].length) refs.push(f['@id']);
	const name = facetName(f);
	if (name && !refs.includes(name)) refs.push(name);
	return refs;
}

function facetMatches(f, name)
{
	if (!f || !name) return false;
	if (facetRefs(f).includes(name)) return true;
	// A facet's payload carries its own semantic type, e.g.
	// "xr:AvatarProfile"; let a deployment request by that too.
	if (hasType(f['@type'], name)) return true;
	if (f.entity && typeof f.entity === 'object' && hasType(f.entity['@type'], name)) return true;
	return false;
}

// Stage 3, Project. Only the facets the caller asked for come back —
// what is not projected is *not projected*, which is a different receipt
// status from absent, and the resolver records both.
function projectFacets(manifest, names)
{
	const facets = Array.isArray(manifest && manifest.facets) ? manifest.facets : [];
	const wanted = Array.isArray(names) ? names.filter(Boolean) : [];
	const projected = [];
	const notProjected = [];
	for (const f of facets)
	{
		if (wanted.some((n) => facetMatches(f, n)))
			projected.push(f);
		else
			notProjected.push(f);
	}
	return { projected, notProjected };
}

function projectClaims(manifest, names)
{
	const claims = Array.isArray(manifest && manifest.claims) ? manifest.claims : [];
	const wanted = Array.isArray(names) ? names.filter(Boolean) : [];
	if (!wanted.length) return [];
	return claims.filter((c) =>
	{
		const name = c && typeof c.name === 'string' ? c.name : '';
		return (name && wanted.includes(name)) || hasType(c && c['@type'], CLAIM_TYPE) && wanted.includes(c && c['@id']);
	});
}

// A facet whose payload is a JWE we have no key for. Acknowledged in the
// receipt as `opaque` and skipped — never a reason to reject the manifest.
function isSealedFacet(f)
{
	if (!f || typeof f !== 'object') return false;
	if (typeof f.encryptionProfile === 'string' && f.encryptionProfile.length) return true;
	const e = f.entity;
	return !!(e && typeof e === 'object' && typeof e.ciphertext === 'string' && typeof e.protected === 'string');
}

module.exports = {
	MANIFEST_TYPE, FACET_TYPE, CONSENT_TYPE, CLAIM_TYPE,
	CONTEXT_V03, CONTEXT_V04, DEFAULT_ACCEPTED_CONTEXTS,
	DEFAULT_AVATAR_POINTER, REQUIRED_MEMBERS,
	typeList, hasType, contextList,
	parseManifest,
	pointerName, pointerTarget, pointerMatches, findPointer,
	facetName, facetRefs, facetMatches, projectFacets, projectClaims,
	isSealedFacet,
};
