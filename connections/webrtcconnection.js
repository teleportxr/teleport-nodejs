'use strict';

const EventEmitter = require('events');
const wrtc =require('@roamhq/wrtc');
const DefaultRTCPeerConnection = require('@roamhq/wrtc').RTCPeerConnection;

const TIME_TO_CONNECTED = 10000;
const TIME_TO_HOST_CANDIDATES = 3000;  // NOTE: Too long.
const TIME_TO_RECONNECTED = 1000;

function EVEN_ID(id) {
    return (id-(id%2))
}
function ODD_ID(id) {
    return (EVEN_ID(id)+1)
}
class WebRtcConnection extends EventEmitter
{
	constructor(id, options = {})
	{
		super();
		this.id = id;
		this.state = 'open';

		this.options = {
			RTCPeerConnection: DefaultRTCPeerConnection,
			clearTimeout,
			setTimeout,
			timeToConnected: TIME_TO_CONNECTED,
			timeToHostCandidates: TIME_TO_HOST_CANDIDATES,
			timeToReconnected: TIME_TO_RECONNECTED,
			...options
		};

		const {
			RTCPeerConnection,
			timeToConnected,
			timeToReconnected
		} = options;

		this.connectionStateChanged			=options.connectionStateChanged;
		this.messageReceivedReliableCb		=options.messageReceivedReliable;
		this.messageReceivedUnreliableCb	=options.messageReceivedUnreliable;
		
		this.sendConfigMessage		=options.sendConfigMessage;


		Object.defineProperties(this, {
			iceConnectionState: {
				get ()
				{
					return this.peerConnection.iceConnectionState;
				}
			},
			localDescription: {
				get ()
				{
					return descriptionToJSON(this.peerConnection.localDescription, true);
				}
			},
			remoteDescription: {
				get ()
				{
					return descriptionToJSON(this.peerConnection.remoteDescription);
				}
			},
			signalingState: {
				get ()
				{
					return this.peerConnection.signalingState;
				}
			}
		});
		this.reconnect();
	}

