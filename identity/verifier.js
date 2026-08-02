'use strict';
// Credential verification and identity resolution.
//
// A credential is a typed slot — { type, value } — rather than a bare
// `id_token` field, because the methodologies a server might accept do not
// share a format:
//
//   oidc-id-token         OIDC (Google, Apple, Entra, Okta, Keycloak).
//                         A JWT checked against the issuer's JWKS.
//   oauth2-access-token   Plain OAuth2 (GitHub, Discord, Steam). There is no
//                         id_token at all; the server calls the provider's
//                         userinfo or introspection endpoint.
//   vc-jwt / did-proof    W3C Verifiable Credentials and DIDs. The subject is
//                         globally unique with no issuer, and verification is
//                         proof of key control.
//   saml-assertion        Enterprise SAML. XML signature; the NameID may be
//                         transient rather than stable.
//
// So verifiers are registered per credential type, and each one reports the
// issuer-specific way to derive a stable user key. identity/oidc_verifier.js
// implements the first of these; the rest are left to host applications.

const identity_proto = require('../protocol/identity.js');

// The result a verifier returns. `claims` must contain whatever the credential
// actually proved — in particular `iss`, which is the authoritative issuer and
// is never taken from the client's `connect` message.
function verified(claims, opts = {}) {
	return { ok: true, claims, subjectScope: opts.subjectScope || 'public', deriveSubject: opts.deriveSubject || null };
}

function rejected(reason) {
	return { ok: false, reason: reason || 'verification_failed', claims: null };
}

// Registry of verifiers by credential type.
class IdentityVerifier {
	constructor() {
		this.verifiers = new Map();
	}

	// `verifier` is any object with async verify(credential, context) →
	// { ok, claims, subjectScope, deriveSubject } | { ok:false, reason }.
	// `context` carries { identity, challenge, key, signature, serverID }.
	register(type, verifier) {
		this.verifiers.set(type, verifier);
		return this;
	}

	has(type) {
		return this.verifiers.has(type);
	}

	// True when at least one credential type can be checked. A server with an
	// empty registry never issues a challenge, since it could not evaluate the
	// answer.
	get enabled() {
		return this.verifiers.size > 0;
	}

	async verify(credential, context) {
		if (!credential || typeof credential !== 'object')
			return rejected('no_credential');
		const type = typeof credential.type === 'string' ? credential.type : '';
		const verifier = this.verifiers.get(type);
		if (!verifier)
			return rejected('unsupported_credential_type');
		try {
			const result = await verifier.verify(credential, context || {});
			if (!result || !result.ok)
				return rejected((result && result.reason) || 'verification_failed');
			return result;
		} catch (err) {
			// A verifier failure must never take the connection down; the
			// client simply stays at the asserted tier.
			console.log('identity: verifier for "' + type + '" threw: ' + (err && err.message ? err.message : err));
			return rejected('verifier_error');
		}
	}
}

// Turns a parsed identity — plus, optionally, the result of verifying a
// credential — into the user record a server should act on.
//
// This is the only place the trust tier is decided, and it is the only place
// that chooses between the asserted and verified keyspaces.
class IdentityResolver {
	constructor(store, opts = {}) {
		this.store = store;
		// When true, an unverified client is treated as anonymous rather than
		// asserted: nothing about it is remembered. Servers that act on
		// identity in any way that matters should set this.
		this.requireVerified = !!opts.requireVerified;
	}

	// `verifyResult` is the value returned by IdentityVerifier.verify(), or
	// null when no credential was offered or none was asked for.
	async resolve(identityRaw, verifyResult) {
		const identity = identity_proto.parseIdentity(identityRaw);

		if (verifyResult && verifyResult.ok) {
			const key = identity_proto.verifiedKey(verifyResult.claims, {
				subjectScope:  verifyResult.subjectScope,
				deriveSubject: verifyResult.deriveSubject,
			});
			if (key) {
				return this._record(key, identity_proto.TRUST_VERIFIED, identity, verifyResult.claims);
			}
			// Verified but unkeyable — e.g. a pairwise issuer whose token
			// carried no audience. Anonymous, not asserted: the client proved
			// itself, so demoting it into the forgeable keyspace would file a
			// verified user's state where anyone could later claim it.
			console.log('identity: credential verified but no stable key could be derived; treating as anonymous.');
			return { tier: identity_proto.TRUST_ANONYMOUS, key: null, record: null, isNewUser: true, identity };
		}

		// Anonymous: no identity, a guest provider, or a server that only
		// trusts verified users. Nothing is stored.
		if (!identity || identity_proto.isGuestIdentity(identity) || this.requireVerified) {
			return {
				tier:      identity_proto.TRUST_ANONYMOUS,
				key:       null,
				record:    null,
				isNewUser: true,
				identity,
			};
		}

		return this._record(identity_proto.assertedKey(identity), identity_proto.TRUST_ASSERTED, identity, null);
	}

	async _record(key, tier, identity, claims) {
		if (!key) {
			return { tier: identity_proto.TRUST_ANONYMOUS, key: null, record: null, isNewUser: true, identity };
		}
		const existing = await this.store.get(key);
		const isNewUser = !existing;
		// A verified display name comes from the token; an asserted one is
		// whatever the client typed. Either way it is display-only, and
		// escaped at the point of rendering.
		const displayName = (claims && typeof claims.name === 'string' && claims.name.length)
			? claims.name.slice(0, identity_proto.MAX_DISPLAY_NAME)
			: (identity ? identity.displayName : '');
		const record = await this.store.upsert(key, {
			tier,
			provider: identity ? identity.provider : '',
			displayName,
			visits: (existing ? existing.visits : 0) + 1,
		});
		const store = this.store;
		return {
			tier, key, record, isNewUser, identity,
			// Write-through, so a store that is not just an in-process Map
			// actually persists. Callers hold the resolved user, not the store.
			update(patch) {
				Object.assign(record, patch || {});
				return store.upsert(key, patch);
			},
		};
	}
}

module.exports = { IdentityVerifier, IdentityResolver, verified, rejected };
