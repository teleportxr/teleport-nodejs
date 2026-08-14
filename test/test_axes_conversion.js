'use strict';
// Axes-standard conversion invariants (core.js ConvertPosition/ConvertRotation/ConvertScale).
//
// These are deliberately property tests rather than tables of expected numbers. The tables
// themselves are what is under test — a hand-written table can be transcribed wrongly and still
// look plausible, and the C++ original this was ported from has exactly that defect: its
// Engineering <-> Gl entries were simply absent, so the conversion silently passed values
// through, and every round-trip test still went green because a no-op round-trips perfectly.
//
// So the load-bearing test here is `basis vectors map to basis vectors`: it pins each
// conversion against an independent statement of what the four standards mean
// (client/motion/axes_basis.js), and a missing or mistyped entry fails it immediately.

const test = require('node:test');
const assert = require('node:assert');

const core = require('../core/core.js');
const ax = require('../client/motion/axes_basis.js');

const A = core.AxesStandard;

const NAMES = {
	[A.EngineeringStyle]: 'EngineeringStyle',
	[A.GlStyle]: 'GlStyle',
	[A.UnrealStyle]: 'UnrealStyle',
	[A.UnityStyle]: 'UnityStyle',
};

// Unreal <-> Unity is the one pair with no entry in any implementation of this table — the
// C++ original has none either, so the port faithfully has none. Both directions warn and pass
// the value through. Listed here so the tests below can assert that explicitly rather than
// quietly skipping it: if someone adds the pair, `unsupported pairs warn` fails and this
// exclusion has to be removed deliberately.
const UNSUPPORTED = [
	[A.UnrealStyle, A.UnityStyle],
	[A.UnityStyle, A.UnrealStyle],
];

function isUnsupported(from, to) {
	return UNSUPPORTED.some(([f, t]) => f === from && t === to);
}

//! Every ordered pair of distinct standards, minus the ones nothing implements.
function supportedPairs() {
	const pairs = [];
	for (const from of core.COMPLETE_AXES_STANDARDS)
		for (const to of core.COMPLETE_AXES_STANDARDS)
			if (from !== to && !isUnsupported(from, to))
				pairs.push([from, to]);
	return pairs;
}

function label(from, to) {
	return NAMES[from] + ' -> ' + NAMES[to];
}

const EPSILON = 1e-9;

function close(a, b, keys) {
	return keys.every((k) => Math.abs(a[k] - b[k]) < EPSILON);
}