	reconnect()
	{
		this.peerConnection		=new DefaultRTCPeerConnection({ sdpSemantics: 'unified-plan'});
		this.beforeOffer();
		let connectionTimer = this.options.setTimeout(() =>
		{
			if (this.peerConnection.iceConnectionState !== 'connected'
				&& this.peerConnection.iceConnectionState !== 'completed')
			{
				this.close();
			}
		}, this.options.timeToConnected);

		let reconnectionTimer = null;

		const onIceConnectionStateChange = () =>
		{
            console.log("ICE state changed to: "+this.peerConnection.iceConnectionState);
			if (this.peerConnection.iceConnectionState === 'connected'
				|| this.peerConnection.iceConnectionState === 'completed')
			{
				if (connectionTimer)
				{
					this.options.clearTimeout(connectionTimer);
					connectionTimer = null;
				}
				this.options.clearTimeout(reconnectionTimer);
				reconnectionTimer = null;
			} else if (this.peerConnection.iceConnectionState === 'disconnected'
				|| this.peerConnection.iceConnectionState === 'failed')
			{
				this.peerConnection.restartIce();
				console.log("restartIce()");
				if (!connectionTimer && !reconnectionTimer)
				{
					const self = this;
					reconnectionTimer = this.options.setTimeout(() =>
					{
						this.reconnect();
						this.doOffer();
					}, this.options.timeToReconnected);
				}
			}
		};
		const onIceGatheringStateChange = () =>
		{
            console.log("ICE gathering state changed to: "+this.peerConnection.iceGatheringState);
        };

		this.peerConnection.addEventListener('iceconnectionstatechange', onIceConnectionStateChange);
		this.peerConnection.addEventListener('icegatheringstatechange', onIceGatheringStateChange);
		this.peerConnection.addEventListener("icecandidateerror", (event) => {

            console.log("ICE candidate error: "+str(event.errorCode)+" "+event.errorText+" "+event.port+" "+event.url);
		});
        
		const onConnectionStateChange = () =>
        {
            console.log("Connection State changed to: "+this.peerConnection.connectionState.toString());
            this.connectionStateChanged(this,this.peerConnection.connectionState);
        }
        this.peerConnection.addEventListener("connectionstatechange", onConnectionStateChange);

        this.onIceCandidate= ({ candidate })=>
        {
            if (!candidate)
            {
                this.options.clearTimeout(this.timeout);
                //this.peerConnection.removeEventListener('icecandidate', this.onIceCandidate);
                this.deferred.resolve();
                return;
            }
            // send the candidate
            var mid=candidate.sdpMid;
            var mlineindex=candidate.sdpMLineIndex;
            var message = '{"teleport-signal-type":"candidate","candidate":"'+candidate.candidate+'","mid":"'+mid.toString()+'","mlineindex":'+mlineindex.toString()+'}';
            this.sendConfigMessage(this.id,message);
        }
        this.waitUntilIceGatheringStateComplete= async  (peerConnection, options) =>
        {
            if (peerConnection.iceGatheringState === 'complete')
            {
                return;
            }
        
            const { timeToHostCandidates } = options;
        
            this.deferred = {};
            this.deferred.promise = new Promise((resolve, reject) =>
            {
                this.deferred.resolve = resolve;
                this.deferred.reject = reject;
            });
        
            this.timeout = options.setTimeout(() =>
            {
                peerConnection.removeEventListener('icecandidate', this.onIceCandidate);
                this.deferred.reject(new Error('Timed out waiting for host candidates'));
            }, timeToHostCandidates);
        
            peerConnection.addEventListener('icecandidate', this.onIceCandidate);
        
            await this.deferred.promise;
        }
        
		this.doOffer = async () =>
		{
			try
			{ 
				const offer = await this.peerConnection.createOffer();
				await this.peerConnection.setLocalDescription(offer);
				var message = '{"teleport-signal-type":"offer","sdp":"'+offer.sdp+'"}'; //
				this.sendConfigMessage(this.id,message);
				await this.waitUntilIceGatheringStateComplete(this.peerConnection, this.options);
			} catch (error)
			{
                console.error("doOffer error: "+error.toString());
				this.close();
                console.log("doOffer close");
				throw error;
			}
		};

		this.applyAnswer = async answer =>
		{
            console.log("received remote answer.");
            var escapedStr=answer.toString();
            try{
                escapedStr=escapedStr.replaceAll('\r','\\r');
                escapedStr=escapedStr.replaceAll('\n','\\n');
            } catch(error)
            {
                console.error("applyAnswer error: "+error.toString());
            }
            var sessionDescription=new wrtc.RTCSessionDescription();
            sessionDescription.sdp=answer;
            sessionDescription.type="answer";
			await this.peerConnection.setRemoteDescription( sessionDescription);
		};
		this.applyRemoteCandidate = async(candidate_txt,mid,mlineindex)=>
		{
            console.log("received remote candidate: "+candidate_txt);
			const ice=new wrtc.RTCIceCandidate({
              candidate: candidate_txt,
              sdpMLineIndex: mlineindex,
              sdpMid: mid
			  });
            this.peerConnection.addIceCandidate(ice).catch((e)=>{
				console.log(`Failure during addIceCandidate(): ${e.name}`);
			});
		};
		this.close = () =>
		{
			console.log("WebRtcConnection.close()");
			this.peerConnection.removeEventListener('iceconnectionstatechange', onIceConnectionStateChange);
			if (connectionTimer)
			{
				this.options.clearTimeout(connectionTimer);
				connectionTimer = null;
			}
			if (reconnectionTimer)
			{
				this.options.clearTimeout(reconnectionTimer);
				reconnectionTimer = null;
			}
			this.peerConnection.close();
			this.state = 'closed';
			this.emit('closed');
		};

		this.toJSON = () =>
		{
			return {
				id: this.id,
				state: this.state,
				iceConnectionState: this.iceConnectionState,
				localDescription: this.localDescription,
				remoteDescription: this.remoteDescription,
				signalingState: this.signalingState
			};
		};
	}
    sendGeometry(buffer) {
		try {	
        	this.geometryDataChannel.send(buffer);
		}
		catch(exception) {
            console.error('datachannel.sendGeometry exception: '+exception.message);
		}
    }
    beforeOffer() {
          
        this.videoDataChannel = this.createDataChannel("video",20);
        this.tagDataChannel = this.createDataChannel("video_tags",40);
        this.audioToClientDataChannel = this.createDataChannel("audio_server_to_client",60);
        this.geometryDataChannel = this.createDataChannel("geometry_unframed",80);
        this.reliableDataChannel = this.createDataChannel("reliable",100);
        this.unreliableDataChannel = this.createDataChannel("unreliable",120,false);
       // this.dataChannel = this.peerConnection.createDataChannel('ping-pong',{id:2050});
      
        function onMessage({ data }) {
          if (data === 'ping') {
            //dataChannel.send('pong');
          }
        }
      
        // NOTE(mroberts): This is a hack so that we can get a callback when the
        // RTCPeerConnection is closed. In the future, we can subscribe to
        // "connectionstatechange" events.
        const { close } = this.peerConnection;
        var self=this;
        this.peerConnection.close = function() {
            //self.dataChannel.removeEventListener('message', onMessage);
          return close.apply(this, arguments);
        };
      }
      
