'use strict';
// Tests for GeometryService.UpdateVisibleNodes — the pass that decides what a
// client should be able to see.
//
// This replaced an additive sweep that streamed every scene node to every
// client on every tick. The sweep had two consequences this file pins down:
// a node another client had just created did reach peers, but a node that had
// been REMOVED never left them, and any host-application decision to unstream a
// node was silently undone within a second. The diff fixes both, and is what
// makes client-specific node lifecycle work without an explicit distribution or
// removal step anywhere.

const test = require('node:test');
const assert = require('node:assert');

const { GeometryService } = require('../client/geometry_service.js');
const { ClientNodeRegistry, NodeVisibility } = require('../client/client_nodes.js');

function fakeScene() {
	return {
		nodes: new Map(),
		InsertNode(n) { this.nodes.set(n.uid, n); return n.uid; },
		RemoveNode(uid) { return this.nodes.delete(uid); },
		GetNode(uid) { return this.nodes.get(uid) || null; },
		GetAllNodeUids() { return Array.from(this.nodes.keys()); },
	};
}

function addNode(scene, uid) {
	const node = { uid, name: 'n' + uid, holder_client_id: 0, components: [] };
	scene.InsertNode(node);
	return node;
}

function makeService(clientID, scene) {
	// The tracked-resource map is static; reset it so uids don't leak across cases.
	GeometryService.trackedResources = new Map();
	const svc = new GeometryService(clientID);
	svc.SetScene(scene);
	return svc;
}

// Pretend everything queued has been sent and acknowledged, so the next
// UnstreamNode produces a genuine RemoveNodes entry rather than being skipped
// as "never sent".
function markSent(svc, uids) {
	for (const uid of uids) svc.EncodedResource(uid);
}

test('a node another client creates reaches an already-connected client', () => {
	const scene = fakeScene();
	const reg = new ClientNodeRegistry(scene);
	addNode(scene, 1n);
	const svc = makeService(100n, scene);

	svc.UpdateVisibleNodes(scene, reg, 100n);
	assert.deepStrictEqual(Array.from(svc.nodesToStreamEventually), [1n]);

	// Client 2 connects and its origin node appears in the shared scene.
	addNode(scene, 2n);
	reg.register(200n, 2n, { role: 'origin', visibility: NodeVisibility.Everyone });

	svc.UpdateVisibleNodes(scene, reg, 100n);
	assert.deepStrictEqual(Array.from(svc.nodesToStreamEventually).sort(), [1n, 2n]);
});

test('a node removed from the scene leaves the visible set and is queued for removal', () => {
	const scene = fakeScene();
	const reg = new ClientNodeRegistry(scene);
	addNode(scene, 1n);
	addNode(scene, 2n);
	reg.register(200n, 2n, { role: 'origin' });
	const svc = makeService(100n, scene);

	svc.UpdateVisibleNodes(scene, reg, 100n);
	markSent(svc, [1n, 2n]);

	// Client 2 departs: the registry takes its nodes out of the scene, and
	// nothing else has to happen.
	reg.releaseForClient(200n);
	svc.UpdateVisibleNodes(scene, reg, 100n);

	assert.deepStrictEqual(Array.from(svc.nodesToStreamEventually), [1n]);
	assert.deepStrictEqual(svc.GetRemoveNodesToSend(), [2n]);
	// Drained: it is not sent twice.
	assert.deepStrictEqual(svc.GetRemoveNodesToSend(), []);
});

test('a node never sent to this client produces no RemoveNodes payload', () => {
	const scene = fakeScene();
	const reg = new ClientNodeRegistry(scene);
	addNode(scene, 3n);
	reg.register(200n, 3n, {});
	const svc = makeService(100n, scene);

	svc.UpdateVisibleNodes(scene, reg, 100n);   // queued, but never encoded
	reg.releaseForClient(200n);
	svc.UpdateVisibleNodes(scene, reg, 100n);

	assert.deepStrictEqual(svc.GetRemoveNodesToSend(), []);
});

