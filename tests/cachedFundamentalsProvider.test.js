import { test } from "node:test";
import assert from "node:assert/strict";
import { CachedFundamentalsProvider, CacheOutcome } from "../src/providers/CachedFundamentalsProvider.js";
import { MemoryCacheStore, CacheState } from "../src/cache/CacheStore.js";
import { FundamentalsError, FundamentalsErrorCodes } from "../src/providers/FundamentalsProvider.js";
import { isPresent, factValue, EvidenceAvailability } from "../src/schema/fundamentals.js";
import { fundamentals, earnings } from "./fixtures/famineFixtures.js";

/**
 * Every test uses a FAKE provider and a FAKE clock. There is no fetch, no
 * HTTP and no Alpha Vantage request anywhere in this file, so no live
 * provider quota is consumed.
 */
const HOUR = 3600 * 1000;

function fakeClock(start = Date.parse("2026-09-04T09:00:00Z")) {
  let now = start;
  const clock = () => now;
  clock.advanceHours = h => { now += h * HOUR; };
  return clock;
}

/** Counts calls so we can prove the provider was or was not contacted. */
function fakeProvider({ failFundamentals = null, failEarnings = null } = {}) {
  const calls = { fundamentals: 0, earnings: 0 };
  return {
    providerId: "alphavantage",
    calls,
    async getFundamentals(ticker) {
      calls.fundamentals++;
      if (failFundamentals) throw failFundamentals;
      return fundamentals({ ticker });
    },
    async getEarningsHistory(ticker) {
      calls.earnings++;
      if (failEarnings) throw failEarnings;
      return earnings({ ticker });
    },
  };
}

function makeCached(provider, clock = fakeClock()) {
  return { cached: new CachedFundamentalsProvider({ provider, clock }), clock };
}

/* ---------------- hit / miss ---------------- */

test("first request is a MISS and calls the provider exactly once", async () => {
  const provider = fakeProvider();
  const { cached } = makeCached(provider);
  const snap = await cached.getFundamentals("AAPL");
  assert.equal(provider.calls.fundamentals, 1);
  assert.equal(snap.source.cached, false);
  assert.equal(snap.source.cacheState, CacheOutcome.MISS);
});

test("a repeat fundamentals request within 24h is a FRESH hit and does not call the provider", async () => {
  const provider = fakeProvider();
  const { cached, clock } = makeCached(provider);
  await cached.getFundamentals("AAPL");
  clock.advanceHours(23);
  const snap = await cached.getFundamentals("AAPL");

  assert.equal(provider.calls.fundamentals, 1, "provider must not be called a second time");
  assert.equal(snap.source.cached, true);
  assert.equal(snap.source.cacheState, CacheOutcome.FRESH);
  assert.equal(snap.source.cacheAgeSeconds, 23 * 3600);
});

test("a repeat earnings request within 12h is a FRESH hit and does not call the provider", async () => {
  const provider = fakeProvider();
  const { cached, clock } = makeCached(provider);
  await cached.getEarningsHistory("AAPL");
  clock.advanceHours(11);
  const hist = await cached.getEarningsHistory("AAPL");

  assert.equal(provider.calls.earnings, 1);
  assert.equal(hist.source.cached, true);
  assert.equal(hist.source.cacheState, CacheOutcome.FRESH);
});

test("different tickers get separate cache entries", async () => {
  const provider = fakeProvider();
  const { cached } = makeCached(provider);
  const a = await cached.getFundamentals("AAPL");
  const b = await cached.getFundamentals("TSLA");
  assert.equal(provider.calls.fundamentals, 2, "a second ticker must be fetched");
  assert.equal(a.ticker, "AAPL");
  assert.equal(b.ticker, "TSLA");
  // And each is independently cached.
  await cached.getFundamentals("AAPL");
  await cached.getFundamentals("TSLA");
  assert.equal(provider.calls.fundamentals, 2);
});

test("fundamentals and earnings for one ticker are separate entries", async () => {
  const provider = fakeProvider();
  const { cached } = makeCached(provider);
  await cached.getFundamentals("AAPL");
  assert.equal(provider.calls.earnings, 0, "fetching fundamentals must not satisfy earnings");
  await cached.getEarningsHistory("AAPL");
  assert.equal(provider.calls.fundamentals, 1);
  assert.equal(provider.calls.earnings, 1);
});

/* ---------------- expiry ---------------- */

