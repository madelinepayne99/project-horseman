import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryCacheStore, CacheStore, CacheState } from "../src/cache/CacheStore.js";
import { cacheKey, ttlFor, CacheKind, CACHE_TTL_MS } from "../src/cache/cachePolicy.js";

/**
 * Deterministic throughout: a fake clock is injected, so no test waits on
 * real time and no test depends on timing. No network of any kind.
 */
function fakeClock(start = Date.parse("2026-09-04T09:00:00Z")) {
  let now = start;
  const clock = () => now;
  clock.advanceHours = h => { now += h * 3600 * 1000; };
  clock.advanceMs = ms => { now += ms; };
  return clock;
}

const HOUR = 3600 * 1000;

test("the abstract CacheStore refuses to be used directly", () => {
  const s = new CacheStore();
  assert.throws(() => s.get("k"), /must be implemented/);
  assert.throws(() => s.set("k", 1, 10), /must be implemented/);
  assert.throws(() => s.delete("k"), /must be implemented/);
  assert.throws(() => s.clear(), /must be implemented/);
});

test("a miss is reported explicitly, not as an error or a null value", () => {
  const store = new MemoryCacheStore({ clock: fakeClock() });
  const lookup = store.get("alphavantage:fundamentals:AAPL");
  assert.equal(lookup.state, CacheState.MISS);
  assert.equal(lookup.value, null);
});

test("a stored entry is FRESH within its TTL and EXPIRED after it", () => {
  const clock = fakeClock();
  const store = new MemoryCacheStore({ clock });
  store.set("k", { ticker: "AAPL" }, 24 * HOUR);

  assert.equal(store.get("k").state, CacheState.FRESH);
  clock.advanceHours(23);
  assert.equal(store.get("k").state, CacheState.FRESH, "still inside the 24h window");
  clock.advanceHours(1);
  assert.equal(store.get("k").state, CacheState.EXPIRED, "exactly at expiry is expired");
  clock.advanceHours(100);
  assert.equal(store.get("k").state, CacheState.EXPIRED);
});

test("an expired entry is still readable so stale fallback stays possible later", () => {
  const clock = fakeClock();
  const store = new MemoryCacheStore({ clock });
  store.set("k", { ticker: "AAPL" }, 1 * HOUR);
  clock.advanceHours(2);
  const lookup = store.get("k");
  assert.equal(lookup.state, CacheState.EXPIRED);
  assert.deepEqual(lookup.value, { ticker: "AAPL" },
    "the store exposes it; the decorator chooses not to use it");
  assert.equal(lookup.ageMs, 2 * HOUR);
});

test("age, storedAt and expiresAt are reported accurately", () => {
  const clock = fakeClock();
  const store = new MemoryCacheStore({ clock });
  const written = store.set("k", { ticker: "AAPL" }, 12 * HOUR);
  clock.advanceHours(3);
  const lookup = store.get("k");
  assert.equal(lookup.ageMs, 3 * HOUR);
  assert.equal(lookup.storedAt, written.storedAt);
  assert.equal(lookup.expiresAt, written.storedAt + 12 * HOUR);
});

test("a malformed entry is discarded rather than half-trusted", () => {
  const store = new MemoryCacheStore({ clock: fakeClock() });
  // Simulate a corrupted envelope written by something other than set().
  store.entries.set("k", { value: { ticker: "AAPL" } }); // no storedAt/expiresAt
  const lookup = store.get("k");
  assert.equal(lookup.state, CacheState.MALFORMED);
  assert.equal(lookup.value, null);
  assert.equal(store.size, 0, "the corrupted entry is removed");
});

test("a non-positive TTL is refused rather than cached forever or never", () => {
  const store = new MemoryCacheStore({ clock: fakeClock() });
  for (const bad of [0, -1, NaN, undefined, null, "12h"]) {
    assert.throws(() => store.set("k", { ticker: "A" }, bad), /non-positive TTL/);
  }
});

test("delete and clear behave as expected", () => {
  const store = new MemoryCacheStore({ clock: fakeClock() });
  store.set("a", { ticker: "A" }, HOUR);
  store.set("b", { ticker: "B" }, HOUR);
  assert.equal(store.size, 2);
  store.delete("a");
  assert.equal(store.get("a").state, CacheState.MISS);
  store.clear();
  assert.equal(store.size, 0);
});

/* ---------------- policy ---------------- */

test("the approved TTLs are exactly 24h for fundamentals and 12h for earnings", () => {
  assert.equal(CACHE_TTL_MS[CacheKind.FUNDAMENTALS], 24 * HOUR);
  assert.equal(CACHE_TTL_MS[CacheKind.EARNINGS], 12 * HOUR);
  assert.equal(ttlFor(CacheKind.FUNDAMENTALS), 24 * HOUR);
  assert.equal(ttlFor(CacheKind.EARNINGS), 12 * HOUR);
});

test("news has no TTL defined — it is deliberately not cacheable", () => {
  assert.equal(CACHE_TTL_MS.news, undefined);
  assert.throws(() => ttlFor("news"), /No cache TTL defined/);
});

test("cache keys separate provider, kind and ticker", () => {
  assert.equal(cacheKey({ provider: "alphavantage", kind: CacheKind.FUNDAMENTALS, ticker: "AAPL" }),
    "alphavantage:fundamentals:AAPL");
  assert.equal(cacheKey({ provider: "alphavantage", kind: CacheKind.EARNINGS, ticker: "AAPL" }),
    "alphavantage:earnings:AAPL");
  // Two providers must never collide on one ticker.
  assert.notEqual(
    cacheKey({ provider: "alphavantage", kind: CacheKind.FUNDAMENTALS, ticker: "AAPL" }),
    cacheKey({ provider: "otherprovider", kind: CacheKind.FUNDAMENTALS, ticker: "AAPL" }));
});

test("ticker case and whitespace are normalised so quota is not spent twice", () => {
  const a = cacheKey({ provider: "p", kind: CacheKind.FUNDAMENTALS, ticker: "aapl" });
  const b = cacheKey({ provider: "p", kind: CacheKind.FUNDAMENTALS, ticker: " AAPL " });
  assert.equal(a, b);
});

test("cacheKey refuses incomplete input rather than building a colliding key", () => {
  assert.throws(() => cacheKey({ kind: CacheKind.FUNDAMENTALS, ticker: "AAPL" }), /provider identity/);
  assert.throws(() => cacheKey({ provider: "p", kind: "nonsense", ticker: "AAPL" }), /unknown kind/);
  assert.throws(() => cacheKey({ provider: "p", kind: CacheKind.FUNDAMENTALS, ticker: "  " }), /requires a ticker/);
});
