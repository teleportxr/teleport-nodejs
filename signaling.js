'use strict';
const getcurrentline = require("get-current-line").default;

// Importing the required modules
const WebSocketServer = require("ws");
const crypto = require("crypto");
const core = require("./core/core.js");
const avatars = require("./protocol/avatars.js");
const identity_proto = require("./protocol/identity.js");
const user_store = require("./identity/user_store.js");
const identity_verifier = require("./identity/verifier.js");

class SignalingState {
	static START = new SignalingState("Start");
	static REQUESTED = new SignalingState("Requested");
	static ACCEPTED = new SignalingState("Accepted");
	static STREAMING = new SignalingState("Streaming");
	static INVALID = new SignalingState("Invalid");
	static STOP = new SignalingState("Stop");

	constructor(name) {
		this.name = name;
	}
	toString() {
		return `SignalingState.${this.name}`;
	}
}
var serverID=BigInt(0n);

class SignalingClient {
	constructor(ip, ws, id) {
		this.ip = ip;
		this.ws = ws;
		this.messagesToPassOn = [];
		this.ip_addr_port = "";
		this.signalingState = SignalingState.START;
		this.clientID = id;
		this.receiveReliableBinaryMessage=null;
		// Handlers wired by the per-client Client when it is created
		// (see ClientManager.newClient). Avatar negotiation messages are
		// JSON text frames so they cannot share the WebRTC binary path.
		this.handleAvatarOffer=null;
		this.handleAvatarRevoke=null;
		// Session-level capabilities advertised by the client in its
		// `connect` message. A general extension point; unknown keys are
		// carried through so the set can grow without breaking older
		// clients. Gates every signal type added after 0.9 — see
		// protocol/avatars.js.
		this.capabilities = {};
		// Who the client says it is, as parsed from `connect`. Unverified.
		this.identity = null;
		// The resolved user: { tier, key, record, isNewUser }. Set once
		// identity resolution completes, just before the session starts.
		this.user = null;
		// Guards the async gap between `connect` and startStreaming(): a
		// client whose discovery loop ticks again during identity
		// verification must not start a second session.
		this.identityInFlight = false;
		// The outstanding identity-challenge, if any.
		this.pendingChallenge = null;
	}
	ChangeSignalingState(newState) {
		console.log(
			"clientID " +
				this.clientID +
				" signaling state from " +
				this.signalingState +
				" to " +
				newState
		);
		this.signalingState = newState;
	}
    sendToClient(data) {
        this.ws.send(data);
    }
}
var signalingClients = new Map();
var desiredIP = "";
var webRtcConnectionManager = null;
var newClient=null;
var disconnectClient=null;
var clientHostHeader = ""; // Store the first client's host header for resource URLs
var clientProtoHeader = ""; // Store the first client's X-Forwarded-Proto header

// Identity plumbing. Defaults recognise returning users within this process
// and verify nothing; exports.init() can replace either.
var userStore = new user_store.MemoryUserStore();
var identityVerifierRegistry = new identity_verifier.IdentityVerifier();
var identityResolver = new identity_verifier.IdentityResolver(userStore);
// How long to wait for an identity-response before giving up and continuing
// at the asserted tier. A failed or slow challenge must never cost the user
// their connection.
var identityChallengeTimeoutMs = 5000;

function startStreaming(signalingClient) {
    signalingClient.ChangeSignalingState(SignalingState.ACCEPTED);
	// And we send the WebSockets connect-response.
	sendResponseToClient(signalingClient.clientID);
	newClient(signalingClient.clientID,signalingClient);
}