function assertVecEqual(got, want, message) {
	assert.ok(close(got, want, ['x', 'y', 'z']),
		message + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
}

//! Run fn with console.warn silenced, returning the messages it produced. The unsupported-pair
//! cases warn by design and would otherwise bury the test output.
function captureWarnings(fn) {
	const warnings = [];
	const original = console.warn;
	console.warn = (...args) => { warnings.push(args.join(' ')); };
	try { fn(); } finally { console.warn = original; }
	return warnings;
}

test('the four complete standards have the documented wire values', () => {
	// These bytes are the wire format (docs/protocol/conventions.rst) and are mirrored in the
	// C++ avs::AxesStandard, the TypeScript client and the Unity C# SDK. Changing one without
	// the others is the defect this pins: the C# enum was wrong for GlStyle and UnrealStyle.
	assert.strictEqual(A.EngineeringStyle, 9);
	assert.strictEqual(A.GlStyle, 21);
	assert.strictEqual(A.UnrealStyle, 42);
	assert.strictEqual(A.UnityStyle, 70);

	assert.deepStrictEqual(core.COMPLETE_AXES_STANDARDS,
		[A.EngineeringStyle, A.GlStyle, A.UnrealStyle, A.UnityStyle]);
	assert.ok(core.IsCompleteAxesStandard(A.GlStyle));
	// A component bit on its own is not a standard, and neither is an unknown byte.
	assert.ok(!core.IsCompleteAxesStandard(A.NotInitialized));
	assert.ok(!core.IsCompleteAxesStandard(A.YVertical));
	assert.ok(!core.IsCompleteAxesStandard(17));	// what the Unity C# enum used to call GlStyle
});

test('basis vectors map to basis vectors', () => {
	// The real test. Each standard is defined by which way is up and which way a node with
	// identity orientation faces; a conversion between two of them must carry one definition
	// onto the other. Nothing here is derived from the conversion tables, so a wrong or missing
	// entry cannot satisfy it by construction.
	captureWarnings(() => {
		for (const [from, to] of supportedPairs()) {
			const source = ax.BasisFor(from);
			const target = ax.BasisFor(to);
			assertVecEqual(core.ConvertPosition(from, to, source.up), target.up,
				label(from, to) + ' must carry up onto up');
			assertVecEqual(core.ConvertPosition(from, to, source.forward), target.forward,
				label(from, to) + ' must carry forward onto forward');
		}
	});
});

test('conversion between differing standards is never the identity', () => {
	// The failure mode the C++ has: an absent table entry leaves the value untouched, which
	// round-trips perfectly and looks like success. A generic vector with three distinct
	// non-zero components cannot survive any real change of basis unchanged.
	const v = { x: 1, y: 2, z: 3 };
	captureWarnings(() => {
		for (const [from, to] of supportedPairs()) {
			assert.ok(!close(core.ConvertPosition(from, to, v), v, ['x', 'y', 'z']),
				label(from, to) + ' left the position unchanged, so the table entry is missing');
		}
	});
});

test('every supported conversion round-trips', () => {
	const p = { x: 1, y: 2, z: 3 };
	const q = { x: 0.1, y: 0.2, z: 0.3, w: 0.9 };
	const s = { x: 1, y: 2, z: 4 };
	captureWarnings(() => {
		for (const [from, to] of supportedPairs()) {
			const rp = core.ConvertPosition(to, from, core.ConvertPosition(from, to, p));
			const rq = core.ConvertRotation(to, from, core.ConvertRotation(from, to, q));
			const rs = core.ConvertScale(to, from, core.ConvertScale(from, to, s));
			assert.ok(close(rp, p, ['x', 'y', 'z']), label(from, to) + ' position does not round-trip');
			assert.ok(close(rq, q, ['x', 'y', 'z', 'w']), label(from, to) + ' rotation does not round-trip');
			assert.ok(close(rs, s, ['x', 'y', 'z']), label(from, to) + ' scale does not round-trip');
		}
	});
});

test('a rotation about an axis becomes a rotation about the converted axis', () => {
	// Ties ConvertRotation to ConvertPosition: whatever permutation the table applies to a
	// direction, it must apply the same one to the axis a rotation turns about. A change of
	// basis between two standards of the same handedness is a rotation, so the angle survives
	// it; between differing handedness it is a mirror, so the angle reverses.
	//
	// The axis is deliberately general rather than one of the basis vectors. A basis vector
	// has two zero components, so it cannot see a sign error in either of them — testing
	// about "up" alone misses the C++ Platform bug (Engineering's up is (0,0,1), and the
	// error is on x). With all three components non-zero and distinct, every entry is live.
	const axis = ax.normalise({ x: 0.3, y: -0.5, z: 0.8 });
	const theta = 0.7;
	captureWarnings(() => {
		for (const [from, to] of supportedPairs()) {
			const sameHandedness = (from & A.LeftHanded) === (to & A.LeftHanded);
			const got = core.ConvertRotation(from, to, ax.QuaternionAbout(axis, theta));
			const want = ax.QuaternionAbout(core.ConvertPosition(from, to, axis),
				sameHandedness ? theta : -theta);
			assert.ok(close(got, want, ['x', 'y', 'z', 'w']),
				label(from, to) + ' (' + (sameHandedness ? 'same' : 'differing') + ' handedness)'
				+ ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want));
		}
	});
});

