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
		const defaultIceServers = [
			{ urls: "stun:stun.l.google.com:19302" }
		];
		this.iceServers = (options && Array.isArray(options.iceServers) && options.iceServers.length)
			? options.iceServers
			: defaultIceServers;
		this.iceTransportPolicy = (options && (options.iceTransportPolicy === 'all' || options.iceTransportPolicy === 'relay'))
			? options.iceTransportPolicy
			: 'all';
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

		this.messageReceivedReliableCb		=options.messageReceivedReliable;
		this.messageReceivedUnreliableCb	=options.messageReceivedUnreliable;
		this.connectionStateChangedCb=options.connectionStateChanged;
		this.sendConfigMessage		=options.sendConfigMessage;

		this._onIceConnectionStateChange = this.onIceConnectionStateChange.bind(this);
		this._onIceGatheringStateChange  = this.onIceGatheringStateChange.bind(this);
		this._onConnectionStateChange    = this.connectionStateChanged.bind(this);
		this._onIceCandidateError = (event) =>
		{
			console.log("ICE candidate error: "+event.errorCode+" "+event.errorText+" "+event.port+" "+event.url);
		};


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
	connectionStateChanged()
	{
		if(!this.peerConnection)
			return;
		this.connectionStateChangedCb(this.peerConnection.connectionState);
	}
	reconnect()
	{
		this.peerConnection		=new DefaultRTCPeerConnection({ sdpSemantics: 'unified-plan', iceServers: this.iceServers, iceTransportPolicy: this.iceTransportPolicy});
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

		this.peerConnection.addEventListener('iceconnectionstatechange', this._onIceConnectionStateChange);
		this.peerConnection.addEventListener('icegatheringstatechange', this._onIceGatheringStateChange);
		this.peerConnection.addEventListener("icecandidateerror", this._onIceCandidateError);
		this.peerConnection.addEventListener("connectionstatechange", this._onConnectionStateChange);

        this.onIceCandidate= ({ candidate })=>
        {
            if (!candidate)
            {
                if (this.iceGatheringSettle)
                    this.iceGatheringSettle();
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

            const onGatheringStateChange = () =>
            {
                if (peerConnection.iceGatheringState === 'complete')
                    this.iceGatheringSettle();
            };

            let settled = false;
            this.iceGatheringSettle = () =>
            {
                if (settled) return;
                settled = true;
                this.options.clearTimeout(this.timeout);
                peerConnection.removeEventListener('icegatheringstatechange', onGatheringStateChange);
                this.deferred.resolve();
            };

            // Trickle ICE is in use; the offer and any already-gathered candidates
            // have been sent. If gathering is slow (e.g. a TURN allocation is
            // timing out), resolve rather than reject so doOffer does not tear
            // down the connection. Remaining candidates will still be sent by
            // the persistent 'icecandidate' listener.
            this.timeout = options.setTimeout(() => this.iceGatheringSettle(), timeToHostCandidates);

            peerConnection.addEventListener('icegatheringstatechange', onGatheringStateChange);
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
			if(this.peerConnection)
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
			if(this.peerConnection)
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
			this.peerConnection.removeEventListener('iceconnectionstatechange', this._onIceConnectionStateChange);
			this.peerConnection.removeEventListener('icegatheringstatechange', this._onIceGatheringStateChange);
			this.peerConnection.removeEventListener("icecandidateerror", this._onIceCandidateError);
			this.peerConnection.removeEventListener("connectionstatechange", this._onConnectionStateChange);
			if (this.onIceCandidate)
			{
				this.peerConnection.removeEventListener('icecandidate', this.onIceCandidate);
			}
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
