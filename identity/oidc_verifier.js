'use strict';
// Verifies an OIDC id_token, and the proof that the client connecting to us is
// the one the token was issued to.
//
// The problem this solves
// -----------------------
// An id_token is a bearer assertion whose audience is the *client's* OAuth
// client id — not ours. If a client simply forwarded its id_token, any server
// it visited could replay that token to a different Teleport server and be
// accepted as the user. The usual fix is for the relying party to supply a
// nonce, but OIDC only lets a nonce be injected at interactive sign-in, and
// the refresh grant does not accept one at all. A client signs in once and
// then visits many servers, so there is no point at which we could inject a
// nonce of our own without forcing a fresh browser sign-in per connection.
//
// So the nonce is spent on something better than a session. At sign-in the
// client generates a long-lived keypair and sets
//
//     nonce = JWK thumbprint (RFC 7638) of its public key
//
// The id_token then attests "the holder of this key is <iss>/<sub>", which is
// worthless to anyone who does not hold the private key. Freshness comes from
// a second step: we send a random challenge, and the client signs it. A server
// that captured the token cannot answer another server's challenge.
//
// Consequently `exp` is deliberately NOT enforced. The token's job is to
// attest a key binding, and that binding does not stop being true when the
// hour is up; the live signature is what proves the client is present right
// now. Staleness is bounded by `maxBindingAgeMs` against `iat` instead, after
// which the user must sign in interactively again.

const crypto = require('crypto');
const { createRemoteJWKSet, createLocalJWKSet, compactVerify, decodeJwt, calculateJwkThumbprint } = require('jose');
const { verified, rejected } = require('./verifier.js');

const CREDENTIAL_TYPE = 'oidc-id-token';

// Default: a sign-in is good for 30 days before the client must re-authenticate
// interactively.
const DEFAULT_MAX_BINDING_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Allowance for clock skew between us and the issuer.
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

// Domain separation: the signed message can never be mistaken for a signature
// over anything else the same key might be asked to sign.
const SIGNATURE_PREFIX = 'teleport-identity:';

function signedMessage(challenge, serverID) {
	return Buffer.from(SIGNATURE_PREFIX + challenge + ':' + serverID, 'utf8');
}

// One configured issuer.
//
//   iss             exact issuer URL, matched against the token's `iss` claim.
//   jwksUri         where to fetch signing keys. Omit and pass `jwks` instead
//                   to supply a fixed key set (used by tests).
//   audiences       client ids we accept tokens for. Teleport's desktop and
//                   headless clients register separately, so this is a list.
//   subjectScope    'public' (one subject per user, e.g. Google) or 'pairwise'
//                   (a different subject per client id: Apple, Entra). See
//                   protocol/identity.js — this decides the shape of the key.
//   deriveSubject   optional (claims) → string, for issuers whose stable
//                   identifier is not `sub`. Microsoft Entra's, for instance,
//                   is the (tid, oid) pair.
//   maxBindingAgeMs how old the sign-in may be.
class IssuerConfig {
	constructor(opts = {}) {
		this.iss             = String(opts.iss || '');
		this.audiences       = Array.isArray(opts.audiences) ? opts.audiences.map(String) : [];
		this.subjectScope    = opts.subjectScope === 'pairwise' ? 'pairwise' : 'public';
		this.deriveSubject   = typeof opts.deriveSubject === 'function' ? opts.deriveSubject : null;
		this.maxBindingAgeMs = opts.maxBindingAgeMs || DEFAULT_MAX_BINDING_AGE_MS;
		if (!this.iss.length)
			throw new Error('IssuerConfig requires iss');
		if (!this.audiences.length)
			throw new Error('IssuerConfig for ' + this.iss + ' requires at least one audience');
		if (opts.jwks)
			this.keys = createLocalJWKSet(opts.jwks);
		else if (opts.jwksUri)
			this.keys = createRemoteJWKSet(new URL(opts.jwksUri));
		else
			throw new Error('IssuerConfig for ' + this.iss + ' requires jwksUri or jwks');
	}
}

