'use strict';
// Fixture builders for the glTF measurement tests. Assets are
// constructed in-memory rather than checked in as binaries: the builder
// is reviewable in a diff, keeps blobs out of git, and can express
// malformed containers (truncated chunks, oversized declared lengths)
// that a checked-in file cannot.

// Pad a buffer to a 4-byte boundary with the given filler byte, per the
// GLB chunk alignment rule.
function pad4(buf, filler)
{
	const rem = buf.length % 4;
	if (!rem)
		return buf;
	return Buffer.concat([buf, Buffer.alloc(4 - rem, filler)]);
}

// Assemble a GLB container from a glTF JSON object and an optional BIN
// chunk. `opts` can override header fields to express malformed files:
//   magic, version, declaredLength — header overrides.
function buildGlb(json, bin, opts = {})
{
	const jsonChunk = pad4(Buffer.from(JSON.stringify(json)), 0x20);
	const chunks = [];
	const jsonHeader = Buffer.alloc(8);
	jsonHeader.writeUInt32LE(jsonChunk.length, 0);
	jsonHeader.writeUInt32LE(0x4E4F534A, 4);	// 'JSON'
	chunks.push(jsonHeader, jsonChunk);
	if (bin)
	{
		const binChunk = pad4(bin, 0x00);
		const binHeader = Buffer.alloc(8);
		binHeader.writeUInt32LE(binChunk.length, 0);
		binHeader.writeUInt32LE(0x004E4942, 4);	// 'BIN\0'
		chunks.push(binHeader, binChunk);
	}
	const body = Buffer.concat(chunks);
	const header = Buffer.alloc(12);
	header.writeUInt32LE(opts.magic ?? 0x46546C67, 0);
	header.writeUInt32LE(opts.version ?? 2, 4);
	header.writeUInt32LE(opts.declaredLength ?? (12 + body.length), 8);
	return Buffer.concat([header, body]);
}

// A minimal valid glTF document: one mesh, one indexed TRIANGLES
// primitive of 12 triangles, bounds 1.0 × 1.8 × 0.5 m.
function minimalGltf(overrides = {})
{
	return Object.assign({
		asset: { version: '2.0' },
		meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
		accessors: [
			{ count: 24, type: 'VEC3', componentType: 5126, min: [-0.5, 0, -0.25], max: [0.5, 1.8, 0.25] },
			{ count: 36, type: 'SCALAR', componentType: 5123 },
		],
	}, overrides);
}

// Wrap a glTF document in the VRM 0.x extension with a humanoid bone
// map and a licence.
function asVrm0(json, meta = { licenseName: 'CC0' })
{
	const bones = ['hips', 'spine', 'head', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg'];
	json.extensionsUsed = ['VRM'];
	json.extensions = {
		VRM: {
			meta,
			humanoid: { humanBones: bones.map((bone, node) => ({ bone, node })) },
		},
	};
	json.skins = [{ joints: [0, 1, 2] }];
	return json;
}

// Image headers — only the bytes the dimension decoders read.
function pngHeader(width, height)
{
	const b = Buffer.alloc(24);
	Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(b, 0);
	b.writeUInt32BE(13, 8);			// IHDR length
	b.write('IHDR', 12);
	b.writeUInt32BE(width, 16);
	b.writeUInt32BE(height, 20);
	return b;
}

function jpegHeader(width, height)
{
	// SOI, then a single SOF0 segment carrying the frame dimensions.
	const b = Buffer.alloc(15);
	b[0] = 0xFF; b[1] = 0xD8;		// SOI
	b[2] = 0xFF; b[3] = 0xC0;		// SOF0
	b.writeUInt16BE(11, 4);			// segment length
	b[6] = 8;						// precision
	b.writeUInt16BE(height, 7);
	b.writeUInt16BE(width, 9);
	b[11] = 3;						// component count (padding beyond here)
	return b;
}

function ktx2Header(width, height)
{
	const b = Buffer.alloc(28);
	Buffer.from([0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A]).copy(b, 0);
	b.writeUInt32LE(width, 20);
	b.writeUInt32LE(height, 24);
	return b;
}

module.exports = { pad4, buildGlb, minimalGltf, asVrm0, pngHeader, jpegHeader, ktx2Header };
