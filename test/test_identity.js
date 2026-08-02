'use strict';
const test = require('node:test');
const assert = require('node:assert');
const identity = require('../protocol/identity.js');
const { MemoryUserStore } = require('../identity/user_store.js');
const { IdentityVerifier, IdentityResolver, verified } = require('../identity/verifier.js');

// parseIdentity ---------------------------------------------------------

test('parseIdentity reads the object form the reference client sends', () => {
	const id = identity.parseIdentity({
		provider: 'google', iss: 'https://accounts.google.com',
		subject: '117934', displayName: 'Roderick', aud: 'abc.apps.googleusercontent.com',
	});
	assert.strictEqual(id.provider, 'google');
	assert.strictEqual(id.iss, 'https://accounts.google.com');
	assert.strictEqual(id.subject, '117934');
	assert.strictEqual(id.displayName, 'Roderick');
});

test('parseIdentity accepts the legacy bare string as an opaque guest', () => {
	// The protocol documented `identity` as an opaque string before the object
	// existed. Such a string carries no issuer, so there is nothing to check it
	// against and nothing safe to key on.
	const id = identity.parseIdentity('some-opaque-string');
	assert.strictEqual(id.provider, 'opaque');
	assert.strictEqual(id.subject, 'some-opaque-string');
	assert.strictEqual(identity.isGuestIdentity(id), true);
});

test('parseIdentity returns null rather than throwing on anything unusable', () => {
	for (const raw of [undefined, null, '', '   ', 42, [], {}, { provider: 'google' }, { subject: 'x' }])
		assert.strictEqual(identity.parseIdentity(raw), null, 'for ' + JSON.stringify(raw));
});

test('parseIdentity keeps an identity that has iss but no provider', () => {
	const id = identity.parseIdentity({ iss: 'https://accounts.google.com', subject: '1' });
	assert.notStrictEqual(id, null);
	assert.strictEqual(id.iss, 'https://accounts.google.com');
});

test('parseIdentity bounds the display name', () => {
	const id = identity.parseIdentity({ provider: 'google', subject: '1', displayName: 'x'.repeat(500) });
	assert.strictEqual(id.displayName.length, identity.MAX_DISPLAY_NAME);
});

// Keys ------------------------------------------------------------------

test('verifiedKey keys on issuer and subject, not subject alone', () => {
	// `sub` is unique only within an issuer, so two issuers that both allocate
	// subject "1" must not collide.
	const a = identity.verifiedKey({ iss: 'https://accounts.google.com', sub: '1' });
	const b = identity.verifiedKey({ iss: 'https://appleid.apple.com',   sub: '1' });
	assert.notStrictEqual(a, b);
});

test('verifiedKey includes the audience for a pairwise issuer', () => {
	// Apple and Entra issue a different `sub` per client id. Teleport's desktop
	// and headless clients register separately, so the same token subject from
	// a different audience is a different subject as far as the issuer is
	// concerned, and must not be merged.
	const desktop  = identity.verifiedKey({ iss: 'https://appleid.apple.com', sub: '1', aud: 'desktop' },  { subjectScope: 'pairwise' });
	const headless = identity.verifiedKey({ iss: 'https://appleid.apple.com', sub: '1', aud: 'headless' }, { subjectScope: 'pairwise' });
	assert.notStrictEqual(desktop, headless);
	// Whereas a public-subject issuer merges them, which is what makes one
	// Google sign-in usable from both clients.
	const g1 = identity.verifiedKey({ iss: 'https://accounts.google.com', sub: '1', aud: 'desktop' });
	const g2 = identity.verifiedKey({ iss: 'https://accounts.google.com', sub: '1', aud: 'headless' });
	assert.strictEqual(g1, g2);
});

test('verifiedKey refuses a pairwise subject with no audience', () => {
	// Without the audience the subject is ambiguous; silently keying on
	// (iss, sub) would merge users the issuer considers distinct.
	assert.strictEqual(identity.verifiedKey({ iss: 'https://appleid.apple.com', sub: '1' }, { subjectScope: 'pairwise' }), null);
});

test('verifiedKey honours a per-issuer subject derivation', () => {
	// Microsoft Entra's stable identifier is (tid, oid), not `sub`.
	const key = identity.verifiedKey(
		{ iss: 'https://login.microsoftonline.com/x/v2.0', sub: 'pairwise-junk', tid: 'T', oid: 'O' },
		{ deriveSubject: (c) => c.tid + '/' + c.oid });
	assert.ok(key.includes(encodeURIComponent('T/O')));
	assert.ok(!key.includes('pairwise-junk'));
});

test('key components are encoded so a crafted subject cannot forge another key', () => {
	// Without encoding, subject "b|c" under issuer "a" would produce the same
	// string as subject "c" under issuer "a|b".
	const a = identity.verifiedKey({ iss: 'a', sub: 'b|c' });
	const b = identity.verifiedKey({ iss: 'a|b', sub: 'c' });
	assert.notStrictEqual(a, b);
});

test('asserted and verified keyspaces cannot collide', () => {
	// An unverified claim must be unable to name a verified user's record,
	// whatever the client writes into the connect message.
	const asserted = identity.assertedKey(identity.parseIdentity({ provider: 'google', subject: '117934' }));
	const verifiedK = identity.verifiedKey({ iss: 'https://accounts.google.com', sub: '117934' });
	assert.notStrictEqual(asserted, verifiedK);
	assert.ok(asserted.startsWith('asserted:'));
});

test('assertedKey refuses guest providers', () => {
	// A guest subject is a random number the client generated, so it names an
	// installation at best.
	assert.strictEqual(identity.assertedKey(identity.parseIdentity({ provider: 'guest', subject: 'abc' })), null);
	assert.strictEqual(identity.assertedKey(identity.parseIdentity('legacy-string')), null);
});

