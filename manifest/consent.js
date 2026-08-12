'use strict';
// Stage 4 of the Universal Manifest evaluation sequence: Consent.
//
// The rule is default-deny. A projected facet with no matching consent
// entry is `consent-missing` and its data MUST NOT be processed. This is
// not a formality: the whole point of a portable envelope is that the
// subject decides what each consumer may do with it, and an evaluator
// that processes an unconsented facet has broken that contract even if
// the manifest itself is perfectly valid.
//
// Two shapes are accepted. v0.3 consents reference a facet by `facetRef`
// and carry scope/purpose/validity; v0.1 consents (which the published XR
// fixtures still use) are a flat `{name, value}` permission where value is
// allowed | denied | restricted.

const mf = require('../protocol/manifest.js');

// Operations this server performs on a projected facet. `read` is the
// baseline; a deployment that forwards facet data onward should require
// `forward` too.
const DEFAULT_REQUIRED_SCOPE = ['read'];

const VALUE_ALLOWED		= 'allowed';
const VALUE_DENIED		= 'denied';
const VALUE_RESTRICTED	= 'restricted';

function parseTime(value)
{
	if (typeof value !== 'string' || !value.length) return NaN;
	return Date.parse(value);
}

// Does this consent entry speak about `ref`? v0.3 uses facetRef, v0.1
// uses name.
function consentMatchesRef(consent, refs)
{
	if (!consent || typeof consent !== 'object' || !Array.isArray(refs))
		return false;
	if (typeof consent.facetRef === 'string' && refs.includes(consent.facetRef))
		return true;
	if (typeof consent.name === 'string' && refs.includes(consent.name))
		return true;
	return false;
}

// Every consent entry in the manifest that applies to `refs`.
function consentsForRefs(manifest, refs)
{
	const consents = Array.isArray(manifest && manifest.consents) ? manifest.consents : [];
	return consents.filter((c) => consentMatchesRef(c, refs));
}

// Evaluate one consent entry. Returns { ok, reason, warning }.
function evaluateConsent(consent, opts = {})
{
	const now			= Number.isFinite(opts.now) ? opts.now : Date.now();
	const requiredScope	= Array.isArray(opts.requiredScope) ? opts.requiredScope : DEFAULT_REQUIRED_SCOPE;
	const purpose		= typeof opts.purpose === 'string' && opts.purpose.length ? opts.purpose : '';

	// A withdrawn consent is treated as absent, not as a denial that can
	// be argued with.
	if (consent.withdrawnAt && parseTime(consent.withdrawnAt) <= now)
		return { ok: false, reason: 'withdrawn' };

	if (consent.grantedAt)
	{
		const granted = parseTime(consent.grantedAt);
		if (Number.isFinite(granted) && granted > now)
			return { ok: false, reason: 'not_yet_granted' };
	}

	if (consent.expiresAt)
	{
		const expires = parseTime(consent.expiresAt);
		if (!Number.isFinite(expires) || expires <= now)
			return { ok: false, reason: 'expired' };
	}

	// v0.1 flat permission.
	if (typeof consent.value === 'string')
	{
		const value = consent.value.toLowerCase();
		if (value === VALUE_DENIED)
			return { ok: false, reason: 'denied' };
		if (value === VALUE_RESTRICTED)
			return { ok: true, warning: 'consent_restricted' };
		if (value === VALUE_ALLOWED)
			return { ok: true };
		return { ok: false, reason: 'denied' };
	}

	// v0.3 scope/purpose.
	if (consent.scope !== undefined)
	{
		const scope = Array.isArray(consent.scope)
			? consent.scope.map((s) => String(s).toLowerCase())
			: [String(consent.scope).toLowerCase()];
		const missing = requiredScope.filter((s) => !scope.includes(String(s).toLowerCase()));
		if (missing.length)
			return { ok: false, reason: 'scope_not_permitted' };
	}
	else
	{
		// v0.3 makes scope required; a consent without one cannot be
		// shown to permit anything.
		return { ok: false, reason: 'scope_not_permitted' };
	}

	if (purpose && consent.purpose !== undefined)
	{
		const declared = Array.isArray(consent.purpose)
			? consent.purpose.map((p) => String(p))
			: [String(consent.purpose)];
		if (!declared.includes(purpose))
			return { ok: false, reason: 'purpose_mismatch' };
	}

	return { ok: true };
}

// Gate one facet. Returns a receipt facet status:
//   processed        — consented, safe to use
//   opaque           — sealed (encrypted) and we have no key; acknowledged, skipped
//   consent-missing  — no consent entry references it
//   consent-denied   — a consent entry references it and refuses
//
// Multiple consents for one facet are conjunctive: all must pass. That is
// the conservative reading and the one the conformance suite expects.
function gateFacet(manifest, facet, opts = {})
{
	if (mf.isSealedFacet(facet))
		return { status: 'opaque', warnings: [] };

	const refs		= mf.facetRefs(facet);
	const applicable = consentsForRefs(manifest, refs);
	if (!applicable.length)
		return { status: 'consent-missing', warnings: [] };

	const warnings = [];
	for (const consent of applicable)
	{
		const verdict = evaluateConsent(consent, opts);
		if (!verdict.ok)
			return { status: 'consent-denied', reason: verdict.reason, warnings };
		if (verdict.warning)
			warnings.push(verdict.warning);
	}
	return { status: 'processed', warnings };
}

// Gate a named reference that is not a facet — specifically the avatar
// pointer. A pointer with no consent entry naming it is allowed: consent
// gating in UM is defined over facets, and requiring an explicit consent
// for every pointer would reject every manifest in the wild. But where
// the subject HAS spoken about it, we obey.
function gateReference(manifest, name, opts = {})
{
	const applicable = consentsForRefs(manifest, [name]);
	if (!applicable.length)
		return { status: 'processed', warnings: [], unstated: true };

	const warnings = [];
	for (const consent of applicable)
	{
		const verdict = evaluateConsent(consent, opts);
		if (!verdict.ok)
			return { status: 'consent-denied', reason: verdict.reason, warnings };
		if (verdict.warning)
			warnings.push(verdict.warning);
	}
	return { status: 'processed', warnings };
}

module.exports = {
	DEFAULT_REQUIRED_SCOPE,
	VALUE_ALLOWED, VALUE_DENIED, VALUE_RESTRICTED,
	consentMatchesRef, consentsForRefs, evaluateConsent, gateFacet, gateReference,
};
