'use strict';

const EventEmitter = require('events');
const path = require('path');
const wrtc =require('@roamhq/wrtc');
const DefaultRTCPeerConnection = require('@roamhq/wrtc').RTCPeerConnection;
const sound = require('../scene/sound.js');

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
		const requestedIceServers = (options && Array.isArray(options.iceServers) && options.iceServers.length)
			? options.iceServers
			: defaultIceServers;
		// @roamhq/wrtc rejects the entire iceServers array if any TURN entry lacks
		// credentials, and TURN can't function without auth, so drop those with a warning.
		this.iceServers = requestedIceServers.filter((s) =>
		{
			const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
			const isTurn = urls.some((u) => u && (u.startsWith('turn:') || u.startsWith('turns:')));
			if (isTurn && (!s.username || !s.credential))
			{
				console.warn("WebRtcConnection: skipping TURN entry without credentials: "+JSON.stringify(s));
				return false;
			}
			return true;
		});
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
		this.dataChannelsOpenCb		=options.dataChannelsOpen;
		this.sendConfigMessage		=options.sendConfigMessage;
		this._dataChannelsOpenFired	=false;

		this._onIceConnectionStateChange = this.onIceConnectionStateChange.bind(this);
		this._onIceGatheringStateChange  = this.onIceGatheringStateChange.bind(this);
		this._onConnectionStateChange    = this.connectionStateChanged.bind(this);
		this._onIceCandidateError = (event) =>
		{
			console.log("ICE candidate error: "+event.errorCode+" "+event.errorText+" "+event.port+" "+event.url);
		};
		this._onTrack = this._handleTrack.bind(this);
		this._audioSource = null;
		this._localAudioTrack = null;
		this._audioSink = null;
		this._sceneAudioStreamer = null;
		this._sceneAudioInterval = null;


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
		// Close and clean up the previous PeerConnection before creating a new one.
		// Failing to do so leaves the old ICE agent (and its UDP socket) alive, which
		// causes it to keep sending/receiving STUN messages with stale credentials and
		// confuses the peer's new ICE agent (ufrag mismatch).
		if (this.peerConnection)
		{
			this.peerConnection.removeEventListener('iceconnectionstatechange', this._onIceConnectionStateChange);
			this.peerConnection.removeEventListener('icegatheringstatechange', this._onIceGatheringStateChange);
			this.peerConnection.removeEventListener("icecandidateerror", this._onIceCandidateError);
			this.peerConnection.removeEventListener("connectionstatechange", this._onConnectionStateChange);
			this.peerConnection.removeEventListener('track', this._onTrack);
			if (this.onIceCandidate)
				this.peerConnection.removeEventListener('icecandidate', this.onIceCandidate);
			this._teardownAudioMediaTrack();
			try { this.peerConnection.close(); } catch (e) {}
			this.peerConnection = null;
		}
		this.peerConnection		=new DefaultRTCPeerConnection({ sdpSemantics: 'unified-plan', iceServers: this.iceServers, iceTransportPolicy: this.iceTransportPolicy});
		// New PeerConnection means new data channels — the "all channels open"
		// callback must be allowed to fire again. Without this reset the latch from
		// the previous PeerConnection's lifetime suppresses UpdateStreaming kick.
		this._dataChannelsOpenFired = false;
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

		this.peerConnection.addEventListener('iceconnectionstatechange', this._onIceConnectionStateChange);
		this.peerConnection.addEventListener('icegatheringstatechange', this._onIceGatheringStateChange);
		this.peerConnection.addEventListener("icecandidateerror", this._onIceCandidateError);
		this.peerConnection.addEventListener("connectionstatechange", this._onConnectionStateChange);
		this.peerConnection.addEventListener('track', this._onTrack);
		// Attach the icecandidate listener here, before doOffer can call
		// setLocalDescription(). libwebrtc starts the ICE agent inside
		// setLocalDescription() and emits host candidates synchronously on
		// resolution; attaching this listener later (e.g. inside
		// waitUntilIceGatheringStateComplete) silently loses those candidates.
		this.peerConnection.addEventListener('icecandidate', this.onIceCandidate);
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

            await this.deferred.promise;
        }
        
		this.doOffer = async () =>
		{
			// Capture the peerConnection at entry; if it gets swapped (reconnect)
			// or nulled (close) during an await, abort silently rather than
			// throwing on a stale reference and double-closing.
			const pc = this.peerConnection;
			try
			{
				const offer = await pc.createOffer();
				if (this.peerConnection !== pc) return;
				await pc.setLocalDescription(offer);
				if (this.peerConnection !== pc) return;
				// Use pc.localDescription.sdp rather than the createOffer() result: the
				// ICE ufrag/pwd in the SDP returned by createOffer() are provisional and
				// libwebrtc may activate a transport with different credentials in
				// setLocalDescription(), which would cause STUN ufrag check failures on
				// the remote peer.
				const localSdp = (pc.localDescription && pc.localDescription.sdp) || offer.sdp;
				var message = '{"teleport-signal-type":"offer","sdp":"'+localSdp+'"}';
				this.sendConfigMessage(this.id,message);
				await this.waitUntilIceGatheringStateComplete(pc, this.options);
			} catch (error)
			{
				if (this.peerConnection !== pc || this.state === 'closed')
					return;
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
			// Do not call restartIce() here: reconnect() below creates a brand-new
			// PeerConnection, so any ICE restart on the old PC is immediately
			// abandoned and produces a third set of dangling ICE credentials.
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
			this.peerConnection.removeEventListener('track', this._onTrack);
			if (this.onIceCandidate)
			{
				this.peerConnection.removeEventListener('icecandidate', this.onIceCandidate);
			}
		}
		this._teardownAudioMediaTrack();
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

		// Always close the PeerConnection regardless of connectionState.
		// Previously it was only closed when state was "connected" or "failed",
		// which left the ICE agent alive (and its socket bound) when state was
		// "disconnected", causing stale STUN traffic toward the peer on reconnect.
		if (this.peerConnection)
		{
			try { this.peerConnection.close(); } catch (e) {}
		}

		// Nullify the reference
		this.peerConnection = null;
		this.state = 'closed';
		this.emit('closed');
	};
	isGeometryOpen() {
		return !!(this.geometryDataChannel && this.geometryDataChannel.readyState === 'open');
	}
	isReliableOpen() {
		return !!(this.reliableDataChannel && this.reliableDataChannel.readyState === 'open');
	}
	// Invoked from each data channel's onopen. Fires the dataChannelsOpen callback
	// exactly once per PeerConnection, the moment both reliable and geometry
	// channels are in 'open' state. This lets Client.UpdateStreaming run as soon
	// as the channels can accept traffic rather than waiting for the next
	// periodic tick (up to 1 s away).
	_handleDataChannelOpen(label) {
		if (this._dataChannelsOpenFired)
			return;
		if (!this.isGeometryOpen() || !this.isReliableOpen())
			return;
		this._dataChannelsOpenFired = true;
		if (this.dataChannelsOpenCb)
		{
			try { this.dataChannelsOpenCb(); }
			catch (e) { console.error('dataChannelsOpenCb threw: '+e.message); }
		}
	}
	// Returns true if the buffer was handed to the underlying transport, false if the
	// channel was not in the 'open' state or send() threw. Callers must use the
	// return value to gate any "this resource has been transmitted" bookkeeping;
	// otherwise a dropped send leaves the resource marked Sent and it won't be
	// retried until geometry_service.timeout_us elapses (default 10 s).
	sendGeometry(buffer) {
		if (!this.isGeometryOpen()) {
			console.warn('sendGeometry called but geometry channel not open (readyState='+
				(this.geometryDataChannel ? this.geometryDataChannel.readyState : 'null')+')');
			return false;
		}
		try {
			this.geometryDataChannel.send(buffer);
			return true;
		}
		catch(exception) {
			console.error('sendGeometry exception: '+exception.message);
			return false;
		}
	}
	sendReliable(buffer) {
		if (!this.isReliableOpen())
			return false;
		try {
			this.reliableDataChannel.send(buffer);
			return true;
		}
		catch(exception) {
			console.error('datachannel.sendReliable exception: '+exception.message);
			return false;
		}
	}
    beforeOffer() {

        this.videoDataChannel = this.createDataChannel("video",20);
        this.tagDataChannel = this.createDataChannel("video_tags",40);
        this.audioToClientDataChannel = this.createDataChannel("audio_server_to_client",60);
        this.geometryDataChannel = this.createDataChannel("geometry_unframed",80);
        this.reliableDataChannel = this.createDataChannel("reliable",100);
        this.unreliableDataChannel = this.createDataChannel("unreliable",120,false);

        this._setupAudioMediaTrack();

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
    // Adds one sendrecv audio transceiver per the protocol (see docs/protocol/audio.rst).
    // Our outbound track is an RTCAudioSource so a future SFU can push selected peer
    // PCM into it; incoming RTP is unwrapped via RTCAudioSink and surfaced as the
    // 'micFrame' event. If options.audioEchoTest is set, received frames are looped
    // straight back to the source, which lets a single browser tab self-test the path.
    _setupAudioMediaTrack() {
        try {
            this._audioSource = new wrtc.nonstandard.RTCAudioSource();
            this._localAudioTrack = this._audioSource.createTrack();
            this.peerConnection.addTransceiver(this._localAudioTrack, { direction: 'sendrecv' });
        } catch (e) {
            console.error('_setupAudioMediaTrack failed: '+e.message);
            this._teardownAudioMediaTrack();
        }
    }
    _handleTrack(event) {
        if (!event || !event.track || event.track.kind !== 'audio')
            return;
        if (this._audioSink) {
            try { this._audioSink.stop(); } catch (e) {}
            this._audioSink = null;
        }
        try {
            this._audioSink = new wrtc.nonstandard.RTCAudioSink(event.track);
        } catch (e) {
            console.error('RTCAudioSink construction failed: '+e.message);
            return;
        }
        this._audioSink.ondata = (data) => {
            this.emit('micFrame', this.id, data);
            if (this.options && this.options.audioEchoTest && this._audioSource) {
                try { this._audioSource.onData(data); } catch (e) {}
            }
        };
    }
    _teardownAudioMediaTrack() {
        this.stopSceneAudio();
        if (this._audioSink) {
            try { this._audioSink.stop(); } catch (e) {}
            this._audioSink = null;
        }
        if (this._localAudioTrack) {
            try { this._localAudioTrack.stop(); } catch (e) {}
            this._localAudioTrack = null;
        }
        this._audioSource = null;
    }
    // Start streaming all SoundComponents in the given scene as a single mixed
    // 48 kHz / mono / int16 PCM track via the outbound audio media track. Idempotent
    // for a given scene; calling again replaces the active source set.
    startSceneAudio(scene) {
        if (!this._audioSource) {
            console.warn('startSceneAudio: no audio source on this connection');
            return;
        }
        if (!scene || typeof scene.GetSoundComponents !== 'function') {
            return;
        }
        const components = scene.GetSoundComponents();
        if (!components || components.length === 0) {
            return;
        }
        if (!this._sceneAudioStreamer) {
            this._sceneAudioStreamer = new sound.SceneAudioStreamer(this._audioSource);
        } else {
            this._sceneAudioStreamer.clear();
        }
        const publicPath = (typeof scene.GetPublicPath === 'function') ? scene.GetPublicPath() : 'http_resources';
        let loaded = 0;
        for (const c of components) {
            if (!c.url) continue;
            const rel = c.url.startsWith('/') ? c.url.slice(1) : c.url;
            const filePath = path.join(publicPath, rel);
            try {
                const src = new sound.WavSource(filePath);
                this._sceneAudioStreamer.addSource(c.url, src);
                loaded++;
            } catch (e) {
                console.warn('startSceneAudio: failed to load '+filePath+': '+e.message);
            }
        }
        if (loaded === 0) {
            return;
        }
        if (this._sceneAudioInterval) {
            clearInterval(this._sceneAudioInterval);
            this._sceneAudioInterval = null;
        }
        // Drive a 10 ms tick. setInterval is sufficient: RTCAudioSource buffers
        // internally, and a few ms of jitter is absorbed by the WebRTC jitter buffer.
        this._sceneAudioTickCount = 0;
        this._sceneAudioInterval = setInterval(() => {
            if (!this._sceneAudioStreamer) return;
            this._sceneAudioStreamer.tick();
            this._sceneAudioTickCount++;
            // Every ~5 s, log tick count + outbound RTP stats so we can confirm
            // libwebrtc is actually transmitting audio packets.
            if ((this._sceneAudioTickCount % 500) === 0) {
                const n = this._sceneAudioTickCount;
                if (typeof this.peerConnection.getStats === 'function') {
                    Promise.resolve(this.peerConnection.getStats()).then((report) => {
                        let summary = 'no outbound-rtp/audio stats';
                        try {
                            const entries = (typeof report.values === 'function') ? Array.from(report.values()) : Object.values(report);
                            const outRtp = entries.find((s) => s && s.type === 'outbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio'));
                            if (outRtp) summary = 'packetsSent='+outRtp.packetsSent+' bytesSent='+outRtp.bytesSent;
                        } catch (e) { summary = 'stats parse error: '+e.message; }
                        console.log('SceneAudioStreamer tick #'+n+' — '+summary);
                    }).catch((e) => { console.log('SceneAudioStreamer tick #'+n+' — getStats failed: '+e.message); });
                } else {
                    console.log('SceneAudioStreamer tick #'+n+' — getStats unavailable');
                }
            }
        }, sound.FRAME_MS);
        console.log('startSceneAudio: streaming '+loaded+' source(s) at '+sound.SAMPLE_RATE+' Hz mono');
    }
    stopSceneAudio() {
        if (this._sceneAudioInterval) {
            clearInterval(this._sceneAudioInterval);
            this._sceneAudioInterval = null;
        }
        if (this._sceneAudioStreamer) {
            this._sceneAudioStreamer.clear();
            this._sceneAudioStreamer = null;
        }
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
            this._handleDataChannelOpen(label);
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
