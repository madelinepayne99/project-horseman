import { FundamentalsProvider } from "./FundamentalsProvider.js";
import { MemoryCacheStore, CacheState, deepFreeze } from "../cache/CacheStore.js";
import { cacheKey, ttlFor, CacheKind } from "../cache/cachePolicy.js";

/**
 * FAMINE V2 — CACHING DECORATOR
 *
 * Wraps ANY FundamentalsProvider and implements the same contract, so
 * nothing downstream knows or cares that caching exists. Contains no
 * provider-specific knowledge whatsoever.
 *
 * ---------------------------------------------------------------------
 * EXPIRED ENTRIES ARE NEVER SERVED
 * ---------------------------------------------------------------------
 * The approved policy is:
 *
 *   fresh cache      -> serve cache
 *   expired cache    -> attempt provider refresh
 *   refresh succeeds -> replace cache, serve fresh result
 *   refresh fails    -> return the provider failure normally
 *
 * An expired entry is never returned as a stale fallback. It is not
 * silently deleted either: the store still reports EXPIRED, so a future
 * deliberate decision to allow stale fallback needs only a change here,
 * not to the store or the schema. That capability is intentionally left
 * unused today — serving stale evidence without a confidence penalty would
 * reintroduce exactly the "degraded data looks fine" problem Famine V2
 * exists to remove.
 *
 * PROVIDER FAILURES ARE NEVER CACHED. A rate-limit or outage must not
 * become a sticky answer for the next 24 hours.
 *
 * PROVENANCE: `fetchedAt` is NEVER rewritten. It remains the moment the
 * provider was genuinely contacted, so a cache hit cannot masquerade as a
 * live request — the timestamp gives it away even before `cached: true`
 * states it outright.
 */

export const CacheOutcome = Object.freeze({
  MISS: "MISS",             // nothing cached; provider called
  FRESH: "FRESH",           // served from cache; provider NOT called
  REFRESHED: "REFRESHED",   // entry had expired; provider called and entry replaced
  MALFORMED: "MALFORMED",   // cached entry unusable; discarded and provider called
  COALESCED: "COALESCED",   // joined an identical request already in flight
  MISMATCHED: "MISMATCHED", // cached payload did not match the request; discarded
});

/**
 * Guards against a cached payload that is not a usable normalised
 * structure — a corrupted or partially-written entry must be discarded
 * rather than half-trusted.
 */
function looksLikeNormalisedEvidence(value) {
  return !!value
    && typeof value === "object"
    && typeof value.ticker === "string"
    && typeof value.availability === "string"
    && !!value.source
    && typeof value.source.provider === "string";
}

/**
 * Defence in depth on top of the cache key. Even though the key encodes
 * provider, kind and ticker, a cached payload is only served if it also
 * SAYS it is for the ticker and provider we asked for. Serving one
 * company's fundamentals under another's name would be among the worst
 * failures this system could produce, so it is checked rather than assumed.
 */
function matchesRequest(value, { ticker, providerId }) {
  const wanted = String(ticker || "").trim().toUpperCase();
  return String(value.ticker || "").trim().toUpperCase() === wanted
    && value.source.provider === providerId;
}

/**
 * Returns a frozen copy carrying cache provenance on `source`.
 *
 * A copy, not a mutation: the cached object stays exactly as the provider
 * produced it, so a caller cannot alter what the next reader receives.
 */
function withCacheProvenance(value, meta) {
  // deepFreeze, not Object.freeze: the spread creates fresh top-level and
  // source objects but shares every nested reference (notably
  // source.providerMeta) with the cached payload. A shallow freeze would
  // leave those nested objects mutable and the cache poisonable.
  return deepFreeze({
    ...value,
    source: { ...value.source, ...meta },
  });
}

export class CachedFundamentalsProvider extends FundamentalsProvider {
  /**
   * @param {FundamentalsProvider} provider the real provider to wrap
   * @param {CacheStore} store defaults to a process-local memory store
   * @param {() => number} clock injectable millisecond clock
   */
  constructor({ provider, store = null, clock = () => Date.now() } = {}) {
    super();
    if (!provider) throw new Error("CachedFundamentalsProvider requires a provider to wrap");
    this.provider = provider;
    this.clock = clock;
    this.store = store || new MemoryCacheStore({ clock });
    // In-flight request de-duplication ("single flight"). Two simultaneous
    // misses for the same key would otherwise each call the provider and
    // each spend one of Alpha Vantage's 25 daily requests. The second
    // caller now awaits the first caller's promise instead.
    this.inFlight = new Map();
    // Identity used in cache keys. Taken from the wrapped provider where it
    // declares one, so two providers never share an entry.
    this.providerId = provider.providerId || provider.constructor?.name || "provider";
  }

