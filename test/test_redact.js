'use strict';
// Tests for the URL/proof redaction helpers (plans/avatars_plan.md §8).

const test		= require('node:test');
const assert	= require('node:assert');

const { redactUrl, redactProof } = require('../utils/redact.js');

test('redactUrl: strips path, query and credentials down to scheme+host', () => {
	assert.strictEqual(redactUrl('https://avatars.example.com/u/abcd1234.glb?token=SECRET'),
		'https://avatars.example.com/...');
	assert.strictEqual(redactUrl('https://user:pass@host.example/x'), 'https://host.example/...');
	assert.strictEqual(redactUrl('http://host.example:8080/deep/path'), 'http://host.example:8080/...');
});

test('redactUrl: keeps server-relative paths but strips query and fragment', () => {
	assert.strictEqual(redactUrl('/avatars/abc123.glb'), '/avatars/abc123.glb');
	assert.strictEqual(redactUrl('/avatars/abc.glb?token=SECRET'), '/avatars/abc.glb');
	assert.strictEqual(redactUrl('/avatars/abc.glb#SECRET'), '/avatars/abc.glb');
	// Protocol-relative is a host, not a path.
	assert.strictEqual(redactUrl('//host.example/x'), '<invalid-url>');
});

test('redactUrl: never echoes an unparseable input', () => {
	const out = redactUrl('not a url with SECRET in it');
	assert.strictEqual(out, '<invalid-url>');
	assert.strictEqual(redactUrl(''), '<no-url>');
	assert.strictEqual(redactUrl(null), '<no-url>');
});

test('redactProof: describes without echoing the value', () => {
	assert.strictEqual(redactProof({ scheme: 'jws-detached', value: 'x'.repeat(84) }), '<jws-detached 84 bytes>');
	assert.strictEqual(redactProof('y'.repeat(10)), '<proof 10 bytes>');
	assert.strictEqual(redactProof({ value: 'abc' }), '<proof 3 bytes>');
	assert.strictEqual(redactProof(null), '<no-proof>');
	assert.ok(!redactProof({ scheme: 'jws-detached', value: 'TOPSECRET' }).includes('TOPSECRET'));
});
