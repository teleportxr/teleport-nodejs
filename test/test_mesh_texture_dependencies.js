'use strict';
// A .glb/.vrm may reference its textures as external files rather than embedding them. Those
// textures are then dependencies of the mesh: a client streaming the mesh has nothing to
// resolve the asset's image uris against unless we stream them too.
//
// scene.json declares them per mesh; when it does not, Scene.ScanMeshTextures reads them out
// of the asset. Either way they end up on the mesh Resource, and GeometryService refcounts
// them into streamedTextures alongside the mesh, so a texture two meshes share is held until
// both let go.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../core/core.js');
const nd = require('../scene/node.js');
const resources = require('../scene/resources.js');
const gltf = require('../client/gltf_measure.js');
const { Scene } = require('../scene/scene.js');
const { GeometryService } = require('../client/geometry_service.js');

// Unique urls per run: Resource.pathToUid is static and shared across tests.
function unique(name, ext) {
	return '/' + name + '-' + Math.random().toString(36).slice(2) + ext;
}

// A minimal GLB whose images reference external files, as GltfConverter --split-objects writes.
function glbWithImageUris(uris) {
	const json = Buffer.from(JSON.stringify({
		asset: { version: '2.0' },
		images: uris.map((uri) => ({ uri })),
		textures: uris.map((_, i) => ({ source: i })),
		meshes: [], nodes: [], scenes: [{ nodes: [] }], scene: 0
	}), 'utf8');
	const pad = (4 - (json.length % 4)) % 4;
	const chunk = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
	const out = Buffer.alloc(12 + 8 + chunk.length);
	out.writeUInt32LE(0x46546C67, 0);			// 'glTF'
	out.writeUInt32LE(2, 4);
	out.writeUInt32LE(out.length, 8);
	out.writeUInt32LE(chunk.length, 12);
	out.writeUInt32LE(0x4E4F534A, 16);			// 'JSON'
	chunk.copy(out, 20);
	return out;
}

// Write a scene.json plus any public assets, and load it.
function loadScene(json, publicFiles) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teleport-meshtex-'));
	const publicDir = path.join(dir, 'http_resources');
	fs.mkdirSync(publicDir, { recursive: true });
	for (const [url, buf] of Object.entries(publicFiles || {})) {
		const file = path.join(publicDir, url);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, buf);
	}
	fs.writeFileSync(path.join(dir, 'scene.json'), JSON.stringify(json));
	const scene = new Scene();
	scene.SetAssetsPath(dir);
	scene.SetPublicPath(publicDir);
	scene.Load('scene.json');
	return scene;
}

function makeService(clientID, scene) {
	// The trackedResources map is static; reset it so uids don't leak across cases.
	GeometryService.trackedResources = new Map();
	const svc = new GeometryService(clientID);
	svc.SetScene(scene);
	return svc;
}

test('externalImageUris returns external image uris only', () => {
	const glb = glbWithImageUris(['tex.png', 'sub/other.jpg']);
	assert.deepStrictEqual(gltf.externalImageUris(glb), ['tex.png', 'sub/other.jpg']);

	// Embedded and inlined images are not dependencies — there is nothing to fetch.
	const embedded = Buffer.from(JSON.stringify({
		asset: { version: '2.0' },
		images: [{ bufferView: 0, mimeType: 'image/png' }, { uri: 'data:image/png;base64,AAAA' }]
	}), 'utf8');
	assert.deepStrictEqual(gltf.externalImageUris(embedded), []);
});

test('a declared "textures" list is registered against the mesh', () => {
	const mesh = unique('declared', '.glb');
	const texture = unique('declared-tex', '.png');
	loadScene({ meshes: { [mesh]: { axes_standard: 'gl', textures: [texture] } } });

	const mesh_uid = resources.GetResourceUidFromUrl(core.GeometryPayloadType.MeshPointer, mesh);
	const texture_uid = resources.GetResourceUidFromUrl(core.GeometryPayloadType.TexturePointer, texture);
	assert.ok(mesh_uid && texture_uid);
	assert.deepStrictEqual(resources.GetMeshTextureUids(mesh_uid), [texture_uid]);

	const res = resources.GetResourceFromUid(texture_uid);
	assert.strictEqual(res.type, core.GeometryPayloadType.TexturePointer);
	// A mesh texture has no frame of its own, unlike an environment cubemap.
	assert.strictEqual(res.axesStandard, core.AxesStandard.NotInitialized);
});

