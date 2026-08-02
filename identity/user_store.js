'use strict';
// Per-user state that outlives a connection.
//
// Everything else in this library is keyed by `clientID`, which is a session
// handle: it comes from core.generateUid(), restarts at 1 with the process,
// and is discarded when the socket closes. A UserStore is keyed by the
// canonical identity key instead (see protocol/identity.js), so a server can
// recognise someone it has met before and reuse what it learned.
//
// Methods may return a value or a promise; callers await either way, so an
// in-memory store stays synchronous while a database-backed one does not have
// to pretend to be.
//
// What is deliberately NOT stored:
//
//   * the avatar URL. An avatar URL may carry a bearer token (utils/redact.js),
//     and the client re-supplies it on every offer, so keeping it would create
//     a disclosure risk in exchange for nothing.
//   * the user's email address. The client never sends it
//     (identity_plan.md principle 5) and the server has no use for it.

const DEFAULT_MAX_USERS = 10000;

// One user's remembered state. Plain data so any backing store can serialise
// it without knowing about this class.
function newRecord(key, tier) {
	const now = Date.now();
	return {
		key,
		tier,
		provider:    '',
		displayName: '',
		firstSeen:   now,
		lastSeen:    now,
		visits:      0,
		// Result of the last successful avatar validation, so a returning
		// user offering the same avatar does not have to be re-fetched and
		// re-measured. Keyed by content hash, which is what the server itself
		// computed from the bytes.
		avatar:      null,   // { contentHash, validated }
	};
}

// The interface a host application implements to persist users elsewhere.
// Subclass or duck-type; the library only ever calls these three methods.
class UserStore {
	// Return the stored record for `key`, or null.
	get(key) {           // eslint-disable-line no-unused-vars
		throw new Error('UserStore.get not implemented');
	}
	// Create or update the record for `key`. `patch` is shallow-merged over
	// the existing record. Returns the resulting record.
	upsert(key, patch) { // eslint-disable-line no-unused-vars
		throw new Error('UserStore.upsert not implemented');
	}
	// Number of users held, for reporting. Optional.
	size() {
		return 0;
	}
}

// Default store: an in-process Map, matching every other store in this
// library. "Returning user" therefore means "since the server started".
// Swap in your own implementation for anything longer-lived.
class MemoryUserStore extends UserStore {
	constructor(opts = {}) {
		super();
		this.users = new Map();
		// A store keyed by client-supplied strings is unbounded by nature, so
		// it is capped. Eviction is least-recently-seen.
		this.maxUsers = opts.maxUsers || DEFAULT_MAX_USERS;
	}

	get(key) {
		if (!key)
			return null;
		return this.users.get(key) || null;
	}

	upsert(key, patch) {
		if (!key)
			return null;
		let record = this.users.get(key);
		if (!record) {
			record = newRecord(key, (patch && patch.tier) || 'asserted');
			this._evictIfFull();
		}
		Object.assign(record, patch || {}, { key, lastSeen: Date.now() });
		this.users.set(key, record);
		return record;
	}

	size() {
		return this.users.size;
	}

	_evictIfFull() {
		if (this.users.size < this.maxUsers)
			return;
		let oldestKey  = null;
		let oldestSeen = Infinity;
		for (const [k, r] of this.users) {
			if (r.lastSeen < oldestSeen) {
				oldestSeen = r.lastSeen;
				oldestKey  = k;
			}
		}
		if (oldestKey !== null)
			this.users.delete(oldestKey);
	}
}

module.exports = { UserStore, MemoryUserStore, newRecord, DEFAULT_MAX_USERS };
