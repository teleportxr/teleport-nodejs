'use strict';
const core= require("../core/core.js");

//! The payload type, or how to interpret the server's message.
const CommandPayloadType =
{									
	Invalid:0,	
	Shutdown:1,
	Setup:2,
	AcknowledgeHandshake:3,
	ReconfigureVideo:4,
	NodeVisibility:5,				
	UpdateNodeMovement:6,			
	UpdateNodeEnabledState:7,		
	SetNodeHighlighted:8,			
	ApplyNodeAnimation:9,			
	UpdateNodeAnimationControlX:10,
	SetNodeAnimationSpeed:11,			
	SetupLighting:12,
	UpdateNodeStructure:13,			
	AssignNodePosePath:14,				
	SetupInputs:15,
	PingForLatency:16,
	AudioSourceMapping:17,
	AudioParticipantStateChange:18,
	SetOriginNode:128
};
class Command{
	constructor(){
        this.CommandPayloadType_commandPayloadType=CommandPayloadType.Invalid;
    }
    size(){
        return 1;
    }
}


class SetupCommand extends Command
{
    constructor(){
        super();
        //   Command=1 byte
        this.CommandPayloadType_commandPayloadType=CommandPayloadType.Setup;
        this.uint32_debug_stream = 0;								    //!< 1+4=5
        this.uint32_debug_network_packets = 0;						    //!< 5+4=9
        this.int32_requiredLatencyMs = 0;							    //!< 9+4=13
        this.uint32_idle_connection_timeout = 5000.0;				    //!< 13+4=17
        this.uint64_session_id = BigInt.asUintN(64, BigInt(0));							    //!< 17+8=25	The server's session id changes when the server session changes.	37 bytes
        this.VideoConfig_video_config=new core.VideoConfig();			    //!< 25+89=114	Video setup structure.
        this.AudioConfig_audio_config=new core.AudioConfig();			    //!< 114+17=131	Audio media-track config.
        this.float32_draw_distance = 0.0;								    //!< 131+4=135	Maximum distance in metres to render locally.
        this.AxesStandard_axesStandard = core.AxesStandard.NotInitialized;	//!< 135+1=136	The axis standard that the server uses.
        this.uint8_audio_input_enabled = 0;							    //!< 136+1=137	Server accepts a microphone media track from the client.
        this.bool_using_ssl = true;									    //!< 137+1=138	Not in use, for later.
        this.int64_startTimestamp_utc_unix_us = BigInt.asUintN(64,  BigInt(0));			    //!< 138+8=146	UTC Unix Timestamp in microseconds when the server session began.
        // TODO: replace this with a background Material, which MAY contain video, texture and/or plain colours.
        this.BackgroundMode_backgroundMode=core.BackgroundMode.COLOUR;   	//!< 146+1=147	Whether the server supplies a background, and of which type.
        this.vec4_backgroundColour=new core.vec4();						    //!< 147+16=163	If the background is of the COLOUR type, which colour to use.
        this.uid_backgroundTexture=BigInt(0);                               //!< 163+8=171
    }
    static sizeof(){
        return 171;
    }
    size(){
        return SetupCommand.sizeof();
    }
};

class AcknowledgeHandshakeCommand extends Command{

    constructor(){
        super();
        //   Command=1 byte
        this.CommandPayloadType_commandPayloadType=CommandPayloadType.AcknowledgeHandshake;
        this.uint64_visibleNodeCount=BigInt(0);
    }
    static sizeof(){
        return 9;
    }
    size(){
        return AcknowledgeHandshakeCommand.sizeof();
    }
};


//! A command that expects an acknowledgement of receipt from the client using an AcknowledgementMessage.
class AckedCommand extends Command
{
    constructor(){
        super();
        //   Command=1 byte
		// ackId 8 bytes
        this.uint64_ackId=BigInt(0);
			//! The id that is used to acknowledge receipt via AcknowledgementMessage.
			// Should increase monotonically per-full-client-session: clients can ignore any id less than or equal to a previously received id.
    }
    static sizeof(){
        return 9;
    }
    size(){
        return AckedCommand.sizeof();
    }
};

//! Sent from server to client to set the origin of the client's space.
class SetOriginNodeCommand extends AckedCommand
{
    constructor(){
        super();
        //   Command=1 byte
        this.CommandPayloadType_commandPayloadType=CommandPayloadType.SetOriginNode;
        //   AckedCommand=9 bytes
		// uint64_originNodeUid 8 bytes
		this.uint64_originNodeUid=BigInt(0);		//!< The session uid of the node to use as the origin.
		
		// uint64_validCounter 8 bytes
		//! A validity value. Larger values indicate newer data, so the client ignores messages with smaller validity than the last one received.
		this.uint64_validCounter =BigInt(0);
    }
	static sizeof()
	{
		return AckedCommand.sizeof()+16;
	}
    size(){
        return SetOriginNodeCommand.sizeof();
    }
};

class SetLightingCommand extends AckedCommand
{
    constructor(){
        super();
        //   Command=1 byte
        this.CommandPayloadType_commandPayloadType=CommandPayloadType.SetupLighting;
        //   AckedCommand=9 bytes
		// ClientDynamicLighting_clientDynamicLighting 57 bytes
		this.ClientDynamicLighting_clientDynamicLighting=new core.ClientDynamicLighting();	//!<			Setup for dynamic object lighting. 174+57=231 bytes
    }
	static sizeof()
	{
		return AckedCommand.sizeof()+57;
	}
    size(){
        return SetLightingCommand.sizeof();
    }
}


//! Sent from server to client when the set of audio tracks delivered to a client changes.
//! The fixed-size header is followed on the wire by addedCount AddedEntry records
//! (uint8 midLen + midLen UTF-8 bytes + uint64 sourceClientUid) then removedCount
//! RemovedEntry records (uint8 midLen + midLen UTF-8 bytes).
class AudioSourceMappingCommand extends Command
{
	constructor(){
		super();
		this.CommandPayloadType_commandPayloadType = CommandPayloadType.AudioSourceMapping;
		this.uint16_addedCount   = 0;
		this.uint16_removedCount = 0;
	}
	static sizeof() { return 5; } // 1 tag + 2 addedCount + 2 removedCount
	size() { return AudioSourceMappingCommand.sizeof(); }
}

//! Sent from server to client to report user-visible audio state changes for participants.
//! Followed by updateCount × 10-byte Update records (uint64 sourceClientUid + uint8 state + uint8 reason).
class AudioParticipantStateChangeCommand extends Command
{
	constructor(){
		super();
		this.CommandPayloadType_commandPayloadType = CommandPayloadType.AudioParticipantStateChange;
		this.uint16_updateCount = 0;
	}
	static sizeof() { return 3; } // 1 tag + 2 updateCount
	size() { return AudioParticipantStateChangeCommand.sizeof(); }
}

module.exports= {Command,CommandPayloadType,SetupCommand,AcknowledgeHandshakeCommand,SetOriginNodeCommand,SetLightingCommand,AudioSourceMappingCommand,AudioParticipantStateChangeCommand};
