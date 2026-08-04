'use strict';
// Tests for the RemoveNodes geometry payload: the encoder's byte layout must
// match the C++ wire format (GeometryEncoder::encodeRemoveNodes /
// GeometryDecoder::decodeRemoveNodes), and GeometryService.UnstreamNode must
// queue a removal only for nodes that were actually sent to the client.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../core/core.js');
const { encodeRemoveNodes } = require('../protocol/encoders/node_encoder.js');
const { GeometryService } = require('../client/geometry_service');

test('encodeRemoveNodes produces size-prefixed payload matching the C++ wire format', () => {
	const uids = [5n, 7n];
	const buffer = new ArrayBuffer(8 + 1 + 2 + uids.length * 8);
	const size = encodeRemoveNodes(uids, buffer);
	assert.strictEqual(size, 8 + 1 + 2 + 16);

	const dataView = new DataView(buffer);
	// Size prefix: count of bytes following the size field.
	assert.strictEqual(dataView.getBigUint64(0, core.endian), BigInt(1 + 2 + 16));
	// Payload type.
	assert.strictEqual(dataView.getUint8(8), core.GeometryPayloadType.RemoveNodes);
	assert.strictEqual(core.GeometryPayloadType.RemoveNodes, 13,
		'RemoveNodes must keep the C++ enum value (after MaterialPointer=12)');
	assert.strictEqual(core.GeometryPayloadType.AnimationPointer, 14,
		'AnimationPointer must keep the C++ enum value (after RemoveNodes=13)');
	// Count and uids.
	assert.strictEqual(dataView.getUint16(9, core.endian), 2);
	assert.strictEqual(dataView.getBigUint64(11, core.endian), 5n);
	assert.strictEqual(dataView.getBigUint64(19, core.endian), 7n);
});

test('encodeRemoveNodes handles a single uid', () => {
	const buffer = new ArrayBuffer(8 + 1 + 2 + 8);
	const size = encodeRemoveNodes([42n], buffer);
	const dataView = new DataView(buffer);
	assert.strictEqual(size, 19);
	assert.strictEqual(dataView.getUint16(9, core.endian), 1);
	assert.strictEqual(dataView.getBigUint64(11, core.endian), 42n);
});

function makeService(clientID) {
	// Reset the static trackedResources map between tests so uids don't leak
	// across cases (same pattern as test_geometry_service_send_gate.js).
	GeometryService.trackedResources = new Map();
	return new GeometryService(clientID);
}

test('UnstreamNode queues a removal for a node that was sent to the client', () => {
	const clientID = 201;
	const svc = makeService(clientID);
	svc.StreamNode(9n);
	// Simulate a successful send.
	GeometryService.GetOrCreateTrackedResource(9n).Sent(clientID, 123n);

	svc.UnstreamNode(9n);
	assert.deepStrictEqual(svc.GetRemoveNodesToSend(), [9n]);
	// Drained: a second call returns nothing.
	assert.deepStrictEqual(svc.GetRemoveNodesToSend(), []);
});

test('UnstreamNode does not queue a removal for a node that was never sent', () => {
	const svc = makeService(202);
	svc.StreamNode(11n);
	// Not sent (e.g. geometry channel never opened).
	svc.UnstreamNode(11n);
	assert.deepStrictEqual(svc.GetRemoveNodesToSend(), []);
});

test('UnstreamNode on a node the client never needed is a no-op', () => {
	const svc = makeService(203);
	GeometryService.GetOrCreateTrackedResource(13n).Sent(203, 1n);
	// StreamNode was never called, so clientNeeds is false: nothing to do.
	svc.UnstreamNode(13n);
	assert.deepStrictEqual(svc.GetRemoveNodesToSend(), []);
});

test('UnstreamNode twice only queues one removal', () => {
	const clientID = 204;
	const svc = makeService(clientID);
	svc.StreamNode(15n);
	GeometryService.GetOrCreateTrackedResource(15n).Sent(clientID, 1n);
	svc.UnstreamNode(15n);
	svc.UnstreamNode(15n);
	assert.deepStrictEqual(svc.GetRemoveNodesToSend(), [15n]);
});
