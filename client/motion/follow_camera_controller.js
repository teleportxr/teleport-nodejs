'use strict';
const core= require('../../core/core.js');
const ax= require('./axes_basis.js');
const {NodeMotionController}= require('./node_motion_controller.js');
const {FlatGround}= require('./ground_provider.js');

//! Keeps a node on the ground at a fixed distance in front of a client's camera.
//!
//! This is the desktop self-avatar model: the user sees their own avatar ahead of them,
//! and the server is what moves it. The node is expected to be parented under the client's
//! origin node, which makes the whole computation stage-local — the head pose arrives in
//! stage space, the movement update is parent-local, and neither needs composing with the
//! origin's global transform. Peers see it correctly positioned for free, via the origin.
//!
//! Registered per client and opt-in; nothing constructs one unless the host application
//! asks for it:
//!
//!     const follower = new FollowCameraController({ nodeUid: avatarUid });
//!     client.AddMotionController(follower);
//!
//! Facing modes:
//!   'away'      the avatar faces the way the camera looks, so the user sees its back.
//!   'toward'    the avatar turns to face the user, so its front is visible.
//!   'velocity'  the avatar faces its own direction of travel while moving, and settles
//!               back to 'away' when it parks.
class FollowCameraController extends NodeMotionController
{
	constructor(opts={})
	{
		super();
		if(!opts.nodeUid&&!opts.nodeRole)
			throw new Error("FollowCameraController requires a nodeUid or a nodeRole");
		//! The node to drive. Either given up front, or resolved each tick from the
		//! client node registry by role — negotiated avatars do not exist yet when the
		//! client is created, and are replaced outright on re-import after a revoke.
		this.nodeUid=opts.nodeUid?BigInt(opts.nodeUid):null;
		this.nodeRole=opts.nodeRole||null;
		//! Metres in front of the camera.
		this.followDistance=opts.followDistance!==undefined?opts.followDistance:2.0;
		this.facing=opts.facing||'away';
		//! Target displacement below which the follower parks and stops emitting, in
		//! metres. Head micro-motion is well under this, so a still user sends nothing.
		this.deadZone=opts.deadZone!==undefined?opts.deadZone:0.15;
		//! Once moving, keep moving until this much closer, so the follower does not
		//! chatter in and out of the dead zone at its boundary.
		this.stopZone=opts.stopZone!==undefined?opts.stopZone:this.deadZone*0.3;
		//! Yaw error below which the follower does not turn, in degrees.
		this.yawDeadZone=opts.yawDeadZone!==undefined?opts.yawDeadZone:5.0;
		//! Exponential approach time constant, seconds. Larger lags further behind.
		this.tau=opts.tau!==undefined?opts.tau:0.25;
		//! Metres per second the follower will not exceed.
		this.maxSpeed=opts.maxSpeed!==undefined?opts.maxSpeed:4.0;
		//! Radians per second the follower will not exceed when turning.
		this.maxTurnRate=opts.maxTurnRate!==undefined?opts.maxTurnRate:Math.PI*2.0;
		this.ground=opts.ground||new FlatGround(0.0);
		//! Optional animation driver, fed this controller's ground speed. Phase 4.
		this.animator=opts.animator||null;

		//! Current follower state, in the server's axes standard, parent-local.
		this.position=null;			// null until the first head pose
		this.yaw=0.0;				// radians about the vertical axis, from basis forward
		this.moving=false;
		//! Smoothed horizontal ground speed, m/s.
		this.speed=0.0;

		//! Diagnostics. A follower that has never emitted anything reports why, every
		//! reportEveryUs, because every reason for it sitting silent (no head pose, no
		//! node, node not acknowledged) looks identical from the outside: no motion.
		//! Once it has emitted, it goes quiet unless debug is on.
		this.debug=opts.debug!==undefined?opts.debug
			:(process.env.TELEPORT_FOLLOWER_DEBUG==='1'||process.env.TELEPORT_FOLLOWER_DEBUG==='true');
		this.reportEveryUs=opts.reportEveryUs!==undefined?opts.reportEveryUs:5000000;
		this.lastReportUs=0;
		this.emitted=0;
	}

