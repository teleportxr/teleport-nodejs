'use strict';
// Node.encodedSize() must be a buffer size encodeNode can actually write into.
//
// This was previously a fixed 500 in SendNode. Sizing it from the node's contents is what
// lets a mesh component carry variable-length joint, animation and material lists — but it
// also means an arithmetic slip becomes a runtime failure at send time rather than a
// compile error. The first version of it referenced `Pose.size`, which has never existed:
// the total came out NaN, `new ArrayBuffer(NaN)` produced a zero-length buffer, and the
// server died on the first node it tried to send.
//
// So these tests check two things about every shape of node: that the figure is finite, and
// that a real encode fits inside it.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../core/core.js');
const nd = require('../scene/node.js');
const node_encoder = require('../protocol/encoders/node_encoder.js');

function assertEncodesWithin(node) {
	const size = node.encodedSize();
	assert.ok(Number.isFinite(size), `encodedSize returned ${size} for node "${node.name}"`);
	assert.ok(size > 0, `encodedSize returned ${size} for node "${node.name}"`);
	const buffer = new ArrayBuffer(size);
	const written = node_encoder.encodeNode(buffer && node, buffer,
		core.AxesStandard.EngineeringStyle, core.AxesStandard.EngineeringStyle);
	assert.ok(written <= size,
		`node "${node.name}" wrote ${written} bytes into a ${size}-byte buffer`);
	return { size, written };
}

test('Pose.sizeof is the 40-byte unpacked transform written into a Node payload', () => {
	// The three sizes here are easy to confuse. The Node payload carries position,
	// orientation AND scale; the packed forms used for pose reports carry no scale.
	assert.strictEqual(nd.Pose.sizeof(), 40);
	assert.strictEqual(nd.POSE_PACKED_SIZE, 28);
	assert.strictEqual(nd.NODE_POSE_SIZE, 60);
	assert.strictEqual(nd.Pose.size, undefined,
		'there is no such property; referencing it yields NaN, which is how this broke');
});

test('a bare node sizes and encodes', () => {
	assertEncodesWithin(new nd.Node('Player'));
});

test('a node with a mesh component sizes and encodes', () => {
	const node = new nd.Node('Avatar_19');
	node.setMeshComponent('/placeholder_avatar.glb');
	assertEncodesWithin(node);
});

test('a node with a long name sizes and encodes', () => {
	assertEncodesWithin(new nd.Node('a-node-with-a-very-'.repeat(12) + 'long-name'));
});

test('a mesh component grows with its joint, animation and material lists', () => {
	// These three lists were hard-coded to zero in the encoder, so a component carrying
	// them silently sent none. Now that they are written, the size has to follow them.
	const bare = new nd.Node('Skinned');
	bare.setMeshComponent('/avatar.glb');
	const bareSize = bare.encodedSize();

	const loaded = new nd.Node('Skinned');
	loaded.setMeshComponent('/avatar.glb');
	const mesh = loaded.components.find((c) => c.getType() === nd.NodeDataType.Mesh);
	mesh.joint_indices = [0, 1, 2, 3, 4, 5, 6, 7];
	mesh.materials = [11n, 12n, 13n];
	assert.ok(loaded.encodedSize() > bareSize,
		'a component carrying joints and materials must be sized larger than a bare one');
	assertEncodesWithin(loaded);
});

test('animation uids are excluded from the size while they are excluded from the payload', () => {
	// Listing a clip in the node payload makes the client block node completion on it, so
	// they are deliberately not sent. Size and encoding must agree about that, in both
	// settings of the switch.
	const node = new nd.Node('Avatar');
	node.setMeshComponent('/avatar.glb');
	const mesh = node.components.find((c) => c.getType() === nd.NodeDataType.Mesh);
	mesh.animations = [101n, 102n, 103n];

	const withoutAnimations = node.encodedSize();
	assertEncodesWithin(node);

	nd.SetSendAnimationUidsInNode(true);
	try {
		assert.strictEqual(node.encodedSize(), withoutAnimations + 3 * 8);
		assertEncodesWithin(node);
	} finally {
		nd.SetSendAnimationUidsInNode(false);
	}
	assert.strictEqual(node.encodedSize(), withoutAnimations,
		'the switch must default back off');
});
