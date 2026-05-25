'use strict';
// Per-client server-side state for avatar negotiation. Phase 2 of the
// implementation in plans/avatars_implementation.md: round-trip a policy,
// receive an offer, always reply with using_default. No validation, no
// download, no import. Behaviour is the same regardless of whether the
// client offered an avatar or not.
//
// One AvatarService is owned by each Client; messages are dispatched in
// from the signaling layer.

const avatars = require('../protocol/avatars.js');

function envelope(type, content) {
	return JSON.stringify({ 'teleport-signal-type': type, content });
}

class AvatarService {
	constructor(clientID, sigSend) {
		this.clientID		= clientID;
		this.sigSend		= sigSend;
		this.currentPolicy	= null;
		this.lastOffer		= null;
		this.lastResult		= null;
	}

	// Send (or re-send) the policy to the owning client. The client is
	// expected to reply with an avatar-offer.
	sendPolicy(policy) {
		if (!policy)
			return;
		this.currentPolicy = policy;
		const content = policy && typeof policy.toJSON === 'function'
			? policy.toJSON()
			: avatars.parseAvatarPolicy(policy).toJSON();
		console.log('avatar-policy → client ' + this.clientID + ' policy_id=' + content.policy_id);
		this.sigSend(envelope(avatars.TELEPORT_SIGNAL_TYPE_AVATAR_POLICY, content));
	}

	// Handle an incoming avatar-offer. Phase 2 always replies using_default.
	handleOffer(offerJson) {
		const offer = avatars.parseAvatarOffer(offerJson);
		this.lastOffer = offer;
		console.log('avatar-offer  ← client ' + this.clientID +
			' policy_id=' + offer.policy_id +
			' have_avatar=' + offer.have_avatar);

		// If we have not sent a policy, or the offer references a different
		// policy_id, reject so the client knows it is talking about something
		// the server does not currently care about.
		if (!this.currentPolicy ||
			BigInt(offer.policy_id || 0n) !== BigInt(this.currentPolicy.policy_id))
		{
			this._reply({
				policy_id:		offer.policy_id || 0n,
				status:			'rejected',
				node_uid:		0n,
				using_default:	false,
				delivery:		'import',
				reasons:		['policy_unknown'],
			});
			return;
		}

		// Phase 2: regardless of what the client offered, the server uses its
		// default avatar. node_uid is 0 because no real node has been imported.
		this._reply({
			policy_id:		offer.policy_id,
			status:			'using_default',
			node_uid:		0n,
			using_default:	true,
			delivery:		'import',
			reasons:		[],
		});
	}

	// Handle a client-initiated revoke (rare in Phase 2; provided for
	// symmetry with later phases).
	handleRevoke(revokeJson) {
		const policy_id = revokeJson && revokeJson.policy_id != null
			? BigInt(revokeJson.policy_id) : 0n;
		console.log('avatar-revoke ← client ' + this.clientID + ' policy_id=' + policy_id);
		// In Phase 2 a revoke from the client just drops cached state; the
		// server keeps the same policy in force and a new offer is expected
		// next.
		this.lastOffer = null;
		this.lastResult = null;
	}

	_reply(result) {
		const content = avatars.encodeAvatarResult(result);
		this.lastResult = content;
		console.log('avatar-result → client ' + this.clientID +
			' status=' + content.status +
			' delivery=' + content.delivery +
			(content.reasons.length ? ' reasons=' + JSON.stringify(content.reasons) : ''));
		this.sigSend(envelope(avatars.TELEPORT_SIGNAL_TYPE_AVATAR_RESULT, content));
	}
}

module.exports = { AvatarService };
