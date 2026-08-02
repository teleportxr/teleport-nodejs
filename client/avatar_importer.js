'use strict';
// Turning an accepted avatar into something peers can see.
//
// The geometry pipeline delivers meshes as URL pointers that clients
// fetch over HTTP themselves (see scene/node.js MeshComponent and the
// MeshPointer resource type). An avatar is therefore just a node with a
// MeshComponent, parented under the owning client's origin node so it
// tracks the player. Peers receive it as ordinary scenery and are never
// told it is an avatar (plans/avatars_plan.md §2.2).
//
// The two delivery modes differ only in whose URL the pointer carries
// (plans/avatars_plan.md §2.1):
//   * relay (the default) — the owner's own offer URL, so peers fetch
//     straight from the avatar host and the server serves no bytes;
//   * import (the fallback) — the validated bytes re-hosted at a
//     server-controlled URL via the host application's `publish`
//     callback, so the owner's URL is never exposed.
//
// IAvatarImporter is the pluggable interface; DefaultAvatarImporter is
// the implementation used by the reference server. Hosts with their own
// asset pipeline (e.g. re-encoding to draco/ktx2) supply their own.

const nd = require('../scene/node.js');
const core = require('../core/core.js');
const resources = require('../scene/resources.js');
const client_nodes = require('./client_nodes.js');
const { redactUrl } = require('../utils/redact.js');

class IAvatarImporter
{
	//! Relay a validated avatar: create the node pointing at the client's
	//! own offer URL, so peers fetch it from the avatar host directly.
	//! Returns the root node uid. This is the default delivery mode.
	relayForClient(/* clientID, client, offerUrl */)
	{
		throw new Error('IAvatarImporter.relayForClient is abstract');
	}
	//! Import a validated avatar: re-host the bytes and point the node at
	//! the server's own copy. `validated` is the validator result
	//! ({ body, contentHash, format, ... }). Returns (a promise of) the
	//! root node uid of the imported sub-tree. This is the fallback for
	//! when relaying is refused or impossible.
	async importValidatedForClient(/* clientID, client, validated */)
	{
		throw new Error('IAvatarImporter.importValidatedForClient is abstract');
	}
	//! Import the server's default avatar for a client. Returns the
	//! node uid, or 0n when no default is configured.
	importDefaultForClient(/* clientID, client */)
	{
		throw new Error('IAvatarImporter.importDefaultForClient is abstract');
	}
	//! Remove a client's avatar node (disconnect, revoke, rejection).
	removeForClient(/* clientID */)
	{
	}
}

class DefaultAvatarImporter extends IAvatarImporter
{
	//! opts:
	//!   scene          — the shared Scene the node is inserted into (required).
	//!   clientManager  — used to UnstreamNode for every client on removal.
	//!   publish        — async ({ body, contentHash, format }) → url path
	//!                    served by the host application. Required for
	//!                    importing client-supplied avatars; without it
	//!                    only the default avatar can be imported.
	//!   defaultUrl     — server-relative URL of the default avatar
	//!                    (e.g. '/generic_avatar.vrm'), already served by
	//!                    the host. Optional.
	//!   sendOwnAvatar  — whether a client is sent its own avatar node as well
	//!                    as its peers'. Default true. Set false so a client
	//!                    does not find itself standing inside its own body.
	constructor(opts = {})
	{
		super();
		if (!opts.scene)
			throw new Error('DefaultAvatarImporter requires a scene');
		this.scene			= opts.scene;
		this.clientManager	= opts.clientManager || null;
		this.publish		= opts.publish || null;
		this.defaultUrl		= opts.defaultUrl || '';
		this.sendOwnAvatar	= opts.sendOwnAvatar !== false;
		// clientID → { nodeUid, url, relayed, validated, hostedUrl }.
		// `validated` is kept for relayed avatars only, so the asset can
		// be re-hosted on demand if a peer fails to fetch the owner's
		// url (see hostedUrlForClient).
		this.nodeByClient	= new Map();
	}

	//! Create (or replace) the avatar node for a client from a URL the
	//! server already serves. The node lives in the shared scene, so
	//! every client — present and future — receives it via the normal
	//! streaming pass. Returns the node uid.
	importUrlForClient(clientID, client, url, meta = {})
	{
		const existing = this.nodeByClient.get(clientID);
		if (existing && existing.url === url)
			return existing.nodeUid;
		if (existing)
			this.removeForClient(clientID);
		const node = new nd.Node('Avatar_' + clientID);
		// Parent under the client's origin node so the avatar tracks the
		// player. (How origin movement propagates to peers is the same
		// story as every other node — outside this module's scope.)
		node.parent_uid		= client && client.origin_uid ? client.origin_uid : 0;
		node.stationary		= false;
		node.holder_client_id = clientID;
		node.setMeshComponent(url);
		const uid = this.scene.InsertNode(node);
		this.nodeByClient.set(clientID, {
			nodeUid:	uid,
			url,
			relayed:	!!meta.relayed,
			validated:	meta.validated || null,
			hostedUrl:	'',
		});
		// Record the ownership, so the node is destroyed with the client's
		// session and so every client's streaming pass knows who may see it.
		// Peers pick it up on their next tick; nothing has to push it to them.
		const registry = this._registry();
		if (registry)
		{
			registry.register(clientID, uid, {
				role:		'avatar',
				visibility:	this.sendOwnAvatar ? client_nodes.NodeVisibility.Everyone
												: client_nodes.NodeVisibility.PeersOnly,
			});
		}
		// Kick off streaming to the owner immediately rather than waiting up to
		// a tick — unless the owner is not meant to see its own avatar.
		if (this.sendOwnAvatar && client && client.geometryService)
			client.geometryService.StreamNode(uid);
		console.log('avatar node ' + uid + ' (' + redactUrl(url) + ') ' +
			(meta.relayed ? 'relayed' : 'imported') + ' for client ' + clientID);
		return uid;
	}

