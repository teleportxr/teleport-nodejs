
 
const WebRtcConnectionManager = require('./connections/webrtcconnectionmanager');


signaling=require("./signaling.js");


options = {
    sendConfigMessage: signaling.sendConfigMessage
};

const connectionManager = WebRtcConnectionManager.create(options);

signaling.init(connectionManager);
