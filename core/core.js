'use strict';
var microtime = require('microtime')	// timings in microseconds.
const UID_SIZE = 8;
const endian = true;
// Get type information by "typename". Everything not listed is assumed to be a struct
// (i.e. a js class with its own encodeIntoDataView function.)
function SizeOfType(member) {
	switch (member) {
		case "float":
		case "float32":
			return [4, "float32"];
		case "double":
		case "float64":
			return [8, "float64"];
		case "float16":
			return [2, "float16"];
		case "CommandPayloadType":
		case "MessagePayloadType":
		case "BackgroundMode":
		case "AxesStandard":
		case "GeometryPayloadType":
			return [1, "uint8"];
		case "CommandPayloadType":
			return [1, "uint8"];
		case "bool":
			return [1, "uint8"];
		case "int8":
			return [1, "uint8"];
		case "uint8":
			return [1, "uint8"];
		case "vec4":
			return [16, "struct"];
		case "uid":
			return [8, "uint64"];
		case "int16":
			return [2, "int16"];
		case "uint16":
			return [2, "uint16"];
		case "int32":
			return [4, "int32"];
		case "uint32":
			return [4, "uint32"];
		case "uint64":
			return [8, "uint64"];
		case "int64":
			return [8, "int64"];
		case "VideoConfig":
			return [89, "struct"];
		case "AudioConfig":
			return [17, "struct"];
		case "VideoCodec":
		case "AxesStandard":
		case "GeometryPayloadType":
		case "BackgroundMode":
		case "LightingMode":
			return [1, "uint8"];
		default:
			// must have defined size() for the object:
			return [0, "struct"];
	};
}

function encodeIntoDataView(obj, dataView, byteOffset) {
	const startOffset = byteOffset;
	for (let [key, value] of Object.entries(obj)) {
		let first_underscore = key.search('_');
		var name = key.substring(first_underscore + 1, key.end);
		var type = key.substring(0, first_underscore);
		var [sz, tp] = SizeOfType(type);
		if (tp == "uint8") {
			dataView.setUint8(byteOffset, value, endian);
		}
		else if (tp == "int8") {
			dataView.setInt8(byteOffset, value, endian);
		}
		else if (tp == "uint16") {
			dataView.setUint16(byteOffset, value, endian);
		}
		else if (tp == "int16") {
			dataView.setInt16(byteOffset, value, endian);
		}
		else if (tp == "uint32") {
			dataView.setUint32(byteOffset, value, endian);
		}
		else if (tp == "int32") {
			dataView.setInt32(byteOffset, value, endian);
		}
		else if (tp == "float32") {
			dataView.setFloat32(byteOffset, value, endian);
		}
		else if (tp == "int64") {
			dataView.setBigInt64(byteOffset, value, endian);
		}
		else if (tp == "uint64") {
			dataView.setBigUint64(byteOffset, value, endian);
		}
		else if (tp == "struct") {
			sz = encodeIntoDataView(value, dataView, byteOffset) - byteOffset;
		}
		if (sz == 0 || sz == NaN) {
			throw new Error("Can't find size of " + key + " in " + obj.toString());
		}
		console.log("Offset " + byteOffset + ": " + sz + " bytes\t" + tp + " " + name + " = " + value.toString().substring(0, 20));
		byteOffset += sz;
	}
	const totalSize = byteOffset - startOffset;
	console.log("ENCODED TOTAL: " + totalSize + " bytes (offsets " + startOffset + " to " + byteOffset + ")\n");
	return byteOffset;
}

function decodeFromDataView(obj, dataView, byteOffset) {
	for (let [key, sub_obj] of Object.entries(obj)) {
		let first_underscore = key.search('_');
		var name = key.substring(first_underscore + 1, key.end);
		var type = key.substring(0, first_underscore);
		var [sz, tp] = SizeOfType(type);
		if (tp == "uint8") {
			var value = dataView.getUint8(byteOffset);
			obj[key] = value;
		}
		else if (tp == "int8") {
			var value = dataView.getInt8(byteOffset);
			obj[key] = value;
		}
		else if (tp == "uint16") {
			var value = dataView.getUint16(byteOffset, endian);
			obj[key] = value;
		}
		else if (tp == "int16") {
			var value = dataView.getInt16(byteOffset, endian);
			obj[key] = value;
		}
		else if (tp == "uint32") {
			var value = dataView.getUint32(byteOffset, endian);
			obj[key] = value;
		}
		else if (tp == "int32") {
			var value = dataView.getInt32(byteOffset, endian);
			obj[key] = value;
		}
		else if (tp == "float32") {
			var value = dataView.getFloat32(byteOffset, endian);
			obj[key] = value;
		}
		else if (tp == "int64") {
			var value = dataView.getBigInt64(byteOffset, endian);
			obj[key] = value;
		}
		else if (tp == "uint64") {
			var value = dataView.getBigUint64(byteOffset, endian);
			obj[key] = value;
		}
		else if (tp == "struct") {
			try {
				sz = decodeFromDataView(sub_obj, dataView, byteOffset) - byteOffset;
			} catch (error) {
				console.error(error);
				throw new Error("decodeFromDataView failed for " + key);
			}
		}
		if (sz == 0 || sz == NaN) {
			throw new Error("Can't find size of " + key);
		}
		byteOffset += sz;
		console.log(byteOffset + ": " + sz + " bytes\t\t" + tp + " " + name + " " + (obj[key] !== undefined ? obj[key] : sub_obj));
	}
	console.log("Total size: " + byteOffset + "\n");
	return byteOffset;
}

