'use strict';
// Tests for GeometryService.RearmClient: forgetting what a client was sent, while keeping
// what it needs.
//
// A client that loses the stream throws its geometry cache away. When the drop is WebRTC-only
// the signalling connection survives, so the same Client object is reused and every resource is
// still marked sent and acknowledged — nothing would ever be re-sent. The visible result is an
// avatar that stops following and never animates again, which is indistinguishable from the
// server having stopped caring, so it is worth pinning down here.

const test = require('node:test');
const assert = require('node:assert');
const { GeometryService } = require('../client/geometry_service.js');

const CLIP = 7001n;
const NODE = 7002n;

function makeService(clientID) {
	const svc = new GeometryService(clientID);
	svc.SetScene({ GetNode: () => null, GetAllNodeUids: () => [] });
	return svc;
}

test('re-arming offers an acknowledged resource for sending again', () => {
	const svc = makeService(201);
	svc.StreamAnimation(CLIP);
	svc.EncodedResource(CLIP);
	svc.ConfirmResource(CLIP);
	assert.deepStrictEqual(svc.GetAnimationsToSend(), [], 'precondition: nothing left to send');
	assert.strictEqual(svc.WasNodeAcknowledged(CLIP), true);

	const rearmed = GeometryService.RearmClient(201);

	assert.ok(rearmed >= 1, 'should report how many resources it re-armed');
	assert.strictEqual(svc.WasNodeAcknowledged(CLIP), false,
		'the client no longer holds it, so it must not still count as acknowledged');
	assert.deepStrictEqual(svc.GetAnimationsToSend(), [CLIP],
		'the clip must be offered again after a reconnection');
});

test('re-arming keeps the reasons the client wants the resource', () => {
	// The distinction from ForgetClient is the whole point: re-arming must forget only that the
	// resource was delivered, never that it is wanted, or the client would come back empty
	// rather than merely stale. It must also leave the refcount alone, since the thing holding
	// the clip has not let go of it.
	const svc = makeService(202);
	svc.StreamAnimation(CLIP);
	svc.StreamAnimation(CLIP);
	svc.EncodedResource(CLIP);
	svc.ConfirmResource(CLIP);

	GeometryService.RearmClient(202);

	assert.strictEqual(svc.streamedAnimations.get(CLIP), 2, 'the refcount must survive a reconnection');
	assert.deepStrictEqual(svc.GetAnimationsToSend(), [CLIP]);
});

test('re-arming a client that has been sent nothing is a no-op', () => {
	// It runs on every connection, including the first, where there is nothing to forget.
	const svc = makeService(203);
	svc.StreamAnimation(CLIP);
	assert.strictEqual(GeometryService.RearmClient(203), 0);
	assert.deepStrictEqual(svc.GetAnimationsToSend(), [CLIP]);
});

test('re-arming an unknown client is harmless', () => {
	assert.strictEqual(GeometryService.RearmClient(999999), 0);
});
