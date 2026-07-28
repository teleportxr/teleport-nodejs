'use strict';
// Tests for the Phase-3 avatar validator. The SSRF blocklist and LRU
// cache are exercised directly; the DefaultAvatarValidator is driven
// with an injected fake fetcher so the network is never touched. This
// matches the rest of teleport-nodejs/test/, which uses node:test
// rather than Jest.

const test		= require('node:test');
const assert	= require('node:assert');

const validator = require('../client/avatar_validator.js');
const fx		= require('./helpers/gltf_fixtures.js');

// SSRF blocklist ---------------------------------------------------

test('isBlockedIp: refuses loopback and private v4 ranges', () => {
	assert.strictEqual(validator.isBlockedIp('127.0.0.1'), true);
	assert.strictEqual(validator.isBlockedIp('10.1.2.3'), true);
	assert.strictEqual(validator.isBlockedIp('172.16.0.1'), true);
	assert.strictEqual(validator.isBlockedIp('172.31.255.255'), true);
	assert.strictEqual(validator.isBlockedIp('192.168.0.1'), true);
	assert.strictEqual(validator.isBlockedIp('169.254.169.254'), true);
	assert.strictEqual(validator.isBlockedIp('0.0.0.0'), true);
	assert.strictEqual(validator.isBlockedIp('224.0.0.1'), true);
});

test('isBlockedIp: allows public v4 addresses', () => {
	assert.strictEqual(validator.isBlockedIp('8.8.8.8'), false);
	assert.strictEqual(validator.isBlockedIp('1.1.1.1'), false);
	assert.strictEqual(validator.isBlockedIp('172.15.0.1'), false);
	assert.strictEqual(validator.isBlockedIp('172.32.0.1'), false);
});

test('isBlockedIp: refuses loopback, link-local and ULA v6', () => {
	assert.strictEqual(validator.isBlockedIp('::1'), true);
	assert.strictEqual(validator.isBlockedIp('fe80::1'), true);
	assert.strictEqual(validator.isBlockedIp('fd00::1'), true);
	assert.strictEqual(validator.isBlockedIp('ff02::1'), true);
	assert.strictEqual(validator.isBlockedIp('::ffff:127.0.0.1'), true);
});

test('isBlockedIp: rejects garbage', () => {
	assert.strictEqual(validator.isBlockedIp(''), true);
	assert.strictEqual(validator.isBlockedIp('not-an-ip'), true);
	assert.strictEqual(validator.isBlockedIp(null), true);
});

// LRU cache --------------------------------------------------------

test('LruCache evicts the oldest entry beyond maxEntries', () => {
	const c = new validator.LruCache(2, 1 << 20);
	c.set('a', { ok: true }, 1);
	c.set('b', { ok: true }, 1);
	c.set('c', { ok: true }, 1);
	assert.strictEqual(c.size, 2);
	assert.strictEqual(c.get('a'), undefined);
	assert.ok(c.get('b'));
	assert.ok(c.get('c'));
});

test('LruCache evicts to honour maxBytes', () => {
	const c = new validator.LruCache(100, 10);
	c.set('a', { ok: true }, 8);
	c.set('b', { ok: true }, 5);
	assert.strictEqual(c.get('a'), undefined);
	assert.ok(c.get('b'));
});

test('LruCache get() refreshes recency', () => {
	const c = new validator.LruCache(2, 1 << 20);
	c.set('a', { ok: true }, 1);
	c.set('b', { ok: true }, 1);
	c.get('a');								// promote 'a'
	c.set('c', { ok: true }, 1);			// evicts 'b', not 'a'
	assert.ok(c.get('a'));
	assert.strictEqual(c.get('b'), undefined);
});

// sniffFormat ------------------------------------------------------

test('sniffFormat recognises GLB magic', () => {
	const glb = Buffer.from([0x67, 0x6C, 0x54, 0x46, 0x02, 0, 0, 0]);
	assert.strictEqual(validator.sniffFormat(glb), 'glb');
});

