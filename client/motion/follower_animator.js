'use strict';
const resources= require('../../scene/resources.js');

//! Locomotion states, in increasing order of speed.
const AnimState = { Idle:'idle', Walk:'walk', Run:'run' };

//! Drives a node's skeletal animation from how fast it is actually moving.
//!
//! Plugged into a FollowCameraController via its `animator` option, it is fed that
//! controller's own smoothed ground speed once per motion tick and emits an ApplyAnimation
//! only when the state changes. A follower standing still costs nothing; one walking steadily
//! costs one command at the moment it started walking.
//!
//! Three things make that "only on change" claim hold up in practice:
//!
//!   * **Smoothing.** Per-tick position differences at 20 Hz are far too noisy to threshold
//!     directly; an exponential moving average turns them into something with a stable sign.
//!   * **Hysteresis and dwell.** Separate on/off thresholds plus a minimum time in state stop
//!     a speed hovering at a boundary from producing a command every tick.
//!   * **Blend lead.** Each state is dated slightly in the future. The client snapshots what
//!     is playing at "now" and interpolates to the new state over the intervening time, so
//!     the lead *is* the cross-fade duration. Sending "now" gives a hard snap.
//!
//! Clips are supplied by the host application, since only it knows what it has published:
//!
//!     new FollowerAnimator({
//!         nodeUid,
//!         clips: {
//!             idle: { url:'/avatar_anim/Idle.vrma',    duration:2.0 },
//!             walk: { url:'/avatar_anim/Walking.vrma', duration:1.0, refSpeed:1.4 },
//!             run:  { url:'/avatar_anim/Running.vrma', duration:0.7, refSpeed:3.5 },
//!         },
//!     });
//!
//! `duration` (seconds) is optional and enables phase continuity across a change of clip —
//! without it the new clip starts from its beginning, which is visible as a hitch in the
//! footfall. `refSpeed` is the ground speed the clip was authored for; the playback rate is
//! scaled by how far the real speed differs from it, which is what stops the feet sliding.
class FollowerAnimator
{
	constructor(opts={})
	{
		if(!opts.clips)
			throw new Error("FollowerAnimator requires a clips map");
		this.nodeUid=opts.nodeUid?BigInt(opts.nodeUid):null;
		this.nodeRole=opts.nodeRole||null;

		//! {state -> {url, duration, refSpeed, uid}}. uid is filled in on first use.
		this.clips={};
		for(const state of [AnimState.Idle,AnimState.Walk,AnimState.Run])
		{
			const c=opts.clips[state];
			if(!c)
				continue;
			const spec=(typeof c==='string')?{url:c}:c;
			if(!spec.url)
				continue;
			this.clips[state]={
				url:spec.url,
				duration:spec.duration!==undefined?spec.duration:0,
				refSpeed:spec.refSpeed!==undefined?spec.refSpeed:(state===AnimState.Run?3.5:1.4),
				// The frame the clip is authored in. Omit for a clip in the server's own
				// frame; a .vrma is glTF, so 'gl'. It must agree with the avatar the clip is
				// retargeted onto, which arrives as a MeshPointer with its own declaration.
				axesStandard:spec.axesStandard!==undefined?spec.axesStandard:spec.axes_standard,
				uid:null,
			};
		}
		if(!this.clips[AnimState.Idle])
			throw new Error("FollowerAnimator requires at least an 'idle' clip");

		//! Speed smoothing time constant, seconds.
		this.speedTau=opts.speedTau!==undefined?opts.speedTau:0.2;
		//! Speed thresholds, metres per second. Separate on/off values give hysteresis.
		this.walkOn =opts.walkOn !==undefined?opts.walkOn :0.35;
		this.walkOff=opts.walkOff!==undefined?opts.walkOff:0.20;
		this.runOn  =opts.runOn  !==undefined?opts.runOn  :2.2;
		this.runOff =opts.runOff !==undefined?opts.runOff :1.8;
		//! Minimum time in a state before it may be left, seconds.
		this.minDwell=opts.minDwell!==undefined?opts.minDwell:0.25;
		//! How far ahead each state is dated, microseconds. This is the cross-fade duration.
		this.blendLeadUs=opts.blendLeadUs!==undefined?opts.blendLeadUs:150000;
		//! Playback-rate multiplier bounds. Outside roughly this range a clip stops reading
		//! as the same gait.
		this.minRate=opts.minRate!==undefined?opts.minRate:0.6;
		this.maxRate=opts.maxRate!==undefined?opts.maxRate:1.6;
		//! Grace period after a clip is acknowledged before it is used, microseconds. The
		//! acknowledgement says the pointer chunk arrived, not that the client has finished
		//! fetching and retargeting the clip behind it.
		this.settleUs=opts.settleUs!==undefined?opts.settleUs:2000000;

		//! Enabled by the host application. Off means the animator streams nothing and sends
		//! nothing: an ApplyAnimation reaching a client built before the sub-scene animation
		//! support is at best ignored.
		this.enabled=opts.enabled!==undefined?!!opts.enabled:true;

		this.state=AnimState.Idle;
		this.smoothedSpeed=0.0;
		//! Normalised position in the current clip, [0,1). Tracked normalised rather than in
		//! seconds so that it survives a change to a clip of a different length.
		this.phase=0.0;
		this.rate=1.0;
		this.lastUpdateUs=null;
		this.stateEnteredUs=null;
		//! When each clip was first seen acknowledged, so settleUs can be measured.
		this.clipReadyUs=new Map();
		//! Clients this animator has successfully told about the current state. Cleared on
		//! every state change; a client absent from it is retried each tick, which is also
		//! what re-emits the state after a reconnect or a re-stream.
		this.informed=new Set();
		//! Clients already asked to stream the clips. StreamAnimation is refcounted, so each
		//! client must be asked exactly once.
		this.streamedFor=new Set();
		this.emitted=0;
	}

