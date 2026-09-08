/**
 * FAMINE V2 — CACHE STORE
 *
 * A deliberately small key/value store with TTLs, used to stop repeated
 * summons of the same ticker from re-spending Alpha Vantage's very limited
 * free quota (25 requests/day, two per Famine analysis).
 *
 * ---------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------
 * MemoryCacheStore is process-local. On a serverless platform that means:
 *
 *   - it survives across invocations on a WARM instance
 *   - it is LOST on a cold start
 *   - it is NOT shared between concurrent instances
 *
 * That is a real limitation, not an oversight. It was chosen over Redis
 * because it needs no account, no environment variable, no npm dependency
 * and no deployment change, and because the waste it targets — several
 * summons of one ticker within a few minutes — happens precisely while an
 * instance is warm. If hit rates prove insufficient in beta, only the
 * store implementation changes; nothing downstream of this interface does.
 *
 * The clock is injectable so behaviour is deterministic and tests never
 * wait on real time.
 */

/**
 * Recursively freezes a value and everything reachable from it.
 *
 * WHY THIS IS HERE: the normalised schemas freeze their own top level,
 * `facts`, `source` and period objects, but pass-through vendor metadata
 * (`source.providerMeta`) is stored by reference and was NOT frozen. A
 * caller could therefore mutate `snapshot.source.providerMeta.exchange`
 * and silently corrupt what every later reader of that cache entry saw —
 * demonstrated before this was added.
 *
 * Freezing happens in the CACHE rather than in the schema so that no
 * existing approved file has to change, and so the guarantee holds for
 * ANY payload a future provider stores here, not just today's shapes.
 *
 * Cycles are handled via a seen-set; frozen objects are skipped, so
 * re-freezing an already-frozen payload is cheap.
 */
export function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    // Skip getters: reading them could execute code or throw.
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

export const CacheState = Object.freeze({
  MISS: "MISS",           // nothing usable was stored
  FRESH: "FRESH",         // stored and within its TTL
  EXPIRED: "EXPIRED",     // stored but past its TTL
  MALFORMED: "MALFORMED", // stored value is not a usable entry
});

/**
 * Abstract contract. Implementations must be safe to call concurrently and
 * must never throw for an ordinary miss.
 */
export class CacheStore {
  // eslint-disable-next-line no-unused-vars
  get(key) { throw new Error("get() must be implemented by a cache store"); }
  // eslint-disable-next-line no-unused-vars
  set(key, value, ttlMs) { throw new Error("set() must be implemented by a cache store"); }
  // eslint-disable-next-line no-unused-vars
  delete(key) { throw new Error("delete() must be implemented by a cache store"); }
  clear() { throw new Error("clear() must be implemented by a cache store"); }
}

function isUsableEntry(entry) {
  return !!entry
    && typeof entry === "object"
    && "value" in entry
    && typeof entry.storedAt === "number" && Number.isFinite(entry.storedAt)
    && typeof entry.expiresAt === "number" && Number.isFinite(entry.expiresAt)
    && entry.value !== null && entry.value !== undefined;
}

export class MemoryCacheStore extends CacheStore {
  /** @param {() => number} clock injectable millisecond clock */
  constructor({ clock = () => Date.now() } = {}) {
    super();
    this.clock = clock;
    this.entries = new Map();
  }

  /**
   * Always returns a LOOKUP describing what was found, never the bare
   * value. Expired entries are reported as EXPIRED rather than silently
   * dropped, so a caller could later choose to use them as an explicit
   * stale fallback. This implementation's caller (see
   * CachedFundamentalsProvider) deliberately does NOT do that today.
   */
  get(key) {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return Object.freeze({ state: CacheState.MISS, value: null, storedAt: null, expiresAt: null, ageMs: null });
    }
    if (!isUsableEntry(entry)) {
      // A corrupted entry is discarded outright — never partially trusted.
      this.entries.delete(key);
      return Object.freeze({ state: CacheState.MALFORMED, value: null, storedAt: null, expiresAt: null, ageMs: null });
    }
    const now = this.clock();
    const ageMs = now - entry.storedAt;
    const state = now >= entry.expiresAt ? CacheState.EXPIRED : CacheState.FRESH;
    return Object.freeze({ state, value: entry.value, storedAt: entry.storedAt, expiresAt: entry.expiresAt, ageMs });
  }

  set(key, value, ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`Refusing to cache "${key}" with a non-positive TTL`);
    }
    const storedAt = this.clock();
    // Deep-frozen on the way in, so nothing that later reads this entry can
    // alter it for the next reader.
    this.entries.set(key, Object.freeze({ value: deepFreeze(value), storedAt, expiresAt: storedAt + ttlMs }));
    return Object.freeze({ key, storedAt, expiresAt: storedAt + ttlMs });
  }

  delete(key) { return this.entries.delete(key); }

  clear() { this.entries.clear(); }

  /** Diagnostics only. Not part of the CacheStore contract. */
  get size() { return this.entries.size; }
}
