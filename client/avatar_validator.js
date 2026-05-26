'use strict';
// Phase 3 of the avatar implementation plan: server-side validation of
// avatar URLs supplied in avatar-offer. Goal is real download, real
// measurement, real rejection reasons. Bytes never leave this process
// — Phase 3 still has no peer visibility.
//
// IAvatarValidator is the pluggable interface; DefaultAvatarValidator is
// a node-only implementation that uses node:https for full control over
// the transport (so SSRF and byte/time limits can be enforced before any
// peer protocol code sees the bytes). Tests substitute a fake fetcher
// via the constructor so they don't have to hit the network.

const crypto	= require('node:crypto');
const dns		= require('node:dns');
const https		= require('node:https');
const http		= require('node:http');
const net		= require('node:net');
const { URL }	= require('node:url');

// SSRF blocklist ------------------------------------------------------
// Mirrors plans/avatars_plan.md §7 (SSRF row) and §5 V3. Refuses
// loopback, link-local, private, broadcast, metadata-service and the
// "this network" range. IPv6: refuses loopback, link-local, ULA, and
// IPv4-mapped addresses (which would re-enter the v4 blocklist).
function isBlockedIp(ip)
{
	if (typeof ip !== 'string' || !ip.length)
		return true;
	const family = net.isIP(ip);
	if (family === 4)
	{
		const o = ip.split('.').map(Number);
		if (o.length !== 4 || o.some(b => !Number.isFinite(b) || b < 0 || b > 255))
			return true;
		if (o[0] === 0)									return true; // "this" net
		if (o[0] === 10)								return true; // RFC1918
		if (o[0] === 127)								return true; // loopback
		if (o[0] === 169 && o[1] === 254)				return true; // link-local + AWS metadata
		if (o[0] === 172 && o[1] >= 16 && o[1] <= 31)	return true; // RFC1918
		if (o[0] === 192 && o[1] === 168)				return true; // RFC1918
		if (o[0] === 192 && o[1] === 0   && o[2] === 0)	return true; // IETF protocol
		if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return true; // benchmarking
		if (o[0] >= 224)								return true; // multicast + reserved
		return false;
	}
	if (family === 6)
	{
		const lo = ip.toLowerCase();
		if (lo === '::1' || lo === '::')				return true;
		if (lo.startsWith('fe80:') || lo.startsWith('fe80::')) return true; // link-local
		if (lo.startsWith('fc') || lo.startsWith('fd'))	return true; // ULA fc00::/7
		if (lo.startsWith('ff'))						return true; // multicast
		if (lo.startsWith('::ffff:'))					return true; // v4-mapped
		return false;
	}
	return true;
}

// Resolve a hostname to a single IP and check it against the blocklist.
// Returns the resolved address on success; throws with a code that maps
// to one of the avatar-result reason codes on failure.
function resolveAndCheck(hostname)
{
	return new Promise((resolve, reject) =>
	{
		// If the hostname is already a literal IP, validate directly.
		if (net.isIP(hostname))
		{
			if (isBlockedIp(hostname))
				return reject(Object.assign(new Error('ssrf_blocked'), { code: 'ssrf_blocked' }));
			return resolve(hostname);
		}
		dns.lookup(hostname, { verbatim: true }, (err, address) =>
		{
			if (err)
				return reject(Object.assign(new Error('dns_failed'), { code: 'download_failed' }));
			if (isBlockedIp(address))
				return reject(Object.assign(new Error('ssrf_blocked'), { code: 'ssrf_blocked' }));
			resolve(address);
		});
	});
}

