'use strict';
// Tests for Client.ReceiveNodePoses / ProcessNodePoses.
//
// The decode had three faults, all latent because the only client that populates
// nodePoses does so from OpenXR pose-path assignments, and no Node server sends
// AssignNodePosePath — so numPoses was always 0 and the trailing-pose path never ran:
//   * the per-pose stride was 28 bytes; the wire is NodePose = uid(8) + PoseDynamic_packed(52) = 60,
//     so any message with numPoses > 0 was rejected as malformed and the head pose in it
//     was dropped along with it;
//   * NodePoseDynamic was not imported into client.js, so decoding one would have thrown;
//   * PoseDynamic's decode wrote to this.orientation / this.position, which did not exist
//     on it (they were on this.pose), so it would have thrown again.
// It also stored poses in the client's axes standard rather than the server's.

const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('../client/client');
const message = require('../protocol/message');
const nd = require('../scene/node');
const core = require('../core/core');

const HEADER = message.NodePosesMessage.sizeof();		// 9 + 28 + 2 = 39

// Build a NodePosesMessage with `poses` trailing NodePose records.
// Layout (little-endian):
//   [0..1)    uint8  messagePayloadType
//   [1..9)    int64  timestamp
//   [9..37)   Pose_packed headPose: vec4 orientation then vec3 position
//   [37..39)  uint16 numPoses
//   then numPoses * 60: uid(8) orientation(16) position(12) velocity(12) angularVelocity(12)
function makeNodePosesBuffer(headPose, poses = []) {
	const ab = new ArrayBuffer(HEADER + poses.length * nd.NODE_POSE_SIZE);
	const dv = new DataView(ab);
	dv.setUint8(0, message.MessagePayloadType.ControllerPoses);
	dv.setBigInt64(1, 1234n, true);
	dv.setFloat32(9, headPose.orientation.x, true);
	dv.setFloat32(13, headPose.orientation.y, true);
	dv.setFloat32(17, headPose.orientation.z, true);
	dv.setFloat32(21, headPose.orientation.w, true);
	dv.setFloat32(25, headPose.position.x, true);
	dv.setFloat32(29, headPose.position.y, true);
	dv.setFloat32(33, headPose.position.z, true);
	dv.setUint16(37, poses.length, true);
	let o = HEADER;
	for (const p of poses) {
		dv.setBigUint64(o, BigInt(p.uid), true); o += 8;
		dv.setFloat32(o, p.orientation.x, true); o += 4;
		dv.setFloat32(o, p.orientation.y, true); o += 4;
		dv.setFloat32(o, p.orientation.z, true); o += 4;
		dv.setFloat32(o, p.orientation.w, true); o += 4;
		dv.setFloat32(o, p.position.x, true); o += 4;
		dv.setFloat32(o, p.position.y, true); o += 4;
		dv.setFloat32(o, p.position.z, true); o += 4;
		for (let i = 0; i < 6; i++) { dv.setFloat32(o, 0, true); o += 4; }	// vel + angVel
	}
	assert.strictEqual(o, ab.byteLength);
	return ab;
}

function makeStubClient(serverAxes) {
	const c = Object.create(Client.prototype);
	c.clientID = 1;
	c.clientAxesStandard = core.AxesStandard.NotInitialized;
	c.currentHeadPose = null;
	c.currentHeadPoseTimeUs = 0;
	c.previousHeadPose = null;
	c.previousHeadPoseTimeUs = 0;
	c.currentNodePoses = new Map();
	c.scene = serverAxes !== undefined ? { serverAxesStandard: serverAxes } : null;
	return c;
}

const IDENTITY = { orientation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 1, y: 2, z: 3 } };

test('decodes a head pose with no node poses', () => {
	const c = makeStubClient();
	c.ReceiveNodePoses(makeNodePosesBuffer(IDENTITY));
	assert.ok(c.currentHeadPose, 'head pose should have been stored');
	assert.strictEqual(c.currentHeadPose.position.x, 1);
	assert.strictEqual(c.currentHeadPose.position.y, 2);
	assert.strictEqual(c.currentHeadPose.position.z, 3);
});

test('sizeof matches the C++ static_assert', () => {
	assert.strictEqual(HEADER, 39);
	assert.strictEqual(nd.POSE_PACKED_SIZE, 28);
	assert.strictEqual(nd.POSE_DYNAMIC_PACKED_SIZE, 52);
	assert.strictEqual(nd.NODE_POSE_SIZE, 60);
});

