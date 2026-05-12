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


// Maximum number of times an unacknowledged origin/lighting command will be
// resent before we give up and log a disconnect. With a 3s ack timeout this
// gives roughly MAX_ACK_RESENDS*3 seconds before we stop trying.
const MAX_ACK_RESENDS = 5;

class OriginState
{
    constructor() {
		this.sent=false;
		this.originClientHas=BigInt(0);
		this.ackId=0;
		this.acknowledged=false;
		this.serverTimeSentUs=BigInt(0);
		this.valid_counter=BigInt(0);
		this.resendCount=0;
		this.givenUp=false;
	}
};

class LightingState
{
    constructor() {
		this.ackId=0;
		this.acknowledged=false;
		this.serverTimeSentUs=BigInt(0);
		this.clientDynamicLighting=new core.ClientDynamicLighting();
		this.resendCount=0;
		this.givenUp=false;
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
		this.clientStartMs=Date.now();
		this.webRtcConnectedAtMs=0;
    }
	elapsedMsSinceStart(){
		return Date.now()-this.clientStartMs;
	}
	elapsedMsSinceConnected(){
		return this.webRtcConnectedAtMs?Date.now()-this.webRtcConnectedAtMs:-1;
	}
	tick(timestamp){
		this.geometryService.GetNodesToSend();
	}
    streamingConnectionStateChanged(newState)
    {
        //this.webRtcConnection=wrtcConn;
		// This should have come from our own existing webRtcConnection and nowhere else.
        console.log("[T+"+this.elapsedMsSinceStart()+"ms] Connection state is "+newState.toString());
		if(newState=="connected")
		{
       		//this.webRtcConnection.sendGeometry("test");
			this.webRtcConnected=true;
			this.webRtcConnectedAtMs=Date.now();
			console.log("[T+"+this.elapsedMsSinceStart()+"ms] WebRTC CONNECTED for client "+this.clientID+" — triggering immediate UpdateStreaming tick.");
			// Kick an immediate tick so SetOriginNode and the first resource batch are
			// sent without waiting for the next periodic interval (up to 1000 ms away).
			setImmediate(this.UpdateStreaming.bind(this));
		}
		else
		{
			this.webRtcConnected=false;
		}
    }
	receivedMessageReliable(id,pkt)
	{
        var dataView=new DataView(pkt.data,0,1);
        const messageType=dataView.getUint8(0);
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
				console.log('Client receivedMessageReliable ch.'+id+' unknown messageType '+messageType+'.');
                break;
        }
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
		this.clientStartMs=Date.now();
		console.log("[T+0ms] Client.Start() — sending SetupCommand for client "+this.clientID);
        this.setupCommand=new command.SetupCommand();
        this.clientDynamicLighting=new core.ClientDynamicLighting();
		// Session is (re)starting; the client has zero state, so retract any
		// outstanding ack tracking from a previous session and force a resend.
		// Clear acknowledgement state but preserve the origin uid that was already set.
		this.currentOriginState.acknowledged = false;
		this.currentOriginState.serverTimeSentUs = BigInt(0);
		this.currentOriginState.ackId = 0;
		this.currentOriginState.resendCount = 0;
		this.currentOriginState.givenUp = false;
		this.currentLightingState = new LightingState();
		this.setupCommand.float32_draw_distance=10.0;
		// The C++ client uses startTimestamp_utc_unix_us as the session epoch
		// against which subsequent message timestamps are measured. Without it
		// some message handlers will not progress.
		this.setupCommand.int64_startTimestamp_utc_unix_us = BigInt(core.getStartTimeUnixUs());
		if(this.scene)
		{
			if(this.scene.backgroundTexturePath&&this.scene.backgroundTexturePath!="")
			{
				this.setupCommand.BackgroundMode_backgroundMode=BackgroundMode.TEXTURE;
				this.setupCommand.uid_backgroundTexture=resources.GetOrAddTexture(this.scene.backgroundTexturePath);
			}
			if(this.scene.diffuseCubemapPath&&this.scene.diffuseCubemapPath!="")
			{
				this.clientDynamicLighting.uid_diffuse_cubemap_texture_uid=resources.GetOrAddTexture(this.scene.diffuseCubemapPath);
			}
			if(this.scene.specularCubemapPath&&this.scene.specularCubemapPath!="")
			{
				this.clientDynamicLighting.uid_specular_cubemap_texture_uid=resources.GetOrAddTexture(this.scene.specularCubemapPath);
			}
		}

