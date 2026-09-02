import { test } from "node:test";
import assert from "node:assert/strict";
import { isProvisionalBar, wallClockAt } from "../src/utils/marketSession.js";

const NY = { exchange_timezone: "America/New_York" };

// 2026-09-02 is a Wednesday. 18:33 UTC == 14:33 America/New_York (EDT),
// which is the exact real-world case that motivated this module.
const MIDSESSION_UTC = new Date("2026-09-02T18:33:00Z");

test("wallClockAt() converts UTC to the exchange's local wall clock", () => {
  const wall = wallClockAt("America/New_York", MIDSESSION_UTC);
  assert.equal(wall.date, "2026-09-02");
  assert.equal(wall.hour, 14);
  assert.equal(wall.minute, 33);
});

test("wallClockAt() returns null for an unusable timezone rather than throwing", () => {
  assert.equal(wallClockAt("Not/AZone", MIDSESSION_UTC), null);
});

test("today's bar during the open session IS provisional", () => {
  assert.equal(isProvisionalBar({ date: "2026-09-02" }, NY, MIDSESSION_UTC), true);
});

test("today's bar after the close (plus settle grace) is NOT provisional", () => {
  // 20:45 UTC == 16:45 New York â€” past the 16:20 settle cutoff.
  const afterClose = new Date("2026-09-02T20:45:00Z");
  assert.equal(isProvisionalBar({ date: "2026-09-02" }, NY, afterClose), false);
});

test("today's bar inside the post-close settle window is still provisional", () => {
  // 20:05 UTC == 16:05 New York â€” after the bell but inside the grace period,
  // where the closing auction and provider aggregation may not have settled.
  const justAfterBell = new Date("2026-09-02T20:05:00Z");
  assert.equal(isProvisionalBar({ date: "2026-09-02" }, NY, justAfterBell), true);
});

test("a bar dated earlier than today is never provisional", () => {
  assert.equal(isProvisionalBar({ date: "2026-08-28" }, NY, MIDSESSION_UTC), false);
});

test("a weekend request against Friday's bar is not provisional", () => {
  // Saturday 2026-09-05; newest available bar is Friday's.
  const saturday = new Date("2026-09-05T15:00:00Z");
  assert.equal(isProvisionalBar({ date: "2026-09-04" }, NY, saturday), false);
});

test("a pre-open request is not provisional (latest bar is the previous session)", () => {
  // 12:00 UTC == 08:00 New York, before the open; newest bar is yesterday's.
  const preOpen = new Date("2026-09-02T12:00:00Z");
  assert.equal(isProvisionalBar({ date: "2026-09-01" }, NY, preOpen), false);
});

test("timezone is taken from provider metadata, not assumed from the server's clock", () => {
  // Same instant, but an exchange where it is already past the close.
  const tokyo = { exchange_timezone: "Asia/Tokyo" };
  // 2026-09-02T18:33Z is 2026-09-03 03:33 in Tokyo, so a bar dated
  // 2026-09-02 is not "today" there and cannot be provisional.
  assert.equal(isProvisionalBar({ date: "2026-09-02" }, tokyo, MIDSESSION_UTC), false);
});

test("missing exchange_timezone falls back to the US session (this phase is US-equity scoped)", () => {
  assert.equal(isProvisionalBar({ date: "2026-09-02" }, null, MIDSESSION_UTC), true);
});

test("a missing bar date is treated as final rather than guessed", () => {
  assert.equal(isProvisionalBar({}, NY, MIDSESSION_UTC), false);
  assert.equal(isProvisionalBar(null, NY, MIDSESSION_UTC), false);
});

test("an unusable timezone is treated as final rather than suppressing real data", () => {
  assert.equal(isProvisionalBar({ date: "2026-09-02" }, { exchange_timezone: "Not/AZone" }, MIDSESSION_UTC), false);
});

test("DST is handled by real zone rules, not a fixed UTC offset", () => {
  // January: New York is EST (UTC-5), so 20:05 UTC == 15:05 â€” still open.
  const winterOpen = new Date("2026-01-14T20:05:00Z");
  assert.equal(isProvisionalBar({ date: "2026-01-14" }, NY, winterOpen), true);
  // Same clock time in July is EDT (UTC-4), so 20:05 UTC == 16:05 â€” past the bell.
  const summer = new Date("2026-07-15T20:05:00Z");
  // Inside the settle grace window, so still provisional â€” but for a
  // different reason than the winter case, which is the point: the offset
  // itself differs by season.
  assert.equal(isProvisionalBar({ date: "2026-07-15" }, NY, summer), true);
  // 20:45 UTC in July == 16:45 EDT, past settle; in January it would be 15:45 and still open.
  assert.equal(isProvisionalBar({ date: "2026-07-15" }, NY, new Date("2026-07-15T20:45:00Z")), false);
  assert.equal(isProvisionalBar({ date: "2026-01-14" }, NY, new Date("2026-01-14T20:45:00Z")), true);
});