test('a host-application UnstreamNode is not undone by the next pass', () => {
	const scene = fakeScene();
	const reg = new ClientNodeRegistry(scene);
	addNode(scene, 1n);
	addNode(scene, 2n);
	const svc = makeService(100n, scene);
	svc.UpdateVisibleNodes(scene, reg, 100n);
	markSent(svc, [1n, 2n]);

	// The host culls a node by distance, as CustomClient.ProcessNodePoses does.
	svc.UnstreamNode(2n);
	assert.deepStrictEqual(svc.GetRemoveNodesToSend(), [2n]);

	// Several passes later it must still be gone: this is what used to thrash,
	// re-streaming the node within a second of every unstream.
	svc.UpdateVisibleNodes(scene, reg, 100n);
	svc.UpdateVisibleNodes(scene, reg, 100n);
	assert.deepStrictEqual(Array.from(svc.nodesToStreamEventually), [1n]);
	assert.deepStrictEqual(svc.GetRemoveNodesToSend(), []);

	// StreamNode is the inverse: it withdraws the suppression.
	svc.StreamNode(2n);
	svc.UpdateVisibleNodes(scene, reg, 100n);
	assert.deepStrictEqual(Array.from(svc.nodesToStreamEventually).sort(), [1n, 2n]);
});

test('visibility hides a client-specific node from the clients it is not for', () => {
	const scene = fakeScene();
	const reg = new ClientNodeRegistry(scene);
	addNode(scene, 10n); // owner's origin  — everyone
	addNode(scene, 11n); // owner's avatar  — peers only
	reg.register(100n, 10n, { role: 'origin', visibility: NodeVisibility.Everyone });
	reg.register(100n, 11n, { role: 'avatar', visibility: NodeVisibility.PeersOnly });

	const owner = makeService(100n, scene);
	owner.UpdateVisibleNodes(scene, reg, 100n);
	assert.deepStrictEqual(Array.from(owner.nodesToStreamEventually), [10n],
		'the owner must not be sent its own peers-only avatar');

	// A second service for the peer. Sharing the static trackedResources map is
	// the production arrangement, so build it without resetting.
	const peer = new GeometryService(200n);
	peer.SetScene(scene);
	peer.UpdateVisibleNodes(scene, reg, 200n);
	assert.deepStrictEqual(Array.from(peer.nodesToStreamEventually).sort(), [10n, 11n],
		'a peer must be sent both the origin and the avatar');
});

test('changing visibility at runtime moves the node in and out of the visible set', () => {
	const scene = fakeScene();
	const reg = new ClientNodeRegistry(scene);
	addNode(scene, 12n);
	reg.register(100n, 12n, { role: 'avatar', visibility: NodeVisibility.Everyone });
	const svc = makeService(100n, scene);

	svc.UpdateVisibleNodes(scene, reg, 100n);
	assert.deepStrictEqual(Array.from(svc.nodesToStreamEventually), [12n]);
	markSent(svc, [12n]);

	reg.setVisibility(12n, NodeVisibility.PeersOnly);
	svc.UpdateVisibleNodes(scene, reg, 100n);
	assert.deepStrictEqual(Array.from(svc.nodesToStreamEventually), []);
	assert.deepStrictEqual(svc.GetRemoveNodesToSend(), [12n]);
});

test('ForgetClient releases the bitset index and clears the departed client\'s bits', () => {
	const scene = fakeScene();
	const reg = new ClientNodeRegistry(scene);
	addNode(scene, 1n);
	const svc = makeService(300n, scene);
	svc.UpdateVisibleNodes(scene, reg, 300n);
	markSent(svc, [1n]);
	const res = GeometryService.GetOrCreateTrackedResource(1n);
	assert.ok(res.IsNeededByClient(300n));
	assert.ok(res.WasSentToClient(300n));

	GeometryService.ForgetClient(300n);

	// A new client handed the recycled index must not inherit the old one's
	// state, or it would silently never be sent resources it has never seen.
	const fresh = new GeometryService(301n);
	assert.ok(!res.IsNeededByClient(301n));
	assert.ok(!res.WasSentToClient(301n));
	assert.ok(!res.WasAcknowledgedByClient(301n));
});
