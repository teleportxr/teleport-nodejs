'use strict';
const core= require("./core");
const command= require("./command");

function decodeFromDataView(obj,dataView,byteOffset){
    for (let key of Object.keys(obj)) {
        let first_underscore=key.search('_');
        var name=key.substring(first_underscore+1,key.end);
        var type=key.substring(0,first_underscore);
        var [sz,tp]=SizeOfType(type);
        if(tp=="uint8")
        {
            var value=dataView.getUint8(byteOffset);
            Object.entries[key]=value;
        }
        else if(tp=="int8")
        {
            var value=dataView.getInt8(byteOffset);
            Object.entries[key]=value;
        }
        else if(tp=="uint32")
        {
            var value=dataView.getUint32(byteOffset);
            Object.entries[key]=value;
        }
        else if(tp=="int32")
        {
            var value=dataView.getInt32(byteOffset);
            Object.entries[key]=value;
        }
        else if(tp=="float32")
        {
            var value=dataView.getFloat32(byteOffset);
            Object.entries[key]=value;
        }
        else if(tp=="int64")
        {
            var value=dataView.getBigInt64(byteOffset);
            Object.entries[key]=value;
        }
        else if(tp=="uint64")
        {
            var value=dataView.get4BigUint6(byteOffset);
            Object.entries[key]=value;
        }
        else if(tp=="struct")
        {
            sz=decodeFromDataView(value,dataView,byteOffset)-byteOffset;
        }
        byteOffset+=sz;
        console.log(byteOffset+": "+sz+" bytes\t\t"+tp+" "+name+" "+value.toString());
    }
    return byteOffset;
}
//! The payload type, or how to interpret the server's message.
const MessagePayloadType =
{									
	Invalid:0,
    Handshake:1,
    NodeStatus:2,
    ReceivedResources:3,
    ControllerPoses:4,
    ResourceLost:5,		//! Inform the server that client "lost" a previously confirmed resource, e.g. due to some bug or error. Should *rarely* be used.
    InputStates:6,
    InputEvents:7,
    DisplayInfo:8,
    KeyframeRequest:9,
    PongForLatency:10,
    OrthogonalAcknowledgement:11,
    Acknowledgement:12	
};

/// A message sent from client to server: may be sent on a reliable or unreliable channel, including via the signaling protocol.
class Message{
	constructor(){
        this.MessagePayloadType_messagePayloadType=MessagePayloadType.Invalid;
        this.int64_timestamp=BigInt(0);
    }
}

class HandshakeMessage extends Message
{
    constructor(){
        super();
        //   type=1 byte
        this.MessagePayloadType_messagePayloadType=MessagePayloadType.Handshake;
        this.int64_timestamp=BigInt(0);
        this.DisplayInfo_startDisplayInfo = new core.DisplayInfo();
        this.float32_MetresPerUnit = 1.0;
        this.float32_FOV = 90.0;
        this.uint32_udpBufferSize = 0;			// In kilobytes.
        this.uint32_maxBandwidthKpS = 0;		// In kilobytes per second
        this.AxesStandard_axesStandard = core.AxesStandard.NotInitialized;
        this.uint8_framerate = 0;				// In hertz
        this.bool_isVR = true;
        this.uint64_resourceCount = 0;			//Count of resources the client has, which are appended to the handshake.
        this.uint32_maxLightsSupported = 0;
        this.int32_minimumPriority = 0;		// The lowest priority object this client will render, meshes with lower priority need not be sent.
        this.RenderingFeatures_renderingFeatures=new core.RenderingFeatures();
    }
    static sizeof(){
        return 58;
    }
    size(){
        return HandshakeMessage.sizeof();
    }
};

class ReceivedResourcesMessage extends Message
{
    constructor(){
        super();
        //   type=1 byte
        this.MessagePayloadType_messagePayloadType=MessagePayloadType.ReceivedResources;
		// timestamp 8 bytes.
		// count 8 bytes
        this.uint64_receivedResourcesCount=BigInt(0);
		// = 17 + 8 * num resources.
    }
    static sizeof(){
        return 17;
    }
    size(){
        return ReceivedResourcesMessage.sizeof();
    }
};
class AcknowledgementMessage extends Message
{
    constructor(){
        super();
        //   type=1 byte
        this.MessagePayloadType_messagePayloadType=MessagePayloadType.Acknowledgement;
		// timestamp 8 bytes.
		// count 8 bytes
        this.uint64_ackId=BigInt(0);
		// = 17 bytes
    }
    static sizeof(){
        return 17;
    }
    size() {
        return AcknowledgementMessage.sizeof();
    }
};
module.exports= {Message,MessagePayloadType,HandshakeMessage,ReceivedResourcesMessage,AcknowledgementMessage};