class vec4 {
	constructor() {
		this.float_x = 0.0;
		this.float_y = 0.0;
		this.float_z = 0.0;
		this.float_w = 0.0;
	}
	static sizeof() {
		return 16;
	}
	size() {
		return vec4.sizeof();
	}
};

const BackgroundMode =
{
	NONE: 0, COLOUR: 1, TEXTURE: 2, VIDEO: 3
};

const AxesStandard =
{
	NotInitialized: 0,
	RightHanded: 1,
	LeftHanded: 2,
	YVertical: 4,
	ZVertical: 8,
	// NB: these must be explicit literals, not `this.ZVertical | ...`. Inside an object
	// literal `this` is the module scope, not the object, so the bitwise expressions would
	// silently evaluate to the wrong values (e.g. EngineeringStyle=0, GlStyle=16). The wire
	// protocol and clients use 9 and 21, so hard-code the resolved values to match.
	EngineeringStyle: 8 | 1,	// ZVertical | RightHanded = 9
	GlStyle: 16 | 4 | 1,		// 16 | YVertical | RightHanded = 21
	UnrealStyle: 32 | 8 | 2,	// 32 | ZVertical | LeftHanded = 42
	UnityStyle: 64 | 4 | 2,		// 64 | YVertical | LeftHanded = 70
};

//! Map a client's axes standard to the filename suffix used for the matching cubemap
//! variant. e.g. GlStyle -> "ogl", so /envCloudyCubemap.ktx2 -> /envCloudyCubemap_ogl.ktx2.
//! Returns "" for an unknown/uninitialised standard, meaning "serve the original file".
function AxesStandardToCubemapSuffix(axesStandard)
{
	switch (axesStandard)
	{
		case AxesStandard.GlStyle:			return "ogl";
		case AxesStandard.EngineeringStyle:	return "eng";
		case AxesStandard.UnrealStyle:		return "unreal";
		case AxesStandard.UnityStyle:		return "unity";
		default:							return "";
	}
}

// ---- Axes-standard conversions for object transforms ----
// Ported from the C++ server (libavstream common_maths.h ConvertPosition/Rotation/Scale), which
// converts each node's transform from the server's axes standard to the client's during encoding.
// The C++ table only covers Unreal/Unity <-> Gl/Engineering (its server is engine-driven), so the
// Engineering <-> GlStyle cases below are added here (both right-handed: position/quat vector part
// maps as (x, z, -y); its inverse as (x, -z, y); scale permutes y/z).
function ConvertPosition(from, to, p)
{
	const A = AxesStandard;
	if (from === to) return { x: p.x, y: p.y, z: p.z };
	if (from === A.UnrealStyle)
	{
		if (to === A.GlStyle)          return { x: +p.y, y: +p.z, z: -p.x };
		if (to === A.EngineeringStyle) return { x: p.y, y: p.x, z: p.z };
	}
	else if (from === A.UnityStyle)
	{
		if (to === A.GlStyle)          return { x: p.x, y: p.y, z: -p.z };
		if (to === A.EngineeringStyle) return { x: p.x, y: p.z, z: p.y };
	}
	else if (from === A.EngineeringStyle)
	{
		if (to === A.UnrealStyle)      return { x: p.y, y: p.x, z: p.z };
		if (to === A.UnityStyle)       return { x: p.x, y: p.z, z: p.y };
		if (to === A.GlStyle)          return { x: p.x, y: p.z, z: -p.y };	// added
	}
	else if (from === A.GlStyle)
	{
		if (to === A.UnrealStyle)      return { x: -p.z, y: +p.x, z: +p.y };
		if (to === A.UnityStyle)       return { x: p.x, y: p.y, z: -p.z };
		if (to === A.EngineeringStyle) return { x: p.x, y: -p.z, z: p.y };	// added
	}
	console.warn("ConvertPosition: unsupported axes "+from+"->"+to+"; leaving unchanged");
	return { x: p.x, y: p.y, z: p.z };
}

