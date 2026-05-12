'use strict';
// Regression tests for GeometryService.GetResourcesToSend / GetMeshesToSend /
// GetNodesToSend. Before the fix, the picker eagerly called res.Sent(now) for
// every uid it returned. Combined with Client.SendNode's "channel not open"
// silent short-circuit, this caused all initial resources to be marked Sent
// during the first UpdateStreaming tick (which fires ~150 ms before the
// geometry data channel finishes opening). On the next tick, every resource
// looked "in flight" and was skipped, and they then sat idle for the full
// 10 s timeout_us window before being retried — visible in production as a
// ~10 s gap between WebRTC connect and the first geometry chunk reaching the
// client.
//
// The fix: GetResourcesToSend / GetMeshesToSend must NOT mark Sent. Sent is
// recorded by EncodedResource(uid), called from Send*() only after the
// transport actually accepts the buffer.

const test = require('node:test');
const assert = require('node:assert');
const { GeometryService } = require('../client/geometry_service');

function makeService(clientID) {
	// Reset the static trackedResources map between tests so uids don't leak
	// across cases.
	GeometryService.trackedResources = new Map();
	return new GeometryService(clientID);
}

function seed(svc, pool, uid) {
	// Ensure the uid is in the static trackedResources map and in the per-client
	// pool, mimicking what AddOrRemoveNodeAndResources / UpdateNodesToStream do.
	GeometryService.GetOrCreateTrackedResource(uid);
	pool.set(uid, 1);
}

test('GetResourcesToSend returns uid but does NOT mark it Sent', () => {
	const svc = makeService(101);
	const pool = new Map();
	seed(svc, pool, 9n);

	const toSend = svc.GetResourcesToSend(pool);
	assert.deepStrictEqual(toSend, [9n]);

	const res = GeometryService.GetOrCreateTrackedResource(9n);
	// WasSentToClient returns the underlying bitset bit (0 / 1), not a boolean.
	assert.ok(!res.WasSentToClient(101),
		'picker must not record Sent — that is the transport layer\'s job');
});

test('GetResourcesToSend keeps returning the same uid across ticks until EncodedResource is called', () => {
	// This is the exact scenario the production stall hit: the geometry data
	// channel is not yet open, SendNode bails out silently, EncodedResource is
	// never invoked. Every subsequent tick must re-offer the uid.
	const svc = makeService(102);
	const pool = new Map();
	seed(svc, pool, 11n);

	for (let tick = 0; tick < 5; tick++) {
		const toSend = svc.GetResourcesToSend(pool);
		assert.deepStrictEqual(toSend, [11n],
			`tick ${tick}: uid must reappear because no successful send was recorded`);
	}
});

test('GetResourcesToSend stops returning a uid once EncodedResource records the send', () => {
	const svc = makeService(103);
	const pool = new Map();
	seed(svc, pool, 13n);

	assert.deepStrictEqual(svc.GetResourcesToSend(pool), [13n]);
	// Simulate Client.SendNode → sendGeometry returned true → EncodedResource.
	svc.EncodedResource(13n);
	assert.deepStrictEqual(svc.GetResourcesToSend(pool), [],
		'after a successful send the uid must not be re-offered until timeout or Timeout()');
});

test('GetResourcesToSend re-offers a uid after timeout_us elapses without acknowledgement', () => {
	const svc = makeService(104);
	svc.timeout_us = 1000; // 1 ms timeout for the test
	const pool = new Map();
	seed(svc, pool, 17n);

	// First tick: picker returns the uid; transport marks it Sent via EncodedResource.
	assert.deepStrictEqual(svc.GetResourcesToSend(pool), [17n]);
	svc.EncodedResource(17n);
	// Immediately after: still in flight, must not be re-offered.
	assert.deepStrictEqual(svc.GetResourcesToSend(pool), []);

	// Manually age the Sent timestamp past the timeout window.
	// core.getTimestampUs() returns a plain Number (microtime.now() - start),
	// matching the type used in GetResourcesToSend's arithmetic.
	const res = GeometryService.GetOrCreateTrackedResource(17n);
	res.sent_server_time_us.set(104, res.GetTimeSent(104) - (svc.timeout_us + 1));

	assert.deepStrictEqual(svc.GetResourcesToSend(pool), [17n],
		'after timeout the uid must be re-offered for retransmission');
});

test('GetResourcesToSend skips uids the client has already acknowledged', () => {
	const svc = makeService(105);
	const pool = new Map();
	seed(svc, pool, 19n);

	svc.EncodedResource(19n);
	svc.ConfirmResource(19n);
	assert.deepStrictEqual(svc.GetResourcesToSend(pool), []);
});

test('GetMeshesToSend follows the same no-eager-Sent contract', () => {
	// The mesh picker used to mark Sent inline; verify it now defers to the
	// transport like the other resource pools.
	const svc = makeService(106);
	seed(svc, svc.streamedMeshes, 23n);

	for (let tick = 0; tick < 3; tick++) {
		assert.deepStrictEqual(svc.GetMeshesToSend(), [23n],
			`tick ${tick}: mesh uid must reappear until EncodedResource is called`);
	}
	svc.EncodedResource(23n);
	assert.deepStrictEqual(svc.GetMeshesToSend(), []);
});
