'use strict';

const EventEmitter = require('events');
const wrtc =require('wrtc');
const DefaultRTCPeerConnection = require('wrtc').RTCPeerConnection;

const TIME_TO_CONNECTED = 10000;
const TIME_TO_HOST_CANDIDATES = 3000;  // NOTE: Too long.
const TIME_TO_RECONNECTED = 10000;

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

		options = {
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

		this.connectionStateChanged=options.connectionStateChanged;
		this.sendConfigMessage=options.sendConfigMessage;
		const peerConnection = new RTCPeerConnection({
			sdpSemantics: 'unified-plan'
		});
        this.pc=peerConnection;
        
		this.beforeOffer(peerConnection);
 
		let connectionTimer = options.setTimeout(() =>
		{
			if (peerConnection.iceConnectionState !== 'connected'
				&& peerConnection.iceConnectionState !== 'completed')
			{
				this.close();
			}
		}, timeToConnected);

		let reconnectionTimer = null;

		const onIceConnectionStateChange = () =>
		{
            console.log("ICE state changed to: "+peerConnection.iceConnectionState);
			if (peerConnection.iceConnectionState === 'connected'
				|| peerConnection.iceConnectionState === 'completed')
			{
				if (connectionTimer)
				{
					options.clearTimeout(connectionTimer);
					connectionTimer = null;
				}
				options.clearTimeout(reconnectionTimer);
				reconnectionTimer = null;
			} else if (peerConnection.iceConnectionState === 'disconnected'
				|| peerConnection.iceConnectionState === 'failed')
			{
				if (!connectionTimer && !reconnectionTimer)
				{
					const self = this;
					reconnectionTimer = options.setTimeout(() =>
					{
						self.close();
					}, timeToReconnected);
				}
			}
		};
		const onIceGatheringStateChange = () =>
		{
            console.log("ICE gathering state changed to: "+peerConnection.iceGatheringState);
        };

		peerConnection.addEventListener('iceconnectionstatechange', onIceConnectionStateChange);
		peerConnection.addEventListener('icegatheringstatechange', onIceGatheringStateChange);

        
		const onConnectionStateChange = () =>
           {
            console.log("Connection State changed to: "+peerConnection.connectionState.toString());
            this.connectionStateChanged(this,peerConnection.connectionState);
        }
        peerConnection.addEventListener("connectionstatechange", onConnectionStateChange);

        this.onIceCandidate= ({ candidate })=>
        {
            if (!candidate)
            {
                options.clearTimeout(this.timeout);
                //peerConnection.removeEventListener('icecandidate', this.onIceCandidate);
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
				const offer = await peerConnection.createOffer();
				await peerConnection.setLocalDescription(offer);
				var message = '{"teleport-signal-type":"offer","sdp":"'+offer.sdp+'"}'; //
				this.sendConfigMessage(this.id,message);
				await this.waitUntilIceGatheringStateComplete(peerConnection, options);
			} catch (error)
			{
                console.error(error.toString());
				this.close();
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
            }
            var sessionDescription=new wrtc.RTCSessionDescription();
            sessionDescription.sdp=answer;
            sessionDescription.type="answer";
			await peerConnection.setRemoteDescription( sessionDescription);
		};
		this.applyRemoteCandidate = async(candidate_txt,mid,mlineindex)=>
		{
            console.log("received remote candidate.");
            peerConnection.addIceCandidate(new wrtc.RTCIceCandidate({
              candidate: candidate_txt,
              sdpMLineIndex: mlineindex,
              sdpMid: mid
            }));
		};

		this.close = () =>
		{
			peerConnection.removeEventListener('iceconnectionstatechange', onIceConnectionStateChange);
			if (connectionTimer)
			{
				options.clearTimeout(connectionTimer);
				connectionTimer = null;
			}
			if (reconnectionTimer)
			{
				options.clearTimeout(reconnectionTimer);
				reconnectionTimer = null;
			}
			peerConnection.close();
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

		Object.defineProperties(this, {
			iceConnectionState: {
				get ()
				{
					return peerConnection.iceConnectionState;
				}
			},
			localDescription: {
				get ()
				{
					return descriptionToJSON(peerConnection.localDescription, true);
				}
			},
			remoteDescription: {
				get ()
				{
					return descriptionToJSON(peerConnection.remoteDescription);
				}
			},
			signalingState: {
				get ()
				{
					return peerConnection.signalingState;
				}
			}
		});
	}
    sendGeometry(buffer) {
		try {	
        	this.geometryDataChannel.send(buffer);
		}
		catch(exception) {
            console.error('datachannel.sendGeometry exception: '+exception.message);
		}
    }
    beforeOffer(peerConnection) {
          
        this.videoDataChannel = this.createDataChannel("video",20);
        this.tagDataChannel = this.createDataChannel("video_tags",40);
        this.audioToClientDataChannel = this.createDataChannel("audio_server_to_client",60);
        this.geometryDataChannel = this.createDataChannel("geometry_unframed",80);
        this.reliableDataChannel = this.createDataChannel("reliable",100);
        this.unreliableDataChannel = this.createDataChannel("unreliable",120,false);
       // this.dataChannel = peerConnection.createDataChannel('ping-pong',{id:2050});
      
        function onMessage({ data }) {
          if (data === 'ping') {
            //dataChannel.send('pong');
          }
        }
      
        // NOTE(mroberts): This is a hack so that we can get a callback when the
        // RTCPeerConnection is closed. In the future, we can subscribe to
        // "connectionstatechange" events.
        const { close } = peerConnection;
        var self=this;
        peerConnection.close = function() {
            //self.dataChannel.removeEventListener('message', onMessage);
          return close.apply(this, arguments);
        };
      }
      
    createDataChannel(label,id,reliable=true)
    {
        //See https://web.dev/articles/webrtc-datachannels. Can only use id if negotiated=true.
        const dataChannelOptions={ordered:reliable,maxRetransmits:reliable?10000:0,id:id};
        
        var dc=this.pc.createDataChannel(label,dataChannelOptions);
       
         dc.onmessage = (event) => {
            console.log('datachannel '+label+' received: '+event.data+'.');
        };
  
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