		// Log the setup command for debugging - in the CORRECT C++ struct byte order
		console.log("\n===== NODE SERVER SENDING SETUPCOMMAND =====");
		const logObj = {
			CommandPayloadType: this.setupCommand.CommandPayloadType_commandPayloadType,
			debug_stream: this.setupCommand.uint32_debug_stream,
			debug_network_packets: this.setupCommand.uint32_debug_network_packets,
			requiredLatencyMs: this.setupCommand.int32_requiredLatencyMs,
			idle_connection_timeout: this.setupCommand.uint32_idle_connection_timeout,
			session_id: this.setupCommand.uint64_session_id,
			video_config: this.setupCommand.VideoConfig_video_config,
			draw_distance: this.setupCommand.float32_draw_distance,
			axesStandard: this.setupCommand.AxesStandard_axesStandard,
			audio_input_enabled: this.setupCommand.uint8_audio_input_enabled,
			using_ssl: this.setupCommand.bool_using_ssl,
			startTimestamp_utc_unix_us: this.setupCommand.int64_startTimestamp_utc_unix_us,
			backgroundMode: this.setupCommand.BackgroundMode_backgroundMode,
			backgroundColour: this.setupCommand.vec4_backgroundColour,
			backgroundTexture: this.setupCommand.uid_backgroundTexture
		};
		console.log(JSON.stringify(logObj, (key, value) => {
			if (typeof value === 'bigint') {
				return value.toString();
			}
			return value;
		}, 2));
		console.log("===== END SETUPCOMMAND =====\n");

