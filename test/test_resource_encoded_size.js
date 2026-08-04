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
