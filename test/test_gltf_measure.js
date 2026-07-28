'use strict';
// Tests for the validation-only glTF/GLB/VRM parser and measurer used
// by the Phase-3 avatar validator. All fixtures are constructed
// in-memory by test/helpers/gltf_fixtures.js.

const test		= require('node:test');
const assert	= require('node:assert');

const gltf		= require('../client/gltf_measure.js');
const fx		= require('./helpers/gltf_fixtures.js');

// parseAsset -------------------------------------------------------

test('parseAsset: parses a GLB container with JSON and BIN chunks', () => {
	const bin = Buffer.alloc(16, 0xCD);
	const parsed = gltf.parseAsset(fx.buildGlb(fx.minimalGltf(), bin));
	assert.strictEqual(parsed.container, 'glb');
	assert.strictEqual(parsed.json.asset.version, '2.0');
	assert.ok(parsed.bin);
	assert.strictEqual(parsed.bin.length, 16);
});

test('parseAsset: parses plain JSON glTF (with BOM and whitespace)', () => {
	const body = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('  \n' + JSON.stringify(fx.minimalGltf()))]);
	const parsed = gltf.parseAsset(body);
	assert.strictEqual(parsed.container, 'gltf');
	assert.strictEqual(parsed.bin, null);
});

test('parseAsset: throws malformed_asset for non-glTF payloads', () => {
	for (const body of [Buffer.from('NOPE'), Buffer.alloc(0), Buffer.from('[1,2]'), Buffer.from('{broken')])
		assert.throws(() => gltf.parseAsset(body), (e) => e.code === 'malformed_asset');
});

test('parseAsset: rejects malformed GLB containers', () => {
	const good = fx.buildGlb(fx.minimalGltf(), null);
	// Wrong version.
	assert.throws(() => gltf.parseAsset(fx.buildGlb(fx.minimalGltf(), null, { version: 1 })),
		(e) => e.code === 'malformed_asset');
	// Declared length beyond the buffer.
	assert.throws(() => gltf.parseAsset(fx.buildGlb(fx.minimalGltf(), null, { declaredLength: good.length + 64 })),
		(e) => e.code === 'malformed_asset');
	// Truncated mid-chunk: cut the buffer but keep the declared length.
	assert.throws(() => gltf.parseAsset(Buffer.concat([good.subarray(0, good.length - 8)])),
		(e) => e.code === 'malformed_asset');
	// A chunk whose declared length overruns the container.
	const overrun = Buffer.from(good);
	overrun.writeUInt32LE(0x7FFFFFFF, 12);
	assert.throws(() => gltf.parseAsset(overrun), (e) => e.code === 'malformed_asset');
});

// detectFormat -----------------------------------------------------

test('detectFormat: VRM 0.x and 1.0 report vrm, plain containers their own name', () => {
	assert.strictEqual(gltf.detectFormat(gltf.parseAsset(fx.buildGlb(fx.minimalGltf(), null))), 'glb');
	assert.strictEqual(gltf.detectFormat(gltf.parseAsset(Buffer.from(JSON.stringify(fx.minimalGltf())))), 'gltf');
	assert.strictEqual(gltf.detectFormat(gltf.parseAsset(fx.buildGlb(fx.asVrm0(fx.minimalGltf()), null))), 'vrm');
	const vrm1 = fx.minimalGltf({ extensionsUsed: ['VRMC_vrm'] });
	assert.strictEqual(gltf.detectFormat(gltf.parseAsset(fx.buildGlb(vrm1, null))), 'vrm');
});

// Triangle counting ------------------------------------------------

test('measureAsset: counts indexed and non-indexed triangles', () => {
	const m = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(fx.minimalGltf(), null)));
	assert.strictEqual(m.triangles, 12);	// 36 indices / 3
	// Non-indexed: POSITION count drives the count.
	const json = fx.minimalGltf();
	delete json.meshes[0].primitives[0].indices;
	const m2 = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(json, null)));
	assert.strictEqual(m2.triangles, 8);	// 24 vertices / 3
});

test('measureAsset: triangle strips and fans use count minus two', () => {
	const json = fx.minimalGltf();
	json.meshes[0].primitives[0].mode = 5;	// TRIANGLE_STRIP
	assert.strictEqual(gltf.measureAsset(gltf.parseAsset(fx.buildGlb(json, null))).triangles, 34);
	json.meshes[0].primitives[0].mode = 6;	// TRIANGLE_FAN
	assert.strictEqual(gltf.measureAsset(gltf.parseAsset(fx.buildGlb(json, null))).triangles, 34);
	json.meshes[0].primitives[0].mode = 1;	// LINES — no triangles
	assert.strictEqual(gltf.measureAsset(gltf.parseAsset(fx.buildGlb(json, null))).triangles, 0);
});