class OidcVerifier {
	constructor(issuers = []) {
		this.issuers = new Map();
		for (const issuer of issuers)
			this.addIssuer(issuer);
	}

	addIssuer(config) {
		const issuer = config instanceof IssuerConfig ? config : new IssuerConfig(config);
		this.issuers.set(issuer.iss, issuer);
		return this;
	}

	// context: { identity, challenge, key, signature, serverID }
	async verify(credential, context) {
		const token = credential && typeof credential.value === 'string' ? credential.value : '';
		if (!token.length)
			return rejected('no_token');
		if (!context || !context.challenge || !context.signature || !context.key)
			return rejected('no_proof_of_possession');

		// Read the issuer before trusting anything, only to select a key set.
		// Every claim is re-read from the verified payload below.
		let unverified;
		try {
			unverified = decodeJwt(token);
		} catch (err) {
			return rejected('malformed_token');
		}
		const issuer = this.issuers.get(String(unverified.iss || ''));
		if (!issuer)
			return rejected('unknown_issuer');

		// Signature. compactVerify rather than jwtVerify because our claim
		// policy is not the standard one — see the note on `exp` above.
		let claims;
		try {
			const { payload } = await compactVerify(token, issuer.keys);
			claims = JSON.parse(Buffer.from(payload).toString('utf8'));
		} catch (err) {
			return rejected('bad_signature');
		}

		if (String(claims.iss || '') !== issuer.iss)
			return rejected('issuer_mismatch');

		// The audience is the client id the token was minted for. An id_token
		// for some unrelated application is not evidence about our user.
		const auds = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud || '')];
		if (!auds.some((a) => issuer.audiences.includes(a)))
			return rejected('audience_mismatch');

		if (!claims.sub || !String(claims.sub).length)
			return rejected('no_subject');

		// Binding age. `exp` is not checked (see header); `iat` bounds how long
		// ago the user actually proved themselves to the issuer.
		const iatMs = Number(claims.iat || 0) * 1000;
		if (!iatMs)
			return rejected('no_iat');
		const now = Date.now();
		if (iatMs > now + CLOCK_TOLERANCE_MS)
			return rejected('iat_in_future');
		if (now - iatMs > issuer.maxBindingAgeMs + CLOCK_TOLERANCE_MS)
			return rejected('binding_too_old');

		// The nonce binds the token to the client's key. Without this check the
		// token would be a bearer credential and replay would be wide open.
		let thumbprint;
		try {
			thumbprint = await calculateJwkThumbprint(context.key, 'sha256');
		} catch (err) {
			return rejected('bad_key');
		}
		if (String(claims.nonce || '') !== thumbprint)
			return rejected('key_not_bound_to_token');

		// Proof of possession: the holder of that key is here, now, and is
		// answering *our* challenge.
		if (!this._verifySignature(context))
			return rejected('bad_challenge_signature');

		return verified(claims, { subjectScope: issuer.subjectScope, deriveSubject: issuer.deriveSubject });
	}

	_verifySignature(context) {
		try {
			const publicKey = crypto.createPublicKey({ key: context.key, format: 'jwk' });
			const signature = Buffer.from(String(context.signature), 'base64url');
			// Ed25519 takes a null algorithm: the hash is part of the scheme.
			return crypto.verify(null, signedMessage(context.challenge, context.serverID), publicKey, signature);
		} catch (err) {
			return false;
		}
	}
}

// Google, the provider the reference client implements. Public subjects, so a
// user is the same person across every client id — which is why the desktop and
// headless clients can share one identity.
function googleIssuer(audiences, opts = {}) {
	return new IssuerConfig(Object.assign({
		iss:          'https://accounts.google.com',
		jwksUri:      'https://www.googleapis.com/oauth2/v3/certs',
		audiences,
		subjectScope: 'public',
	}, opts));
}

module.exports = {
	OidcVerifier, IssuerConfig, googleIssuer,
	CREDENTIAL_TYPE, signedMessage,
	DEFAULT_MAX_BINDING_AGE_MS, CLOCK_TOLERANCE_MS,
};