test('decodes trailing node poses at a 60-byte stride', () => {
	const c = makeStubClient();
	const poses = [
		{ uid: 7, orientation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 10, y: 11, z: 12 } },
		{ uid: 9, orientation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 20, y: 21, z: 22 } },
	];
	c.ReceiveNodePoses(makeNodePosesBuffer(IDENTITY, poses));
	// The head pose must survive a message that also carries node poses — the whole
	// point of the stride fix.
	assert.ok(c.currentHeadPose, 'head pose dropped when node poses were present');
	assert.strictEqual(c.currentHeadPose.position.x, 1);
	assert.strictEqual(c.currentNodePoses.size, 2);
	assert.strictEqual(c.currentNodePoses.get(7n).position.x, 10);
	assert.strictEqual(c.currentNodePoses.get(9n).position.z, 22);
});

test('rejects a message whose length does not match its pose count', () => {
	const c = makeStubClient();
	// Claims one pose but carries the old 28-byte stride's worth of bytes.
	const ab = new ArrayBuffer(HEADER + 28);
	const dv = new DataView(ab);
	dv.setUint8(0, message.MessagePayloadType.ControllerPoses);
	dv.setUint16(37, 1, true);
	c.ReceiveNodePoses(ab);
	assert.strictEqual(c.currentHeadPose, null, 'malformed message must not be decoded');
});

test('accepts a Buffer view at a non-zero byteOffset', () => {
	const c = makeStubClient();
	const ab = makeNodePosesBuffer(IDENTITY);
	// Emulate the signaling path: a Node Buffer over a pooled ArrayBuffer, offset in.
	const pool = new ArrayBuffer(ab.byteLength + 16);
	new Uint8Array(pool, 16).set(new Uint8Array(ab));
	const view = Buffer.from(pool, 16, ab.byteLength);
	c.ReceiveNodePoses(view);
	assert.ok(c.currentHeadPose);
	assert.strictEqual(c.currentHeadPose.position.y, 2);
});

test('converts inbound poses from the client axes standard to the server\'s', () => {
	// Client is GlStyle (Y up), server is EngineeringStyle (Z up).
	const c = makeStubClient(core.AxesStandard.EngineeringStyle);
	c.clientAxesStandard = core.AxesStandard.GlStyle;
	// GL (0,1,0) is straight up; Engineering up is +Z, so this must land on z.
	c.ReceiveNodePoses(makeNodePosesBuffer({
		orientation: { x: 0, y: 0, z: 0, w: 1 },
		position: { x: 0, y: 1, z: 0 },
	}));
	const p = c.currentHeadPose.position;
	// Signed zero is expected here: the GL->Engineering map negates a component.
	assert.ok(Math.abs(p.x) < 1e-9, 'x should be zero, got ' + p.x);
	assert.ok(Math.abs(p.y) < 1e-9, 'y should be zero, got ' + p.y);
	assert.strictEqual(p.z, 1, 'GL +Y (up) should convert to Engineering +Z (up)');
});

test('converts inbound poses for a GL server and an Engineering client', () => {
	// The mirror of the case above, and the one a GL-authored scene actually runs: the server
	// is now Y-up and it is the C++/headless client, which declares EngineeringStyle, that
	// needs converting. Engineering up is +Z, so this must land on GL's +Y.
	const c = makeStubClient(core.AxesStandard.GlStyle);
	c.clientAxesStandard = core.AxesStandard.EngineeringStyle;
	c.ReceiveNodePoses(makeNodePosesBuffer({
		orientation: { x: 0, y: 0, z: 0, w: 1 },
		position: { x: 0, y: 0, z: 1 },
	}));
	const p = c.currentHeadPose.position;
	assert.ok(Math.abs(p.x) < 1e-9, 'x should be zero, got ' + p.x);
	assert.strictEqual(p.y, 1, 'Engineering +Z (up) should convert to GL +Y (up)');
	assert.ok(Math.abs(p.z) < 1e-9, 'z should be zero, got ' + p.z);
});

test('leaves inbound poses alone when client and server share a standard', () => {
	// The common case once the server is GL: the web client declares GlStyle too, so the
	// whole conversion path must be a no-op rather than a permutation that happens to cancel.
	const c = makeStubClient(core.AxesStandard.GlStyle);
	c.clientAxesStandard = core.AxesStandard.GlStyle;
	c.ReceiveNodePoses(makeNodePosesBuffer({
		orientation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 1, y: 2, z: 3 },
	}));
	assert.deepStrictEqual(c.currentHeadPose.position, { x: 1, y: 2, z: 3 });
});

test('retains the previous head pose sample', () => {
	const c = makeStubClient();
	c.ReceiveNodePoses(makeNodePosesBuffer(IDENTITY));
	const first = c.currentHeadPose;
	c.ReceiveNodePoses(makeNodePosesBuffer({
		orientation: { x: 0, y: 0, z: 0, w: 1 }, position: { x: 4, y: 5, z: 6 },
	}));
	assert.strictEqual(c.previousHeadPose, first);
	assert.strictEqual(c.currentHeadPose.position.x, 4);
	assert.ok(c.currentHeadPoseTimeUs >= c.previousHeadPoseTimeUs);
});
