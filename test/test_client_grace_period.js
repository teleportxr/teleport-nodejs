'use strict';
// Tests for the client-departure grace period in ClientManager.
//
// A client that drops for a moment — a wifi blip, a headset sleeping — used to
// be indistinguishable from one that had gone for good, except that neither
// case destroyed anything: the "Player" origin node created for every
// connection stayed in the scene for the lifetime of the process. Now the nodes
// are held briefly and then destroyed, and a client that comes back inside the
// window and can be recognised inherits the nodes it left, so its peers see no
// interruption at all.

const test = require('node:test');
const assert = require('node:assert');

const { ClientManager } = require('../client/client_manager.js');
const { GeometryService } = require('../client/geometry_service.js');
const signaling = require('../signaling.js');

function fakeScene() {
	let next = 1n;
	return {
		nodes: new Map(),
		CreateNode(name) {
			const uid = next++;
			this.nodes.set(uid, { uid, name, holder_client_id: 0, components: [] });
			return uid;
		},
		RemoveNode(uid) { return this.nodes.delete(uid); },
		GetNode(uid) { return this.nodes.get(uid) || null; },
		GetAllNodeUids() { return Array.from(this.nodes.keys()); },
	};
}

// A ClientManager wired to a scene, with the host callbacks the library
// requires. `user` is the identity the next connecting client resolves to.
function makeManager(scene) {
	const cm = new ClientManager();
	cm.SetScene(scene);
	cm.SetNewClientNodeCallback((clientID) => scene.CreateNode('Player'));
	cm.SetCreateClientCallback((clientID, sigSend) => ({
		clientID,
		origin_uid: 0,
		geometryService: new GeometryService(clientID),
		setOrigin(uid) { this.origin_uid = uid; },
		StopStreaming() {},
		UpdateStreaming() {},
		hasWebRtcConnectionTimedOut() { return false; },
	}));
	return cm;
}

// GetOrCreateClient reads the signalling record for the client's identity, so
// tests have to seed one. Returns a cleanup function.
function seedSignalingClient(clientID, user) {
	signaling.signalingClients.set(clientID, { clientID, user, sendToClient() {} });
	return () => signaling.signalingClients.delete(clientID);
}

function connect(cm, clientID, user) {
	const cleanup = seedSignalingClient(clientID, user);
	const c = cm.GetOrCreateClient(clientID);
	cleanup();
	return c;
}

const alice = { tier: 'verified', key: 'user:alice', record: {}, isNewUser: false };
const bob = { tier: 'verified', key: 'user:bob', record: {}, isNewUser: false };
const anon = { tier: 'anonymous', key: null, record: null, isNewUser: true };

test('the origin node is owned by the client and destroyed when it goes for good', () => {
	const scene = fakeScene();
	const cm = makeManager(scene);
	cm.SetGracePeriodMs(0, 0);

	const c = connect(cm, 1n, anon);
	const origin = c.origin_uid;
	assert.ok(origin, 'the client must have been given an origin node');
	assert.ok(scene.GetNode(origin));
	assert.strictEqual(cm.clientNodes.ownerOf(origin), 1n);
	assert.strictEqual(cm.clientNodes.roleOf(origin), 'origin');

	cm.RemoveClient(1n);
	// With no grace period the node goes immediately. This is the leak that
	// used to accumulate one dead "Player" node per connection, for ever.
	assert.strictEqual(scene.GetNode(origin), null);
	assert.strictEqual(cm.clientNodes.ownerOf(origin), 0);
	cm.StopStreaming();
});

test('an identified client\'s nodes are held during the grace period, then destroyed', async () => {
	const scene = fakeScene();
	const cm = makeManager(scene);
	cm.SetGracePeriodMs(60, 0);

	const c = connect(cm, 1n, alice);
	const origin = c.origin_uid;
	cm.RemoveClient(1n);

	// Still there: peers must not see the node blink out over a momentary drop.
	assert.ok(scene.GetNode(origin), 'nodes must survive the grace period');
	assert.strictEqual(cm.departing.size, 1);

	await new Promise((r) => setTimeout(r, 120));
	assert.strictEqual(scene.GetNode(origin), null, 'nodes must be destroyed once the window closes');
	assert.strictEqual(cm.departing.size, 0);
	cm.StopStreaming();
});

test('an anonymous client gets no grace period by default', () => {
	const scene = fakeScene();
	const cm = makeManager(scene);
	cm.SetGracePeriodMs(60000, 0);

	const c = connect(cm, 1n, anon);
	const origin = c.origin_uid;
	cm.RemoveClient(1n);
	// There is no stable identity to match a returning client against, so
	// holding the nodes would only delay the inevitable.
	assert.strictEqual(scene.GetNode(origin), null);
	assert.strictEqual(cm.departing.size, 0);
	cm.StopStreaming();
});

test('the same user returning inside the window inherits the nodes it left', () => {
	const scene = fakeScene();
	const cm = makeManager(scene);
	cm.SetGracePeriodMs(60000, 0);

	const first = connect(cm, 1n, alice);
	const origin = first.origin_uid;
	cm.RemoveClient(1n);
	assert.ok(scene.GetNode(origin));

	// Alice reconnects: a new connection, so a new clientID, but the same person.
	const second = connect(cm, 2n, alice);
	assert.strictEqual(second.origin_uid, origin, 'the returning client must re-adopt its origin node');
	assert.strictEqual(cm.clientNodes.ownerOf(origin), 2n);
	assert.strictEqual(cm.departing.size, 0, 'the departing record must be cleared on re-adoption');
	// Exactly one Player node: the reconnect did not create a second.
	assert.strictEqual(scene.GetAllNodeUids().length, 1);
	cm.RemoveClient(2n);
	cm.StopStreaming();
});

test('a different user does not inherit someone else\'s nodes', () => {
	const scene = fakeScene();
	const cm = makeManager(scene);
	cm.SetGracePeriodMs(60000, 0);

	const first = connect(cm, 1n, alice);
	const aliceOrigin = first.origin_uid;
	cm.RemoveClient(1n);

	const second = connect(cm, 2n, bob);
	assert.notStrictEqual(second.origin_uid, aliceOrigin);
	assert.strictEqual(cm.clientNodes.ownerOf(aliceOrigin), 1n, 'Alice still owns her held node');
	assert.strictEqual(cm.departing.size, 1, 'Alice is still within her grace period');
	cm.FinaliseDepartedClient(1n);
	cm.RemoveClient(2n);
	cm.StopStreaming();
});

test('the disconnection callback fires at finalisation, not at departure', async () => {
	const scene = fakeScene();
	const cm = makeManager(scene);
	cm.SetGracePeriodMs(60, 0);
	const disconnected = [];
	cm.SetClientDisconnectionCallback((clientID) => disconnected.push(clientID));

	connect(cm, 1n, alice);
	cm.RemoveClient(1n);
	assert.deepStrictEqual(disconnected, [], 'the client might still come back');

	await new Promise((r) => setTimeout(r, 120));
	assert.deepStrictEqual(disconnected, [1n]);
	cm.StopStreaming();
});
