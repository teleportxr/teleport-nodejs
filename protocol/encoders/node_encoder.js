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
function encodeNode(node,buffer)
{
	var byteOffset=0;
	const dataView = new DataView(buffer); 
	byteOffset=putPlaceholderSize(dataView);

	var t=node.encodeIntoDataView(dataView,byteOffset);
	byteOffset=t;
	// Actual size is now known: write the count of bytes that follow the
	// size field, in little-endian (the protocol convention). Without the
	// explicit core.endian flag DataView defaults to big-endian.
	dataView.setBigUint64(0,BigInt(byteOffset-8),core.endian);
	return byteOffset;
}
module.exports= {encodeNode};