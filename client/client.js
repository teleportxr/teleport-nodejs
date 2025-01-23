'use strict';

const core= require("../protocol/core");
const command= require("../protocol/command.js");
const message= require("../protocol/message.js");
const gs= require("./geometry_service.js");
const node_encoder= require("../protocol/encoders/node_encoder.js");
const WebRtcConnectionManager = require('../connections/webrtcconnectionmanager');

class Client {
    constructor(cid,sigSend) {
		this.signalingSend=sigSend;
        this.clientID=cid;
        this.origin_uid=0;
        this.handshakeMessage=new message.HandshakeMessage();
		this.geometryService=new gs.GeometryService(cid);
		this.webRtcConnected=false;
		this.webRtcConnection=null;
    }
	tick(timestamp){
		this.geometryService.GetNodesToStream();
	}
    streamingConnectionStateChanged(wrtcConn,newState)
    {
        //this.webRtcConnection=wrtcConn;
		// This should have come from our own existing webRtcConnection and nowhere else.
        console.warn("Connection state is "+newState.toString());
		if(newState=="connected")
		{
       		//this.webRtcConnection.sendGeometry("test");
			this.webRtcConnected=true;
		}
		else
		{
			this.webRtcConnected=false;
		}
    }
	receivedMessageReliable(id,data)
	{
		console.log('Client receivedMessage unreliable ch.'+id+' received: '+data+'.');
	}
	// Is the Buffer bf too small to contain a type tp?
	checkTooSmall(tp,bf) {
        if(bf.byteLength<tp.sizeof()) {
            // NOTE: we use log() here rather than warn() or error() because this is a problem with
            // the message we were SENT, not with the local server code.
            console.log("Binary message from "+this.clientID+" is too small to be a "+tp.toString()+": "+bf.byteLength+"<"+tp.sizeof());
            return false;
        }
		return true;
	}
	receiveReceivedResourcesMessage(bf)
	{
        if(!this.checkTooSmall(message.ReceivedResourcesMessage,bf)) {
             return;
        }
        var msg				=new message.ReceivedResourcesMessage();
		var uia				=new Uint8Array(bf);
		var dataView		=new DataView(bf,0,bf.length);
		core.decodeFromDataView(msg,dataView);
        const excess		=uia.length-message.ReceivedResourcesMessage.sizeof();
        const numReceived	=excess/core.UID_SIZE;
        if(numReceived!=msg.uint64_receivedResourcesCount) {
            console.log("ReceivedResourcesMessage claims to have "<<msg.resourceCount<<" resources but has only enough data for "+numReceived);
            return;
        }
        var offset			=message.NodeStatusMessage.sizeof();
        var dataView		=new DataView(data.buffer,offset,data.offset,data.length);
        for(let i=0;i<msg.resourceCount;i++ ) {
            var uid=dataView.getBigUint64(offset);
            this.geometryService.confirmResource(uid);
            offset+=core.UID_SIZE;
        }
	}
	receivedMessageUnreliable(id,pkt)
	{
		console.log('Client receivedMessage reliable ch.'+id+' received: '+pkt+'.');

        var dataView=new DataView(pkt.data,0,1);
        const messageType=dataView.getUint8(0);
        switch(messageType){
            case message.MessagePayloadType.ReceivedResources:
                this.receiveReceivedResourcesMessage(pkt.data);
                return;
            default:
                break;
        }
	}
    // We call Start() when the signaling server accepts the client.
    // In Start() we send the SetupCommand.
    Start()
    {
        this.setupCommand=new command.SetupCommand();
        this.SendCommand(this.setupCommand);
    }
    SendCommand(command){
        let array=core.encodeToUint8Array(command);
        this.signalingSend(array);
    }
    // We call StartStreaming once the SetupCommand has been acknowledged.
    StartStreaming()
    {
		this.webRtcConnectionManager=WebRtcConnectionManager.getInstance();
        // We make sure WebRTC has a connection for this client.
  		this.webRtcConnection = this. webRtcConnectionManager.createConnection(
										this.clientID
										,this.streamingConnectionStateChanged.bind(this)
										,this.receivedMessageReliable.bind(this)
										,this.receivedMessageUnreliable.bind(this));
		//.then(
		//	function(value) {myDisplayer(value);},
		//	function(error) {myDisplayer(error);}
    }
	UpdateStreaming()
	{
		if(!this.scene)
			return;
		if(!this.webRtcConnected)
			return;
		var timestamp=core.getTimestampUs();
		// Establish which nodes the client should have, and their resources.
		// Then: which resources we think it does not yet have. Send those.
		var node_uids=this.scene.GetAllNodeUids();
		for (let uid of node_uids)
		{
			this.geometryService.StreamNode(uid);
		}
		var nodes_to_stream_now_uids=this.geometryService.GetNodesToStream();
		for (const [uid, count] of nodes_to_stream_now_uids)
		{
			this.SendNode(uid);
			//gs.GeometryService.trackedResources[uid].Sent(this.clientID,timestamp);
		}
	}
	SendNode(uid)
	{
		var node=this.scene.GetNode(uid);
		const MAX_NODE_SIZE=500;
		const buffer = new ArrayBuffer(MAX_NODE_SIZE);
		const nodeSize=node_encoder.encodeNode(node,buffer);
		this.geometryService.EncodedResource(uid);
		const view2 = new DataView(buffer, 0, nodeSize); 
		console.log("Sending node "+uid+" "+node.name+" to Client "+this.clientID+", size: "+nodeSize+" bytes");
		this.webRtcConnection.sendGeometry(view2);
	}
    receiveHandshake(data)
    {
        if(data.length<message.HandshakeMessage.sizeof()) {
            // NOTE: we use log() here rather than warn() or error() because this is a problem with
            // the message we were SENT, not with the local server code.
            console.log("Binary message from "+this.clientID+" is too small to be a Handshake: "+data.length+"<"+message.HandshakeMessage.sizeof());
            return;
        }
        var handshakeMessage=new message.HandshakeMessage();
		core.decodeFromUint8Array(handshakeMessage,data);
        const excess		=data.length-message.HandshakeMessage.sizeof();
        const numReceived	=excess/core.UID_SIZE;
        if(numReceived!=handshakeMessage.uint64_resourceCount) {
            console.log("Handshake claims to have "<<handshakeMessage.uint64_resourceCount<<" resources but has only enough data for "+numReceived);
        }
		else {
			var offset		=message.HandshakeMessage.sizeof();
			var dataView	=new DataView(data.buffer,offset,data.offset,data.length);
			for(let i=0;i<this.handshakeMessage.resourceCount;i++ ) {
				var uid=dataView.getBigUint64(offset);
				this.geometryService.confirmResource(uid);
				offset+=core.UID_SIZE;
			}
		}
        var acknowledgeHandshakeCommand=new command.AcknowledgeHandshakeCommand;
        this.SendCommand(acknowledgeHandshakeCommand);
		// And now, setup is complete. On the next geometry update, we can send nodes/resources.
		this.StartStreaming();
    }
    receiveReliableBinaryMessage(data){
        const messageType=data[0];
        switch(messageType){
            case message.MessagePayloadType.Handshake:
                this.receiveHandshake(data);
                return;
            default:
                break;
        }
    }
	SetScene(sc){
		this.scene=sc;
		this.geometryService.SetScene(sc);
	}
}

module.exports = { Client };
