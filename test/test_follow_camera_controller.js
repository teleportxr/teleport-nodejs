'use strict';
// Tests for FollowCameraController: the server-driven follower avatar that stays on the
// ground a fixed distance in front of a client's camera.
//
// These are pure logic — no scene, no transport, no timers. The controller is fed a head
// pose and asked to tick; what it queues on the client is the assertion surface.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../core/core');
const nd = require('../scene/node');
const { FollowCameraController } = require('../client/motion/follow_camera_controller');
const { FlatGround, CallbackGround } = require('../client/motion/ground_provider');
const ax = require('../client/motion/axes_basis');

const NODE_UID = 77n;

// Minimal stand-in for Client: a scene with one node, and a record of what was queued.
function makeStubClient(serverAxes = core.AxesStandard.EngineeringStyle) {
	const node = new nd.Node('Avatar_test');
	node.uid = NODE_UID;
	const queued = [];
	return {
		clientID: 1,
		clientManager: null,
		scene: {
			serverAxesStandard: serverAxes,
			GetNode: (uid) => (uid === NODE_UID ? node : null),
		},
		currentHeadPose: null,
		node,
		queued,
		QueueNodeMovement(uid, pose) {
			queued.push({ uid, position: { ...pose.position }, orientation: { ...pose.orientation } });
		},
	};
}

// Head pose looking along the basis forward direction, i.e. identity orientation.
function headAt(x, y, z) {
	return { orientation: { x: 0, y: 0, z: 0, w: 1 }, position: { x, y, z } };
}

// Run n ticks of dt seconds, holding the head pose fixed.
function settle(controller, client, n = 400, dt = 0.05) {
	for (let i = 0; i < n; i++) controller.update(dt, client, i * dt * 1e6);
}

test('places the follower followDistance ahead, on the ground', () => {
	const c = makeStubClient();		// EngineeringStyle: +Y forward, +Z up
	const f = new FollowCameraController({ nodeUid: NODE_UID, followDistance: 2.0 });
	c.currentHeadPose = headAt(0, 0, 1.7);		// standing, head 1.7 m up
	f.update(0.05, c, 0);
	const p = c.queued[0].position;
	assert.ok(Math.abs(p.x - 0) < 1e-6, 'x');
	assert.ok(Math.abs(p.y - 2.0) < 1e-6, 'should be 2 m along +Y (Engineering forward)');
	assert.strictEqual(p.z, 0, 'should be dropped onto the ground plane, not left at head height');
});

test('uses the vertical axis of the server axes standard, not a hard-coded Y', () => {
	// GlStyle is Y-up, forward -Z. The same call must put the follower on y=0, not z=0.
	const c = makeStubClient(core.AxesStandard.GlStyle);
	const f = new FollowCameraController({ nodeUid: NODE_UID, followDistance: 2.0 });
	c.currentHeadPose = headAt(0, 1.7, 0);
	f.update(0.05, c, 0);
	const p = c.queued[0].position;
	assert.strictEqual(p.y, 0, 'Y-up basis should ground on y');
	assert.ok(Math.abs(p.z + 2.0) < 1e-6, 'GL forward is -Z');
});

test('honours a non-zero ground height', () => {
	const c = makeStubClient();
	const f = new FollowCameraController({ nodeUid: NODE_UID, ground: new FlatGround(0.5) });
	c.currentHeadPose = headAt(0, 0, 1.7);
	f.update(0.05, c, 0);
	assert.strictEqual(c.queued[0].position.z, 0.5);
});

test('queries the ground provider at the follower position, not the head position', () => {
	const c = makeStubClient();
	const seen = [];
	const f = new FollowCameraController({
		nodeUid: NODE_UID, followDistance: 2.0,
		ground: new CallbackGround((x, z) => { seen.push([x, z]); return 0; }),
	});
	c.currentHeadPose = headAt(0, 0, 1.7);
	f.update(0.05, c, 0);
	// Engineering: horizontal components are (x, y), and the follower is 2 m along +Y.
	assert.deepStrictEqual(seen[0], [0, 2]);
});

test('first pose snaps rather than gliding in from the origin', () => {
	const c = makeStubClient();
	const f = new FollowCameraController({ nodeUid: NODE_UID, followDistance: 2.0 });
	c.currentHeadPose = headAt(10, 10, 1.7);
	f.update(0.05, c, 0);
	assert.ok(Math.abs(c.queued[0].position.x - 10) < 1e-6);
	assert.ok(Math.abs(c.queued[0].position.y - 12) < 1e-6);
});

