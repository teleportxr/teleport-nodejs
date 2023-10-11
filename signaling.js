// Importing the required modules
const WebSocketServer = require('ws');
var generateUid = (function () {
		var i = BigInt(1);
		return function () {
				return i++;
		}
})();

class SignalingState {
	static START = new SignalingState('Start');
	static REQUESTED = new SignalingState('Requested');
	static ACCEPTED = new SignalingState('Accepted');
	static STREAMING = new SignalingState('Streaming');
	static INVALID = new SignalingState('Invalid');
  
	constructor(name) {
	  this.name = name;
	}
	toString() {
	  return `SignalingState.${this.name}`;
	}
  }

class SignalingClient {
		constructor(ip, ws,id) {
			this.ip = ip;
			this.ws = ws;
			this.messagesToPassOn=[];
			this.ip_addr_port="";
			this.signalingState=SignalingState.START;
			this.clientID = id;
			this.client = null;
		}
	}
const signalingClients = new Map();
var desiredIP="";
var connectionManager=null;
function startStreaming(signalingClient)
{
    var txt='{"teleport-signal-type":"request-response","content":{"clientID": '+signalingClient.clientID+'}}';
	signalingClient.ws.send(txt);
    var c=connectionManager.createConnection();
}
function processInitialRequest(clientID,signalingClient,content)
{
	var j_clientID = BigInt(0);
	if (content.hasOwnProperty("clientID") )
	{
		var j_clientID = BigInt(content["clientID"]);
	}
	console.log( "Received connection request from " + signalingClient.ip_addr_port + " identifying as client " + j_clientID + " .");
	if (clientID == 0)
	{
		clientID = j_clientID;
	}
	else
	{
		if (!signalingClients.has(j_clientID))
		{
			// sent us a client ID that isn't valid. Ignore it, don't waste bandwidth..?
			// or instead, send the replacement ID in the response, leave it up to
			// client whether they accept the new ID or abandon the connection.
			j_clientID=clientID;
		}
		// identifies as a previous client. Discard the new client ID.
		//TODO: we're taking the client's word for it that it is clientID. Some kind of token/hash?
		signalingClients[clientID] =signalingClient;
		if (j_clientID != clientID)
		{
			console.log("info: Remapped from " + clientID+ " to " + j_clientID );
			console.log("info: signalingClient has " + signalingClient.clientID );
			
			if (signalingClients.has(clientID))
			{
				signalingClients[clientID] = nullptr;
				clientUids.erase(clientID);
			}
			clientID = j_clientID;
		}
	}
	var ipAddr = signalingClient.ip_addr_port;
	//Skip clients we have already added.
	if (signalingClient.signalingState == SignalingState.START)
		signalingClient.signalingState = SignalingState.REQUESTED;
	// if signalingState is START, we should not have a client...
	if (signalingClient.client!=null)
	{
		// ok, we've received a connection request from a client that WE think we already have.
		// Apparently the CLIENT thinks they've disconnected.
		// The client might, as far as we know, have lost the information it needs to continue the connection.
		// THerefore we should resend everything required.
		signalingClient.signalingState = SignalingState.STREAMING;
		console.log( "Warning: Client " + clientID + " reconnected, but we didn't know we'd lost them." );
		// It may be just that the connection request was already in flight when we accepted its predecessor.
		sendResponseToClient(clientID);
		return;
	}
	if (signalingClient.signalingState != SignalingState.REQUESTED)
		return;
	//Ignore connections from clients with the wrong IP, if a desired IP has been set.
	if (desiredIP.length == 0||ipAddr.contains(desiredIP))
	{
		signalingClient.signalingState = SignalingState.ACCEPTED;
		startStreaming(signalingClient);
	}
}

function receiveWebSocketsMessage(clientID,signalingClient,txt)
{
	var message = JSON.parse(txt);
	if (!message.hasOwnProperty("teleport-signal-type"))
		return;
	if (message["teleport-signal-type"] == "request")
		processInitialRequest(clientID, signalingClient,message["content"]);
	//else
	//	signalingClients[clientID].messagesToPassOn.push(txt);
}
function OnWebSocket(ws,req)
{
	var clientID = generateUid();
	var signalingClient=new SignalingClient(req.socket.remoteAddress,ws,clientID);
	signalingClients.set(clientID, signalingClient);
	console.log("new client "+clientID.toString()+" connected from "+signalingClient.ip_addr_port .toString());
	//When the server runs behind a proxy like NGINX, the de-facto standard is to use the X-Forwarded-For header.
	//const ip = .headers['x-forwarded-for'].split(',')[0].trim();

	const re=RegExp("([0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+)(:[0-9]+)?", 'i');
	
	signalingClient.ip_addr_port = req.socket.remoteAddress;
	var match=signalingClient.ip_addr_port.match(re);
	if (match)
	{
		signalingClient.ip_addr_port =match[0];
	}

	//on message from client
	ws.on("message", (data, isBinary) => {
		if (!isBinary)
		{
			console.log(`Client has sent text: ${data}`)
			receiveWebSocketsMessage(signalingClient.clientID,signalingClient,data);
		}
		else
		{
			console.log(`Client has sent binary:`+data.byteLength+" bytes.");
			//console.log(data.toString());
			receiveBinaryWebSocketsMessage(signalingClient.clientID, data);
		}
	});
	ws.on("error",error=>
	{
		console.error("Websocket err " + error );
	});
	// handling what to do when clients disconnects from server
	ws.on("close", () => {
		console.log("the client has connected");
	});
	// handling client connection error
	ws.onerror = function () {
			console.log("Some Error occurred")
	}
}
exports.init =function (c)
{
	// Creating a new websocket server
	const wss = new WebSocketServer.Server({ port: 8081 })
	connectionManager=c;
	// Creating connection using websocket
	wss.on("connection", (ws, req) => {
		OnWebSocket(ws,req);
	});
	console.log("The WebSocket server is running on port "+wss.options.port);
}
exports.sendConfigMessage=function(clientID,msg)
{
	signalingClients[clientID].ws.send(msg);
}