  async #resolve(kind, ticker, fetchFromProvider) {
    const key = cacheKey({ provider: this.providerId, kind, ticker });
    const lookup = this.store.get(key);

    if (lookup.state === CacheState.FRESH) {
      const usable = looksLikeNormalisedEvidence(lookup.value);
      const matches = usable && matchesRequest(lookup.value, { ticker, providerId: this.providerId });
      if (usable && !matches) {
        // Should be unreachable given the key design; if it ever happens,
        // fail loudly in the logs and refetch rather than serve the wrong
        // company's evidence.
        console.error(`[CachedFundamentalsProvider] Cached payload under "${key}" did not match the request (got ticker "${lookup.value.ticker}", provider "${lookup.value.source.provider}"). Discarding.`);
        this.store.delete(key);
        return this.#fetchAndStore(key, kind, fetchFromProvider, CacheOutcome.MISMATCHED);
      }
      if (matches) {
        return withCacheProvenance(lookup.value, {
          cached: true,
          cacheState: CacheOutcome.FRESH,
          cachedAt: new Date(lookup.storedAt).toISOString(),
          cacheAgeSeconds: Math.floor(lookup.ageMs / 1000),
          cacheExpiresAt: new Date(lookup.expiresAt).toISOString(),
          // NOTE: value.source.fetchedAt is untouched above and still
          // records when the provider was actually contacted.
        });
      }
      // Fresh by age but structurally unusable: discard and refetch.
      this.store.delete(key);
      return this.#fetchAndStore(key, kind, fetchFromProvider, CacheOutcome.MALFORMED);
    }

    const outcome =
      lookup.state === CacheState.EXPIRED ? CacheOutcome.REFRESHED :
      lookup.state === CacheState.MALFORMED ? CacheOutcome.MALFORMED :
      CacheOutcome.MISS;

    // EXPIRED entries are deliberately NOT served here. The provider is
    // called; if it throws, the error propagates and the caller sees the
    // real failure rather than stale evidence.
    return this.#fetchAndStore(key, kind, fetchFromProvider, outcome);
  }

  async #fetchAndStore(key, kind, fetchFromProvider, outcome) {
    // If a request for this key is already in flight, join it rather than
    // starting a second one. Note this shares the PROVIDER call only; each
    // caller still gets its own provenance below, so a joiner is never
    // mislabelled as a cache hit.
    const existing = this.inFlight.get(key);
    if (existing) {
      const value = await existing;
      const lookup = this.store.get(key);
      return withCacheProvenance(value, {
        cached: false,
        cacheState: CacheOutcome.COALESCED,
        cachedAt: lookup.storedAt ? new Date(lookup.storedAt).toISOString() : null,
        cacheAgeSeconds: 0,
        cacheExpiresAt: lookup.expiresAt ? new Date(lookup.expiresAt).toISOString() : null,
      });
    }

    const pending = fetchFromProvider();
    this.inFlight.set(key, pending);

    let value;
    try {
      // If this throws, nothing is written: failures are never cached.
      value = await pending;
    } finally {
      // Cleared on failure too, so an error is never a sticky in-flight
      // entry that starves later retries.
      this.inFlight.delete(key);
    }
    const stored = this.store.set(key, value, ttlFor(kind));
    return withCacheProvenance(value, {
      cached: false,
      cacheState: outcome,
      cachedAt: new Date(stored.storedAt).toISOString(),
      cacheAgeSeconds: 0,
      cacheExpiresAt: new Date(stored.expiresAt).toISOString(),
    });
  }

  async getFundamentals(ticker) {
    return this.#resolve(CacheKind.FUNDAMENTALS, ticker, () => this.provider.getFundamentals(ticker));
  }

  async getEarningsHistory(ticker) {
    return this.#resolve(CacheKind.EARNINGS, ticker, () => this.provider.getEarningsHistory(ticker));
  }
}
