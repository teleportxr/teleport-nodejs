'use strict';
// Phase 4 of the avatar implementation plan: import mode. A validated
// avatar becomes a node in the server scene and is streamed to peers
// through the existing geometry pipeline, so peers can actually see
// each other.
//
// In this server the geometry pipeline delivers meshes as URL pointers
// that clients fetch over HTTP (see scene/node.js MeshComponent and the
// MeshPointer resource type). "Importing" therefore means:
//   1. re-hosting the validated bytes at a server-controlled URL (the
//      host application supplies a `publish` callback — the library has
//      no HTTP server of its own), and
//   2. creating a node carrying a MeshComponent with that URL, parented
//      under the owning client's origin node so it tracks the player.
// Peers never see the original offer URL (plans/avatars_plan.md §8):
// they fetch the server-hosted copy like any other scene resource.
//
// IAvatarImporter is the pluggable interface; DefaultAvatarImporter is
// the implementation used by the reference server. Hosts with their own
// asset pipeline (e.g. re-encoding to draco/ktx2) supply their own.

const nd = require('../scene/node.js');
const { redactUrl } = require('../utils/redact.js');

class IAvatarImporter
{
	//! Import a validated avatar for a client. `validated` is the
	//! validator result ({ body, contentHash, format, ... }). Returns
	//! (a promise of) the root node uid of the imported sub-tree.
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
	constructor(opts = {})
	{
		super();
		if (!opts.scene)
			throw new Error('DefaultAvatarImporter requires a scene');
		this.scene			= opts.scene;
		this.clientManager	= opts.clientManager || null;
		this.publish		= opts.publish || null;
		this.defaultUrl		= opts.defaultUrl || '';
		this.nodeByClient	= new Map();	// clientID → { nodeUid, url }
	}

	//! Create (or replace) the avatar node for a client from a URL the
	//! server already serves. The node lives in the shared scene, so
	//! every client — present and future — receives it via the normal
	//! streaming pass. Returns the node uid.
	importUrlForClient(clientID, client, url)
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
		this.nodeByClient.set(clientID, { nodeUid: uid, url });
		// Kick off streaming to the owner immediately; everyone else
		// picks the node up on their next UpdateStreaming tick.
		if (client && client.geometryService)
			client.geometryService.StreamNode(uid);
		console.log('avatar node ' + uid + ' (' + redactUrl(url) + ') imported for client ' + clientID);
		return uid;
	}

	async importValidatedForClient(clientID, client, validated)
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
		return this.importUrlForClient(clientID, client, url);
	}

	importDefaultForClient(clientID, client)
	{
		if (!this.defaultUrl)
			return 0n;
		return this.importUrlForClient(clientID, client, this.defaultUrl);
	}

	nodeUidForClient(clientID)
	{
		const entry = this.nodeByClient.get(clientID);
		return entry ? entry.nodeUid : 0n;
	}

	//! Remove the avatar node of a client: delete it from the scene and
	//! unstream it for every connected client, which queues a RemoveNodes
	//! payload on their next streaming tick.
	removeForClient(clientID)
	{
		const entry = this.nodeByClient.get(clientID);
		if (!entry)
			return;
		this.nodeByClient.delete(clientID);
		this.scene.RemoveNode(entry.nodeUid);
		if (this.clientManager && this.clientManager.clients)
		{
			for (const [, cl] of this.clientManager.clients)
			{
				if (cl && cl.geometryService)
					cl.geometryService.UnstreamNode(entry.nodeUid);
			}
		}
		console.log('avatar node ' + entry.nodeUid + ' removed for client ' + clientID);
	}
}

module.exports = { IAvatarImporter, DefaultAvatarImporter };
