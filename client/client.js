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
    }
	tick(timestamp){
		this.geometryService.GetNodesToStream();
	}
    webRtcConnection=null;
    streamingConnectionStateChanged(wrtcConn,newState)
    {
        this.webRtcConnection=wrtcConn;
        console.warn("Connection state is "+newState.toString());
		if(newState=="connected")
		{
       		//this.webRtcConnection.sendGeometry("test");
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
  		this.webRtcConnection = this.webRtcConnectionManager.createConnection(this.clientID,this.streamingConnectionStateChanged);
    }
	UpdateStreaming()
	{
		if(!this.scene)
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
		for (let uid of nodes_to_stream_now_uids)
		{
			this.SendNode(uid);
			GeometryService.trackedResources[uid].Sent(this.clientID,timestamp);
		}
	}
	SendNode(uid)
	{
		var node=this.scene.GetNode(uid);
		const MAX_NODE_SIZE=500;
		const buffer = new ArrayBuffer(MAX_NODE_SIZE);
		const nodeSize=node_encoder.encodeNode(node,buffer);
		geometryStreamingService.encodedResource(uid);
		const view2 = new DataView(buffer, 0, nodeSize); 
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
        const excess=data.length-message.HandshakeMessage.sizeof();
        const numReceived=excess/core.UID_SIZE;
        if(numReceived!=handshakeMessage.uint64_resourceCount){
            console.log("Handshake claims to have "<<handshakeMessage.resourceCount<<" resources but has only enough data for "+numReceived);
            return;
        }
        var offset=message.HandshakeMessage.sizeof();
        var dataView=new DataView(data.buffer,offset,data.offset,data.length);
        for(let i=0;i<this.handshakeMessage.resourceCount;i++ ) {
            var uid=dataView.getBigUint64(offset);
            this.geometryService.confirmResource(uid);
            offset+=core.UID_SIZE;
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
