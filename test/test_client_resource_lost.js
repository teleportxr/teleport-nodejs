'use strict';
// Tests for Client's handling of the ResourceLost client message.
//
// Relayed avatars are delivered as a mesh pointer carrying the owner's own
// url, so a peer that cannot reach the avatar host (offline, 4xx, or a
// missing CORS header in a browser) has no way to render it. That peer
// tells us with the ordinary ResourceLost message — it does not know the
// resource was an avatar — and we re-host the validated bytes and re-send
// that one peer our own copy. The owner is never told, and every other
// peer keeps using the relayed url (plans/avatars_plan.md §5.1).

const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('../client/client');
const message = require('../protocol/message');
const core = require('../core/core');

const LOST_UID = 555n;

// A ResourceLost frame: type + timestamp + uint16 count + uids.
function buildResourceLost(uids) {
	const size = message.ResourceLostMessage.sizeof() + core.UID_SIZE * uids.length;
	const buf = new ArrayBuffer(size);
	const dv = new DataView(buf);
	dv.setUint8(0, message.MessagePayloadType.ResourceLost);
	dv.setBigInt64(1, 0n, core.endian);
	dv.setUint16(9, uids.length, core.endian);
	let offset = message.ResourceLostMessage.sizeof();
	for (const uid of uids) {
		dv.setBigUint64(offset, uid, core.endian);
		offset += core.UID_SIZE;
	}
	return buf;
}

function makeStubClient(importer) {
	const c = Object.create(Client.prototype);
	c.clientID = 7n;
	c.avatarUrlOverrides = new Map();
	c._resent = [];
	c.geometryService = { ResendResource: (uid) => c._resent.push(uid) };
	c.avatarService = { importer };
	return c;
}

function makeImporter(opts = {}) {
	const calls = { hosted: [] };
	return {
		calls,
		relayedClientForMeshResourceUid: (uid) =>
			(BigInt(uid) === LOST_UID ? (opts.ownerID ?? 42n) : null),
		hostedUrlForClient: async (ownerID) => {
			calls.hosted.push(ownerID);
			if (opts.throws) throw new Error('publish exploded');
			return opts.hostedUrl !== undefined ? opts.hostedUrl : '/avatars/rehosted.glb';
		},
	};
}

// Give the async fallback started by the message handler a turn to finish.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a lost relayed avatar is re-hosted and queued for re-send to that client alone', async () => {
	const importer = makeImporter();
	const c = makeStubClient(importer);
	c.receiveResourceLostMessage(buildResourceLost([LOST_UID]));
	await settle();
	assert.deepStrictEqual(importer.calls.hosted, [42n]);
	assert.strictEqual(c.avatarUrlOverrides.get(LOST_UID), '/avatars/rehosted.glb');
	assert.deepStrictEqual(c._resent, [LOST_UID]);
});

test('losing an ordinary resource does not touch the avatar path', async () => {
	const importer = makeImporter();
	const c = makeStubClient(importer);
	c.receiveResourceLostMessage(buildResourceLost([999n]));
	await settle();
	assert.deepStrictEqual(importer.calls.hosted, []);
	assert.strictEqual(c.avatarUrlOverrides.size, 0);
	assert.deepStrictEqual(c._resent, []);
});

test('a second loss of the same avatar does not re-host again', async () => {
	// The client already has our copy; losing it again means something else
	// is wrong and there is nothing further to substitute.
	const importer = makeImporter();
	const c = makeStubClient(importer);
	c.receiveResourceLostMessage(buildResourceLost([LOST_UID]));
	await settle();
	c.receiveResourceLostMessage(buildResourceLost([LOST_UID]));
	await settle();
	assert.deepStrictEqual(importer.calls.hosted, [42n]);
	assert.deepStrictEqual(c._resent, [LOST_UID]);
});

test('no override is recorded when the asset cannot be re-hosted', async () => {
	for (const importer of [makeImporter({ hostedUrl: '' }), makeImporter({ throws: true })]) {
		const c = makeStubClient(importer);
		c.receiveResourceLostMessage(buildResourceLost([LOST_UID]));
		await settle();
		assert.strictEqual(c.avatarUrlOverrides.size, 0);
		assert.deepStrictEqual(c._resent, []);
	}
});

test('a short or truncated frame is rejected without throwing', async () => {
	const importer = makeImporter();
	const c = makeStubClient(importer);
	c.receiveResourceLostMessage(new ArrayBuffer(4));
	// Header claims one uid but carries none.
	const truncated = buildResourceLost([LOST_UID]).slice(0, message.ResourceLostMessage.sizeof());
	c.receiveResourceLostMessage(truncated);
	await settle();
	assert.deepStrictEqual(importer.calls.hosted, []);
});

test('every lost uid in one frame is considered', async () => {
	const importer = makeImporter();
	const c = makeStubClient(importer);
	c.receiveResourceLostMessage(buildResourceLost([111n, LOST_UID, 222n]));
	await settle();
	assert.deepStrictEqual(importer.calls.hosted, [42n]);
	assert.deepStrictEqual(c._resent, [LOST_UID]);
});

test('a client with no avatar importer wired ignores the message', async () => {
	const c = makeStubClient(null);
	c.receiveResourceLostMessage(buildResourceLost([LOST_UID]));
	await settle();
	assert.strictEqual(c.avatarUrlOverrides.size, 0);
});
