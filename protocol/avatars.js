'use strict';
// JSON codecs for the avatar-negotiation signaling messages.
// Wire format mirrors Teleport/TeleportCore/Avatars.h and is documented
// in Teleport/docs/protocol/signaling.rst.
//
// Each codec is a tiny pair of plain JS helpers so callers can build the
// JSON object directly, or round-trip an incoming JSON value into a
// well-typed object. Unknown keys on incoming objects are preserved so
// future protocol fields survive a parse+emit cycle.

const TELEPORT_SIGNAL_TYPE_AVATAR_POLICY        = 'avatar-policy';
const TELEPORT_SIGNAL_TYPE_AVATAR_OFFER         = 'avatar-offer';
const TELEPORT_SIGNAL_TYPE_AVATAR_RESULT        = 'avatar-result';
const TELEPORT_SIGNAL_TYPE_AVATAR_REVOKE        = 'avatar-revoke';

// There are deliberately no peer-facing avatar messages: a client is only
// ever told about its own avatar (plans/avatars_plan.md §2.2). Another
// client's avatar reaches it as an ordinary node carrying a MeshPointer,
// through the geometry pipeline.

// SignalingCapabilities ------------------------------------------------
// Free-form capability bag advertised on the `connect` envelope. It is a
// general signaling-level extension point: a capability is a named boolean
// flag, and the set grows without a version bump because unknown names are
// carried through rather than rejected.
//
// This matters for more than tidiness. A peer that does not recognise a
// signal type forwards it to the WebRTC stack (see signaling.js's
// dispatcher and TeleportClient/SignalingServer.cpp), so a server must
// never send a new signal type to a client that has not advertised support
// for it — the frame would be pushed into libdatachannel as if it were SDP.
// Every capability below is such a gate.

// Client can answer an `identity-challenge` with a signed `identity-response`.
const CAPABILITY_IDENTITY_CHALLENGE = 'identity_challenge';

// Only boolean-valued keys are capabilities. Anything else is malformed and
// is dropped rather than being coerced, so a truthy-but-not-true value
// (`"false"`, `0`, `{}`) can never be mistaken for support.
function decodeCapabilities(raw) {
	const caps = {};
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		return caps;
	for (const [name, value] of Object.entries(raw)) {
		if (typeof value === 'boolean' && name.length)
			caps[name] = value;
	}
	return caps;
}

function encodeCapabilities(caps) {
	return decodeCapabilities(caps);
}

// True only when the peer explicitly advertised the capability.
function hasCapability(caps, name) {
	return !!caps && caps[name] === true;
}

// AvatarPolicy ---------------------------------------------------------

class AvatarPolicy {
	constructor(opts = {}) {
		this.policy_id          = BigInt(opts.policy_id || 0n);
		this.requirement        = opts.requirement || 'optional';   // required | optional | forbidden
		this.default_available  = !!opts.default_available;
		this.requirements       = opts.requirements || {};
		this.proof              = Object.assign({ required: false, accepted_schemes: [] }, opts.proof || {});
		if (opts.fetch_timeout_ms != null) this.fetch_timeout_ms = opts.fetch_timeout_ms;
	}
	toJSON() {
		const j = {
			policy_id:         Number(this.policy_id),
			requirement:       this.requirement,
			default_available: this.default_available,
			requirements:      this.requirements,
			proof: {
				required:         !!this.proof.required,
				accepted_schemes: Array.isArray(this.proof.accepted_schemes) ? this.proof.accepted_schemes : []
			}
		};
		if (this.fetch_timeout_ms != null) j.fetch_timeout_ms = this.fetch_timeout_ms;
		return j;
	}
}

function parseAvatarPolicy(j) {
	const p = new AvatarPolicy();
	if (!j || typeof j !== 'object') return p;
	if (j.policy_id         != null) p.policy_id         = BigInt(j.policy_id);
	if (j.requirement       != null) p.requirement       = String(j.requirement);
	if (j.default_available != null) p.default_available = !!j.default_available;
	if (j.requirements      != null) p.requirements      = j.requirements;
	if (j.proof             != null) p.proof = {
		required:         !!j.proof.required,
		accepted_schemes: Array.isArray(j.proof.accepted_schemes) ? j.proof.accepted_schemes.slice() : []
	};
	if (j.fetch_timeout_ms  != null) p.fetch_timeout_ms  = j.fetch_timeout_ms;
	return p;
}

