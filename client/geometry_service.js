"use strict";
// using https://github.com/infusion/BitSet.js
const bit = require("bitset");
const core = require("../core/core.js");
const nd = require("../scene/node.js");
const resources = require("../scene/resources.js");
const { forEach } = require("underscore");

var clientIDToIndex = new Map();
// Indices belonging to clients that have gone, available for re-use. Without
// this the bitsets grow by one bit per connection for the lifetime of the
// process. GeometryService.ForgetClient clears a departing client's bits before
// releasing its index, so a re-used index never inherits stale state.
var freeIndices = [];
var nextIndex = 0;

function acquireClientIndex(clientID) {
	if (clientIDToIndex.has(clientID)) return clientIDToIndex.get(clientID);
	const index = freeIndices.length ? freeIndices.pop() : nextIndex++;
	clientIDToIndex.set(clientID, index);
	return index;
}

//! Each resource (node, texture, mesh etc) what MAY need to be streamed has a TrackedResource.
//! Then, within the TrackedResource class instance, we keep track of which clients:
//! * Need this resource
//! * Were sent the resource (and when)
//! * Acknowledged that the resource was received.
//! This is done with a bitset: each Client has an index. We set and clear the Client's bit in the
//! TrackedResource's bitset members to indicate the resource's status with respect to the client.
//!  The exception is sent_server_time_us: this is a Map from client ID to the time sent.
//! We remove these values when no longer needed, to prevent the maps from getting too large.
class TrackedResource {
	constructor() {
		this.clientNeeds = new bit.BitSet(); // whether we THINK the client NEEDS the resource.
		this.sent = new bit.BitSet(); // Whether we have actually sent the resource,
		this.sent_server_time_us = new Map(); // and when we sent it. Map of clientID to timestamp.
		this.acknowledged = new bit.BitSet(); // Whether the client acknowledged receiving the resource.
	}
	IsNeededByClient(clientID) {
		return this.clientNeeds.get(clientIDToIndex.get(clientID));
	}
	WasSentToClient(clientID) {
		return this.sent.get(clientIDToIndex.get(clientID));
	}
	WasAcknowledgedByClient(clientID) {
		return this.acknowledged.get(clientIDToIndex.get(clientID));
	}
	GetTimeSent(clientID) {
		return this.sent_server_time_us.get(clientID);
	}
	Sent(clientID, timestamp) {
		this.sent.set(clientIDToIndex.get(clientID), true);
		this.acknowledged.set(clientIDToIndex.get(clientID), false);
		this.sent_server_time_us.set(clientID, timestamp);
	}
	AcknowledgeBy(clientID) {
		this.acknowledged.set(clientIDToIndex.get(clientID), true);
		// erase timestamp?
		this.sent_server_time_us.delete(clientID);
	}
	Timeout(clientID) {
		this.sent.set(clientIDToIndex.get(clientID), false);
		this.acknowledged.set(clientIDToIndex.get(clientID), false);
		// delete, not clear: clear() takes no argument and would drop every
		// other client's send timestamp for this resource too.
		this.sent_server_time_us.delete(clientID);
	}
}

//! One GeometryService per connected client.
class GeometryService {
	//! One trackedResources shared acrosss all clients.
	static trackedResources = new Map();

