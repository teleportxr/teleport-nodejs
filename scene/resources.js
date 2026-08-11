"use strict";
const core = require("../core/core.js");

/// Each resource has a url. If it's a local URL, the resource
/// is stored here on the server. If not, it's a remotely stored resource,
/// accessed by https.
class Resource {
	//! One trackedResources shared acrosss all clients.
	static resourcesByUid = new Map();
	static pathToUid = new Map();
	static defaultPathRoot = "http://localhost";
	static SetDefaultPathRoot(str) {
		Resource.defaultPathRoot = str;
	}
	constructor(type, uid, url) {
		this.uid = uid;
		this.url = url;
		this.type = type;
		// True for environment cubemaps (background/diffuse/specular). Such resources are
		// served per-client in the variant matching the client's axes standard.
		this.isCubemap = false;
		//! The axes standard the asset behind this url is authored in, for pointer types.
		//!
		//! NotInitialized means "the same as the server's scene", which is the common case and
		//! what the client assumes when the field is absent. It needs setting only for assets
		//! that disagree with the server: a glTF-family file (.glb/.vrm/.vrma) is always Y-up
		//! right-handed (GlStyle) regardless of what the scene around it uses, and the client
		//! applies a real conversion from this standard to its own.
		this.axesStandard = core.AxesStandard.NotInitialized;
	}
	//! Buffer to allocate before encoding. Includes the 8-byte payload-size prefix that
	//! resource_encoder.EncodeResource writes ahead of the body, as FontAtlas.encodedSize
	//! does — the figure is a buffer size, not a body size.
	//!
	//! **This sizes a pointer body specifically.** Any subclass that overrides
	//! encodeIntoDataView writes something other than a url and must override this as well;
	//! inheriting it will under-allocate and fail at send time. See test_resource_encoded_size.js.
	//!
	//! Body: uint8 type + uint64 uid + uint8 axes standard + uint16 url length + the url's
	//! bytes. Sized from the url actually about to be encoded, not a fixed figure: the
	//! url actually about to be encoded, not a fixed figure: the default path root is
	//! prepended to relative urls, and a long CDN root plus a long path will pass any guess.
	//! Takes the same urlOverride as encodeIntoDataView so the two always agree.
	encodedSize(urlOverride){
		const url=urlOverride||this.url||"";
		const root=(url.search("://")==-1)?Resource.defaultPathRoot:"";
		// put_string writes one byte per UTF-16 code unit; the UTF-8 length is an upper
		// bound on that, so allocating by it is always enough.
		return 20+Buffer.byteLength(root+url,'utf8');
	}
	//! Does this pointer type carry a meaningful axes standard? Only the ones whose asset
	//! has a geometric frame: a texture does not (its byte is a placeholder for future
	//! texture interpretation), and a cubemap's orientation is handled instead by serving
	//! a per-axes variant of the file (see GetOrAddCubemap).
	carriesAxesStandard() {
		return this.type == core.GeometryPayloadType.MeshPointer
			|| this.type == core.GeometryPayloadType.AnimationPointer;
	}
	//! urlOverride, if supplied, replaces this.url for this encoding only (e.g. to send a
	//! client-specific cubemap variant). The stored this.url is left untouched.
	encodeIntoDataView(dataView, byteOffset, urlOverride) {
		byteOffset = core.put_uint8(dataView, byteOffset, this.type);
		byteOffset = core.put_uint64(dataView, byteOffset, this.uid);
		// Every pointer body begins with an axes-standard byte, ahead of the url, so it is
		// always in the same place. For pointer types that don't carry one (see
		// carriesAxesStandard) this stays NotInitialized — a placeholder, not a statement
		// about the asset.
		byteOffset = core.put_uint8(dataView, byteOffset, this.axesStandard);
		var url = urlOverride || this.url;
		if (url.search("://") == -1)
			url = Resource.defaultPathRoot + url;
		byteOffset = core.put_string(dataView, byteOffset, url);
		return byteOffset;
	}
}

class FontAtlas extends Resource {
	constructor(uid, url) {
		super(core.GeometryPayloadType.FontAtlas, uid, url);
		this.font_texture_uid=0;
		this.fontMaps=new Map();
	}
	encodedSize(){
		const numMaps = this.fontMaps.size;
		var sz=26;
		for (let [key, fontMap] of this.fontMaps) {
			sz+=8;
			const numGlyphs = fontMap.glyphs.length;
			sz += numGlyphs * 30;
		}
		return sz;
	}

