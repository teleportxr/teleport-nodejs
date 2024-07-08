
 
const WebRtcConnectionManager = require('./connections/webrtcconnectionmanager');


signaling=require("./signaling.js");


options = {
    sendConfigMessage: signaling.sendConfigMessage
};

const webRtcConnectionManager = WebRtcConnectionManager.create(options);

signaling.init(webRtcConnectionManager);
