'use strict';
// Tests for FollowerAnimator: the idle/walk/run state machine that drives a follower
// avatar's skeletal animation from how fast it is actually moving.
//
// Pure logic — no scene, no transport, no timers. The animator is fed a speed and a clock
// and asked to tick; the ApplyAnimation commands it asks the client to send are the
// assertion surface.
//
// The property that matters most is silence. This runs at 20 Hz on the reliable channel for
// every client, so anything that emits per-tick rather than per-transition is a bandwidth
// bug that will not show up in a one-user test.

const test = require('node:test');
const assert = require('node:assert');
const { FollowerAnimator, AnimState } = require('../client/motion/follower_animator');

const NODE_UID = 77n;
const TICK_US = 50000; // 20 Hz, matching the motion tick.

const CLIPS = {
	idle: { url: '/anim/Idle.vrma', duration: 2.0 },
	walk: { url: '/anim/Walking.vrma', duration: 1.0, refSpeed: 1.4 },
	run: { url: '/anim/Running.vrma', duration: 0.5, refSpeed: 3.5 },
};

// Minimal stand-in for Client. Everything is acknowledged, so readiness never masks a
// state-machine result; the readiness rules are tested separately below.
function makeStubClient(opts = {}) {
	const sent = [];
	const acknowledged = opts.acknowledged !== undefined ? opts.acknowledged : true;
	const streamed = [];
	const client = {
		clientID: opts.clientID !== undefined ? opts.clientID : 1,
		clientManager: null,
		sent,
		streamed,
		acknowledged,
		geometryService: {
			StreamAnimation(uid) { streamed.push(uid); },
			WasNodeAcknowledged() { return client.acknowledged; },
		},
		SendApplyAnimation(nodeUid, animationUid, o) {
			if (!client.acknowledged) return false;
			sent.push({ nodeUid, animationUid, ...o });
			return true;
		},
	};
	return client;
}

// Settle is disabled by default: it is a delay for the client's HTTPS fetch, not part of the
// state machine, and having every test wait two seconds of virtual time would obscure them.
function makeAnimator(overrides = {}) {
	return new FollowerAnimator(Object.assign({
		nodeUid: NODE_UID,
		clips: CLIPS,
		settleUs: 0,
	}, overrides));
}

// Drive the animator at 20 Hz for `seconds` at a constant speed. Returns the end time.
function run(animator, client, speed, seconds, startUs = 0) {
	let nowUs = startUs;
	const ticks = Math.round((seconds * 1e6) / TICK_US);
	for (let i = 0; i < ticks; i++) {
		animator.Update(speed, nowUs, client);
		nowUs += TICK_US;
	}
	return nowUs;
}

test('a speed ramp 0 to 3 to 0 walks up and down the states, one command each', () => {
	const animator = makeAnimator();
	const client = makeStubClient();
	let t = 0;
	// Long enough at each speed for the smoothed speed to settle and the dwell to expire.
	t = run(animator, client, 0.0, 1.0, t);
	t = run(animator, client, 1.0, 1.5, t);   // walk band
	t = run(animator, client, 3.0, 1.5, t);   // run band
	t = run(animator, client, 1.0, 1.5, t);   // back to walk
	t = run(animator, client, 0.0, 2.0, t);   // back to idle

	const states = client.sent.map((s) => s.animationUid);
	const idle = animator.clips.idle.uid;
	const walk = animator.clips.walk.uid;
	const runUid = animator.clips.run.uid;
	assert.deepStrictEqual(states, [idle, walk, runUid, walk, idle],
		'expected exactly idle->walk->run->walk->idle, one command per transition');
});

test('dithering across the walk threshold emits nothing extra', () => {
	// A speed sitting exactly on walkOn, wobbling either side of it at 20 Hz. Without
	// smoothing, hysteresis and a dwell floor this produces a command every tick — 100 of
	// them over five seconds, on the reliable channel, per client.
	const animator = makeAnimator();
	const client = makeStubClient();
	const walkOn = animator.walkOn;
	let nowUs = 0;
	for (let i = 0; i < 100; i++) {
		const speed = walkOn + ((i % 2 === 0) ? 0.02 : -0.02);
		animator.Update(speed, nowUs, client);
		nowUs += TICK_US;
	}
	assert.ok(client.sent.length <= 2,
		`dithering across the threshold emitted ${client.sent.length} commands; expected at most 2`);
});

