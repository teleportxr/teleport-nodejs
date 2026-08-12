'use strict';
// Stage 2 of the Universal Manifest evaluation sequence: signature and
// freshness. Key pairs are generated per test so nothing depends on a
// checked-in secret.

const test		= require('node:test');
const assert	= require('node:assert');
const crypto	= require('node:crypto');

const verify	= require('../manifest/verify.js');
const jcs		= require('../manifest/jcs.js');
const fx		= require('./helpers/manifest_fixtures.js');

// Key handling -----------------------------------------------------

test('did:key round-trips an Ed25519 public key', () => {
	const keys		= fx.generateKeyPair();
	const did		= fx.didKeyFor(keys.publicKey);
	const resolved	= verify.keyFromDidKey(did);
	assert.ok(resolved);
	assert.ok(verify.rawFromKey(resolved).equals(fx.rawPublicKey(keys.publicKey)));
});

test('did:key ignores a fragment', () => {
	const keys = fx.generateKeyPair();
	const did  = fx.didKeyFor(keys.publicKey);
	assert.ok(verify.keyFromDidKey(did + '#' + did.slice('did:key:'.length)));
});

test('did:key rejects a non-Ed25519 multicodec prefix', () => {
	// 0xec01 is X25519, not Ed25519: a signature key it is not.
	const raw = fx.rawPublicKey(fx.generateKeyPair().publicKey);
	const bad = 'did:key:z' + fx.base58Encode(Buffer.concat([Buffer.from([0xec, 0x01]), raw]));
	assert.strictEqual(verify.keyFromDidKey(bad), null);
});

test('did:key rejects malformed base58', () => {
	assert.strictEqual(verify.keyFromDidKey('did:key:z0OIl'), null);
	assert.strictEqual(verify.keyFromDidKey('did:web:example.com'), null);
	assert.strictEqual(verify.keyFromDidKey(''), null);
});