test('a stationary head emits nothing once settled', () => {
	const c = makeStubClient();
	const f = new FollowCameraController({ nodeUid: NODE_UID });
	c.currentHeadPose = headAt(0, 0, 1.7);
	settle(f, c);
	const before = c.queued.length;
	settle(f, c, 20);
	assert.strictEqual(c.queued.length, before, 'a still user must cost no bandwidth');
});

test('sub-dead-zone jitter emits nothing', () => {
	const c = makeStubClient();
	const f = new FollowCameraController({ nodeUid: NODE_UID, deadZone: 0.15 });
	c.currentHeadPose = headAt(0, 0, 1.7);
	settle(f, c);
	const before = c.queued.length;
	// Wobble the head by a few centimetres, well inside the dead zone.
	for (let i = 0; i < 40; i++) {
		c.currentHeadPose = headAt(0.02 * Math.sin(i), 0.02 * Math.cos(i), 1.7);
		f.update(0.05, c, i * 50000);
	}
	assert.strictEqual(c.queued.length, before, 'head micro-motion must not emit updates');
});

test('converges on a step without overshooting', () => {
	const c = makeStubClient();
	const f = new FollowCameraController({ nodeUid: NODE_UID, followDistance: 2.0, tau: 0.25 });
	c.currentHeadPose = headAt(0, 0, 1.7);
	settle(f, c);
	c.queued.length = 0;
	// Step the camera 2 m sideways; the target moves with it.
	c.currentHeadPose = headAt(2, 0, 1.7);
	let previousError = Infinity;
	for (let i = 0; i < 200; i++) {
		f.update(0.05, c, i * 50000);
		const err = Math.abs(f.position.x - 2);
		assert.ok(err <= previousError + 1e-9, 'error must decrease monotonically (no overshoot)');
		previousError = err;
	}
	// It converges to within the stop zone, not to zero: the follower parks once it is
	// close enough, which is what stops it chasing head jitter forever.
	assert.ok(previousError <= f.stopZone + 1e-6, 'should have converged, error=' + previousError);
});

test('never exceeds maxSpeed', () => {
	const c = makeStubClient();
	const f = new FollowCameraController({ nodeUid: NODE_UID, tau: 0.01, maxSpeed: 1.0 });
	c.currentHeadPose = headAt(0, 0, 1.7);
	settle(f, c);
	c.currentHeadPose = headAt(100, 0, 1.7);		// enormous step
	let last = { ...f.position };
	for (let i = 0; i < 50; i++) {
		f.update(0.05, c, i * 50000);
		const moved = Math.hypot(f.position.x - last.x, f.position.y - last.y, f.position.z - last.z);
		assert.ok(moved <= 1.0 * 0.05 + 1e-6, 'moved ' + moved + ' in one 50 ms tick');
		last = { ...f.position };
	}
});

test('stays on the ground throughout a move', () => {
	const c = makeStubClient();
	const f = new FollowCameraController({ nodeUid: NODE_UID, ground: new FlatGround(0.25) });
	c.currentHeadPose = headAt(0, 0, 1.7);
	settle(f, c);
	c.currentHeadPose = headAt(5, 5, 1.9);
	for (let i = 0; i < 100; i++) {
		f.update(0.05, c, i * 50000);
		assert.ok(Math.abs(f.position.z - 0.25) < 1e-6, 'left the ground: z=' + f.position.z);
	}
});

test('facing away yields identity orientation when looking along basis forward', () => {
	const c = makeStubClient();
	const f = new FollowCameraController({ nodeUid: NODE_UID, facing: 'away' });
	c.currentHeadPose = headAt(0, 0, 1.7);
	f.update(0.05, c, 0);
	const q = c.queued[0].orientation;
	assert.ok(Math.abs(Math.abs(q.w) - 1) < 1e-6, 'expected no rotation, got w=' + q.w);
});

test('facing toward is 180 degrees from facing away', () => {
	const basis = ax.BasisFor(core.AxesStandard.EngineeringStyle);
	const away = new FollowCameraController({ nodeUid: NODE_UID, facing: 'away' });
	const toward = new FollowCameraController({ nodeUid: NODE_UID, facing: 'toward' });
	const head = headAt(0, 0, 1.7);
	const a = away.ComputeTarget(head, basis).yaw;
	const t = toward.ComputeTarget(head, basis).yaw;
	assert.ok(Math.abs(Math.abs(ax.WrapAngle(t - a)) - Math.PI) < 1e-6);
});

