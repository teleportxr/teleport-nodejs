'use strict';
// Scene.Load's environment block: each cubemap may be written as a bare url string or as
// {"url":..., "axes_standard":...}. The stored path must always end up a string — assigning
// the raw object used to survive Load and then throw "url.search is not a function" at the
// point the resource was encoded for a client, which is a long way from the mistake.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../core/core.js');
const resources = require('../scene/resources.js');
const { Scene } = require('../scene/scene.js');

function loadScene(json) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teleport-scene-'));
	const file = 'scene.json';
	fs.writeFileSync(path.join(dir, file), JSON.stringify(json));
	const scene = new Scene();
	scene.SetAssetsPath(dir);
	scene.Load(file);
	return scene;
}

// Unique urls per run: Resource.pathToUid is static and shared across tests.
function url(name) {
	return '/' + name + '-' + Math.random().toString(36).slice(2) + '.ktx2';
}

test('environment textures accept both the string and the object form', () => {
	const background = url('background');
	const diffuse = url('diffuse');
	const specular = url('specular');
	const scene = loadScene({
		environment: {
			background_texture: { url: background, axes_standard: 'engineering' },
			diffuse_cubemap: diffuse,
			specular_cubemap: { url: specular, axes_standard: 'gl' }
		}
	});

	assert.strictEqual(scene.backgroundTexturePath, background);
	assert.strictEqual(scene.diffuseCubemapPath, diffuse);
	assert.strictEqual(scene.specularCubemapPath, specular);

	const axesOf = (u) => resources.GetResourceFromUrl(u).axesStandard;
	assert.strictEqual(axesOf(background), core.AxesStandard.EngineeringStyle);
	// A bare string means gl, unlike the "meshes" block where absent means "the server's own".
	assert.strictEqual(axesOf(diffuse), core.AxesStandard.GlStyle);
	assert.strictEqual(axesOf(specular), core.AxesStandard.GlStyle);
});

test('an environment texture is registered as a TexturePointer that encodes cleanly', () => {
	const background = url('encodable');
	loadScene({ environment: { background_texture: { url: background, axes_standard: 'engineering' } } });

	const res = resources.GetResourceFromUrl(background);
	assert.strictEqual(res.type, core.GeometryPayloadType.TexturePointer);
	// The object form used to reach the encoder intact and throw here.
	const buffer = new ArrayBuffer(res.encodedSize());
	assert.ok(res.encodeIntoDataView(new DataView(buffer), 0) > 0);
});

test('a malformed environment entry is skipped rather than stored', () => {
	const scene = loadScene({ environment: { background_texture: { axes_standard: 'gl' } } });
	assert.strictEqual(scene.backgroundTexturePath, '');
});
