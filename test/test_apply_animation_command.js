'use strict';
// Byte-level tests for ApplyAnimationCommand.
//
// The client checks this command's length against sizeof(ApplyAnimationCommand) and drops it
// without a word if it differs, so the size is not a detail that can drift: getting it wrong
// produces a server that appears to send animation and a client that appears to ignore it,
// with nothing logged at either end. Offsets are pinned for the same reason — the C++ struct
// is TELEPORT_PACKED and memcpy'd straight out of the packet.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../core/core.js');
const command = require('../protocol/command.js');
const animation_encoder = require('../protocol/encoders/animation_encoder.js');

test('ApplyAnimationCommand is exactly 46 bytes', () => {
	assert.strictEqual(command.APPLY_ANIMATION_COMMAND_SIZE, 46);
	assert.strictEqual(command.ApplyAnimationCommand.sizeof(), 46);
	const bytes = animation_encoder.buildApplyAnimation(new command.ApplyAnimationCommand());
	assert.strictEqual(bytes.byteLength, 46,
		'SessionClient::ReceiveNodeAnimationUpdate requires this size exactly');
});

test('ApplyAnimationCommand field offsets match the packed C++ struct', () => {
	const cmd = new command.ApplyAnimationCommand();
	cmd.animLayer = 0;
	cmd.timestampUs = 1234567n;
	cmd.nodeID = 0x1122334455667788n;
	cmd.cacheID = 0n;
	cmd.animationID = 0x99aabbccddeeff00n;
	cmd.animTimeAtTimestamp = 0.5;
	cmd.speedUnitsPerSecond = 1.25;
	cmd.loop = true;

	const bytes = animation_encoder.buildApplyAnimation(cmd);
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	assert.strictEqual(dv.getUint8(0), command.CommandPayloadType.ApplyNodeAnimation);
	assert.strictEqual(command.CommandPayloadType.ApplyNodeAnimation, 9,
		'ApplyNodeAnimation must keep the C++ enum value');
	assert.strictEqual(dv.getInt32(1, core.endian), 0);
	assert.strictEqual(dv.getBigInt64(5, core.endian), 1234567n);
	assert.strictEqual(dv.getBigUint64(13, core.endian), 0x1122334455667788n);
	assert.strictEqual(dv.getBigUint64(21, core.endian), 0n);
	assert.strictEqual(dv.getBigUint64(29, core.endian), 0x99aabbccddeeff00n);
	assert.strictEqual(dv.getFloat32(37, core.endian), 0.5);
	assert.strictEqual(dv.getFloat32(41, core.endian), 1.25);
	assert.strictEqual(dv.getUint8(45), 1);
});

test('a negative timestampUs round-trips as a signed 64-bit value', () => {
	// timestampUs is int64 on the wire. A client whose session datum is ahead of ours sees
	// legitimately negative values, and encoding them unsigned would place the state roughly
	// 584,000 years in the future, where it can never become current.
	const cmd = new command.ApplyAnimationCommand();
	cmd.timestampUs = -250000n;
	const bytes = animation_encoder.buildApplyAnimation(cmd);
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	assert.strictEqual(dv.getBigInt64(5, core.endian), -250000n);
});

test('loop encodes as a single byte, not a word', () => {
	const cmd = new command.ApplyAnimationCommand();
	cmd.loop = false;
	const bytes = animation_encoder.buildApplyAnimation(cmd);
	assert.strictEqual(bytes[45], 0);
	assert.strictEqual(bytes.byteLength, 46);
});
