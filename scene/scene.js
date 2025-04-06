'use strict';
const fs = require('fs');
const nd = require('./node.js');
const core = require('../core/core.js');
const resources = require('./resources.js');
const { error } = require('console');

class Scene {
	constructor() {
		this.nodes = new Map();
		this.backgroundTexturePath="";
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
	//! Load an initial scene state from a json file.
	Load(filename) {
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
				}
				const components = sub_obj["components"];
				if (components) {
					for (let c of components) {
						if (c["type"] == "mesh")
							n.setMeshComponent(c["url"]);
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
