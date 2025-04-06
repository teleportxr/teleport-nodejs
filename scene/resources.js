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
    constructor(type,uid,url)
    {
		this.uid=uid;
		this.url=url;
		this.type=type;
	}
	encodeIntoDataView(dataView,byteOffset) {
		byteOffset=core.put_uint8(dataView,byteOffset,this.type);
		byteOffset=core.put_uint64(dataView,byteOffset,this.uid);
		byteOffset=core.put_string(dataView,byteOffset,this.url);
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
	GetResourceUidFromUrl(core.GeometryPayloadType.TexturePointer,url);
}

module.exports = {Resource,GetResourceFromUrl,GetResourceUidFromUrl,GetResourceFromUid,AddTexture};
