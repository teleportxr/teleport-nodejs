'use strict';
// Client-specific nodes: nodes whose lifetime is scoped to one client's session.
//
// A client-specific node is created when a client connects (its origin node, its
// avatar node, anything else the host application spawns for it) and must be
// destroyed when that client leaves. Until this registry existed, every feature
// that needed such a node re-implemented the bookkeeping — and each one got a
// different part of it wrong: the origin node was never destroyed at all, and
// avatar nodes were torn down by hand-rolled loops over the remaining clients.
//
// The registry is the single index of "which client owns which node, and who is
// allowed to see it". It does not own the nodes: they live in the shared Scene
// exactly as before, and `Node.holder_client_id` — a field that has always been
// on the wire in both the Node.js and C++ implementations — carries the owner to
// the client. The registry is therefore a derived index, rebuildable from the
// scene, and the wire format is unchanged.
//
// Distribution and removal both fall out of GeometryService.UpdateVisibleNodes,
// which diffs each client's streamed set against the set this registry says they
// should see. Nothing has to push a new node to peers, and nothing has to push a
// removal: leaving the visible set *is* the removal.

//! Who receives a client-specific node.
//!   Everyone  — the owner and every peer. The default, and what an origin node
//!               must be: the owner needs it for SetOriginNode, and peers need
//!               it as the parent transform of everything the owner carries.
//!   OwnerOnly — only the client that owns it. For per-client UI or scenery that
//!               peers must not see.
//!   PeersOnly — everyone except the owner. For an avatar the owner would
//!               otherwise find itself standing inside.
const NodeVisibility = {
	Everyone:	0,
	OwnerOnly:	1,
	PeersOnly:	2,
};

function visibilityToString(v)
{
	switch (v)
	{
	case NodeVisibility.OwnerOnly:	return 'owner-only';
	case NodeVisibility.PeersOnly:	return 'peers-only';
	default:						return 'everyone';
	}
}

class ClientNodeRegistry
{
	constructor(scene = null)
	{
		this.scene = scene;
		// uid → { clientID, visibility, role }
		this.byNode = new Map();
		// clientID → Set of uid
		this.byClient = new Map();
	}

	//! The scene client-specific nodes live in. Set automatically the first time
	//! a client is given a scene (see Client.SetScene), so host applications do
	//! not have to wire it up themselves.
	SetScene(scene)
	{
		if (scene)
			this.scene = scene;
	}

	//! Record that `uid` belongs to `clientID`, and stamp the ownership onto the
	//! scene node so it reaches the client on the wire. Re-registering the same
	//! uid updates its visibility and role rather than duplicating it.
	register(clientID, uid, opts = {})
	{
		if (!uid)
			return uid;
		const visibility	= (opts.visibility !== undefined) ? opts.visibility : NodeVisibility.Everyone;
		const role			= opts.role || '';
		const existing		= this.byNode.get(uid);
		if (existing && existing.clientID !== clientID)
			this._forget(existing.clientID, uid);
		this.byNode.set(uid, { clientID, visibility, role });
		if (!this.byClient.has(clientID))
			this.byClient.set(clientID, new Set());
		this.byClient.get(clientID).add(uid);
		// holder_client_id is the protocol-level ownership marker. Setting it
		// here means every client-specific node carries its owner, whoever
		// created it.
		const node = this.scene ? this.scene.GetNode(uid) : null;
		if (node)
			node.holder_client_id = clientID;
		console.log('client node ' + uid + ' (' + (role || 'node') + ', ' +
			visibilityToString(visibility) + ') registered to client ' + clientID);
		return uid;
	}

	//! Forget a node without touching the scene. Use when the host application
	//! has taken over the node's lifetime, or when replacing one node with
	//! another for the same client (an avatar being swapped, say).
	unregister(uid)
	{
		const entry = this.byNode.get(uid);
		if (!entry)
			return false;
		this._forget(entry.clientID, uid);
		this.byNode.delete(uid);
		return true;
	}

	_forget(clientID, uid)
	{
		const set = this.byClient.get(clientID);
		if (!set)
			return;
		set.delete(uid);
		if (set.size === 0)
			this.byClient.delete(clientID);
	}

	//! The uids owned by a client, as an array (safe to iterate while removing).
	nodesForClient(clientID)
	{
		const set = this.byClient.get(clientID);
		return set ? Array.from(set) : [];
	}

	//! The uids owned by a client with the given role, e.g. 'origin', 'avatar'.
	nodesForClientWithRole(clientID, role)
	{
		return this.nodesForClient(clientID).filter((uid) => {
			const entry = this.byNode.get(uid);
			return entry && entry.role === role;
		});
	}

	//! The client that owns this node, or 0 if it is ordinary scenery.
	ownerOf(uid)
	{
		const entry = this.byNode.get(uid);
		return entry ? entry.clientID : 0;
	}

	visibilityOf(uid)
	{
		const entry = this.byNode.get(uid);
		return entry ? entry.visibility : NodeVisibility.Everyone;
	}

	roleOf(uid)
	{
		const entry = this.byNode.get(uid);
		return entry ? entry.role : '';
	}

	//! Change a node's visibility after registration, e.g. when the host flips
	//! its "send the client its own avatar" setting at runtime.
	setVisibility(uid, visibility)
	{
		const entry = this.byNode.get(uid);
		if (!entry)
			return false;
		entry.visibility = visibility;
		return true;
	}

	//! The one predicate the streaming pass uses. Nodes with no owner are
	//! ordinary scenery and are visible to everybody.
	isVisibleTo(uid, clientID)
	{
		const entry = this.byNode.get(uid);
		if (!entry)
			return true;
		const isOwner = (entry.clientID === clientID);
		switch (entry.visibility)
		{
		case NodeVisibility.OwnerOnly:	return isOwner;
		case NodeVisibility.PeersOnly:	return !isOwner;
		default:						return true;
		}
	}

	//! Hand a departed client's nodes to its reconnected session. Used when a
	//! client returns inside the grace period: the nodes never left the scene,
	//! so peers saw no interruption, and the new session simply inherits them.
	//! Returns the uids transferred.
	transferToClient(fromClientID, toClientID)
	{
		const uids = this.nodesForClient(fromClientID);
		for (const uid of uids)
		{
			const entry = this.byNode.get(uid);
			if (!entry)
				continue;
			this.register(toClientID, uid, { visibility: entry.visibility, role: entry.role });
		}
		return uids;
	}

	//! Destroy a client's nodes: remove them from the scene and forget them.
	//! Every client's next UpdateVisibleNodes pass then sees them leave its
	//! visible set and queues a RemoveNodes payload. Returns the removed uids.
	releaseForClient(clientID)
	{
		const uids = this.nodesForClient(clientID);
		for (const uid of uids)
		{
			this.byNode.delete(uid);
			if (this.scene)
				this.scene.RemoveNode(uid);
		}
		this.byClient.delete(clientID);
		if (uids.length)
			console.log('released ' + uids.length + ' client node(s) [' + uids.join(', ') +
				'] belonging to client ' + clientID);
		return uids;
	}

	writeState()
	{
		var content = '<table><tr><th>Node</th><th>Owner</th><th>Role</th><th>Visibility</th></tr>';
		for (const [uid, entry] of this.byNode)
		{
			content += '\n<tr><td>' + uid + '</td> <td>' + entry.clientID + '</td> <td>' +
				(entry.role || '—') + '</td> <td>' + visibilityToString(entry.visibility) + '</td></tr>';
		}
		content += '\n</table>';
		return content;
	}
}

module.exports = { ClientNodeRegistry, NodeVisibility, visibilityToString };
