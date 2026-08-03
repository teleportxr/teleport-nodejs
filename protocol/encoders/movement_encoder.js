'use strict';
const core= require('../../core/core.js');
const command= require('../command.js');

// Encode an UpdateNodeMovementCommand: uint8 payload type, uint64 updatesCount, then
// updatesCount MovementUpdate records (matches ClientMessaging::sendNodeMovementUpdates on
// the C++ server and SessionClient::ReceiveNodeMovementUpdate on the client).
//
// Unlike the geometry payloads this is a COMMAND: it goes on the reliable channel with no
// leading size field, because the command stream is message-framed already.
//
// Returns the number of bytes written.
function encodeUpdateNodeMovement(updates,buffer)
{
	var byteOffset=0;
	const dataView = new DataView(buffer);
	byteOffset=core.put_uint8(dataView,byteOffset,command.CommandPayloadType.UpdateNodeMovement);
	byteOffset=core.put_uint64(dataView,byteOffset,updates.length);
	for(var i=0;i<updates.length;i++)
	{
		byteOffset=updates[i].encodeIntoDataView(dataView,byteOffset);
	}
	return byteOffset;
}

// Size in bytes of the command carrying this many updates.
function updateNodeMovementSize(count)
{
	return command.UpdateNodeMovementCommand.sizeof()+count*command.MOVEMENT_UPDATE_SIZE;
}

// Build the command as a Uint8Array ready to send.
function buildUpdateNodeMovement(updates)
{
	const buffer=new ArrayBuffer(updateNodeMovementSize(updates.length));
	const written=encodeUpdateNodeMovement(updates,buffer);
	if(written!=buffer.byteLength)
		throw new Error("encodeUpdateNodeMovement wrote "+written+" bytes, expected "+buffer.byteLength);
	return new Uint8Array(buffer);
}

module.exports= {encodeUpdateNodeMovement,updateNodeMovementSize,buildUpdateNodeMovement};
