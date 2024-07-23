'use strict';
// using https://github.com/infusion/BitSet.js
const bit=require("bitset.js");

var clientIDToIndex=new Map();
var nextIndex=0;

class TrackedResource
{
    constructor(){
        this.clientNeeds=new BitSet();		    // whether we THINK the client NEEDS the resource.
        this.sent=new BitSet();			        // Whether we have actually sent the resource,
        this.sent_server_time_us=new Map(); 	// and when we sent it. Map of clientID to timestamp.
        this.acknowledged=new BitSet();	        // Whether the client acknowledged receiving the resource.
		
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
		this.sent_server_time_us[clientID]=timestamp;
	}
	AcknowledgeBy(clientID){
		this.acknowledged.BitSet(clientIDToIndex[clientID],true);
		// erase timestamp?
		this.sent_server_time_us.delete(clientID);
	}
};
class GeometryService
{
	static trackedResources=new Map();

    constructor(clientID) {
		this.clientID=clientID;
		clientIDToIndex[clientID]=nextIndex++;
		this.originNodeId = BigInt.asUintN(BigInt(0));
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
		this.streamedNodes=new Map();//map<avs::uid,int> 
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
	StreamNode(uid){
		// this client should stream node uid.
		res=trackedResources[uid];
		index=clientIDToIndex[this.clientID];
		res.clientNeeds.BitSet(index,true);
	}
	UnstreamNode(uid){
		res=trackedResources[uid];
		index=clientIDToIndex[this.clientID];
		res.clientNeeds.BitSet(index,false);
	}
	GetNodesToStream(){
		// We have sets/maps of what the client SHOULD have, but some of these may have been sent already.
			let time_now_us=GetServerTimeUs();
			// ten seconds for timeout. Tweak this.
			const timeout_us=10000000;
		// Start with nodes. The set of ALL the nodes of sufficient priority that the client NEEDS is
		// streamedNodes.
			for(let uid in streamedNodes)
			{
				const tr=trackedResources[uid];
				if(tr.acknowledged)
					continue;
				if(!tr.sent||time_now_us-tr.sent_server_time_us>timeout_us)
				{
					outNodeIDs.insert(r.first);
				}
			}
		return this.nodesToStream;
	}
};

module.exports= {GeometryService};