test('sniffFormat recognises JSON glTF', () => {
	assert.strictEqual(validator.sniffFormat(Buffer.from('  {\n"asset":{}}')), 'gltf');
	assert.strictEqual(validator.sniffFormat(Buffer.from('\uFEFF{"a":1}')), 'gltf');
});

test('sniffFormat returns empty for unknown payloads', () => {
	assert.strictEqual(validator.sniffFormat(Buffer.from('NOPE')), '');
	assert.strictEqual(validator.sniffFormat(Buffer.alloc(0)), '');
});

// DefaultAvatarValidator with an injected fetcher ----------------
// The fetcher contract is just `({ url, maxBytes, ... }) → { ok, body,
// sha256, ... }`. By injecting one we keep the tests offline and
// deterministic.
function makeBody(bufOrText) {
	const crypto = require('node:crypto');
	const body = Buffer.isBuffer(bufOrText) ? bufOrText : Buffer.from(bufOrText);
	const sha256 = crypto.createHash('sha256').update(body).digest('hex');
	return { body, sha256 };
}
function fakeFetcher(map) {
	return async (opts) => {
		const next = map[opts.url];
		if (typeof next === 'function') return next(opts);
		if (!next) return { ok: false, reason: 'download_failed' };
		return next;
	};
}

test('DefaultAvatarValidator: happy path returns ok with the computed hash', async () => {
	const { body, sha256 } = makeBody(fx.buildGlb(fx.minimalGltf(), null));
	const v = new validator.DefaultAvatarValidator({
		fetcher: fakeFetcher({
			'https://x/avatar.glb': { ok: true, body, sha256, finalUrl: 'https://x/avatar.glb' },
		}),
	});
	const r = await v.validate(
		{ url: 'https://x/avatar.glb', declared: { format: 'glb' } },
		{ formats: ['glb'], max_file_bytes: 1 << 20 });
	assert.strictEqual(r.ok, true);
	assert.strictEqual(r.format, 'glb');
	assert.strictEqual(r.contentHash, 'sha256:' + sha256);
	assert.deepStrictEqual(r.reasons, []);
});

test('DefaultAvatarValidator: rejects declared format outside allow-list before fetching', async () => {
	let fetched = false;
	const v = new validator.DefaultAvatarValidator({
		fetcher: async () => { fetched = true; return { ok: true, body: Buffer.alloc(0), sha256: '' }; },
	});
	const r = await v.validate(
		{ url: 'https://x/a.fbx', declared: { format: 'fbx' } },
		{ formats: ['glb', 'vrm'] });
	assert.strictEqual(r.ok, false);
	assert.deepStrictEqual(r.reasons, ['format_not_allowed']);
	assert.strictEqual(fetched, false);
});

test('DefaultAvatarValidator: rejects oversized declared file before fetching', async () => {
	let fetched = false;
	const v = new validator.DefaultAvatarValidator({
		fetcher: async () => { fetched = true; return { ok: true, body: Buffer.alloc(0), sha256: '' }; },
	});
	const r = await v.validate(
		{ url: 'https://x/a.glb', declared: { format: 'glb', file_bytes: 1_000_000 } },
		{ formats: ['glb'], max_file_bytes: 100 });
	assert.strictEqual(r.ok, false);
	assert.deepStrictEqual(r.reasons, ['file_too_large']);
	assert.strictEqual(fetched, false);
});

test('DefaultAvatarValidator: surfaces a content_hash mismatch', async () => {
	const { body, sha256 } = makeBody(fx.buildGlb(fx.minimalGltf(), null));
	const v = new validator.DefaultAvatarValidator({
		fetcher: fakeFetcher({ 'https://x/a.glb': { ok: true, body, sha256 } }),
	});
	const r = await v.validate(
		{ url: 'https://x/a.glb', declared: { format: 'glb' }, content_hash: 'sha256:deadbeef' },
		{ formats: ['glb'] });
	assert.strictEqual(r.ok, false);
	assert.ok(r.reasons.includes('hash_mismatch'));
	// Hash on the result is the actual computed hash, not the claimed one.
	assert.strictEqual(r.contentHash, 'sha256:' + sha256);
});

