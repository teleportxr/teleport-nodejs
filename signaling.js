'use strict';
const getcurrentline = require("get-current-line").default;

// Importing the required modules
const WebSocketServer = require("ws");
const core=require("./core/core.js");

class SignalingState {
	static START = new SignalingState("Start");
	static REQUESTED = new SignalingState("Requested");
	static ACCEPTED = new SignalingState("Accepted");
	static STREAMING = new SignalingState("Streaming");
	static INVALID = new SignalingState("Invalid");

	constructor(name) {
		this.name = name;
	}
	toString() {
		return `SignalingState.${this.name}`;
	}
}

class SignalingClient { 
	constructor(ip, ws, id) {
		this.ip = ip;
		this.ws = ws;
		this.messagesToPassOn = [];
		this.ip_addr_port = "";
		this.signalingState = SignalingState.START;
		this.clientID = id;
		this.receiveReliableBinaryMessage=null;
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
function startStreaming(signalingClient) {
    signalingClient.ChangeSignalingState(SignalingState.ACCEPTED);
	// And we send the WebSockets request-response.
	sendResponseToClient(signalingClient.clientID);
	newClient(signalingClient.clientID,signalingClient);
}

function sendResponseToClient(clientID) {
	if (!signalingClients.has(clientID)) {
        console.log("No client "+clientID+" found.");
	} else {
        var signalingClient=signalingClients[clientID];
		// First, we send the WebSockets signaling response.
		var txt =
			'{"teleport-signal-type":"request-response","content":{"clientID": ' +
			signalingClient.clientID +
			'}}';
		signalingClient.ws.send(txt);
	}
}
function processDisconnection(clientID,signalingClient){

}
function processInitialRequest(clientID, signalingClient, content) {
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
		signalingClients[clientID] = signalingClient;
		if (j_clientID != clientID) {
			console.log(
				"info: Remapped from " + clientID + " to " + j_clientID
			);
			console.log(
				"info: signalingClient has " + signalingClient.clientID
			);

			if (signalingClients.has(clientID)) {
				signalingClients[clientID] = null;
				clientUids.erase(clientID);
			}
			clientID = j_clientID;
		}
	}
	var ipAddr = signalingClient.ip_addr_port;
	// Skip clients we have already added.
	if (signalingClient.signalingState == SignalingState.START)
		signalingClient.ChangeSignalingState(SignalingState.REQUESTED);
	// if signalingState is START, we should not have a client...
	if (signalingClient.client != null) {
		// ok, we've received a connection request from a client that WE think we already have.
		// Apparently the CLIENT thinks they've disconnected.
		// The client might, as far as we know, have lost the information it needs to continue the connection.
		// Therefore we should resend everything required.
		signalingClient.ChangeSignalingState(SignalingState.STREAMING);
		console.log(
			"Warning: Client " +
				clientID +
				" reconnected, but we didn't know we'd lost them."
		);
		// It may be just that the connection request was already in flight when we accepted its predecessor.
		sendResponseToClient(clientID);
		return;
	}
	if (signalingClient.signalingState != SignalingState.REQUESTED)
        return;
	//Ignore connections from clients with the wrong IP, if a desired IP has been set.
	if (desiredIP.length == 0 || ipAddr.contains(desiredIP)) {
		startStreaming(signalingClient);
	}
}

function receiveWebSocketsMessage(clientID, signalingClient, txt) {
	var message = JSON.parse(txt);
	if (!message.hasOwnProperty("teleport-signal-type"))
        return;
    var teleport_signal_type=message["teleport-signal-type"];
	if (teleport_signal_type == "request")
    {
		processInitialRequest(clientID, signalingClient, message["content"]);
    }
    else if (teleport_signal_type == "disconnect")
    {
        processDisconnection(clientID, signalingClient);
    }
    else
    {
        var webRtcConnection = webRtcConnectionManager.getConnection(clientID);
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
	ws.on("close", () => {
		console.log("the client has connected");
	});
	// handling client connection error
	ws.onerror = function () {
		console.log("Some Error occurred");
	};
}
exports.init = function (webRtcCM,newClientFn) {
	// Creating a new websocket server
	const wss = new WebSocketServer.Server({ port: 8081 });
	webRtcConnectionManager = webRtcCM;
	newClient=newClientFn;
	// Creating connection using websocket
	wss.on("connection", (ws, req) => {
		OnWebSocket(ws, req);
	});
	console.log("The WebSockets Signaling Server is running on port " + wss.options.port);
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
		signalingClients[clientID].ws.send(escapedStr);
	} else {
		console.log(
			"sendConfigMessage with clientID " +
				clientID +
				" not in signalingClients map."
		);
	}
};

exports.signalingClients = signalingClients;