	//! Why is nothing happening? Returns a human-readable reason, or null if the
	//! follower is working. Ordered to match the sequence update() goes through.
	Diagnose(client)
	{
		if(!client.scene)
			return "client has no scene (Client.SetScene not called yet)";
		if(this.nodeRole&&!this.nodeUid)
		{
			const registry=client.clientManager?client.clientManager.clientNodes:null;
			if(!registry)
				return "no client node registry, so role '"+this.nodeRole+"' cannot be resolved";
			return "no node with role '"+this.nodeRole+"' for this client yet"
				+" (an avatar is only registered once the client accepts the avatar policy)";
		}
		if(!this.nodeUid)
			return "no node to drive";
		if(!client.scene.GetNode(this.nodeUid))
			return "node "+this.nodeUid+" is not in the scene";
		if(!client.currentHeadPose)
			return "no head pose received yet (client sends these at 10 Hz once it has an origin)";
		const gs=client.geometryService;
		if(gs&&typeof gs.WasNodeAcknowledged==='function'&&!gs.WasNodeAcknowledged(this.nodeUid))
			return "node "+this.nodeUid+" not yet acknowledged by the client, so movement is withheld";
		return null;
	}

	Report(client,nowUs)
	{
		if(this.emitted&&!this.debug)
			return;
		if(nowUs-this.lastReportUs<this.reportEveryUs)
			return;
		this.lastReportUs=nowUs;
		const reason=this.Diagnose(client);
		if(reason)
			console.log("FollowCameraController ["+client.clientID+"]: idle — "+reason);
		else if(this.debug)
			console.log("FollowCameraController ["+client.clientID+"]: node="+this.nodeUid
				+" pos="+JSON.stringify(this.position)+" speed="+this.speed.toFixed(2)
				+" moving="+this.moving+" emitted="+this.emitted);
	}

	//! Where the follower should ultimately be, given a head pose. Exposed separately
	//! from the smoothing so it can be tested directly.
	//! Returns {position, yaw} or null if the head pose is unusable.
	ComputeTarget(headPose,basis)
	{
		if(!headPose||!headPose.position)
			return null;
		const forward=ax.normalise(ax.Horizontal(ax.RotateVector(headPose.orientation,basis.forward),basis.up));
		// Looking straight up or down leaves no horizontal direction to work with; hold
		// the heading we already have rather than snapping to an arbitrary one.
		if(ax.length(forward)<1e-6)
			return null;
		const ahead=ax.add(headPose.position,ax.scale(forward,this.followDistance));
		const up=basis.up;
		// Drop the target onto the ground: keep its horizontal part, and replace its
		// vertical component with the ground height at that horizontal location.
		const horizontal=ax.Horizontal(ahead,up);
		const [gx,gz]=ax.HorizontalComponents(horizontal,up);
		const position=ax.add(horizontal,ax.scale(up,this.ground.groundHeightAt(gx,gz)));
		let facingDir=forward;
		if(this.facing==='toward')
			facingDir=ax.scale(forward,-1.0);
		const yaw=ax.SignedAngleAbout(basis.forward,facingDir,up);
		return {position, yaw};
	}

	//! The node this controller drives, or null if it does not exist yet.
	ResolveNodeUid(client)
	{
		if(this.nodeRole)
		{
			const registry=client.clientManager?client.clientManager.clientNodes:null;
			const uids=registry?registry.nodesForClientWithRole(client.clientID,this.nodeRole):[];
			const uid=uids.length?BigInt(uids[0]):null;
			// A different node than last tick means the avatar was re-imported; start
			// again from wherever the camera is now rather than gliding from the old one.
			if(uid!==this.nodeUid)
			{
				this.nodeUid=uid;
				this.position=null;
			}
		}
		return this.nodeUid;
	}

