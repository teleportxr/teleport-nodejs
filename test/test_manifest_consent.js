'use strict';
// Stage 4 of the Universal Manifest evaluation sequence: default-deny
// consent gating. The rule under test throughout is that absence of
// permission is refusal, never permission.

const test		= require('node:test');
const assert	= require('node:assert');

const consent	= require('../manifest/consent.js');

const NOW = Date.parse('2026-06-01T12:00:00Z');

function facet(id, name, extra = {})
{
	return Object.assign({ '@id': id, '@type': ['um:Facet'], name, entity: { '@type': ['um:Entity'] } }, extra);
}

function manifestWith(consents, facets)
{
	return { consents, facets: facets || [] };
}

function v03Consent(overrides = {})
{
	return Object.assign({
		'@id':		'urn:consent:1',
		'@type':	'um:Consent',
		facetRef:	'urn:facet:profile',
		scope:		['read', 'display'],
		purpose:	'avatar-presentation',
		grantedAt:	'2026-05-01T00:00:00Z',
		expiresAt:	'2026-12-01T00:00:00Z',
	}, overrides);
}

// Default deny -----------------------------------------------------

test('a facet with no consent entry is consent-missing', () => {
	const f = facet('urn:facet:profile', 'avatarProfile');
	const m = manifestWith([]);
	assert.strictEqual(consent.gateFacet(m, f, { now: NOW }).status, 'consent-missing');
});

test('a facet with a consent for a different facet is consent-missing', () => {
	const f = facet('urn:facet:profile', 'avatarProfile');
	const m = manifestWith([v03Consent({ facetRef: 'urn:facet:something-else' })]);
	assert.strictEqual(consent.gateFacet(m, f, { now: NOW }).status, 'consent-missing');
});

test('a matching consent permits processing', () => {
	const f = facet('urn:facet:profile', 'avatarProfile');
	const m = manifestWith([v03Consent()]);
	const gate = consent.gateFacet(m, f, { now: NOW, purpose: 'avatar-presentation' });
	assert.strictEqual(gate.status, 'processed');
});

test('a consent may reference a facet by name as well as by @id', () => {
	const f = facet('urn:facet:profile', 'avatarProfile');
	const m = manifestWith([v03Consent({ facetRef: 'avatarProfile' })]);
	assert.strictEqual(consent.gateFacet(m, f, { now: NOW }).status, 'processed');
});

// Scope, purpose, validity ------------------------------------------

test('a consent whose scope omits a required operation denies', () => {
	const f = facet('urn:facet:profile', 'avatarProfile');
	const m = manifestWith([v03Consent({ scope: ['display'] })]);
	const gate = consent.gateFacet(m, f, { now: NOW, requiredScope: ['read'] });
	assert.strictEqual(gate.status, 'consent-denied');
	assert.strictEqual(gate.reason, 'scope_not_permitted');
});

test('a consent with no scope at all denies', () => {
	const f = facet('urn:facet:profile', 'avatarProfile');
	const m = manifestWith([v03Consent({ scope: undefined })]);
	assert.strictEqual(consent.gateFacet(m, f, { now: NOW }).status, 'consent-denied');
});

test('a purpose the consent does not name denies', () => {
	const f = facet('urn:facet:profile', 'avatarProfile');
	const m = manifestWith([v03Consent({ purpose: 'analytics' })]);
	const gate = consent.gateFacet(m, f, { now: NOW, purpose: 'avatar-presentation' });
	assert.strictEqual(gate.status, 'consent-denied');
	assert.strictEqual(gate.reason, 'purpose_mismatch');
});

test('a consent listing several purposes matches any of them', () => {
	const f = facet('urn:facet:profile', 'avatarProfile');
	const m = manifestWith([v03Consent({ purpose: ['analytics', 'avatar-presentation'] })]);
	assert.strictEqual(consent.gateFacet(m, f, { now: NOW, purpose: 'avatar-presentation' }).status, 'processed');
});

test('an evaluator that states no purpose does not check purpose', () => {
	const f = facet('urn:facet:profile', 'avatarProfile');
	const m = manifestWith([v03Consent({ purpose: 'analytics' })]);
	assert.strictEqual(consent.gateFacet(m, f, { now: NOW }).status, 'processed');
});

test('an expired consent denies', () => {
	const f = facet('urn:facet:profile', 'avatarProfile');
	const m = manifestWith([v03Consent({ expiresAt: '2026-01-01T00:00:00Z' })]);
	const gate = consent.gateFacet(m, f, { now: NOW });
	assert.strictEqual(gate.status, 'consent-denied');
	assert.strictEqual(gate.reason, 'expired');
});

test('a withdrawn consent denies', () => {
	const f = facet('urn:facet:profile', 'avatarProfile');
	const m = manifestWith([v03Consent({ withdrawnAt: '2026-05-15T00:00:00Z' })]);
	const gate = consent.gateFacet(m, f, { now: NOW });
	assert.strictEqual(gate.status, 'consent-denied');
	assert.strictEqual(gate.reason, 'withdrawn');
});

test('a consent withdrawn in the future is still in force', () => {
	const f = facet('urn:facet:profile', 'avatarProfile');
	const m = manifestWith([v03Consent({ withdrawnAt: '2026-11-01T00:00:00Z' })]);
	assert.strictEqual(consent.gateFacet(m, f, { now: NOW }).status, 'processed');
});

