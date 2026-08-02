'use strict';
const core=require("../core/core.js");
const client=require("./client.js");
const gs=require("./geometry_service.js");
const client_nodes=require("./client_nodes.js");
const signaling=require("../signaling.js");
const identity_proto=require("../protocol/identity.js");
var _ = require('underscore');
const WebRtcConnectionManager = require('../connections/webrtcconnectionmanager');

// How long a departed client's nodes stay in the scene, waiting for it to come
// back. A brief network blip should not make an avatar pop out of every peer's
// world and back in a second later. Overridable per deployment.
const CLIENT_GRACE_MS = parseInt(process.env.TELEPORT_CLIENT_GRACE_MS || '10000', 10);
// Anonymous clients get no grace by default: with no stable identity there is
// nothing to match a returning client against, so every reconnect would be a new
// session and the old one's nodes would linger for the full window with no
// possibility of ever being re-adopted.
const ANONYMOUS_GRACE_MS = parseInt(process.env.TELEPORT_CLIENT_GRACE_ANONYMOUS_MS || '0', 10);

class ClientManager
{
	static clientManager = null;
    constructor()
    {
		this.clients= new Map();
		// Nodes whose lifetime is scoped to a client session: origin nodes,
		// avatar nodes, anything else the host application spawns per client.
		// See client_nodes.js.
		this.clientNodes=new client_nodes.ClientNodeRegistry();
		// Clients that have gone, whose nodes are being held for a possible
		// reconnect. clientID -> { userKey, timer, graceMs }.
		this.departing= new Map();
		this.graceMs=CLIENT_GRACE_MS;
		this.anonymousGraceMs=ANONYMOUS_GRACE_MS;
		this.addClientNodeAndReturnOriginUid=null;
		this.onClientPostCreate=null;
		this.onClientDisconnect=null;
		this.geometryIntervalId=0;
		let unixt_us=core.getStartTimeUnixUs();
		console.log("Start Time: "+unixt_us+" us = "+core.unixTimeToUTCString(unixt_us)+"\n");
    }
	//! The scene client-specific nodes live in. Picked up automatically from the
	//! first client given a scene (Client.SetScene), so most host applications
	//! never need to call this.
	SetScene(sc)
	{
		this.clientNodes.SetScene(sc);
	}
	//! How long a departed client's nodes survive before being destroyed, in ms.
	//! Zero destroys them as soon as the client is known to have gone.
	SetGracePeriodMs(ms,anonymousMs)
	{
		if(ms!=null)
			this.graceMs=ms;
		if(anonymousMs!=null)
			this.anonymousGraceMs=anonymousMs;
	}

