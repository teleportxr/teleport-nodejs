'use strict';
const client=require("./client.js");
const signaling=require("../signaling.js");

class ClientManager
{
	static clientManager = null;
    constructor()
    {
		this.clients= new Map();
		this.addNewClientAndReturnOriginUid=null;
		var c=new client.Client(13513,null);
    }
	
    GetOrCreateClient(clientID)
    {
        if(!this.clients.has(clientID))
        {
			var origin_uid=this.addNewClientAndReturnOriginUid(clientID);
			if(origin_uid==BigInt(0)){
				error("Failed to create a root node for client "+clientID);
				return null;
			}
			var sigCli=signaling.signalingClients[clientID];
			var sigSend=sigCli.sendToClient.bind(sigCli);
			var c=new client.Client(clientID,sigSend);
			c.origin_uid=origin_uid;
            this.clients.set(clientID,c);
			return c;
        }
        var c=this.clients.get(clientID);
        return c;
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
	// This is a callback, signaling service calls this when the client has signalled.
	newClient(clientID,signalingClient) {
		// then we tell the client manager to start this client.
		var c=this.GetOrCreateClient(clientID);
		signalingClient.receiveReliableBinaryMessage=c.receiveReliableBinaryMessage.bind(c);
		//client.setWebRTCConnection(c);
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