	constructor(clientID) {
		this.clientID = clientID;
		acquireClientIndex(clientID);
		this.originNodeId = 0;
		this.priority = 0;
		// The lowest priority for which the client has confirmed all the nodes we sent.
		// We only send lower-priority nodes when all higher priorities have been confirmed.
		this.lowest_confirmed_node_priority = -100000;
		// How many nodes we have unconfirmed
		this.unconfirmed_priority_counts = new Map();
		// Nodes the client needs, we might not send all at once.
		this.nodesToStreamEventually = new Set();
		//!The nodes actually to stream.
		// When higher priority nodes are acknowledged,
		// lower priority nodes AND their resources are added.
		// This is a map from the resource uid's to the number of REASONS we have to stream it.
		//   e.g. if a texture is needed by two nodes, it should have 2 here.
		this.streamedNodes = new Map();
		// Node resources are refcounted, they could be requested
		// by more than one node, and only when no node references
		//  them should they be removed.
		this.streamedMeshes = new Map();
		this.streamedMaterials = new Map();
		this.streamedTextures = new Map();
		this.streamedSkeletons = new Map();
		this.streamedBones = new Map();
		this.streamedAnimations = new Map();
		this.streamedTextCanvases = new Map();
		this.streamedFontAtlases = new Map();
		// Nodes that were streamed to this client and have since been unstreamed.
		// Drained by GetRemoveNodesToSend() and sent as a RemoveNodes payload.
		this.removedNodesToSend = new Set();
		// Nodes the host application has explicitly unstreamed for this client
		// (e.g. distance culling). UpdateVisibleNodes leaves these alone, so an
		// application decision is not undone by the next streaming pass.
		// StreamNode() is the inverse: it clears the suppression.
		this.appSuppressed = new Set();

		this.backgroundTextureUid = 0;
		// ten seconds for timeout. Tweak this.
		this.timeout_us = 10000000;
	}
	SetScene(sc) {
		this.scene = sc;
	}
	SetOriginNode(n_uid) {
		if (this.originNodeId == n_uid) return;
		this.originNodeId = n_uid;
		this.StreamNode(n_uid);
	}
	static GetOrCreateTrackedResource(uid) {
		if (!GeometryService.trackedResources.has(uid))
			GeometryService.trackedResources.set(uid, new TrackedResource());
		var res = GeometryService.trackedResources.get(uid);
		return res;
	}
	//! Forget everything we know about a departed client, so its bookkeeping
	//! does not accumulate for the lifetime of the process. The client's bit is
	//! cleared in every tracked resource BEFORE its index is released, so the
	//! next client to be handed that index does not inherit its state.
	static ForgetClient(clientID) {
		var index = clientIDToIndex.get(clientID);
		if (index === undefined) return;
		for (const [, res] of GeometryService.trackedResources) {
			res.clientNeeds.set(index, false);
			res.sent.set(index, false);
			res.acknowledged.set(index, false);
			res.sent_server_time_us.delete(clientID);
		}
		clientIDToIndex.delete(clientID);
		freeIndices.push(index);
	}
	//! Drop a tracked resource no client needs any more and which no longer
	//! exists in the scene. Called from UnstreamNode, the only place where a
	//! resource can become unwanted.
	_pruneTrackedNode(uid) {
		// Only prune what we can positively confirm has left the scene. Without
		// a scene we cannot tell "deleted" from "not streamed just now", and
		// dropping the record would lose the clientNeeds bit that makes
		// UnstreamNode idempotent.
		if (!this.scene || this.scene.GetNode(uid)) return;
		var res = GeometryService.trackedResources.get(uid);
		if (!res || !res.clientNeeds.isEmpty()) return;
		GeometryService.trackedResources.delete(uid);
	}
	StreamNode(uid) {
		// An explicit request to stream is also a withdrawal of any earlier
		// request not to: StreamNode and UnstreamNode are inverses.
		this.appSuppressed.delete(uid);
		// this client should stream node uid.
		var res = GeometryService.GetOrCreateTrackedResource(uid);
		var index = clientIDToIndex.get(this.clientID);
		if (res.clientNeeds.get(index)) {
			// Already streaming for this client — nothing to do.
			return;
		}
		res.clientNeeds.set(index, true);
		// Add to the list of nodes this client should eventually receive:
		this.nodesToStreamEventually.add(uid);
	}
	//! Stop streaming a node to this client. `suppress` records that the caller
	//! does not want it back: host applications get that by default, so their
	//! decision survives the next UpdateVisibleNodes pass. UpdateVisibleNodes
	//! itself passes false, because it is deriving the set rather than
	//! overriding it.
	UnstreamNode(uid, suppress = true) {
		if (suppress)
			this.appSuppressed.add(uid);
		var index = clientIDToIndex.get(this.clientID);
		var res = GeometryService.trackedResources.get(uid);
		if (res) {
			if (!res.clientNeeds.get(index)) {
				// Already unstreamed for this client — nothing to do. The
				// suppression above is still recorded, so a caller that
				// re-evaluates its decision every tick keeps the node out of
				// the visible set without touching shared state or logging.
				return;
			}
			res.clientNeeds.set(index, false);
			// If the node was actually sent to this client, the client must be
			// told to destroy it via a RemoveNodes payload.
			if (res.WasSentToClient(this.clientID)) {
				this.removedNodesToSend.add(uid);
			}
		}
		// Should certainly be in this set:
		this.nodesToStreamEventually.delete(uid);
		// MAY not be in this set:
		this.streamedNodes.delete(uid);
		// TODO: now reduce the counts for all the dependent resources.
		console.log("Unstreaming node ", uid," for client ", this.clientID);
		this._pruneTrackedNode(uid);
	}
	//! Bring this client's streamed set into line with what it should be able to
	//! see: every node in the scene, minus those the registry hides from it,
	//! minus those the host application has suppressed.
	//!
	//! This is a diff rather than an additive sweep, which is what makes the
	//! client-specific node lifecycle work without any explicit distribution
	//! step. A node another client has just created enters the set and is
	//! streamed; a node whose owner has gone has left the scene, so it leaves
	//! the set and a RemoveNodes payload is queued. Neither case needs code of
	//! its own.
	UpdateVisibleNodes(scene, registry, clientID) {
		if (!scene) return;
		const desired = new Set();
		for (const uid of scene.GetAllNodeUids()) {
			if (this.appSuppressed.has(uid)) continue;
			if (registry && !registry.isVisibleTo(uid, clientID)) continue;
			desired.add(uid);
		}
		for (const uid of desired) {
			if (!this.nodesToStreamEventually.has(uid)) this.StreamNode(uid);
		}
		// Copy first: UnstreamNode mutates nodesToStreamEventually.
		for (const uid of Array.from(this.nodesToStreamEventually)) {
			if (!desired.has(uid)) this.UnstreamNode(uid, false);
		}
	}
	//! Drain the set of nodes the client must destroy. Returns an array of uids;
	//! the caller re-queues via UnstreamNode semantics if the send fails.
	GetRemoveNodesToSend() {
		if (this.removedNodesToSend.size == 0) return [];
		var uids = Array.from(this.removedNodesToSend);
		this.removedNodesToSend.clear();
		return uids;
	}
	StreamOrUnstream(resourceMap, uid, diff) {
		// exclude "undefined"
		if (!uid) return;
		if (uid == BigInt(0)) return;
		if (uid == 0) return;
		if (!resourceMap.has(uid)) {
			resourceMap.set(uid, 0);
		}
		resourceMap.set(uid, resourceMap.get(uid) + diff);
	}
	AddOrRemoveTexture(thisTextureUid, diff) {
		this.StreamOrUnstream(this.streamedTextures, thisTextureUid, diff);
	}

