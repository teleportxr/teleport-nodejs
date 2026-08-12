'use strict';
// AvatarService with a manifest resolver wired in. The point of every
// test here is that manifest resolution is an indirection in FRONT of
// the existing pipeline: once it has produced an asset url, the
// validator and importer see exactly what they would have seen had the
// client offered that url directly.

const test		= require('node:test');
const assert	= require('node:assert');

const avatars			= require('../protocol/avatars.js');
const avatar_service	= require('../client/avatar_service.js');

const MANIFEST_URL	= 'https://manifests.example/me.jsonld';
const AVATAR_URL	= 'https://assets.example/avatars/beta.glb';

function makeSink() {
	const sent = [];
	return { send: (s) => sent.push(JSON.parse(s)), sent };
}

// A resolver stub in the IAvatarManifestResolver shape.
function makeResolver(result) {
	const calls = [];
	return {
		calls,
		async resolve(manifestOffer, requirements) {
			calls.push({ manifestOffer, requirements });
			return result;
		},
	};
}

function okResult(overrides = {}) {
	return Object.assign({
		ok:			true,
		reasons:	[],
		manifestUrl: MANIFEST_URL,
		avatarUrl:	AVATAR_URL,
		subject:	'did:web:xr.example:users:beta',
		projection:	{ subject: 'did:web:xr.example:users:beta', pointer: 'portableIdentity.avatar', facets: [], claims: [] },
		receipt:	{ manifestId: 'urn:uuid:1', outcome: 'accepted', signatureCheck: 'valid', freshnessCheck: 'fresh', facetStatuses: [], warnings: [] },
		expiresAt:	Date.now() + 3600000,
	}, overrides);
}

// A validator that accepts whatever url it is handed, recording it.
function makeValidator() {
	const seen = [];
	return {
		seen,
		async validate(offer) {
			seen.push(offer.url);
			return { ok: true, reasons: [], bytes: 1024, contentHash: 'sha256:' + 'a'.repeat(64), format: 'glb', body: Buffer.alloc(0) };
		},
	};
}

function makeImporter(uid = 99n) {
	const calls = [];
	return {
		calls,
		relayForClient(clientID, client, url) { calls.push(['relay', url]); return uid; },
		async importValidatedForClient() { calls.push(['import']); return uid; },
		importDefaultForClient() { calls.push(['default']); return 5n; },
		removeForClient() { calls.push(['remove']); },
	};
}

function serviceWith(opts) {
	const sink = makeSink();
	const svc = new avatar_service.AvatarService(42n, sink.send, opts);
	svc.sendPolicy(new avatars.AvatarPolicy({
		policy_id:			7n,
		default_available:	true,
		requirements:		{ formats: ['glb'], manifest: { accepted: ['https://universalmanifest.net/ns/v0.3'] } },
	}));
	sink.sent.length = 0;
	return { svc, sink };
}

// Happy path -------------------------------------------------------

test('a manifest offer resolves to an asset url and reaches the validator', async () => {
	const validator = makeValidator();
	const resolver	= makeResolver(okResult());
	const { svc, sink } = serviceWith({ validator, importer: makeImporter(), manifestResolver: resolver });

	await svc.handleOffer({ policy_id: 7, have_avatar: true, manifest: { url: MANIFEST_URL } });

	// The validator never learns a manifest was involved.
	assert.deepStrictEqual(validator.seen, [AVATAR_URL]);
	const msg = sink.sent.at(-1);
	assert.strictEqual(msg.content.status, 'accepted');
	assert.strictEqual(msg.content.node_uid, 99);
});

test('the resolver is handed the policy manifest requirements block', async () => {
	const resolver = makeResolver(okResult());
	const { svc } = serviceWith({ validator: makeValidator(), manifestResolver: resolver });

	await svc.handleOffer({ policy_id: 7, have_avatar: true, manifest: { url: MANIFEST_URL, pointer: 'game.avatar' } });

	assert.strictEqual(resolver.calls.length, 1);
	assert.deepStrictEqual(resolver.calls[0].manifestOffer, { url: MANIFEST_URL, pointer: 'game.avatar' });
	assert.deepStrictEqual(resolver.calls[0].requirements, { accepted: ['https://universalmanifest.net/ns/v0.3'] });
});

test('the receipt is attached to the avatar-result', async () => {
	const resolver = makeResolver(okResult({
		receipt: {
			manifestId: 'urn:uuid:abc', outcome: 'accepted-partial',
			signatureCheck: 'valid', freshnessCheck: 'fresh',
			facetStatuses: [{ facetId: 'urn:f:1', name: 'avatarProfile', status: 'consent-missing' }],
			warnings: [],
		},
	}));
	const { svc, sink } = serviceWith({ validator: makeValidator(), manifestResolver: resolver });

	await svc.handleOffer({ policy_id: 7, have_avatar: true, manifest: { url: MANIFEST_URL } });

	const manifest = sink.sent.at(-1).content.manifest;
	assert.ok(manifest, 'avatar-result should carry a manifest receipt');
	assert.strictEqual(manifest.manifest_id, 'urn:uuid:abc');
	assert.strictEqual(manifest.outcome, 'accepted-partial');
	assert.strictEqual(manifest.signature_check, 'valid');
	assert.strictEqual(manifest.freshness_check, 'fresh');
	assert.deepStrictEqual(manifest.facets, [{ name: 'avatarProfile', status: 'consent-missing' }]);
});

