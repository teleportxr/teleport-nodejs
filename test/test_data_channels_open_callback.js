'use strict';
// Regression tests for _handleDataChannelOpen. After both reliable and geometry
// data channels are simultaneously in 'open' state, the dataChannelsOpenCb must
// fire exactly once for the lifetime of the PeerConnection — additional channel
// opens (e.g. the unreliable channel) must not retrigger it.

const test = require('node:test');
const assert = require('node:assert');
const WebRtcConnection = require('../connections/webrtcconnection');

function makeCtx() {
	const ctx = Object.create(WebRtcConnection.prototype);
	ctx._dataChannelsOpenFired = false;
	return ctx;
}

test('callback fires once when both required channels reach "open"', () => {
	let calls = 0;
	const ctx = makeCtx();
	ctx.dataChannelsOpenCb = () => { calls++; };
	ctx.geometryDataChannel = { readyState: 'connecting' };
	ctx.reliableDataChannel = { readyState: 'connecting' };

	// First channel opens — callback must not fire yet.
	ctx.geometryDataChannel.readyState = 'open';
	ctx._handleDataChannelOpen('geometry_unframed');
	assert.strictEqual(calls, 0, 'callback fired with only geometry open');

	// Second channel opens — callback fires.
	ctx.reliableDataChannel.readyState = 'open';
	ctx._handleDataChannelOpen('reliable');
	assert.strictEqual(calls, 1, 'callback did not fire when both channels open');

	// Later channels opening must not retrigger.
	ctx._handleDataChannelOpen('unreliable');
	ctx._handleDataChannelOpen('video');
	assert.strictEqual(calls, 1, 'callback fired a second time on later channel open');
});

test('callback never fires while only one of the required channels is open', () => {
	let calls = 0;
	const ctx = makeCtx();
	ctx.dataChannelsOpenCb = () => { calls++; };
	ctx.geometryDataChannel = { readyState: 'open' };
	ctx.reliableDataChannel = { readyState: 'connecting' };

	ctx._handleDataChannelOpen('geometry_unframed');
	ctx._handleDataChannelOpen('video');
	assert.strictEqual(calls, 0);
});

test('absent dataChannelsOpenCb does not throw when both channels open', () => {
	const ctx = makeCtx();
	ctx.geometryDataChannel = { readyState: 'open' };
	ctx.reliableDataChannel = { readyState: 'open' };
	// Must not throw.
	ctx._handleDataChannelOpen('reliable');
	assert.strictEqual(ctx._dataChannelsOpenFired, true);
});

test('callback that throws is caught and the fired flag remains set', () => {
	const ctx = makeCtx();
	ctx.dataChannelsOpenCb = () => { throw new Error('handler boom'); };
	ctx.geometryDataChannel = { readyState: 'open' };
	ctx.reliableDataChannel = { readyState: 'open' };
	// Must not propagate the error to the caller.
	ctx._handleDataChannelOpen('reliable');
	assert.strictEqual(ctx._dataChannelsOpenFired, true);
});