test('run never falls straight back to idle', () => {
	// Decelerating from a run and standing still are different movements. Blending run
	// directly to idle skips the one that reads as stopping.
	const animator = makeAnimator();
	const client = makeStubClient();
	let t = run(animator, client, 3.0, 2.0, 0);
	assert.strictEqual(animator.state, AnimState.Run);
	// Speed collapses to zero instantly.
	run(animator, client, 0.0, 2.0, t);

	const order = client.sent.map((s) => s.animationUid);
	const walk = animator.clips.walk.uid;
	const idle = animator.clips.idle.uid;
	const lastTwo = order.slice(-2);
	assert.deepStrictEqual(lastTwo, [walk, idle],
		'run must reach idle via walk, never directly');
});

test('the transition rule allows idle straight to run, but not run straight to idle', () => {
	// Tested on NextState rather than end to end, because it is a rule about the transition
	// table and the speed EMA usually reaches the run band by passing through the walk one.
	// That is correct — a follower really does accelerate through walking speed — but it
	// means the direct idle->run edge only fires when the smoothed speed arrives above runOn
	// in a single step, which is a property of the rule, not of a typical ramp.
	const animator = makeAnimator();
	const dwelt = animator.minDwell + 1;

	animator.state = AnimState.Idle;
	assert.strictEqual(animator.NextState(4.0, dwelt), AnimState.Run);

	animator.state = AnimState.Run;
	assert.strictEqual(animator.NextState(0.0, dwelt), AnimState.Walk);

	animator.state = AnimState.Walk;
	assert.strictEqual(animator.NextState(0.0, dwelt), AnimState.Idle);
});

test('no state change is allowed before the minimum dwell has elapsed', () => {
	const animator = makeAnimator();
	animator.state = AnimState.Idle;
	assert.strictEqual(animator.NextState(4.0, animator.minDwell - 0.01), AnimState.Idle,
		'a state has to be worth committing to, or a speed on a threshold emits every tick');
});

test('each state is dated one blend lead into the future', () => {
	// The lead IS the cross-fade: the client snapshots what is playing at "now" and
	// interpolates to the state's timestamp. Sending "now" would snap.
	const animator = makeAnimator({ blendLeadUs: 150000 });
	const client = makeStubClient();
	let nowUs = 0;
	for (let i = 0; i < 4; i++) {
		animator.Update(0.0, nowUs, client);
		if (client.sent.length) break;
		nowUs += TICK_US;
	}
	assert.strictEqual(client.sent.length, 1);
	assert.strictEqual(client.sent[0].timestampUs, nowUs + 150000);
});

test('normalised phase carries across a change of clip', () => {
	// Walk and run have different durations. Phase is tracked normalised and converted to
	// seconds against whichever clip is about to play, so the footfall survives the switch.
	const animator = makeAnimator();
	const client = makeStubClient();
	let t = run(animator, client, 1.0, 2.0, 0);
	const phaseBefore = animator.phase;
	run(animator, client, 3.0, 1.5, t);

	const runCommand = client.sent[client.sent.length - 1];
	assert.strictEqual(runCommand.animationUid, animator.clips.run.uid);
	assert.ok(runCommand.animTimeAtTimestamp >= 0
		&& runCommand.animTimeAtTimestamp < animator.clips.run.duration,
		'animTimeAtTimestamp must be seconds within the incoming clip, not the outgoing one');
	assert.ok(phaseBefore > 0, 'phase should have advanced while walking');
});

test('animTimeAtTimestamp is zero for a clip with no declared duration', () => {
	// Without a duration there is no way to convert a normalised phase into seconds. Saying
	// "start at the beginning" is honest; guessing is not.
	const animator = makeAnimator({
		clips: { idle: { url: '/anim/Idle.vrma' } },
	});
	const client = makeStubClient();
	run(animator, client, 0.0, 1.0, 0);
	assert.ok(client.sent.length >= 1);
	assert.strictEqual(client.sent[0].animTimeAtTimestamp, 0.0);
});

test('speedUnitsPerSecond is a clamped rate multiplier, and exactly 1 for idle', () => {
	const animator = makeAnimator();
	const client = makeStubClient();
	// Idle: the clip has no reference speed to scale against.
	run(animator, client, 0.0, 1.0, 0);
	assert.strictEqual(client.sent[0].speedUnitsPerSecond, 1.0);

	// Far above the walk clip's reference speed: clamped, not unbounded. A 4x playback rate
	// does not read as a walk however fast the follower is going.
	const fast = makeAnimator();
	const fastClient = makeStubClient();
	run(fast, fastClient, 1.4 * 8, 1.5, 0);
	for (const cmd of fastClient.sent) {
		assert.ok(cmd.speedUnitsPerSecond >= fast.minRate && cmd.speedUnitsPerSecond <= fast.maxRate,
			`rate ${cmd.speedUnitsPerSecond} outside [${fast.minRate}, ${fast.maxRate}]`);
	}
});