test("expired fundamentals trigger a provider refresh and the entry is replaced", async () => {
  const provider = fakeProvider();
  const { cached, clock } = makeCached(provider);
  await cached.getFundamentals("AAPL");
  clock.advanceHours(25);
  const snap = await cached.getFundamentals("AAPL");

  assert.equal(provider.calls.fundamentals, 2);
  assert.equal(snap.source.cached, false, "a refresh is a live result, not a cache hit");
  assert.equal(snap.source.cacheState, CacheOutcome.REFRESHED);

  // The replacement is cached in turn.
  clock.advanceHours(1);
  const again = await cached.getFundamentals("AAPL");
  assert.equal(provider.calls.fundamentals, 2);
  assert.equal(again.source.cached, true);
});

test("expired earnings trigger a provider refresh at 12h, not 24h", async () => {
  const provider = fakeProvider();
  const { cached, clock } = makeCached(provider);
  await cached.getEarningsHistory("AAPL");
  clock.advanceHours(13);
  await cached.getEarningsHistory("AAPL");
  assert.equal(provider.calls.earnings, 2, "the 12h earnings TTL must expire before 24h");
});

/* ---------------- failure behaviour ---------------- */

test("an expired entry plus a provider failure returns the failure and does NOT serve stale data", async () => {
  const provider = fakeProvider();
  const clock = fakeClock();
  const cached = new CachedFundamentalsProvider({ provider, clock });

  const first = await cached.getFundamentals("AAPL");
  assert.equal(factValue(first.facts.revenueGrowthYoY), 0.164, "a real value was cached");

  clock.advanceHours(25);
  // The provider now fails. The expired entry must not be used.
  provider.getFundamentals = async () => {
    throw new FundamentalsError("daily cap reached", FundamentalsErrorCodes.RATE_LIMITED);
  };

  await assert.rejects(() => cached.getFundamentals("AAPL"), err => {
    assert.equal(err.code, FundamentalsErrorCodes.RATE_LIMITED,
      "the caller must see the real provider failure");
    return true;
  });
});

test("a miss plus a provider failure returns the failure and caches nothing", async () => {
  const provider = fakeProvider({
    failFundamentals: new FundamentalsError("unreachable", FundamentalsErrorCodes.PROVIDER_UNAVAILABLE),
  });
  const clock = fakeClock();
  const store = new MemoryCacheStore({ clock });
  const cached = new CachedFundamentalsProvider({ provider, store, clock });

  await assert.rejects(() => cached.getFundamentals("AAPL"),
    err => err.code === FundamentalsErrorCodes.PROVIDER_UNAVAILABLE);

  assert.equal(store.size, 0, "a failure must never become a sticky cached answer");
  // And the next attempt genuinely retries rather than replaying a failure.
  await assert.rejects(() => cached.getFundamentals("AAPL"), () => true);
  assert.equal(provider.calls.fundamentals, 2);
});

test("a malformed cached entry is discarded and the provider is called", async () => {
  const provider = fakeProvider();
  const clock = fakeClock();
  const store = new MemoryCacheStore({ clock });
  const cached = new CachedFundamentalsProvider({ provider, store, clock });

  // Corrupted envelope, as if written by something other than set().
  store.entries.set("alphavantage:fundamentals:AAPL", { value: { nonsense: true } });
  const snap = await cached.getFundamentals("AAPL");

  assert.equal(provider.calls.fundamentals, 1);
  assert.equal(snap.source.cached, false);
  assert.equal(snap.source.cacheState, CacheOutcome.MALFORMED);
  assert.equal(snap.availability, EvidenceAvailability.PRESENT);
});

test("an entry that is fresh by age but structurally unusable is also discarded", async () => {
  const provider = fakeProvider();
  const clock = fakeClock();
  const store = new MemoryCacheStore({ clock });
  const cached = new CachedFundamentalsProvider({ provider, store, clock });

  // Valid envelope, unusable payload.
  store.set("alphavantage:fundamentals:AAPL", { not: "a snapshot" }, 24 * HOUR);
  const snap = await cached.getFundamentals("AAPL");
  assert.equal(provider.calls.fundamentals, 1, "structural validation must not trust age alone");
  assert.equal(snap.source.cacheState, CacheOutcome.MALFORMED);
});

/* ---------------- provenance ---------------- */

