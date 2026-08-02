'use strict';
// Tests for OIDC verification. Everything is local: an issuer keypair is
// generated in-process, tokens are minted against it, and the verifier is given
// the matching JWK set directly. No network.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { SignJWT, exportJWK, generateKeyPair, calculateJwkThumbprint } = require('jose');
const { OidcVerifier, IssuerConfig, signedMessage } = require('../identity/oidc_verifier.js');

const ISS = 'https://issuer.test';
const AUD = 'teleport-desktop.apps.example';
const SUB = '117934';
const SERVER_ID = '13503465235793';

// A fake issuer plus a client keypair, wired into a verifier.
async function harness(issuerOpts = {}) {
	const issuerKeys = await generateKeyPair('RS256');
	const jwk = await exportJWK(issuerKeys.publicKey);
	jwk.kid = 'test-key';
	jwk.alg = 'RS256';

	// The client's long-lived binding key. Ed25519, as the reference client uses.
	const clientKeys = crypto.generateKeyPairSync('ed25519');
	const clientJwk  = clientKeys.publicKey.export({ format: 'jwk' });
	const thumbprint = await calculateJwkThumbprint(clientJwk, 'sha256');

	const verifier = new OidcVerifier([new IssuerConfig(Object.assign({
		iss: ISS, audiences: [AUD], jwks: { keys: [jwk] },
	}, issuerOpts))]);

	// Mint an id_token. `nonce` defaults to the client key's thumbprint, which
	// is what binds the token to the key.
	async function mint(claims = {}) {
		const now = Math.floor(Date.now() / 1000);
		return new SignJWT(Object.assign({ nonce: thumbprint, name: 'Roderick' }, claims))
			.setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
			.setIssuer(claims.iss || ISS)
			.setAudience(claims.aud || AUD)
			.setSubject(claims.sub || SUB)
			.setIssuedAt(claims.iat != null ? claims.iat : now)
			.setExpirationTime(claims.exp != null ? claims.exp : now + 3600)
			.sign(issuerKeys.privateKey);
	}

	function sign(challenge, serverID = SERVER_ID, key = clientKeys.privateKey) {
		return crypto.sign(null, signedMessage(challenge, serverID), key).toString('base64url');
	}

	function context(challenge, overrides = {}) {
		return Object.assign({
			challenge, serverID: SERVER_ID, key: clientJwk, signature: sign(challenge),
		}, overrides);
	}

	return { verifier, mint, sign, context, clientJwk, clientKeys, thumbprint };
}

function credential(value) {
	return { type: 'oidc-id-token', value };
}

test('a correctly bound token with a good challenge signature verifies', async () => {
	const h = await harness();
	const result = await h.verifier.verify(credential(await h.mint()), h.context('chal-1'));
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.claims.sub, SUB);
	assert.strictEqual(result.claims.iss, ISS);
	assert.strictEqual(result.subjectScope, 'public');
});

test('a token from an unconfigured issuer is rejected', async () => {
	const h = await harness();
	const result = await h.verifier.verify(credential(await h.mint({ iss: 'https://evil.test' })), h.context('c'));
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'unknown_issuer');
});

test('a token minted for another application is rejected', async () => {
	const h = await harness();
	const result = await h.verifier.verify(credential(await h.mint({ aud: 'some-other-app' })), h.context('c'));
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'audience_mismatch');
});

test('a tampered token fails the signature check', async () => {
	const h = await harness();
	const token = await h.mint();
	const [header, payload, sig] = token.split('.');
	const forged = JSON.parse(Buffer.from(payload, 'base64url').toString());
	forged.sub = 'someone-else';
	const tampered = header + '.' + Buffer.from(JSON.stringify(forged)).toString('base64url') + '.' + sig;
	const result = await h.verifier.verify(credential(tampered), h.context('c'));
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'bad_signature');
});

test('a token whose nonce does not match the offered key is rejected', async () => {
	// This is the check that stops the token being a plain bearer credential.
	const h = await harness();
	const result = await h.verifier.verify(credential(await h.mint({ nonce: 'not-the-thumbprint' })), h.context('c'));
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'key_not_bound_to_token');
});

test('a token with no nonce at all is rejected', async () => {
	// An id_token obtained without the key-binding step proves nothing about
	// who is connecting.
	const h = await harness();
	const result = await h.verifier.verify(credential(await h.mint({ nonce: undefined })), h.context('c'));
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'key_not_bound_to_token');
});