	update(dtSeconds,client,nowUs)
	{
		if(!client)
			return;
		if(!client.scene)
			return this.Report(client,nowUs);
		const uid=this.ResolveNodeUid(client);
		if(!uid)
			return this.Report(client,nowUs);
		const node=client.scene.GetNode(uid);
		if(!node)
			return this.Report(client,nowUs);
		const basis=ax.BasisFor(client.scene.serverAxesStandard);
		const target=this.ComputeTarget(client.currentHeadPose,basis);
		if(!target)
			return this.Report(client,nowUs);

		// First pose: snap, rather than gliding in from wherever the node happened to be.
		if(!this.position)
		{
			this.position=target.position;
			this.yaw=target.yaw;
			this.speed=0.0;
			this.moving=false;
			this.Apply(client,node,basis,true);
			this.Report(client,nowUs);
			return;
		}

		const toTarget=ax.sub(target.position,this.position);
		const distance=ax.length(toTarget);
		// Hysteresis: start moving past deadZone, stop only once well inside it.
		if(this.moving)
		{
			if(distance<this.stopZone)
				this.moving=false;
		}
		else if(distance>this.deadZone)
		{
			this.moving=true;
		}

		let yawError=ax.WrapAngle(target.yaw-this.yaw);
		const yawDeadZoneRad=this.yawDeadZone*Math.PI/180.0;
		const turning=Math.abs(yawError)>yawDeadZoneRad;

		if(!this.moving&&!turning)
		{
			// Parked: emit nothing at all. A still user costs no bandwidth.
			this.speed=0.0;
			if(this.animator)
				this.animator.Update(this.speed,nowUs,client);
			this.Report(client,nowUs);
			return;
		}

		// Exponential approach: fraction of the remaining error covered this tick.
		const alpha=1.0-Math.exp(-dtSeconds/Math.max(this.tau,1e-6));
		let moved=0.0;
		if(this.moving)
		{
			let step=ax.scale(toTarget,alpha);
			const stepLen=ax.length(step);
			const maxStep=this.maxSpeed*dtSeconds;
			if(stepLen>maxStep&&stepLen>1e-9)
				step=ax.scale(step,maxStep/stepLen);
			this.position=ax.add(this.position,step);
			moved=ax.length(step);
		}
		if(turning)
		{
			let dYaw=yawError*alpha;
			const maxTurn=this.maxTurnRate*dtSeconds;
			if(Math.abs(dYaw)>maxTurn)
				dYaw=Math.sign(dYaw)*maxTurn;
			this.yaw=ax.WrapAngle(this.yaw+dYaw);
		}

		// Ground speed, for the animation state machine. Horizontal only: a step up a
		// slope is not a faster walk.
		const horizontalMoved=ax.length(ax.Horizontal(
			ax.scale(ax.normalise(toTarget),moved),basis.up));
		this.speed=dtSeconds>0?horizontalMoved/dtSeconds:0.0;

		if(this.facing==='velocity'&&this.moving&&moved>1e-6)
		{
			const travelDir=ax.normalise(ax.Horizontal(toTarget,basis.up));
			if(ax.length(travelDir)>1e-6)
				this.yaw=ax.SignedAngleAbout(basis.forward,travelDir,basis.up);
		}

		this.Apply(client,node,basis,false);
		if(this.animator)
			this.animator.Update(this.speed,nowUs,client);
		this.Report(client,nowUs);
	}

	//! Write the follower's pose to the scene node and queue it for sending.
	//!
	//! The scene node is updated too, not just the wire message: a peer receiving this
	//! node for the first time, or the owner after a reconnect, gets the node payload —
	//! which carries node.pose — and must not see the follower back at its start point.
	//!
	//! The movement goes to every connected client, not only the one being followed. The
	//! pose is parent-local, and the parent is this client's origin node, so the same
	//! numbers are correct for a peer: the peer composes them with the origin's transform
	//! exactly as it does for any other child node.
	Apply(client,node,basis,snapped)
	{
		const orientation=ax.QuaternionAbout(basis.up,this.yaw);
		node.pose.position={x:this.position.x, y:this.position.y, z:this.position.z};
		node.pose.orientation=orientation;
		const pose={
			position:node.pose.position,
			orientation:orientation,
			scale:node.pose.scale,
		};
		const cm=client.clientManager;
		if(cm&&typeof cm.QueueNodeMovementForAll==='function')
			cm.QueueNodeMovementForAll(this.nodeUid,pose);
		else
			client.QueueNodeMovement(this.nodeUid,pose);
		this.emitted++;
	}
}

module.exports= {FollowCameraController};
