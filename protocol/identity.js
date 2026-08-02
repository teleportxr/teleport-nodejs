'use strict';
// Parsing and canonicalisation for the `identity` member of the `connect`
// signaling message, documented in Teleport/docs/protocol/signaling.rst.
//
// `identity` tells a server who is connecting, so that it can distinguish a
// new user from one it already knows. It is *not* the same thing as
// `clientID`, which is a per-session handle (core.generateUid()) and is
// neither stable across restarts nor authenticated.
//
// A server must decide how much to believe. Three tiers:
//
//   anonymous  no identity at all, or a guest provider. Fully functional,
//              but nothing is remembered between sessions.
//   asserted   the client claims a provider and subject, with no credential
//              backing it — which is all any client sent before verification
//              existed. Anyone can claim anyone's subject, so this tier gets
//              its own keyspace and may only hold convenience state.
//   verified   a credential was checked against the issuer (see
//              identity/verifier.js). Keys derive from the *token's* claims,
//              never from anything the client typed.
//
// The asserted and verified keyspaces are produced by two separate functions
// rather than one function with a mode argument, so that a forged assertion
// can never resolve to a verified user's record by accident.

const TELEPORT_SIGNAL_TYPE_IDENTITY_CHALLENGE = 'identity-challenge';
const TELEPORT_SIGNAL_TYPE_IDENTITY_RESPONSE  = 'identity-response';

const TRUST_ANONYMOUS = 'anonymous';
const TRUST_ASSERTED  = 'asserted';
const TRUST_VERIFIED  = 'verified';

// Providers that never denote a durable account. A guest subject is a random
// number the client made up (GuestIdentityProvider::GenerateSubject), so it
// identifies an installation at best and must not be treated as a user.
const GUEST_PROVIDERS = new Set(['guest', 'anonymous', 'opaque']);

// A display name is shown to operators and other users, so it is bounded
// here rather than wherever it happens to be rendered.
const MAX_DISPLAY_NAME = 64;

function asString(v) {
	return typeof v === 'string' ? v : '';
}

// Parse the wire form into a plain object, or null if there is no usable
// identity. Tolerant by design: a malformed identity must never fail a
// connection, it just leaves the client anonymous.
//
// Accepts the object form, and also a bare string for the legacy shape the
// protocol documented before the object existed. A legacy string is recorded
// under the 'opaque' provider, which is a guest provider — an unstructured
// string carries no issuer, so there is nothing to check it against and
// nothing to safely key on.
function parseIdentity(raw) {
	if (typeof raw === 'string') {
		const subject = raw.trim();
		if (!subject.length)
			return null;
		return { provider: 'opaque', iss: '', subject, displayName: '', aud: '' };
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		return null;

	const identity = {
		// A client-chosen label, e.g. "google". Useful for display and for
		// routing to a verifier, but it is NOT an identifier: any client can
		// write any provider name. The authoritative issuer is `iss`, which
		// appears as a signed claim inside the credential.
		provider:    asString(raw.provider).trim().toLowerCase(),
		iss:         asString(raw.iss).trim(),
		// OIDC `sub`: stable and never reassigned, but unique only within an
		// issuer — so it is never a key on its own.
		subject:     asString(raw.subject).trim(),
		displayName: asString(raw.displayName).trim().slice(0, MAX_DISPLAY_NAME),
		// The audience the credential was issued to. Needed because some
		// issuers scope `sub` per client id — see verifiedKey().
		aud:         asString(raw.aud).trim(),
	};
	if (!identity.subject.length)
		return null;
	if (!identity.provider.length && !identity.iss.length)
		return null;
	return identity;
}

function isGuestIdentity(identity) {
	return !identity || GUEST_PROVIDERS.has(identity.provider);
}

// Key components are percent-encoded before being joined, so that a subject
// or audience containing the separator cannot be crafted to collide with a
// different user's key.
function joinKey(parts) {
	return parts.map((p) => encodeURIComponent(p)).join('|');
}

// Keyspace for identities we have not verified. Deliberately prefixed and
// deliberately built from `provider` rather than `iss`: an unverified claim
// must be unable to name a verified record, whatever the client writes.
function assertedKey(identity) {
	if (!identity || isGuestIdentity(identity))
		return null;
	return 'asserted:' + joinKey([identity.provider, identity.subject]);
}

// Keyspace for verified identities. `claims` must come from a checked
// credential, never from the `connect` message.
//
// `subjectScope` reflects how the issuer allocates `sub`:
//
//   'public'    one subject per user across every client id (Google).
//               Key on (iss, sub).
//   'pairwise'  a different subject per client id (Sign in with Apple,
//               Microsoft Entra, anything configured subject_type=pairwise).
//               Key on (iss, aud, sub), because the same person arriving via
//               a different client id is, to that issuer, a different subject
//               and cannot be merged without the issuer's help.
//
// Teleport's desktop and headless clients register *different* Google client
// ids, so this distinction becomes load-bearing the moment a pairwise issuer
// is configured.
//
// `deriveSubject` exists because not every issuer's stable identifier is
// `sub`: Microsoft Entra's is the (tid, oid) pair, and `sub` there is pairwise
// per application. An issuer config can supply its own derivation.
function verifiedKey(claims, opts = {}) {
	if (!claims)
		return null;
	const iss = asString(claims.iss).trim();
	if (!iss.length)
		return null;
	const derive = typeof opts.deriveSubject === 'function' ? opts.deriveSubject : (c) => asString(c.sub);
	const subject = asString(derive(claims)).trim();
	if (!subject.length)
		return null;
	if (opts.subjectScope === 'pairwise') {
		// `aud` may legitimately be an array; the first entry is the party the
		// token was issued to. Without it a pairwise subject is ambiguous, so
		// refuse rather than silently keying on (iss, sub).
		const rawAud = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
		const aud = asString(rawAud).trim();
		if (!aud.length)
			return null;
		return joinKey([iss, aud, subject]);
	}
	return joinKey([iss, subject]);
}

// Escape for the operator dashboard. `displayName` is attacker-controlled and
// client_manager.writeState() builds its table by string concatenation, so
// this is not optional.
function escapeHtml(value) {
	return String(value == null ? '' : value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

module.exports = {
	TELEPORT_SIGNAL_TYPE_IDENTITY_CHALLENGE,
	TELEPORT_SIGNAL_TYPE_IDENTITY_RESPONSE,
	TRUST_ANONYMOUS, TRUST_ASSERTED, TRUST_VERIFIED,
	GUEST_PROVIDERS, MAX_DISPLAY_NAME,
	parseIdentity, isGuestIdentity,
	assertedKey, verifiedKey,
	escapeHtml,
};
