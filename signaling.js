// Importing the required modules
const WebSocketServer = require('ws');

var generateUid = (function () {
		var i = BigInt(1);
		return function () {
				return i++;
		}
})();

class SignalingClient {
		constructor(ip, ws) {
			this.ip = ip;
			this.ws = ws;
			this.messagesToPassOn=[];
		}
	}
const signalingClients = new Map();

function processInitialRequest(clientID,txt)
{
	/*if (content.hasOwnProperty("clientID") )
	{
		var j_clientID = content["clientID"].BigInt();
		if (clientID == 0)
		{
			clientID = j_clientID;
		}
		else
		{
			if (!signalingClients.has(clientID))
			{
				// sent us a client ID that isn't valid. Ignore it, don't waste bandwidth..?
				// or instead, send the replacement ID in the response, leave it up to
				// client whether they accept the new ID or abandon the connection.
			}
			// identifies as a previous client. Discard the new client ID.
			//TODO: we're taking the client's word for it that it is clientID. Some kind of token/hash?
			signalingClients[clientID] = signalingClient;
			if (uid != clientID)
			{
				TELEPORT_COUT << ": info: Remapped from " << uid << " to " << clientID << std::endl;
				TELEPORT_COUT << ": info: signalingClient has " << signalingClient->clientID << std::endl;
				signalingClients[uid] = nullptr;
				clientUids.erase(uid);
				uid = clientID;
			}
		}
		std::string ipAddr;
		ipAddr = signalingClient->ip_addr_port;
		TELEPORT_COUT << "Received connection request from " << ipAddr << " identifying as client " << clientID << " .\n";

		//Skip clients we have already added.
		if (signalingClient->signalingState == core::SignalingState::START)
			signalingClient->signalingState = core::SignalingState::REQUESTED;
		// if signalingState is START, we should not have a client...
		if (clientManager.hasClient(clientID))
		{
			// ok, we've received a connection request from a client that WE think we already have.
			// Apparently the CLIENT thinks they've disconnected.
			// The client might, as far as we know, have lost the information it needs to continue the connection.
			// THerefore we should resend everything required.
			signalingClient->signalingState = core::SignalingState::STREAMING;
			TELEPORT_COUT << "Warning: Client " << clientID << " reconnected, but we didn't know we'd lost them." << std::endl;
			// It may be just that the connection request was already in flight when we accepted its predecessor.
			sendResponseToClient(clientID);
			return;
		}
		if (signalingClient->signalingState != core::SignalingState::REQUESTED)
			return;
		//Ignore connections from clients with the wrong IP, if a desired IP has been set.
		if (desiredIP.length() != 0)
		{
			//Create new wide-string with clientIP, and add new client if there is no difference between the new client's IP and the desired IP.
			if (desiredIP.compare(0, ipAddr.size(), { ipAddr.begin(), ipAddr.end() }) == 0)
			{
				signalingClient->signalingState = core::SignalingState::ACCEPTED;
			}
		}
		else
		{
			signalingClient->signalingState = core::SignalingState::ACCEPTED;
		}
	}*/
}

function receiveWebSocketsMessage(clientID,txt)
{
	var message = JSON.parse(txt);
	if (!message.hasOwnProperty("teleport-signal-type"))
		return;
	if (message["teleport-signal-type"] == "request")
		processInitialRequest(clientID, message["content"]);
	else
		signalingClients[clientID].messagesToPassOn.push(txt);
}

exports.init =function ()
{
		// Creating a new websocket server
		const wss = new WebSocketServer.Server({ port: 8080 })
		
		// Creating connection using websocket
		wss.on("connection", (ws, req) => {
			var clientID = generateUid();
			const ip_addr_port = req.socket.remoteAddress;
			var signalingClient=new SignalingClient(ip_addr_port,ws);
			signalingClients.set(clientID, signalingClient);
			console.log("new client "+clientID.toString()+" connected from "+ip_addr_port.toString());
			//When the server runs behind a proxy like NGINX, the de-facto standard is to use the X-Forwarded-For header.
			//const ip = req.headers['x-forwarded-for'].split(',')[0].trim();
		
			// sending message to client
			 //ws.send('Welcome, you are connected!');
		
			//on message from client
			ws.on("message", (data, isBinary) => {
			if (!isBinary)
			{
				console.log(`Client has sent text: ${data}`)
				receiveWebSocketsMessage(signalingClient.clientID, data);
			}
			else
			{
				console.log(`Client has sent binary:`+data);
				console.log(data.toString());
			// ReceiveBinaryWebSocketsMessage(signalingClient->clientID, bin);
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
		});
		console.log("The WebSocket server is running on port 8080");
}