function sendResponseToClient(clientID) {
	if (!signalingClients.has(clientID)) {
        console.log("No client "+clientID+" found.");
	} else {
        var signalingClient=signalingClients.get(clientID);
		// First, we send the WebSockets signaling response.
		var txt =
			'{"teleport-signal-type":"connect-response",'
			+`"content":{"clientID": ${signalingClient.clientID},`
			+`"serverID": ${serverID}}}`;
		signalingClient.ws.send(txt);
	}
}
function processDisconnection(clientID,signalingClient){
    signalingClient.ChangeSignalingState(SignalingState.START);
	// Release anything waiting on a challenge this client will never answer.
	if (signalingClient.pendingChallenge)
		signalingClient.pendingChallenge.resolve(null);
	disconnectClient(signalingClient.clientID);
	signalingClients.delete(clientID);
}
function processInitialRequest(clientID, signalingClient, content) {
	// Free-form capability bag: a missing / malformed object leaves
	// capabilities empty.
	if (content && typeof content === 'object' && content.capabilities) {
		signalingClient.capabilities = avatars.decodeCapabilities(content.capabilities);
	}
	// Who the client claims to be. Nothing is trusted yet: parsing only
	// normalises the shape, and a malformed or absent identity simply leaves
	// the client anonymous rather than failing the connection.
	if (content && typeof content === 'object' && content.identity !== undefined) {
		signalingClient.identity = identity_proto.parseIdentity(content.identity);
	}
	var j_clientID = 0;
	if (content.hasOwnProperty("clientID")) {
		var j_clientID = content["clientID"];
	}
	var thisline = getcurrentline();
	console.log(
		"info: Received connection request from " +
			signalingClient.ip_addr_port +
			" identifying as client " +
			j_clientID +
			" ."
	);
	if (clientID == 0) {
		clientID = j_clientID;
	} else {
		if (!signalingClients.has(j_clientID)) {
			// sent us a client ID that isn't valid. Ignore it, don't waste bandwidth..?
			// or instead, send the replacement ID in the response, leave it up to
			// client whether they accept the new ID or abandon the connection.
			j_clientID = clientID;
		}
		// identifies as a previous client. Discard the new client ID.
		//TODO: we're taking the client's word for it that it is clientID. Some kind of token/hash?
		signalingClients.set(clientID,signalingClient);
		if (j_clientID != clientID) {
			console.log(
				"info: Remapped from " + clientID + " to " + j_clientID
			);
			console.log(
				"info: signalingClient has " + signalingClient.clientID
			);

			if (signalingClients.has(clientID)) {
				signalingClients.delete(clientID);
				clientUids.erase(clientID);
			}
			clientID = j_clientID;
		}
	}
	var ipAddr = signalingClient.ip_addr_port;
	if (desiredIP.length != 0 && !ipAddr.contains(desiredIP))
		return;
	// Skip clients we have already added.
	if (signalingClient.signalingState == SignalingState.START)
		signalingClient.ChangeSignalingState(SignalingState.REQUESTED);
	//Ignore connections from clients with the wrong IP, if a desired IP has been set.
	// if signalingState is START, we should not have a client...
	if (signalingClient.signalingState==SignalingState.ACCEPTED||signalingClient.signalingState==SignalingState.STREAMING)
	{
		// The client sent us another "connect" while we already hold an active
		// session for them — most likely the client's discovery loop ticked again
		// before the client's connection-status guard kicked in. Respond
		// idempotently: re-send the connect-response so the client knows we still
		// recognise it, and do nothing else. Do NOT tear down the Client /
		// WebRtcConnection, and do NOT re-run startStreaming — both would destroy
		// the live transport (in particular leaving SetOriginNodeCommand /
		// SetLightingCommand without a reliable data channel to be acked on).
		console.log(
			"Warning: Client " + clientID + " sent another connect; resending connect-response."
		);
		sendResponseToClient(clientID);
		return;
	}
	if (signalingClient.signalingState==SignalingState.REQUESTED)
	{
		beginSession(signalingClient);
	}
}

// Resolve who this client is, then start the session. Identity resolution can
// involve a round-trip to the client and a network call to an issuer, so this
// is async — but the session start it guards is not optional: every failure
// path below still ends in startStreaming().
function beginSession(signalingClient) {
	if (signalingClient.identityInFlight)
		return;
	signalingClient.identityInFlight = true;
	resolveIdentityFor(signalingClient)
		.then((verifyResult) => identityResolver.resolve(signalingClient.identity, verifyResult))
		.catch((err) => {
			console.log("identity: resolution failed for client " + signalingClient.clientID +
				": " + (err && err.message ? err.message : err));
			return { tier: identity_proto.TRUST_ANONYMOUS, key: null, record: null, isNewUser: true, identity: null };
		})
		.then((user) => {
			signalingClient.identityInFlight = false;
			// The socket may have gone during verification.
			if (!signalingClients.has(signalingClient.clientID))
				return;
			signalingClient.user = user;
			logUser(signalingClient, user);
			startStreaming(signalingClient);
		});
}

function logUser(signalingClient, user) {
	if (!user || user.tier === identity_proto.TRUST_ANONYMOUS) {
		console.log("identity: client " + signalingClient.clientID + " is anonymous.");
		return;
	}
	const who = user.record && user.record.displayName ? ' "' + user.record.displayName + '"' : '';
	console.log("identity: client " + signalingClient.clientID + " is a " +
		(user.isNewUser ? "new" : "returning") + " " + user.tier + " user" + who +
		" (key=" + user.key + ", visits=" + (user.record ? user.record.visits : 0) + ")");
}