// escapeHtml ------------------------------------------------------------

test('escapeHtml neutralises a display name aimed at the dashboard', () => {
	// client_manager.writeState() builds its table by concatenation, and
	// displayName comes straight from the client.
	const escaped = identity.escapeHtml('<img src=x onerror=alert(1)>');
	assert.ok(!escaped.includes('<'));
	assert.ok(!escaped.includes('>'));
	assert.strictEqual(escaped, '&lt;img src=x onerror=alert(1)&gt;');
	assert.strictEqual(identity.escapeHtml('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');
	assert.strictEqual(identity.escapeHtml(null), '');
});

// Resolution ------------------------------------------------------------

test('an unverified client is asserted, and is recognised on its second visit', async () => {
	const resolver = new IdentityResolver(new MemoryUserStore());
	const raw = { provider: 'google', subject: '117934', displayName: 'Roderick' };

	const first = await resolver.resolve(raw, null);
	assert.strictEqual(first.tier, identity.TRUST_ASSERTED);
	assert.strictEqual(first.isNewUser, true);
	assert.strictEqual(first.record.visits, 1);

	const second = await resolver.resolve(raw, null);
	assert.strictEqual(second.isNewUser, false);
	assert.strictEqual(second.record.visits, 2);
	assert.strictEqual(second.key, first.key);
});

test('a verified client gets the verified keyspace and the token display name', async () => {
	const resolver = new IdentityResolver(new MemoryUserStore());
	const result = await resolver.resolve(
		{ provider: 'google', subject: '117934', displayName: 'client-supplied' },
		verified({ iss: 'https://accounts.google.com', sub: '117934', name: 'From Token' }));
	assert.strictEqual(result.tier, identity.TRUST_VERIFIED);
	assert.ok(!result.key.startsWith('asserted:'));
	// The name from the verified token wins over whatever the client typed.
	assert.strictEqual(result.record.displayName, 'From Token');
});

test('a forged assertion cannot reach a verified user record', async () => {
	const store = new MemoryUserStore();
	const resolver = new IdentityResolver(store);
	const real = await resolver.resolve(
		{ provider: 'google', subject: '117934' },
		verified({ iss: 'https://accounts.google.com', sub: '117934', name: 'Real User' }));
	real.update({ avatar: { contentHash: 'secret-hash', validated: {} } });

	// An attacker claims the same subject with no credential.
	const attacker = await resolver.resolve({ provider: 'google', subject: '117934' }, null);
	assert.strictEqual(attacker.tier, identity.TRUST_ASSERTED);
	assert.notStrictEqual(attacker.key, real.key);
	assert.strictEqual(attacker.record.avatar, null);
	assert.strictEqual(attacker.isNewUser, true);
});

test('guests and identity-less clients are anonymous and are not stored', async () => {
	const store = new MemoryUserStore();
	const resolver = new IdentityResolver(store);
	for (const raw of [null, undefined, { provider: 'guest', subject: 'abc123' }]) {
		const result = await resolver.resolve(raw, null);
		assert.strictEqual(result.tier, identity.TRUST_ANONYMOUS);
		assert.strictEqual(result.key, null);
		assert.strictEqual(result.record, null);
	}
	assert.strictEqual(store.size(), 0);
});

test('requireVerified downgrades unverified clients to anonymous', async () => {
	const store = new MemoryUserStore();
	const resolver = new IdentityResolver(store, { requireVerified: true });
	const result = await resolver.resolve({ provider: 'google', subject: '117934' }, null);
	assert.strictEqual(result.tier, identity.TRUST_ANONYMOUS);
	assert.strictEqual(store.size(), 0);
});

test('a verified result that cannot be keyed does not fall back to asserted', async () => {
	// A pairwise issuer whose token carried no audience. Guessing a key would
	// be worse than treating the client as anonymous.
	const resolver = new IdentityResolver(new MemoryUserStore());
	const result = await resolver.resolve(
		{ provider: 'apple', subject: '1' },
		verified({ iss: 'https://appleid.apple.com', sub: '1' }, { subjectScope: 'pairwise' }));
	assert.strictEqual(result.tier, identity.TRUST_ANONYMOUS);
});

// Verifier registry -----------------------------------------------------

test('an empty verifier registry is disabled, so no challenge is ever issued', () => {
	assert.strictEqual(new IdentityVerifier().enabled, false);
	assert.strictEqual(new IdentityVerifier().register('t', {}).enabled, true);
});

test('a verifier that throws leaves the client asserted rather than failing the connection', async () => {
	const registry = new IdentityVerifier().register('boom', {
		verify() { throw new Error('kaboom'); },
	});
	const result = await registry.verify({ type: 'boom', value: 'x' }, {});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'verifier_error');
});

test('an unregistered credential type is rejected, not ignored', async () => {
	const result = await new IdentityVerifier().register('known', { verify: async () => verified({}) })
		.verify({ type: 'unknown', value: 'x' }, {});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'unsupported_credential_type');
});

// Store -----------------------------------------------------------------

test('MemoryUserStore evicts the least recently seen user when full', () => {
	const store = new MemoryUserStore({ maxUsers: 3 });
	store.upsert('a', { tier: 'verified' });
	store.upsert('b', { tier: 'verified' });
	store.upsert('c', { tier: 'verified' });
	// Touch 'a' so 'b' becomes the oldest.
	store.get('a').lastSeen = Date.now() + 1000;
	store.upsert('d', { tier: 'verified' });
	assert.strictEqual(store.get('b'), null);
	assert.notStrictEqual(store.get('a'), null);
	assert.notStrictEqual(store.get('d'), null);
});