	AddMeshComponentResources(meshComponent, diff) {
		if (meshComponent.getType() != nd.NodeDataType.Mesh) {
			return;
		}
		if (meshComponent.data_uid == 0) {
			return;
		}
		this.StreamOrUnstream(
			this.streamedMeshes,
			meshComponent.data_uid,
			diff
		);
		//meshNode.skeletonID = node.skeletonNodeID;

		//Get joint/bone IDs, if the skeletonID is not zero.
		if (
			meshComponent.data_uid != 0 &&
			meshComponent.data_type == nd.NodeDataType.Skeleton
		) {
			var skeleton = geometryStore.getSkeleton(
				meshComponent.data_uid,
				getClientAxesStandard()
			);
			for (var uid of skeleton.boneIDs) {
			}
		}
		if (meshComponent.renderState.globalIlluminationUid != BigInt(0)) {
			this.StreamOrUnstream(
				this.streamedTextures,
				meshComponent.renderState.globalIlluminationUid,
				diff
			);
		}
	}

	AddCanvasResources(canvasComponent, diff) {
		if (canvasComponent.getType() != nd.NodeDataType.TextCanvas) {
			return;
		}
		if (canvasComponent.data_uid == 0) {
			return;
		}
		this.StreamOrUnstream(
			this.streamedTextCanvases,
			canvasComponent.data_uid,
			diff
		);
		var textCanvas = resources.GetResourceFromUid(canvasComponent.data_uid);
		if (textCanvas && textCanvas.fontAtlasUid) {
			if (canvasComponent.data_uid)
				this.StreamOrUnstream(
					this.streamedTextCanvases,
					canvasComponent.data_uid,
					diff
				);
			if (textCanvas.fontAtlasUid) {
				this.StreamOrUnstream(
					this.streamedFontAtlases,
					textCanvas.fontAtlasUid,
					diff
				);
				var fontAtlas = resources.GetResourceFromUid(
					textCanvas.fontAtlasUid
				);
				if (fontAtlas.font_texture_uid)
					this.StreamOrUnstream(
						this.streamedTextures,
						fontAtlas.font_texture_uid,
						diff
					);
			} else
				{
			
				console.error("Text Canvas ", canvasComponent.data_uid, " has font atlas 0");
			}
		}
	}