test('DefaultAvatarValidator: maps fetcher failure reasons through', async () => {
	const v = new validator.DefaultAvatarValidator({
		fetcher: fakeFetcher({ 'https://x/a.glb': { ok: false, reason: 'ssrf_blocked' } }),
	});
	const r = await v.validate({ url: 'https://x/a.glb', declared: { format: 'glb' } }, { formats: ['glb'] });
	assert.strictEqual(r.ok, false);
	assert.deepStrictEqual(r.reasons, ['ssrf_blocked']);
});

test('DefaultAvatarValidator: cache hit on content_hash skips the fetcher', async () => {
	const { body, sha256 } = makeBody(fx.buildGlb(fx.minimalGltf(), null));
	let fetches = 0;
	const v = new validator.DefaultAvatarValidator({
		fetcher: async () => { fetches++; return { ok: true, body, sha256 }; },
	});
	const offer = { url: 'https://x/c.glb', declared: { format: 'glb' } };
	const first = await v.validate(offer, { formats: ['glb'] });
	assert.strictEqual(first.ok, true);
	assert.strictEqual(fetches, 1);
	const second = await v.validate(
		{ url: 'https://x/c.glb', declared: { format: 'glb' }, content_hash: first.contentHash },
		{ formats: ['glb'] });
	assert.strictEqual(second.ok, true);
	assert.strictEqual(second.fromCache, true);
	assert.strictEqual(fetches, 1);
	// Measurements survive the cache round-trip.
	assert.ok(second.measurements);
	assert.strictEqual(second.measurements.triangles, 12);
});

// Measurement enforcement (Phase 3 gap closure) --------------------

test('DefaultAvatarValidator: a VRM is rejected under a glb-only policy and accepted under vrm', async () => {
	const { body, sha256 } = makeBody(fx.buildGlb(fx.asVrm0(fx.minimalGltf()), null));
	const v = new validator.DefaultAvatarValidator({
		fetcher: fakeFetcher({ 'https://x/a.vrm': { ok: true, body, sha256 } }),
	});
	const rejected = await v.validate({ url: 'https://x/a.vrm' }, { formats: ['glb'] });
	assert.strictEqual(rejected.ok, false);
	assert.strictEqual(rejected.format, 'vrm');
	assert.deepStrictEqual(rejected.reasons, ['format_not_allowed']);

	const v2 = new validator.DefaultAvatarValidator({
		fetcher: fakeFetcher({ 'https://x/a.vrm': { ok: true, body, sha256 } }),
	});
	const accepted = await v2.validate({ url: 'https://x/a.vrm' }, { formats: ['vrm'] });
	assert.strictEqual(accepted.ok, true);
	assert.strictEqual(accepted.format, 'vrm');
});

test('DefaultAvatarValidator: enforces the triangle cap from the fetched bytes', async () => {
	const { body, sha256 } = makeBody(fx.buildGlb(fx.minimalGltf(), null));	// 12 triangles
	const v = new validator.DefaultAvatarValidator({
		fetcher: fakeFetcher({ 'https://x/a.glb': { ok: true, body, sha256 } }),
	});
	const r = await v.validate({ url: 'https://x/a.glb' }, { formats: ['glb'], max_triangles: 10 });
	assert.strictEqual(r.ok, false);
	assert.deepStrictEqual(r.reasons, ['too_many_triangles']);
	assert.strictEqual(r.measurements.triangles, 12);
});