// Bounds -----------------------------------------------------------

test('measureAsset: height and width come from the POSITION min/max union', () => {
	const m = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(fx.minimalGltf(), null)));
	assert.ok(Math.abs(m.heightM - 1.8) < 1e-6);
	assert.ok(Math.abs(m.widthM - 1.0) < 1e-6);	// X extent 1.0 beats Z extent 0.5
	assert.strictEqual(m.measurementFailed, false);
});

test('measureAsset: missing POSITION min/max flags measurementFailed', () => {
	const json = fx.minimalGltf();
	delete json.accessors[0].min;
	const m = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(json, null)));
	assert.strictEqual(m.measurementFailed, true);
	// Only enforced when a policy actually asks for a bound.
	assert.deepStrictEqual(gltf.checkRequirements(m, {}), []);
	assert.deepStrictEqual(gltf.checkRequirements(m, { max_height_m: 2.5 }), ['measurement_failed']);
});

// External references ----------------------------------------------

test('checkRequirements: external buffer/image URIs are always refused', () => {
	const json = fx.minimalGltf({ buffers: [{ uri: 'https://elsewhere.example/data.bin', byteLength: 4 }] });
	const m = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(json, null)));
	assert.deepStrictEqual(gltf.checkRequirements(m, {}), ['external_reference']);
});

test('measureAsset: data: URIs are not external references', () => {
	const json = fx.minimalGltf({ buffers: [{ uri: 'data:application/octet-stream;base64,AAAA', byteLength: 3 }] });
	const m = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(json, null)));
	assert.deepStrictEqual(m.externalRefs, []);
});

// Images -----------------------------------------------------------

test('imageDimensions: decodes PNG, JPEG and KTX2 headers', () => {
	assert.deepStrictEqual(gltf.imageDimensions(fx.pngHeader(640, 480)), { width: 640, height: 480 });
	assert.deepStrictEqual(gltf.imageDimensions(fx.jpegHeader(320, 200)), { width: 320, height: 200 });
	assert.deepStrictEqual(gltf.imageDimensions(fx.ktx2Header(1024, 512)), { width: 1024, height: 512 });
	assert.strictEqual(gltf.imageDimensions(Buffer.from('not an image, definitely')), null);
});

test('measureAsset: image dimensions from BIN bufferViews and data URIs', () => {
	const png = fx.pngHeader(256, 128);
	const json = fx.minimalGltf({
		bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.length }],
		buffers: [{ byteLength: png.length }],
		images: [
			{ bufferView: 0, mimeType: 'image/png' },
			{ uri: 'data:image/png;base64,' + fx.pngHeader(64, 64).toString('base64') },
		],
	});
	const m = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(json, png)));
	assert.strictEqual(m.textureCount, 2);
	assert.strictEqual(m.maxTexturePixels, 256 * 128);
	assert.strictEqual(m.unreadableTextures, 0);
});

test('checkRequirements: texture limits and unreadable images fail closed', () => {
	const png = fx.pngHeader(2048, 2048);
	const json = fx.minimalGltf({
		bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.length }],
		buffers: [{ byteLength: png.length }],
		images: [{ bufferView: 0 }],
	});
	const m = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(json, png)));
	assert.deepStrictEqual(gltf.checkRequirements(m, { max_texture_pixels: 1_048_576 }), ['texture_too_large']);
	assert.deepStrictEqual(gltf.checkRequirements(m, { max_textures: 0 }), ['too_many_textures']);

	// An image whose bytes cannot be decoded is only fatal when the
	// policy caps texture pixels.
	const bad = fx.minimalGltf({ images: [{ bufferView: 99 }] });
	const mBad = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(bad, null)));
	assert.strictEqual(mBad.unreadableTextures, 1);
	assert.deepStrictEqual(gltf.checkRequirements(mBad, {}), []);
	assert.deepStrictEqual(gltf.checkRequirements(mBad, { max_texture_pixels: 1_048_576 }), ['texture_unreadable']);
});

// Licence ----------------------------------------------------------

