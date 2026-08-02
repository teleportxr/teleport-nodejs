'use strict';
// Tests for ClientNodeRegistry: which client owns which node, who is allowed to
// see it, and what happens to it when that client goes.
//
// The registry is the single place client-specific nodes are recorded, so the
// origin node and the avatar node can no longer be tracked (and leaked) by
// separate, differently-broken bits of host application code.

const test = require('node:test');
const assert = require('node:assert');

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

test('register records the owner and stamps holder_client_id onto the scene node', () => {
	const scene = fakeScene();
	const node = addNode(scene, 10n);
	const reg = new ClientNodeRegistry(scene);

	reg.register(1n, 10n, { role: 'origin' });
	assert.strictEqual(reg.ownerOf(10n), 1n);
	assert.strictEqual(reg.roleOf(10n), 'origin');
	assert.strictEqual(reg.visibilityOf(10n), NodeVisibility.Everyone);
	// The ownership marker must reach the client: holder_client_id is on the
	// wire in both the Node.js and C++ implementations.
	assert.strictEqual(node.holder_client_id, 1n);
	assert.deepStrictEqual(reg.nodesForClient(1n), [10n]);
});

test('an unowned node is ordinary scenery, visible to everybody', () => {
	const reg = new ClientNodeRegistry(fakeScene());
	assert.strictEqual(reg.isVisibleTo(99n, 1n), true);
	assert.strictEqual(reg.ownerOf(99n), 0);
});

test('visibility decides who a client-specific node reaches', () => {
	const scene = fakeScene();
	addNode(scene, 20n); addNode(scene, 21n); addNode(scene, 22n);
	const reg = new ClientNodeRegistry(scene);
	reg.register(1n, 20n, { visibility: NodeVisibility.Everyone });
	reg.register(1n, 21n, { visibility: NodeVisibility.OwnerOnly });
	reg.register(1n, 22n, { visibility: NodeVisibility.PeersOnly });

	// The owner.
	assert.strictEqual(reg.isVisibleTo(20n, 1n), true);
	assert.strictEqual(reg.isVisibleTo(21n, 1n), true);
	assert.strictEqual(reg.isVisibleTo(22n, 1n), false);
	// A peer.
	assert.strictEqual(reg.isVisibleTo(20n, 2n), true);
	assert.strictEqual(reg.isVisibleTo(21n, 2n), false);
	assert.strictEqual(reg.isVisibleTo(22n, 2n), true);
});

test('re-registering the same uid updates it rather than duplicating it', () => {
	const scene = fakeScene();
	addNode(scene, 30n);
	const reg = new ClientNodeRegistry(scene);
	reg.register(1n, 30n, { role: 'avatar', visibility: NodeVisibility.Everyone });
	reg.register(1n, 30n, { role: 'avatar', visibility: NodeVisibility.PeersOnly });
	assert.deepStrictEqual(reg.nodesForClient(1n), [30n]);
	assert.strictEqual(reg.visibilityOf(30n), NodeVisibility.PeersOnly);
});

test('releaseForClient removes exactly that client\'s nodes from the scene', () => {
	const scene = fakeScene();
	addNode(scene, 40n); addNode(scene, 41n); addNode(scene, 42n); addNode(scene, 43n);
	const reg = new ClientNodeRegistry(scene);
	reg.register(1n, 40n, { role: 'origin' });
	reg.register(1n, 41n, { role: 'avatar' });
	reg.register(2n, 42n, { role: 'origin' });
	// 43n is scenery: owned by nobody.

	const removed = reg.releaseForClient(1n);
	assert.deepStrictEqual(removed.sort(), [40n, 41n]);
	assert.strictEqual(scene.GetNode(40n), null);
	assert.strictEqual(scene.GetNode(41n), null);
	// The other client's node and the scenery are untouched.
	assert.ok(scene.GetNode(42n));
	assert.ok(scene.GetNode(43n));
	assert.deepStrictEqual(reg.nodesForClient(1n), []);
	assert.strictEqual(reg.ownerOf(40n), 0);

	// Releasing again is a no-op.
	assert.deepStrictEqual(reg.releaseForClient(1n), []);
});

test('unregister forgets a node without removing it from the scene', () => {
	const scene = fakeScene();
	addNode(scene, 50n);
	const reg = new ClientNodeRegistry(scene);
	reg.register(1n, 50n, {});
	assert.strictEqual(reg.unregister(50n), true);
	assert.strictEqual(reg.ownerOf(50n), 0);
	assert.ok(scene.GetNode(50n), 'unregister must not touch the scene');
	assert.strictEqual(reg.unregister(50n), false);
});

test('transferToClient hands a returning client the nodes it left behind', () => {
	const scene = fakeScene();
	addNode(scene, 60n); addNode(scene, 61n);
	const reg = new ClientNodeRegistry(scene);
	reg.register(1n, 60n, { role: 'origin' });
	reg.register(1n, 61n, { role: 'avatar', visibility: NodeVisibility.PeersOnly });

	reg.transferToClient(1n, 2n);
	assert.deepStrictEqual(reg.nodesForClient(1n), []);
	assert.deepStrictEqual(reg.nodesForClient(2n).sort(), [60n, 61n]);
	assert.deepStrictEqual(reg.nodesForClientWithRole(2n, 'origin'), [60n]);
	// Roles and visibility survive the transfer, and the new owner is stamped
	// onto the nodes.
	assert.strictEqual(reg.visibilityOf(61n), NodeVisibility.PeersOnly);
	assert.strictEqual(reg.isVisibleTo(61n, 2n), false);
	assert.strictEqual(scene.GetNode(60n).holder_client_id, 2n);
	// The nodes never left the scene, so peers saw no interruption.
	assert.ok(scene.GetNode(60n));
	assert.ok(scene.GetNode(61n));
});
