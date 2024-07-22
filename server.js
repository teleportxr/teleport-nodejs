'use strict';
 
const WebRtcConnectionManager = require('./connections/webrtcconnectionmanager');
const cm = require('./client/client_manager.js');

const signaling=require("./signaling.js");
const scene=require("./scene/scene.js");

const options = {
    sendConfigMessage: signaling.sendConfigMessage
};

var s=new scene.Scene();
s.Load("assets/scene.json");

function createNewClient(clientID){
	var origin_uid=s.CreateNode();
	return origin_uid;
}

const webRtcConnectionManager = WebRtcConnectionManager.create(options);
cm.getInstance().SetNewClientCallback(createNewClient);
signaling. init(webRtcConnectionManager,cm.getInstance().newClient.bind(cm.getInstance()));
