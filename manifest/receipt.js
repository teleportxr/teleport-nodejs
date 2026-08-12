'use strict';
// Stages 5 and 6 of the Universal Manifest evaluation sequence: Compose
// and Receipt.
//
// A conformant evaluator hands back a structured receipt that honestly
// records what it did — including what it chose not to look at. That
// honesty is the point: "not projected" is a different statement from
// "absent", and a subject reading a receipt should be able to tell which
// of their facets a given server actually read.
//
// The full receipt is kept server-side (logged, and passed to the host
// application). A compact snake_case projection of it travels back to the
// client as avatar-result.manifest.

const OUTCOME_ACCEPTED			= 'accepted';
const OUTCOME_WITH_WARNINGS		= 'accepted-with-warnings';
const OUTCOME_PARTIAL			= 'accepted-partial';
const OUTCOME_REJECTED			= 'rejected';

const STATUS_PROCESSED			= 'processed';
const STATUS_OPAQUE				= 'opaque';
const STATUS_CONSENT_DENIED		= 'consent-denied';
const STATUS_CONSENT_MISSING	= 'consent-missing';
const STATUS_NOT_PROJECTED		= 'not-projected';

// The highest trust tier this implementation can actually verify. Tier 0
// is signature-only, which is exactly what manifest/verify.js does. Tier
// 1 needs verifiable presentations or cross-DID binding, tier 2 a ZKP
// profile, tier 3 a multi-party ceremony — none of which exist here, and
// claiming otherwise would be worse than admitting it.
const SUPPORTED_TRUST_TIER = 0;

function tierOf(value)
{
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Trust tiers are raise-only: a facet floor can lift the requirement
// above the manifest's, never below it, and a policy floor lifts both.
function effectiveTier(...values)
{
	return values.reduce((acc, v) => Math.max(acc, tierOf(v)), 0);
}

class Receipt
{
	constructor(manifestId)
	{
		this['@type']		= ['um:Receipt'];
		this.manifestId		= manifestId || '';
		this.outcome		= OUTCOME_REJECTED;
		this.signatureCheck	= 'unsupported-profile';
		this.freshnessCheck	= 'expired';
		this.facetStatuses	= [];
		this.warnings		= [];
		this.processedAt	= new Date().toISOString();
	}

	addFacet(name, status, reason)
	{
		const entry = { facetId: name || '', status };
		if (name) entry.name = name;
		if (reason) entry.reason = reason;
		this.facetStatuses.push(entry);
		return entry;
	}

	addWarning(warning)
	{
		if (warning && !this.warnings.includes(warning))
			this.warnings.push(warning);
	}
}

// Compose. `fatal` is true when something stopped the evaluation
// outright — a bad signature, an expired manifest, no usable avatar
// pointer. Otherwise the outcome is graded by what happened to the
// facets, because partial acceptance is the normal case rather than an
// error: a subject is not obliged to consent to everything a server asks
// for, and a server is not obliged to refuse them over it.
function composeOutcome(receipt, fatal)
{
	if (fatal)
	{
		receipt.outcome = OUTCOME_REJECTED;
		return receipt.outcome;
	}

	const degraded = receipt.facetStatuses.some((f) =>
		f.status === STATUS_CONSENT_DENIED ||
		f.status === STATUS_CONSENT_MISSING ||
		f.status === STATUS_NOT_PROJECTED ||
		f.status === STATUS_OPAQUE);

	if (degraded)
		receipt.outcome = OUTCOME_PARTIAL;
	else if (receipt.warnings.length)
		receipt.outcome = OUTCOME_WITH_WARNINGS;
	else
		receipt.outcome = OUTCOME_ACCEPTED;

	return receipt.outcome;
}

// The projection that travels back to the client on avatar-result. Kept
// small and snake_case to match every other field on that message; the
// full receipt stays here.
function toWire(receipt)
{
	if (!receipt)
		return null;
	return {
		manifest_id:		receipt.manifestId || '',
		outcome:			receipt.outcome,
		signature_check:	receipt.signatureCheck,
		freshness_check:	receipt.freshnessCheck,
		facets:				receipt.facetStatuses.map((f) => ({ name: f.name || f.facetId || '', status: f.status })),
	};
}

function parseWire(j)
{
	if (!j || typeof j !== 'object')
		return null;
	return {
		manifest_id:		typeof j.manifest_id     === 'string' ? j.manifest_id     : '',
		outcome:			typeof j.outcome         === 'string' ? j.outcome         : OUTCOME_REJECTED,
		signature_check:	typeof j.signature_check === 'string' ? j.signature_check : 'unsupported-profile',
		freshness_check:	typeof j.freshness_check === 'string' ? j.freshness_check : 'expired',
		facets:				Array.isArray(j.facets)
			? j.facets.filter((f) => f && typeof f === 'object').map((f) => ({ name: String(f.name || ''), status: String(f.status || '') }))
			: [],
	};
}

module.exports = {
	OUTCOME_ACCEPTED, OUTCOME_WITH_WARNINGS, OUTCOME_PARTIAL, OUTCOME_REJECTED,
	STATUS_PROCESSED, STATUS_OPAQUE, STATUS_CONSENT_DENIED, STATUS_CONSENT_MISSING, STATUS_NOT_PROJECTED,
	SUPPORTED_TRUST_TIER, tierOf, effectiveTier,
	Receipt, composeOutcome, toWire, parseWire,
};