	encodeIntoDataView(dataView, byteOffset) {
		if (this.font_texture_uid==0)
		{
			this.font_texture_uid=GetOrAddResourceUidFromUrl(core.GeometryPayloadType.TexturePointer,this.font_texture_path);
		}
		byteOffset = core.put_uint8(dataView, byteOffset, this.type);	// 9
		byteOffset = core.put_uint64(dataView, byteOffset, this.uid);	// 17

		byteOffset = core.put_uint64(									// 25
			dataView,
			byteOffset,
			this.font_texture_uid
		);
		const numMaps = this.fontMaps.size;
		byteOffset = core.put_uint8(dataView, byteOffset, numMaps);		// 26
		
		for (let [key, fontMap] of this.fontMaps) {
			byteOffset = core.put_uint16(dataView, byteOffset, key);	
			byteOffset = core.put_float32(
				dataView,
				byteOffset,
				fontMap.lineHeight
			);
			const numGlyphs = fontMap.glyphs.length;
			byteOffset = core.put_uint16(dataView, byteOffset, numGlyphs);	// 8
			for (let glyph of fontMap.glyphs) {
				byteOffset = core.put_uint16(dataView, byteOffset, glyph.indexInCharset);
				byteOffset = core.put_uint16(dataView, byteOffset, glyph.x0); // g * 28
				byteOffset = core.put_uint16(dataView, byteOffset, glyph.y0);
				byteOffset = core.put_uint16(dataView, byteOffset, glyph.x1);
				byteOffset = core.put_uint16(dataView, byteOffset, glyph.y1);
				byteOffset = core.put_float32(
					dataView,
					byteOffset,
					glyph.xOffset
				);
				byteOffset = core.put_float32(
					dataView,
					byteOffset,
					glyph.yOffset
				);
				byteOffset = core.put_float32(
					dataView,
					byteOffset,
					glyph.xAdvance
				);
				byteOffset = core.put_float32(
					dataView,
					byteOffset,
					glyph.xOffset2
				);
				byteOffset = core.put_float32(
					dataView,
					byteOffset,
					glyph.yOffset2
				);
			}
		}
		return byteOffset;
	}
}

class TextCanvas extends Resource {
	constructor(uid, url) {
		super(core.GeometryPayloadType.TextCanvas, uid, url);
	}
	static getType() {
		return core.GeometryPayloadType.TextCanvas;
	}
	//! Required, not optional: the base encodedSize sizes a *pointer* body (a url), and a
	//! text canvas writes something else entirely. Any subclass that overrides
	//! encodeIntoDataView must override this too.
	encodedSize() {
		// prefix(8) type(1) uid(8) fontAtlasUid(8) int32(4) lineHeight(4) colour(16)
		// content length(2) + content
		return 51 + Buffer.byteLength(this.content || "", 'utf8');
	}
	encodeIntoDataView(dataView, byteOffset) {
		byteOffset = core.put_uint8(dataView, byteOffset, this.type);
		byteOffset = core.put_uint64(dataView, byteOffset, this.uid);

		byteOffset = core.put_uint64(dataView, byteOffset, this.fontAtlasUid);
		byteOffset = core.put_int32(dataView, byteOffset, 128);
		byteOffset = core.put_float32(dataView, byteOffset, this.lineHeight);
		const colour = new core.vec4();
		colour.x = 0.6;
		colour.y = 0.3;
		colour.z = 0.0;
		colour.w = 1.0;
		byteOffset = core.put_vec4(dataView, byteOffset, colour);

		byteOffset = core.put_string(dataView, byteOffset, this.content);
		return byteOffset;
	}
}

