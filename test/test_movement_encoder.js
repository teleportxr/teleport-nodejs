'use strict';
// Byte-level tests for the UpdateNodeMovement command, pinned against
// teleport::core::MovementUpdate in TeleportCore/CommonNetworking.h. The struct is
// TELEPORT_PACKED with no padding, so every offset below is exact; if any of these
// change, the C++ client silently misreads node transforms.

const test = require('node:test');
const assert = require('node:assert');
const command = require('../protocol/command');
const enc = require('../protocol/encoders/movement_encoder');
const core = require('../core/core');

// Field offsets within a MovementUpdate record.
const OFF = {
	server_time_us: 0,			// int64
	isGlobal: 8,				// bool
	nodeID: 9,					// uid
	position: 17,				// vec3
	rotation: 29,				// vec4
	scale: 45,					// vec3
	velocity: 57,				// vec3
	angularVelocityAxis: 69,	// vec3
	angularVelocityAngle: 81,	// float
};

function makeUpdate() {
	const u = new command.MovementUpdate();
	u.server_time_us = 123456789n;
	u.isGlobal = false;
	u.nodeID = 42n;
	u.position = { x: 1.5, y: 2.5, z: 3.5 };
	u.rotation = { x: 0.1, y: 0.2, z: 0.3, w: 0.4 };
	u.scale = { x: 1, y: 1, z: 1 };
	u.angularVelocityAngle = 0.75;
	return u;
}

test('MovementUpdate is exactly 85 bytes', () => {
	assert.strictEqual(command.MOVEMENT_UPDATE_SIZE, 85);
	assert.strictEqual(command.MovementUpdate.sizeof(), 85);
	// The offset table must account for every byte, with no gaps.
	assert.strictEqual(OFF.angularVelocityAngle + 4, 85);
});

test('command header is 9 bytes and the tag is UpdateNodeMovement', () => {
	assert.strictEqual(command.UpdateNodeMovementCommand.sizeof(), 9);
	assert.strictEqual(command.CommandPayloadType.UpdateNodeMovement, 6);
	const bytes = enc.buildUpdateNodeMovement([]);
	assert.strictEqual(bytes.length, 9);
	assert.strictEqual(bytes[0], 6);
	const dv = new DataView(bytes.buffer);
	assert.strictEqual(dv.getBigUint64(1, true), 0n);
});

test('total size is 9 + 85*N', () => {
	for (const n of [0, 1, 2, 7]) {
		const updates = [];
		for (let i = 0; i < n; i++) updates.push(makeUpdate());
		assert.strictEqual(enc.buildUpdateNodeMovement(updates).length, 9 + 85 * n);
		assert.strictEqual(enc.updateNodeMovementSize(n), 9 + 85 * n);
	}
});

test('every field lands at its documented offset, little-endian', () => {
	const bytes = enc.buildUpdateNodeMovement([makeUpdate()]);
	const dv = new DataView(bytes.buffer);
	const base = 9;		// past the command header
	assert.strictEqual(dv.getBigInt64(base + OFF.server_time_us, true), 123456789n);
	assert.strictEqual(dv.getUint8(base + OFF.isGlobal), 0);
	assert.strictEqual(dv.getBigUint64(base + OFF.nodeID, true), 42n);
	assert.strictEqual(dv.getFloat32(base + OFF.position, true), 1.5);
	assert.strictEqual(dv.getFloat32(base + OFF.position + 4, true), 2.5);
	assert.strictEqual(dv.getFloat32(base + OFF.position + 8, true), 3.5);
	assert.ok(Math.abs(dv.getFloat32(base + OFF.rotation, true) - 0.1) < 1e-6);
	assert.ok(Math.abs(dv.getFloat32(base + OFF.rotation + 12, true) - 0.4) < 1e-6);
	assert.strictEqual(dv.getFloat32(base + OFF.scale, true), 1);
	// Velocity is deliberately zero: a non-zero value latches the C++ client's heavily
	// damped smoothing filter permanently. See the note on MovementUpdate.
	assert.strictEqual(dv.getFloat32(base + OFF.velocity, true), 0);
	assert.strictEqual(dv.getFloat32(base + OFF.velocity + 4, true), 0);
	assert.strictEqual(dv.getFloat32(base + OFF.velocity + 8, true), 0);
	assert.strictEqual(dv.getFloat32(base + OFF.angularVelocityAxis, true), 0);
	assert.strictEqual(dv.getFloat32(base + OFF.angularVelocityAngle, true), 0.75);
});

test('isGlobal encodes as one byte, true or false', () => {
	const u = makeUpdate();
	u.isGlobal = true;
	const dv = new DataView(enc.buildUpdateNodeMovement([u]).buffer);
	assert.strictEqual(dv.getUint8(9 + OFF.isGlobal), 1);
});

test('server_time_us round-trips as a signed 64-bit value', () => {
	const u = makeUpdate();
	u.server_time_us = -5000n;
	const dv = new DataView(enc.buildUpdateNodeMovement([u]).buffer);
	assert.strictEqual(dv.getBigInt64(9 + OFF.server_time_us, true), -5000n);
});

test('multiple updates are packed back to back with no padding', () => {
	const a = makeUpdate(); a.nodeID = 1n;
	const b = makeUpdate(); b.nodeID = 2n;
	const dv = new DataView(enc.buildUpdateNodeMovement([a, b]).buffer);
	assert.strictEqual(dv.getBigUint64(9 + OFF.nodeID, true), 1n);
	assert.strictEqual(dv.getBigUint64(9 + 85 + OFF.nodeID, true), 2n);
	assert.strictEqual(dv.getBigUint64(1, true), 2n, 'updatesCount');
});