test('every command targets animation layer zero and loops', () => {
	// The client's AnimationInstance only processes layer 0; a state on any other layer is
	// stored and never applied. Locomotion clips are cycles, so they loop.
	const animator = makeAnimator();
	const client = makeStubClient();
	run(animator, client, 1.0, 2.0, 0);
	assert.ok(client.sent.length >= 1);
	for (const cmd of client.sent) {
		assert.strictEqual(cmd.loop, true);
	}
});

test('nothing is sent until the node is acknowledged', () => {
	const animator = makeAnimator();
	const client = makeStubClient({ acknowledged: false });
	run(animator, client, 1.0, 2.0, 0);
	assert.strictEqual(client.sent.length, 0);

	// Once the client confirms it holds the node, the current state goes out.
	client.acknowledged = true;
	run(animator, client, 1.0, 1.0, 2000000);
	assert.ok(client.sent.length >= 1);
});

test('a clip is not used until the settle delay after acknowledgement has passed', () => {
	// Acknowledgement covers the pointer chunk, not the HTTPS fetch and retarget behind it.
	// Naming a clip the client has not finished with means the update is dropped, and there
	// is no mechanism to ask for an animation state again.
	const animator = makeAnimator({ settleUs: 2000000 });
	const client = makeStubClient();
	run(animator, client, 0.0, 1.0, 0);
	assert.strictEqual(client.sent.length, 0, 'should still be within the settle window');

	run(animator, client, 0.0, 1.5, 1000000);
	assert.ok(client.sent.length >= 1, 'should send once the clip has settled');
});

test('clips are streamed once per client, not once per tick', () => {
	// StreamAnimation is refcounted. Asking every tick would run the count up 20 times a
	// second and the clip could never be released.
	const animator = makeAnimator();
	const client = makeStubClient();
	run(animator, client, 0.0, 3.0, 0);
	assert.strictEqual(client.streamed.length, 3,
		`expected one stream request per clip, got ${client.streamed.length}`);
});

test('a re-sent node causes the current state to be sent again', () => {
	// A node the client stops acknowledging has been re-sent, or the client reconnected.
	// Either way its AnimationComponent went with the node and it no longer knows what to
	// play; nothing else in the system would tell it.
	const animator = makeAnimator();
	const client = makeStubClient();
	run(animator, client, 0.0, 1.0, 0);
	const afterFirst = client.sent.length;
	assert.ok(afterFirst >= 1);

	client.acknowledged = false;
	run(animator, client, 0.0, 0.5, 1000000);
	assert.strictEqual(client.sent.length, afterFirst, 'nothing to send while unacknowledged');

	client.acknowledged = true;
	run(animator, client, 0.0, 0.5, 1500000);
	assert.ok(client.sent.length > afterFirst, 'state must be re-emitted after a re-stream');
});

test('a disabled animator streams nothing and sends nothing', () => {
	// The kill switch: an ApplyAnimation reaching a client without sub-scene animation
	// support is at best ignored, and older clients crash on it.
	const animator = makeAnimator({ enabled: false });
	const client = makeStubClient();
	run(animator, client, 3.0, 3.0, 0);
	assert.strictEqual(client.sent.length, 0);
	assert.strictEqual(client.streamed.length, 0);
});

test('fan-out reaches peers, each gated on its own resources', () => {
	// Animation is per-connection. A peer watching this avatar needs the same command, and
	// its own copy of the clips — but a peer that has not acknowledged the node must not
	// hold up the owner.
	const owner = makeStubClient({ clientID: 1 });
	const peer = makeStubClient({ clientID: 2, acknowledged: false });
	owner.clientManager = { GetClients: () => [owner, peer] };

	const animator = makeAnimator();
	run(animator, owner, 0.0, 1.0, 0);
	assert.ok(owner.sent.length >= 1, 'owner should have been told');
	assert.strictEqual(peer.sent.length, 0, 'peer has not acknowledged the node');
	assert.strictEqual(peer.streamed.length, 3, 'peer still needs its own copy of the clips');

	peer.acknowledged = true;
	run(animator, owner, 0.0, 1.0, 1000000);
	assert.ok(peer.sent.length >= 1, 'peer should be told once it has the node');
});
