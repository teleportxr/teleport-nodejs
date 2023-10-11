'use strict';

const DefaultRTCPeerConnection = require('wrtc').RTCPeerConnection;

const Connection = require('./connection');

const TIME_TO_CONNECTED = 10000;
const TIME_TO_HOST_CANDIDATES = 3000;  // NOTE: Too long.
const TIME_TO_RECONNECTED = 10000;

class WebRtcConnection extends Connection
{
    constructor(id, options = {})
    {
        super(id);

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

        beforeOffer(peerConnection);

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
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            var message = '{{"teleport-signal-type",description.typeString()},{"sdp",'+offer+'}}';
            sendConfigMessage(message);
            try
            {
                await waitUntilIceGatheringStateComplete(peerConnection, options);
            } catch (error)
            {
                this.close();
                throw error;
            }
        };

        this.applyAnswer = async answer =>
        {
            await peerConnection.setRemoteDescription(answer);
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
            super.close();
        };

        this.toJSON = () =>
        {
            return {
                ...super.toJSON(),
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
}

function beforeOffer(peerConnection) {
    const dataChannel = peerConnection.createDataChannel('ping-pong');
  
    function onMessage({ data }) {
      if (data === 'ping') {
        dataChannel.send('pong');
      }
    }
  
    dataChannel.addEventListener('message', onMessage);
  
    // NOTE(mroberts): This is a hack so that we can get a callback when the
    // RTCPeerConnection is closed. In the future, we can subscribe to
    // "connectionstatechange" events.
    const { close } = peerConnection;
    peerConnection.close = function() {
      dataChannel.removeEventListener('message', onMessage);
      return close.apply(this, arguments);
    };
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
