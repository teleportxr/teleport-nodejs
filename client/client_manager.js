'use strict';
const core=require("../core/core.js");
const client=require("./client.js");
const signaling=require("../signaling.js");
const identity_proto=require("../protocol/identity.js");
var _ = require('underscore');
const WebRtcConnectionManager = require('../connections/webrtcconnectionmanager');

class ClientManager
{
	static clientManager = null;
    constructor()
    {
		this.clients= new Map();
		this.addClientNodeAndReturnOriginUid=null;
		this.onClientPostCreate=null;
		this.onClientDisconnect=null;
		this.geometryIntervalId=0;
		let unixt_us=core.getStartTimeUnixUs();
		console.log("Start Time: "+unixt_us+" us = "+core.unixTimeToUTCString(unixt_us)+"\n");
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
				cl.UpdateStreaming();
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
				error("No callback has been set to create the client origin.");
				return null;
			}
			var origin_uid=this.addClientNodeAndReturnOriginUid(clientID);
			if(origin_uid==0) {
				error("Failed to create a root node for client "+clientID);
				return null;
			}
			var sigCli=signaling.signalingClients.get(clientID);
			var sigSend=sigCli.sendToClient.bind(sigCli);
			var c=this.createClient(clientID,sigSend);
			c.setOrigin(origin_uid);
			// Identity was resolved before the session started, so the host
			// application can act on it in onClientPostCreate.
			c.user=sigCli.user||null;
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
	RemoveClient(clientID){
        if(this.clients.has(clientID)) {
			this.clients.delete(clientID);
			// Notify the host application after removal, so per-client state
			// (e.g. avatar nodes) can be torn down while this client is gone
			// from the map but the remaining clients are still iterable.
			if(this.onClientDisconnect!=null)
				this.onClientDisconnect(clientID);
			if(this.clients.size==0)
				this.StopStreaming();
		}
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