	StartStreaming(){
		this.geometryIntervalId = setInterval(_.bind( function() {
			//console.log("Streaming Update at "+core.getTimestampUs()/1000000.0);
			this.UpdateStreaming();
		  },this), 1000);
	}
	StopStreaming(){
		if(this.geometryIntervalId!=0)
			clearInterval(this.geometryIntervalId);
	}
	UpdateStreaming() {
		// Track clients to remove due to timeout (can't modify Map during iteration)
		const clientsToRemove = [];

		for (let [cl_id,cl] of this.clients) {
			// Check if this client's WebRTC connection has timed out
			if(cl.hasWebRtcConnectionTimedOut()) {
				clientsToRemove.push(cl_id);
			} else {
				// One client's failure must not stop the others being streamed
				// to. This callback runs inside a setInterval, where an escaping
				// exception would take the whole process down.
				try {
					cl.UpdateStreaming();
				} catch(err) {
					console.error("UpdateStreaming failed for client "+cl_id+": "+(err&&err.stack?err.stack:err));
				}
			}
		}

		// Remove clients that timed out
		for (const cl_id of clientsToRemove) {
			console.log("Removing client "+cl_id+" due to WebRTC connection timeout");
			const cl = this.clients.get(cl_id);
			if(cl) {
				cl.StopStreaming();
			}
			this.RemoveClient(cl_id);
		}
	}
    GetOrCreateClient(clientID)
    {
        if(!this.clients.has(clientID))
        {
			if(this.addClientNodeAndReturnOriginUid==null){
				console.error("No callback has been set to create the client origin.");
				return null;
			}
			var sigCli=signaling.signalingClients.get(clientID);
			var user=sigCli?(sigCli.user||null):null;
			// Is this a client that left moments ago and has come back? If so it
			// inherits the nodes it left behind, which never left the scene, so
			// peers saw no interruption at all.
			var origin_uid=this.ReadoptDepartedNodes(clientID,user);
			if(origin_uid==0)
				origin_uid=this.addClientNodeAndReturnOriginUid(clientID);
			if(origin_uid==0) {
				console.error("Failed to create a root node for client "+clientID);
				return null;
			}
			// The origin node is the origin of this client's LOCAL tracking
			// space, positioned within the server's global space. Peers need it
			// as the parent transform of everything the client carries, and the
			// client itself needs it for SetOriginNode — so it is visible to
			// everyone, always.
			this.clientNodes.register(clientID,origin_uid,{
				visibility:client_nodes.NodeVisibility.Everyone,
				role:'origin'});
			var sigSend=sigCli.sendToClient.bind(sigCli);
			var c=this.createClient(clientID,sigSend);
			// Internal back-reference: lets the client reach the node registry
			// during streaming, and hand its scene to the registry.
			c.clientManager=this;
			c.setOrigin(origin_uid);
			// Identity was resolved before the session started, so the host
			// application can act on it in onClientPostCreate.
			c.user=user;
			if(this.clients.size==0)
				this.StartStreaming();
            this.clients.set(clientID,c);
			if(this.onClientPostCreate!=null)
				this.onClientPostCreate(clientID, c.user);
			return c;
        }
        var c=this.clients.get(clientID);
        return c;
    }
	//! A returning client re-adopts the nodes its previous session left behind,
	//! if it can be recognised as the same person and the grace period has not
	//! expired. Returns the inherited origin node uid, or 0 for a new session.
	ReadoptDepartedNodes(clientID,user)
	{
		const key=(user&&user.key)?user.key:null;
		if(!key||!this.departing.size)
			return 0;
		for(const [departedID,entry] of this.departing) {
			if(entry.userKey!==key)
				continue;
			clearTimeout(entry.timer);
			this.departing.delete(departedID);
			this.clientNodes.transferToClient(departedID,clientID);
			gs.GeometryService.ForgetClient(departedID);
			const origins=this.clientNodes.nodesForClientWithRole(clientID,'origin');
			const origin_uid=origins.length?origins[0]:0;
			console.log("Client "+clientID+" is client "+departedID+" returning within the grace "
				+"period; re-adopting its "+this.clientNodes.nodesForClient(clientID).length
				+" node(s), origin "+origin_uid+".");
			return origin_uid;
		}
		return 0;
	}
	RemoveClient(clientID){
        if(this.clients.has(clientID)) {
			const c=this.clients.get(clientID);
			this.clients.delete(clientID);
			const userKey=(c&&c.user&&c.user.key)?c.user.key:null;
			const graceMs=userKey?this.graceMs:this.anonymousGraceMs;
			if(graceMs>0&&this.clientNodes.nodesForClient(clientID).length) {
				// Hold the nodes. They stay in the scene and stay streamed to
				// every peer, so a momentary drop is invisible to them.
				const timer=setTimeout(_.bind(function(){
					console.log("Grace period expired for client "+clientID+".");
					this.FinaliseDepartedClient(clientID);
				},this),graceMs);
				// Don't keep the process alive just to expire a grace period.
				if(timer.unref)
					timer.unref();
				this.departing.set(clientID,{userKey,timer,graceMs});
				console.log("Client "+clientID+" left; holding its nodes for "+graceMs+"ms in case it returns.");
			} else {
				this.FinaliseDepartedClient(clientID);
			}
			if(this.clients.size==0)
				this.StopStreaming();
		}
	}
	//! Destroy a departed client's nodes for good. Their removal from the scene
	//! is all that is needed: every remaining client's next streaming pass finds
	//! them gone from its visible set and queues a RemoveNodes payload.
	FinaliseDepartedClient(clientID){
		const entry=this.departing.get(clientID);
		if(entry) {
			clearTimeout(entry.timer);
			this.departing.delete(clientID);
		}
		this.clientNodes.releaseForClient(clientID);
		// Notify the host application after removal, so per-client state can be
		// torn down while this client is gone from the map but the remaining
		// clients are still iterable.
		if(this.onClientDisconnect!=null)
			this.onClientDisconnect(clientID);
		// Free the per-client streaming bookkeeping last: the host callback may
		// still want to look the client up.
		gs.GeometryService.ForgetClient(clientID);
	}
    GetClient(clientID)
    {
        if(!this.clients.has(clientID))
        {
            return null;
        }
        var c=this.clients.get(clientID);
        return c;
    }
	SetNewClientNodeCallback(cb)
	{
		this.addClientNodeAndReturnOriginUid=cb;
	}
	SetCreateClientCallback(cb)
	{
		this.createClient=cb;
	}
	SetClientPostCreationCallback(cb)
	{
		this.onClientPostCreate=cb;
	}
	SetClientDisconnectionCallback(cb)
	{
		this.onClientDisconnect=cb;
	}
	// This is a callback, signaling service calls this when the client has signalled.
	newClient(clientID, signalingClient) {
		// then we tell the client manager to start this client.
		var c=this.GetOrCreateClient(clientID);
		signalingClient.receiveReliableBinaryMessage=c.receiveReliableBinaryMessage.bind(c);
		// Route avatar-offer / avatar-revoke text frames to the per-client
		// AvatarService. The signaling layer dispatches by message type.
		signalingClient.handleAvatarOffer=c.avatarService.handleOffer.bind(c.avatarService);
		signalingClient.handleAvatarRevoke=c.avatarService.handleRevoke.bind(c.avatarService);
		//c.SetScene(this.scene);
		c.Start();
		return c;
	}
	disconnectClient(clientID) {
		var c=this.GetClient(clientID);
		if(!c)
			return;
		c.StopStreaming();
		this.RemoveClient(clientID);
	}
	writeState() {
		// This builds HTML by concatenation, and displayName is supplied by the
		// client, so every cell goes through escapeHtml. Do not interpolate a
		// raw value here.
		const esc=identity_proto.escapeHtml;
		var content="<table><tr><th>Client Id</th><th>IP Address</th><th>Signalling State</th>"
			+"<th>User</th><th>Trust</th><th>Visits</th></tr>";
		for (let [cl_id,cl] of this.clients) {
			var sigCli=signaling.signalingClients.get(cl_id);
			var user=cl.user;
			var tier=user?user.tier:identity_proto.TRUST_ANONYMOUS;
			var name=(user&&user.record&&user.record.displayName)?user.record.displayName:"—";
			var visits=(user&&user.record)?user.record.visits:"—";
			content+="\n<tr><td>"+esc(cl_id)+"</td> <td>" + esc(sigCli?sigCli.ip:"") + "</td> <td>"
				+ esc(sigCli?sigCli.signalingState:"") + "</td> <td>" + esc(name) + "</td> <td>"
				+ esc(tier) + "</td> <td>" + esc(visits) + "</td></tr>";
		};
		content+="\n</table>";
		return content;
	}
}

exports.getInstance=()=>
{
	if(ClientManager.clientManager==null)
		ClientManager.clientManager = new ClientManager();
	return ClientManager.clientManager;
}
exports.ClientManager=ClientManager;