test("a cache hit preserves the ORIGINAL fetchedAt and never looks like a live request", async () => {
  const provider = fakeProvider();
  const { cached, clock } = makeCached(provider);

  const first = await cached.getFundamentals("AAPL");
  const originalFetchedAt = first.source.fetchedAt;

  clock.advanceHours(6);
  const hit = await cached.getFundamentals("AAPL");

  assert.equal(hit.source.fetchedAt, originalFetchedAt,
    "fetchedAt must record when the provider was genuinely contacted");
  assert.equal(hit.source.cached, true);
  assert.equal(hit.source.cacheAgeSeconds, 6 * 3600);
  assert.ok(hit.source.cachedAt, "when it entered the cache is recorded");
  assert.ok(hit.source.cacheExpiresAt, "when it expires is recorded");
});

test("provider identity and the normalised payload survive caching intact", async () => {
  const provider = fakeProvider();
  const { cached, clock } = makeCached(provider);
  const live = await cached.getFundamentals("AAPL");
  clock.advanceHours(2);
  const hit = await cached.getFundamentals("AAPL");

  assert.equal(hit.source.provider, "alphavantage");
  assert.equal(hit.source.provider, live.source.provider);
  assert.equal(hit.ticker, "AAPL");
  assert.equal(hit.asOf, live.asOf);
  assert.equal(factValue(hit.facts.revenueGrowthYoY), factValue(live.facts.revenueGrowthYoY));
  assert.equal(isPresent(hit.facts.peRatio), true);
});

test("a live provider result explicitly reports cached: false", async () => {
  const provider = fakeProvider();
  const { cached } = makeCached(provider);
  const snap = await cached.getFundamentals("AAPL");
  assert.equal(snap.source.cached, false);
  assert.equal(snap.source.cacheAgeSeconds, 0);
});

test("the cache cannot be mutated through a returned object", async () => {
  const provider = fakeProvider();
  const { cached, clock } = makeCached(provider);

  const first = await cached.getFundamentals("AAPL");
  // The returned object is frozen, so tampering fails loudly in module
  // (strict-mode) code rather than silently corrupting the cache.
  assert.throws(() => { first.ticker = "TAMPERED"; }, TypeError);
  assert.throws(() => { first.source.cached = true; }, TypeError);

  clock.advanceHours(1);
  const hit = await cached.getFundamentals("AAPL");
  assert.equal(hit.ticker, "AAPL", "the cached value is unaffected");
  assert.equal(hit.source.cached, true);
  assert.equal(provider.calls.fundamentals, 1);
});

test("cache provenance is added without altering the normalised evidence itself", async () => {
  const provider = fakeProvider();
  const { cached } = makeCached(provider);
  const direct = await provider.getFundamentals("AAPL");
  const viaCache = await cached.getFundamentals("AAPL");

  // Same evidence, only source metadata differs.
  assert.deepEqual(Object.keys(direct).sort(), Object.keys(viaCache).sort());
  assert.equal(viaCache.availability, direct.availability);
  assert.equal(factValue(viaCache.facts.eps), factValue(direct.facts.eps));
});

/* ---------------- contract ---------------- */

test("the decorator implements the FundamentalsProvider contract and requires a provider", () => {
  assert.throws(() => new CachedFundamentalsProvider({}), /requires a provider/);
  const c = new CachedFundamentalsProvider({ provider: fakeProvider() });
  assert.equal(typeof c.getFundamentals, "function");
  assert.equal(typeof c.getEarningsHistory, "function");
});

test("two providers never share a cache entry for the same ticker", async () => {
  const clock = fakeClock();
  const store = new MemoryCacheStore({ clock });
  const a = fakeProvider(); a.providerId = "alphavantage";
  const b = fakeProvider(); b.providerId = "otherprovider";
  const ca = new CachedFundamentalsProvider({ provider: a, store, clock });
  const cb = new CachedFundamentalsProvider({ provider: b, store, clock });

  await ca.getFundamentals("AAPL");
  await cb.getFundamentals("AAPL");
  assert.equal(a.calls.fundamentals, 1);
  assert.equal(b.calls.fundamentals, 1, "the second provider must not read the first's entry");
});

test("expired entries remain readable in the store even though the decorator refuses to serve them", async () => {
  const provider = fakeProvider();
  const clock = fakeClock();
  const store = new MemoryCacheStore({ clock });
  const cached = new CachedFundamentalsProvider({ provider, store, clock });

  await cached.getFundamentals("AAPL");
  clock.advanceHours(25);

  // The capability for a future, deliberate stale-fallback decision exists...
  assert.equal(store.get("alphavantage:fundamentals:AAPL").state, CacheState.EXPIRED);
  // ...but is deliberately unused: the provider is called instead.
  await cached.getFundamentals("AAPL");
  assert.equal(provider.calls.fundamentals, 2);
});