test('checkRequirements: licence tags — allowed, not allowed, unknown', () => {
	const cc0 = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(fx.asVrm0(fx.minimalGltf(), { licenseName: 'CC0' }), null)));
	assert.strictEqual(cc0.licenceTag, 'cc0');
	assert.deepStrictEqual(gltf.checkRequirements(cc0, { licence_tags_allowed: ['cc0', 'cc-by'] }), []);

	const nc = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(fx.asVrm0(fx.minimalGltf(), { licenseName: 'CC_BY_NC' }), null)));
	assert.strictEqual(nc.licenceTag, 'cc-by-nc');
	assert.deepStrictEqual(gltf.checkRequirements(nc, { licence_tags_allowed: ['cc0'] }), ['licence_not_allowed']);

	const bare = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(fx.minimalGltf(), null)));
	assert.strictEqual(bare.licenceTag, '');
	assert.deepStrictEqual(gltf.checkRequirements(bare, { licence_tags_allowed: ['cc0'] }), ['licence_unknown']);
	// No licence requirement — not inspected.
	assert.deepStrictEqual(gltf.checkRequirements(bare, {}), []);
});

test('normaliseLicence: VRM 1.0 licence URLs map to coarse tags', () => {
	const make = (licenseUrl) => gltf.measureAsset(gltf.parseAsset(fx.buildGlb(fx.minimalGltf({
		extensionsUsed: ['VRMC_vrm'],
		extensions: { VRMC_vrm: { meta: { licenseUrl } } },
	}), null))).licenceTag;
	assert.strictEqual(make('https://creativecommons.org/publicdomain/zero/1.0/'), 'cc0');
	assert.strictEqual(make('https://creativecommons.org/licenses/by/4.0/'), 'cc-by');
	assert.strictEqual(make('https://vrm.dev/licenses/1.0/'), 'vrm');
	assert.strictEqual(make('https://example.com/my-eula'), 'other');
});

// Skeleton ---------------------------------------------------------

test('checkRequirements: humanoid skeleton requirement', () => {
	const vrm = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(fx.asVrm0(fx.minimalGltf()), null)));
	assert.deepStrictEqual(gltf.checkRequirements(vrm, { skeleton: 'humanoid-mixamo' }), []);

	// A VRM without a humanoid bone map fails.
	const stripped = fx.asVrm0(fx.minimalGltf());
	delete stripped.extensions.VRM.humanoid;
	const noBones = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(stripped, null)));
	assert.deepStrictEqual(gltf.checkRequirements(noBones, { skeleton: 'humanoid-mixamo' }), ['skeleton_unsupported']);

	// A plain glTF only has to be skinned.
	const skinned = fx.minimalGltf({ skins: [{ joints: [0] }] });
	const mSkinned = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(skinned, null)));
	assert.deepStrictEqual(gltf.checkRequirements(mSkinned, { skeleton: 'humanoid' }), []);
	const unskinned = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(fx.minimalGltf(), null)));
	assert.deepStrictEqual(gltf.checkRequirements(unskinned, { skeleton: 'humanoid' }), ['skeleton_unsupported']);

	// Unrecognised skeleton values fail closed.
	assert.deepStrictEqual(gltf.checkRequirements(mSkinned, { skeleton: 'quadruped' }), ['skeleton_unsupported']);
});

// V6: all reasons at once ------------------------------------------

test('checkRequirements: reports every failing constraint in one result', () => {
	const json = fx.minimalGltf({ buffers: [{ uri: 'https://elsewhere.example/x.bin', byteLength: 4 }] });
	const m = gltf.measureAsset(gltf.parseAsset(fx.buildGlb(json, null)));
	const reasons = gltf.checkRequirements(m, {
		max_triangles: 1,
		max_height_m: 0.5,
		max_width_m: 0.5,
		licence_tags_allowed: ['cc0'],
	});
	assert.deepStrictEqual(reasons.sort(), ['external_reference', 'licence_unknown', 'too_many_triangles', 'too_tall', 'too_wide'].sort());
});

// requiresMeasurement ----------------------------------------------

test('requiresMeasurement: true only for keys that need a parse', () => {
	assert.strictEqual(gltf.requiresMeasurement({}), false);
	assert.strictEqual(gltf.requiresMeasurement({ max_file_bytes: 1 }), false);
	assert.strictEqual(gltf.requiresMeasurement({ max_triangles: 1 }), true);
	assert.strictEqual(gltf.requiresMeasurement({ licence_tags_allowed: [] }), false);
	assert.strictEqual(gltf.requiresMeasurement({ licence_tags_allowed: ['cc0'] }), true);
	assert.strictEqual(gltf.requiresMeasurement({ skeleton: 'humanoid' }), true);
});
