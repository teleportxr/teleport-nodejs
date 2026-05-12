'use strict';
// Regression tests for Client.ReceiveAcknowledgement. The handler is called
// from three transports:
//   * receivedMessageReliable / receivedMessageUnreliable (WebRTC data channels)
//     deliver event.data as a raw ArrayBuffer.
//   * receiveReliableBinaryMessage (WebSocket signaling fallback) delivers a
//     Node Buffer (Uint8Array view over a pooled ArrayBuffer).
// A previous patch ("Fix buffer type error.") switched the DataView ctor to
// `new DataView(data.buffer, data.byteOffset, data.byteLength)` which fixed the
// Buffer path but crashed the WebRTC path because ArrayBuffer has no .buffer
// property. The crash exits the server with status 1, forcing reconnects and a
// 10 s+ stall in initial resource transfer. These tests pin both shapes.

const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('../client/client');
const message = require('../protocol/message');

// Build a 17-byte AcknowledgementMessage buffer (sizeof === 17). Field
// layout (little-endian) per Message + AcknowledgementMessage:
//   [0..1)   uint8  messagePayloadType (= MessagePayloadType.Acknowledgement)
//   [1..9)   int64  timestamp
//   [9..17)  uint64 ackId
// The current decodeFromDataView implementation has an unrelated bug that
// prevents the decoded values from being assigned back onto `msg`, so the
// downstream ackId comparison branches won't actually fire — but that is fine
// for this regression: the test only asserts the handler does not throw and
// returns normally, which is the property the crash violated.
function makeAckArrayBuffer() {
	const ab = new ArrayBuffer(message.AcknowledgementMessage.sizeof());
	const dv = new DataView(ab);
	dv.setUint8(0, message.MessagePayloadType.Acknowledgement);
	dv.setBigInt64(1, 0n, true);
	dv.setBigUint64(9, 42n, true);
	return ab;
}

function makeStubClient() {
	const c = Object.create(Client.prototype);
	c.clientID = 1;
	c.currentOriginState = { ackId: 0n, acknowledged: false, resendCount: 0 };
	c.currentLightingState = { ackId: 0n, acknowledged: false, resendCount: 0 };
	return c;
}

test('ReceiveAcknowledgement accepts a raw ArrayBuffer (WebRTC path)', () => {
	const c = makeStubClient();
	const ab = makeAckArrayBuffer();
	// Sanity-check: this is the exact shape WebRTC delivers — a bare
	// ArrayBuffer with no .buffer property. Before the fix, the DataView ctor
	// threw "First argument to DataView constructor must be an ArrayBuffer"
	// because data.buffer was undefined.
	assert.strictEqual(ArrayBuffer.isView(ab), false);
	assert.strictEqual(ab.buffer, undefined);
	assert.doesNotThrow(() => c.ReceiveAcknowledgement(ab));
});

test('ReceiveAcknowledgement accepts a Node Buffer (signaling path)', () => {
	const c = makeStubClient();
	const ab = makeAckArrayBuffer();
	// ws delivers binary frames as Node Buffer. Buffer is a Uint8Array view,
	// so ArrayBuffer.isView is true and .buffer / .byteOffset / .byteLength
	// must be used to construct the DataView.
	const buf = Buffer.from(ab);
	assert.strictEqual(ArrayBuffer.isView(buf), true);
	assert.doesNotThrow(() => c.ReceiveAcknowledgement(buf));
});

test('ReceiveAcknowledgement accepts a Uint8Array view at non-zero offset', () => {
	// Defensive: simulate a pooled Buffer where byteOffset > 0. If the handler
	// were to ignore byteOffset and read from offset 0 of the pool, it would
	// see unrelated bytes from a neighbouring allocation.
	const c = makeStubClient();
	const ackSize = message.AcknowledgementMessage.sizeof();
	const pool = new ArrayBuffer(64 + ackSize);
	const dv = new DataView(pool);
	dv.setUint8(64, message.MessagePayloadType.Acknowledgement);
	dv.setBigInt64(65, 0n, true);
	dv.setBigUint64(73, 7n, true);
	const view = new Uint8Array(pool, 64, ackSize);
	assert.strictEqual(view.byteOffset, 64);
	assert.doesNotThrow(() => c.ReceiveAcknowledgement(view));
});

test('ReceiveAcknowledgement rejects a malformed packet without throwing', () => {
	const c = makeStubClient();
	const tooSmall = new ArrayBuffer(3);
	// Should log and return early, not throw.
	assert.doesNotThrow(() => c.ReceiveAcknowledgement(tooSmall));
	const tooBig = new ArrayBuffer(message.AcknowledgementMessage.sizeof() + 1);
	assert.doesNotThrow(() => c.ReceiveAcknowledgement(tooBig));
});