	AddNodeResources(node) {
		/*for(var anim_uid of node.animations)
		{
			this.streamedAnimations[anim_uid]+=diff;
		}*/
		for (const material_uid of node.materials) {
			var thisMaterial = geometryStore.getMaterial(material_uid);
			if (!thisMaterial) {
				continue;
			}
			this.StreamOrUnstream(this.streamedMaterials, material_uid, diff);

			var texture_uids = [
				thisMaterial.baseColorTexture.index,
				thisMaterial.metallicRoughnessTexture.index,
				thisMaterial.emissiveTexture.index,
				thisMaterial.normalTexture.index,
				thisMaterial.occlusionTexture.index,
			];
			for (const tex_uid of texture_uids) {
				if (tex_uid != 0)
					this.StreamOrUnstream(this.streamedTextures, tex_uid, diff);
			}
		}
	}
	AddOrRemoveNodeAndResources(node_uid, diff) {
		var already_present = false;
		var old_count = 0;
		if (this.streamedNodes.has(node_uid)) {
			already_present = true;
			old_count = this.streamedNodes.get(node_uid);
		} else {
			this.streamedNodes.set(node_uid, 0);
		}

		var node = this.scene.GetNode(node_uid);
		if (!node) {
			// The node left the scene between being added to the stream set and
			// being resolved — a client-specific node whose owner disconnected,
			// most likely. Undo the tentative entry and let the next
			// UpdateVisibleNodes pass queue the removal.
			this.streamedNodes.delete(node_uid);
			return;
		}
		if(diff>0 && !already_present)
			console.log("Adding node ", node.name," (", node_uid,") for client ", this.clientID);
		else if(diff<0 && already_present)
			console.log("Removing node ", node.name," (", node_uid,") for client ", this.clientID);
		else
			console.log("Changing node ", node.name," (", node_uid,") count from ", old_count, " to ", old_count+diff, " for client ", this.clientID);
		this.streamedNodes.set(node_uid, old_count + diff);
		var meshResources = [];
		node.components.forEach((component) => {
			switch (component.getType()) {
				case nd.NodeDataType.None:
				case nd.NodeDataType.Light:
					break;
				case nd.NodeDataType.Skeleton:
					{
						//GetSkeletonNodeResources(node_uid, *node, meshResources);
					}
					break;
				case nd.NodeDataType.Mesh:
					{
						this.AddMeshComponentResources(component, diff);

						/*if(node.skeletonNodeID!=0)
						{
							var skeletonnode = this.scene.getNode(node.skeletonNodeID);
							if(!skeletonnode)
							{
								//TELEPORT_CERR<<"Missing skeleton node "<<node.skeletonNodeID<<std.endl;
							}
							else
							{
								this.streamedNodes[node.skeletonNodeID]+=diff;
								meshResources=meshResources.concat(GetSkeletonNodeResources(node.skeletonNodeID, skeletonnode ));
								for(var r of meshResources)
								{
									for(var b of r.boneIDs)
									{
										if(b)
											streamedNodes.set(b,streamedNodes.get(b)+diff);
									}
								}
							}
						}*/
					}
					break;
				case nd.NodeDataType.TextCanvas:
					{
						this.AddCanvasResources(component, diff);
					}
					break;
				default:
					break;
			}
		});
	}
	/*

	+-------------------------------------------+
	|	nodesToStreamEventually					|
	|	+---------------------------+			|
	|	|	streamedNodes			|			|
	|	|		+---------------+	|			|
	|	|		|  nodesToSend	|	|			|
	|	|		+---------------+	|			|
	|	+---------------------------+			|
	+-------------------------------------------+

	*/