test('a consent not yet granted denies', () => {
	const f = facet('urn:facet:profile', 'avatarProfile');
	const m = manifestWith([v03Consent({ grantedAt: '2026-07-01T00:00:00Z' })]);
	const gate = consent.gateFacet(m, f, { now: NOW });
	assert.strictEqual(gate.status, 'consent-denied');
	assert.strictEqual(gate.reason, 'not_yet_granted');
});

// Conjunction ------------------------------------------------------

test('several consents for one facet are conjunctive: one refusal denies', () => {
	const f = facet('urn:facet:profile', 'avatarProfile');
	const m = manifestWith([
		v03Consent({ '@id': 'urn:consent:1' }),
		v03Consent({ '@id': 'urn:consent:2', expiresAt: '2026-01-01T00:00:00Z' }),
	]);
	assert.strictEqual(consent.gateFacet(m, f, { now: NOW }).status, 'consent-denied');
});

test('several consents that all pass permit processing', () => {
	const f = facet('urn:facet:profile', 'avatarProfile');
	const m = manifestWith([
		v03Consent({ '@id': 'urn:consent:1' }),
		v03Consent({ '@id': 'urn:consent:2' }),
	]);
	assert.strictEqual(consent.gateFacet(m, f, { now: NOW }).status, 'processed');
});

// v0.1 flat permissions ---------------------------------------------

test('v0.1 consent shape: allowed permits', () => {
	const f = facet('urn:facet:profile', 'portableIdentity.profilePublic');
	const m = manifestWith([{ '@type': 'um:Consent', name: 'portableIdentity.profilePublic', value: 'allowed' }]);
	assert.strictEqual(consent.gateFacet(m, f, { now: NOW }).status, 'processed');
});

test('v0.1 consent shape: denied refuses', () => {
	const f = facet('urn:facet:voice', 'portableIdentity.voiceCapture');
	const m = manifestWith([{ '@type': 'um:Consent', name: 'portableIdentity.voiceCapture', value: 'denied' }]);
	const gate = consent.gateFacet(m, f, { now: NOW });
	assert.strictEqual(gate.status, 'consent-denied');
	assert.strictEqual(gate.reason, 'denied');
});

test('v0.1 consent shape: restricted permits but warns', () => {
	const f = facet('urn:facet:analytics', 'portableIdentity.analyticsShare');
	const m = manifestWith([{ '@type': 'um:Consent', name: 'portableIdentity.analyticsShare', value: 'restricted' }]);
	const gate = consent.gateFacet(m, f, { now: NOW });
	assert.strictEqual(gate.status, 'processed');
	assert.deepStrictEqual(gate.warnings, ['consent_restricted']);
});

test('v0.1 consent shape: an unrecognised value refuses', () => {
	const f = facet('urn:facet:profile', 'x');
	const m = manifestWith([{ '@type': 'um:Consent', name: 'x', value: 'maybe' }]);
	assert.strictEqual(consent.gateFacet(m, f, { now: NOW }).status, 'consent-denied');
});

// Sealed facets ----------------------------------------------------

test('a sealed facet is opaque, not a rejection', () => {
	// Being unable to decrypt someone else's facet says nothing about
	// whether the manifest is valid.
	const f = facet('urn:facet:sealed', 'sealed', {
		encryptionProfile: 'jwe-inline-v1',
		entity: { protected: 'eyJ...', ciphertext: 'abc', iv: 'x', tag: 'y' },
	});
	const m = manifestWith([]);
	assert.strictEqual(consent.gateFacet(m, f, { now: NOW }).status, 'opaque');
});

test('a sealed facet is detected from a JWE entity without the profile member', () => {
	const f = facet('urn:facet:sealed', 'sealed', {
		entity: { protected: 'eyJ...', ciphertext: 'abc' },
	});
	assert.strictEqual(consent.gateFacet(manifestWith([]), f, { now: NOW }).status, 'opaque');
});

// References (pointers) ---------------------------------------------

test('an unstated reference is permitted', () => {
	// Consent in UM is defined over facets; requiring an explicit consent
	// for every pointer would reject every manifest in the wild.
	const gate = consent.gateReference(manifestWith([]), 'portableIdentity.avatar', { now: NOW });
	assert.strictEqual(gate.status, 'processed');
	assert.strictEqual(gate.unstated, true);
});

test('a reference the subject has denied is refused', () => {
	const m = manifestWith([{ '@type': 'um:Consent', name: 'portableIdentity.avatar', value: 'denied' }]);
	assert.strictEqual(consent.gateReference(m, 'portableIdentity.avatar', { now: NOW }).status, 'consent-denied');
});

test('a reference the subject has allowed is permitted and not marked unstated', () => {
	const m = manifestWith([{ '@type': 'um:Consent', name: 'portableIdentity.avatar', value: 'allowed' }]);
	const gate = consent.gateReference(m, 'portableIdentity.avatar', { now: NOW });
	assert.strictEqual(gate.status, 'processed');
	assert.strictEqual(gate.unstated, undefined);
});

// Matching helper ---------------------------------------------------

test('consentsForRefs collects every applicable entry', () => {
	const m = manifestWith([
		v03Consent({ '@id': 'a', facetRef: 'urn:facet:profile' }),
		v03Consent({ '@id': 'b', facetRef: 'other' }),
		{ '@type': 'um:Consent', name: 'avatarProfile', value: 'allowed' },
	]);
	const found = consent.consentsForRefs(m, ['urn:facet:profile', 'avatarProfile']);
	assert.strictEqual(found.length, 2);
});
