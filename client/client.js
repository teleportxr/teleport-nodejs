'use strict';

const core= require("../core/core.js");
const command= require("../protocol/command.js");
const message= require("../protocol/message.js");
const gs= require("./geometry_service.js");
const node_encoder= require("../protocol/encoders/node_encoder.js");
const resource_encoder= require("../protocol/encoders/resource_encoder.js");
const WebRtcConnectionManager = require('../connections/webrtcconnectionmanager');
const resources= require("../scene/resources.js");
const { BackgroundMode } = require("../core/core.js");


class OriginState
{
    constructor() {
		this.sent=false;
		this.originClientHas=BigInt(0);
		this.ackId=0;
		this.acknowledged=false;
		this.serverTimeSentUs=BigInt(0);
		this.valid_counter=BigInt(0);
	}
};

class LightingState
{
    constructor() {
		this.ackId=0;
		this.acknowledged=false;
		this.serverTimeSentUs=BigInt(0);
		this.clientDynamicLighting=new core.ClientDynamicLighting();
	}
};

class Client {
    constructor(cid,sigSend) {
		this.signalingSend=sigSend;
        this.clientID=cid;
        this.origin_uid=0;
        this.handshakeMessage=new message.HandshakeMessage();
		this.geometryService=new gs.GeometryService(cid);
		this.webRtcConnected=false;
		this.webRtcConnection=null;
		this.currentOriginState=new OriginState();
		this.currentLightingState=new LightingState();
		this.next_ack_id=BigInt(1);
    }
	tick(timestamp){
		this.geometryService.GetNodesToSend();
	}
    streamingConnectionStateChanged(newState)
    {
        //this.webRtcConnection=wrtcConn;
		// This should have come from our own existing webRtcConnection and nowhere else.
        console.log("Connection state is "+newState.toString());
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
		console.log('Client receivedMessage reliable ch.'+id+' received: '+data+'.');
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
		core.decodeFromDataView(msg,dataView,0);
        const excess		=uia.length-message.ReceivedResourcesMessage.sizeof();
        const numReceived	=excess/core.UID_SIZE;
        if(numReceived!=msg.uint64_receivedResourcesCount) {
            console.log("ReceivedResourcesMessage claims to have "<<msg.resourceCount<<" resources but has only enough data for "+numReceived);
            return;
        }
        var offset			=message.ReceivedResourcesMessage.sizeof();
        for(let i=0;i<msg.uint64_receivedResourcesCount;i++ ) {
            var uid=dataView.getBigUint64(offset,core.endian);
            this.geometryService.ConfirmResource(uid);
            offset+=core.UID_SIZE;
        }
	}
	receivedMessageUnreliable(id,pkt)
	{
        var dataView=new DataView(pkt.data,0,1);
        const messageType=dataView.getUint8(0);
		//console.log('Client receivedMessage reliable ch.'+id+' received: '+messageType+'.');
        switch(messageType){
            case message.MessagePayloadType.ReceivedResources:
                this.receiveReceivedResourcesMessage(pkt.data);
                return;
			case message.MessagePayloadType.Acknowledgement:
				this.ReceiveAcknowledgement(pkt.data);
				return;
			case message.MessagePayloadType.ControllerPoses:
				this.ReceiveNodePoses(pkt.data);
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
        this.clientDynamicLighting=new core.ClientDynamicLighting();
		this.setupCommand.float32_draw_distance=10.0;
		if(this.scene)
		{
			if(this.scene.backgroundTexturePath&&this.scene.backgroundTexturePath!="")
			{
				this.setupCommand.BackgroundMode_backgroundMode=BackgroundMode.TEXTURE;
				this.setupCommand.uid_backgroundTexture=resources.AddTexture(this.scene.backgroundTexturePath);
			}
			if(this.scene.diffuseCubemapPath&&this.scene.diffuseCubemapPath!="")
			{
				this.clientDynamicLighting.uid_diffuse_cubemap_texture_uid=resources.AddTexture(this.scene.diffuseCubemapPath);
			}
			if(this.scene.specularCubemapPath&&this.scene.specularCubemapPath!="")
			{
				this.clientDynamicLighting.uid_specular_cubemap_texture_uid=resources.AddTexture(this.scene.specularCubemapPath);
			}
		}
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
  		this.webRtcConnection = this.webRtcConnectionManager.createConnection(
										this.clientID
										,this.streamingConnectionStateChanged.bind(this)
										,this.receivedMessageReliable.bind(this)
										,this.receivedMessageUnreliable.bind(this));
		//.then(
		//	function(value) {myDisplayer(value);},
		//	function(error) {myDisplayer(error);}
    }
	//! Cleanly shut down the WebRTC connection. This may be called when the client has signalled that it is
	//! disconnecting, or when the server determines that the client is lost or needs to be booted.
	StopStreaming()
	{
		this.webRtcConnectionManager.destroyConnection(this.clientID);
		this.webRtcConnection=null;
	}
	// Generic message acknowledgement. Certain kinds of message are expected to be ack'ed.
	ReceiveAcknowledgement(data)
	{
		if (data.byteLength!=message.AcknowledgementMessage.sizeof())
		{
			console.log("Client: Received malformed AcknowledgementMessage packet of length: ",data.length);
			return;
		}
        var msg				=new message.AcknowledgementMessage();
		var bf				=data;
		var dataView		=new DataView(data,0,data.length);
		core.decodeFromDataView(msg,dataView,0);
		if(msg.uint64_ackId==this.currentOriginState.ackId)
		{
			this.currentOriginState.acknowledged=true;
		}
		if(msg.uint64_ackId==this.currentLightingState.ackId)
		{
			this.currentLightingState.acknowledged=true;
		}
	}
	ReceiveNodePoses(data)
	{
		if (data.byteLength<message.NodePosesMessage.sizeof())
		{
			console.log("Client: Received malformed NodePosesMessage packet of length: ",data.length);
			return;
		}
        var msg			=new message.NodePosesMessage();
		var dataView	=new DataView(data,0,data.byteLength);
		var byteOffset	=0;
		msg.messageType = dataView.getUint8(byteOffset, core.endian);
		msg.timestamp = dataView.getBigUint64(byteOffset+1, core.endian);
		byteOffset		=msg.Pose_headPose.decodeOrientationPositionFromDataView(dataView, byteOffset+9);
		msg.uint16_numPoses = dataView.getUint16(byteOffset, core.endian);
		byteOffset+=2;
		if (data.byteLength!=message.NodePosesMessage.sizeof()+msg.uint16_numPoses*28)
		{
			console.log("Client: Received malformed NodePosesMessage packet of length: ",data.length);
			return;
		}
		msg.nodePoses = new Array(msg.uint16_numPoses);
		for(let i=0; i <msg.uint16_numPoses; i++)
		{
			msg.nodePoses[i] = new NodePoseDynamic();
			byteOffset = msg.nodePoses[i].decodeOrientationPositionFromDataView(dataView,byteOffset);
		}
		//console.log("Client: Received ", msg.uint16_numPoses, " node poses.");
		this.ProcessNodePoses(msg.Pose_headPose,msg.uint16_numPoses, msg.nodePoses);
	}
	ProcessNodePoses(headPose,numPoses,nodePoses)
	{
		console.log("Client: ProcessNodePoses ", numPoses, " poses.");
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
		var nodes_to_stream_now_uids=this.geometryService.GetNodesToSend();
		for (const uid of nodes_to_stream_now_uids)
		{
			this.SendNode(uid);
		}
		var mesh_uids=this.geometryService.GetMeshesToSend();
		for (const uid of mesh_uids)
		{
			this.SendMesh(uid);
		}
		var canvases_to_send_now_uids=this.geometryService.GetCanvasesToSend();
		for (const uid of canvases_to_send_now_uids)
		{
			this.SendCanvas(uid);
		}
		var font_atlases_to_send_now_uids=this.geometryService.GetFontAtlasesToSend();
		for (const uid of font_atlases_to_send_now_uids)
		{
			this.SendFontAtlas(uid);
		}
		var textures_to_send_now_uids=this.geometryService.GetTexturesToSend();
		for (const uid of textures_to_send_now_uids)
		{
			this.SendTexture(uid);
		}
		if(!this.currentOriginState.acknowledged)
			this.SendOrigin();
		if(!this.currentLightingState.acknowledged)
			this.SendLighting();
	}
	SendOrigin()
	{
		let time_now_us=core.getTimestampUs();
		let originAckWaitTimeUs=BigInt(3000000);// three seconds
		if(this.setupCommand.startTimestamp_utc_unix_us==0)
			return ;
		// If we sent it, and  haven't timed out waiting for ack...
		if(this.currentOriginState.serverTimeSentUs!=BigInt(0)
			&&(time_now_us-this.currentOriginState.serverTimeSentUs)<originAckWaitTimeUs)
		{
			return;
		}
		if (!this.webRtcConnection)
		{
			return;
		}
		if(this.currentOriginState.originClientHas==BigInt(0))
			return;
		this.currentOriginState.valid_counter++;
		this.geometryService.SetOriginNode(this.currentOriginState.originClientHas);
		var setp=new command.SetOriginNodeCommand();
		setp.uint64_ackId=this.next_ack_id++;
		setp.uint64_originNodeUid=this.currentOriginState.originClientHas;
		setp.uint64_validCounter = this.currentOriginState.valid_counter;
		
		// This is now the valid origin.
		this.currentOriginState.sent=true;
		this.currentOriginState.ackId=setp.uint64_ackId;
		this.currentOriginState.acknowledged=false;
		this.currentOriginState.serverTimeSentUs=core.getTimestampUs();
		this.SendCommand(setp);
	}
	SendLighting()
	{
		let time_now_us=core.getTimestampUs();
		let ackWaitTimeUs=BigInt(3000000);// three seconds
		if(this.setupCommand.startTimestamp_utc_unix_us==0)
			return;
		// If we sent it, and  haven't timed out waiting for ack...
		if(this.currentLightingState.serverTimeSentUs!=BigInt(0)
			&&(time_now_us-this.currentLightingState.serverTimeSentUs)<ackWaitTimeUs)
		{
			return;
		}
		if (!this.webRtcConnection)
		{
			return;
		}

		var setl					=new command.SetLightingCommand();
		setl.uint64_ackId			=this.next_ack_id++;
		setl.ClientDynamicLighting_clientDynamicLighting = this.clientDynamicLighting;
		
		// This is now the valid origin.
		this.currentLightingState.ackId=setl.uint64_ackId;
		this.currentLightingState.acknowledged=false;
		this.currentLightingState.serverTimeSentUs=core.getTimestampUs();
		this.SendCommand(setl);
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
		if(!this.webRtcConnection)
		{
			console.error("this.webRtcConnection is null");
			return;
		}
		if(!this.webRtcConnection.sendGeometry)
		{
			console.error("this.webRtcConnection.sendGeometry is null");
			console.log(JSON.stringify(this.webRtcConnection));
			return;
		}
		this.webRtcConnection.sendGeometry(view2);
	}
	SendGenericResource(uid)
	{
		var resource=resources.GetResourceFromUid(uid);
		if(!resource)
		{
			console.warn("No resource of uid ",uid," was found.")
			return;
		}
		const MAX_BUFFER_SIZE=resource.encodedSize();;
		const buffer = new ArrayBuffer(MAX_BUFFER_SIZE);
		const resourceSize=resource_encoder.EncodeResource(resource,buffer);
		this.geometryService.EncodedResource(uid);
		const view2 = new DataView(buffer, 0, resourceSize); 
		console.log("Sending resource "+uid+" "+resource.url+" to Client "+this.clientID+", size: "+resourceSize+" bytes");
		this.webRtcConnection.sendGeometry(view2);
	}
	SendMesh(uid)
	{
		this.SendGenericResource(uid);
	}
	SendTexture(uid)
	{
		this.SendGenericResource(uid);
	}
	SendCanvas(uid)
	{
		this.SendGenericResource(uid);
	}
	SendFontAtlas(uid)
	{
		this.SendGenericResource(uid);
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
				var uid=dataView.getBigUint64(offset,core.endian);
				this.geometryService.ConfirmResource(uid);
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
			case message.MessagePayloadType.Acknowledgement:
				this.ReceiveAcknowledgement(data);
				return;
            default:
                break;
        }
    }
	SetScene(sc){
		this.scene=sc;
		this.geometryService.SetScene(sc);
	}
	setOrigin(origin_node_uid)
	{
		if(origin_node_uid==0)
			return;
		if(this.currentOriginState.originClientHas==origin_node_uid)
			return;
		// It's a different origin. So we reset the time sent.
		this.currentOriginState.serverTimeSentUs=BigInt(0);
		this.currentOriginState.originClientHas=origin_node_uid;
	}
}

module.exports = { Client };