//! A server-authored skeletal animation, sent inline as keyframes (payload type 5).
//!
//! **Disabled, and must stay that way** — see `enableNativeAnimationPayload` below. It is
//! kept because the byte layout is part of the protocol and worth having encoded and tested,
//! and because a server that one day authors its own Skeleton payloads will need it. Today
//! it cannot play:
//!
//!   * Keyframes are indexed by `int16` bone number against a Skeleton resource this server
//!     never sends, so the client has nothing to resolve the indices against.
//!   * Retargeting matches on joint *names*, which this format does not carry. An animation
//!     built this way is never retargeted, and the client only ever plays retargeted clips.
//!
//! Use AnimationPointer instead: a URL to a `.vrma`/`.glb`, which does carry joint names.
class Animation extends Resource {
	constructor(uid, url) {
		super(core.GeometryPayloadType.Animation, uid, url);
		this.animationName = "";
		//! Seconds. Note the C++ struct's "//Milliseconds" comments are wrong; the wire,
		//! and ozz, use seconds throughout.
		this.duration = 0.0;
		//! [{boneIndex, positionKeyframes:[{time,value:{x,y,z}}], rotationKeyframes:[{time,value:{x,y,z,w}}]}]
		this.boneKeyframes = [];
	}
	static getType() {
		return core.GeometryPayloadType.Animation;
	}
	encodedSize() {
		// 8-byte payload-size prefix, then: uint8 type + uint64 uid + uint16 name length
		// + name + float duration + uint64 track count
		let sz = 8 + 1 + 8 + 2 + Buffer.byteLength(this.animationName, 'utf8') + 4 + 8;
		for (const track of this.boneKeyframes) {
			// int16 boneIndex + uint64 position count + uint64 rotation count
			sz += 2 + 8 + 8;
			// Each position keyframe is float time + vec3; each rotation float time + vec4.
			sz += track.positionKeyframes.length * 16;
			sz += track.rotationKeyframes.length * 20;
		}
		return sz;
	}
	encodeIntoDataView(dataView, byteOffset) {
		byteOffset = core.put_uint8(dataView, byteOffset, this.type);
		byteOffset = core.put_uint64(dataView, byteOffset, this.uid);
		byteOffset = core.put_string(dataView, byteOffset, this.animationName);
		byteOffset = core.put_float32(dataView, byteOffset, this.duration);
		byteOffset = core.put_uint64(dataView, byteOffset, this.boneKeyframes.length);
		for (const track of this.boneKeyframes) {
			byteOffset = core.put_int16(dataView, byteOffset, track.boneIndex);
			byteOffset = core.put_uint64(dataView, byteOffset, track.positionKeyframes.length);
			for (const k of track.positionKeyframes) {
				byteOffset = core.put_float32(dataView, byteOffset, k.time);
				byteOffset = core.put_vec3(dataView, byteOffset, k.value);
			}
			byteOffset = core.put_uint64(dataView, byteOffset, track.rotationKeyframes.length);
			for (const k of track.rotationKeyframes) {
				byteOffset = core.put_float32(dataView, byteOffset, k.time);
				byteOffset = core.put_vec4(dataView, byteOffset, k.value);
			}
		}
		return byteOffset;
	}
}

//! Kill switch for the inline Animation payload above. Leave false.
//!
//! Beyond being unplayable, an inline clip is far larger than anything this server has ever
//! put on a data channel: Idle.vrma is ~31 kB against a ceiling of a few hundred bytes for
//! every payload sent to date, and WebRtcConnection.sendGeometry does no chunking. Measure
//! before ever turning this on.
let enableNativeAnimationPayload = false;

function SetNativeAnimationPayloadEnabled(enabled) {
	enableNativeAnimationPayload = !!enabled;
}

function IsNativeAnimationPayloadEnabled() {
	return enableNativeAnimationPayload;
}

function AddTypedResource(typename, path) {
	if (Resource.pathToUid.has(path)) {
		throw new Error("Resource already exists at " + path);
		return uid;
	}
	var uid = core.generateUid();
	Resource.resourcesByUid.set(
		uid,
		new typename(uid, path)
	);
	Resource.pathToUid.set(path, uid);
	return uid;
}

function GetOrAddResourceFromUrl(type, url) {
	if (Resource.pathToUid.has(url)) {
		return Resource.pathToUid.get(url);
	}
	var uid = core.generateUid();
	var res = null;
	switch (type) {
		case core.GeometryPayloadType.TextCanvas:
		case core.GeometryPayloadType.FontAtlas:
			throw new Error(
				"Type ",
				type,
				" can't be instantiated with GetOrAddResourceFromUrl()."
			);
			break;
		default:
			res = new Resource(type, uid, url);
			break;
	}

	Resource.resourcesByUid.set(uid, res);
	Resource.pathToUid.set(url, uid);
	return uid;
}

function GetResourceUidFromUrl(type, url) {
	if (Resource.pathToUid.has(url)) {
		var uid = Resource.pathToUid.get(url);
		return uid;
	}
	console.error("GetResourceUidFromUrl, could not find resource uid for " + url);
	return 0;
}

function GetOrAddResourceUidFromUrl(type, url){
	var uid=GetResourceUidFromUrl(type, url);
	if(uid!=0)
		return uid;
	if(!url)
		return 0;
	return GetOrAddResourceFromUrl(type, url);
}

function GetResourceFromUrl(url) {
	if (!Resource.pathToUid.has(url)) return null;
	var uid = Resource.pathToUid.get(url);
	if (uid == 0) return null;
	var res = Resource.resourcesByUid.get(uid);
	return res;
}

function GetResourceFromUid(uid) {
	var res = Resource.resourcesByUid.get(uid);
	return res;
}

//! Get or add the texture url as a resource.
function GetOrAddTexture(url) {
	return GetOrAddResourceFromUrl(core.GeometryPayloadType.TexturePointer, url);
}

//! Get or add a cubemap texture, flagging the resource so it is served per-client in the
//! variant matching the client's axes standard. Returns the resource uid.
function GetOrAddCubemap(url) {
	const uid = GetOrAddTexture(url);
	const res = GetResourceFromUid(uid);
	if (res)
		res.isCubemap = true;
	return uid;
}

