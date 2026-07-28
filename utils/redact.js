'use strict';
// Redaction helpers for avatar URLs and proofs (plans/avatars_plan.md §8,
// plans/avatars_implementation.md §10.1). An avatar URL may carry a bearer
// token or user identifier and a proof may encode user attributes, so any
// log line mentioning either must pass through these helpers. Mirrored by
// TeleportCore/Redact.h (C++) and teleport-web-client/src/log/redact.ts.

const { URL } = require('node:url');

// Reduce a URL to scheme + host: "https://host.example/...". Anything
// unparseable is replaced wholesale so a malformed URL can never leak.
function redactUrl(u)
{
	if (typeof u !== 'string' || !u.length)
		return '<no-url>';
	try
	{
		const parsed = new URL(u);
		return parsed.protocol + '//' + parsed.host + '/...';
	}
	catch (e)
	{
		// Server-relative paths ('/avatars/abc.glb') are not absolute URLs
		// but name our own resources, so they are safe — and useful — to
		// log. Any query or fragment is still stripped in case it carries
		// a credential. '//host/path' is protocol-relative, i.e. a host,
		// so it is not treated as a path.
		if (u.startsWith('/') && !u.startsWith('//'))
			return u.replace(/[?#].*$/, '');
		return '<invalid-url>';
	}
}

// Describe a proof without echoing its value. Accepts either the wire
// object ({ scheme, value }) or a bare string.
function redactProof(p)
{
	if (p == null)
		return '<no-proof>';
	if (typeof p === 'string')
		return '<proof ' + p.length + ' bytes>';
	const scheme = typeof p.scheme === 'string' && p.scheme.length ? p.scheme : 'proof';
	const length = typeof p.value === 'string' ? p.value.length : 0;
	return '<' + scheme + ' ' + length + ' bytes>';
}

module.exports = { redactUrl, redactProof };