	UpdateNodesToStream() {
		//  The set of ALL the nodes of sufficient priority that the client NEEDS is streamedNodes.
		for (let uid of this.nodesToStreamEventually) {
			// If it's not in the global tracked resources list, we can't stream it.
			if (!GeometryService.trackedResources.has(uid)) continue;
			// The client eventually should need this node.
			// But is it already in the streamed list?
			if (this.streamedNodes.has(uid)) {
				// no need to add it.
				continue;
			}
			// if it hasn't been sent at all to our client, we add its resources.
			this.AddOrRemoveNodeAndResources(uid, 1);
		}
	}
	UpdateTexturesToStream() {
		// scene background?
		var bg_uid = resources.GetOrAddResourceUidFromUrl(
			core.GeometryPayloadType.TexturePointer,
			this.scene.backgroundTexturePath
		);
		if (bg_uid && this.backgroundTextureUid != bg_uid) {
			this.AddOrRemoveTexture(this.backgroundTextureUid, -1);
			this.backgroundTextureUid = bg_uid;
			this.AddOrRemoveTexture(this.backgroundTextureUid, 1);
		}

		var diff_uid = resources.GetOrAddResourceUidFromUrl(
			core.GeometryPayloadType.TexturePointer,
			this.scene.diffuseCubemapPath
		);
		if (diff_uid && this.diffuseTextureUid != diff_uid) {
			this.AddOrRemoveTexture(this.diffuseTextureUid, -1);
			this.diffuseTextureUid = diff_uid;
			this.AddOrRemoveTexture(this.diffuseTextureUid, 1);
		}

		var spec_uid = resources.GetOrAddResourceUidFromUrl(
			core.GeometryPayloadType.TexturePointer,
			this.scene.specularCubemapPath
		);
		if (spec_uid && this.specularTextureUid != spec_uid) {
			this.AddOrRemoveTexture(this.specularTextureUid, -1);
			this.specularTextureUid = spec_uid;
			this.AddOrRemoveTexture(this.specularTextureUid, 1);
		}
	}
	GetResourcesToSend(resourcePool) {
		var toSend = [];
		// We have sets/maps of what the client SHOULD have, but some of these may have been sent already.
		let time_now_us = core.getTimestampUs();
		for (const [uid, count] of resourcePool) {
			var res = GeometryService.GetOrCreateTrackedResource(uid);
			// If it was already received we don't send it:
			if (res.WasAcknowledgedByClient(this.clientID)) continue;
			// But what if it was sent to the client, and not yet acknowledged?
			//  depends how long ago.
			if (res.WasSentToClient(this.clientID)) {
				var timeSentUs = res.GetTimeSent(this.clientID);
				// If we sent it too long ago with no acknowledgement, we can send it again.
				if (time_now_us - timeSentUs > this.timeout_us) {
					res.Timeout(this.clientID);
				} else {
					continue;
				}
			}
			// Do NOT mark Sent here. The caller's Send*() path checks
			// isGeometryOpen() and may bail out silently if the geometry channel
			// hasn't finished opening yet; marking Sent eagerly would leave the
			// resource stuck "in flight" until timeout_us (10 s) elapses, even
			// though nothing was actually transmitted. The successful-send path
			// calls EncodedResource(uid), which records the Sent state.
			toSend.push(uid);
		}
		return toSend;
	}

