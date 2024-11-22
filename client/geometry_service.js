'use strict';
// using https://github.com/infusion/BitSet.js
const bit=require("bitset");
const core=require("../protocol/core.js");

var clientIDToIndex=new Map();
var nextIndex=0;

class TrackedResource
{
    constructor(){
        this.clientNeeds=new bit.BitSet();		    // whether we THINK the client NEEDS the resource.
        this.sent=new bit.BitSet();			        // Whether we have actually sent the resource,
        this.sent_server_time_us=new Map(); 	// and when we sent it. Map of clientID to timestamp.
        this.acknowledged=new bit.BitSet();	        // Whether the client acknowledged receiving the resource.
		
    }
	IsNeededByClient(clientID){
		return this.clientNeeds.bit[clientIDToIndex[clientID]];
	}
	WasSentToClient(cleitnID){
		return this.sent.bit[clientIDToIndex[clientID]];
	}
	WasAcknowledgedBy(clientID){
		return this.acknowledged.bit[clientIDToIndex[clientID]];
	}
	GetTimeSent(clientID){
		return this.sent_server_time_us[clientID];
	}
	Sent(clientID,timestamp){
		this.sent.BitSet(clientIDToIndex[clientID],true);
		this.acknowledged.BitSet(clientIDToIndex[clientID],false);
		this.sent_server_time_us.set(clientID,timestamp);
	}
	AcknowledgeBy(clientID){
		this.acknowledged.BitSet(clientIDToIndex[clientID],true);
		// erase timestamp?
		this.sent_server_time_us.delete(clientID);
	}
	Timeout(clientID){
		this.sent.BitSet(clientIDToIndex[clientID],false);
		this.acknowledged.BitSet(clientIDToIndex[clientID],false);
		this.sent_server_time_us.clear(clientID);
	}
};

class GeometryService
{
	static trackedResources=new Map();

