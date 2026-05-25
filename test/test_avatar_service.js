'use strict';
// Tests for the per-client AvatarService introduced in Phase 2 of the
// avatars implementation plan. The service:
//   * serialises a policy and emits it as an avatar-policy text frame;
//   * receives an avatar-offer and replies with avatar-result.
// Phase 2 always replies status=using_default for a matching policy and
// status=rejected,reasons=[policy_unknown] for anything else.

const test		= require('node:test');
const assert	= require('node:assert');

const avatars			= require('../protocol/avatars.js');
const avatar_service	= require('../client/avatar_service.js');

// Tiny helper that captures every signaling string the service emits.
function makeSink() {
	const sent = [];
	return { send: (s) => sent.push(JSON.parse(s)), sent };
}

test('sendPolicy emits an avatar-policy envelope with the policy content', () => {
	const sink = makeSink();
	const svc  = new avatar_service.AvatarService(42n, sink.send);
	const policy = new avatars.AvatarPolicy({
		policy_id: 12345n,
		requirement: 'optional',
		default_available: true,
		requirements: { formats: ['glb'], max_file_bytes: 8388608 },
	});
	svc.sendPolicy(policy);
	assert.strictEqual(sink.sent.length, 1);
	const msg = sink.sent[0];
	assert.strictEqual(msg['teleport-signal-type'], 'avatar-policy');
	assert.strictEqual(msg.content.policy_id, 12345);
	assert.strictEqual(msg.content.requirement, 'optional');
	assert.strictEqual(msg.content.default_available, true);
	assert.deepStrictEqual(msg.content.requirements.formats, ['glb']);
});

test('handleOffer replies with using_default when policy_id matches', () => {
	const sink = makeSink();
	const svc  = new avatar_service.AvatarService(42n, sink.send);
	svc.sendPolicy(new avatars.AvatarPolicy({ policy_id: 7n, default_available: true }));
	sink.sent.length = 0;
	svc.handleOffer({ policy_id: 7, have_avatar: false });
	assert.strictEqual(sink.sent.length, 1);
	const msg = sink.sent[0];
	assert.strictEqual(msg['teleport-signal-type'], 'avatar-result');
	assert.strictEqual(msg.content.policy_id, 7);
	assert.strictEqual(msg.content.status, 'using_default');
	assert.strictEqual(msg.content.using_default, true);
	assert.strictEqual(msg.content.delivery, 'import');
	assert.strictEqual(msg.content.node_uid, 0);
	assert.deepStrictEqual(msg.content.reasons, []);
});

test('handleOffer still replies using_default when client supplies an avatar', () => {
	// Phase 2 ignores the offer contents entirely; this asserts that we
	// don't accidentally accept a URL.
	const sink = makeSink();
	const svc  = new avatar_service.AvatarService(42n, sink.send);
	svc.sendPolicy(new avatars.AvatarPolicy({ policy_id: 9n, default_available: true }));
	sink.sent.length = 0;
	svc.handleOffer({
		policy_id: 9,
		have_avatar: true,
		url: 'https://example.com/avatar.glb',
		content_hash: 'sha256:abcd',
		declared: { format: 'glb', file_bytes: 4096 },
	});
	assert.strictEqual(sink.sent[0].content.status, 'using_default');
	assert.strictEqual(sink.sent[0].content.using_default, true);
});

test('handleOffer rejects with policy_unknown when policy_id does not match', () => {
	const sink = makeSink();
	const svc  = new avatar_service.AvatarService(42n, sink.send);
	svc.sendPolicy(new avatars.AvatarPolicy({ policy_id: 100n, default_available: true }));
	sink.sent.length = 0;
	svc.handleOffer({ policy_id: 999, have_avatar: false });
	const msg = sink.sent[0];
	assert.strictEqual(msg.content.status, 'rejected');
	assert.deepStrictEqual(msg.content.reasons, ['policy_unknown']);
});

test('handleOffer rejects when no policy has been sent yet', () => {
	const sink = makeSink();
	const svc  = new avatar_service.AvatarService(42n, sink.send);
	svc.handleOffer({ policy_id: 1, have_avatar: false });
	assert.strictEqual(sink.sent[0].content.status, 'rejected');
	assert.deepStrictEqual(sink.sent[0].content.reasons, ['policy_unknown']);
});

test('handleRevoke clears cached offer state without emitting anything', () => {
	const sink = makeSink();
	const svc  = new avatar_service.AvatarService(42n, sink.send);
	svc.sendPolicy(new avatars.AvatarPolicy({ policy_id: 5n }));
	svc.handleOffer({ policy_id: 5, have_avatar: false });
	sink.sent.length = 0;
	svc.handleRevoke({ policy_id: 5 });
	assert.strictEqual(sink.sent.length, 0);
	assert.strictEqual(svc.lastOffer, null);
	assert.strictEqual(svc.lastResult, null);
});

test('signaling dispatch: avatar-offer routed to handleAvatarOffer', () => {
	// Round-trip the dispatch path: build a SignalingClient stub, attach a
	// handler, and feed it a JSON frame. Reaching into the module the same
	// way test_avatars.js does because SignalingClient is not exported.
	const fs		= require('node:fs');
	const path		= require('node:path');
	const Module	= require('node:module');
	const src		= fs.readFileSync(path.join(__dirname, '..', 'signaling.js'), 'utf8');
	const m			= new Module(require.resolve('../signaling.js'));
	m.filename = require.resolve('../signaling.js');
	m.paths = Module._nodeModulePaths(m.filename);
	m._compile(src + '\nmodule.exports._SignalingClient = SignalingClient;'
		+ '\nmodule.exports._receiveWebSocketsMessage = receiveWebSocketsMessage;\n', m.filename);
	const SignalingClient = m.exports._SignalingClient;
	const receive		  = m.exports._receiveWebSocketsMessage;

	const sc = new SignalingClient('1.2.3.4', { send: () => {} }, 1n);
	let receivedOffer = null;
	sc.handleAvatarOffer = (o) => { receivedOffer = o; };
	let receivedRevoke = null;
	sc.handleAvatarRevoke = (r) => { receivedRevoke = r; };

	receive(1n, sc, JSON.stringify({
		'teleport-signal-type': 'avatar-offer',
		content: { policy_id: 1, have_avatar: false },
	}));
	assert.deepStrictEqual(receivedOffer, { policy_id: 1, have_avatar: false });

	receive(1n, sc, JSON.stringify({
		'teleport-signal-type': 'avatar-revoke',
		content: { policy_id: 1, reason: 'replaced' },
	}));
	assert.deepStrictEqual(receivedRevoke, { policy_id: 1, reason: 'replaced' });
});
