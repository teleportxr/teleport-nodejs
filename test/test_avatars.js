'use strict';
// Unit tests for the avatar-negotiation JSON codecs in protocol/avatars.js
// and the connect-time `capabilities` parsing in signaling.js.
// Mirrors the C++ test suite in Teleport/test/test_avatars.cpp so a
// regression on either side surfaces in matching test cases.

const test = require('node:test');
const assert = require('node:assert');

const avatars = require('../protocol/avatars.js');

test('decodeCapabilities returns all-false for missing / empty / non-object input', () => {
	assert.deepStrictEqual(avatars.decodeCapabilities(undefined), { avatar_relay: false });
	assert.deepStrictEqual(avatars.decodeCapabilities(null),      { avatar_relay: false });
	assert.deepStrictEqual(avatars.decodeCapabilities({}),        { avatar_relay: false });
	assert.deepStrictEqual(avatars.decodeCapabilities('nope'),    { avatar_relay: false });
});

test('decodeCapabilities reads avatar_relay and ignores unknown future keys', () => {
	const caps = avatars.decodeCapabilities({ avatar_relay: true, future_flag: 'whatever' });
	assert.strictEqual(caps.avatar_relay, true);
	assert.strictEqual('future_flag' in caps, false);
});

test('decodeCapabilities ignores non-boolean avatar_relay', () => {
	const caps = avatars.decodeCapabilities({ avatar_relay: 'yes' });
	assert.strictEqual(caps.avatar_relay, false);
});

test('encodeCapabilities drops unknown keys and coerces to boolean', () => {
	assert.deepStrictEqual(avatars.encodeCapabilities({ avatar_relay: 1, junk: 'x' }), { avatar_relay: true });
	assert.deepStrictEqual(avatars.encodeCapabilities({}),                              { avatar_relay: false });
});

test('AvatarPolicy: toJSON / parseAvatarPolicy round-trip', () => {
	const policy = new avatars.AvatarPolicy({
		policy_id: 12345n,
		requirement: 'required',
		default_available: true,
		requirements: { formats: ['glb', 'vrm'], max_file_bytes: 8388608, max_triangles: 60000, skeleton: 'humanoid' },
		proof: { required: true, accepted_schemes: ['jws-detached', 'well-known-url'] },
		fetch_timeout_ms: 7500,
	});
	const wire = JSON.parse(JSON.stringify(policy));
	const parsed = avatars.parseAvatarPolicy(wire);
	assert.strictEqual(parsed.policy_id,         12345n);
	assert.strictEqual(parsed.requirement,       'required');
	assert.strictEqual(parsed.default_available, true);
	assert.deepStrictEqual(parsed.requirements.formats, ['glb', 'vrm']);
	assert.strictEqual(parsed.proof.required, true);
	assert.deepStrictEqual(parsed.proof.accepted_schemes, ['jws-detached', 'well-known-url']);
	assert.strictEqual(parsed.fetch_timeout_ms, 7500);
});

test('parseAvatarOffer handles the have_avatar=false short-form', () => {
	const o = avatars.parseAvatarOffer({ policy_id: 7, have_avatar: false });
	assert.strictEqual(o.policy_id, 7n);
	assert.strictEqual(o.have_avatar, false);
	assert.strictEqual(o.url, undefined);
	assert.strictEqual(o.declared, undefined);
});

test('parseAvatarOffer + encodeAvatarOffer round-trip a full offer', () => {
	const offer = {
		policy_id: 42n,
		have_avatar: true,
		url: 'https://avatars.example.com/u/42.glb',
		content_hash: 'sha256:abcd',
		declared: { format: 'glb', file_bytes: 4096, triangles: 1200 },
		proof: { scheme: 'jws-detached', value: 'eyJ...' },
		allow_relay: false,
	};
	const wire = avatars.encodeAvatarOffer(offer);
	const back = avatars.parseAvatarOffer(wire);
	assert.strictEqual(back.policy_id, 42n);
	assert.strictEqual(back.have_avatar, true);
	assert.strictEqual(back.url, offer.url);
	assert.strictEqual(back.content_hash, offer.content_hash);
	assert.deepStrictEqual(back.declared, offer.declared);
	assert.deepStrictEqual(back.proof, offer.proof);
	assert.strictEqual(back.allow_relay, false);
});

test('encodeAvatarResult fills sensible defaults for missing fields', () => {
	const r = avatars.encodeAvatarResult({ policy_id: 3n, status: 'accepted', node_uid: 999n, delivery: 'relay' });
	assert.strictEqual(r.policy_id, 3);
	assert.strictEqual(r.status, 'accepted');
	assert.strictEqual(r.node_uid, 999);
	assert.strictEqual(r.using_default, false);
	assert.strictEqual(r.delivery, 'relay');
	assert.deepStrictEqual(r.reasons, []);
});

test('encodeAvatarRevoke produces the expected envelope', () => {
	assert.deepStrictEqual(
		avatars.encodeAvatarRevoke({ policy_id: 17n, reason: 'licence_expired' }),
		{ policy_id: 17, reason: 'licence_expired' }
	);
});

test('encodePeerAvatar carries url / hash / format / proof', () => {
	const wire = avatars.encodePeerAvatar({
		peer_client_id: 100n,
		peer_node_uid: 200n,
		url: 'https://example.com/a.glb',
		content_hash: 'sha256:ff',
		format: 'glb',
		proof: { scheme: 'well-known-url', value: 'https://example.com/.well-known/avatar-binding' },
	});
	assert.strictEqual(wire.peer_client_id, 100);
	assert.strictEqual(wire.peer_node_uid, 200);
	assert.strictEqual(wire.url, 'https://example.com/a.glb');
	assert.strictEqual(wire.content_hash, 'sha256:ff');
	assert.strictEqual(wire.format, 'glb');
	assert.strictEqual(wire.proof.scheme, 'well-known-url');
	assert.strictEqual(wire.revoked, false);
});

test('parsePeerAvatarFailed round-trips peer_node_uid and reason', () => {
	const f = avatars.parsePeerAvatarFailed({ peer_node_uid: '200', reason: '404' });
	assert.strictEqual(f.peer_node_uid, 200n);
	assert.strictEqual(f.reason, '404');
});

test('signaling.SignalingClient defaults capabilities to all-false', () => {
	// Constructed without a websocket — fine for testing the field shape only.
	const signaling = require('../signaling.js');
	// SignalingClient isn't exported; reach into the module like other tests do.
	const fs = require('node:fs');
	const path = require('node:path');
	const Module = require('node:module');
	const src = fs.readFileSync(path.join(__dirname, '..', 'signaling.js'), 'utf8');
	const m = new Module(require.resolve('../signaling.js'));
	m.filename = require.resolve('../signaling.js');
	m.paths = Module._nodeModulePaths(m.filename);
	m._compile(src + '\nmodule.exports._SignalingClient = SignalingClient;\n', m.filename);
	const SignalingClient = m.exports._SignalingClient;
	const c = new SignalingClient('1.2.3.4', /* ws */ null, 1n);
	assert.deepStrictEqual(c.capabilities, { avatar_relay: false });
});
