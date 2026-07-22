'use strict';
// Regression tests for GeometryService.StreamNode / UnstreamNode idempotency.
//
// Before this fix, UnstreamNode unconditionally rewrote the clientNeeds bit,
// deleted from nodesToStreamEventually/streamedNodes, and logged — even when
// the node was already unstreamed for this client. A caller that re-evaluates
// a streaming decision every tick (e.g. distance-based visibility in
// teleport-nodejs-server-example's CustomClient.ProcessNodePoses) would then
// log and touch shared state on every tick it stayed on one side of the
// threshold, rather than only on the actual transition. StreamNode had the
// same gap in the other direction. Both now return early — no state writes,
// no log — when the call would not change anything.

const test = require('node:test');
const assert = require('node:assert');
const { GeometryService } = require('../client/geometry_service');

function makeService(clientID) {
	// Reset the static trackedResources map between tests so uids don't leak
	// across cases.
	GeometryService.trackedResources = new Map();
	return new GeometryService(clientID);
}

test('UnstreamNode logs and clears state on the real transition, then is silent on repeat calls', () => {
	const svc = makeService(201);
	svc.StreamNode(31n);
	const res = GeometryService.GetOrCreateTrackedResource(31n);
	assert.ok(res.IsNeededByClient(201));

	const originalLog = console.log;
	const logs = [];
	console.log = (...args) => logs.push(args.join(''));
	try {
		svc.UnstreamNode(31n);
		assert.ok(!res.IsNeededByClient(201));
		assert.strictEqual(logs.length, 1, 'the first UnstreamNode call for a streamed node must log once');

		svc.UnstreamNode(31n);
		svc.UnstreamNode(31n);
		assert.strictEqual(logs.length, 1,
			'repeated UnstreamNode calls while already unstreamed must not log again');
	} finally {
		console.log = originalLog;
	}
});

test('UnstreamNode is a no-op on the redundant path: it must not re-touch nodesToStreamEventually/streamedNodes', () => {
	const svc = makeService(202);
	svc.StreamNode(33n);
	svc.UnstreamNode(33n);

	// Simulate some other subsystem re-adding bookkeeping for this uid after
	// the real unstream, so a later no-op UnstreamNode call would visibly
	// disturb it if the guard were missing.
	svc.nodesToStreamEventually.add(33n);
	svc.streamedNodes.set(33n, 1);

	svc.UnstreamNode(33n);
	assert.ok(svc.nodesToStreamEventually.has(33n),
		'a redundant UnstreamNode call (already unstreamed) must not delete from nodesToStreamEventually');
	assert.ok(svc.streamedNodes.has(33n),
		'a redundant UnstreamNode call (already unstreamed) must not delete from streamedNodes');
});

test('StreamNode is idempotent: a second call for an already-needed node does not resurrect nodesToStreamEventually', () => {
	const svc = makeService(203);
	svc.StreamNode(41n);
	assert.ok(svc.nodesToStreamEventually.has(41n));

	// Simulate the resource having been picked up and removed from the
	// "eventually" queue by UpdateNodesToStream, as happens in production.
	svc.nodesToStreamEventually.delete(41n);

	// A redundant StreamNode call (client still needs it) must not re-add it —
	// only the real transition (need false -> true) should do that.
	svc.StreamNode(41n);
	assert.ok(!svc.nodesToStreamEventually.has(41n),
		'redundant StreamNode call must not resurrect nodesToStreamEventually for an already-needed node');
});

test('StreamNode after UnstreamNode is a real transition and does re-add to nodesToStreamEventually', () => {
	const svc = makeService(204);
	svc.StreamNode(43n);
	svc.UnstreamNode(43n);
	svc.nodesToStreamEventually.delete(43n); // UnstreamNode already does this; assert the starting state.
	assert.ok(!svc.nodesToStreamEventually.has(43n));

	svc.StreamNode(43n);
	assert.ok(svc.nodesToStreamEventually.has(43n),
		'StreamNode must still re-add the uid on an actual false -> true transition');
	const res = GeometryService.GetOrCreateTrackedResource(43n);
	assert.ok(res.IsNeededByClient(204));
});