    constructor(clientID) {
		this.clientID=clientID;
		clientIDToIndex.set(clientID,nextIndex++);
		this.originNodeId = 0;
		this.priority = 0;
		// The lowest priority for which the client has confirmed all the nodes we sent.
		// We only send lower-priority nodes when all higher priorities have been confirmed.
		this.lowest_confirmed_node_priority=-100000;
		// How many nodes we have unconfirmed 
		this.unconfirmed_priority_counts=new Map();
		// Nodes the client needs, we might not send all at once.
		this.nodesToStream=new Set();
		//!The nodes actually to stream.
		// When higher priority nodes are acknowledged,
		// lower priority nodes AND their resources are added.
		// This is a map from the resource uid's to the number of REASONS we have to stream it.
		//   e.g. if a texture is needed by two nodes, it should have 2 here.
		this.streamedNodes=new Map();//map<uid,int> 
		// Node resources are refcounted, they could be requested
		// by more than one node, and only when no node references
		//  them should they be removed.
		this.streamedMeshes=new Map();
		this.streamedMaterials=new Map();
		this.streamedTextures=new Map();
		this.streamedSkeletons=new Map();
		this.streamedBones=new Map();
		this.streamedAnimations=new Map();
		this.streamedTextCanvases=new Map();
		this.streamedFontAtlases=new Map();
    }
	StreamNode(uid) {
		// this client should stream node uid.
		if(!GeometryService.trackedResources.has(uid))
			GeometryService.trackedResources.set(uid,new TrackedResource());
		var res=GeometryService.trackedResources.get(uid);
		var index=clientIDToIndex.get(this.clientID);
		res.clientNeeds.set(index,true);
		// Add to the list of nodes this client should eventually receive:
		this.nodesToStream.add(uid);
	}
	UnstreamNode(uid) {
		var res=GeometryService.trackedResources.get(uid);
		var index=clientIDToIndex.get(this.clientID);
		res.clientNeeds.BitSet(index,false);
		// Should certainly be in this set:
		this.nodesToStream.delete(uid);
		// MAY not be in this set:
		this.streamedNodes.delete(uid);
	}
	AddOrRemoveNodeAndResources(node_uid, remove)
	{
		var diff=remove?-1:1;
		if(!streamedNodes.has(node_uid))
		{
			streamedNodes.set(node_uid,0);
		}
		else if(!remove)
		{
			return;
		}
		var node = scene.getNode(node_uid);
		streamedNodes.set(node_uid,streamedNodes.get(node_uid)+diff);
		
		//std.vector<MeshNodeResources> meshResources;
		switch (node.data_type)
		{
			case NodeDataType.None:
			case NodeDataType.Light:
				break;
			case NodeDataType.Skeleton:
			{
				//GetSkeletonNodeResources(node_uid, *node, meshResources);
			}
			break;
			case NodeDataType.Mesh:
				{
					meshResources=GetMeshNodeResources(node_uid, node );
					if(node.renderState.globalIlluminationUid>0)
					{
						streamedTextures[node.renderState.globalIlluminationUid]+=diff;
					}
			
					if(node.skeletonNodeID!=0)
					{
						var skeletonnode = scene.getNode(node.skeletonNodeID);
						if(!skeletonnode)
						{
							//TELEPORT_CERR<<"Missing skeleton node "<<node.skeletonNodeID<<std.endl;
						}
						else
						{
							streamedNodes[node.skeletonNodeID]+=diff;
							meshResources=GetSkeletonNodeResources(node.skeletonNodeID, skeletonnode );
							for(var r in meshResources)
							{
								for(var b in r.boneIDs)
								{
									if(b)
										streamedNodes.set(b,streamedNodes.get(b)+diff);
								}
							}
						}
					}
				}
				break;
			case NodeDataType.TextCanvas:
				if(node.data_uid)
				{
					var textCanvas=scene.getTextCanvas(node.data_uid);
					if(c&&c.font_uid)
					{
						var fontAtlas =scene.getFontAtlas(c.font_uid);
						if(f)
						{
							if(node.data_uid)
								streamedTextCanvases[node.data_uid]+=diff;
							if(c.font_uid)
								streamedFontAtlases[c.font_uid]+=diff;
							if(f.font_texture_uid)
								streamedTextures[f.font_texture_uid]+=diff;
						}
					}
				}
				break;
			default:
				break;
		}
		for(var m in meshResources)
		{
			for(var u in m.animationIDs)
			{
				streamedAnimations[u]+=diff;
			}
			for(var u in m.boneIDs)
			{
				streamedBones[u]+=diff;
			}
			for(var u in m.materials)
			{
				streamedMaterials[u.material_uid]+=diff;
				for(var t in u.texture_uids)
				{
					streamedTextures[t]+=diff;
				}
			}
			if(m.mesh_uid)
			{
				streamedMeshes[m.mesh_uid]+=diff;
			}
			if(m.skeletonAssetID)
			{
				streamedSkeletons[m.skeletonAssetID]+=diff;
			}
		}
	}
	GetNodesToStream() {
		// We have sets/maps of what the client SHOULD have, but some of these may have been sent already.
		let time_now_us=core.getTimestampUs();
		// ten seconds for timeout. Tweak this.
		const timeout_us=10000000;
		//  The set of ALL the nodes of sufficient priority that the client NEEDS is streamedNodes.
		for(let uid in this.nodesToStream)
		{
			var res=GeometryService.trackedResources.get(uid);
			// The client eventually should need this node.
			// But if was already received we don't send it:
			if(res.WasAcknowledgedBy(this.clientID))
				continue;
			if(res.WasSentToClient(this.clientID))
			{
				var timeSentUs=res.GetTimeSent(this.clientID);
				// If we sent it too long ago with no acknowledgement, we can send it again.
				if(time_now_us-timeSentUs>timeout_us)
				{
					res.Timeout(this.clientID);
				}
				else
				{
					continue;
				}
			}
			else
			{
				// if it hasn't been sent at all to our client, we add its resources.
				AddOrRemoveNodeAndResources(uid,false);
			}
			this.streamedNodes.set(uid,time_now_us);
			res.Sent(this.clientID,time_now_us);
		}
		return this.streamedNodes;
	}
};

module.exports= {GeometryService};
