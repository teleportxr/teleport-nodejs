'use strict';
const fs = require('fs');
var path = require('path');
const nd = require('./node.js');
const core = require('../core/core.js');
const resources = require('./resources.js');
const { error } = require('console');
const generateBMFont = require('msdf-bmfont-xml');

class Scene {
	constructor() {
		this.nodes = new Map();
		this.backgroundTexturePath="";
		this.diffuseCubemapPath="";
		this.specularCubemapPath="";
		this.assetsPath="assets";
		this.publicPath="http_resources";
	}
	GetOrCreateNode(uid) {
		if (!this.nodes.has(uid)) {
			this.nodes.set(uid, new nd.Node(uid));
		}
		var c = this.nodes.get(uid);
		return c;
	}
	GetNode(uid) {
		if (!this.nodes.has(uid)) {
			return null;
		}
		var c = this.nodes.get(uid);
		return c;
	}
	CreateNode(name) {
		var uid = core.generateUid();
		if (this.nodes.has(uid)) {
			error("Uid " + uid + " already present.");
		}
		this.nodes.set(uid, new nd.Node(uid, name));
		return uid;
	}
	GetAllNodeUids() {
		let node_uids = Array.from(this.nodes.keys());
		return node_uids;
	}
	LoadFontAtlas(res, filename) {
		const data = fs.readFileSync(filename, "utf8");
		const jfa = JSON.parse(data);
		res.charset='!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
		// jfa.fontMaps should be a Map, but JSON treats it as an object.
		res.fontMaps = new Map(Object.entries(jfa.fontMaps));
		for (let [sz,fm] of res.fontMaps) {
			var n=0;
			for(let g of fm.glyphs){
				g.indexInCharset=n;
				n++;
			}
		}
		console.log("FontAtlas, ",res.fontMaps.size," maps.");
	}
	// Create the font atlas dst_atlas_filename from a specified font.
	CreateFontAtlas(f,src_font_filename,dst_atlas_filename) {
		let options = {
			fieldType: 'msdf',
			outputType: 'json',
			roundDecimal: 6,
			smartSize: true,
			pot: true,
			fontSize: 42,
			distanceRange: 4,
			charset: ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'
		  };         
		var texture_filename='';
		generateBMFont(
			src_font_filename,
			options,
			(err, textures, font) => {
			  if (err) {
				console.error(err)
				reject(err)
			  } else {
				textures.forEach((texture) => {
				  try {
					texture_filename=texture.filename+".png";
					fs.writeFileSync(texture_filename, texture.texture);
				  } catch (e) {
					console.error(e);
					reject(e);
				  }
				})
				try {
					fs.writeFileSync(dst_atlas_filename, font.data);
					const jfa = JSON.parse(font.data);
					// The texture will be in the assets folder, but we want to put it into our public http directory.
					
					const asset_path = path.relative(this.assetsPath,texture_filename).replaceAll("\\","/");
					const public_path= path.join(this.publicPath, asset_path);

					fs.copyFile(path.join(this.assetsPath, asset_path), public_path, (err) => {
						if (err)
							throw err;
						console.log('Created ',public_path);
					  });

					f.font_texture_path = "/"+asset_path;
					f.font_texture_uid=resources.GetOrAddResourceUidFromUrl(core.GeometryPayloadType.TexturePointer,f.font_texture_path);
					f.charset=options.charset;
					f.fontMaps.set("128",{});
					var fm=f.fontMaps.get("128");
					fm.lineHeight=jfa.common.lineHeight;
					fm.glyphs=[];
					for (let c of jfa.chars) {
					/*
        {
            "id": 40,
            "index": 11,
            "char": "(",
            "width": 14,
            "height": 46,
            "xoffset": 1,
            "yoffset": 1.536133,
            "xadvance": 13.986328,
            "chnl": 15,
            "x": 0,
            "y": 0,
            "page": 0
        },
					*/
					var index=f.charset.lastIndexOf(c.char);
					const g={indexInCharset: index,
						x0: c.x,
						x1: c.x+c.width,
						y0: c.y,
						y1: c.y+c.height,
						xAdvance: c.xadvance,
						xOffset: c.xoffset,
						xOffset2: c.xoffset+c.width,
						yOffset: c.yoffset,
						yOffset2: c.yoffset+c.height,
					};
					fm.glyphs.push(g);
				  }
				  fm.glyphs.sort((a, b) => a.indexInCharset - b.indexInCharset)
				} catch (err) {
				  console.error(err);
				  reject(err);
				}
			  }
			}
		  )
	}
	SetAssetsPath(pt){
		this.assetsPath=pt;
	}
	SetPublicPath(pp){
		this.publicPath=pp;
	}
	//! Load an initial scene state from a json file.
	Load(filename) {
		filename=path.join(this.assetsPath,filename);
		const dir = path.dirname(filename).replaceAll("\\","/")+"/";
		const data = fs.readFileSync(filename, "utf8");
		const j = JSON. parse(data);
		console.log(j);
		if(j.environment)
		{
			if(j.environment.background_texture)
			{
				this.backgroundTexturePath=j.environment.background_texture;
				resources.AddTexture(this.backgroundTexturePath);
			}
			if(j.environment.diffuse_cubemap)
			{
				this.diffuseCubemapPath=j.environment.diffuse_cubemap;
				resources.AddTexture(this.diffuseCubemapPath);
			}
			if(j.environment.specular_cubemap)
			{
				this.specularCubemapPath=j.environment.specular_cubemap;
				resources.AddTexture(this.specularCubemapPath);
			}
		}
		if(j.font_atlases)
		{
			const j_fonts=j.font_atlases;
			for (let sub_obj of j_fonts) {
				if(!sub_obj.path){
					// No path? Maybe there's a ttf or otf font?
					if(!sub_obj.font)
						continue;
					let index = sub_obj.font.lastIndexOf(".");
					var sdf_filename=sub_obj.font.substring(0,index)+".font_atlas_sdf";
					var uid = resources.AddFontAtlas(sub_obj.font);
					var f = resources.GetResourceFromUid(uid);
					this.CreateFontAtlas(f,path.join(dir,sub_obj.font),path.join(dir,sdf_filename));
				

				} else {

					var uid = resources.AddFontAtlas(sub_obj.path);
					var f = resources.GetResourceFromUid(uid);
					this.LoadFontAtlas(f,dir+sub_obj.path);
					f.font_texture_path=sub_obj.font_texture_path;
					f.font_texture_uid=resources.GetOrAddResourceUidFromUrl(core.GeometryPayloadType.TexturePointer,f.font_texture_path);
				
					console.log(f.uid);
				}
			}
		}
		if(j.canvases)
		{
			const j_canvases=j.canvases;
			for (let [key, sub_obj] of Object.entries(j_canvases)) {
				var content = sub_obj.content
				if(Array.isArray ( content))
					content=sub_obj.content.join('\n');
				var uid = resources.AddTextCanvas(key,sub_obj.font,sub_obj.lineHeight,content);
			}
		}
		if(j.nodes)
		{
			const j_nodes=j.nodes;
			for (let [key, sub_obj] of Object.entries(j_nodes)) {
				var uid = this.CreateNode();
				var n = this.GetNode(uid);
				n.name = key;
				const pose = sub_obj["pose"];
				if (pose) {
					n.pose.position = { x: pose.position[0], y: pose.position[1], z: pose.position[2] };
					n.pose.orientation = { x: pose.orientation[0], y: pose.orientation[1], z: pose.orientation[2], w: pose.orientation[3] };
					n.pose.scale = { x: pose.scale[0], y: pose.scale[1], z: pose.scale[2] };
				}
				const components = sub_obj["components"];
				if (components) {
					for (let c of components) {
						if (c["type"] == "mesh")
						{
							var mesh_url=c["url"];
							n.setMeshComponent(mesh_url);
						}
						if (c["type"] == "canvas")
						{
							var canvas=c.url;
							n.setCanvasComponent(canvas);
						}
					}
				}
			}
		}
	}
	writeState() {
		var content="";
		this.nodes.forEach(node => {
			content=content+"Node "+node.uid+" " + node.name + "<br>";
		});
		return content;
	}
}

module.exports = { Scene };