	//! Nodes to send this frame: of the streamedNodes, which have not been sent,
	//!   or were sent a while ago and never acknowledged?
	GetNodesToSend() {
		this.UpdateNodesToStream();
		return this.GetResourcesToSend(this.streamedNodes);
	}
	GetTexturesToSend() {
		this.UpdateTexturesToStream();
		return this.GetResourcesToSend(this.streamedTextures);
	}
	GetCanvasesToSend() {
		return this.GetResourcesToSend(this.streamedTextCanvases);
	}
	GetFontAtlasesToSend() {
		return this.GetResourcesToSend(this.streamedFontAtlases);
	}
	// Get the list of meshes to stream. This is the list of meshes that we should have on the client
	//  excluding those that have been sent.
	GetMeshesToSend() {
		// Delegate to GetResourcesToSend so all resource pools share the same
		// "not acknowledged AND (not sent OR sent-but-timed-out)" rule, and the
		// same gating contract — Sent is recorded by EncodedResource() after the
		// transport actually accepts the buffer, not by the picker.
		return this.GetResourcesToSend(this.streamedMeshes);
	}
	EncodedResource(resource_uid) {
		if (!GeometryService.trackedResources.has(resource_uid)) return;
		var res = GeometryService.GetOrCreateTrackedResource(resource_uid);
		if (res) {
			let time_now_us = core.getTimestampUs();
			res.Sent(this.clientID, time_now_us);
		}
	}
	//! Forget that we ever sent this resource to this client, so the next
	//! streaming pass picks it up again. Used when the client tells us it
	//! could not obtain the resource and we have something different to
	//! send it (see Client.RehostRelayedAvatarFor).
	ResendResource(resource_uid) {
		if (!GeometryService.trackedResources.has(resource_uid)) return;
		var res = GeometryService.GetOrCreateTrackedResource(resource_uid);
		if (res) {
			res.Timeout(this.clientID);
		}
	}
	ConfirmResource(resource_uid) {
		if (!GeometryService.trackedResources.has(resource_uid)) return;
		var res = GeometryService.GetOrCreateTrackedResource(resource_uid);
		if (res) {
			res.AcknowledgeBy(this.clientID);
		}
	}
	//! Has this client confirmed receipt of this resource? False for anything we have
	//! never tracked.
	WasNodeAcknowledged(resource_uid) {
		const res = GeometryService.trackedResources.get(resource_uid);
		return res ? res.WasAcknowledgedByClient(this.clientID) : false;
	}
	//! Has this node been put on the wire for this client? True from the moment we send
	//! it, without waiting for the client to confirm.
	//!
	//! This, not WasNodeAcknowledged, is the right gate for per-tick updates such as
	//! movement. Acknowledgement travels back over the client's own send path, and when
	//! that path is broken the client can still be holding — and rendering — a node it
	//! has never managed to acknowledge. Withholding movement then leaves it frozen for
	//! the rest of the session. The C++ server takes the same view: it sends movement for
	//! every streamed non-stationary node with no acknowledgement check at all
	//! (GeometryStreamingService.cpp). Gating on "sent" still avoids the pointless
	//! traffic of moving a node the client has not been given yet.
	WasNodeSent(resource_uid) {
		const res = GeometryService.trackedResources.get(resource_uid);
		return res ? res.WasSentToClient(this.clientID) : false;
	}
}

module.exports = { GeometryService };
