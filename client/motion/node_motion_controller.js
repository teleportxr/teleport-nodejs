'use strict';

//! Interface for server-side logic that moves a node on a client's behalf.
//!
//! Controllers are registered per client with Client.AddMotionController and run once per
//! motion tick by ClientManager.UpdateMotion. A controller does not send anything itself:
//! it calls client.QueueNodeMovement(uid, pose), and the client batches everything queued
//! in the tick into a single UpdateNodeMovementCommand.
//!
//! Poses are in the SERVER's axes standard, and local to the node's parent. For a node
//! parented under a client's origin node that means the client's stage space, which is
//! also the space its head pose arrives in — so a controller driving an avatar from the
//! head pose needs no coordinate composition at all.
class NodeMotionController
{
	//! dtSeconds: real time since the last tick. client: the Client being driven.
	//! nowUs: server-session time in microseconds, the same value stamped into the
	//! MovementUpdate, so a controller that needs a clock should use this rather than
	//! calling getTimestampUs() again.
	update(dtSeconds,client,nowUs)
	{
		throw new Error("NodeMotionController.update is abstract");
	}
}

module.exports= {NodeMotionController};