test('DefaultAvatarValidator: reports all failing constraints together (V6)', async () => {
	const { body, sha256 } = makeBody(fx.buildGlb(fx.minimalGltf(), null));
	const v = new validator.DefaultAvatarValidator({
		fetcher: fakeFetcher({ 'https://x/a.glb': { ok: true, body, sha256 } }),
	});
	const r = await v.validate(
		{ url: 'https://x/a.glb', content_hash: 'sha256:deadbeef' },
		{ formats: ['glb'], max_triangles: 1, max_height_m: 0.5 });
	assert.strictEqual(r.ok, false);
	assert.deepStrictEqual(r.reasons.sort(), ['hash_mismatch', 'too_many_triangles', 'too_tall'].sort());
});

test('DefaultAvatarValidator: unparseable body fails when the policy needs a parse', async () => {
	const { body, sha256 } = makeBody('this is not a gltf');
	const v = new validator.DefaultAvatarValidator({
		fetcher: fakeFetcher({ 'https://x/a.bin': { ok: true, body, sha256 } }),
	});
	const r = await v.validate({ url: 'https://x/a.bin' }, { formats: ['glb'] });
	assert.strictEqual(r.ok, false);
	assert.ok(r.reasons.includes('malformed_asset'));
});

test('DefaultAvatarValidator: unparseable body passes through with an empty requirements bag', async () => {
	const { body, sha256 } = makeBody('opaque host-validated bytes');
	const v = new validator.DefaultAvatarValidator({
		fetcher: fakeFetcher({ 'https://x/a.bin': { ok: true, body, sha256 } }),
	});
	const r = await v.validate({ url: 'https://x/a.bin' }, {});
	assert.strictEqual(r.ok, true);
	assert.deepStrictEqual(r.reasons, []);
});

test('DefaultAvatarValidator: external references in the asset are refused', async () => {
	const json = fx.minimalGltf({ buffers: [{ uri: 'https://elsewhere.example/x.bin', byteLength: 4 }] });
	const { body, sha256 } = makeBody(fx.buildGlb(json, null));
	const v = new validator.DefaultAvatarValidator({
		fetcher: fakeFetcher({ 'https://x/a.glb': { ok: true, body, sha256 } }),
	});
	const r = await v.validate({ url: 'https://x/a.glb' }, { formats: ['glb'] });
	assert.strictEqual(r.ok, false);
	assert.deepStrictEqual(r.reasons, ['external_reference']);
});


// defaultFetcher against a local http server -----------------------
// Exercises the real transport path (node:http with the byte cap,
// timeout and redirect follower) by binding a server to 127.0.0.1.
// The defaultFetcher's SSRF guard is bypassed for these tests via the
// `resolver` injection point — see the dedicated SSRF guard test below
// for the real-blocklist path.

const http = require('node:http');

function withServer(handler, fn) {
	return new Promise((resolve, reject) => {
		const srv = http.createServer(handler);
		srv.listen(0, '127.0.0.1', async () => {
			const port = srv.address().port;
			try {
				const out = await fn(port);
				srv.close(() => resolve(out));
			} catch (err) {
				srv.close(() => reject(err));
			}
		});
	});
}

// Permissive resolver used for the loopback tests: returns whatever it
// was asked for without consulting DNS or the blocklist.
const permissiveResolver = (host) => Promise.resolve(host);

test('fetcher: happy-path GET returns body + sha256', async () => {
	const body = Buffer.from([0x67, 0x6C, 0x54, 0x46, 1, 2, 3, 4, 5, 6, 7, 8]);
	await withServer((req, res) => { res.writeHead(200, { 'content-type': 'model/gltf-binary' }); res.end(body); }, async (port) => {
		const r = await validator.defaultFetcher({
			url: 'http://127.0.0.1:' + port + '/a.glb', maxBytes: 1 << 16,
			timeoutMs: 5000, maxRedirects: 0, allowedSchemes: ['http:'],
			resolver: permissiveResolver,
		});
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.body.length, body.length);
		assert.strictEqual(r.sha256, require('node:crypto').createHash('sha256').update(body).digest('hex'));
	});
});