// Default fetcher --------------------------------------------------
// Streams the response body, hashing as it goes and aborting the
// connection as soon as `maxBytes` would be exceeded so that a hostile
// origin cannot trickle gigabytes. Honours `maxRedirects` and re-runs
// the SSRF check at every hop. Returns { ok, status, body, sha256,
// finalUrl, reason } where `body` is a Buffer trimmed to maxBytes.
function defaultFetcher(opts)
{
	const { url, maxBytes, timeoutMs, maxRedirects, allowedSchemes } = opts;
	// Tests can inject a permissive resolver so the loopback-bound
	// scratch server they spin up isn't rejected by the SSRF guard.
	const resolver = opts.resolver || resolveAndCheck;
	return new Promise((resolve) =>
	{
		const visited = new Set();
		const start = Date.now();

		const attempt = (currentUrl, hopsLeft) =>
		{
			let u;
			try { u = new URL(currentUrl); }
			catch (e) { return resolve({ ok: false, reason: 'invalid_url' }); }

			if (!allowedSchemes.includes(u.protocol))
				return resolve({ ok: false, reason: 'scheme_not_allowed' });
			if (visited.has(u.href))
				return resolve({ ok: false, reason: 'redirect_loop' });
			visited.add(u.href);

			resolver(u.hostname).then((ip) =>
			{
				const lib = u.protocol === 'http:' ? http : https;
				const port = u.port ? Number(u.port) : (u.protocol === 'http:' ? 80 : 443);
				const remaining = Math.max(1, timeoutMs - (Date.now() - start));
				const req = lib.request({
					host:		ip,
					port:		port,
					path:		u.pathname + u.search,
					method:		'GET',
					servername:	u.hostname,	// SNI/SAN check still uses real host
					headers:	{ host: u.hostname, 'user-agent': 'teleportxr-avatar-validator/1' },
					timeout:	remaining,
				}, (res) =>
				{
					// Follow redirects with the same SSRF check at every hop.
					if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
					{
						res.resume();
						if (hopsLeft <= 0)
							return resolve({ ok: false, reason: 'too_many_redirects' });
						const next = new URL(res.headers.location, u).href;
						return attempt(next, hopsLeft - 1);
					}
					if (res.statusCode !== 200)
					{
						res.resume();
						return resolve({ ok: false, reason: 'http_' + res.statusCode });
					}
					const hash = crypto.createHash('sha256');
					const chunks = [];
					let total = 0;
					let aborted = false;
					res.on('data', (chunk) =>
					{
						if (aborted) return;
						total += chunk.length;
						if (total > maxBytes)
						{
							aborted = true;
							req.destroy();
							return resolve({ ok: false, reason: 'file_too_large' });
						}
						hash.update(chunk);
						chunks.push(chunk);
					});
					res.on('end', () =>
					{
						if (aborted) return;
						resolve({
							ok:			true,
							status:		200,
							body:		Buffer.concat(chunks, total),
							sha256:		hash.digest('hex'),
							finalUrl:	u.href,
						});
					});
					res.on('error', () =>
					{
						if (!aborted) resolve({ ok: false, reason: 'download_failed' });
					});
				});
				req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'fetch_timeout' }); });
				req.on('error', () => resolve({ ok: false, reason: 'download_failed' }));
				req.end();
			}).catch((err) =>
			{
				resolve({ ok: false, reason: err.code || 'download_failed' });
			});
		};

		attempt(url, maxRedirects);
	});
}

// LRU cache --------------------------------------------------------
// Bounded by both entry count and total bytes. Maps content_hash → a
// frozen validation result so two clients submitting the same URL do
// not cause two fetches (plan §5 V5, §9). Map preserves insertion order
// so we can evict the oldest by simply re-inserting on access.
class LruCache
{
	constructor(maxEntries, maxBytes)
	{
		this.maxEntries	= Math.max(1, maxEntries | 0);
		this.maxBytes	= Math.max(0, maxBytes | 0);
		this.map		= new Map();
		this.bytes		= 0;
	}
	get(key)
	{
		if (!this.map.has(key)) return undefined;
		const v = this.map.get(key);
		this.map.delete(key); this.map.set(key, v);
		return v;
	}
	set(key, value, bytes)
	{
		if (this.map.has(key))
		{
			this.bytes -= this.map.get(key)._bytes || 0;
			this.map.delete(key);
		}
		const stored = Object.assign({}, value, { _bytes: bytes });
		this.map.set(key, stored);
		this.bytes += bytes;
		while (this.map.size > this.maxEntries || this.bytes > this.maxBytes)
		{
			const first = this.map.keys().next().value;
			if (first === undefined) break;
			this.bytes -= this.map.get(first)._bytes || 0;
			this.map.delete(first);
		}
	}
	get size() { return this.map.size; }
}

// Sniff the leading bytes to confirm the declared format. Phase 3
// supports GLB (binary glTF) by magic + glTF (JSON) by leading brace.
// Anything else is passed through as ok=true; the host-supplied
// validator can do stricter checking. Returns the canonical short name.
function sniffFormat(buf)
{
	if (!buf || buf.length < 4) return '';
	if (buf[0] === 0x67 && buf[1] === 0x6C && buf[2] === 0x54 && buf[3] === 0x46)
		return 'glb';
	// Skip BOM, whitespace.
	let i = 0;
	if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) i = 3;
	while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0A || buf[i] === 0x0D)) i++;
	if (i < buf.length && buf[i] === 0x7B) return 'gltf';
	return '';
}