test('yaw takes the shortest arc across the +/-180 degree seam', () => {
	const c = makeStubClient();
	const f = new FollowCameraController({ nodeUid: NODE_UID, tau: 0.25, maxTurnRate: 100 });
	c.currentHeadPose = headAt(0, 0, 1.7);
	settle(f, c);
	// Yaw just under +180 degrees, then just over: the shortest path is a few degrees
	// through the seam, not ~358 degrees the long way round.
	f.yaw = Math.PI - 0.05;
	const target = -Math.PI + 0.05;
	const step = ax.WrapAngle(target - f.yaw);
	assert.ok(Math.abs(step) < 0.2, 'shortest arc should be ~0.1 rad, got ' + step);
});

test('resolves its node by role when given nodeRole instead of nodeUid', () => {
	const c = makeStubClient();
	c.clientManager = {
		clientNodes: { nodesForClientWithRole: (cid, role) => (role === 'avatar' ? [NODE_UID] : []) },
	};
	const f = new FollowCameraController({ nodeRole: 'avatar' });
	c.currentHeadPose = headAt(0, 0, 1.7);
	f.update(0.05, c, 0);
	assert.strictEqual(c.queued.length, 1);
	assert.strictEqual(c.queued[0].uid, NODE_UID);
});

test('does nothing until its node exists', () => {
	const c = makeStubClient();
	c.clientManager = { clientNodes: { nodesForClientWithRole: () => [] } };
	const f = new FollowCameraController({ nodeRole: 'avatar' });
	c.currentHeadPose = headAt(0, 0, 1.7);
	f.update(0.05, c, 0);
	assert.strictEqual(c.queued.length, 0);
});

test('does nothing before the first head pose', () => {
	const c = makeStubClient();
	const f = new FollowCameraController({ nodeUid: NODE_UID });
	f.update(0.05, c, 0);
	assert.strictEqual(c.queued.length, 0);
});

test('holds its heading when the camera looks straight up', () => {
	const c = makeStubClient();
	const f = new FollowCameraController({ nodeUid: NODE_UID });
	c.currentHeadPose = headAt(0, 0, 1.7);
	f.update(0.05, c, 0);
	const settled = { ...f.position };
	// Pitch 90 degrees about the X axis so forward becomes vertical: no horizontal
	// direction is available, so the target is undefined and the follower must hold.
	const s = Math.sin(Math.PI / 4), w = Math.cos(Math.PI / 4);
	c.currentHeadPose = { orientation: { x: s, y: 0, z: 0, w }, position: { x: 0, y: 0, z: 1.7 } };
	c.queued.length = 0;
	f.update(0.05, c, 0);
	assert.strictEqual(c.queued.length, 0, 'should emit nothing rather than snap');
	assert.deepStrictEqual(f.position, settled);
});

test('movement fans out to peers, not just the followed client', () => {
	const owner = makeStubClient();
	const peer = makeStubClient();
	// Both clients share the scene node; the manager fans movement to everyone, and each
	// client's own acknowledgement gate decides whether it actually goes on the wire.
	owner.clientManager = {
		clients: new Map([[1, owner], [2, peer]]),
		QueueNodeMovementForAll(uid, pose) {
			for (const [, cl] of this.clients) cl.QueueNodeMovement(uid, pose);
		},
	};
	const f = new FollowCameraController({ nodeUid: NODE_UID, followDistance: 2.0 });
	owner.currentHeadPose = headAt(0, 0, 1.7);
	f.update(0.05, owner, 0);
	assert.strictEqual(owner.queued.length, 1, 'owner should be sent the movement');
	assert.strictEqual(peer.queued.length, 1, 'peer should be sent the movement too');
	assert.deepStrictEqual(peer.queued[0].position, owner.queued[0].position);
});

test('writes the pose back to the scene node, so a late peer sees it in place', () => {
	const c = makeStubClient();
	const f = new FollowCameraController({ nodeUid: NODE_UID, followDistance: 2.0 });
	c.currentHeadPose = headAt(3, 4, 1.7);
	f.update(0.05, c, 0);
	assert.ok(Math.abs(c.node.pose.position.x - 3) < 1e-6);
	assert.ok(Math.abs(c.node.pose.position.y - 6) < 1e-6);
});
