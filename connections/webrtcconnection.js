'use strict';

const EventEmitter = require('events');
const wrtc =require('wrtc');
const DefaultRTCPeerConnection = require('wrtc').RTCPeerConnection;

const TIME_TO_CONNECTED = 10000;
const TIME_TO_HOST_CANDIDATES = 3000;  // NOTE: Too long.
const TIME_TO_RECONNECTED = 10000;

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

		peerConnection.addEventListener('iceconnectionstatechange', onIceConnectionStateChange);

		this.doOffer = async () =>
		{
			try
			{ 
				const offer = await peerConnection.createOffer();
				await peerConnection.setLocalDescription(offer);
				var message = '{"teleport-signal-type":"offer","sdp":"'+offer.sdp+'"}'; //
				this.sendConfigMessage(this.id,message);
				await waitUntilIceGatheringStateComplete(peerConnection, options);
			} catch (error)
			{
				this.close();
				throw error;
			}
		};

		this.applyAnswer = async answer =>
		{
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
    beforeOffer(peerConnection) {
        
        this.videoDataChannel = this.createDataChannel("video",{id:20});
        this.tagDataChannel = this.createDataChannel("video_tags",{id:40});
        this.audioToClientDataChannel = this.createDataChannel("audio_server_to_client",{id:60});
        this.geometryDataChannel = this.createDataChannel("geometry",{id:80});
        this.reliableDataChannel = this.createDataChannel("reliable",{id:100});
        this.unreliableDataChannel = this.createDataChannel("unreliable",{id:120,ordered:false});
        this.dataChannel = peerConnection.createDataChannel('ping-pong');
      
        function onMessage({ data }) {
          if (data === 'ping') {
            //dataChannel.send('pong');
          }
        }
      
        // NOTE(mroberts): This is a hack so that we can get a callback when the
        // RTCPeerConnection is closed. In the future, we can subscribe to
        // "connectionstatechange" events.
        const { close } = peerConnection;
        peerConnection.close = function() {
          dataChannel.removeEventListener('message', onMessage);
          return close.apply(this, arguments);
        };
      }
    createDataChannel(label,dict)
    {
        var dc=this.pc.createDataChannel(label,dict);
        dc.onmessage = (event) => {
            console.log('datachannel '+label+' received: '+event.data+'.');
        };
  
          dc.onopen = () => {
            console.log('datachannel '+label+' open');
        };
  
        dc.onclose = () => {
            console.log('datachannel '+label+' close');
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

async function waitUntilIceGatheringStateComplete (peerConnection, options)
{
	if (peerConnection.iceGatheringState === 'complete')
	{
		return;
	}

	const { timeToHostCandidates } = options;

	const deferred = {};
	deferred.promise = new Promise((resolve, reject) =>
	{
		deferred.resolve = resolve;
		deferred.reject = reject;
	});

	const timeout = options.setTimeout(() =>
	{
		peerConnection.removeEventListener('icecandidate', onIceCandidate);
		deferred.reject(new Error('Timed out waiting for host candidates'));
	}, timeToHostCandidates);

	function onIceCandidate ({ candidate })
	{
		if (!candidate)
		{
			options.clearTimeout(timeout);
			peerConnection.removeEventListener('icecandidate', onIceCandidate);
			deferred.resolve();
		}
	}

	peerConnection.addEventListener('icecandidate', onIceCandidate);

	await deferred.promise;
}

module.exports = WebRtcConnection;
