'use strict';
// Builders for Universal Manifest test fixtures: an Ed25519 key pair, a
// did:key identifier for it, and a signed v0.3 manifest.
//
// Fixtures are signed here rather than checked in as static JSON so that
// a change to the canonicaliser shows up as a signature failure in the
// tests instead of silently invalidating a stale blob. The one place a
// static vector IS the right answer is the cross-language check against
// the C++ implementation — see test_manifest_jcs.js.

const crypto = require('node:crypto');

const jcs = require('../../manifest/jcs.js');

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(buf)
{
	const digits = [0];
	for (const byte of buf)
	{
		let carry = byte;
		for (let i = 0; i < digits.length; i++)
		{
			carry += digits[i] << 8;
			digits[i] = carry % 58;
			carry = (carry / 58) | 0;
		}
		while (carry)
		{
			digits.push(carry % 58);
			carry = (carry / 58) | 0;
		}
	}
	let out = '';
	for (const b of buf)
	{
		if (b !== 0) break;
		out += '1';
	}
	for (let i = digits.length - 1; i >= 0; i--)
		out += BASE58_ALPHABET[digits[i]];
	return out;
}

function generateKeyPair()
{
	return crypto.generateKeyPairSync('ed25519');
}

function rawPublicKey(publicKey)
{
	const der = publicKey.export({ format: 'der', type: 'spki' });
	return der.subarray(der.length - 32);
}

// did:key:z<base58btc(0xed01 || raw)>
function didKeyFor(publicKey)
{
	return 'did:key:z' + base58Encode(Buffer.concat([Buffer.from([0xed, 0x01]), rawPublicKey(publicKey)]));
}

function spkiBase64For(publicKey)
{
	return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}

// Sign a manifest in place of any existing signature, exactly as
// manifest/verify.js will check it: JCS over the document minus
// `signature`, Ed25519, value base64url.
function sign(manifest, privateKey, keyRef, extraSignatureMembers = {})
{
	const { signature, ...payload } = manifest;
	void signature;
	const input = jcs.canonicalizeToBuffer(payload);
	const value = crypto.sign(null, input, privateKey).toString('base64url');
	return Object.assign({}, payload, {
		signature: Object.assign({
			algorithm:			'Ed25519',
			canonicalization:	'JCS-RFC8785',
			keyRef,
			value,
		}, extraSignatureMembers),
	});
}

// A valid, signed v0.3 manifest carrying one avatar pointer, one facet
// and a consent for that facet. `overrides` is merged over the envelope
// before signing so a test can perturb any single member.
function makeManifest(opts = {})
{
	const keys		= opts.keys || generateKeyPair();
	const keyRef	= opts.keyRef || didKeyFor(keys.publicKey);
	const now		= Number.isFinite(opts.now) ? opts.now : Date.now();
	const issuedAt	= opts.issuedAt || new Date(now - 60 * 1000).toISOString();
	const expiresAt	= opts.expiresAt || new Date(now + 24 * 3600 * 1000).toISOString();
	const avatarUrl	= opts.avatarUrl || 'https://assets.example/avatars/beta.glb';

	const envelope = Object.assign({
		'@context':			'https://universalmanifest.net/ns/v0.3',
		'@id':				'urn:uuid:6dfc40f2-8797-4f7b-a5f7-49d6a010f600',
		'@type':			['um:Manifest'],
		manifestVersion:	'0.3',
		subject:			'did:web:xr.example:users:beta',
		issuedAt,
		expiresAt,
		pointers: opts.pointers !== undefined ? opts.pointers : [
			{ '@type': 'um:Pointer', name: 'portableIdentity.avatar', target: avatarUrl },
		],
		facets: opts.facets !== undefined ? opts.facets : [
			{
				'@id':		'urn:facet:avatarProfile',
				'@type':	['um:Facet'],
				name:		'avatarProfile',
				entity: {
					'@id':	'did:web:xr.example:users:beta#avatar',
					'@type': ['um:Entity', 'xr:AvatarProfile'],
					skeletonProfile: 'humanoid-v1',
					supportsFacialBlendShapes: true,
				},
			},
		],
		consents: opts.consents !== undefined ? opts.consents : [
			{
				'@id':		'urn:consent:avatarProfile',
				'@type':	'um:Consent',
				facetRef:	'urn:facet:avatarProfile',
				scope:		['read', 'display'],
				purpose:	'avatar-presentation',
				grantedAt:	issuedAt,
				expiresAt:	expiresAt,
			},
		],
	}, opts.overrides || {});

	// Members explicitly set to undefined are removed rather than
	// serialised, so a test can build a manifest that is missing one.
	for (const key of Object.keys(envelope))
	{
		if (envelope[key] === undefined)
			delete envelope[key];
	}

	return {
		keys,
		keyRef,
		manifest: opts.unsigned ? envelope : sign(envelope, keys.privateKey, keyRef, opts.signatureMembers || {}),
	};
}

// A fetcher stub matching the defaultFetcher contract: resolves, never
// rejects, and returns a Buffer body. `routes` maps url → string body or
// a { reason } failure.
function makeFetcher(routes)
{
	const calls = [];
	const fetcher = async (opts) =>
	{
		calls.push(opts);
		const entry = routes[opts.url];
		if (entry === undefined)
			return { ok: false, reason: 'http_404' };
		if (typeof entry === 'object' && entry.reason)
			return { ok: false, reason: entry.reason };
		const body = Buffer.from(typeof entry === 'string' ? entry : JSON.stringify(entry), 'utf8');
		if (opts.maxBytes && body.length > opts.maxBytes)
			return { ok: false, reason: 'file_too_large' };
		return { ok: true, status: 200, body, sha256: '', finalUrl: opts.url };
	};
	fetcher.calls = calls;
	return fetcher;
}

module.exports = {
	base58Encode, generateKeyPair, rawPublicKey, didKeyFor, spkiBase64For,
	sign, makeManifest, makeFetcher,
};
