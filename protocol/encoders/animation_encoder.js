'use strict';
const command= require('../command.js');

// Encode an ApplyAnimationCommand (matches ClientMessaging::updateNodeAnimation on the C++
// server and SessionClient::ReceiveNodeAnimationUpdate on the client).
//
// Like UpdateNodeMovement this is a COMMAND, so it goes on the reliable channel with no
// leading size field — the command stream is message-framed already. Unlike it, the size is
// fixed: the client checks for exactly 46 bytes and drops anything else without a word.
//
// Returns the number of bytes written.
function encodeApplyAnimation(applyAnimation,buffer)
{
	const dataView = new DataView(buffer);
	return applyAnimation.encodeIntoDataView(dataView,0);
}

// Build the command as a Uint8Array ready to send.
function buildApplyAnimation(applyAnimation)
{
	const buffer=new ArrayBuffer(command.APPLY_ANIMATION_COMMAND_SIZE);
	const written=encodeApplyAnimation(applyAnimation,buffer);
	if(written!=buffer.byteLength)
		throw new Error("encodeApplyAnimation wrote "+written+" bytes, expected "+buffer.byteLength);
	return new Uint8Array(buffer);
}

module.exports= {encodeApplyAnimation,buildApplyAnimation};
