'use strict';
// Per-client server-side state for avatar negotiation. Phase 3 of the
// implementation in plans/avatars_implementation.md: hand an offered
// URL to an IAvatarValidator and surface its verdict. With no
// validator wired the service falls back to the Phase-2 behaviour
// (always reply using_default), so existing deployments keep working.
//
// One AvatarService is owned by each Client; messages are dispatched in
// from the signaling layer.

const avatars = require('../protocol/avatars.js');

// Threshold above which a 'pending' frame is sent so the client can
// show progress (plan §4.1 / §9). Picked to be just under one second
// so the UX never feels stuck.
const PENDING_DELAY_MS = 750;

function envelope(type, content) {
	return JSON.stringify({ 'teleport-signal-type': type, content });
}

class AvatarService {
	constructor(clientID, sigSend, opts) {
		this.clientID		= clientID;
		this.sigSend		= sigSend;
		this.currentPolicy	= null;
		this.lastOffer		= null;
		this.lastResult		= null;
		// Optional IAvatarValidator. When null the service keeps its
		// Phase-2 behaviour: any offer is answered with using_default.
		this.validator		= (opts && opts.validator) || null;
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

	// Handle an incoming avatar-offer. With no validator wired the
	// service replies using_default exactly as Phase 2 did; with a
	// validator the offered URL is fetched, hashed and measured, and
	// the verdict is reported back.
	async handleOffer(offerJson) {
		const offer = avatars.parseAvatarOffer(offerJson);
		this.lastOffer = offer;
		console.log('avatar-offer  ← client ' + this.clientID +
			' policy_id=' + offer.policy_id +
			' have_avatar=' + offer.have_avatar);

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

		// Without a validator, or without an offered URL, fall straight
		// back to the default avatar (this is also the Phase-2 path).
		if (!this.validator || !offer.have_avatar || !offer.url) {
			this._reply({
				policy_id:		offer.policy_id,
				status:			'using_default',
				node_uid:		0n,
				using_default:	true,
				delivery:		'import',
				reasons:		[],
			});
			return;
		}

		// Long-running validation gets a 'pending' status so the client
		// can show progress instead of appearing to hang (plan §4.1).
		let pendingSent = false;
		const pendingTimer = setTimeout(() => {
			pendingSent = true;
			this._reply({
				policy_id:		offer.policy_id,
				status:			'pending',
				node_uid:		0n,
				using_default:	false,
				delivery:		'import',
				reasons:		[],
			}, /*record*/ false);
		}, PENDING_DELAY_MS);

		let result;
		try {
			result = await this.validator.validate(offer, this.currentPolicy.requirements || {});
		} catch (err) {
			result = { ok: false, reasons: ['validator_error'], bytes: 0, contentHash: '', format: '' };
		}
		clearTimeout(pendingTimer);

		if (result.ok) {
			this._reply({
				policy_id:		offer.policy_id,
				status:			'accepted',
				node_uid:		0n,
				using_default:	false,
				delivery:		'import',
				reasons:		[],
			});
		} else if (this.currentPolicy.default_available) {
			this._reply({
				policy_id:		offer.policy_id,
				status:			'using_default',
				node_uid:		0n,
				using_default:	true,
				delivery:		'import',
				reasons:		result.reasons || [],
			});
		} else {
			this._reply({
				policy_id:		offer.policy_id,
				status:			'rejected',
				node_uid:		0n,
				using_default:	false,
				delivery:		'import',
				reasons:		result.reasons || ['validation_failed'],
			});
		}
		void pendingSent;
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

	_reply(result, record = true) {
		const content = avatars.encodeAvatarResult(result);
		if (record) this.lastResult = content;
		console.log('avatar-result → client ' + this.clientID +
			' status=' + content.status +
			' delivery=' + content.delivery +
			(content.reasons.length ? ' reasons=' + JSON.stringify(content.reasons) : ''));
		this.sigSend(envelope(avatars.TELEPORT_SIGNAL_TYPE_AVATAR_RESULT, content));
	}
}

module.exports = { AvatarService };
