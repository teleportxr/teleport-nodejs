
const WebRtcConnectionManager	= require('./connections/webrtcconnectionmanager.js');
const signaling					= require("./signaling.js");
const client_manager 			= require('./client/client_manager.js');
const identity_proto			= require('./protocol/identity.js');
const user_store				= require('./identity/user_store.js');
const identity_verifier			= require('./identity/verifier.js');

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

function initServer(signaling_port, options) {
	var cm=client_manager.getInstance();
	const webRtcConnectionManager = WebRtcConnectionManager.getInstance();
	webRtcConnectionManager.SetSendConfigMessage(signaling.sendConfigMessage);
	if (options && Array.isArray(options.iceServers))
		webRtcConnectionManager.SetIceServers(options.iceServers);
	if (options && options.iceTransportPolicy)
		webRtcConnectionManager.SetIceTransportPolicy(options.iceTransportPolicy);
	if (options && typeof options.audioEchoTest !== 'undefined')
		webRtcConnectionManager.SetAudioEchoTest(options.audioEchoTest);
	// Identity: how connecting clients are recognised as new or returning.
	// Left alone this remembers users in-process and verifies nothing; see
	// signaling.configureIdentity.
	if (options && options.identity)
		signaling.configureIdentity(options.identity);
	return signaling.init(serverID, webRtcConnectionManager,cm.newClient.bind(cm),cm.disconnectClient.bind(cm),signaling_port);
  }

  module.exports = {
	initServer,
	// Identity: parse and canonicalise `connect.identity`, decide trust, and
	// remember users between sessions.
	UserStore:         user_store.UserStore,
	MemoryUserStore:   user_store.MemoryUserStore,
	IdentityVerifier:  identity_verifier.IdentityVerifier,
	IdentityResolver:  identity_verifier.IdentityResolver,
	identity:          identity_proto,
  }
