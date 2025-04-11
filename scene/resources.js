'use strict';
const core= require('../core/core.js');

/// Each resource has a url. If it's a local URL, the resource
/// is stored here on the server. If not, it's a remotely stored resource,
/// accessed by https.
class Resource
{
	//! One trackedResources shared acrosss all clients.
	static resourcesByUid=new Map();
	static pathToUid=new Map();
	static defaultPathRoot="http://localhost";
	static SetDefaultPathRoot(str)
	{
		Resource.defaultPathRoot=str;
	}
    constructor(type,uid,url)
    {
		this.uid=uid;
		this.url=url;
		this.type=type;
	}
	encodeIntoDataView(dataView,byteOffset) {
		byteOffset=core.put_uint8(dataView,byteOffset,this.type);
		byteOffset=core.put_uint64(dataView,byteOffset,this.uid);
		var url=this.url;
		if(this.url.search("://")==-1)
			url=Resource.defaultPathRoot+this.url;
		byteOffset=core.put_string(dataView,byteOffset,url);
		return byteOffset;
	}
}

function GetResourceUidFromUrl(type,url)
{
	if(Resource.pathToUid.has(url))
	{
		var uid=Resource.pathToUid.get(url);
		return uid;
	}
	var uid=core.generateUid();
	Resource.resourcesByUid.set(uid,new Resource(type,uid,url));
	Resource.pathToUid.set(url,uid);
	return uid;
}

function GetResourceFromUrl(url)
{
	if(!Resource.pathToUid.has(url))
		return null;
	var uid=Resource.pathToUid.get(url);
	if(uid==0)
		return null;
	var res=Resource.resourcesByUid.get(uid);
	return res;
}

function GetResourceFromUid(uid)
{
	var res=Resource.resourcesByUid.get(uid);
	return res;
}

//! Add the texture url as a resource.
function AddTexture(url)
{
	return GetResourceUidFromUrl(core.GeometryPayloadType.TexturePointer,url);
}

//! Add the texture url as a resource.
function AddMesh(url)
{
	return GetResourceUidFromUrl(core.GeometryPayloadType.MeshPointer,url);
}

module.exports = {Resource,GetResourceFromUrl,GetResourceUidFromUrl,GetResourceFromUid,AddTexture,AddMesh};
