'use strict';
// RFC 8785 JSON Canonicalisation Scheme.
//
// The vectors in SHARED_VECTORS are duplicated verbatim in
// Teleport/test/test_jcs.cpp. That duplication is deliberate and is the
// only thing holding the two canonicalisers together: if they diverge, a
// manifest signed by the Node.js server fails to verify on the C++ one
// and the failure looks like a bad signature rather than a serialisation
// bug. Add a vector to one file, add it to the other.

const test		= require('node:test');
const assert	= require('node:assert');

const jcs = require('../manifest/jcs.js');

// [ description, input JSON text, expected canonical form ]
const SHARED_VECTORS = [
	['empty object',			'{}',								'{}'],
	['empty array',				'[]',								'[]'],
	['null',					'null',								'null'],
	['booleans in an array',	'[true,false]',						'[true,false]'],
	['member order is sorted',	'{"b":1,"a":2}',					'{"a":2,"b":1}'],
	['whitespace is removed',	'{ "a" : [ 1 , 2 ] }',				'{"a":[1,2]}'],
	['nested objects sort independently',
								'{"b":{"d":1,"c":2},"a":3}',		'{"a":3,"b":{"c":2,"d":1}}'],
	['array order is preserved',
								'{"a":[3,1,2]}',					'{"a":[3,1,2]}'],
	// RFC 8785 §3.2.3: sorting is on UTF-16 code units, so an uppercase
	// letter sorts before a lowercase one and a digit before both.
	['ascii key ordering',		'{"a":1,"A":2,"1":3}',				'{"1":3,"A":2,"a":1}'],
	// A key that is a prefix of another sorts first.
	['prefix keys',				'{"ab":1,"a":2}',					'{"a":2,"ab":1}'],
	// Non-ASCII keys sort by code unit, not by locale or code point.
	['non-ascii key ordering',	'{"\\u00e9":1,"z":2}',				'{"z":2,"é":1}'],
	// The case that separates UTF-16 code-unit order from UTF-8 byte order,
	// which is what a C++ std::map would give: U+1F600 encodes as the
	// surrogate pair D83D DE00, and D83D sorts BELOW U+FFFD, so the emoji
	// key comes first — the opposite of code-point order.
	['astral key ordering',		'{"\\ufffd":1,"\\ud83d\\ude00":2}',	'{"😀":2,"�":1}'],
	// Numbers use ECMAScript Number::toString: no trailing zeros, no
	// leading plus, exponent only where it is shorter.
	['integer numbers',			'{"a":1,"b":-0,"c":0}',				'{"a":1,"b":0,"c":0}'],
	['fractional numbers',		'{"a":1.5,"b":1.0,"c":100.0}',		'{"a":1.5,"b":1,"c":100}'],
	['large and small numbers',	'{"a":1e21,"b":1e-7}',				'{"a":1e+21,"b":1e-7}'],
	// The positional/exponential switch is made on the decimal exponent
	// alone — below 1e-6 and at or above 1e21 — never on whichever form
	// happens to be shorter. printf-family formatting gets this wrong,
	// and so does std::to_chars' shortest mode, which is why the C++ side
	// re-formats rather than using it directly.
	['1e-5 stays positional',	'{"a":1e-5}',						'{"a":0.00001}'],
	['1e-6 stays positional',	'{"a":1e-6}',						'{"a":0.000001}'],
	['1e-7 goes exponential',	'{"a":1e-7}',						'{"a":1e-7}'],
	['1e20 stays positional',	'{"a":1e20}',						'{"a":100000000000000000000}'],
	['1e21 goes exponential',	'{"a":1e21}',						'{"a":1e+21}'],
	['exponent carries no padding zeros',	'{"a":1.5e-7}',			'{"a":1.5e-7}'],
	['fraction below the switch',	'{"a":0.0001}',					'{"a":0.0001}'],
	['mixed integer and fraction',	'{"a":123.456}',				'{"a":123.456}'],
	['negative fraction',		'{"a":-1.5}',						'{"a":-1.5}'],
	// Escaping follows JSON.stringify: the short forms where they exist,
	// \u00XX for other control characters, and no escaping of forward
	// slash or non-ASCII.
	['string escapes',			'{"a":"\\"\\\\\\b\\f\\n\\r\\t"}',	'{"a":"\\"\\\\\\b\\f\\n\\r\\t"}'],
	['control character escape',	'{"a":"\\u0000\\u001f"}',			'{"a":"\\u0000\\u001f"}'],
	['forward slash is not escaped',	'{"a":"/"}',				'{"a":"/"}'],
	['non-ascii is not escaped',	'{"a":"\\u00e9\\u20ac"}',		'{"a":"é€"}'],
	['surrogate pair is not escaped',	'{"a":"\\ud83d\\ude00"}',	'{"a":"😀"}'],
];

for (const [description, input, expected] of SHARED_VECTORS)
{
	test('jcs vector: ' + description, () => {
		assert.strictEqual(jcs.canonicalize(JSON.parse(input)), expected);
	});
}

test('jcs: canonicalisation is stable under re-parsing', () => {
	const value = { z: [1, { b: 2, a: 3 }], a: 'x' };
	const once = jcs.canonicalize(value);
	assert.strictEqual(jcs.canonicalize(JSON.parse(once)), once);
});

test('jcs: member order in the source does not matter', () => {
	const a = jcs.canonicalize({ one: 1, two: 2, three: 3 });
	const b = jcs.canonicalize({ three: 3, one: 1, two: 2 });
	assert.strictEqual(a, b);
});

test('jcs: canonicalizeToBuffer emits utf-8', () => {
	const buf = jcs.canonicalizeToBuffer({ 'é': '€' });
	assert.ok(Buffer.isBuffer(buf));
	assert.strictEqual(buf.toString('utf8'), '{"é":"€"}');
	// Two bytes for é, three for €, plus the seven ASCII delimiters.
	assert.strictEqual(buf.length, 2 + 3 + 7);
});

test('jcs: undefined object members are dropped, array holes become null', () => {
	assert.strictEqual(jcs.canonicalize({ a: undefined, b: 1 }), '{"b":1}');
	assert.strictEqual(jcs.canonicalize([1, undefined, 2]), '[1,null,2]');
});

test('jcs: non-finite numbers are refused rather than serialised', () => {
	// RFC 8785 has no representation for these, and quietly emitting
	// null would produce a document that verifies against bytes nobody
	// signed.
	assert.throws(() => jcs.canonicalize({ a: NaN }), TypeError);
	assert.throws(() => jcs.canonicalize({ a: Infinity }), TypeError);
	assert.throws(() => jcs.canonicalize({ a: -Infinity }), TypeError);
});

test('jcs: bigint is refused', () => {
	assert.throws(() => jcs.canonicalize({ a: 1n }), TypeError);
});

test('jcs: compareCodeUnits orders by utf-16 code unit', () => {
	assert.ok(jcs.compareCodeUnits('A', 'a') < 0);
	assert.ok(jcs.compareCodeUnits('a', 'b') < 0);
	assert.ok(jcs.compareCodeUnits('a', 'a') === 0);
	assert.ok(jcs.compareCodeUnits('z', 'é') < 0);
});
