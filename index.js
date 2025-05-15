
const WebRtcConnectionManager	= require('./connections/webrtcconnectionmanager.js');
const signaling					= require("./signaling.js");
const client_manager 			= require('./client/client_manager.js');

/** Generates BigInts between low (inclusive) and high (exclusive) */
function generateRandomBigInt() {
  const difference = BigInt(9007199254740991n);
  const differenceLength = difference.toString().length;
  let multiplier = '';
  while (multiplier.length < differenceLength) {
    multiplier += Math.random()
      .toString()
      .split('.')[1];
  }
  multiplier = multiplier.slice(0, differenceLength);
  const divisor = '1' + '0'.repeat(differenceLength);
  const randomDifference = (difference * BigInt(multiplier)) / BigInt(divisor);
  return randomDifference;
}

const serverID = generateRandomBigInt();

function initServer(signaling_port) {
	var cm=client_manager.getInstance();
	const webRtcConnectionManager = WebRtcConnectionManager.getInstance();
	webRtcConnectionManager.SetSendConfigMessage(signaling.sendConfigMessage);
	return signaling.init(serverID, webRtcConnectionManager,cm.newClient.bind(cm),cm.disconnectClient.bind(cm),signaling_port);
  }
  
  module.exports = {initServer}
