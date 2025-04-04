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
    constructor(uid,url)
    {
		this.uid=uid;
		this.url=url;
	}
}

function GetResourceUidFromUrl(url)
{
	if(Resource.pathToUid.has(url))
	{
		var uid=Resource.pathToUid.get(url);
		return uid;
	}
	var uid=core.generateUid();
	Resource.resourcesByUid.set(uid,new Resource(uid,url));
	Resource.pathToUid.set(url,uid);
	return uid;
}

function GetResourceFromUrl(url)
{
	var uid=GetResourceUidFromUrl(url);
	if(uid==0)
		return null;
	var res=Resource.resourcesByUid.get(uid);
	return res;
}

module.exports = {Resource,GetResourceFromUrl,GetResourceUidFromUrl};
