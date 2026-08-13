'use strict';
// Validation-only glTF/GLB/VRM parser and measurer for the Phase-3
// avatar validator (plans/avatars_implementation.md §4). Deliberately
// hand-rolled rather than a dependency: every measurement the avatar
// requirements need (accessor counts, POSITION min/max, image counts,
// image header dimensions, extensionsUsed, VRM meta) is available from
// the JSON chunk plus a few header bytes of embedded images, so nothing
// here decodes geometry or texture data. All reads are bounds-checked
// per the input-validation rule in AGENTS.md; a malformed container
// throws { code: 'malformed_asset' } rather than measuring garbage.

const GLB_MAGIC			= 0x46546C67;	// 'glTF' little-endian
const GLB_CHUNK_JSON	= 0x4E4F534A;	// 'JSON'
const GLB_CHUNK_BIN		= 0x004E4942;	// 'BIN\0'

// Primitive modes that produce triangles (glTF 2.0 §3.7.2.1).
const MODE_TRIANGLES		= 4;
const MODE_TRIANGLE_STRIP	= 5;
const MODE_TRIANGLE_FAN		= 6;

function malformed(detail)
{
	return Object.assign(new Error('malformed_asset' + (detail ? ': ' + detail : '')), { code: 'malformed_asset' });
}

// Parse a fetched avatar body into { container: 'glb'|'gltf', json, bin }.
// `bin` is the GLB BIN chunk as a Buffer, or null for JSON glTF. Throws
// { code: 'malformed_asset' } on any container violation.
function parseAsset(buf)
{
	if (!Buffer.isBuffer(buf) || buf.length < 4)
		throw malformed('too short');
	if (buf.length >= 12 && buf.readUInt32LE(0) === GLB_MAGIC)
	{
		const version = buf.readUInt32LE(4);
		if (version !== 2)
			throw malformed('glb version ' + version);
		const declaredLength = buf.readUInt32LE(8);
		if (declaredLength < 12 || declaredLength > buf.length)
			throw malformed('glb length field');
		let offset = 12;
		let jsonChunk = null;
		let binChunk = null;
		while (offset < declaredLength)
		{
			if (offset + 8 > declaredLength)
				throw malformed('truncated chunk header');
			const chunkLength = buf.readUInt32LE(offset);
			const chunkType = buf.readUInt32LE(offset + 4);
			if (offset + 8 + chunkLength > declaredLength)
				throw malformed('chunk overruns container');
			const data = buf.subarray(offset + 8, offset + 8 + chunkLength);
			if (chunkType === GLB_CHUNK_JSON)
			{
				if (jsonChunk)
					throw malformed('duplicate JSON chunk');
				jsonChunk = data;
			}
			else if (chunkType === GLB_CHUNK_BIN)
			{
				if (binChunk)
					throw malformed('duplicate BIN chunk');
				binChunk = data;
			}
			// Unknown chunk types are skipped per the GLB spec.
			offset += 8 + chunkLength;
		}
		if (!jsonChunk)
			throw malformed('missing JSON chunk');
		let json;
		try { json = JSON.parse(jsonChunk.toString('utf8')); }
		catch (e) { throw malformed('JSON chunk unparseable'); }
		if (!json || typeof json !== 'object' || Array.isArray(json))
			throw malformed('JSON chunk not an object');
		return { container: 'glb', json, bin: binChunk };
	}
	// Plain JSON glTF: skip BOM and leading whitespace, expect '{'.
	let i = 0;
	if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) i = 3;
	while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0A || buf[i] === 0x0D)) i++;
	if (i >= buf.length || buf[i] !== 0x7B)
		throw malformed('not GLB or JSON');
	let json;
	try { json = JSON.parse(buf.toString('utf8', i)); }
	catch (e) { throw malformed('JSON unparseable'); }
	if (!json || typeof json !== 'object' || Array.isArray(json))
		throw malformed('not an object');
	return { container: 'gltf', json, bin: null };
}