/* ==================================================================== */
/* REVIEW FINDINGS — deep immutability, single flight, key integrity     */
/* ==================================================================== */

import { makeFundamentalsSnapshot } from "../src/schema/fundamentals.js";
import { deepFreeze } from "../src/cache/CacheStore.js";

/** A snapshot carrying NESTED vendor metadata, which is the mutable surface. */
function snapshotWithNestedMeta(ticker = "AAPL", provider = "alphavantage") {
  return makeFundamentalsSnapshot({
    ticker, companyName: "Apple Inc.", revenueGrowthYoY: "0.164",
    earningsGrowthYoY: "0.287", profitMargin: "0.276", eps: "8.71", peRatio: "37.33",
    asOf: "2026-06-30", provider,
    providerMeta: { exchange: "NASDAQ", sector: "TECHNOLOGY", industry: "COMPUTERS" },
  });
}

test("deepFreeze() freezes nested objects and arrays and tolerates cycles", () => {
  const cyclic = { a: { b: [1, { c: 2 }] } };
  cyclic.self = cyclic;
  deepFreeze(cyclic);
  assert.ok(Object.isFrozen(cyclic.a));
  assert.ok(Object.isFrozen(cyclic.a.b));
  assert.ok(Object.isFrozen(cyclic.a.b[1]));
});

test("cached payloads are DEEPLY immutable — nested vendor metadata cannot be tampered with", async () => {
  const clock = fakeClock();
  const provider = {
    providerId: "alphavantage", calls: { fundamentals: 0 },
    async getFundamentals(t) { this.calls.fundamentals++; return snapshotWithNestedMeta(t); },
    async getEarningsHistory() { return null; },
  };
  const cached = new CachedFundamentalsProvider({ provider, clock });

  const first = await cached.getFundamentals("AAPL");
  assert.ok(Object.isFrozen(first.source.providerMeta), "nested metadata must be frozen");
  assert.throws(() => { first.source.providerMeta.exchange = "TAMPERED"; }, TypeError);

  clock.advanceHours(1);
  const second = await cached.getFundamentals("AAPL");
  assert.equal(provider.calls.fundamentals, 1, "served from cache");
  assert.equal(second.source.providerMeta.exchange, "NASDAQ",
    "a later reader must not see another caller's mutation");
});

test("nested arrays inside cached evidence are also immutable", async () => {
  const clock = fakeClock();
  const provider = {
    providerId: "alphavantage", calls: { earnings: 0 },
    async getFundamentals(t) { return snapshotWithNestedMeta(t); },
    async getEarningsHistory(t) { this.calls.earnings++; return earnings({ ticker: t }); },
  };
  const cached = new CachedFundamentalsProvider({ provider, clock });

  const hist = await cached.getEarningsHistory("AAPL");
  assert.ok(Object.isFrozen(hist.periods), "the periods array is frozen");
  assert.ok(Object.isFrozen(hist.periods[0]), "each period is frozen");
  assert.throws(() => { hist.periods.push({}); }, TypeError);

  clock.advanceHours(1);
  const again = await cached.getEarningsHistory("AAPL");
  assert.equal(provider.calls.earnings, 1);
  assert.equal(again.periods.length, hist.periods.length);
});

test("two simultaneous misses for one key call the provider ONCE (single flight)", async () => {
  let calls = 0, release;
  const gate = new Promise(r => { release = r; });
  const provider = {
    providerId: "alphavantage",
    async getFundamentals(t) { calls++; await gate; return snapshotWithNestedMeta(t); },
    async getEarningsHistory() { return null; },
  };
  const cached = new CachedFundamentalsProvider({ provider, clock: fakeClock() });

  const a = cached.getFundamentals("AAPL");
  const b = cached.getFundamentals("AAPL");
  release();
  const [r1, r2] = await Promise.all([a, b]);

  assert.equal(calls, 1, "quota is scarce: one in-flight request must serve both callers");
  const outcomes = [r1.source.cacheState, r2.source.cacheState].sort();
  assert.deepEqual(outcomes, [CacheOutcome.COALESCED, CacheOutcome.MISS]);
  // A joiner is a live result, not a cache hit — it must not claim otherwise.
  assert.equal(r1.source.cached, false);
  assert.equal(r2.source.cached, false);
});

