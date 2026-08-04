'use strict';
// encodedSize() must be a buffer size that EncodeResource can actually write into.
//
// This used to be a hard-coded 500 for every pointer resource, which happened to be enough
// for the short relative urls in the example server and would have overrun silently for a
// CDN root plus a long path — a RangeError deep inside put_string, at the moment a
// deployment moved its assets. The figure also has to include the 8-byte payload-size
// prefix EncodeResource writes ahead of the body, which is easy to leave out because
// encodeIntoDataView never sees it.

const test = require('node:test');
const assert = require('node:assert');
const core = require('../core/core.js');
const resources = require('../scene/resources.js');
const resource_encoder = require('../protocol/encoders/resource_encoder.js');

function encodeAndMeasure(uid, urlOverride) {
	const res = resources.GetResourceFromUid(uid);
	const size = res.encodedSize(urlOverride);
	const buffer = new ArrayBuffer(size);
	const written = resource_encoder.EncodeResource(res, buffer, urlOverride);
	return { size, written };
}

test('encodedSize covers what EncodeResource writes, for a short relative url', () => {
	const uid = resources.GetOrAddAnimationPointer('/avatar_anim/Idle.vrma');
	const { size, written } = encodeAndMeasure(uid);
	assert.ok(written <= size, `wrote ${written} bytes into a ${size}-byte buffer`);
});

test('encodedSize covers a url far longer than the old fixed 500 bytes', () => {
	// The case the fixed size could not survive.
	const longUrl = 'https://cdn.example.com/' + 'a-fairly-long-path-segment/'.repeat(24) + 'Clip.vrma';
	assert.ok(longUrl.length > 500);
	const uid = resources.GetOrAddAnimationPointer(longUrl);
	const { size, written } = encodeAndMeasure(uid);
	assert.ok(written <= size, `wrote ${written} bytes into a ${size}-byte buffer`);
});

test('encodedSize accounts for the default path root prepended to relative urls', () => {
	// A relative url is encoded with defaultPathRoot in front of it, so sizing from the
	// stored url alone under-counts by the length of the root.
	const previous = resources.Resource.defaultPathRoot;
	resources.Resource.SetDefaultPathRoot('https://a-rather-long-deployment-hostname.example.com');
	try {
		const uid = resources.GetOrAddAnimationPointer('/avatar_anim/Walking.vrma');
		const { size, written } = encodeAndMeasure(uid);
		assert.ok(written <= size, `wrote ${written} bytes into a ${size}-byte buffer`);
	} finally {
		resources.Resource.SetDefaultPathRoot(previous);
	}
});

test('encodedSize honours a urlOverride longer than the stored url', () => {
	// Cubemap axes variants and rehosted avatars encode a different url from the stored
	// one; the size and the encoding must be computed from the same string.
	const uid = resources.GetOrAddAnimationPointer('/short.vrma');
	const override = 'https://elsewhere.example.com/' + 'x'.repeat(400) + '.vrma';
	const { size, written } = encodeAndMeasure(uid, override);
	assert.ok(written <= size, `wrote ${written} bytes into a ${size}-byte buffer`);
});

test('every resource type sizes its own body, not the base class pointer body', () => {
	// The base encodedSize sizes a url. A subclass that overrides encodeIntoDataView writes
	// something else and must override encodedSize too — TextCanvas did not, and was covered
	// only by the old fixed 500 until that was replaced. This walks the types the example
	// server actually streams.
	const atlasPath = '/test-atlas-' + Math.random().toString(36).slice(2) + '.ttf';
	const canvasPath = '/test-canvas-' + Math.random().toString(36).slice(2);
	resources.AddFontAtlas(atlasPath);
	const canvasUid = resources.AddTextCanvas(canvasPath, atlasPath, 2.0,
		'A line of canvas text long enough to exceed anything the pointer body would have allowed for.');

	const canvas = resources.GetResourceFromUid(canvasUid);
	const size = canvas.encodedSize();
	const buffer = new ArrayBuffer(size);
	const written = resource_encoder.EncodeResource(canvas, buffer);
	assert.ok(written <= size, `TextCanvas wrote ${written} bytes into a ${size}-byte buffer`);

	// Any subclass overriding the encoder must override the sizer; catching this by
	// inspection is cheaper than catching it when a server falls over mid-session.
	for (const type of [resources.FontAtlas, resources.Animation]) {
		assert.notStrictEqual(type.prototype.encodedSize, resources.Resource.prototype.encodedSize,
			`${type.name} overrides encodeIntoDataView, so it must override encodedSize`);
	}
});

