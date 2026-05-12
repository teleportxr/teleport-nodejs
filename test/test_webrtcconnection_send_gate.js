'use strict';
// Regression tests for the send-gating behaviour added to WebRtcConnection.
// Before the fix, sendGeometry/sendReliable swallowed InvalidStateError when
// the data channel's readyState was still 'connecting' but returned no signal
// to the caller, so client.js was free to mark resources as transmitted even
// though nothing had been written. The geometry_service then refused to retry
// them until its 10 s timeout elapsed.
//
// These tests don't construct a real RTCPeerConnection; they invoke the
// methods on a stub object that inherits from WebRtcConnection.prototype.

const test = require('node:test');
const assert = require('node:assert');
const WebRtcConnection = require('../connections/webrtcconnection');

function makeCtx() {
	return Object.create(WebRtcConnection.prototype);
}

test('sendGeometry returns false and does not call dc.send when channel is connecting', () => {
	let sendCalls = 0;
	const ctx = makeCtx();
	ctx.geometryDataChannel = {
		readyState: 'connecting',
		send: () => { sendCalls++; },
	};
	const result = ctx.sendGeometry(new Uint8Array([1, 2, 3]));
	assert.strictEqual(result, false);
	assert.strictEqual(sendCalls, 0, 'send() must not be called while readyState is "connecting"');
});

test('sendGeometry returns false when geometryDataChannel is missing entirely', () => {
	const ctx = makeCtx();
	assert.strictEqual(ctx.sendGeometry(new Uint8Array([1])), false);
});

test('sendGeometry returns true when channel is open and forwards the buffer', () => {
	let captured = null;
	const ctx = makeCtx();
	ctx.geometryDataChannel = {
		readyState: 'open',
		send: (b) => { captured = b; },
	};
	const buf = new Uint8Array([4, 5, 6]);
	assert.strictEqual(ctx.sendGeometry(buf), true);
	assert.strictEqual(captured, buf);
});

test('sendGeometry returns false when an open channel throws inside send()', () => {
	const ctx = makeCtx();
	ctx.geometryDataChannel = {
		readyState: 'open',
		send: () => { throw new Error('simulated wrtc failure'); },
	};
	assert.strictEqual(ctx.sendGeometry(new Uint8Array([1])), false);
});

test('sendReliable returns false and does not call dc.send when channel is connecting', () => {
	let sendCalls = 0;
	const ctx = makeCtx();
	ctx.reliableDataChannel = {
		readyState: 'connecting',
		send: () => { sendCalls++; },
	};
	assert.strictEqual(ctx.sendReliable(new Uint8Array([1])), false);
	assert.strictEqual(sendCalls, 0);
});

test('sendReliable returns true when channel is open and forwards the buffer', () => {
	let captured = null;
	const ctx = makeCtx();
	ctx.reliableDataChannel = {
		readyState: 'open',
		send: (b) => { captured = b; },
	};
	const buf = new Uint8Array([7, 8, 9]);
	assert.strictEqual(ctx.sendReliable(buf), true);
	assert.strictEqual(captured, buf);
});

test('isGeometryOpen reports true only when readyState equals "open"', () => {
	const ctx = makeCtx();
	assert.strictEqual(ctx.isGeometryOpen(), false, 'no channel');
	ctx.geometryDataChannel = { readyState: 'connecting' };
	assert.strictEqual(ctx.isGeometryOpen(), false, 'connecting');
	ctx.geometryDataChannel.readyState = 'open';
	assert.strictEqual(ctx.isGeometryOpen(), true, 'open');
	ctx.geometryDataChannel.readyState = 'closing';
	assert.strictEqual(ctx.isGeometryOpen(), false, 'closing');
});
