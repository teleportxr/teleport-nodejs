'use strict';
// Regression test for the origin not being re-sent after a WebRTC reconnection.
//
// The client resets its origin counter on every stream drop
// (InstanceRenderer::OnVideoStreamClosed sets receivedInitialPos = 0), and that same
// counter gates whether it sends head and controller poses at all
// (`if (poseValidCounter)` in SessionClient::Frame). The server kept the origin marked
// acknowledged across the drop, so SendOrigin() was skipped and the client never got an
// origin again — it stopped reporting its pose for the rest of the session, which in turn
// froze anything server-side that depends on the head pose.

const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('../client/client');

function makeStubClient() {
	const c = Object.create(Client.prototype);
	c.clientID = 19;
	c.clientStartMs = Date.now();
	c.webRtcConnectedAtMs = Date.now();
	c.currentOriginState = {
		sent: true,
		originClientHas: 5n,
		ackId: 1n,
		acknowledged: true,
		serverTimeSentUs: 12345n,
		valid_counter: 3n,
		resendCount: 0,
		givenUp: false,
	};
	// LightingState has no `sent` field, unlike OriginState — the guard must cope.
	c.currentLightingState = {
		ackId: 2n,
		acknowledged: true,
		serverTimeSentUs: 999n,
		resendCount: 0,
		givenUp: false,
	};
	c.UpdateStreaming = () => {};
	return c;
}

test('re-arms an acknowledged origin so it is sent again', () => {
	const c = makeStubClient();
	c.RearmAckedCommands();
	assert.strictEqual(c.currentOriginState.acknowledged, false);
	assert.strictEqual(c.currentOriginState.serverTimeSentUs, 0n,
		'the 3 s resend timer must be cleared or SendOrigin will wait it out');
	assert.strictEqual(c.currentOriginState.resendCount, 0);
});

test('re-arms an origin we had given up on', () => {
	const c = makeStubClient();
	c.currentOriginState.acknowledged = false;
	c.currentOriginState.givenUp = true;
	c.currentOriginState.resendCount = 9;
	c.RearmAckedCommands();
	assert.strictEqual(c.currentOriginState.givenUp, false);
	assert.strictEqual(c.currentOriginState.resendCount, 0);
});

test('leaves an origin that was never sent to the normal path', () => {
	const c = makeStubClient();
	c.currentOriginState.sent = false;
	c.currentOriginState.acknowledged = false;
	c.currentOriginState.serverTimeSentUs = 0n;
	c.RearmAckedCommands();
	assert.strictEqual(c.currentOriginState.sent, false);
});

test('does not disturb an origin already awaiting acknowledgement', () => {
	const c = makeStubClient();
	c.currentOriginState.acknowledged = false;
	c.currentOriginState.serverTimeSentUs = 12345n;
	c.currentOriginState.resendCount = 2;
	c.RearmAckedCommands();
	assert.strictEqual(c.currentOriginState.serverTimeSentUs, 12345n,
		'an in-flight origin keeps its resend timer');
	assert.strictEqual(c.currentOriginState.resendCount, 2);
});

test('re-arms lighting too, which the client also resets on disconnect', () => {
	// SessionClient::Disconnect zeroes receivedLightingAckId alongside receivedInitialPos.
	const c = makeStubClient();
	c.RearmAckedCommands();
	assert.strictEqual(c.currentLightingState.acknowledged, false);
	assert.strictEqual(c.currentLightingState.serverTimeSentUs, 0n);
});

test('leaves a never-sent lighting state alone', () => {
	const c = makeStubClient();
	c.currentLightingState.acknowledged = false;
	c.currentLightingState.serverTimeSentUs = 0n;
	c.RearmAckedCommands();
	assert.strictEqual(c.currentLightingState.givenUp, false);
});

test('onDataChannelsOpen re-arms the origin', () => {
	const c = makeStubClient();
	c.onDataChannelsOpen();
	assert.strictEqual(c.currentOriginState.acknowledged, false,
		'a reconnecting client must be re-sent its origin, or it never reports poses again');
});