// IAvatarValidator -------------------------------------------------
// Reference interface; subclass and override `validate`. The default
// implementation below is sufficient for the Phase 3 exit criteria;
// host applications that want a stricter pipeline (e.g. real glTF
// parse, triangle count, proof check) supply their own.
class IAvatarValidator
{
	async validate(/* offer, requirements */)
	{
		throw new Error('IAvatarValidator.validate is abstract');
	}
}

class DefaultAvatarValidator extends IAvatarValidator
{
	constructor(opts = {})
	{
		super();
		this.allowedSchemes		= opts.allowedSchemes		|| ['https:'];
		this.maxRedirects		= opts.maxRedirects ?? 3;
		this.defaultMaxBytes	= opts.defaultMaxBytes		|| 10 * 1024 * 1024;
		this.defaultTimeoutMs	= opts.defaultTimeoutMs		|| 15000;
		this.fetcher			= opts.fetcher				|| defaultFetcher;
		this.cache				= opts.cache				|| new LruCache(opts.cacheEntries || 256, opts.cacheBytes || 256 * 1024 * 1024);
	}

	async validate(offer, requirements)
	{
		const reasons	= [];
		const req		= requirements || {};
		const formats	= Array.isArray(req.formats) ? req.formats.map(s => String(s).toLowerCase()) : [];
		const maxBytes	= Number.isFinite(req.max_file_bytes) ? Math.min(req.max_file_bytes, this.defaultMaxBytes) : this.defaultMaxBytes;
		const timeoutMs	= Number.isFinite(req.fetch_timeout_ms) ? req.fetch_timeout_ms : this.defaultTimeoutMs;

		// Cheap pre-flight checks before spending a TCP connection.
		if (!offer || !offer.url || typeof offer.url !== 'string')
			return { ok: false, reasons: ['no_url'], bytes: 0, contentHash: '', format: '' };
		const declared = offer.declared || {};
		if (formats.length && declared.format && !formats.includes(String(declared.format).toLowerCase()))
			return { ok: false, reasons: ['format_not_allowed'], bytes: 0, contentHash: '', format: declared.format };
		if (declared.file_bytes && declared.file_bytes > maxBytes)
			return { ok: false, reasons: ['file_too_large'], bytes: declared.file_bytes, contentHash: '', format: declared.format || '' };

		// Cache hit on declared content_hash short-circuits the fetch.
		if (offer.content_hash && this.cache.get(offer.content_hash))
		{
			const cached = this.cache.get(offer.content_hash);
			return { ok: cached.ok, reasons: cached.reasons.slice(), bytes: cached.bytes, contentHash: offer.content_hash, format: cached.format, fromCache: true };
		}

		const fetched = await this.fetcher({
			url:				offer.url,
			maxBytes:			maxBytes,
			timeoutMs:			timeoutMs,
			maxRedirects:		this.maxRedirects,
			allowedSchemes:		this.allowedSchemes,
		});
		if (!fetched.ok)
			return { ok: false, reasons: [fetched.reason || 'download_failed'], bytes: 0, contentHash: '', format: '' };

		const bytes			= fetched.body.length;
		const contentHash	= 'sha256:' + fetched.sha256;
		const sniffed		= sniffFormat(fetched.body);
		const format		= sniffed || (declared.format || '').toLowerCase();

		if (offer.content_hash && offer.content_hash !== contentHash)
			reasons.push('hash_mismatch');
		if (formats.length && format && !formats.includes(format))
			reasons.push('format_not_allowed');
		if (bytes > maxBytes)
			reasons.push('file_too_large');

		const ok = reasons.length === 0;
		const result = { ok, reasons: reasons.slice(), bytes, contentHash, format };
		this.cache.set(contentHash, result, bytes);
		return result;
	}
}

module.exports.isBlockedIp				= isBlockedIp;
module.exports.resolveAndCheck			= resolveAndCheck;
module.exports.defaultFetcher			= defaultFetcher;
module.exports.LruCache					= LruCache;
module.exports.sniffFormat				= sniffFormat;
module.exports.IAvatarValidator			= IAvatarValidator;
module.exports.DefaultAvatarValidator	= DefaultAvatarValidator;