	//! Resolve the clip urls to resource uids, and ask each client for the clips once.
	//!
	//! Once per client, not once per tick: StreamAnimation is refcounted, so calling it
	//! repeatedly for the same reason would run the count up without bound and the clip
	//! could never be released. `streamedFor` records which clients have been asked.
	//!
	//! Every client that will be sent an ApplyAnimation needs the clips, not just the one
	//! being followed — a peer watching this avatar has to have the clip in its own cache
	//! before it can play it.
	EnsureClipsStreamed(clients)
	{
		for(const state of Object.keys(this.clips))
		{
			const clip=this.clips[state];
			if(clip.uid===null)
				clip.uid=BigInt(resources.GetOrAddAnimationPointer(clip.url,clip.axesStandard));
		}
		for(const c of clients)
		{
			if(!c||!c.geometryService||this.streamedFor.has(c.clientID))
				continue;
			this.streamedFor.add(c.clientID);
			for(const state of Object.keys(this.clips))
				c.geometryService.StreamAnimation(this.clips[state].uid);
		}
	}

	//! The node this animator drives, or null. Mirrors FollowCameraController.ResolveNodeUid:
	//! a negotiated avatar does not exist when the client is created, and is replaced outright
	//! when re-imported.
	ResolveNodeUid(client)
	{
		if(this.nodeRole)
		{
			const registry=client.clientManager?client.clientManager.clientNodes:null;
			const uids=registry?registry.nodesForClientWithRole(client.clientID,this.nodeRole):[];
			const uid=uids.length?BigInt(uids[0]):null;
			if(uid!==this.nodeUid)
			{
				this.nodeUid=uid;
				// A different node has no animation state, so tell everyone again.
				this.informed.clear();
			}
		}
		return this.nodeUid;
	}

	//! Which state does this speed call for, given where we are now? Pure, and the whole of
	//! the hysteresis rule, so it can be tested without a client.
	NextState(speed,dwellSeconds)
	{
		// Too soon to change: a state has to be worth committing to, or a speed sitting on a
		// threshold produces a command every tick.
		if(dwellSeconds<this.minDwell)
			return this.state;
		switch(this.state)
		{
			case AnimState.Idle:
				// Idle straight to run is allowed, though the speed EMA means a normal ramp
				// still passes briefly through walk on the way — which is right, since a
				// follower does accelerate through walking speed. This edge is for the case
				// where the smoothed speed arrives in the run band in one step.
				if(speed>=this.runOn)
					return AnimState.Run;
				if(speed>=this.walkOn)
					return AnimState.Walk;
				return AnimState.Idle;
			case AnimState.Walk:
				if(speed>=this.runOn)
					return AnimState.Run;
				if(speed<this.walkOff)
					return AnimState.Idle;
				return AnimState.Walk;
			case AnimState.Run:
				// Run to idle only through walk, however abruptly the speed drops:
				// decelerating from a run and standing still are different movements, and
				// blending run straight to idle skips the one that reads as stopping.
				if(speed<this.runOff)
					return AnimState.Walk;
				return AnimState.Run;
		}
		return AnimState.Idle;
	}

	//! Playback-rate multiplier for a state at a given speed. Not metres per second: it
	//! scales the authored rate, which is how one clip covers a band of speeds without the
	//! feet sliding.
	RateFor(state,speed)
	{
		if(state===AnimState.Idle)
			return 1.0;
		const clip=this.clips[state];
		if(!clip||!clip.refSpeed)
			return 1.0;
		const r=speed/clip.refSpeed;
		return Math.min(this.maxRate,Math.max(this.minRate,r));
	}

