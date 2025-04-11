
const WebRtcConnectionManager	= require('./connections/webrtcconnectionmanager.js');
const signaling					=require("./signaling.js");
const client_manager 			= require('./client/client_manager.js');

function initServer(signaling_port) {
	var cm=client_manager.getInstance();
	const webRtcConnectionManager = WebRtcConnectionManager.getInstance();
	webRtcConnectionManager.SetSendConfigMessage(signaling.sendConfigMessage);
	return signaling.init(webRtcConnectionManager,cm.newClient.bind(cm),signaling_port);
  }
  
  module.exports = {initServer}