test('fetcher: aborts mid-stream when body exceeds maxBytes', async () => {
	await withServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/octet-stream' });
		let n = 0;
		const iv = setInterval(() => {
			n++;
			res.write(Buffer.alloc(1024, 0xAB));
			if (n > 200) { clearInterval(iv); res.end(); }
		}, 1);
	}, async (port) => {
		const r = await validator.defaultFetcher({
			url: 'http://127.0.0.1:' + port + '/big', maxBytes: 4096,
			timeoutMs: 5000, maxRedirects: 0, allowedSchemes: ['http:'],
			resolver: permissiveResolver,
		});
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.reason, 'file_too_large');
	});
});

test('fetcher: surfaces an HTTP timeout', async () => {
	await withServer((req, res) => { /* never respond */ }, async (port) => {
		const r = await validator.defaultFetcher({
			url: 'http://127.0.0.1:' + port + '/hang', maxBytes: 1 << 16,
			timeoutMs: 100, maxRedirects: 0, allowedSchemes: ['http:'],
			resolver: permissiveResolver,
		});
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.reason, 'fetch_timeout');
	});
});

test('fetcher: follows a redirect up to maxRedirects', async () => {
	const body = Buffer.from([0x67, 0x6C, 0x54, 0x46, 0, 0, 0, 0]);
	await withServer((req, res) => {
		if (req.url === '/start') { res.writeHead(302, { location: '/final' }); res.end(); return; }
		if (req.url === '/final') { res.writeHead(200); res.end(body); return; }
		res.writeHead(404); res.end();
	}, async (port) => {
		const r = await validator.defaultFetcher({
			url: 'http://127.0.0.1:' + port + '/start', maxBytes: 1 << 16,
			timeoutMs: 5000, maxRedirects: 2, allowedSchemes: ['http:'],
			resolver: permissiveResolver,
		});
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.body.length, body.length);
	});
});

test('fetcher: refuses a redirect to loopback (SSRF guard runs per hop)', async () => {
	// The first hop is on a stubbed public host (192.0.2.1, TEST-NET-1)
	// served by our loopback http server; it 302s to 127.0.0.1, which
	// the real resolveAndCheck guard must refuse.
	await withServer((req, res) => {
		res.writeHead(302, { location: 'http://127.0.0.1:1/never' }); res.end();
	}, async (port) => {
		const stubbedResolver = (host) => host === '127.0.0.1'
			? validator.resolveAndCheck(host)	// real check, will reject
			: Promise.resolve('127.0.0.1');	// pretend the first hop resolves to loopback
		const r = await validator.defaultFetcher({
			url: 'http://example.invalid:' + port + '/start', maxBytes: 1 << 16,
			timeoutMs: 5000, maxRedirects: 3, allowedSchemes: ['http:'],
			resolver: stubbedResolver,
		});
		assert.strictEqual(r.ok, false);
		assert.strictEqual(r.reason, 'ssrf_blocked');
	});
});

test('fetcher: defaultFetcher refuses an http://127.0.0.1 URL (SSRF guard)', async () => {
	// Production resolveAndCheck runs; isBlockedIp must reject loopback.
	const r = await validator.defaultFetcher({
		url: 'http://127.0.0.1:1/anything', maxBytes: 1024,
		timeoutMs: 1000, maxRedirects: 0, allowedSchemes: ['http:'],
	});
	assert.strictEqual(r.ok, false);
	assert.strictEqual(r.reason, 'ssrf_blocked');
});

test('fetcher: refuses a non-allow-listed scheme', async () => {
	const r = await validator.defaultFetcher({
		url: 'file:///etc/passwd', maxBytes: 1024,
		timeoutMs: 1000, maxRedirects: 0, allowedSchemes: ['https:'],
	});
	assert.strictEqual(r.ok, false);
	assert.strictEqual(r.reason, 'scheme_not_allowed');
});

