'use strict';
// Tests for Client.QueueNodeMovement / SendNodeMovements: the gating and batching around
// the movement channel. Modelled on test_client_send_node_gate.js — a fake
// webRtcConnection records what the client tried to send.

const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('../client/client');
const { GeometryService } = require('../client/geometry_service');
const core = require('../core/core');

const NODE_A = 101n;
const NODE_B = 102n;

function makeStubClient({ reliableOpen = true, acknowledged = [NODE_A, NODE_B] } = {}) {
	const sent = [];
	const c = Object.create(Client.prototype);
	c.clientID = 1;
	c.clientAxesStandard = core.AxesStandard.EngineeringStyle;
	c.scene = { serverAxesStandard: core.AxesStandard.EngineeringStyle };
	c.webRtcConnected = true;
	c.pendingNodeMovements = new Map();
	c.motionControllers = [];
	c.webRtcConnection = {
		isReliableOpen: () => reliableOpen,
		sendReliable: (bytes) => { sent.push(bytes); return true; },
	};
	const ackSet = new Set(acknowledged.map((u) => BigInt(u)));
	c.geometryService = { WasNodeAcknowledged: (uid) => ackSet.has(BigInt(uid)) };
	c.sent = sent;
	return c;
}

const POSE = {
	position: { x: 1, y: 2, z: 3 },
	orientation: { x: 0, y: 0, z: 0, w: 1 },
	scale: { x: 1, y: 1, z: 1 },
};

test('sends nothing when nothing was queued', () => {
	const c = makeStubClient();
	c.SendNodeMovements(0);
	assert.strictEqual(c.sent.length, 0);
});

test('batches every queued node into one command', () => {
	const c = makeStubClient();
	c.QueueNodeMovement(NODE_A, POSE);
	c.QueueNodeMovement(NODE_B, POSE);
	c.SendNodeMovements(0);
	assert.strictEqual(c.sent.length, 1, 'should be a single batched command');
	assert.strictEqual(c.sent[0].length, 9 + 85 * 2);
	const dv = new DataView(c.sent[0].buffer);
	assert.strictEqual(dv.getUint8(0), 6);
	assert.strictEqual(dv.getBigUint64(1, true), 2n);
});

test('coalesces repeated queues for the same node within a tick', () => {
	const c = makeStubClient();
	c.QueueNodeMovement(NODE_A, POSE);
	c.QueueNodeMovement(NODE_A, { ...POSE, position: { x: 9, y: 9, z: 9 } });
	c.SendNodeMovements(0);
	const dv = new DataView(c.sent[0].buffer);
	assert.strictEqual(dv.getBigUint64(1, true), 1n, 'only the last pose should go out');
	assert.strictEqual(dv.getFloat32(9 + 17, true), 9);
});

test('skips nodes the client has not acknowledged', () => {
	const c = makeStubClient({ acknowledged: [NODE_A] });
	c.QueueNodeMovement(NODE_A, POSE);
	c.QueueNodeMovement(NODE_B, POSE);
	c.SendNodeMovements(0);
	const dv = new DataView(c.sent[0].buffer);
	assert.strictEqual(dv.getBigUint64(1, true), 1n);
	assert.strictEqual(dv.getBigUint64(9 + 9, true), NODE_A);
});

test('sends nothing when no node is acknowledged yet', () => {
	const c = makeStubClient({ acknowledged: [] });
	c.QueueNodeMovement(NODE_A, POSE);
	c.SendNodeMovements(0);
	assert.strictEqual(c.sent.length, 0);
});

test('drops the queue when the reliable channel is closed', () => {
	const c = makeStubClient({ reliableOpen: false });
	c.QueueNodeMovement(NODE_A, POSE);
	c.SendNodeMovements(0);
	assert.strictEqual(c.sent.length, 0);
	// Movement is per-tick state: stale poses must not pile up waiting for a channel.
	assert.strictEqual(c.pendingNodeMovements.size, 0);
});

test('clears the queue after sending, so a parked follower sends once', () => {
	const c = makeStubClient();
	c.QueueNodeMovement(NODE_A, POSE);
	c.SendNodeMovements(0);
	c.SendNodeMovements(0);
	assert.strictEqual(c.sent.length, 1);
});

test('stamps server_time_us from the tick', () => {
	const c = makeStubClient();
	c.QueueNodeMovement(NODE_A, POSE);
	c.SendNodeMovements(555000);
	const dv = new DataView(c.sent[0].buffer);
	assert.strictEqual(dv.getBigInt64(9, true), 555000n);
});

test('converts the pose into the client axes standard', () => {
	const c = makeStubClient();
	c.clientAxesStandard = core.AxesStandard.GlStyle;		// server stays Engineering
	c.QueueNodeMovement(NODE_A, { ...POSE, position: { x: 0, y: 0, z: 1 } });
	c.SendNodeMovements(0);
	const dv = new DataView(c.sent[0].buffer);
	// Engineering +Z (up) must arrive as GL +Y (up).
	assert.ok(Math.abs(dv.getFloat32(9 + 17, true)) < 1e-6, 'x');
	assert.strictEqual(dv.getFloat32(9 + 17 + 4, true), 1, 'y should carry the up component');
	assert.ok(Math.abs(dv.getFloat32(9 + 17 + 8, true)) < 1e-6, 'z');
});

test('UpdateMotion runs controllers then flushes what they queued', () => {
	const c = makeStubClient();
	let sawDt = null;
	c.motionControllers.push({
		update(dt, client, nowUs) { sawDt = dt; client.QueueNodeMovement(NODE_A, POSE); },
	});
	c.UpdateMotion(0.05, 1000);
	assert.strictEqual(sawDt, 0.05);
	assert.strictEqual(c.sent.length, 1);
});

test('a throwing controller does not stop the others or the flush', () => {
	const c = makeStubClient();
	c.motionControllers.push({ update() { throw new Error('boom'); } });
	c.motionControllers.push({ update(dt, client) { client.QueueNodeMovement(NODE_A, POSE); } });
	c.UpdateMotion(0.05, 1000);
	assert.strictEqual(c.sent.length, 1);
});
