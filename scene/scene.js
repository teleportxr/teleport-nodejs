'use strict';
const fs = require('fs');
var path = require('path');
const nd = require('./node.js');
const core = require('../core/core.js');
const resources = require('./resources.js');
const { error } = require('console');

class Scene {
	constructor() {
		this.nodes = new Map();
		this.backgroundTexturePath="";
		this.diffuseCubemapPath="";
		this.specularCubemapPath="";
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
		for (var attrname in jfa)
		{
			res[attrname] = jfa[attrname];
		}
	}
	//! Load an initial scene state from a json file.
	Load(filename) {
		const dir = path.dirname(filename).replaceAll("\\","/")+"/";
		const data = fs.readFileSync(filename, "utf8");
		const j = JSON.parse(data);
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
				var uid = resources.AddFontAtlas(sub_obj.path);
				var f = resources.GetResourceFromUid(uid);
				this.LoadFontAtlas(f,dir+sub_obj.path);
				console.log(f.uid);
			}
		}
		if(j.canvases)
		{
			const j_canvases=j.canvases;
			for (let [key, sub_obj] of Object.entries(j_canvases)) {
				var uid = resources.AddTextCanvas(key,sub_obj.font,sub_obj.lineHeight,sub_obj.content);
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