        this.SendCommand(this.setupCommand);
    }
    SendCommand(command){
        let array=core.encodeToUint8Array(command);
        console.log("SendCommand: encoded to", array.length, "bytes, expected", command.size(), "bytes");
        // Once the WebRTC reliable data channel is open, route commands through it
        // (matches the C++ server's sendCommand path). Bootstrap commands sent
        // before the channel is open (SetupCommand, AcknowledgeHandshakeCommand)
        // fall back to the signaling WebSocket.
        if(this.webRtcConnection && this.webRtcConnection.isReliableOpen())
            this.webRtcConnection.sendReliable(array);
        else
            this.signalingSend(array);
    }
    // We call StartStreaming once the SetupCommand has been acknowledged.
    StartStreaming()
    {
		console.log("[T+"+this.elapsedMsSinceStart()+"ms] Client.StartStreaming() — creating WebRTC connection for client "+this.clientID);
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
		// data arrives from the WebSocket signaling channel as a Node Buffer (Uint8Array view over a pooled
		// ArrayBuffer), so we must wrap its underlying buffer using byteOffset/byteLength rather than passing
		// the Buffer directly to DataView.
		var dataView		=new DataView(data.buffer,data.byteOffset,data.byteLength);
		core.decodeFromDataView(msg,dataView,0);
		if(msg.uint64_ackId==this.currentOriginState.ackId)
		{
			this.currentOriginState.acknowledged=true;
			this.currentOriginState.resendCount=0;
		}
		if(msg.uint64_ackId==this.currentLightingState.ackId)
		{
			this.currentLightingState.acknowledged=true;
			this.currentLightingState.resendCount=0;
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
		//console.log("Client: ProcessNodePoses ", numPoses, " poses.");
	}
	UpdateStreaming()
	{
		if(!this.scene)
			return;
		if(!this.webRtcConnected)
			return;
		console.log("[T+"+this.elapsedMsSinceStart()+"ms, conn+"+this.elapsedMsSinceConnected()+"ms] UpdateStreaming tick for client "+this.clientID);
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
		if(!this.currentOriginState.acknowledged && !this.currentOriginState.givenUp)
			this.SendOrigin();
		if(!this.currentLightingState.acknowledged && !this.currentLightingState.givenUp)
			this.SendLighting();
	}
	SendOrigin()
	{
		let time_now_us=core.getTimestampUs();
		let originAckWaitTimeUs=BigInt(3000000);// three seconds
		if(this.setupCommand.int64_startTimestamp_utc_unix_us==BigInt(0))
		{
			console.log("Start timestamp is not set, so not sending origin.");
			return ;
		}
		// If we sent it, and  haven't timed out waiting for ack...
		if(this.currentOriginState.serverTimeSentUs!=BigInt(0)
			&&(time_now_us-this.currentOriginState.serverTimeSentUs)<originAckWaitTimeUs)
		{
			console.log("Waiting for acknowledgement of SetOriginNodeCommand with origin uid "+this.currentOriginState.originClientHas+" and ackId "+this.currentOriginState.ackId+". Time since sent: "+(time_now_us-this.currentOriginState.serverTimeSentUs)+" us.");
			return;
		}
		if (!this.webRtcConnection)
		{
			console.log("WebRTC connection is not established, so not sending origin.");
			return;
		}
		if(this.currentOriginState.originClientHas==BigInt(0))
		{
			console.log("Origin client has is 0, so not sending origin.");
			return;
		}
		// A previous send timed out without an ack. Bound the resend loop so
		// we don't spam the client forever if it never acknowledges.
		if(this.currentOriginState.serverTimeSentUs!=BigInt(0))
		{
			this.currentOriginState.resendCount++;
			if(this.currentOriginState.resendCount>MAX_ACK_RESENDS)
			{
				console.log("Client "+this.clientID+": gave up resending SetOriginNodeCommand after "+this.currentOriginState.resendCount+" attempts; treating client as disconnected for origin.");
				this.currentOriginState.givenUp=true;
				return;
			}
		}
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
		console.log("\n===== NODE SERVER SENDING SETORIGINCOMMAND =====");
		console.log("[T+"+this.elapsedMsSinceStart()+"ms, conn+"+this.elapsedMsSinceConnected()+"ms] Sending SetOriginNodeCommand with origin uid "+setp.uint64_originNodeUid+" and ackId "+setp.uint64_ackId);
		console.log("\n===== END SETORIGINCOMMAND =====");
		this.SendCommand(setp);
	}
	SendLighting()
	{
		let time_now_us=core.getTimestampUs();
		let ackWaitTimeUs=BigInt(3000000);// three seconds
		if(this.setupCommand.int64_startTimestamp_utc_unix_us==BigInt(0))
		{
			console.log("Start timestamp is not set, so not sending lighting.");
			return;
		}
		// If we sent it, and  haven't timed out waiting for ack...
		if(this.currentLightingState.serverTimeSentUs!=BigInt(0)
			&&(time_now_us-this.currentLightingState.serverTimeSentUs)<ackWaitTimeUs)
		{
			console.log("Waiting for acknowledgement of SetLightingCommand with ackId "+this.currentLightingState.ackId+". Time since sent: "+(time_now_us-this.currentLightingState.serverTimeSentUs)+" us.");
			return;
		}
		if (!this.webRtcConnection)
		{
			console.log("WebRTC connection is not established, so not sending lighting.");
			return;
		}
		// A previous send timed out without an ack. Bound the resend loop so
		// we don't spam the client forever if it never acknowledges.
		if(this.currentLightingState.serverTimeSentUs!=BigInt(0))
		{
			this.currentLightingState.resendCount++;
			if(this.currentLightingState.resendCount>MAX_ACK_RESENDS)
			{
				console.log("Client "+this.clientID+": gave up resending SetLightingCommand after "+this.currentLightingState.resendCount+" attempts; treating client as disconnected for lighting.");
				this.currentLightingState.givenUp=true;
				return;
			}
		}

		var setl					=new command.SetLightingCommand();
		setl.uint64_ackId			=this.next_ack_id++;
		setl.ClientDynamicLighting_clientDynamicLighting = this.clientDynamicLighting;

		// Log in declaration order matching ClientDynamicLighting / SetLightingCommand structs.
		const cdl = setl.ClientDynamicLighting_clientDynamicLighting;
		console.log("\n===== NODE SERVER SENDING SETLIGHTINGCOMMAND =====");
		console.log(JSON.stringify({
			ack_id: setl.uint64_ackId.toString(),
			specularPos:                  cdl.int2_specularPos,
			specularCubemapSize:          cdl.int32_specularCubemapSize,
			specularMips:                 cdl.int32_specularMips,
			diffusePos:                   cdl.int2_diffusePos,
			diffuseCubemapSize:           cdl.int32_diffuseCubemapSize,
			lightPos:                     cdl.int2_lightPos,
			lightCubemapSize:             cdl.int32_lightCubemapSize,
			specular_cubemap_texture_uid: cdl.uid_specular_cubemap_texture_uid.toString(),
			diffuse_cubemap_texture_uid:  cdl.uid_diffuse_cubemap_texture_uid.toString(),
			lightingMode:                 cdl.LightingMode_lightingMode,
		}, null, 2));
		console.log("===== END SETLIGHTINGCOMMAND =====\n");

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
			// Wrap the Node Buffer correctly: use its underlying ArrayBuffer together with
			// byteOffset (Buffers may share a pooled ArrayBuffer, so offset 0 is wrong).
			var dataView	=new DataView(data.buffer, data.byteOffset, data.byteLength);
			var offset		=message.HandshakeMessage.sizeof();
			for(let i=0;i<handshakeMessage.uint64_resourceCount;i++ ) {
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
