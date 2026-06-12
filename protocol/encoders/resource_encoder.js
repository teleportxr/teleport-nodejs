'use strict';
const fs = require('fs');
const resources = require('../../scene/resources.js');
const core= require('../../core/core.js');
const { error } = require('console');


function putPlaceholderSize(dataView)
{
	// Add placeholder for the payload size 
	dataView.setBigUint64(0,BigInt(0),core.endian);
	return 8;
}

// return the size of the encoded resource.
// urlOverride, if supplied, is passed to the resource so it can encode a client-specific
// url (e.g. an axes-standard cubemap variant) without mutating the shared resource.
function EncodeResource(res,buffer,urlOverride)
{
	var byteOffset=0;
	const dataView = new DataView(buffer);
	byteOffset=putPlaceholderSize(dataView);
	var t=res.encodeIntoDataView(dataView,byteOffset,urlOverride);
	byteOffset=t;
	t-=8;
	// Actual size is now known: write the count of bytes that follow the
	// size field, in little-endian (the protocol convention). Without the
	// explicit core.endian flag DataView defaults to big-endian.
	dataView.setBigUint64(0,BigInt(t),core.endian);
	return byteOffset;
}
module.exports= {EncodeResource};