test('scale is the unsigned form of the position permutation', () => {
	// Scale permutes exactly as position does but never changes sign — a negative scale would
	// flip the mesh. Deriving one from the other keeps the two tables honest with each other.
	const s = { x: 2, y: 3, z: 5 };
	captureWarnings(() => {
		for (const [from, to] of supportedPairs()) {
			const converted = core.ConvertPosition(from, to, s);
			const want = { x: Math.abs(converted.x), y: Math.abs(converted.y), z: Math.abs(converted.z) };
			assertVecEqual(core.ConvertScale(from, to, s), want,
				label(from, to) + ' scale must be the unsigned position permutation');
		}
	});
});

test('converting to the same standard is a no-op that copies', () => {
	const p = { x: 1, y: 2, z: 3 };
	for (const standard of core.COMPLETE_AXES_STANDARDS) {
		const got = core.ConvertPosition(standard, standard, p);
		assert.deepStrictEqual(got, p);
		// A copy, not the same object: callers store the result on a node and must not alias
		// the caller's pose.
		assert.notStrictEqual(got, p);
	}
});

test('Engineering <-> Gl uses the documented mapping', () => {
	// Spelled out rather than derived, because this is the pair the protocol requires every
	// server to support ("A server must be capable of supporting clients in at least
	// EngineeringStyle and GlStyle") and the one the C++ table omitted entirely.
	// Engineering is (right, forward, up); Gl is (right, up, back).
	const p = { x: 1, y: 2, z: 3 };
	assertVecEqual(core.ConvertPosition(A.EngineeringStyle, A.GlStyle, p), { x: 1, y: 3, z: -2 },
		'Engineering -> Gl position is (x, z, -y)');
	assertVecEqual(core.ConvertPosition(A.GlStyle, A.EngineeringStyle, p), { x: 1, y: -3, z: 2 },
		'Gl -> Engineering position is (x, -z, y)');

	const q = { x: 1, y: 2, z: 3, w: 4 };
	// Both standards are right-handed, so the change of basis has determinant +1 and the
	// quaternion's vector part permutes exactly as a position does.
	assert.deepStrictEqual(core.ConvertRotation(A.EngineeringStyle, A.GlStyle, q),
		{ x: 1, y: 3, z: -2, w: 4 });
	assert.deepStrictEqual(core.ConvertRotation(A.GlStyle, A.EngineeringStyle, q),
		{ x: 1, y: -3, z: 2, w: 4 });

	const s = { x: 1, y: 2, z: 3 };
	assertVecEqual(core.ConvertScale(A.EngineeringStyle, A.GlStyle, s), { x: 1, y: 3, z: 2 },
		'Engineering -> Gl scale permutes y and z');
	assertVecEqual(core.ConvertScale(A.GlStyle, A.EngineeringStyle, s), { x: 1, y: 3, z: 2 },
		'Gl -> Engineering scale permutes y and z');
});

test('unsupported pairs warn rather than returning silent rubbish', () => {
	const p = { x: 1, y: 2, z: 3 };
	for (const [from, to] of UNSUPPORTED) {
		for (const [fn, name] of [[core.ConvertPosition, 'ConvertPosition'],
			[core.ConvertRotation, 'ConvertRotation'], [core.ConvertScale, 'ConvertScale']]) {
			const warnings = captureWarnings(() => { fn(from, to, { ...p, w: 1 }); });
			assert.ok(warnings.some((w) => w.includes(name) && w.includes('unsupported axes')),
				name + ' ' + label(from, to) + ' should warn; got ' + JSON.stringify(warnings));
		}
	}
});

test('ConvertPose converts all three parts, defaulting an absent scale', () => {
	const pose = {
		position: { x: 1, y: 2, z: 3 },
		orientation: { x: 0.1, y: 0.2, z: 0.3, w: 0.9 },
	};
	const got = core.ConvertPose(A.EngineeringStyle, A.GlStyle, pose);
	assert.deepStrictEqual(got.position,
		core.ConvertPosition(A.EngineeringStyle, A.GlStyle, pose.position));
	assert.deepStrictEqual(got.orientation,
		core.ConvertRotation(A.EngineeringStyle, A.GlStyle, pose.orientation));
	// An absent scale means unit scale, and unit scale is invariant under any permutation.
	assert.deepStrictEqual(got.scale, { x: 1, y: 1, z: 1 });
});