	receiveMessage(id,event)
	{
        //.videoDataChannel = .("video",20);
        //.tagDataChannel = .("video_tags",40);
        //.audioToClientDataChannel = .("audio_server_to_client",60);
        //.geometryDataChannel =l("geometry_unframed",80);
        //.reliableDataChannel =l("reliable",100);
        //.unreliableDataChannelnel("unreliable",120,false);
		switch(id)
		{
			case 120:
				this.messageReceivedUnreliableCb(id,event);
				break;
			case 100:
				this.messageReceivedReliableCb(id,event);
				break;
			default:
				break;
		}
		// event is an ArrayBuffer.
	};
    createDataChannel(label,id,reliable=true)
    {
        //See https://web.dev/articles/webrtc-datachannels. Can only use id if negotiated=true.
        const dataChannelOptions={ordered:reliable,maxRetransmits:reliable?10000:0,id:id};
        
        var dc=this.peerConnection.createDataChannel(label,dataChannelOptions);
       
         dc.onmessage = this.receiveMessage.bind(this,id);
  
          dc.onopen = (event) => {
            console.log('datachannel '+label+' open');
           //dc.send('XXXX');
        };
  
        dc.onclose = (event) => {
            console.log('datachannel '+label+' close');
        };
  
        dc.onclosing = (event) => {
            console.log('datachannel '+label+' onclosing');
        };
  
  
        dc.onbufferedamountlow = (event) => {
            console.log('datachannel '+label+' onbufferedamountlow;');
        };
  
  
       // dc.addEventListener('message', onMessage);
        return dc;
    }
	receiveStreamingControlMessage(txt)
	{
		var message = JSON.parse(txt);
		if (!message.hasOwnProperty("teleport-signal-type"))
		{
			console.error("Streaming message ill-formed.");
			return;
		}
		var teleport_signal_type=message["teleport-signal-type"];
		if (teleport_signal_type == "answer")
		{
			var sdp = message["sdp"];
			this.receiveAnswer(sdp);
		}
		else if (teleport_signal_type == "candidate")
		{
			var candidate = message["candidate"];
			var mid = message["mid"];
			var mlineindex = message["mlineindex"];
			this.applyRemoteCandidate(candidate, mid, mlineindex);
		}	
	}
    receiveAnswer(sdp)
    {
        this.applyAnswer(sdp);
    }
    receiveCandidate(candidate,mid,mlineindex)
    {
        peerConn.addIceCandidate(new RTCIceCandidate({
            candidate: message.candidate,
            sdpMLineIndex: message.label,
            sdpMid: message.id
        }));
    }
    
}


function descriptionToJSON (description, shouldDisableTrickleIce)
{
	return !description ? {} : {
		type: description.type,
		sdp: shouldDisableTrickleIce ? disableTrickleIce(description.sdp) : description.sdp
	};
}

function disableTrickleIce (sdp)
{
	return sdp.replace(/\r\na=ice-options:trickle/g, '');
}

module.exports = WebRtcConnection;