test('a token replayed to another server cannot be used — the whole point', async () => {
	// A malicious server captures a valid token and its signature, then presents
	// both to a different Teleport server. That server issues its own challenge,
	// and the attacker cannot sign it without the client's private key.
	const h = await harness();
	const token = await h.mint();
	const victimChallenge = 'challenge-issued-by-server-A';
	const capturedSignature = h.sign(victimChallenge, 'server-A-id');

	const result = await h.verifier.verify(credential(token), {
		challenge: 'challenge-issued-by-server-B',   // B's own challenge
		serverID:  'server-B-id',
		key:       h.clientJwk,
		signature: capturedSignature,                // all the attacker has
	});
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'bad_challenge_signature');
});

test('a signature over the right challenge but the wrong server is rejected', async () => {
	// The serverID is part of the signed message, so a signature harvested by
	// one server cannot be presented to another even if the challenge matched.
	const h = await harness();
	const result = await h.verifier.verify(credential(await h.mint()), h.context('c', {
		signature: h.sign('c', 'a-different-server'),
	}));
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'bad_challenge_signature');
});

test('a signature from a different key is rejected', async () => {
	const h = await harness();
	const other = crypto.generateKeyPairSync('ed25519');
	const result = await h.verifier.verify(credential(await h.mint()), h.context('c', {
		signature: h.sign('c', SERVER_ID, other.privateKey),
	}));
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'bad_challenge_signature');
});

test('an expired token still verifies: the binding outlives the token', async () => {
	// `exp` is deliberately not enforced. An id_token lives about an hour, but
	// the client visits servers for weeks without signing in again, and the
	// live challenge signature is what proves presence.
	const h = await harness();
	const hourAgo = Math.floor(Date.now() / 1000) - 7200;
	const result = await h.verifier.verify(
		credential(await h.mint({ iat: hourAgo, exp: hourAgo + 3600 })), h.context('c'));
	assert.strictEqual(result.ok, true);
});

test('a sign-in older than the binding age is rejected', async () => {
	// Staleness is bounded by iat rather than exp, so a user must eventually
	// re-authenticate with the issuer.
	const h = await harness({ maxBindingAgeMs: 1000 });
	const longAgo = Math.floor(Date.now() / 1000) - 86400;
	const result = await h.verifier.verify(credential(await h.mint({ iat: longAgo })), h.context('c'));
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'binding_too_old');
});

test('a token issued in the future is rejected', async () => {
	const h = await harness();
	const later = Math.floor(Date.now() / 1000) + 86400;
	const result = await h.verifier.verify(credential(await h.mint({ iat: later })), h.context('c'));
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.reason, 'iat_in_future');
});

test('verification without proof of possession is refused', async () => {
	// A credential offered with no challenge answer is not evidence.
	const h = await harness();
	const token = await h.mint();
	for (const ctx of [{}, { challenge: 'c' }, { challenge: 'c', signature: 'x' }]) {
		const result = await h.verifier.verify(credential(token), ctx);
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.reason, 'no_proof_of_possession');
	}
});

test('malformed credentials are rejected without throwing', async () => {
	const h = await harness();
	assert.strictEqual((await h.verifier.verify(credential('not-a-jwt'), h.context('c'))).reason, 'malformed_token');
	assert.strictEqual((await h.verifier.verify(credential(''), h.context('c'))).reason, 'no_token');
	assert.strictEqual((await h.verifier.verify(null, h.context('c'))).reason, 'no_token');
	assert.strictEqual((await h.verifier.verify(credential(await h.mint()), h.context('c', { key: { kty: 'oops' } }))).reason, 'bad_key');
});

test('a pairwise issuer reports its scope so the key includes the audience', async () => {
	const h = await harness({ subjectScope: 'pairwise' });
	const result = await h.verifier.verify(credential(await h.mint()), h.context('c'));
	assert.strictEqual(result.ok, true);
	assert.strictEqual(result.subjectScope, 'pairwise');
});

test('IssuerConfig refuses a configuration that could accept any audience', async () => {
	assert.throws(() => new IssuerConfig({ iss: ISS, jwks: { keys: [] } }), /audience/);
	assert.throws(() => new IssuerConfig({ audiences: [AUD], jwks: { keys: [] } }), /iss/);
	assert.throws(() => new IssuerConfig({ iss: ISS, audiences: [AUD] }), /jwksUri or jwks/);
});