//! Insert an axes suffix before a cubemap URL's extension:
//!   InsertCubemapAxesSuffix("/envCloudyCubemap.ktx2", "ogl") -> "/envCloudyCubemap_ogl.ktx2"
//! Returns the url unchanged when the suffix is empty.
function InsertCubemapAxesSuffix(url, suffix) {
	if (!suffix || !url)
		return url;
	const dot = url.lastIndexOf(".");
	if (dot < 0)
		return url + "_" + suffix;
	return url.substring(0, dot) + "_" + suffix + url.substring(dot);
}

//! Parse an axes standard written as a friendly name, as scene.json and the server config
//! use. Accepts a number too, so a raw wire value can be given where that is clearer.
//! Returns core.AxesStandard.NotInitialized for anything unrecognised, which means "same as
//! the server's scene".
function ParseAxesStandard(value) {
	if (value === undefined || value === null || value === "")
		return core.AxesStandard.NotInitialized;
	if (typeof value === "number")
		return value;
	const name = String(value).trim().toLowerCase();
	switch (name) {
		// glTF and everything built on it - .glb, .vrm, .vrma - is Y-up right-handed.
		case "gl": case "gltf": case "glstyle": case "opengl":
			return core.AxesStandard.GlStyle;
		case "engineering": case "eng": case "engineeringstyle": case "zup":
			return core.AxesStandard.EngineeringStyle;
		case "unity": case "unitystyle":
			return core.AxesStandard.UnityStyle;
		case "unreal": case "unrealstyle":
			return core.AxesStandard.UnrealStyle;
		default:
			console.warn("Unknown axes standard '" + value + "'; treating as the server's own.");
			return core.AxesStandard.NotInitialized;
	}
}

//! Record the axes standard an already-registered resource's asset is authored in.
//! Only needed where the asset disagrees with the server's own scene; see Resource.axesStandard.
function SetResourceAxesStandard(uid, axesStandard) {
	const res = GetResourceFromUid(uid);
	if (!res)
		return false;
	res.axesStandard = ParseAxesStandard(axesStandard);
	return true;
}

//! Get or add the mesh url as a resource.
//! axesStandard is optional; omit it for an asset authored in the server's own frame.
function GetOrAddMesh(url, axesStandard) {
	const uid = GetOrAddResourceFromUrl(core.GeometryPayloadType.MeshPointer, url);
	if (axesStandard !== undefined)
		SetResourceAxesStandard(uid, axesStandard);
	return uid;
}

//! Get or add an animation clip url as a resource. The client fetches the url and decodes
//! the body as an Animation, so it must end in an extension the client dispatches on:
//! `.vrma`, `.glb`, `.vrm` (glTF binary) or `.gltf` (glTF text).
//!
//! One uid identifies one axes-converted variant of one clip, exactly as for meshes and
//! textures. Serving two axes standards from a single uid is not possible; mint a separate
//! resource per (clip, axes standard) if that is ever needed.
//! axesStandard is optional; omit it for a clip authored in the server's own frame. A
//! `.vrma` is glTF, so it is Y-up ("gl") whatever the scene around it uses — but it must
//! agree with the avatar it will be retargeted onto, which is streamed as a MeshPointer.
function GetOrAddAnimationPointer(url, axesStandard) {
	const uid = GetOrAddResourceFromUrl(core.GeometryPayloadType.AnimationPointer, url);
	if (axesStandard !== undefined)
		SetResourceAxesStandard(uid, axesStandard);
	return uid;
}

function AddFontAtlas(path) {
	const atlas_uid = AddTypedResource(FontAtlas, path);
	return atlas_uid;
}

function AddTextCanvas(path, font_atlas, line_height, content) {
	const canvas_uid = AddTypedResource(TextCanvas, path);
	const canvas = GetResourceFromUid(canvas_uid);
	canvas.fontAtlasUid = GetResourceUidFromUrl(core.GeometryPayloadType.FontAtlas, font_atlas);
	canvas.lineHeight = line_height;
	canvas.content = content;
	return canvas_uid;
}

module.exports = {
	Resource,
	FontAtlas,
	Animation,
	SetNativeAnimationPayloadEnabled,
	IsNativeAnimationPayloadEnabled,
	GetOrAddAnimationPointer,
	ParseAxesStandard,
	SetResourceAxesStandard,
	GetResourceFromUrl,
	GetResourceUidFromUrl,
	GetOrAddResourceUidFromUrl,
	GetResourceFromUid,
	GetOrAddTexture,
	GetOrAddCubemap,
	InsertCubemapAxesSuffix,
	GetOrAddMesh,
	AddFontAtlas,
	AddTextCanvas,
	AddTypedResource,
};
