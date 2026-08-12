'use strict';
// RFC 8785 JSON Canonicalisation Scheme (JCS).
//
// Universal Manifest Signature Profile A signs the JCS serialisation of
// the manifest with the `signature` member removed, so this module is on
// the critical path for every manifest verification. It is mirrored
// byte-for-byte by TeleportCore/Jcs.cpp — the two implementations are
// held together by the shared vector set in test/test_manifest_jcs.js
// and Teleport/test/test_jcs.cpp. Change one, change both.
//
// The three rules that matter (RFC 8785 §3.2.2 and §3.2.3):
//   * no insignificant whitespace;
//   * object members sorted by the UTF-16 code units of their names;
//   * strings and numbers serialised exactly as ECMAScript's
//     JSON.stringify would.
//
// The third rule is why this file leans on JSON.stringify for the two
// scalar cases rather than reimplementing them: in JavaScript that
// function *is* the normative behaviour the RFC points at.

// RFC 8785 §3.2.3: sort on UTF-16 code units, not code points and not
// locale collation. JavaScript's relational operators on strings already
// compare code units, but the comparator is spelled out because
// Array.prototype.sort's default is defined in terms of ToString and it
// should be obvious to a reader that no locale is involved.
function compareCodeUnits(a, b)
{
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

// Serialise one value. Mirrors JSON semantics for the cases JSON has an
// opinion about (undefined members dropped from objects, undefined array
// elements becoming null) so that canonicalize(x) and JSON.stringify(x)
// only ever differ in whitespace and member order.
function serialize(value)
{
	if (value === null)
		return 'null';

	const type = typeof value;

	if (type === 'boolean')
		return value ? 'true' : 'false';

	if (type === 'number')
	{
		// RFC 8785 §3.2.2.3 has no representation for these; a manifest
		// containing one is not canonicalisable and must not be signed
		// or verified as if it were.
		if (!Number.isFinite(value))
			throw new TypeError('jcs: cannot canonicalise non-finite number');
		// JSON.stringify implements ECMAScript Number::toString, which is
		// what the RFC specifies, and already renders -0 as "0".
		return JSON.stringify(value);
	}

	if (type === 'string')
		return JSON.stringify(value);

	if (type === 'bigint')
		throw new TypeError('jcs: cannot canonicalise bigint');

	if (Array.isArray(value))
	{
		const parts = new Array(value.length);
		for (let i = 0; i < value.length; i++)
		{
			const element = value[i];
			// Matches JSON.stringify: a hole, undefined or a function in
			// an array serialises as null rather than vanishing, because
			// dropping it would change every later index.
			parts[i] = (element === undefined || typeof element === 'function')
				? 'null'
				: serialize(element);
		}
		return '[' + parts.join(',') + ']';
	}

	if (type === 'object')
	{
		const keys = Object.keys(value)
			.filter((k) => value[k] !== undefined && typeof value[k] !== 'function')
			.sort(compareCodeUnits);
		const parts = new Array(keys.length);
		for (let i = 0; i < keys.length; i++)
			parts[i] = JSON.stringify(keys[i]) + ':' + serialize(value[keys[i]]);
		return '{' + parts.join(',') + '}';
	}

	// undefined, symbol: no JSON representation at all.
	throw new TypeError('jcs: cannot canonicalise ' + type);
}

// Canonicalise a parsed JSON value to its RFC 8785 string form.
function canonicalize(value)
{
	return serialize(value);
}

// The bytes that actually get signed or verified. UTF-8 per RFC 8785 §3.3.
function canonicalizeToBuffer(value)
{
	return Buffer.from(canonicalize(value), 'utf8');
}

module.exports = { canonicalize, canonicalizeToBuffer, compareCodeUnits };
