
const WebRtcConnectionManager	= require('./connections/webrtcconnectionmanager.js');
const signaling					=require("./signaling.js");
const client_manager 			= require('./client/client_manager.js');

function initServer(http_server) {
	var cm=client_manager.getInstance();
	const webRtcConnectionManager = WebRtcConnectionManager.getInstance();
	webRtcConnectionManager.SetSendConfigMessage(signaling.sendConfigMessage);
	signaling.init(webRtcConnectionManager,cm.newClient.bind(cm),http_server);
  }
  
  module.exports = {initServer}
