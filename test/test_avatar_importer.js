'use strict';
// Tests for the DefaultAvatarImporter: accepted (or default) avatars
// become scene nodes parented under the owning client's origin, and are
// removed with a RemoveNodes unstream for every client on
// disconnect/revoke. The node's mesh is a pointer to either the owner's
// own url (relay, the default) or to a server-hosted copy published
// through the host-supplied callback (import).

const test		= require('node:test');
const assert	= require('node:assert');

const { DefaultAvatarImporter } = require('../client/avatar_importer.js');
const nd = require('../scene/node.js');

function fakeScene() {
	return {
		nodes: new Map(),
		InsertNode(n) { this.nodes.set(n.uid, n); return n.uid; },
		RemoveNode(uid) { return this.nodes.delete(uid); },
		GetNode(uid) { return this.nodes.get(uid) || null; },
	};
}

function fakeClient(originUid) {
	const streamed = [];
	const unstreamed = [];
	return {
		origin_uid: originUid,
		geometryService: {
			StreamNode: (uid) => streamed.push(uid),
			UnstreamNode: (uid) => unstreamed.push(uid),
		},
		streamed,
		unstreamed,
	};
}

test('importUrlForClient creates a node parented under the client origin and streams it', () => {
	const scene = fakeScene();
	const client = fakeClient(777n);
	const imp = new DefaultAvatarImporter({ scene });
	const uid = imp.importUrlForClient(1n, client, '/avatars/abc.glb');
	assert.notStrictEqual(uid, 0n);
	const node = scene.GetNode(uid);
	assert.ok(node);
	assert.strictEqual(node.parent_uid, 777n);
	assert.strictEqual(node.holder_client_id, 1n);
	assert.strictEqual(node.stationary, false);
	assert.strictEqual(node.components.length, 1);
	assert.strictEqual(node.components[0].getType(), nd.NodeDataType.Mesh);
	assert.strictEqual(node.components[0].meshUrl, '/avatars/abc.glb');
	assert.deepStrictEqual(client.streamed, [uid]);
});

test('importUrlForClient is idempotent for the same URL and replaces for a new one', () => {
	const scene = fakeScene();
	const client = fakeClient(1n);
	const imp = new DefaultAvatarImporter({ scene });
	const first = imp.importUrlForClient(2n, client, '/avatars/one.glb');
	assert.strictEqual(imp.importUrlForClient(2n, client, '/avatars/one.glb'), first);
	assert.strictEqual(scene.nodes.size, 1);
	const second = imp.importUrlForClient(2n, client, '/avatars/two.glb');
	assert.notStrictEqual(second, first);
	assert.strictEqual(scene.nodes.size, 1);
	assert.strictEqual(scene.GetNode(first), null);
	assert.strictEqual(imp.nodeUidForClient(2n), second);
});

test('importValidatedForClient publishes the bytes and imports the returned URL', async () => {
	const scene = fakeScene();
	const client = fakeClient(1n);
	let published = null;
	const imp = new DefaultAvatarImporter({
		scene,
		publish: async (p) => { published = p; return '/avatars/' + p.contentHash.slice(7) + '.glb'; },
	});
	const body = Buffer.from('bytes');
	const uid = await imp.importValidatedForClient(3n, client, { body, contentHash: 'sha256:ff00', format: 'glb' });
	assert.ok(published);
	assert.strictEqual(published.body, body);
	assert.strictEqual(published.contentHash, 'sha256:ff00');
	assert.strictEqual(scene.GetNode(uid).components[0].meshUrl, '/avatars/ff00.glb');
});

test('importValidatedForClient fails with import_failed when unpublishable', async () => {
	const scene = fakeScene();
	const noPublish = new DefaultAvatarImporter({ scene });
	await assert.rejects(
		() => noPublish.importValidatedForClient(4n, null, { body: Buffer.from('x'), contentHash: 'sha256:aa' }),
		(e) => e.code === 'import_failed');
	const noBody = new DefaultAvatarImporter({ scene, publish: async () => '/x.glb' });
	await assert.rejects(
		() => noBody.importValidatedForClient(4n, null, { contentHash: 'sha256:aa' }),
		(e) => e.code === 'import_failed');
});

