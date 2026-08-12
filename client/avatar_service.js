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
const receipts = require('../manifest/receipt.js');
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
		this.lastManifestReceipt = null;
		// Optional IAvatarValidator. When null the service keeps its
		// Phase-2 behaviour: any offer is answered with using_default.
		this.validator		= (opts && opts.validator) || null;
		// Optional IAvatarImporter. When set, accepted offers and
		// default fallbacks produce a real scene node whose uid is
		// reported in avatar-result.node_uid.
		this.importer		= (opts && opts.importer) || null;
		// Optional IAvatarManifestResolver. When set, an offer carrying a
		// manifest address is resolved to an asset url before validation.
		// When null, manifest offers are ignored — which is the right
		// behaviour for a deployment that has not opted in, since it has
		// not told the client it accepts them either.
		this.manifestResolver = (opts && opts.manifestResolver) || null;
		// Optional host callback, invoked with the app-specific facets a
		// resolved manifest carried:
		//   onManifestProjected(clientID, projection, receipt)
		this.onManifestProjected = (opts && opts.onManifestProjected) || null;
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
		// Any receipt from this offer's manifest evaluation; attached to
		// whichever avatar-result we end up sending. Cleared per offer so
		// a later offer never inherits an earlier one's receipt.
		this.lastManifestReceipt = null;
		// A url or manifest address may carry a bearer token; only ever
		// log either redacted (plans/avatars_plan.md §8).
		const offeredAddress = offer.have_avatar
			? (offer.manifest ? (offer.manifest.url || offer.manifest.umid) : offer.url)
			: '';
		console.log('avatar-offer  ← client ' + this.clientID +
			' policy_id=' + offer.policy_id +
			' have_avatar=' + offer.have_avatar +
			(offeredAddress ? (offer.manifest ? ' manifest=' : ' url=') + redactUrl(offeredAddress) : ''));

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

		// A manifest address is an indirection in front of an asset url:
		// resolve it, and everything downstream proceeds as if the client
		// had offered the resolved url directly.
		//
		// Gated on having a validator as well as a resolver, because
		// without one the offer would fall back to the default avatar
		// anyway and the manifest fetch would be a network round trip
		// spent on a result we would discard.
		if (offer.have_avatar && offer.manifest && this.manifestResolver && this.validator) {
			const resolved = await this._resolveManifest(offer);
			if (!resolved) return;
		}

		// Without a validator, or without an offered URL, fall straight
		// back to the default avatar (this is also the Phase-2 path).
		if (!this.validator || !offer.have_avatar || !offer.url) {
			this._replyDefaultOrReject(offer.policy_id, []);
			return;
		}

		// A returning user re-offering the avatar we already validated does not
		// need it fetched, hashed and measured again.
		//
		// The match is on content hash, which the server computed from the
		// bytes itself last time. The client must still supply the url and the
		// hash on every offer — nothing is ever read back to it — so this saves
		// a download without disclosing anything the caller did not know.
		//
		// Only on the relay path: importing re-hosts the bytes, and a
		// remembered result has no bytes precisely because we skipped the
		// fetch. When the avatar has to be imported, validate properly.
		const remembered = this._rememberedAvatar();
		if (remembered && offer.content_hash && offer.content_hash === remembered.contentHash &&
			this._chooseDelivery(offer) === 'relay')
		{
			console.log('avatar for client ' + this.clientID +
				': reusing validation from a previous session (hash ' + remembered.contentHash.slice(0, 12) + '…)');
			await this._acceptValidated(offer, remembered.validated, 'relay');
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
			await this._acceptValidated(offer, result, null);
		} else {
			this._replyDefaultOrReject(offer.policy_id, result.reasons || ['validation_failed']);
		}
		void pendingSent;
	}

	// Resolve offer.manifest to an asset url, writing it into offer.url so
	// the rest of handleOffer is unaware a manifest was involved.
	//
	// Returns true to continue, false when it has already replied. A
	// manifest that fails to resolve is not a protocol error: the client
	// offered something the server could not use, which is the same
	// situation as a bad url, and it falls back to the default avatar
	// exactly as that does.
	async _resolveManifest(offer) {
		const requirements = (this.currentPolicy.requirements || {}).manifest || {};
		let resolved;
		try {
			resolved = await this.manifestResolver.resolve(offer.manifest, requirements);
		} catch (err) {
			resolved = { ok: false, reasons: ['manifest_unresolvable'], receipt: null };
		}

		this.lastManifestReceipt = resolved.receipt || null;

		if (!resolved.ok) {
			this._replyDefaultOrReject(offer.policy_id, resolved.reasons || ['manifest_unresolvable']);
			return false;
		}

		console.log('avatar manifest for client ' + this.clientID +
			': resolved ' + redactUrl(resolved.manifestUrl) +
			' → ' + redactUrl(resolved.avatarUrl) +
			' (outcome ' + (resolved.receipt ? resolved.receipt.outcome : 'unknown') + ')');

		offer.url = resolved.avatarUrl;
		// The manifest said nothing about the asset's byte size or
		// triangle count, so any `declared` block the client sent still
		// stands and the validator measures the asset regardless.

		if (typeof this.onManifestProjected === 'function') {
			try {
				this.onManifestProjected(this.clientID, resolved.projection, resolved.receipt);
			} catch (err) {
				// A host callback must never be able to fail a client's
				// avatar; the manifest itself was fine.
				console.log('avatar manifest projection callback threw for client ' + this.clientID + ': ' + err.message);
			}
		}
		return true;
	}

	// Turn a successful validation into a scene node and an avatar-result.
	// `delivery` forces the delivery mode when the caller has already decided
	// it; pass null to choose here. `validated` is remembered against the user
	// so a later session can skip revalidation.
	async _acceptValidated(offer, validated, delivery) {
		// The avatar becomes a scene node whose mesh is a pointer to a url the
		// peers fetch themselves. Relay (the owner's own url) unless something
		// rules it out, in which case re-host and point at our copy instead.
		const mode = delivery || this._chooseDelivery(offer);
		let nodeUid = 0n;
		if (this.importer) {
			try {
				nodeUid = mode === 'relay'
					? this.importer.relayForClient(this.clientID, this.client, offer.url, validated)
					: await this.importer.importValidatedForClient(this.clientID, this.client, validated);
			} catch (err) {
				this._replyDefaultOrReject(offer.policy_id, [err.code || 'import_failed']);
				return;
			}
		}
		this._rememberAvatar(validated);
		this._reply({
			policy_id:		offer.policy_id,
			status:			'accepted',
			node_uid:		nodeUid,
			using_default:	false,
			delivery:		mode,
			reasons:		[],
		});
	}

	// The avatar this user was last seen with, or null. Anonymous clients have
	// no record, so they always revalidate.
	_rememberedAvatar() {
		const user = this.client && this.client.user;
		if (!user || !user.record || !user.record.avatar)
			return null;
		const avatar = user.record.avatar;
		return (avatar.contentHash && avatar.validated) ? avatar : null;
	}

	// Remember a validated avatar against the user, not the clientID: the
	// point is to still have it after this connection is gone.
	//
	// The response body is dropped before storing. It can be many megabytes,
	// it is not needed to recognise the same avatar again, and keeping it
	// would make the user store grow without bound.
	_rememberAvatar(validated) {
		const user = this.client && this.client.user;
		if (!user || !user.record || !validated || !validated.contentHash)
			return;
		const { body, ...withoutBody } = validated;
		void body;
		const avatar = { contentHash: validated.contentHash, validated: withoutBody };
		if (typeof user.update === 'function')
			user.update({ avatar });
		else
			user.record.avatar = avatar;
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
		this.lastManifestReceipt = null;
		if (this.importer)
			this.importer.removeForClient(this.clientID);
	}

	_reply(result, record = true) {
		// Carry the manifest receipt on whichever result this offer
		// produced, unless the caller supplied one explicitly.
		if (result.manifest === undefined && this.lastManifestReceipt)
			result = Object.assign({}, result, { manifest: receipts.toWire(this.lastManifestReceipt) });
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