function ConvertRotation(from, to, q)
{
	const A = AxesStandard;
	if (from === to) return { x: q.x, y: q.y, z: q.z, w: q.w };
	if (from === A.UnrealStyle)
	{
		if (to === A.GlStyle)          return { x: -q.y, y: -q.z, z: +q.x, w: q.w };
		if (to === A.EngineeringStyle) return { x: -q.y, y: -q.x, z: -q.z, w: q.w };
	}
	else if (from === A.EngineeringStyle)
	{
		if (to === A.UnrealStyle)      return { x: -q.y, y: -q.x, z: -q.z, w: q.w };
		if (to === A.UnityStyle)       return { x: -q.x, y: -q.z, z: -q.y, w: q.w };
		if (to === A.GlStyle)          return { x: q.x, y: q.z, z: -q.y, w: q.w };	// added
	}
	else if (from === A.GlStyle)
	{
		if (to === A.UnrealStyle)      return { x: +q.z, y: -q.x, z: -q.y, w: q.w };
		if (to === A.UnityStyle)       return { x: -q.x, y: -q.y, z: q.z, w: q.w };
		if (to === A.EngineeringStyle) return { x: q.x, y: -q.z, z: q.y, w: q.w };	// added
	}
	else if (from === A.UnityStyle)
	{
		if (to === A.GlStyle)          return { x: -q.x, y: -q.y, z: q.z, w: q.w };
		if (to === A.EngineeringStyle) return { x: -q.x, y: -q.z, z: -q.y, w: q.w };
	}
	console.warn("ConvertRotation: unsupported axes "+from+"->"+to+"; leaving unchanged");
	return { x: q.x, y: q.y, z: q.z, w: q.w };
}

function ConvertScale(from, to, s)
{
	const A = AxesStandard;
	if (from === to) return { x: s.x, y: s.y, z: s.z };
	if (from === A.UnrealStyle)
	{
		if (to === A.GlStyle)          return { x: +s.y, y: +s.z, z: s.x };
		if (to === A.EngineeringStyle) return { x: s.y, y: s.x, z: s.z };
	}
	else if (from === A.UnityStyle)
	{
		if (to === A.GlStyle)          return { x: s.x, y: s.y, z: s.z };
		if (to === A.EngineeringStyle) return { x: s.x, y: s.z, z: s.y };
	}
	else if (from === A.EngineeringStyle)
	{
		if (to === A.UnrealStyle)      return { x: s.y, y: s.x, z: s.z };
		if (to === A.UnityStyle)       return { x: s.x, y: s.z, z: s.y };
		if (to === A.GlStyle)          return { x: s.x, y: s.z, z: s.y };	// added (abs of position map)
	}
	else if (from === A.GlStyle)
	{
		if (to === A.UnrealStyle)      return { x: s.z, y: +s.x, z: +s.y };
		if (to === A.UnityStyle)       return { x: s.x, y: s.y, z: s.z };
		if (to === A.EngineeringStyle) return { x: s.x, y: s.z, z: s.y };	// added
	}
	return { x: s.x, y: s.y, z: s.z };
}

//! Convert a {position, orientation, scale} pose from one axes standard to another.
function ConvertPose(from, to, pose)
{
	return {
		position:    ConvertPosition(from, to, pose.position),
		orientation: ConvertRotation(from, to, pose.orientation),
		scale:       ConvertScale(from, to, pose.scale || { x: 1, y: 1, z: 1 }),
	};
}

const GeometryPayloadType =
{
	Invalid: 0,
	Mesh: 1,
	Material: 2,
	MaterialInstance: 3,
	Texture: 4,
	Animation: 5,
	Node: 6,
	Skeleton: 7,
	FontAtlas: 8,
	TextCanvas: 9,
	TexturePointer: 10,
	MeshPointer: 11,
	MaterialPointer: 12,
};

