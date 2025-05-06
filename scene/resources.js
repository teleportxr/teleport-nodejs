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
	}
	encodedSize(){
		return 500;
	}
	encodeIntoDataView(dataView, byteOffset) {
		byteOffset = core.put_uint8(dataView, byteOffset, this.type);
		byteOffset = core.put_uint64(dataView, byteOffset, this.uid);
		var url = this.url;
		if (this.url.search("://") == -1)
			url = Resource.defaultPathRoot + this.url;
		byteOffset = core.put_string(dataView, byteOffset, url);
		return byteOffset;
	}
}

class FontAtlas extends Resource {
	constructor(uid, url) {
		super(core.GeometryPayloadType.FontAtlas, uid, url);
		this.font_texture_uid=0;
	}
	encodedSize(){
		const numMaps = this.fontMaps.size;
		var sz=26;
		for (let [key, fontMap] of Object.entries(this.fontMaps)) {
			sz+=8;
			const numGlyphs = fontMap.glyphs.length;
			sz += numGlyphs * 28;
		}
		return sz+8;
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
		

		for (let [key, fontMap] of Object.entries(this.fontMaps)) {
			byteOffset = core.put_uint16(dataView, byteOffset, key);	
			byteOffset = core.put_float32(
				dataView,
				byteOffset,
				fontMap.lineHeight
			);
			const numGlyphs = fontMap.glyphs.length;
			byteOffset = core.put_uint16(dataView, byteOffset, numGlyphs);	// 8
			for (let glyph of fontMap.glyphs) {
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

		return byteOffset-8;
	}
}

class TextCanvas extends Resource {
	constructor(uid, url) {
		super(core.GeometryPayloadType.TextCanvas, uid, url);
	}
	static getType() {
		return core.GeometryPayloadType.TextCanvas;
	}
	encodeIntoDataView(dataView, byteOffset) {
		byteOffset = core.put_uint8(dataView, byteOffset, this.type);
		byteOffset = core.put_uint64(dataView, byteOffset, this.uid);

		byteOffset = core.put_uint64(dataView, byteOffset, this.fontAtlasUid);
		byteOffset = core.put_int32(dataView, byteOffset, 64);
		byteOffset = core.put_float32(dataView, byteOffset, this.lineHeight);
		const colour = new core.vec4();
		colour.float_x = 1.0;
		colour.float_y = 0.5;
		colour.float_z = 0.0;
		colour.float_w = 1.0;
		byteOffset = core.put_vec4(dataView, byteOffset, colour);

		byteOffset = core.put_string(dataView, byteOffset, this.content);
		return byteOffset;
	}
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

function AddResourceFromUrl(type, url) {
	var uid = core.generateUid();
	var res = null;
	switch (type) {
		case core.GeometryPayloadType.TextCanvas:
		case core.GeometryPayloadType.FontAtlas:
			throw new Error(
				"Type ",
				type,
				" can't be instantiated with AddResourceFromUrl()."
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
	return 0;
}

function GetOrAddResourceUidFromUrl(type, url){
	var uid=GetResourceUidFromUrl(type, url);
	if(uid!=0)
		return uid;
	return AddResourceFromUrl(type, url);
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

//! Add the texture url as a resource.
function AddTexture(url) {
	return AddResourceFromUrl(core.GeometryPayloadType.TexturePointer, url);
}

//! Add the texture url as a resource.
function AddMesh(url) {
	return AddResourceFromUrl(core.GeometryPayloadType.MeshPointer, url);
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
	GetResourceFromUrl,
	GetResourceUidFromUrl,
	GetOrAddResourceUidFromUrl,
	GetResourceFromUid,
	AddTexture,
	AddMesh,
	AddFontAtlas,
	AddTextCanvas,
	AddTypedResource,
};
