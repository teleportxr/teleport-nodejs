'use strict';
// Stage 2 of the Universal Manifest evaluation sequence: Verify.
//
// Signature Profile A is the only profile this implementation supports:
// JCS-RFC8785 canonicalisation of the manifest with `signature` removed,
// signed with Ed25519. Anything else is reported as an unsupported
// profile rather than silently accepted.
//
// What this module deliberately does NOT do is check that the manifest's
// `subject` is the client presenting it. Verification here proves the
// document is authentic and unmodified; it does not prove the bearer has
// any right to it. Binding subject to the connecting identity is the
// avatar-proof work (plans/avatars_plan.md §6) and is tracked separately.
// Until it lands, a verified manifest is genuine but not necessarily
// yours.

const crypto = require('node:crypto');

const jcs = require('./jcs.js');

// Ed25519 SubjectPublicKeyInfo prefix: SEQUENCE { SEQUENCE { OID
// 1.3.101.112 }, BIT STRING }. Prepending this to the 32 raw key bytes
// is the cheapest way to hand a raw key to node:crypto, which only
// ingests structured formats.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_RAW_KEY_BYTES = 32;

const SUPPORTED_ALGORITHM		= 'Ed25519';
const SUPPORTED_CANONICALIZATION = 'JCS-RFC8785';

// Tolerance for disagreeing clocks between the manifest issuer and this
// server. Generous enough to survive an unsynchronised host, tight
// enough that an expired manifest is not usable for long.
const DEFAULT_CLOCK_SKEW_MS = 60 * 1000;

// base58btc, as used by did:key. Small enough to inline; pulling a
// dependency in for forty lines of arithmetic is not worth the supply
// chain.
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(str)
{
	if (typeof str !== 'string' || !str.length)
		return null;
	const bytes = [0];
	for (const ch of str)
	{
		const value = BASE58_ALPHABET.indexOf(ch);
		if (value < 0)
			return null;
		let carry = value;
		for (let i = 0; i < bytes.length; i++)
		{
			carry += bytes[i] * 58;
			bytes[i] = carry & 0xff;
			carry >>= 8;
		}
		while (carry)
		{
			bytes.push(carry & 0xff);
			carry >>= 8;
		}
	}
	// Every leading '1' is a leading zero byte that the arithmetic above
	// cannot represent.
	for (let i = 0; i < str.length && str[i] === '1'; i++)
		bytes.push(0);
	return Buffer.from(bytes.reverse());
}

// Wrap 32 raw Ed25519 public key bytes as a node:crypto KeyObject.
function keyFromRaw(raw)
{
	if (!Buffer.isBuffer(raw) || raw.length !== ED25519_RAW_KEY_BYTES)
		return null;
	try
	{
		return crypto.createPublicKey({
			key:	Buffer.concat([ED25519_SPKI_PREFIX, raw]),
			format:	'der',
			type:	'spki',
		});
	}
	catch (e)
	{
		return null;
	}
}

// Extract the 32 raw bytes back out of a KeyObject so two keys reached
// by different routes can be compared for the keyRef/inline consistency
// check.
function rawFromKey(key)
{
	if (!key) return null;
	try
	{
		const der = key.export({ format: 'der', type: 'spki' });
		if (der.length < ED25519_RAW_KEY_BYTES) return null;
		return der.subarray(der.length - ED25519_RAW_KEY_BYTES);
	}
	catch (e)
	{
		return null;
	}
}

function keyFromSpkiBase64(b64)
{
	if (typeof b64 !== 'string' || !b64.length)
		return null;
	try
	{
		// Accept both base64 and base64url; the profile names base64 but
		// the two differ only in two characters and rejecting a
		// url-safe encoding here would be gratuitous.
		const der = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
		return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
	}
	catch (e)
	{
		return null;
	}
}

// did:key:z<base58btc(0xed01 || raw)> is the Ed25519 multicodec form.
function keyFromDidKey(did)
{
	if (typeof did !== 'string' || !did.startsWith('did:key:z'))
		return null;
	// Strip any fragment: did:key:z6Mk...#z6Mk... refers to the same key.
	const encoded = did.slice('did:key:z'.length).split('#')[0];
	const decoded = base58Decode(encoded);
	if (!decoded || decoded.length !== ED25519_RAW_KEY_BYTES + 2)
		return null;
	if (decoded[0] !== 0xed || decoded[1] !== 0x01)
		return null;
	return keyFromRaw(decoded.subarray(2));
}

// A JWK or JWKS document fetched from an https keyRef. `kid` comes from
// the keyRef's fragment when it has one.
function keyFromJwkDocument(doc, kid)
{
	if (!doc || typeof doc !== 'object')
		return null;
	const candidates = Array.isArray(doc.keys) ? doc.keys : [doc];
	const usable = candidates.filter((k) => k && k.kty === 'OKP' && k.crv === 'Ed25519' && typeof k.x === 'string');
	if (!usable.length)
		return null;
	const chosen = kid ? usable.find((k) => k.kid === kid) : usable[0];
	if (!chosen)
		return null;
	return keyFromRaw(Buffer.from(chosen.x, 'base64url'));
}

