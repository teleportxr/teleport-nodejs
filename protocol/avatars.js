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
const TELEPORT_SIGNAL_TYPE_PEER_AVATAR          = 'peer-avatar';
const TELEPORT_SIGNAL_TYPE_PEER_AVATAR_FAILED   = 'peer-avatar-failed';

// SignalingCapabilities ------------------------------------------------
// Free-form capability bag advertised on the `connect` envelope. Unknown
// keys are ignored on read and dropped on write — first-class flags only.

function decodeCapabilities(raw) {
	const out = { avatar_relay: false };
	if (raw && typeof raw === 'object' && typeof raw.avatar_relay === 'boolean') {
		out.avatar_relay = raw.avatar_relay;
	}
	return out;
}

function encodeCapabilities(caps) {
	return { avatar_relay: !!(caps && caps.avatar_relay) };
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

// AvatarResult / Revoke / Peer messages --------------------------------

function encodeAvatarResult(r) {
	return {
		policy_id:     Number(r.policy_id || 0n),
		status:        r.status || 'rejected',           // accepted | rejected | pending
		node_uid:      Number(r.node_uid || 0n),
		using_default: !!r.using_default,
		delivery:      r.delivery || 'import',           // import | relay
		reasons:       Array.isArray(r.reasons) ? r.reasons.slice() : []
	};
}

function encodeAvatarRevoke(r) {
	return { policy_id: Number(r.policy_id || 0n), reason: r.reason || '' };
}

function encodePeerAvatar(p) {
	const j = {
		peer_client_id: Number(p.peer_client_id || 0n),
		peer_node_uid:  Number(p.peer_node_uid  || 0n),
		revoked:        !!p.revoked
	};
	if (p.url          != null) j.url          = String(p.url);
	if (p.content_hash != null) j.content_hash = String(p.content_hash);
	if (p.format       != null) j.format       = String(p.format);
	if (p.proof)               j.proof        = Object.assign({}, p.proof);
	return j;
}

function parsePeerAvatarFailed(j) {
	const f = { peer_node_uid: 0n, reason: '' };
	if (!j || typeof j !== 'object') return f;
	if (j.peer_node_uid != null) f.peer_node_uid = BigInt(j.peer_node_uid);
	if (j.reason        != null) f.reason        = String(j.reason);
	return f;
}

module.exports = {
	TELEPORT_SIGNAL_TYPE_AVATAR_POLICY,
	TELEPORT_SIGNAL_TYPE_AVATAR_OFFER,
	TELEPORT_SIGNAL_TYPE_AVATAR_RESULT,
	TELEPORT_SIGNAL_TYPE_AVATAR_REVOKE,
	TELEPORT_SIGNAL_TYPE_PEER_AVATAR,
	TELEPORT_SIGNAL_TYPE_PEER_AVATAR_FAILED,
	decodeCapabilities, encodeCapabilities,
	AvatarPolicy, parseAvatarPolicy,
	parseAvatarOffer, encodeAvatarOffer,
	encodeAvatarResult, encodeAvatarRevoke,
	encodePeerAvatar, parsePeerAvatarFailed,
};
