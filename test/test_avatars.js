'use strict';
// Unit tests for the avatar-negotiation JSON codecs in protocol/avatars.js
// and the connect-time `capabilities` parsing in signaling.js.
// Mirrors the C++ test suite in Teleport/test/test_avatars.cpp so a
// regression on either side surfaces in matching test cases.

const test = require('node:test');
const assert = require('node:assert');

const avatars = require('../protocol/avatars.js');

test('decodeCapabilities returns an empty bag for any input', () => {
	// No signaling capabilities are defined at present: the object is an
	// extension point only. Avatars deliberately need none — relay is the
	// default and requires no negotiation (plans/avatars_plan.md D7).
	assert.deepStrictEqual(avatars.decodeCapabilities(undefined), {});
	assert.deepStrictEqual(avatars.decodeCapabilities(null),      {});
	assert.deepStrictEqual(avatars.decodeCapabilities({}),        {});
	assert.deepStrictEqual(avatars.decodeCapabilities('nope'),    {});
});

test('decodeCapabilities ignores unknown keys rather than failing on them', () => {
	const caps = avatars.decodeCapabilities({ future_flag: 'whatever', avatar_relay: true });
	assert.deepStrictEqual(caps, {});
});

test('encodeCapabilities emits an empty bag', () => {
	assert.deepStrictEqual(avatars.encodeCapabilities({ junk: 'x' }), {});
	assert.deepStrictEqual(avatars.encodeCapabilities({}),            {});
});

test('isRelayableUrl accepts the extensions clients can decode', () => {
	assert.strictEqual(avatars.isRelayableUrl('https://a.example/u/42.glb'),  true);
	assert.strictEqual(avatars.isRelayableUrl('https://a.example/u/42.vrm'),  true);
	assert.strictEqual(avatars.isRelayableUrl('https://a.example/u/42.gltf'), true);
	assert.strictEqual(avatars.isRelayableUrl('https://a.example/u/42.GLB'),  true);
});

test('isRelayableUrl ignores query and fragment when finding the extension', () => {
	// A bearer token after the extension is fine; the client still sees .glb.
	assert.strictEqual(avatars.isRelayableUrl('https://a.example/u/42.glb?token=abc'), true);
	assert.strictEqual(avatars.isRelayableUrl('https://a.example/u/42.glb#frag'),      true);
	// But an extension that only appears in the query is not usable.
	assert.strictEqual(avatars.isRelayableUrl('https://a.example/u/42?format=glb'), false);
});

test('isRelayableUrl rejects urls a client could not pick a decoder for', () => {
	assert.strictEqual(avatars.isRelayableUrl('https://a.example/u/42'),     false);
	assert.strictEqual(avatars.isRelayableUrl('https://a.example/u/42.png'), false);
	assert.strictEqual(avatars.isRelayableUrl(''),                           false);
	assert.strictEqual(avatars.isRelayableUrl(undefined),                    false);
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

test('there are no peer-facing avatar messages', () => {
	// A client is only ever told about its own avatar; another client's
	// arrives as ordinary geometry (plans/avatars_plan.md §2.2). Guards
	// against the deleted peer-avatar codecs creeping back in.
	for (const name of ['encodePeerAvatar', 'parsePeerAvatar', 'encodePeerAvatarFailed', 'parsePeerAvatarFailed'])
		assert.strictEqual(name in avatars, false, name + ' should not exist');
	for (const key of Object.keys(avatars))
		assert.strictEqual(/^TELEPORT_SIGNAL_TYPE_PEER/.test(key), false, key + ' should not exist');
});

test('signaling.SignalingClient defaults capabilities to an empty bag', () => {
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
	assert.deepStrictEqual(c.capabilities, {});
});
