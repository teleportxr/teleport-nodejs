'use strict';

const EventEmitter = require('events');
const wrtc =require('@roamhq/wrtc');
const DefaultRTCPeerConnection = require('@roamhq/wrtc').RTCPeerConnection;

const TIME_TO_CONNECTED = 30000;
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
		const iceServers=[
			"stun:stun.l.google.com:19302"
			];
		this.iceServers = [] ;
		for(const s in iceServers)
		{
			this.iceServers.push({ 'urls': iceServers[s] });
		}
		//this.iceServers=[{'urls': 'stun:stun.l.google.com:19302'}];
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
		this.peerConnection		=new DefaultRTCPeerConnection({ sdpSemantics: 'unified-plan', 'iceServers': this.iceServers});
		this.beforeOffer();
		this.connectionTimer = this.options.setTimeout(() =>
		{
			if (this.peerConnection.iceConnectionState !== 'connected'
				&& this.peerConnection.iceConnectionState !== 'completed')
			{
				console.log("WebRtcConnection timeout, this.peerConnection.iceConnectionState = "+this.peerConnection.iceConnectionState);
				this.close();
			}
		}, this.options.timeToConnected);

		this.reconnectionTimer = null;

		this.peerConnection.addEventListener('iceconnectionstatechange', this.onIceConnectionStateChange.bind(this));
		this.peerConnection.addEventListener('icegatheringstatechange', this.onIceGatheringStateChange.bind(this));
		this.peerConnection.addEventListener("icecandidateerror", (event) => {

            console.log("ICE candidate error: "+event.errorCode+" "+event.errorText+" "+event.port+" "+event.url);
		});
        
        this.peerConnection.addEventListener("connectionstatechange", this.connectionStateChanged.bind(this,this.peerConnection.connectionState));

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
                peerConnection.removeEventListener('icecandidate', this.onIceCandidate.bind(this));
                this.deferred.reject(new Error('Timed out waiting for host candidates'));
            }, timeToHostCandidates);
        
            peerConnection.addEventListener('icecandidate', this.onIceCandidate.bind(this));
        
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
	connectionStateChanged()
	{
		if(!this.peerConnection)
			return;
		console.log("Connection State changed to: "+this.peerConnection.connectionState.toString());
	}
	onIceConnectionStateChange()
	{
		if(!this.peerConnection)
			return;
		console.log("ICE state changed to: "+this.peerConnection.iceConnectionState);
		if (this.peerConnection.iceConnectionState === 'connected'
			|| this.peerConnection.iceConnectionState === 'completed')
		{
			if (this.connectionTimer)
			{
				this.options.clearTimeout(this.connectionTimer);
				this.connectionTimer = null;
			}
			this.options.clearTimeout(this.reconnectionTimer);
			this.reconnectionTimer = null;
		} else if (this.peerConnection.iceConnectionState === 'disconnected'
			|| this.peerConnection.iceConnectionState === 'failed')
		{
			this.peerConnection.restartIce();
			console.log("restartIce()");
			if (!this.connectionTimer && !this.reconnectionTimer)
			{
				const self = this;
				this.reconnectionTimer = this.options.setTimeout(() =>
				{
					this.reconnect();
					this.doOffer();
				}, this.options.timeToReconnected);
			}
		}
	}
	onIceGatheringStateChange()
	{
		// This could get hit in the WebRtcConnection constructor where we've had no chance to set the peerConnection pointer!
		if(this.peerConnection)
			console.log("ICE gathering state changed to: "+this.peerConnection.iceGatheringState);
	}

	close()
	{
		console.log("WebRtcConnection.close()");
		if(this.peerConnection)
		{
			this.peerConnection.removeEventListener('iceconnectionstatechange', this.onIceConnectionStateChange.bind(this));

			this.peerConnection.eve
			this.peerConnection.removeEventListener('iceconnectionstatechange', this.onIceConnectionStateChange.bind(this));
			this.peerConnection.removeEventListener('icegatheringstatechange', this.onIceGatheringStateChange.bind(this));
		//this.peerConnection.removeEventListener("icecandidateerror", (event) => {
			this.peerConnection.removeEventListener("connectionstatechange", this.connectionStateChanged.bind(this,this.peerConnection.connectionState));
		}
		if (this.connectionTimer)
		{
			this.options.clearTimeout(this.connectionTimer);
			this.connectionTimer = null;
		}
		if (this.reconnectionTimer)
		{
			this.options.clearTimeout(this.reconnectionTimer);
			this.reconnectionTimer = null;
		}

		// Check the connection state
		if(this.peerConnection)
		if (this.peerConnection.connectionState == "connected" ||
			this.peerConnection.connectionState == "failed")
		{
			// Close each track
		/*	this.peerConnection.cl.forEach(mediaStream => { {
						mediaStream.videoTracks.forEach( it => {it.setEnabled(false); });
						mediaStream.audioTracks.forEach( it => {it.setEnabled(false); });

					};
				});;6'7*/

			// Close the connection
			this.peerConnection.close();
		}

		// Nullify the reference
		this.peerConnection = null;
		this.state = 'closed';
		this.emit('closed');
	};
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