test('a resolved url that is relayable is relayed, not imported', async () => {
	// The relay/import decision is made on the RESOLVED url, so a
	// manifest pointing at a .glb relays exactly as a direct offer would.
	const importer = makeImporter();
	const { svc } = serviceWith({ validator: makeValidator(), importer, manifestResolver: makeResolver(okResult()) });

	await svc.handleOffer({ policy_id: 7, have_avatar: true, manifest: { url: MANIFEST_URL } });

	assert.deepStrictEqual(importer.calls, [['relay', AVATAR_URL]]);
});

test('a resolved url with no relayable extension is imported', async () => {
	const importer = makeImporter();
	const resolver = makeResolver(okResult({ avatarUrl: 'https://assets.example/asset?id=7' }));
	const { svc, sink } = serviceWith({ validator: makeValidator(), importer, manifestResolver: resolver });

	await svc.handleOffer({ policy_id: 7, have_avatar: true, manifest: { url: MANIFEST_URL } });

	assert.deepStrictEqual(importer.calls, [['import']]);
	assert.strictEqual(sink.sent.at(-1).content.delivery, 'import');
});

// Failure paths ----------------------------------------------------

test('a manifest that fails to resolve falls back to the default avatar', async () => {
	const validator = makeValidator();
	const importer	= makeImporter();
	const resolver	= makeResolver({ ok: false, reasons: ['manifest_signature_invalid'], receipt: null });
	const { svc, sink } = serviceWith({ validator, importer, manifestResolver: resolver });

	await svc.handleOffer({ policy_id: 7, have_avatar: true, manifest: { url: MANIFEST_URL } });

	// Nothing was fetched as an asset, and the client got a diagnosis.
	assert.deepStrictEqual(validator.seen, []);
	const msg = sink.sent.at(-1);
	assert.strictEqual(msg.content.status, 'using_default');
	assert.deepStrictEqual(msg.content.reasons, ['manifest_signature_invalid']);
	assert.deepStrictEqual(importer.calls, [['default']]);
});

test('a rejection receipt still reaches the client', async () => {
	const resolver = makeResolver({
		ok: false, reasons: ['manifest_expired'],
		receipt: { manifestId: 'urn:uuid:x', outcome: 'rejected', signatureCheck: 'valid', freshnessCheck: 'expired', facetStatuses: [], warnings: [] },
	});
	const { svc, sink } = serviceWith({ validator: makeValidator(), manifestResolver: resolver });

	await svc.handleOffer({ policy_id: 7, have_avatar: true, manifest: { url: MANIFEST_URL } });

	const manifest = sink.sent.at(-1).content.manifest;
	assert.strictEqual(manifest.outcome, 'rejected');
	assert.strictEqual(manifest.freshness_check, 'expired');
});

test('a resolver that throws is contained', async () => {
	const resolver = { async resolve() { throw new Error('boom'); } };
	const { svc, sink } = serviceWith({ validator: makeValidator(), importer: makeImporter(), manifestResolver: resolver });

	await svc.handleOffer({ policy_id: 7, have_avatar: true, manifest: { url: MANIFEST_URL } });

	assert.deepStrictEqual(sink.sent.at(-1).content.reasons, ['manifest_unresolvable']);
});

// Opt-in -----------------------------------------------------------

test('with no resolver wired, a manifest offer falls back to the default', async () => {
	// A deployment that has not opted in has not advertised manifest
	// support either, so this is a client offering something it was
	// never told the server would accept.
	const validator = makeValidator();
	const { svc, sink } = serviceWith({ validator, importer: makeImporter() });

	await svc.handleOffer({ policy_id: 7, have_avatar: true, manifest: { url: MANIFEST_URL } });

	assert.deepStrictEqual(validator.seen, []);
	assert.strictEqual(sink.sent.at(-1).content.status, 'using_default');
});

test('a direct url offer is untouched when a resolver is wired', async () => {
	const validator = makeValidator();
	const resolver	= makeResolver(okResult());
	const { svc } = serviceWith({ validator, importer: makeImporter(), manifestResolver: resolver });

	await svc.handleOffer({ policy_id: 7, have_avatar: true, url: 'https://direct.example/me.glb' });

	assert.strictEqual(resolver.calls.length, 0);
	assert.deepStrictEqual(validator.seen, ['https://direct.example/me.glb']);
});