test('an undeclared asset is scanned, and its uris resolve against the mesh url', () => {
	const dir = '/props-' + Math.random().toString(36).slice(2);
	const mesh = dir + '/chair.glb';
	const scene = loadScene(
		{ meshes: { [mesh]: { axes_standard: 'gl' } } },
		{ [mesh]: glbWithImageUris(['chair_base.png', '/shared/atlas.ktx2', 'nested/n.jpg']) });

	assert.deepStrictEqual(scene.ScanMeshTextures(mesh), [
		dir + '/chair_base.png',		// relative to the asset
		'/shared/atlas.ktx2',			// already root-relative
		dir + '/nested/n.jpg'
	]);

	const mesh_uid = resources.GetResourceUidFromUrl(core.GeometryPayloadType.MeshPointer, mesh);
	const uids = resources.GetMeshTextureUids(mesh_uid);
	assert.strictEqual(uids.length, 3);
	assert.strictEqual(uids[0],
		resources.GetResourceUidFromUrl(core.GeometryPayloadType.TexturePointer, dir + '/chair_base.png'));
});

test('scanning is silent and empty for assets we do not host or cannot read', () => {
	const scene = loadScene({});
	assert.deepStrictEqual(scene.ScanMeshTextures('/not-here.glb'), []);
	assert.deepStrictEqual(scene.ScanMeshTextures('https://cdn.example/x.glb'), []);
	assert.deepStrictEqual(scene.ScanMeshTextures('/model.mesh'), []);
});

test('a malformed asset warns once and yields no dependencies', () => {
	const mesh = unique('broken', '.glb');
	const scene = loadScene({}, { [mesh]: Buffer.from('not a glb at all') });
	const originalWarn = console.warn;
	const warnings = [];
	console.warn = (...args) => warnings.push(args.join(''));
	try {
		assert.deepStrictEqual(scene.ScanMeshTextures(mesh), []);
	} finally {
		console.warn = originalWarn;
	}
	assert.strictEqual(warnings.length, 1);
});

test('streaming a node streams the mesh textures, refcounted across nodes', () => {
	const mesh = unique('shared', '.glb');
	const texture = unique('shared-tex', '.png');
	const scene = loadScene({ meshes: { [mesh]: { textures: [texture] } } });

	const mesh_uid = resources.GetResourceUidFromUrl(core.GeometryPayloadType.MeshPointer, mesh);
	const texture_uid = resources.GetResourceUidFromUrl(core.GeometryPayloadType.TexturePointer, texture);

	const a = scene.CreateNode();
	const b = scene.CreateNode();
	scene.GetNode(a).setMeshComponent(mesh);
	scene.GetNode(b).setMeshComponent(mesh);

	const svc = makeService(301, scene);
	svc.StreamNode(a);
	svc.StreamNode(b);
	svc.UpdateNodesToStream();

	assert.strictEqual(svc.streamedMeshes.get(mesh_uid), 2, 'mesh is wanted by both nodes');
	assert.strictEqual(svc.streamedTextures.get(texture_uid), 2,
		'its external texture is wanted once per streaming reason, exactly as the mesh is');

	// The texture must actually go on the wire with the mesh.
	assert.ok(svc.GetTexturesToSend().includes(texture_uid));

	// One node leaving is not enough to drop the texture; the other still needs it.
	svc.AddOrRemoveNodeAndResources(a, -1);
	assert.strictEqual(svc.streamedTextures.get(texture_uid), 1);
	svc.AddOrRemoveNodeAndResources(b, -1);
	assert.strictEqual(svc.streamedTextures.get(texture_uid), 0);
});

test('a mesh with no external textures adds nothing', () => {
	const mesh = unique('embedded', '.glb');
	const scene = loadScene({ meshes: { [mesh]: { axes_standard: 'gl' } } });
	const mesh_uid = resources.GetResourceUidFromUrl(core.GeometryPayloadType.MeshPointer, mesh);
	assert.deepStrictEqual(resources.GetMeshTextureUids(mesh_uid), []);

	const n = scene.CreateNode();
	scene.GetNode(n).setMeshComponent(mesh);
	const svc = makeService(302, scene);
	svc.StreamNode(n);
	svc.UpdateNodesToStream();
	assert.strictEqual(svc.streamedTextures.size, 0);
});

test('GetMeshTextureUids is empty for an unknown or non-mesh uid', () => {
	assert.deepStrictEqual(resources.GetMeshTextureUids(0), []);
	assert.deepStrictEqual(resources.GetMeshTextureUids(123456789n), []);
	const canvasUid = resources.AddTextCanvas(unique('canvas', '.canvas'), '', 1.0, 'hi');
	assert.deepStrictEqual(resources.GetMeshTextureUids(canvasUid), []);
});
