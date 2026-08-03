'use strict';

//! Server-side motion: logic that moves nodes on a client's behalf, run once per motion
//! tick by ClientManager. See node_motion_controller.js for the interface.
//!
//! Nothing here runs unless the host application registers a controller with
//! Client.AddMotionController.

const {NodeMotionController}= require('./node_motion_controller.js');
const {FlatGround,CallbackGround}= require('./ground_provider.js');
const {FollowCameraController}= require('./follow_camera_controller.js');
const axes_basis= require('./axes_basis.js');

module.exports= {NodeMotionController,FlatGround,CallbackGround,FollowCameraController,axes_basis};
