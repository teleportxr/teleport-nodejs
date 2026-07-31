'use strict';
// Per-client server-side state for avatar negotiation. Phases 3–4 of
// the implementation in plans/avatars_implementation.md: hand an
// offered URL to an IAvatarValidator, then hand the validated bytes to
// an IAvatarImporter which turns them into a scene node streamed to
// every peer. With no validator wired the service falls back to the
// Phase-2 behaviour (always reply using_default); with no importer the
// results carry node_uid=0 as before, so existing deployments keep
// working.
//
// One AvatarService is owned by each Client; messages are dispatched in
// from the signaling layer.

const avatars = require('../protocol/avatars.js');
const { redactUrl } = require('../utils/redact.js');

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
		// Optional IAvatarImporter. When set, accepted offers and
		// default fallbacks produce a real scene node whose uid is
		// reported in avatar-result.node_uid.
		this.importer		= (opts && opts.importer) || null;
		// Server-wide relay switch. Relay is the default delivery mode
		// (plans/avatars_plan.md §2.1); set false for deployments where
		// an avatar url must never reach other clients.
		this.allowRelay		= !(opts && opts.allowRelay === false);
		// Back-reference to the owning Client, set by the Client
		// constructor; handed to the importer so the avatar node can be
		// parented under the client's origin.
		this.client			= null;
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
		// The URL may carry a bearer token; only ever log it redacted
		// (plans/avatars_plan.md §8).
		console.log('avatar-offer  ← client ' + this.clientID +
			' policy_id=' + offer.policy_id +
			' have_avatar=' + offer.have_avatar +
			(offer.have_avatar && offer.url ? ' url=' + redactUrl(offer.url) : ''));

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
			this._replyDefaultOrReject(offer.policy_id, []);
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
			// The avatar becomes a scene node whose mesh is a pointer to
			// a url the peers fetch themselves. Relay (the owner's own
			// url) unless something rules it out, in which case re-host
			// and point at our copy instead.
			const delivery = this._chooseDelivery(offer);
			let nodeUid = 0n;
			if (this.importer) {
				try {
					nodeUid = delivery === 'relay'
						? this.importer.relayForClient(this.clientID, this.client, offer.url, result)
						: await this.importer.importValidatedForClient(this.clientID, this.client, result);
				} catch (err) {
					this._replyDefaultOrReject(offer.policy_id, [err.code || 'import_failed']);
					void pendingSent;
					return;
				}
			}
			this._reply({
				policy_id:		offer.policy_id,
				status:			'accepted',
				node_uid:		nodeUid,
				using_default:	false,
				delivery:		delivery,
				reasons:		[],
			});
		} else {
			this._replyDefaultOrReject(offer.policy_id, result.reasons || ['validation_failed']);
		}
		void pendingSent;
	}

	// Relay or import? Relay is the default; each of the three checks
	// below is a reason the owner's url cannot go out to peers
	// (plans/avatars_plan.md §2.1). None of them is a rejection — the
	// avatar is accepted either way.
	_chooseDelivery(offer) {
		if (!this.allowRelay) {
			console.log('avatar for client ' + this.clientID + ': import (relay disabled server-wide)');
			return 'import';
		}
		if (offer.allow_relay === false) {
			console.log('avatar for client ' + this.clientID + ': import (owner opted out of relay)');
			return 'import';
		}
		if (!avatars.isRelayableUrl(offer.url)) {
			// Clients choose a decoder by file extension, so a url without
			// a recognised one has to be re-hosted under a name we control.
			console.log('avatar for client ' + this.clientID + ': import (url has no relayable extension)');
			return 'import';
		}
		return 'relay';
	}

	// Fall back to the default avatar when the policy allows it,
	// otherwise reject. `reasons` explains why the client's own avatar
	// was not used (empty when it simply didn't offer one).
	_replyDefaultOrReject(policy_id, reasons) {
		if (this.currentPolicy && this.currentPolicy.default_available) {
			let nodeUid = 0n;
			if (this.importer)
				nodeUid = this.importer.importDefaultForClient(this.clientID, this.client) || 0n;
			this._reply({
				policy_id:		policy_id,
				status:			'using_default',
				node_uid:		nodeUid,
				using_default:	true,
				delivery:		'import',
				reasons:		reasons,
			});
		} else {
			// No default to fall back to: drop any previously imported
			// avatar and reject (plan §11 edge case 4).
			if (this.importer)
				this.importer.removeForClient(this.clientID);
			this._reply({
				policy_id:		policy_id,
				status:			'rejected',
				node_uid:		0n,
				using_default:	false,
				delivery:		'import',
				reasons:		reasons.length ? reasons : ['no_avatar_available'],
			});
		}
	}

	// Handle a client-initiated revoke (rare in Phase 2; provided for
	// symmetry with later phases).
	handleRevoke(revokeJson) {
		const policy_id = revokeJson && revokeJson.policy_id != null
			? BigInt(revokeJson.policy_id) : 0n;
		console.log('avatar-revoke ← client ' + this.clientID + ' policy_id=' + policy_id);
		// A revoke from the client withdraws its avatar: drop cached
		// state and remove any imported node. The server keeps the same
		// policy in force and a new offer is expected next.
		this.lastOffer = null;
		this.lastResult = null;
		if (this.importer)
			this.importer.removeForClient(this.clientID);
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