// The uris of images a glTF/GLB references as external files, in the order
// they appear in `images`. An asset that embeds its images (bufferView) or
// inlines them (data: uri) yields an empty array.
//
// These are the mesh's texture dependencies: a server streaming the mesh
// must stream them too, or the client has nothing to resolve the uris
// against. See scene.Load and resources.SetMeshTextures.
//
// Uris are returned exactly as authored — relative to the asset itself,
// per the glTF spec — so the caller resolves them against the asset's own
// url. Throws { code: 'malformed_asset' } on a bad container, as parseAsset
// does; a caller scanning an arbitrary file should catch it.
//
// Note this is the same information measureAsset collects as `externalRefs`
// in order to *refuse* an asset: a user-supplied avatar must be
// self-contained (protocol plan §7), and that stays true. This function is
// for server-owned scene assets, which may legitimately reference files
// beside them.
function externalImageUris(buf)
{
	const parsed = parseAsset(buf);
	const images = Array.isArray(parsed.json.images) ? parsed.json.images : [];
	const uris = [];
	for (const im of images)
	{
		if (!im || typeof im.uri !== 'string' || !im.uri || im.uri.startsWith('data:'))
			continue;
		if (!uris.includes(im.uri))
			uris.push(im.uri);
	}
	return uris;
}

// Canonical short format name for the policy `formats` list. A VRM is
// reported as 'vrm', not 'glb' — a server that wants both must list
// both (this is exactly the sniffFormat misbehaviour being fixed).
function detectFormat(parsed)
{
	const ext = parsed.json.extensionsUsed;
	if (Array.isArray(ext) && (ext.includes('VRM') || ext.includes('VRMC_vrm')))
		return 'vrm';
	return parsed.container;
}

// Decode the pixel dimensions of an embedded image from its header
// bytes. Supports PNG, JPEG and KTX2; returns { width, height } or
// null when the format is unrecognised or the header is truncated.
function imageDimensions(buf)
{
	if (!Buffer.isBuffer(buf) || buf.length < 4)
		return null;
	// PNG: 8-byte signature, then the IHDR chunk whose width/height are
	// big-endian u32s at byte offsets 16 and 20.
	if (buf.length >= 24 &&
		buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
		buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A)
	{
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	}
	// KTX2: 12-byte identifier, pixelWidth/pixelHeight little-endian
	// u32s at offsets 20 and 24. pixelHeight may be 0 for 1D textures.
	if (buf.length >= 28 &&
		buf[0] === 0xAB && buf[1] === 0x4B && buf[2] === 0x54 && buf[3] === 0x58 &&
		buf[4] === 0x20 && buf[5] === 0x32 && buf[6] === 0x30 && buf[7] === 0xBB &&
		buf[8] === 0x0D && buf[9] === 0x0A && buf[10] === 0x1A && buf[11] === 0x0A)
	{
		return { width: buf.readUInt32LE(20), height: Math.max(1, buf.readUInt32LE(24)) };
	}
	// JPEG: bounds-checked marker walk to the first frame header (SOFn).
	if (buf[0] === 0xFF && buf[1] === 0xD8)
	{
		let i = 2;
		while (i + 3 < buf.length)
		{
			if (buf[i] !== 0xFF) return null;
			let marker = buf[i + 1];
			// Skip fill bytes.
			while (marker === 0xFF && i + 2 < buf.length) { i++; marker = buf[i + 1]; }
			// Standalone markers without a length field.
			if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) { i += 2; continue; }
			if (marker === 0xD9) return null;	// EOI before any SOF
			if (i + 3 >= buf.length) return null;
			const segLength = buf.readUInt16BE(i + 2);
			if (segLength < 2 || i + 2 + segLength > buf.length) return null;
			// SOF0..SOF15 excluding DHT(C4), JPG(C8), DAC(CC).
			if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC)
			{
				if (segLength < 7) return null;
				return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
			}
			i += 2 + segLength;
		}
		return null;
	}
	return null;
}

// Decode a data: URI into a Buffer, or return null if it isn't one or
// the encoding is unsupported.
function decodeDataUri(uri)
{
	if (typeof uri !== 'string' || !uri.startsWith('data:'))
		return null;
	const comma = uri.indexOf(',');
	if (comma < 0)
		return null;
	const meta = uri.slice(5, comma);
	const payload = uri.slice(comma + 1);
	try
	{
		if (meta.endsWith(';base64'))
			return Buffer.from(payload, 'base64');
		return Buffer.from(decodeURIComponent(payload), 'utf8');
	}
	catch (e) { return null; }
}