	//! Relay: point the node at the client's own offer url so peers fetch
	//! it straight from the avatar host. `validated` is retained so the
	//! asset can still be re-hosted for any peer that fails to fetch it.
	relayForClient(clientID, client, offerUrl, validated)
	{
		if (typeof offerUrl !== 'string' || !offerUrl.length)
			throw Object.assign(new Error('no url to relay'), { code: 'relay_failed' });
		return this.importUrlForClient(clientID, client, offerUrl, { relayed: true, validated: validated || null });
	}

	async importValidatedForClient(clientID, client, validated)
	{
		const url = await this._publishValidated(validated);
		return this.importUrlForClient(clientID, client, url, { relayed: false });
	}

	importDefaultForClient(clientID, client)
	{
		if (!this.defaultUrl)
			return 0n;
		// The default is already served by the host, so pointing at it is
		// not relaying anyone's private url.
		return this.importUrlForClient(clientID, client, this.defaultUrl, { relayed: false });
	}

	async _publishValidated(validated)
	{
		if (!this.publish)
			throw Object.assign(new Error('no publish callback configured'), { code: 'import_failed' });
		if (!validated || !validated.body || !validated.contentHash)
			throw Object.assign(new Error('validated result carries no body'), { code: 'import_failed' });
		const url = await this.publish({
			body:			validated.body,
			contentHash:	validated.contentHash,
			format:			validated.format || '',
		});
		if (typeof url !== 'string' || !url.length)
			throw Object.assign(new Error('publish returned no url'), { code: 'import_failed' });
		return url;
	}

	//! A server-hosted url for a relayed client's avatar, published on
	//! first request and cached thereafter. Used to downgrade a single
	//! peer to import when it reports the relayed url unfetchable
	//! (plans/avatars_plan.md §5.1). Returns '' when this client's avatar
	//! is not relayed, or when there are no bytes to re-host.
	async hostedUrlForClient(clientID)
	{
		const entry = this.nodeByClient.get(clientID);
		if (!entry || !entry.relayed)
			return '';
		if (entry.hostedUrl)
			return entry.hostedUrl;
		if (!entry.validated || !this.publish)
			return '';
		entry.hostedUrl = await this._publishValidated(entry.validated);
		return entry.hostedUrl;
	}

	nodeUidForClient(clientID)
	{
		const entry = this.nodeByClient.get(clientID);
		return entry ? entry.nodeUid : 0n;
	}

	//! The uid of the mesh-pointer resource carrying this client's avatar,
	//! or 0n if it has none. Lets the ResourceLost path recognise an
	//! avatar asset among all the other resources a client may lose.
	meshResourceUidForClient(clientID)
	{
		const entry = this.nodeByClient.get(clientID);
		if (!entry || !entry.url)
			return 0n;
		return resources.GetOrAddResourceUidFromUrl(core.GeometryPayloadType.MeshPointer, entry.url);
	}

	//! Reverse of meshResourceUidForClient: which client's relayed avatar
	//! does this resource uid belong to? Returns null if none.
	relayedClientForMeshResourceUid(uid)
	{
		for (const [clientID, entry] of this.nodeByClient)
		{
			if (!entry.relayed || !entry.url)
				continue;
			const resUid = resources.GetOrAddResourceUidFromUrl(core.GeometryPayloadType.MeshPointer, entry.url);
			if (BigInt(resUid) === BigInt(uid))
				return clientID;
		}
		return null;
	}

	//! The client-node registry, when this importer is attached to a client
	//! manager that has one. Null in unit tests and for hosts that drive the
	//! importer directly, in which case ownership is simply not recorded.
	_registry()
	{
		return (this.clientManager && this.clientManager.clientNodes) ? this.clientManager.clientNodes : null;
	}

	//! Remove the avatar node of a client: delete it from the scene and forget
	//! it. Removal from the scene is the whole story — every client's next
	//! streaming pass finds the node gone from its visible set and queues a
	//! RemoveNodes payload of its own accord.
	removeForClient(clientID)
	{
		const entry = this.nodeByClient.get(clientID);
		if (!entry)
			return;
		this.nodeByClient.delete(clientID);
		const registry = this._registry();
		if (registry)
			registry.unregister(entry.nodeUid);
		this.scene.RemoveNode(entry.nodeUid);
		console.log('avatar node ' + entry.nodeUid + ' removed for client ' + clientID);
	}
}

module.exports = { IAvatarImporter, DefaultAvatarImporter };
