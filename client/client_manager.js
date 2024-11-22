'use strict';
const core=require("../protocol/core.js");
const client=require("./client.js");
const signaling=require("../signaling.js");
var _ = require('underscore');

class ClientManager
{
	static clientManager = null;
    constructor()
    {
		this.clients= new Map();
		this.addNewClientAndReturnOriginUid=null;
		this.onClientPostCreate=null;
		this.geometryIntervalId=0;
		console.log("Start Unix Time us: "+core.getStartTimeUnixUs()+"\n");
		//console.log("From Date: "+Date.now()*1000+"\n");
    }
	
	StartStreaming(){
		this.geometryIntervalId = setInterval(_.bind( function() {
			console.log("Streaming Update at "+core.getTimestampUs()/1000000.0);
			this.UpdateStreaming();
		  },this), 5000);
	}
	StopStreaming(){
		if(this.geometryIntervalId!=0)
			clearInterval(this.geometryIntervalId);
	}
	UpdateStreaming(){
		for (let [cl_id,cl] of this.clients) {
			cl.UpdateStreaming();
		}
	}
    GetOrCreateClient(clientID)
    {
        if(!this.clients.has(clientID))
        {
			if(this.addNewClientAndReturnOriginUid==null){
				error("No callback has been set to create the client origin.");
				return null;
			}
			var origin_uid=this.addNewClientAndReturnOriginUid(clientID);
			if(origin_uid==0){
				error("Failed to create a root node for client "+clientID);
				return null;
			}
			var sigCli=signaling.signalingClients[clientID];
			var sigSend=sigCli.sendToClient.bind(sigCli);
			var c=new client.Client(clientID,sigSend);
			c.origin_uid=origin_uid;
			if(this.clients.size==0)
				this.StartStreaming();
            this.clients.set(clientID,c);
			if(this.onClientPostCreate!=null)
				this.onClientPostCreate(clientID);
			return c;
        }
        var c=this.clients.get(clientID);
        return c;
    }
	RemoveClient(clientID){
        if(this.clients.has(clientID)) {
			this.clients.delete(clientID);
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
	SetNewClientCallback(cb)
	{
		this.addNewClientAndReturnOriginUid=cb;
	}
	SetClientPostCreationCallback(cb)
	{
		this.onClientPostCreate=cb;
	}
	// This is a callback, signaling service calls this when the client has signalled.
	newClient(clientID,signalingClient) {
		// then we tell the client manager to start this client.
		var c=this.GetOrCreateClient(clientID);
		signalingClient.receiveReliableBinaryMessage=c.receiveReliableBinaryMessage.bind(c);
		//c.SetScene(this.scene);
		c.Start();
		return c;
	}
}

exports.getInstance=()=>
{
	if(ClientManager.clientManager==null)
		ClientManager.clientManager = new ClientManager();
	return ClientManager.clientManager;
}
exports.ClientManager=ClientManager;
