'use strict';
const fs = require('fs');
const nd = require('../../scene/node.js');
const core= require('../../core/core.js');
const { error } = require('console');


function putPlaceholderSize(dataView)
{
	// Add placeholder for the payload size 
	dataView.setBigUint64(0,BigInt(0),core.endian);
	return 8;
}

// return the size of the encoded node.
// fromAxes/toAxes, when supplied, convert the node's transform from the server's axes standard to
// the client's during encoding (matches the C++ server). Omit them to encode the pose unchanged.
function encodeNode(node,buffer,fromAxes,toAxes)
{
	var byteOffset=0;
	const dataView = new DataView(buffer);
	byteOffset=putPlaceholderSize(dataView);

	var t=node.encodeIntoDataView(dataView,byteOffset,fromAxes,toAxes);
	byteOffset=t;
	// Actual size is now known: write the count of bytes that follow the
	// size field, in little-endian (the protocol convention). Without the
	// explicit core.endian flag DataView defaults to big-endian.
	dataView.setBigUint64(0,BigInt(byteOffset-8),core.endian);
	return byteOffset;
}
module.exports= {encodeNode};