// Challenge the client to prove it holds the key its credential was bound to,
// and verify the answer. Returns the verification result, or null when no
// challenge was issued or it did not succeed — in which case the caller falls
// back to the asserted tier.
//
// The challenge is what makes a forwarded credential useless to anyone but the
// intended server: an OIDC id_token's audience is the *client's* id, not ours,
// so a token replayed by another server still cannot be signed for our
// challenge. See Teleport/docs/protocol/signaling.rst.
function resolveIdentityFor(signalingClient) {
	if (!identityVerifierRegistry.enabled)
		return Promise.resolve(null);
	if (!signalingClient.identity || identity_proto.isGuestIdentity(signalingClient.identity))
		return Promise.resolve(null);
	// A client that has not advertised the capability must never be sent the
	// challenge: unknown signal types are forwarded to the WebRTC stack, so the
	// frame would land in libdatachannel as if it were SDP.
	if (!avatars.hasCapability(signalingClient.capabilities, avatars.CAPABILITY_IDENTITY_CHALLENGE))
		return Promise.resolve(null);

	const challenge = crypto.randomBytes(32).toString('base64url');
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			if (signalingClient.pendingChallenge && signalingClient.pendingChallenge.challenge === challenge) {
				signalingClient.pendingChallenge = null;
				console.log("identity: client " + signalingClient.clientID + " did not answer the challenge in time.");
				resolve(null);
			}
		}, identityChallengeTimeoutMs);
		signalingClient.pendingChallenge = {
			challenge,
			resolve: (result) => {
				clearTimeout(timer);
				signalingClient.pendingChallenge = null;
				resolve(result);
			},
		};
		signalingClient.sendToClient(JSON.stringify({
			"teleport-signal-type": identity_proto.TELEPORT_SIGNAL_TYPE_IDENTITY_CHALLENGE,
			content: { challenge, serverID: serverID.toString() },
		}));
	});
}

// Handle an identity-response. Anything wrong with it resolves to null, which
// leaves the client at the asserted tier rather than disconnecting it.
async function processIdentityResponse(signalingClient, content) {
	const pending = signalingClient.pendingChallenge;
	if (!pending) {
		console.log("identity: unsolicited identity-response from client " + signalingClient.clientID + "; ignored.");
		return;
	}
	if (!content || typeof content !== 'object' || content.challenge !== pending.challenge) {
		console.log("identity: client " + signalingClient.clientID + " answered the wrong challenge.");
		pending.resolve(null);
		return;
	}
	const result = await identityVerifierRegistry.verify(content.credential, {
		identity:  signalingClient.identity,
		challenge: pending.challenge,
		key:       content.key,
		signature: content.signature,
		serverID:  serverID.toString(),
	});
	if (!result.ok)
		console.log("identity: verification failed for client " + signalingClient.clientID + ": " + result.reason);
	pending.resolve(result.ok ? result : null);
}