// AvatarOffer ----------------------------------------------------------

function parseAvatarOffer(j) {
	const o = { policy_id: 0n, have_avatar: false };
	if (!j || typeof j !== 'object') return o;
	if (j.policy_id   != null) o.policy_id   = BigInt(j.policy_id);
	if (j.have_avatar != null) o.have_avatar = !!j.have_avatar;
	if (j.url          != null) o.url          = String(j.url);
	if (j.content_hash != null) o.content_hash = String(j.content_hash);
	if (j.declared && typeof j.declared === 'object') {
		o.declared = {
			format: j.declared.format ? String(j.declared.format) : '',
		};
		if (j.declared.file_bytes != null) o.declared.file_bytes = Number(j.declared.file_bytes);
		if (j.declared.triangles  != null) o.declared.triangles  = Number(j.declared.triangles);
	}
	if (j.proof && typeof j.proof === 'object') {
		o.proof = {
			scheme: j.proof.scheme ? String(j.proof.scheme) : '',
			value:  j.proof.value  ? String(j.proof.value)  : ''
		};
	}
	if (j.allow_relay != null) o.allow_relay = !!j.allow_relay;
	return o;
}

function encodeAvatarOffer(o) {
	const j = { policy_id: Number(o.policy_id || 0n), have_avatar: !!o.have_avatar };
	if (o.url          != null) j.url          = String(o.url);
	if (o.content_hash != null) j.content_hash = String(o.content_hash);
	if (o.declared) j.declared = Object.assign({}, o.declared);
	if (o.proof)    j.proof    = Object.assign({}, o.proof);
	if (o.allow_relay != null) j.allow_relay = !!o.allow_relay;
	return j;
}

// AvatarResult / Revoke -------------------------------------------------

function encodeAvatarResult(r) {
	return {
		policy_id:     Number(r.policy_id || 0n),
		status:        r.status || 'rejected',           // accepted | rejected | pending
		node_uid:      Number(r.node_uid || 0n),
		using_default: !!r.using_default,
		// relay (default) — the mesh pointer carries the owner's own url;
		// import — the server re-hosted the bytes and the pointer carries
		// the server's url. See plans/avatars_plan.md §2.1.
		delivery:      r.delivery || 'relay',
		reasons:       Array.isArray(r.reasons) ? r.reasons.slice() : []
	};
}

function encodeAvatarRevoke(r) {
	return { policy_id: Number(r.policy_id || 0n), reason: r.reason || '' };
}

// Relayable urls ---------------------------------------------------------
// Clients pick a decoder for a fetched mesh pointer from the url's file
// extension, so a url without a recognised one cannot be relayed — the
// server imports it instead (plans/avatars_plan.md §11.11, D10).

const RELAYABLE_EXTENSIONS = ['.glb', '.vrm', '.gltf'];

function isRelayableUrl(url) {
	if (typeof url !== 'string' || !url.length)
		return false;
	// Strip query and fragment first: '…/a.glb?token=x' is relayable,
	// '…/asset?format=glb' is not.
	const path = url.split('#')[0].split('?')[0].toLowerCase();
	return RELAYABLE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

module.exports = {
	TELEPORT_SIGNAL_TYPE_AVATAR_POLICY,
	TELEPORT_SIGNAL_TYPE_AVATAR_OFFER,
	TELEPORT_SIGNAL_TYPE_AVATAR_RESULT,
	TELEPORT_SIGNAL_TYPE_AVATAR_REVOKE,
	decodeCapabilities, encodeCapabilities, hasCapability,
	CAPABILITY_IDENTITY_CHALLENGE,
	AvatarPolicy, parseAvatarPolicy,
	parseAvatarOffer, encodeAvatarOffer,
	encodeAvatarResult, encodeAvatarRevoke,
	RELAYABLE_EXTENSIONS, isRelayableUrl,
};