// Map a VRM licence declaration to a lowercase tag comparable with the
// policy's `licence_tags_allowed` list. VRM 0.x carries meta.licenseName
// (e.g. "CC_BY_NC"); VRM 1.0 carries meta.licenseUrl. The table is
// intentionally coarse — a host that needs finer distinctions supplies
// its own validator.
function normaliseLicence(json)
{
	const vrm0 = json.extensions && json.extensions.VRM && json.extensions.VRM.meta;
	if (vrm0 && typeof vrm0.licenseName === 'string' && vrm0.licenseName.length)
		return vrm0.licenseName.toLowerCase().replace(/_/g, '-');
	const vrm1 = json.extensions && json.extensions.VRMC_vrm && json.extensions.VRMC_vrm.meta;
	if (vrm1 && typeof vrm1.licenseUrl === 'string' && vrm1.licenseUrl.length)
	{
		const u = vrm1.licenseUrl.toLowerCase();
		if (u.includes('creativecommons.org/publicdomain/zero'))	return 'cc0';
		if (u.includes('creativecommons.org/licenses/by-nc-nd'))	return 'cc-by-nc-nd';
		if (u.includes('creativecommons.org/licenses/by-nc-sa'))	return 'cc-by-nc-sa';
		if (u.includes('creativecommons.org/licenses/by-nc'))		return 'cc-by-nc';
		if (u.includes('creativecommons.org/licenses/by-nd'))		return 'cc-by-nd';
		if (u.includes('creativecommons.org/licenses/by-sa'))		return 'cc-by-sa';
		if (u.includes('creativecommons.org/licenses/by'))			return 'cc-by';
		if (u.includes('vrm.dev/licenses'))							return 'vrm';
		return 'other';
	}
	return '';
}