test('a pointer body ends with the axes standard of the asset it points at', () => {
	// Appended after the url so that a client built before the field simply stops reading at
	// the end of the url. NotInitialized means "the same as the server's scene", which is why
	// only assets that disagree — anything glTF, against a Z-up server — need declaring.
	const uid = resources.GetOrAddMesh('/axes-test-' + Math.random().toString(36).slice(2) + '.vrm', 'gl');
	const res = resources.GetResourceFromUid(uid);
	assert.strictEqual(res.axesStandard, core.AxesStandard.GlStyle);

	const buffer = new ArrayBuffer(res.encodedSize());
	const written = resource_encoder.EncodeResource(res, buffer);
	const dv = new DataView(buffer);
	// Last byte of the body.
	assert.strictEqual(dv.getUint8(written - 1), core.AxesStandard.GlStyle);
	// And it is inside the declared payload size, not past it.
	assert.strictEqual(Number(dv.getBigUint64(0, core.endian)), written - 8);
});

test('an undeclared asset encodes NotInitialized, meaning "same as the server"', () => {
	const uid = resources.GetOrAddMesh('/undeclared-' + Math.random().toString(36).slice(2) + '.glb');
	const res = resources.GetResourceFromUid(uid);
	const buffer = new ArrayBuffer(res.encodedSize());
	const written = resource_encoder.EncodeResource(res, buffer);
	assert.strictEqual(new DataView(buffer).getUint8(written - 1), core.AxesStandard.NotInitialized);
	assert.strictEqual(core.AxesStandard.NotInitialized, 0);
});

test('a texture pointer carries no axes standard', () => {
	// A texture has no geometric frame. Cubemap orientation is handled instead by serving a
	// per-axes variant of the file, so adding a field here would be meaningless.
	const uid = resources.GetOrAddTexture('/tex-' + Math.random().toString(36).slice(2) + '.ktx2');
	const res = resources.GetResourceFromUid(uid);
	assert.strictEqual(res.carriesAxesStandard(), false);
	const buffer = new ArrayBuffer(res.encodedSize());
	const written = resource_encoder.EncodeResource(res, buffer);
	// The body ends with the url's last character, not an axes byte.
	const dv = new DataView(buffer);
	assert.strictEqual(dv.getUint8(written - 1), '2'.charCodeAt(0));
});

test('axes standards can be named or given as wire values', () => {
	const P = resources.ParseAxesStandard;
	assert.strictEqual(P('gl'), core.AxesStandard.GlStyle);
	assert.strictEqual(P('GLTF'), core.AxesStandard.GlStyle);
	assert.strictEqual(P('engineering'), core.AxesStandard.EngineeringStyle);
	assert.strictEqual(P('unity'), core.AxesStandard.UnityStyle);
	assert.strictEqual(P('unreal'), core.AxesStandard.UnrealStyle);
	assert.strictEqual(P(core.AxesStandard.GlStyle), core.AxesStandard.GlStyle);
	// Unknown or omitted both mean "the server's own", so a typo degrades to today's
	// behaviour rather than silently rotating an asset.
	assert.strictEqual(P(undefined), core.AxesStandard.NotInitialized);
	assert.strictEqual(P('nonsense'), core.AxesStandard.NotInitialized);
});

test('an AnimationPointer encodes as payload type 14 with a size prefix', () => {
	const uid = resources.GetOrAddAnimationPointer('/avatar_anim/Running.vrma');
	const res = resources.GetResourceFromUid(uid);
	const buffer = new ArrayBuffer(res.encodedSize());
	const written = resource_encoder.EncodeResource(res, buffer);
	const dv = new DataView(buffer);

	// Size prefix: bytes following the size field.
	assert.strictEqual(Number(dv.getBigUint64(0, core.endian)), written - 8);
	assert.strictEqual(dv.getUint8(8), core.GeometryPayloadType.AnimationPointer);
	assert.strictEqual(core.GeometryPayloadType.AnimationPointer, 14);
	assert.strictEqual(dv.getBigUint64(9, core.endian), BigInt(uid));
});
