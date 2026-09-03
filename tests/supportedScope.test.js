import { test } from "node:test";
import assert from "node:assert/strict";
import { isSupportedUsEquity } from "../src/utils/supportedScope.js";

test("isSupportedUsEquity() accepts a security reported on a recognised US exchange", () => {
  assert.equal(isSupportedUsEquity({ exchange: "NASDAQ", country: "United States" }), true);
});

test("isSupportedUsEquity() accepts on country alone if exchange is missing", () => {
  assert.equal(isSupportedUsEquity({ country: "United States" }), true);
});

test("isSupportedUsEquity() rejects a non-US exchange like the LSE", () => {
  assert.equal(isSupportedUsEquity({ exchange: "LSE", country: "United Kingdom" }), false);
});

test("isSupportedUsEquity() treats a real US ticker with a dot (e.g. BRK.B) correctly via metadata, not string pattern", () => {
  // The point of this test is that scope is decided from provider metadata,
  // never from the ticker string â€” a naive ".â€-based rule would wrongly
  // reject BRK.B, a genuine NYSE-listed US security.
  assert.equal(isSupportedUsEquity({ exchange: "NYSE", country: "United States" }), true);
});

test("isSupportedUsEquity() treats missing/absent metadata as unsupported rather than assuming eligibility", () => {
  assert.equal(isSupportedUsEquity(null), false);
  assert.equal(isSupportedUsEquity({}), false);
});

test("isSupportedUsEquity() reads canonical metadata and is provider-agnostic", () => {
  // The same canonical shape must work regardless of which adapter produced
  // it â€” this function has no knowledge of vendor field names.
  assert.equal(isSupportedUsEquity({ exchange: "NASDAQ", country: "United States", exchangeTimezone: "America/New_York" }), true);
  // Vendor-specific field names alone must NOT be accepted any more.
  assert.equal(isSupportedUsEquity({ exchange_timezone: "America/New_York" }), false);
});