test("simultaneous requests for DIFFERENT keys are not coalesced together", async () => {
  let calls = 0, release;
  const gate = new Promise(r => { release = r; });
  const provider = {
    providerId: "alphavantage",
    async getFundamentals(t) { calls++; await gate; return snapshotWithNestedMeta(t); },
    async getEarningsHistory() { return null; },
  };
  const cached = new CachedFundamentalsProvider({ provider, clock: fakeClock() });

  const a = cached.getFundamentals("AAPL");
  const b = cached.getFundamentals("TSLA");
  release();
  const [r1, r2] = await Promise.all([a, b]);
  assert.equal(calls, 2, "different tickers are genuinely different requests");
  assert.equal(r1.ticker, "AAPL");
  assert.equal(r2.ticker, "TSLA");
});

test("a failed in-flight request is not sticky — later callers retry", async () => {
  let calls = 0;
  let shouldFail = true;
  const provider = {
    providerId: "alphavantage",
    async getFundamentals(t) {
      calls++;
      if (shouldFail) throw new FundamentalsError("cap", FundamentalsErrorCodes.RATE_LIMITED);
      return snapshotWithNestedMeta(t);
    },
    async getEarningsHistory() { return null; },
  };
  const cached = new CachedFundamentalsProvider({ provider, clock: fakeClock() });

  const a = cached.getFundamentals("AAPL").catch(e => e);
  const b = cached.getFundamentals("AAPL").catch(e => e);
  const [e1, e2] = await Promise.all([a, b]);
  assert.equal(calls, 1, "both joined one in-flight attempt");
  assert.equal(e1.code, FundamentalsErrorCodes.RATE_LIMITED);
  assert.equal(e2.code, FundamentalsErrorCodes.RATE_LIMITED, "the joiner sees the same real failure");

  // The in-flight entry must have been cleared.
  shouldFail = false;
  const ok = await cached.getFundamentals("AAPL");
  assert.equal(calls, 2, "a later attempt genuinely retries");
  assert.equal(ok.ticker, "AAPL");
});

test("a cached payload can never be served under the wrong ticker", async () => {
  const clock = fakeClock();
  const store = new MemoryCacheStore({ clock });
  const provider = {
    providerId: "alphavantage", calls: { fundamentals: 0 },
    async getFundamentals(t) { this.calls.fundamentals++; return snapshotWithNestedMeta(t); },
    async getEarningsHistory() { return null; },
  };
  const cached = new CachedFundamentalsProvider({ provider, store, clock });

  // Deliberately plant TSLA's payload under AAPL's key.
  store.set("alphavantage:fundamentals:AAPL", snapshotWithNestedMeta("TSLA"), 24 * HOUR);
  const snap = await cached.getFundamentals("AAPL");

  assert.equal(snap.ticker, "AAPL", "the wrong company's evidence must never be served");
  assert.equal(snap.source.cacheState, CacheOutcome.MISMATCHED);
  assert.equal(provider.calls.fundamentals, 1, "the mismatch forced a real fetch");
});

test("a cached payload can never be served under the wrong provider identity", async () => {
  const clock = fakeClock();
  const store = new MemoryCacheStore({ clock });
  const provider = {
    providerId: "alphavantage", calls: { fundamentals: 0 },
    async getFundamentals(t) { this.calls.fundamentals++; return snapshotWithNestedMeta(t); },
    async getEarningsHistory() { return null; },
  };
  const cached = new CachedFundamentalsProvider({ provider, store, clock });

  // Right ticker, wrong provenance.
  store.set("alphavantage:fundamentals:AAPL", snapshotWithNestedMeta("AAPL", "otherprovider"), 24 * HOUR);
  const snap = await cached.getFundamentals("AAPL");

  assert.equal(snap.source.provider, "alphavantage");
  assert.equal(snap.source.cacheState, CacheOutcome.MISMATCHED);
  assert.equal(provider.calls.fundamentals, 1);
});

test("evidence kinds cannot be served across each other", async () => {
  const clock = fakeClock();
  const store = new MemoryCacheStore({ clock });
  const provider = fakeProvider();
  const cached = new CachedFundamentalsProvider({ provider, store, clock });

  await cached.getFundamentals("AAPL");
  // The earnings key is untouched by the fundamentals fetch.
  assert.equal(store.get("alphavantage:earnings:AAPL").state, "MISS");
  await cached.getEarningsHistory("AAPL");
  assert.equal(provider.calls.earnings, 1, "earnings had to be fetched separately");
});