test('importDefaultForClient uses defaultUrl, or returns 0n when unconfigured', () => {
	const scene = fakeScene();
	const client = fakeClient(1n);
	const withDefault = new DefaultAvatarImporter({ scene, defaultUrl: '/generic_avatar.vrm' });
	const uid = withDefault.importDefaultForClient(5n, client);
	assert.notStrictEqual(uid, 0n);
	assert.strictEqual(scene.GetNode(uid).components[0].meshUrl, '/generic_avatar.vrm');
	const without = new DefaultAvatarImporter({ scene: fakeScene() });
	assert.strictEqual(without.importDefaultForClient(5n, client), 0n);
});

test('relayForClient points the node at the owner\'s own url, publishing nothing', () => {
	const scene = fakeScene();
	const client = fakeClient(1n);
	let published = false;
	const imp = new DefaultAvatarImporter({ scene, publish: async () => { published = true; return '/x.glb'; } });
	const uid = imp.relayForClient(8n, client, 'https://avatars.example/u/42.glb', { body: Buffer.from('b'), contentHash: 'sha256:aa' });
	assert.strictEqual(scene.GetNode(uid).components[0].meshUrl, 'https://avatars.example/u/42.glb');
	assert.strictEqual(published, false, 'relay must not re-host the asset');
});

test('relayForClient refuses an empty url', () => {
	const imp = new DefaultAvatarImporter({ scene: fakeScene() });
	assert.throws(() => imp.relayForClient(8n, null, ''), (e) => e.code === 'relay_failed');
});

test('hostedUrlForClient re-hosts a relayed avatar once, and caches the result', async () => {
	const scene = fakeScene();
	let publishes = 0;
	const imp = new DefaultAvatarImporter({
		scene,
		publish: async () => { publishes++; return '/avatars/rehosted.glb'; },
	});
	imp.relayForClient(9n, fakeClient(1n), 'https://avatars.example/u/9.glb',
		{ body: Buffer.from('b'), contentHash: 'sha256:bb', format: 'glb' });
	assert.strictEqual(await imp.hostedUrlForClient(9n), '/avatars/rehosted.glb');
	assert.strictEqual(await imp.hostedUrlForClient(9n), '/avatars/rehosted.glb');
	assert.strictEqual(publishes, 1, 'a second peer failing must reuse the published copy');
});

test('hostedUrlForClient returns nothing for an avatar that was never relayed', async () => {
	const scene = fakeScene();
	const imp = new DefaultAvatarImporter({ scene, publish: async () => '/x.glb' });
	imp.importUrlForClient(10n, fakeClient(1n), '/avatars/already-ours.glb');
	assert.strictEqual(await imp.hostedUrlForClient(10n), '');
	assert.strictEqual(await imp.hostedUrlForClient(999n), '');
});

test('relayedClientForMeshResourceUid finds the owner of a relayed pointer only', () => {
	const scene = fakeScene();
	const imp = new DefaultAvatarImporter({ scene, publish: async () => '/x.glb' });
	imp.relayForClient(11n, fakeClient(1n), 'https://avatars.example/u/11.glb', { body: Buffer.from('b'), contentHash: 'sha256:cc' });
	imp.importUrlForClient(12n, fakeClient(1n), '/avatars/ours.glb');
	const relayedUid = imp.meshResourceUidForClient(11n);
	const importedUid = imp.meshResourceUidForClient(12n);
	assert.strictEqual(imp.relayedClientForMeshResourceUid(relayedUid), 11n);
	// An imported avatar is served by us already: nothing to downgrade.
	assert.strictEqual(imp.relayedClientForMeshResourceUid(importedUid), null);
	assert.strictEqual(imp.relayedClientForMeshResourceUid(999999n), null);
});

test('removeForClient removes the node and unstreams it for every client', () => {
	const scene = fakeScene();
	const owner = fakeClient(1n);
	const peer = fakeClient(2n);
	const clientManager = { clients: new Map([[6n, owner], [7n, peer]]) };
	const imp = new DefaultAvatarImporter({ scene, clientManager });
	const uid = imp.importUrlForClient(6n, owner, '/avatars/gone.glb');
	imp.removeForClient(6n);
	assert.strictEqual(scene.GetNode(uid), null);
	assert.deepStrictEqual(owner.unstreamed, [uid]);
	assert.deepStrictEqual(peer.unstreamed, [uid]);
	assert.strictEqual(imp.nodeUidForClient(6n), 0n);
	// A second removal is a no-op.
	imp.removeForClient(6n);
	assert.deepStrictEqual(owner.unstreamed, [uid]);
});