test('when both url and manifest are present the manifest wins', async () => {
	const validator = makeValidator();
	const resolver	= makeResolver(okResult());
	const { svc } = serviceWith({ validator, importer: makeImporter(), manifestResolver: resolver });

	await svc.handleOffer({
		policy_id: 7, have_avatar: true,
		url: 'https://direct.example/me.glb',
		manifest: { url: MANIFEST_URL },
	});

	assert.strictEqual(resolver.calls.length, 1);
	assert.deepStrictEqual(validator.seen, [AVATAR_URL]);
});

// Host projection callback -----------------------------------------

test('projected facets reach the host callback', async () => {
	const projection = {
		subject: 'did:web:xr.example:users:beta',
		pointer: 'portableIdentity.avatar',
		facets: [{ name: 'teleport:playerLoadout', entity: { weapon: 'sword' } }],
		claims: [],
	};
	const seen = [];
	const { svc } = serviceWith({
		validator: makeValidator(),
		manifestResolver: makeResolver(okResult({ projection })),
		onManifestProjected: (clientID, p, receipt) => seen.push([clientID, p, receipt]),
	});

	await svc.handleOffer({ policy_id: 7, have_avatar: true, manifest: { url: MANIFEST_URL } });

	assert.strictEqual(seen.length, 1);
	assert.strictEqual(seen[0][0], 42n);
	assert.deepStrictEqual(seen[0][1].facets[0].entity, { weapon: 'sword' });
});

test('a throwing host callback cannot fail the avatar', async () => {
	const { svc, sink } = serviceWith({
		validator: makeValidator(),
		importer: makeImporter(),
		manifestResolver: makeResolver(okResult()),
		onManifestProjected: () => { throw new Error('host bug'); },
	});

	await svc.handleOffer({ policy_id: 7, have_avatar: true, manifest: { url: MANIFEST_URL } });

	assert.strictEqual(sink.sent.at(-1).content.status, 'accepted');
});

// Lifecycle --------------------------------------------------------

test('a receipt does not leak from one offer into the next', async () => {
	const resolver = makeResolver(okResult());
	const { svc, sink } = serviceWith({ validator: makeValidator(), importer: makeImporter(), manifestResolver: resolver });

	await svc.handleOffer({ policy_id: 7, have_avatar: true, manifest: { url: MANIFEST_URL } });
	assert.ok(sink.sent.at(-1).content.manifest);

	await svc.handleOffer({ policy_id: 7, have_avatar: false });
	assert.strictEqual(sink.sent.at(-1).content.manifest, undefined);
});

test('revoke clears the manifest receipt', async () => {
	const { svc } = serviceWith({ validator: makeValidator(), importer: makeImporter(), manifestResolver: makeResolver(okResult()) });
	await svc.handleOffer({ policy_id: 7, have_avatar: true, manifest: { url: MANIFEST_URL } });
	assert.ok(svc.lastManifestReceipt);
	svc.handleRevoke({ policy_id: 7 });
	assert.strictEqual(svc.lastManifestReceipt, null);
});

// Codecs -----------------------------------------------------------

test('the manifest address round-trips through the offer codec', () => {
	const encoded = avatars.encodeAvatarOffer({
		policy_id: 7n, have_avatar: true,
		manifest: { url: MANIFEST_URL, pointer: 'portableIdentity.avatar' },
	});
	assert.deepStrictEqual(encoded.manifest, { url: MANIFEST_URL, pointer: 'portableIdentity.avatar' });

	const parsed = avatars.parseAvatarOffer(encoded);
	assert.deepStrictEqual(parsed.manifest, { url: MANIFEST_URL, pointer: 'portableIdentity.avatar' });
});

test('a umid address round-trips through the offer codec', () => {
	const parsed = avatars.parseAvatarOffer({ policy_id: 1, have_avatar: true, manifest: { umid: 'abc123' } });
	assert.deepStrictEqual(parsed.manifest, { umid: 'abc123' });
});

test('a manifest address with neither url nor umid is dropped', () => {
	assert.strictEqual(avatars.parseAvatarOffer({ manifest: { pointer: 'x' } }).manifest, undefined);
	assert.strictEqual(avatars.parseAvatarOffer({ manifest: 'not-an-object' }).manifest, undefined);
	assert.strictEqual(avatars.parseAvatarOffer({ manifest: [] }).manifest, undefined);
});

test('an offer with no manifest emits no manifest member', () => {
	const encoded = avatars.encodeAvatarOffer({ policy_id: 1n, have_avatar: true, url: 'https://a.example/x.glb' });
	assert.ok(!('manifest' in encoded));
});

test('a result with no receipt emits no manifest member', () => {
	const encoded = avatars.encodeAvatarResult({ policy_id: 1n, status: 'accepted' });
	assert.ok(!('manifest' in encoded));
});

test('the receipt is normalised on the way out', () => {
	const encoded = avatars.encodeAvatarResult({
		policy_id: 1n, status: 'accepted',
		manifest: { manifest_id: 'x', outcome: 'accepted', signature_check: 'valid', freshness_check: 'fresh', facets: [{ name: 'a', status: 'processed' }, 'junk'] },
	});
	assert.deepStrictEqual(encoded.manifest.facets, [{ name: 'a', status: 'processed' }]);
});
