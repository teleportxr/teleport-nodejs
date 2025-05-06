"use strict";
// using https://github.com/infusion/BitSet.js
const bit = require("bitset");
const core = require("../core/core.js");
const nd = require("../scene/node.js");
const resources = require("../scene/resources.js");
const { forEach } = require("underscore");

var clientIDToIndex = new Map();
var nextIndex = 0;

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
		this.sent_server_time_us.clear(clientID);
	}
}

//! One GeometryService per connected client.
class GeometryService {
	//! One trackedResources shared acrosss all clients.
	static trackedResources = new Map();

	constructor(clientID) {
		this.clientID = clientID;
		clientIDToIndex.set(clientID, nextIndex++);
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
		-this.StreamNode(n_uid);
	}
	static GetOrCreateTrackedResource(uid) {
		if (!GeometryService.trackedResources.has(uid))
			GeometryService.trackedResources.set(uid, new TrackedResource());
		var res = GeometryService.trackedResources.get(uid);
		return res;
	}
	StreamNode(uid) {
		// this client should stream node uid.
		var res = GeometryService.GetOrCreateTrackedResource(uid);
		var index = clientIDToIndex.get(this.clientID);
		res.clientNeeds.set(index, true);
		// Add to the list of nodes this client should eventually receive:
		this.nodesToStreamEventually.add(uid);
	}
	UnstreamNode(uid) {
		var index = clientIDToIndex.get(this.clientID);
		if (GeometryService.trackedResources.has(uid)) {
			var res = GeometryService.GetOrCreateTrackedResource(uid);
			res.clientNeeds.BitSet(index, false);
		}
		// Should certainly be in this set:
		this.nodesToStreamEventually.delete(uid);
		// MAY not be in this set:
		this.streamedNodes.delete(uid);
		// TODO: now reduce the counts for all the dependent resources.
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
		console.log("Adding node ", node.name, " for client ", this.clientID);
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
			toSend.push(uid);
			res.Sent(this.clientID, time_now_us);
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
		var resource_uids = [];
		let time_now_us = core.getTimestampUs();
		for (const [uid, count] of this.streamedMeshes) {
			//is mesh streamed
			var res = GeometryService.GetOrCreateTrackedResource(uid);
			// If it was already received we don't send it:
			if (res.WasAcknowledgedByClient(this.clientID)) continue;
			if (res.WasSentToClient(this.clientID)) {
				var timeSentUs = res.GetTimeSent(this.clientID);
				// If we sent it too long ago with no acknowledgement, we can send it again.
				if (time_now_us - timeSentUs > this.timeout_us) {
					res.Timeout(this.clientID);
				}
			} else {
				// if it hasn't been sent at all to our client, we add its resources.
				resource_uids.push(uid);
				res.Sent(this.clientID, time_now_us);
			}
		}
		return resource_uids;
	}
	EncodedResource(resource_uid) {
		if (!GeometryService.trackedResources.has(resource_uid)) return;
		var res = GeometryService.GetOrCreateTrackedResource(resource_uid);
		if (res) {
			let time_now_us = core.getTimestampUs();
			res.Sent(this.clientID, time_now_us);
		}
	}
	ConfirmResource(resource_uid) {
		if (!GeometryService.trackedResources.has(resource_uid)) return;
		var res = GeometryService.GetOrCreateTrackedResource(resource_uid);
		if (res) {
			res.AcknowledgeBy(this.clientID);
		}
	}
}

module.exports = { GeometryService };
