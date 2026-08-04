'use strict';
// Tests for animation streaming in GeometryService.
//
// Animation clips ride the same TrackedResource machinery as meshes and textures — sent
// bitset, acknowledged bitset, per-client send timestamps — but they are the first resource
// type that is not derived from the node graph. A clip is asked for explicitly by whatever is
// driving the node, so the refcount is the only thing keeping it alive, and getting it wrong
// either leaks a clip for the life of the process or drops one that is still in use.

const test = require('node:test');
const assert = require('node:assert');
const { GeometryService } = require('../client/geometry_service.js');

const CLIP_A = 5001n;
const CLIP_B = 5002n;

function makeService(clientID) {
	const svc = new GeometryService(clientID);
	// GetResourcesToSend consults the scene only through node pruning, which animations do
	// not use; a stub keeps the test independent of scene.js.
	svc.SetScene({ GetNode: () => null, GetAllNodeUids: () => [] });
	return svc;
}

test('a streamed animation is offered for sending, once', () => {
	const svc = makeService(101);
	svc.StreamAnimation(CLIP_A);
	assert.deepStrictEqual(svc.GetAnimationsToSend(), [CLIP_A]);

	// Still unsent, so still offered — EncodedResource is what records the send, and it is
	// called only after the transport accepts the buffer.
	assert.deepStrictEqual(svc.GetAnimationsToSend(), [CLIP_A]);

	svc.EncodedResource(CLIP_A);
	assert.deepStrictEqual(svc.GetAnimationsToSend(), [],
		'a clip in flight must not be sent again immediately');
});

test('acknowledgement stops the clip being offered again', () => {
	const svc = makeService(102);
	svc.StreamAnimation(CLIP_A);
	svc.EncodedResource(CLIP_A);
	svc.ConfirmResource(CLIP_A);
	assert.deepStrictEqual(svc.GetAnimationsToSend(), []);
	assert.strictEqual(svc.WasNodeAcknowledged(CLIP_A), true);
});

test('an unacknowledged clip is offered again once the timeout expires', () => {
	// The client may simply never answer — a dropped chunk, a broken send path. Without the
	// resend the avatar would stand still for the rest of the session.
	const svc = makeService(103);
	svc.timeout_us = 0;
	svc.StreamAnimation(CLIP_A);
	svc.EncodedResource(CLIP_A);
	assert.deepStrictEqual(svc.GetAnimationsToSend(), [CLIP_A],
		'a clip sent longer ago than timeout_us should be offered again');
});

test('the refcount holds a clip until every reason for it is withdrawn', () => {
	const svc = makeService(104);
	svc.StreamAnimation(CLIP_A);
	svc.StreamAnimation(CLIP_A);
	assert.strictEqual(svc.streamedAnimations.get(CLIP_A), 2);

	svc.UnstreamAnimation(CLIP_A);
	assert.strictEqual(svc.streamedAnimations.get(CLIP_A), 1,
		'one holder letting go must not drop a clip another still wants');
	assert.deepStrictEqual(svc.GetAnimationsToSend(), [CLIP_A]);

	svc.UnstreamAnimation(CLIP_A);
	assert.strictEqual(svc.streamedAnimations.has(CLIP_A), false);
	assert.deepStrictEqual(svc.GetAnimationsToSend(), []);
});

test('unstreaming a clip that was never streamed is harmless', () => {
	const svc = makeService(105);
	svc.UnstreamAnimation(CLIP_A);
	svc.UnstreamAnimation(0n);
	assert.strictEqual(svc.streamedAnimations.size, 0);
});

test('clips are tracked per client', () => {
	// Two clients streaming the same clip must not see each other's send state: the resource
	// record is shared, but the bitsets in it are indexed by client.
	const a = makeService(106);
	const b = makeService(107);
	a.StreamAnimation(CLIP_A);
	b.StreamAnimation(CLIP_A);

	a.EncodedResource(CLIP_A);
	a.ConfirmResource(CLIP_A);

	assert.deepStrictEqual(a.GetAnimationsToSend(), []);
	assert.deepStrictEqual(b.GetAnimationsToSend(), [CLIP_A],
		"one client's acknowledgement must not suppress another's send");

	GeometryService.ForgetClient(106);
	GeometryService.ForgetClient(107);
});

test('a departed client leaves no acknowledgement behind for the next one', () => {
	// Client indices are recycled. A new client inheriting a departed one's index must not
	// inherit its "already has this clip" state, or it would never be sent the clip at all.
	const svc = makeService(108);
	svc.StreamAnimation(CLIP_B);
	svc.EncodedResource(CLIP_B);
	svc.ConfirmResource(CLIP_B);
	assert.strictEqual(svc.WasNodeAcknowledged(CLIP_B), true);

	GeometryService.ForgetClient(108);

	const reused = makeService(109);
	reused.StreamAnimation(CLIP_B);
	assert.strictEqual(reused.WasNodeAcknowledged(CLIP_B), false);
	assert.deepStrictEqual(reused.GetAnimationsToSend(), [CLIP_B]);
	GeometryService.ForgetClient(109);
});

test('WereResourcesAcknowledged is all-or-nothing', () => {
	// The gate on sending an ApplyAnimation: naming a node or a clip the client has not
	// confirmed means the command is dropped on arrival, with nothing to retry it.
	const svc = makeService(110);
	svc.StreamAnimation(CLIP_A);
	svc.StreamAnimation(CLIP_B);
	svc.EncodedResource(CLIP_A);
	svc.ConfirmResource(CLIP_A);

	assert.strictEqual(svc.WereResourcesAcknowledged([CLIP_A]), true);
	assert.strictEqual(svc.WereResourcesAcknowledged([CLIP_A, CLIP_B]), false);

	svc.EncodedResource(CLIP_B);
	svc.ConfirmResource(CLIP_B);
	assert.strictEqual(svc.WereResourcesAcknowledged([CLIP_A, CLIP_B]), true);
	GeometryService.ForgetClient(110);
});