class DisplayInfo {
	constructor() {
		this.uint32_width = 0;		//!< Width of the display.
		this.uint32_height = 0;		//!< Height of the display.
		this.float_framerate = 0.0;	//!< Expected framerate.
	}
	static sizeof() {
		return 12;
	}
	size() {
		return DisplayInfo.sizeof();
	}
};
//! Features supported by a client.
class RenderingFeatures {
	constructor() {
		this.bool_normals = false;			//!< Whether normal maps are supported.
		this.bool_ambientOcclusion = false;	//!< Whether ambient occlusion maps are supported.
	}
	static sizeof() {
		return 2;
	}
	size() {
		return RenderingFeatures.sizeof();
	}
};

const LightingMode =
{
	NONE: 0,
	TEXTURE: 1,
	VIDEO: 2
};

const VideoCodec =
{
	Invalid: 0,
	H264: 1, /*!< H264 */
	HEVC: 2 /*!< HEVC (H265) */
};
//! Information on the configuration of a video stream.

class VideoConfig {
	constructor() {
		this.uint32_video_width = 0;
		this.uint32_video_height = 0;
		this.uint32_depth_width = 0;
		this.uint32_depth_height = 0;
		this.uint32_perspective_width = 0;
		this.uint32_perspective_height = 0;
		this.float_perspective_fov = 110;
		this.float_nearClipPlane = 0.5;
		this.uint32_webcam_width = 0;
		this.uint32_webcam_height = 0;
		this.int32_webcam_offset_x = 0;
		this.int32_webcam_offset_y = 0;
		this.uint32_use_10_bit_decoding = 0;
		this.uint32_use_yuv_444_decoding = 0;
		this.uint32_use_alpha_layer_decoding = 1;
		this.uint32_colour_cubemap_size = 0;
		this.int32_compose_cube = 0;
		this.int32_use_cubemap = 1;
		this.int32_stream_webcam = 0;
		this.VideoCodec_videoCodec = VideoCodec.Invalid;
		this.int32_shadowmap_x = 0;
		this.int32_shadowmap_y = 0;
		this.int32_shadowmap_size = 0;
	}
	static sizeof() {
		return 89;
	}
};	// 89 bytes

//! Audio configuration carried inside SetupCommand (17 bytes).
//! See docs/protocol/audio.rst §AudioConfig for the full specification.
class AudioConfig {
	constructor() {
		this.uint8_codec             = 1;    //!< 0=disabled; 1=Opus
		this.uint8_rtpPayloadType    = 111;
		this.uint32_sampleRateHz     = 48000;
		this.uint8_channelCount      = 1;
		this.uint8_frameDurationMs   = 20;
		this.uint8_flags             = 3;    //!< bit0=FEC, bit1=DTX
		this.uint8_maxInboundStreams = 0;
		this.uint8_selectionPolicy   = 0;    //!< 0=All
		this.float32_proximityRadiusMetres = 0.0;
		this.uint16_evictionGraceMs  = 0;
	}
	static sizeof() { return 17; }
};

//! Setup for dynamically-lit objects on the client.
class ClientDynamicLighting {
	constructor() {
		this.int2_specularPos = { int32_x: 0, int32_y: 0 };
		this.int32_specularCubemapSize = 0;
		this.int32_specularMips = 0;
		this.int2_diffusePos = { int32_x: 0, int32_y: 0 };
		this.int32_diffuseCubemapSize = 0;
		this.int2_lightPos = { int32_x: 0, int32_y: 0 };
		this.int32_lightCubemapSize = 0;
		this.uid_specular_cubemap_texture_uid = BigInt.asUintN(64, BigInt(0));
		this.uid_diffuse_cubemap_texture_uid = BigInt.asUintN(64, BigInt(0));	//14*4=56
		this.LightingMode_lightingMode = LightingMode.TEXTURE;// 57
	}
	static sizeof() {
		return 57;
	}
}; // 57 bytes

function encodeToUint8Array(object) {
	var array = new Uint8Array(object.size());
	var dataView = new DataView(array.buffer);
	var byteOffset = 0;
	byteOffset = encodeIntoDataView(object, dataView, byteOffset);
	console.log("\n");
	return array;
}

function decodeFromUint8Array(object, array) {
	if (array.length < object.size()) {
		console.log("Array is wrong size for " + object.toString() + ". have " + array.length.toString() + ", need " + object.size().toString() + ".");
	}
	var dataView = new DataView(array.buffer, array.offset, array.length);
	var byteOffset = 0;
	byteOffset = decodeFromDataView(object, dataView, byteOffset);
	if (byteOffset != object.size()) {
		console.error("Failed to read all of object. Read " + byteOffset + " but expected " + object.size());
	}
	console.log("\n");
	return byteOffset;
}

var generateUid = (function () {
	var i = 1;
	return function () {
		return BigInt(i++);
	};
})();

