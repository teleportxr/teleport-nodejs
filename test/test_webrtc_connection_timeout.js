'use strict';
// Tests for WebRTC connection timeout functionality.
// Verifies that clients that don't establish WebRTC within the configured
// timeout are automatically disconnected.

const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('../client/client');
const { ClientManager } = require('../client/client_manager');

// Helper to create a stub client
function makeStubClient(opts = {}) {
	const c = Object.create(Client.prototype);
	c.clientID = opts.clientID || 1;
	c.scene = { GetAllNodeUids: () => [] };
	c.geometryService = {
		StreamNode: () => {},
		GetNodesToSend: () => [],
		GetMeshesToSend: () => [],
		GetCanvasesToSend: () => [],
		GetFontAtlasesToSend: () => [],
		GetTexturesToSend: () => [],
	};
	c.clientStartMs = opts.clientStartMs || Date.now();
	c.webRtcConnectedAtMs = 0;
	c.webRtcConnected = false;
	c.webRtcConnection = null;
	c.webRtcConnectionInitiatedAtMs = opts.webRtcConnectionInitiatedAtMs || 0;
	c.StopStreaming = opts.StopStreaming || (() => {});
	return c;
}

test('hasWebRtcConnectionTimedOut returns false when no connection attempt', () => {
	const c = makeStubClient();
	assert.strictEqual(c.hasWebRtcConnectionTimedOut(), false);
});

test('hasWebRtcConnectionTimedOut returns false when already connected', () => {
	const c = makeStubClient();
	c.webRtcConnected = true;
	c.webRtcConnectionInitiatedAtMs = Date.now() - 100000; // old time
	assert.strictEqual(c.hasWebRtcConnectionTimedOut(), false);
});

test('hasWebRtcConnectionTimedOut returns false when under timeout', () => {
	const c = makeStubClient({
		webRtcConnectionInitiatedAtMs: Date.now() - 5000, // 5 seconds ago
	});
	c.webRtcConnected = false;
	assert.strictEqual(c.hasWebRtcConnectionTimedOut(), false);
});

test('hasWebRtcConnectionTimedOut returns true when over timeout', async () => {
	const c = makeStubClient({
		webRtcConnectionInitiatedAtMs: Date.now() - 15000, // 15 seconds ago
	});
	c.webRtcConnected = false;
	assert.strictEqual(c.hasWebRtcConnectionTimedOut(), true);
});

test('ClientManager.UpdateStreaming removes timed-out clients', async () => {
	const cm = new ClientManager();
	const clientsRemoved = [];

	// Create two stub clients
	const client1 = makeStubClient({ clientID: 1 });
	const client2 = makeStubClient({
		clientID: 2,
		webRtcConnectionInitiatedAtMs: Date.now() - 15000, // Will timeout
	});

	client2.webRtcConnected = false;

	cm.clients.set(1, client1);
	cm.clients.set(2, client2);

	// Mock the RemoveClient to track removals
	const originalRemoveClient = cm.RemoveClient.bind(cm);
	cm.RemoveClient = (clientID) => {
		clientsRemoved.push(clientID);
		originalRemoveClient(clientID);
	};

	cm.UpdateStreaming();

	// Client 2 should have been removed due to timeout
	assert.deepStrictEqual(clientsRemoved, [2]);
	assert.strictEqual(cm.clients.has(1), true, 'Client 1 should still exist');
	assert.strictEqual(cm.clients.has(2), false, 'Client 2 should be removed');
});
