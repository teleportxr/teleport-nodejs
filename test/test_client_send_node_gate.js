'use strict';
// Regression tests for Client.SendNode / Client.SendGenericResource. Before the
// fix, EncodedResource(uid) was called unconditionally before sendGeometry, so
// a failed send still marked the resource as transmitted and the
// geometry_service refused to retry it until its 10 s timeout elapsed.

const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('../client/client');
const resources = require('../scene/resources');

function makeStubClient(opts) {
	const c = Object.create(Client.prototype);
	c.clientID = 7;
	c.scene = {
		GetNode: () => ({
			name: 'stub-node',
			encodeIntoDataView: (_dv, off) => off + 1,
		}),
	};
	c.geometryService = {
		EncodedResource: (uid) => { c._encodedCalls.push(uid); },
	};
	c._encodedCalls = [];
	c.webRtcConnection = opts.webRtcConnection;
	return c;
}

test('SendNode does not mark resource encoded when geometry channel is not open', () => {
	const c = makeStubClient({
		webRtcConnection: {
			isGeometryOpen: () => false,
			sendGeometry: () => { throw new Error('sendGeometry must not be called when not open'); },
		},
	});
	c.SendNode(42n);
	assert.strictEqual(c._encodedCalls.length, 0);
});

test('SendNode marks resource encoded when sendGeometry returns true', () => {
	const c = makeStubClient({
		webRtcConnection: {
			isGeometryOpen: () => true,
			sendGeometry: () => true,
		},
	});
	c.SendNode(42n);
	assert.deepStrictEqual(c._encodedCalls, [42n]);
});

test('SendNode does not mark resource encoded when sendGeometry returns false', () => {
	// Simulates the race where the channel was "open" at the isGeometryOpen()
	// check but transitioned to closing/closed before send() ran (or wrtc
	// returned false synchronously). The resource must remain unmarked so the
	// next UpdateStreaming tick re-attempts it.
	const c = makeStubClient({
		webRtcConnection: {
			isGeometryOpen: () => true,
			sendGeometry: () => false,
		},
	});
	c.SendNode(42n);
	assert.strictEqual(c._encodedCalls.length, 0);
});

test('SendNode short-circuits when webRtcConnection is null', () => {
	const c = makeStubClient({ webRtcConnection: null });
	// Must not throw; must not record an encoded resource.
	c.SendNode(42n);
	assert.strictEqual(c._encodedCalls.length, 0);
});

// SendGenericResource shares the same gating shape. Build a minimal Resource so
// the encoder doesn't blow up.
class StubResource {
	constructor() {
		this.url = 'stub://resource';
		this.uid = 99n;
	}
	encodedSize() { return 64; }
	encodeIntoDataView(_dv, off) { return off + 1; }
}

test('SendGenericResource does not mark resource encoded when channel is not open', () => {
	const stub = new StubResource();
	const originalGet = resources.GetResourceFromUid;
	resources.GetResourceFromUid = () => stub;
	try {
		const c = makeStubClient({
			webRtcConnection: {
				isGeometryOpen: () => false,
				sendGeometry: () => { throw new Error('must not be called'); },
			},
		});
		c.SendGenericResource(99n);
		assert.strictEqual(c._encodedCalls.length, 0);
	}
	finally {
		resources.GetResourceFromUid = originalGet;
	}
});

test('SendGenericResource marks resource encoded only after a successful send', () => {
	const stub = new StubResource();
	const originalGet = resources.GetResourceFromUid;
	resources.GetResourceFromUid = () => stub;
	try {
		const c = makeStubClient({
			webRtcConnection: {
				isGeometryOpen: () => true,
				sendGeometry: () => true,
			},
		});
		c.SendGenericResource(99n);
		assert.deepStrictEqual(c._encodedCalls, [99n]);

		const c2 = makeStubClient({
			webRtcConnection: {
				isGeometryOpen: () => true,
				sendGeometry: () => false,
			},
		});
		c2.SendGenericResource(99n);
		assert.strictEqual(c2._encodedCalls.length, 0);
	}
	finally {
		resources.GetResourceFromUid = originalGet;
	}
});