// Resolve signature.keyRef to a public key.
//
// The spec is explicit that skipping key resolution is non-conformant:
// accepting an inline public key without checking it against the keyRef
// lets an attacker re-sign a modified manifest with their own key and
// swap the inline key to match. So an unresolvable keyRef is a failure
// even when an inline key is present.
async function resolveKey(signature, opts = {})
{
	const keyRef	= typeof signature.keyRef === 'string' ? signature.keyRef : '';
	const inline	= keyFromSpkiBase64(signature.publicKeySpkiB64);

	if (!keyRef)
		return { ok: false, reason: 'manifest_key_unresolvable' };

	let resolved = null;

	if (keyRef.startsWith('did:key:'))
	{
		resolved = keyFromDidKey(keyRef);
	}
	else if (keyRef.startsWith('https:'))
	{
		if (typeof opts.fetcher !== 'function')
			return { ok: false, reason: 'manifest_key_unresolvable' };
		const hashIndex = keyRef.indexOf('#');
		const url = hashIndex >= 0 ? keyRef.slice(0, hashIndex) : keyRef;
		const kid = hashIndex >= 0 ? keyRef.slice(hashIndex + 1) : '';
		const fetched = await opts.fetcher({
			url:			url,
			maxBytes:		opts.maxKeyBytes || 64 * 1024,
			timeoutMs:		opts.timeoutMs || 5000,
			maxRedirects:	opts.maxRedirects ?? 3,
			allowedSchemes:	opts.allowedSchemes || ['https:'],
		});
		if (!fetched.ok)
			return { ok: false, reason: 'manifest_key_unresolvable' };
		try
		{
			resolved = keyFromJwkDocument(JSON.parse(fetched.body.toString('utf8')), kid);
		}
		catch (e)
		{
			resolved = null;
		}
	}
	else
	{
		// did:web and anything else: not supported yet. Refusing is the
		// conformant outcome — see the note above.
		return { ok: false, reason: 'manifest_key_unresolvable' };
	}

	if (!resolved)
		return { ok: false, reason: 'manifest_key_unresolvable' };

	// Consistency check. Both routes must arrive at the same key.
	if (inline)
	{
		const a = rawFromKey(inline);
		const b = rawFromKey(resolved);
		if (!a || !b || !a.equals(b))
			return { ok: false, reason: 'manifest_signature_invalid' };
	}

	return { ok: true, key: resolved };
}

// The signing input: the manifest with `signature` removed, canonicalised.
// Removing it is what stops the signature covering itself.
function signingInput(manifest)
{
	const { signature, ...payload } = manifest;
	void signature;
	return jcs.canonicalizeToBuffer(payload);
}

function parseTime(value)
{
	if (typeof value !== 'string' || !value.length) return NaN;
	return Date.parse(value);
}

// Freshness against issuedAt/expiresAt. Returns one of the three receipt
// values. `stale` is used for a manifest whose issuedAt is in the future
// beyond the skew allowance — it is not expired, but it is not something
// a correct clock should be presenting either.
function checkFreshness(manifest, opts = {})
{
	const now	= Number.isFinite(opts.now) ? opts.now : Date.now();
	const skew	= Number.isFinite(opts.clockSkewMs) ? opts.clockSkewMs : DEFAULT_CLOCK_SKEW_MS;

	const issued	= parseTime(manifest.issuedAt);
	const expires	= parseTime(manifest.expiresAt);

	if (!Number.isFinite(issued) || !Number.isFinite(expires))
		return 'expired';
	if (now > expires + skew)
		return 'expired';
	if (issued > now + skew)
		return 'stale';
	return 'fresh';
}

// Full stage 2. Returns { signatureCheck, freshnessCheck, reasons } where
// signatureCheck is one of valid | invalid | unsupported-profile and
// freshnessCheck one of fresh | expired | stale, matching the receipt
// enumerations exactly.
async function verifyManifest(manifest, opts = {})
{
	const reasons	= [];
	const signature	= manifest && manifest.signature;

	const freshnessCheck = checkFreshness(manifest, opts);
	if (freshnessCheck === 'expired')
		reasons.push('manifest_expired');
	else if (freshnessCheck === 'stale')
		reasons.push('manifest_expired');

	if (!signature || typeof signature !== 'object')
		return { signatureCheck: 'unsupported-profile', freshnessCheck, reasons: reasons.concat(['manifest_signature_invalid']) };

	if (signature.algorithm !== SUPPORTED_ALGORITHM || signature.canonicalization !== SUPPORTED_CANONICALIZATION)
		return { signatureCheck: 'unsupported-profile', freshnessCheck, reasons: reasons.concat(['manifest_signature_invalid']) };

	const key = await resolveKey(signature, opts);
	if (!key.ok)
		return { signatureCheck: 'invalid', freshnessCheck, reasons: reasons.concat([key.reason]) };

	let valid = false;
	try
	{
		const input	= signingInput(manifest);
		const sig	= Buffer.from(String(signature.value || ''), 'base64url');
		// Ed25519 takes a null algorithm: the hash is part of the scheme.
		valid = crypto.verify(null, input, key.key, sig);
	}
	catch (e)
	{
		valid = false;
	}

	if (!valid)
		return { signatureCheck: 'invalid', freshnessCheck, reasons: reasons.concat(['manifest_signature_invalid']) };

	return { signatureCheck: 'valid', freshnessCheck, reasons };
}

module.exports = {
	SUPPORTED_ALGORITHM, SUPPORTED_CANONICALIZATION, DEFAULT_CLOCK_SKEW_MS,
	base58Decode, keyFromRaw, rawFromKey, keyFromSpkiBase64, keyFromDidKey, keyFromJwkDocument,
	resolveKey, signingInput, checkFreshness, verifyManifest,
};