function receiveWebSocketsMessage(clientID, signalingClient, txt) {
	var message = JSON.parse(txt);
	if (!message.hasOwnProperty("teleport-signal-type"))
        return;
    var teleport_signal_type=message["teleport-signal-type"];
	if (teleport_signal_type == "connect")
    {
		processInitialRequest(clientID, signalingClient, message["content"]);
    }
    else if (teleport_signal_type == "disconnect")
    {
        processDisconnection(clientID, signalingClient);
    }
	else if (teleport_signal_type == avatars.TELEPORT_SIGNAL_TYPE_AVATAR_OFFER)
	{
		if (signalingClient.handleAvatarOffer)
			signalingClient.handleAvatarOffer(message["content"]);
		else
			console.log("avatar-offer received for client " + clientID + " but no handler is wired.");
	}
	else if (teleport_signal_type == identity_proto.TELEPORT_SIGNAL_TYPE_IDENTITY_RESPONSE)
	{
		processIdentityResponse(signalingClient, message["content"]);
	}
	else if (teleport_signal_type == avatars.TELEPORT_SIGNAL_TYPE_AVATAR_REVOKE)
	{
		if (signalingClient.handleAvatarRevoke)
			signalingClient.handleAvatarRevoke(message["content"]);
	}
    else
    {
        var webRtcConnection = webRtcConnectionManager.getConnection(clientID);
		if(webRtcConnection)
	        webRtcConnection.receiveStreamingControlMessage(txt);
    }
}
function OnWebSocket(ws, req) {
	var clientID = core.generateUid();
	var signalingClient = new SignalingClient(
		req.socket.remoteAddress,
		ws,
		clientID
	);
	signalingClient.ip_addr_port = req.socket.remoteAddress;
	signalingClients.set(clientID, signalingClient);
	console.log(
		"new client " +
			clientID.toString() +
			" connected from " +
			signalingClient.ip_addr_port.toString()
	);

	// Capture the Host and X-Forwarded-Proto headers from the first client connection
	// for resource URL auto-detection.
	if (!clientHostHeader && req.headers) {
		// Prefer X-Forwarded-Host / X-Forwarded-Proto set by a reverse proxy.
		const xForwardedHost  = req.headers['x-forwarded-host'];
		const xForwardedProto = req.headers['x-forwarded-proto'];
		const hostHeader      = req.headers['host'];
		clientHostHeader  = xForwardedHost  || hostHeader || '';
		clientProtoHeader = xForwardedProto || '';
		if (clientHostHeader) {
			console.log("Auto-detected resource server host from client connection: " + clientHostHeader);
			if (xForwardedHost)  console.log("  (from X-Forwarded-Host: "  + xForwardedHost  + ")");
			else                  console.log("  (from Host: "              + hostHeader       + ")");
			if (xForwardedProto) console.log("  (from X-Forwarded-Proto: " + xForwardedProto + ")");
		} else {
			console.log("WARNING: Could not auto-detect host from request headers");
			console.log("  Available headers: " + JSON.stringify(req.headers));
		}
	}

	//When the server runs behind a proxy like NGINX, the de-facto standard is to use the X-Forwarded-For header.
	//const ip = .headers['x-forwarded-for'].split(',')[0].trim();

	const re = RegExp("([0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+)(:[0-9]+)?", "i");

	var match = signalingClient.ip_addr_port.match(re);
	if (match) {
		signalingClient.ip_addr_port = match[0];
	}

	//on message from client
	ws.on("message", (data, isBinary) => {
		if (!isBinary) {
			console.log(`Client has sent text: ${data}`);
			receiveWebSocketsMessage(
				signalingClient.clientID,
				signalingClient,
				data
			);
		} else {
			console.log(
				`Client has sent binary:` + data.byteLength + " bytes."
			);
			//console.log(data.toString());
			signalingClient.receiveReliableBinaryMessage(data);
		}
	});
	ws.on("error", (error) => {
		console.error("Websocket err " + error);
	});
	// handling what to do when clients disconnects from server
	ws.on("close", (code, reason) => {
		const reasonStr = (reason && reason.length) ? reason.toString() : "";
		console.log(
			"client " + signalingClient.clientID +
			" disconnected (code=" + code + (reasonStr ? ", reason=" + reasonStr : "") + ")"
		);
	});
}
// Replace the identity plumbing. All fields optional:
//
//   store             a UserStore (see identity/user_store.js). Defaults to an
//                     in-process Map, so users are remembered only until the
//                     server restarts.
//   verifier          an IdentityVerifier registry. While empty no challenge is
//                     ever issued, and every client stays at the asserted tier.
//   requireVerified   treat unverified clients as anonymous, remembering
//                     nothing about them.
//   challengeTimeoutMs
exports.configureIdentity = function (opts = {}) {
	if (opts.store)
		userStore = opts.store;
	if (opts.verifier)
		identityVerifierRegistry = opts.verifier;
	if (opts.challengeTimeoutMs)
		identityChallengeTimeoutMs = opts.challengeTimeoutMs;
	identityResolver = new identity_verifier.IdentityResolver(userStore, { requireVerified: !!opts.requireVerified });
	return { store: userStore, verifier: identityVerifierRegistry, resolver: identityResolver };
};
exports.getUserStore = function () { return userStore; };

exports.init = function (server_id, webRtcCM, newClientFn, disconnectClientFn, signaling_port) {
	serverID = server_id;
	// Creating a new websocket server
	// const signaling_port = process.env.PORT || 8081;
	var wss;
	if(signaling_port)
	{
		wss= new WebSocketServer.Server({ port: signaling_port});
	}
	else
	{
		wss= new WebSocketServer.Server({ noServer: true });
	}
	webRtcConnectionManager = webRtcCM;
	newClient=newClientFn;
	disconnectClient=disconnectClientFn;
	// Creating connection using websocket
	wss.on("connection", (ws, req) => {
		OnWebSocket(ws, req);
	});
	console.log("The WebSockets Signaling Server {"+serverID+"} is running: " + JSON.stringify(wss.options));
	return wss;
};
exports.sendConfigMessage = function (clientID, msg) {
    // Test: is this message valid json?
    var escapedStr=msg.toString();
    try{
        escapedStr=escapedStr.replaceAll('\r','\\r');
        escapedStr=escapedStr.replaceAll('\n','\\n');
        var message = JSON.parse(escapedStr);
    } catch(error)
    {
        console.error(error);
        console.error("Invalid json: "+escapedStr);
        return;
    }


	if (signalingClients.has(clientID)) {
		console.log("sendConfigMessage to "+clientID+": "+msg);
		signalingClients.get(clientID).ws.send(escapedStr);
	} else {
		console.log(
			"sendConfigMessage with clientID " +
				clientID +
				" not in signalingClients map."
		);
	}
};

exports.signalingClients = signalingClients;

// Export function to retrieve the auto-detected client host header for resource URLs
exports.getClientHostHeader = function () {
	return clientHostHeader;
};

// Export function to retrieve the auto-detected X-Forwarded-Proto header
exports.getClientProtoHeader = function () {
	return clientProtoHeader;
};