	//! Is this clip usable for this client yet? The clip must be acknowledged, and settled:
	//! the acknowledgement covers the pointer chunk, not the HTTPS fetch and retarget behind
	//! it, and naming a clip the client has not finished with means the update is dropped
	//! with nothing to retry it.
	ClipReady(client,clip,nowUs)
	{
		if(!clip||clip.uid===null)
			return false;
		if(!client.geometryService.WasNodeAcknowledged(clip.uid))
			return false;
		const key=String(clip.uid);
		if(!this.clipReadyUs.has(key))
		{
			this.clipReadyUs.set(key,nowUs);
			return false;
		}
		return (nowUs-this.clipReadyUs.get(key))>=this.settleUs;
	}

	//! Fed once per motion tick by the controller that owns this animator.
	//! speed is that controller's smoothed horizontal ground speed, in metres per second.
	Update(speed,nowUs,client)
	{
		if(!this.enabled||!client)
			return;
		const dt=(this.lastUpdateUs===null)?0:(nowUs-this.lastUpdateUs)/1000000.0;
		this.lastUpdateUs=nowUs;
		if(this.stateEnteredUs===null)
			this.stateEnteredUs=nowUs;

		// Exponential moving average. Raw per-tick speed is far too noisy to threshold.
		if(dt>0)
		{
			const alpha=1.0-Math.exp(-dt/Math.max(this.speedTau,1e-6));
			this.smoothedSpeed+=(speed-this.smoothedSpeed)*alpha;
		}

		// Animation is per-connection, like movement: a peer watching this avatar needs the
		// same command, and its own copy of the clips.
		const cm=client.clientManager;
		const clients=(cm&&typeof cm.GetClients==='function')?cm.GetClients():[client];
		this.EnsureClipsStreamed(clients);

		const uid=this.ResolveNodeUid(client);
		if(!uid)
			return;

		// Advance the phase by however much of the clip played since the last tick, so that a
		// change of clip can pick up where the last one left off.
		const current=this.clips[this.state];
		if(dt>0&&current&&current.duration>0)
			this.phase=(this.phase+dt*this.rate/current.duration)%1.0;

		const dwell=(nowUs-this.stateEnteredUs)/1000000.0;
		let next=this.NextState(this.smoothedSpeed,dwell);
		// Fall back to a state we actually have a clip for rather than emitting nothing.
		if(!this.clips[next])
			next=AnimState.Idle;

		if(next!==this.state)
		{
			this.state=next;
			this.stateEnteredUs=nowUs;
			this.informed.clear();
		}
		this.rate=this.RateFor(this.state,this.smoothedSpeed);

		this.Emit(clients,nowUs);
	}

	//! Send the current state to every client that can see this node and has not been told.
	//!
	//! Each client is tracked separately in `informed`, so one whose clip has not arrived yet
	//! is retried on later ticks without re-sending to the others. That per-client retry is
	//! also what re-emits the state to a client that reconnected or was re-sent the node: its
	//! AnimationComponent died with the node, and nothing else would tell it what to play.
	Emit(clients,nowUs)
	{
		for(const c of clients)
		{
			if(!c||!c.geometryService)
				continue;
			const nodeAcknowledged=c.geometryService.WasNodeAcknowledged(this.nodeUid);
			// A node that stops being acknowledged has been re-sent, or the client has
			// reconnected. Either way its AnimationComponent went with it and it no longer
			// knows what to play, so forget having told it and start again once it is back.
			if(!nodeAcknowledged)
			{
				this.informed.delete(c.clientID);
				continue;
			}
			if(this.informed.has(c.clientID))
				continue;
			const clip=this.clips[this.state];
			if(!this.ClipReady(c,clip,nowUs))
				continue;
			// Phase continuity: the stored phase is normalised, and the command wants seconds
			// into the clip about to play. Without a duration for it we can only start at the
			// beginning.
			const animTime=clip.duration>0?this.phase*clip.duration:0.0;
			const ok=c.SendApplyAnimation(this.nodeUid,clip.uid,{
				// Dated ahead: this interval is the cross-fade.
				timestampUs:nowUs+this.blendLeadUs,
				animTimeAtTimestamp:animTime,
				speedUnitsPerSecond:this.rate,
				loop:true,
			});
			if(ok)
			{
				this.informed.add(c.clientID);
				this.emitted++;
			}
		}
	}
}

module.exports= {FollowerAnimator,AnimState};