function unixTimeToUTCString(unix_time_us) {
	let unix_timestamp_ms = unix_time_us / 1000.0;

	// Create a new JavaScript Date object based on the timestamp
	// multiplied by 1000 so that the argument is in milliseconds, not seconds
	var date = new Date(unix_timestamp_ms);

	var hours = date.getHours();
	return Intl.DateTimeFormat('en-GB', {
		dateStyle: 'full',
		timeStyle: 'long',
		timeZone: 'UTC',
	}).format(date)
	// Hours part from the timestamp
	/*	var hours = date.getHours();
	
		// Minutes part from the timestamp
		var minutes = "0" + date.getMinutes();
	
		// Seconds part from the timestamp
		var seconds = "0" + date.getSeconds();
	
		// Will display time in 10:30:23 format
		var formattedTime = hours + ':' + minutes.substr(-2) + ':' + seconds.substr(-2);
	
		return formattedTime;*/
}

var startTimeUnixUs = 0;

function getStartTimeUnixUs() {
	if (startTimeUnixUs == 0)
		startTimeUnixUs = microtime.now();
	return startTimeUnixUs;
}

function getTimestampUs() {
	//var t_unix_ms=Date.now();
	//var t_perf_us=performance.now();
	const t_unix_us = microtime.now();
	const t_us = t_unix_us - getStartTimeUnixUs();
	return t_us;
}

function put_float32(dataView, byteOffset, value) {
	dataView.setFloat32(byteOffset, value, endian);
	byteOffset += 4;
	return byteOffset;
}

function put_uint16(dataView, byteOffset, value) {
	dataView.setUint16(byteOffset, value, endian);
	byteOffset += 2;
	return byteOffset;
}

function put_int32(dataView, byteOffset, value) {
	dataView.setInt32(byteOffset, value, endian);
	byteOffset += 4;
	return byteOffset;
}

function put_uint32(dataView, byteOffset, value) {
	dataView.setUint32(byteOffset, value, endian);
	byteOffset += 4;
	return byteOffset;
}

function put_uint64(dataView, byteOffset, value) {
	dataView.setBigUint64(byteOffset, BigInt(value), endian);
	byteOffset += 8;
	return byteOffset;
}

function put_uint8(dataView, byteOffset, value) {
	dataView.setUint8(byteOffset, value, endian);
	byteOffset++;
	return byteOffset;
}
function put_vec2(dataView, byteOffset, value) {
	dataView.setFloat32(byteOffset, value.x, endian);
	byteOffset+=4;
	dataView.setFloat32(byteOffset, value.y, endian);
	byteOffset+=4;
	return byteOffset;
}
function put_vec3(dataView, byteOffset, value) {
	dataView.setFloat32(byteOffset, value.x, endian);
	byteOffset+=4;
	dataView.setFloat32(byteOffset, value.y, endian);
	byteOffset+=4;
	dataView.setFloat32(byteOffset, value.z, endian);
	byteOffset+=4;
	return byteOffset;
}
function put_vec4(dataView, byteOffset, value) {
	dataView.setFloat32(byteOffset, value.x, endian);
	byteOffset+=4;
	dataView.setFloat32(byteOffset, value.y, endian);
	byteOffset+=4;
	dataView.setFloat32(byteOffset, value.z, endian);
	byteOffset+=4;
	dataView.setFloat32(byteOffset, value.w, endian);
	byteOffset+=4;
	return byteOffset;
}

//! Insert a string to the dataView.
function put_string(dataView, byteOffset, name) {
	byteOffset = put_uint16(dataView, byteOffset, name.length);
	// Push name.
	for (var i = 0; i < name.length; i++) {
		var char = name[i];
		var code = char.charCodeAt(0);
		byteOffset = put_uint8(dataView, byteOffset, code);
	}
	return byteOffset;
}

module.exports = {
	UID_SIZE, endian, SizeOfType, encodeIntoDataView, decodeFromDataView
	, vec4, BackgroundMode, AxesStandard, AxesStandardToCubemapSuffix
	, ConvertPosition, ConvertRotation, ConvertScale, ConvertPose
	, GeometryPayloadType, DisplayInfo, RenderingFeatures, LightingMode, VideoCodec
	, VideoConfig, AudioConfig, ClientDynamicLighting, encodeToUint8Array, decodeFromUint8Array
	, generateUid, getStartTimeUnixUs, getTimestampUs,
	unixTimeToUTCString, put_float32, put_uint16, put_int32, put_uint32
	, put_uint64, put_uint8, put_vec2, put_vec3, put_vec4, put_string
};
