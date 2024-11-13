'use strict';
 
const WebRtcConnectionManager = require('./connections/webrtcconnectionmanager');
const cm = require('./client/client_manager.js');

const signaling=require("./signaling.js");
const scene=require("./scene/scene.js");

var sc=new scene.Scene();
sc.Load("assets/scene.json");

function createNewClient(clientID) {
	var origin_uid=s.CreateNode();
	return origin_uid;
}

// This will be called AFTER a client has been created, so we can access it from the clientManager.
function onClientPostCreate(clientID) {
	var client=cm.getInstance().GetClient(clientID);
	client->SetScene(sc);
}

const webRtcConnectionManager = WebRtcConnectionManager.getInstance();
webRtcConnectionManager.SetSendConfigMessage(signaling.sendConfigMessage);
cm.getInstance().SetNewClientCallback(createNewClient);
cm.getInstance().SetClientPostCreateCallback(onClientPostCreate);
signaling.init(webRtcConnectionManager,cm.getInstance().newClient.bind(cm.getInstance()));
