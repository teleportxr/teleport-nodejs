'use strict';
// Regression tests for the decodeFromDataView duplicate that lives in
// protocol/message.js. The duplicate had four latent bugs (object-assignment
// via Object.entries, missing endian on multi-byte getters, undefined `value`
// in the struct branch, and a missing SizeOfType import). Tests are written
// against the function as exercised through a small re-export so the bugfix
// stays load-bearing even though no production caller imports it today.

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// Reach into protocol/message.js's module scope to grab the (non-exported)
// decodeFromDataView. Re-loading the module and reading its compiled wrapper
// is overkill; instead, require() the file and use a tiny trick: the function
// is referenced by class methods on classes that ARE exported. Since none of
// the exported classes call it either, we evaluate the module file once and
// pull the symbol from its source via Function constructor.
function loadLocalDecode() {
	const fs = require('node:fs');
	const path = require('node:path');
	const src = fs.readFileSync(
		path.join(__dirname, '..', 'protocol', 'message.js'),
		'utf8'
	);
	// Stand up a fake module context that mirrors the file's top-level requires
	// but exposes decodeFromDataView. Tack a `module.exports.decodeFromDataView`
	// assignment onto the end and evaluate via Module._compile.
	const m = new Module(require.resolve('../protocol/message.js'));
	m.filename = require.resolve('../protocol/message.js');
	m.paths = Module._nodeModulePaths(m.filename);
	m._compile(
		src + '\nmodule.exports.decodeFromDataView = decodeFromDataView;\n',
		m.filename
	);
	return m.exports.decodeFromDataView;
}

const decodeFromDataView = loadLocalDecode();
const core = require('../core/core.js');

test('decodeFromDataView writes uint8 fields back onto the target object', () => {
	const obj = { uint8_messagePayloadType: 0 };
	const ab = new ArrayBuffer(1);
	new DataView(ab).setUint8(0, 12);
	decodeFromDataView(obj, new DataView(ab), 0);
	assert.strictEqual(obj.uint8_messagePayloadType, 12);
});

test('decodeFromDataView reads multi-byte fields in the writer\'s endianness', () => {
	// The writer (core.encodeIntoDataView) uses core.endian (little-endian).
	// Pre-fix, the local decoder omitted the endian argument and would have
	// read big-endian, so 42n encoded LE as 2a 00 00 00 00 00 00 00 would
	// decode as 0x2a00000000000000n. Pin the round-trip.
	const obj = { uint64_ackId: 0n };
	const ab = new ArrayBuffer(8);
	new DataView(ab).setBigUint64(0, 42n, core.endian);
	decodeFromDataView(obj, new DataView(ab), 0);
	assert.strictEqual(obj.uint64_ackId, 42n);
});

test('decodeFromDataView round-trips a full Message-shaped payload', () => {
	// The Message base class is { uint8_messagePayloadType, int64_timestamp }
	// plus one trailing uint64. Build the layout directly so we don't depend
	// on the (separately tested) core encoder.
	const obj = {
		uint8_messagePayloadType: 0,
		int64_timestamp: 0n,
		uint64_ackId: 0n,
	};
	const ab = new ArrayBuffer(17);
	const dv = new DataView(ab);
	dv.setUint8(0, 12);
	dv.setBigInt64(1, -7n, core.endian);
	dv.setBigUint64(9, 0xdeadbeefn, core.endian);
	const endOffset = decodeFromDataView(obj, new DataView(ab), 0);
	assert.strictEqual(endOffset, 17);
	assert.strictEqual(obj.uint8_messagePayloadType, 12);
	assert.strictEqual(obj.int64_timestamp, -7n);
	assert.strictEqual(obj.uint64_ackId, 0xdeadbeefn);
});

test('decodeFromDataView recurses into nested struct fields', () => {
	// "struct" is the catch-all branch in SizeOfType — anything not in the
	// primitive list is treated as a nested object whose own keys follow the
	// type_name convention. Pre-fix, this branch referenced an undefined
	// `value` and would have thrown TypeError on the very first struct field.
	const obj = {
		struct_inner: { uint8_kind: 0, uint32_value: 0 },
		uint8_trailer: 0,
	};
	const ab = new ArrayBuffer(6);
	const dv = new DataView(ab);
	dv.setUint8(0, 3);
	dv.setUint32(1, 0x11223344, core.endian);
	dv.setUint8(5, 0xff);
	const endOffset = decodeFromDataView(obj, new DataView(ab), 0);
	assert.strictEqual(endOffset, 6);
	assert.strictEqual(obj.struct_inner.uint8_kind, 3);
	assert.strictEqual(obj.struct_inner.uint32_value, 0x11223344);
	assert.strictEqual(obj.uint8_trailer, 0xff);
});

test('decodeFromDataView does not mutate Object.entries itself', () => {
	// Pin the most embarrassing of the pre-fix bugs: `Object.entries[key]=value`
	// wrote properties onto the global Object.entries function. After the fix,
	// decoding must leave Object.entries untouched.
	const before = Object.getOwnPropertyNames(Object.entries);
	const obj = { uint8_x: 0 };
	const ab = new ArrayBuffer(1);
	new DataView(ab).setUint8(0, 99);
	decodeFromDataView(obj, new DataView(ab), 0);
	const after = Object.getOwnPropertyNames(Object.entries);
	assert.deepStrictEqual(after, before);
});