test('inline SPKI parses in both base64 and base64url', () => {
	const keys	= fx.generateKeyPair();
	const b64	= fx.spkiBase64For(keys.publicKey);
	const b64u	= b64.replace(/\+/g, '-').replace(/\//g, '_');
	assert.ok(verify.keyFromSpkiBase64(b64));
	assert.ok(verify.keyFromSpkiBase64(b64u));
});

// Signature --------------------------------------------------------

test('a correctly signed manifest verifies', async () => {
	const { manifest } = fx.makeManifest();
	const result = await verify.verifyManifest(manifest);
	assert.strictEqual(result.signatureCheck, 'valid');
	assert.strictEqual(result.freshnessCheck, 'fresh');
	assert.deepStrictEqual(result.reasons, []);
});

test('a tampered payload fails verification', async () => {
	const { manifest } = fx.makeManifest();
	// Change the avatar the manifest points at, leaving the signature.
	manifest.pointers[0].target = 'https://evil.example/other.glb';
	const result = await verify.verifyManifest(manifest);
	assert.strictEqual(result.signatureCheck, 'invalid');
	assert.ok(result.reasons.includes('manifest_signature_invalid'));
});

test('a manifest signed by a different key fails verification', async () => {
	const other = fx.generateKeyPair();
	const { manifest } = fx.makeManifest();
	// Re-sign with a key that the keyRef does not name.
	const { signature, ...payload } = manifest;
	manifest.signature = Object.assign({}, signature, {
		value: crypto.sign(null, jcs.canonicalizeToBuffer(payload), other.privateKey).toString('base64url'),
	});
	const result = await verify.verifyManifest(manifest);
	assert.strictEqual(result.signatureCheck, 'invalid');
});

test('member order in the received document does not affect verification', async () => {
	// The whole point of canonicalisation: a proxy or JSON library that
	// reorders members must not break the signature.
	const { manifest } = fx.makeManifest();
	const reordered = JSON.parse(JSON.stringify(manifest));
	const shuffled = {};
	for (const key of Object.keys(reordered).sort().reverse())
		shuffled[key] = reordered[key];
	const result = await verify.verifyManifest(shuffled);
	assert.strictEqual(result.signatureCheck, 'valid');
});

test('an unknown member added after signing invalidates the signature', async () => {
	// Unknown members are preserved AND covered by the signature; that
	// is what makes forward compatibility safe rather than a hole.
	const { manifest } = fx.makeManifest();
	manifest.somethingFromAFutureVersion = { hello: 'world' };
	const result = await verify.verifyManifest(manifest);
	assert.strictEqual(result.signatureCheck, 'invalid');
});

test('an unknown member present at signing time verifies', async () => {
	const built = fx.makeManifest({ overrides: { somethingFromAFutureVersion: { hello: 'world' } } });
	const result = await verify.verifyManifest(built.manifest);
	assert.strictEqual(result.signatureCheck, 'valid');
});

// Key substitution -------------------------------------------------

test('an inline key disagreeing with keyRef is refused', async () => {
	// The attack this blocks: re-sign a modified manifest with your own
	// key, then set publicKeySpkiB64 to your key so it self-verifies.
	const victim	= fx.generateKeyPair();
	const attacker	= fx.generateKeyPair();
	const built		= fx.makeManifest({ keys: victim });

	const { signature, ...payload } = built.manifest;
	payload.pointers[0].target = 'https://evil.example/other.glb';
	const forged = Object.assign({}, payload, {
		signature: {
			algorithm:			'Ed25519',
			canonicalization:	'JCS-RFC8785',
			keyRef:				signature.keyRef,	// still names the victim
			publicKeySpkiB64:	fx.spkiBase64For(attacker.publicKey),
			value:				crypto.sign(null, jcs.canonicalizeToBuffer(payload), attacker.privateKey).toString('base64url'),
		},
	});

	const result = await verify.verifyManifest(forged);
	assert.strictEqual(result.signatureCheck, 'invalid');
	assert.ok(result.reasons.includes('manifest_signature_invalid'));
});

test('an inline key agreeing with keyRef is accepted', async () => {
	const keys = fx.generateKeyPair();
	const built = fx.makeManifest({ keys, signatureMembers: { publicKeySpkiB64: fx.spkiBase64For(keys.publicKey) } });
	const result = await verify.verifyManifest(built.manifest);
	assert.strictEqual(result.signatureCheck, 'valid');
});

test('an unresolvable keyRef is refused even with an inline key', async () => {
	// Skipping key resolution because an inline key is present is exactly
	// the non-conformance that opens key substitution.
	const keys = fx.generateKeyPair();
	const built = fx.makeManifest({
		keys,
		keyRef: 'did:web:issuer.example',
		signatureMembers: { publicKeySpkiB64: fx.spkiBase64For(keys.publicKey) },
	});
	const result = await verify.verifyManifest(built.manifest);
	assert.strictEqual(result.signatureCheck, 'invalid');
	assert.ok(result.reasons.includes('manifest_key_unresolvable'));
});

test('an https keyRef resolves through the injected fetcher', async () => {
	const keys	= fx.generateKeyPair();
	const jwks	= {
		keys: [{
			kty: 'OKP', crv: 'Ed25519', kid: 'k1',
			x: fx.rawPublicKey(keys.publicKey).toString('base64url'),
		}],
	};
	const built = fx.makeManifest({ keys, keyRef: 'https://issuer.example/jwks.json#k1' });
	const fetcher = fx.makeFetcher({ 'https://issuer.example/jwks.json': JSON.stringify(jwks) });

	const result = await verify.verifyManifest(built.manifest, { fetcher });
	assert.strictEqual(result.signatureCheck, 'valid');
	assert.strictEqual(fetcher.calls.length, 1);
	// The key fetch is subject to the same scheme allow-list as everything else.
	assert.deepStrictEqual(fetcher.calls[0].allowedSchemes, ['https:']);
});

test('an https keyRef with no usable key is unresolvable', async () => {
	const built = fx.makeManifest({ keyRef: 'https://issuer.example/jwks.json' });
	const fetcher = fx.makeFetcher({ 'https://issuer.example/jwks.json': JSON.stringify({ keys: [{ kty: 'RSA' }] }) });
	const result = await verify.verifyManifest(built.manifest, { fetcher });
	assert.ok(result.reasons.includes('manifest_key_unresolvable'));
});

test('an https keyRef with no fetcher is unresolvable', async () => {
	const built = fx.makeManifest({ keyRef: 'https://issuer.example/jwks.json' });
	const result = await verify.verifyManifest(built.manifest);
	assert.ok(result.reasons.includes('manifest_key_unresolvable'));
});

// Profile ----------------------------------------------------------

test('an unsupported algorithm or canonicalisation is reported as such', async () => {
	for (const members of [{ algorithm: 'RS256' }, { canonicalization: 'URDNA2015' }])
	{
		const built = fx.makeManifest({ signatureMembers: members });
		const result = await verify.verifyManifest(built.manifest);
		assert.strictEqual(result.signatureCheck, 'unsupported-profile');
	}
});

test('a missing signature is an unsupported profile, not a crash', async () => {
	const built = fx.makeManifest({ unsigned: true });
	const result = await verify.verifyManifest(built.manifest);
	assert.strictEqual(result.signatureCheck, 'unsupported-profile');
});

// Freshness --------------------------------------------------------

test('freshness: within the validity window is fresh', () => {
	const now = Date.now();
	const { manifest } = fx.makeManifest({ now });
	assert.strictEqual(verify.checkFreshness(manifest, { now }), 'fresh');
});

test('freshness: past expiresAt beyond skew is expired', () => {
	const now = Date.now();
	const { manifest } = fx.makeManifest({ expiresAt: new Date(now - 10 * 60 * 1000).toISOString() });
	assert.strictEqual(verify.checkFreshness(manifest, { now }), 'expired');
});

test('freshness: just past expiresAt but within skew is still fresh', () => {
	const now = Date.now();
	const { manifest } = fx.makeManifest({ expiresAt: new Date(now - 10 * 1000).toISOString() });
	assert.strictEqual(verify.checkFreshness(manifest, { now, clockSkewMs: 60000 }), 'fresh');
});

test('freshness: issuedAt in the future beyond skew is stale', () => {
	const now = Date.now();
	const { manifest } = fx.makeManifest({
		issuedAt:  new Date(now + 10 * 60 * 1000).toISOString(),
		expiresAt: new Date(now + 24 * 3600 * 1000).toISOString(),
	});
	assert.strictEqual(verify.checkFreshness(manifest, { now }), 'stale');
});

test('freshness: unparseable timestamps are treated as expired', () => {
	const { manifest } = fx.makeManifest({ expiresAt: 'not-a-date' });
	assert.strictEqual(verify.checkFreshness(manifest), 'expired');
});

test('an expired manifest reports both the freshness failure and its reason', async () => {
	const now = Date.now();
	const built = fx.makeManifest({ expiresAt: new Date(now - 3600 * 1000).toISOString() });
	const result = await verify.verifyManifest(built.manifest, { now });
	assert.strictEqual(result.freshnessCheck, 'expired');
	assert.ok(result.reasons.includes('manifest_expired'));
	// The signature is still checked and still valid: expiry and
	// authenticity are separate questions.
	assert.strictEqual(result.signatureCheck, 'valid');
});

// Signing input ----------------------------------------------------

test('signingInput excludes the signature member', () => {
	const { manifest } = fx.makeManifest();
	const input = verify.signingInput(manifest).toString('utf8');
	assert.ok(!input.includes('"signature"'));
	assert.ok(input.includes('"manifestVersion"'));
});