// Core bones a humanoid rig must map (subset of the VRM required list;
// enough to rule out non-humanoid assets without being brittle).
const HUMANOID_CORE_BONES = ['hips', 'spine', 'head', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg', 'rightUpperLeg'];

function hasHumanoidBones(json)
{
	const vrm0 = json.extensions && json.extensions.VRM && json.extensions.VRM.humanoid;
	if (vrm0 && Array.isArray(vrm0.humanBones))
	{
		const names = new Set(vrm0.humanBones.map(b => b && b.bone).filter(n => typeof n === 'string'));
		return HUMANOID_CORE_BONES.every(b => names.has(b));
	}
	const vrm1 = json.extensions && json.extensions.VRMC_vrm && json.extensions.VRMC_vrm.humanoid;
	if (vrm1 && vrm1.humanBones && typeof vrm1.humanBones === 'object')
		return HUMANOID_CORE_BONES.every(b => vrm1.humanBones[b] != null);
	return false;
}

// Measure a parsed asset. Never throws on odd-but-parseable content;
// instead it sets `measurementFailed` when a required measurement could
// not be taken (e.g. a POSITION accessor without the spec-mandated
// min/max), so checkRequirements can fail closed only when a policy
// actually asks for that measurement.
function measureAsset(parsed)
{
	const json = parsed.json;
	const accessors	= Array.isArray(json.accessors)	? json.accessors	: [];
	const meshes	= Array.isArray(json.meshes)	? json.meshes		: [];
	const images	= Array.isArray(json.images)	? json.images		: [];
	const buffers	= Array.isArray(json.buffers)	? json.buffers		: [];
	const bufferViews = Array.isArray(json.bufferViews) ? json.bufferViews : [];

	// External URI references (protocol plan §7): the asset must be
	// self-contained; any non-data: uri on a buffer or image is refused.
	const externalRefs = [];
	for (const b of buffers)
		if (b && typeof b.uri === 'string' && !b.uri.startsWith('data:'))
			externalRefs.push(b.uri);
	for (const im of images)
		if (im && typeof im.uri === 'string' && !im.uri.startsWith('data:'))
			externalRefs.push(im.uri);

	const accessorCount = (index) =>
	{
		if (!Number.isInteger(index) || index < 0 || index >= accessors.length)
			return null;
		const c = accessors[index] && accessors[index].count;
		return Number.isFinite(c) && c >= 0 ? c : null;
	};

	// Triangles: sum per unique primitive. Meshes referenced by several
	// nodes count once — instancing shares geometry, and the cap exists
	// to bound parse/import cost, not draw cost.
	let triangles = 0;
	let measurementFailed = false;
	for (const mesh of meshes)
	{
		const prims = mesh && Array.isArray(mesh.primitives) ? mesh.primitives : [];
		for (const prim of prims)
		{
			if (!prim || typeof prim !== 'object')
				continue;
			const mode = Number.isInteger(prim.mode) ? prim.mode : MODE_TRIANGLES;
			let count = null;
			if (Number.isInteger(prim.indices))
				count = accessorCount(prim.indices);
			else if (prim.attributes && Number.isInteger(prim.attributes.POSITION))
				count = accessorCount(prim.attributes.POSITION);
			if (count === null)
			{
				measurementFailed = true;
				continue;
			}
			if (mode === MODE_TRIANGLES)
				triangles += Math.floor(count / 3);
			else if (mode === MODE_TRIANGLE_STRIP || mode === MODE_TRIANGLE_FAN)
				triangles += Math.max(0, count - 2);
			// Points/lines (modes 0-3) contribute no triangles.
		}
	}

	// Bounds: union AABB over every POSITION accessor's spec-mandated
	// min/max. Node-hierarchy transforms are deliberately not applied:
	// the caps are sanity limits, avatar roots are identity or near-
	// identity in practice, and Phase 4's importer applies the same
	// transforms so this can be revisited there.
	let min = null, max = null;
	for (const mesh of meshes)
	{
		const prims = mesh && Array.isArray(mesh.primitives) ? mesh.primitives : [];
		for (const prim of prims)
		{
			if (!prim || !prim.attributes || !Number.isInteger(prim.attributes.POSITION))
				continue;
			const acc = accessors[prim.attributes.POSITION];
			const aMin = acc && Array.isArray(acc.min) ? acc.min : null;
			const aMax = acc && Array.isArray(acc.max) ? acc.max : null;
			if (!aMin || !aMax || aMin.length < 3 || aMax.length < 3 ||
				!aMin.slice(0, 3).every(Number.isFinite) || !aMax.slice(0, 3).every(Number.isFinite))
			{
				measurementFailed = true;
				continue;
			}
			if (!min)
			{
				min = aMin.slice(0, 3);
				max = aMax.slice(0, 3);
			}
			else
			{
				for (let k = 0; k < 3; k++)
				{
					min[k] = Math.min(min[k], aMin[k]);
					max[k] = Math.max(max[k], aMax[k]);
				}
			}
		}
	}
	const heightM	= min ? max[1] - min[1] : 0;
	const widthM	= min ? Math.max(max[0] - min[0], max[2] - min[2]) : 0;

	// Images: count, and per-image pixel dimensions from the embedded
	// header bytes (bufferView into the BIN chunk, or a data: URI).
	let maxTexturePixels = 0;
	let unreadableTextures = 0;
	for (const im of images)
	{
		if (!im || typeof im !== 'object')
		{
			unreadableTextures++;
			continue;
		}
		if (typeof im.uri === 'string' && !im.uri.startsWith('data:'))
			continue;	// already reported as an external ref
		let bytes = null;
		if (typeof im.uri === 'string')
			bytes = decodeDataUri(im.uri);
		else if (Number.isInteger(im.bufferView) && im.bufferView >= 0 && im.bufferView < bufferViews.length)
		{
			const bv = bufferViews[im.bufferView];
			const bvOffset = Number.isInteger(bv && bv.byteOffset) ? bv.byteOffset : 0;
			const bvLength = bv && Number.isInteger(bv.byteLength) ? bv.byteLength : -1;
			if (parsed.bin && bvLength >= 0 && bvOffset >= 0 && bvOffset + bvLength <= parsed.bin.length)
				bytes = parsed.bin.subarray(bvOffset, bvOffset + bvLength);
		}
		const dims = bytes ? imageDimensions(bytes) : null;
		if (!dims)
		{
			unreadableTextures++;
			continue;
		}
		maxTexturePixels = Math.max(maxTexturePixels, dims.width * dims.height);
	}

	const hasSkins = Array.isArray(json.skins) &&
		json.skins.some(s => s && Array.isArray(s.joints) && s.joints.length > 0);

	return {
		format:				detectFormat(parsed),
		triangles,
		heightM,
		widthM,
		textureCount:		images.length,
		maxTexturePixels,
		unreadableTextures,
		licenceTag:			normaliseLicence(json),
		humanoid:			hasHumanoidBones(json),
		hasSkins,
		externalRefs,
		measurementFailed,
	};
}

// Requirement keys that need a parsed asset. Used by the validator to
// decide whether an unparseable body must fail or may pass through.
const MEASUREMENT_KEYS = ['max_triangles', 'max_height_m', 'max_width_m', 'max_textures', 'max_texture_pixels', 'skeleton', 'licence_tags_allowed'];

function requiresMeasurement(req)
{
	if (!req || typeof req !== 'object')
		return false;
	return MEASUREMENT_KEYS.some(k =>
	{
		const v = req[k];
		if (v == null) return false;
		if (Array.isArray(v)) return v.length > 0;
		return true;
	});
}

// Compare a measurement against a requirements bag. Returns every
// failing reason code at once (plan §5 V6), never just the first.
function checkRequirements(measure, req)
{
	const reasons = [];
	const r = req || {};

	// External references are refused whenever the asset parsed at all —
	// this is a security property (protocol plan §7), not a policy knob.
	if (measure.externalRefs.length)
		reasons.push('external_reference');

	if (Number.isFinite(r.max_triangles))
	{
		if (measure.measurementFailed)
			reasons.push('measurement_failed');
		else if (measure.triangles > r.max_triangles)
			reasons.push('too_many_triangles');
	}
	if (Number.isFinite(r.max_height_m))
	{
		if (measure.measurementFailed)
		{
			if (!reasons.includes('measurement_failed'))
				reasons.push('measurement_failed');
		}
		else if (measure.heightM > r.max_height_m)
			reasons.push('too_tall');
	}
	if (Number.isFinite(r.max_width_m))
	{
		if (measure.measurementFailed)
		{
			if (!reasons.includes('measurement_failed'))
				reasons.push('measurement_failed');
		}
		else if (measure.widthM > r.max_width_m)
			reasons.push('too_wide');
	}
	if (Number.isFinite(r.max_textures) && measure.textureCount > r.max_textures)
		reasons.push('too_many_textures');
	if (Number.isFinite(r.max_texture_pixels))
	{
		if (measure.unreadableTextures > 0)
			reasons.push('texture_unreadable');
		if (measure.maxTexturePixels > r.max_texture_pixels)
			reasons.push('texture_too_large');
	}
	if (Array.isArray(r.licence_tags_allowed) && r.licence_tags_allowed.length)
	{
		const allowed = r.licence_tags_allowed.map(s => String(s).toLowerCase());
		if (!measure.licenceTag)
			reasons.push('licence_unknown');
		else if (!allowed.includes(measure.licenceTag))
			reasons.push('licence_not_allowed');
	}
	if (typeof r.skeleton === 'string' && r.skeleton.length)
	{
		if (r.skeleton.startsWith('humanoid'))
		{
			// A VRM must carry a humanoid bone map; a bare glTF only has
			// to be skinned (there is no standard bone-name mapping to
			// check against). Hosts wanting stricter retarget checks
			// supply their own validator.
			const ok = measure.format === 'vrm' ? (measure.hasSkins && measure.humanoid) : measure.hasSkins;
			if (!ok)
				reasons.push('skeleton_unsupported');
		}
		else
			reasons.push('skeleton_unsupported');
	}
	return reasons;
}

module.exports.parseAsset			= parseAsset;
module.exports.externalImageUris	= externalImageUris;
module.exports.detectFormat			= detectFormat;
module.exports.imageDimensions		= imageDimensions;
module.exports.decodeDataUri		= decodeDataUri;
module.exports.normaliseLicence		= normaliseLicence;
module.exports.measureAsset			= measureAsset;
module.exports.requiresMeasurement	= requiresMeasurement;
module.exports.checkRequirements	= checkRequirements;
