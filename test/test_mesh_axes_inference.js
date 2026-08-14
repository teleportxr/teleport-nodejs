'use strict';
// A mesh resource carries the axes standard its asset file is authored in, and the client uses
// it to convert the fetched .glb/.vrm into its own frame. NotInitialized means "the same as the
// server's scene", which is only right for an asset actually authored in that frame.
//
// scene.json's "meshes" block declares it, but not every mesh comes from there: a
// client-supplied avatar url arrives at runtime through Node.setMeshComponent (see
// client/avatar_importer.js). Such a mesh used to keep NotInitialized and so be read as being
// in the server's frame — wrong for every glTF-family file whenever the scene is not itself
// Y-up. The extension settles it: .glb/.gltf/.vrm/.vrma are Y-up right-handed by
// specification, whatever the scene around them uses.

const test = require('node:test');
const assert = require('node:assert');

const core = require('../core/core.js');
const nd = require('../scene/node.js');
const resources = require('../scene/resources.js');

// Unique urls per run: Resource.pathToUid is static and shared across tests.
function unique(name, ext) {
	return '/' + name + '-' + Math.random().toString(36).slice(2) + ext;
}

function axesOf(url) {
	const res = resources.GetResourceFromUrl(url);
	assert.ok(res, 'no resource registered for ' + url);
	return res.axesStandard;
}

test('AxesStandardForAssetUrl recognises the glTF family and nothing else', () => {
	for (const ext of ['.glb', '.gltf', '.vrm', '.vrma']) {
		assert.strictEqual(resources.AxesStandardForAssetUrl('/avatar' + ext),
			core.AxesStandard.GlStyle, ext + ' is Y-up right-handed by specification');
		assert.strictEqual(resources.AxesStandardForAssetUrl('/AVATAR' + ext.toUpperCase()),
			core.AxesStandard.GlStyle, 'the extension test is case-insensitive');
	}
	// A query string or fragment must not hide the extension — a CDN url may carry either.
	assert.strictEqual(resources.AxesStandardForAssetUrl('https://cdn.example/a.glb?v=2'),
		core.AxesStandard.GlStyle);
	assert.strictEqual(resources.AxesStandardForAssetUrl('https://cdn.example/a.vrm#frag'),
		core.AxesStandard.GlStyle);

	// Anything the extension does not settle stays "the server's own frame".
	for (const url of ['/mesh.fbx', '/mesh', '/mesh.glb.txt', '', undefined, null, 42]) {
		assert.strictEqual(resources.AxesStandardForAssetUrl(url),
			core.AxesStandard.NotInitialized, JSON.stringify(url) + ' should not be inferable');
	}
});

test('setMeshComponent infers GlStyle for a glTF-family url', () => {
	const url = unique('runtime-avatar', '.vrm');
	const node = new nd.Node('avatar');
	node.setMeshComponent(url);
	assert.strictEqual(axesOf(url), core.AxesStandard.GlStyle);
});

test('setMeshComponent leaves a non-glTF url as the server\'s own frame', () => {
	const url = unique('opaque', '.bin');
	new nd.Node('thing').setMeshComponent(url);
	assert.strictEqual(axesOf(url), core.AxesStandard.NotInitialized);
});

test('setMeshComponent does not overwrite an explicit declaration', () => {
	// scene.json is loaded before nodes reference their meshes, so a mesh listed in the
	// "meshes" block already has a standard by the time setMeshComponent sees it. An author
	// who says a .glb is Engineering-authored — a converted asset, say — must be believed.
	const url = unique('declared', '.glb');
	resources.GetOrAddMesh(url, 'engineering');
	new nd.Node('thing').setMeshComponent(url);
	assert.strictEqual(axesOf(url), core.AxesStandard.EngineeringStyle);
});

test('setMeshComponent still registers the mesh and attaches one component', () => {
	// The inference is an addition to what the method already did; none of it may be lost.
	const url = unique('component', '.glb');
	const node = new nd.Node('thing');
	node.setMeshComponent(url);

	const uid = resources.GetResourceUidFromUrl(core.GeometryPayloadType.MeshPointer, url);
	assert.ok(uid, 'the mesh should be registered as a MeshPointer');

	const meshComponents = node.components.filter(
		(c) => c.getType() === nd.NodeDataType.Mesh);
	assert.strictEqual(meshComponents.length, 1);
	assert.strictEqual(meshComponents[0].data_uid, uid);
});
