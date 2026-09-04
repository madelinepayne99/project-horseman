import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeFact, missingFact, isPresent, factValue,
  makeFundamentalsSnapshot, makeUnavailableFundamentals,
  makeEarningsPeriod, makeEarningsHistory, makeUnavailableEarnings,
  FactState, MissingReason, EvidenceAvailability, ageInDays,
} from "../src/schema/fundamentals.js";

/**
 * The schema's whole purpose is that MISSING can never be mistaken for a
 * neutral 0. These tests exist mainly to hold that property in place.
 */

test("makeFact(): parses provider strings into numeric facts", () => {
  assert.equal(factValue(makeFact("0.164")), 0.164);
  assert.equal(factValue(makeFact(37.33)), 37.33);
  assert.equal(factValue(makeFact("-0.052")), -0.052);
  assert.equal(isPresent(makeFact("0")), true, "a genuine zero is PRESENT, not missing");
  assert.equal(factValue(makeFact("0")), 0);
});

test("makeFact(): Alpha Vantage's 'None' and friends become MISSING, never 0", () => {
  for (const raw of ["None", "none", "N/A", "-", "", null, undefined]) {
    const f = makeFact(raw);
    assert.equal(f.state, FactState.MISSING, `${JSON.stringify(raw)} must be MISSING`);
    assert.equal(f.value, null, "missing values are null, never 0");
  }
});

test("makeFact(): unparseable input is MISSING with a distinct reason", () => {
  const f = makeFact("not-a-number");
  assert.equal(f.state, FactState.MISSING);
  assert.equal(f.reason, MissingReason.NOT_PARSEABLE);
});

test("a missing fact cannot masquerade as a neutral 0 in arithmetic or comparison", () => {
  const missing = missingFact();
  const zero = makeFact(0);

  // The critical property: the wrapper is NOT a number. Comparisons that
  // would silently treat a missing value as 0 are false for BOTH branches,
  // so a scoring rule cannot accidentally award a neutral band.
  assert.equal(missing > 0.05, false);
  assert.equal(missing < 0, false);
  assert.equal(missing >= 0, false, "crucially NOT true — a bare null would be");
  assert.ok(Number.isNaN(Number(missing)), "coercing a missing fact yields NaN, not 0");

  // A real zero still behaves like a real zero.
  assert.equal(isPresent(zero), true);
  assert.equal(factValue(zero), 0);

  // And the two are distinguishable, which null-vs-0 would not be.
  assert.notEqual(missing.state, zero.state);
});

test("factValue()/isPresent() are the only sanctioned way to read a fact", () => {
  assert.equal(isPresent(makeFact("1.5")), true);
  assert.equal(isPresent(missingFact()), false);
  assert.equal(factValue(missingFact()), null);
  assert.equal(isPresent(undefined), false, "defensive: no fact at all is not present");
});

test("makeFundamentalsSnapshot(): normalises a healthy provider payload", () => {
  const snap = makeFundamentalsSnapshot({
    ticker: "AAPL", companyName: "Apple Inc.", currency: "USD",
    revenueGrowthYoY: "0.164", earningsGrowthYoY: "0.287",
    profitMargin: "0.276", eps: "8.71", peRatio: "37.33",
    asOf: "2026-06-30", provider: "alphavantage",
  });

  assert.equal(snap.availability, EvidenceAvailability.PRESENT);
  assert.equal(snap.ticker, "AAPL");
  assert.equal(factValue(snap.facts.revenueGrowthYoY), 0.164);
  assert.equal(factValue(snap.facts.peRatio), 37.33);
  assert.equal(snap.asOf, "2026-06-30");
  assert.equal(snap.source.provider, "alphavantage");
  assert.ok(snap.source.fetchedAt);
  assert.equal(snap.source.cached, false, "cache flag exists for a later caching layer");
});

test("makeFundamentalsSnapshot(): partially reported fundamentals stay explicitly missing", () => {
  const snap = makeFundamentalsSnapshot({
    ticker: "AAPL", revenueGrowthYoY: "0.164",
    earningsGrowthYoY: "None", profitMargin: null, eps: "8.71", peRatio: "None",
    asOf: "2026-06-30", provider: "alphavantage",
  });
  assert.equal(factValue(snap.facts.revenueGrowthYoY), 0.164);
  assert.equal(isPresent(snap.facts.earningsGrowthYoY), false);
  assert.equal(isPresent(snap.facts.profitMargin), false);
  assert.equal(isPresent(snap.facts.peRatio), false);
  // The category itself was still obtained.
  assert.equal(snap.availability, EvidenceAvailability.PRESENT);
});

test("makeUnavailableFundamentals(): every fact is missing and the cause is explicit", () => {
  const snap = makeUnavailableFundamentals({
    ticker: "AAPL", provider: "alphavantage",
    availability: EvidenceAvailability.PROVIDER_UNAVAILABLE,
    errorCode: "RATE_LIMITED", message: "daily limit reached",
  });

  assert.equal(snap.availability, EvidenceAvailability.PROVIDER_UNAVAILABLE);
  assert.notEqual(snap.availability, EvidenceAvailability.EMPTY, "an outage is not an empty result");
  assert.equal(snap.errorCode, "RATE_LIMITED");
  for (const key of ["revenueGrowthYoY", "earningsGrowthYoY", "profitMargin", "eps", "peRatio"]) {
    assert.equal(isPresent(snap.facts[key]), false);
    assert.equal(snap.facts[key].reason, MissingReason.CATEGORY_UNAVAILABLE);
  }
  assert.equal(snap.asOf, null, "no reporting date is invented");
});

test("makeEarningsHistory(): normalises quarters newest-first with typed facts", () => {
  const hist = makeEarningsHistory({
    ticker: "AAPL", provider: "alphavantage",
    periods: [
      makeEarningsPeriod({ fiscalPeriodEnd: "2026-06-30", reportedDate: "2026-07-30", reportedEps: "1.57", estimatedEps: "1.46", surprisePct: "7.4" }),
      makeEarningsPeriod({ fiscalPeriodEnd: "2026-03-31", reportedDate: "2026-05-01", reportedEps: "1.53", estimatedEps: "1.50", surprisePct: "2.0" }),
    ],
  });

  assert.equal(hist.availability, EvidenceAvailability.PRESENT);
  assert.equal(hist.periods.length, 2);
  assert.equal(hist.mostRecentPeriodEnd, "2026-06-30");
  assert.equal(hist.mostRecentReportedDate, "2026-07-30");
  assert.equal(factValue(hist.periods[0].surprisePct), 7.4);
  assert.equal(factValue(hist.periods[0].reportedEps), 1.57);
});

test("makeEarningsHistory(): a 'None' surprise stays missing rather than becoming 0%", () => {
  const hist = makeEarningsHistory({
    ticker: "X", provider: "alphavantage",
    periods: [makeEarningsPeriod({ fiscalPeriodEnd: "2026-06-30", reportedEps: "1.20", estimatedEps: "None", surprisePct: "None" })],
  });
  assert.equal(isPresent(hist.periods[0].surprisePct), false,
    "a missing surprise must not read as a 0% (in-line) surprise");
  assert.equal(isPresent(hist.periods[0].estimatedEps), false);
  assert.equal(factValue(hist.periods[0].reportedEps), 1.20);
});

test("makeEarningsHistory(): an empty-but-successful result is EMPTY, not unavailable", () => {
  const hist = makeEarningsHistory({ ticker: "NEWCO", periods: [], provider: "alphavantage" });
  assert.equal(hist.availability, EvidenceAvailability.EMPTY);
  assert.notEqual(hist.availability, EvidenceAvailability.PROVIDER_UNAVAILABLE);
  assert.equal(hist.mostRecentPeriodEnd, null);
});

test("makeUnavailableEarnings(): distinguishable from an empty history", () => {
  const hist = makeUnavailableEarnings({
    ticker: "AAPL", provider: "alphavantage",
    availability: EvidenceAvailability.PROVIDER_UNAVAILABLE,
    errorCode: "PROVIDER_UNAVAILABLE",
  });
  assert.equal(hist.availability, EvidenceAvailability.PROVIDER_UNAVAILABLE);
  assert.equal(hist.periods.length, 0);
  assert.equal(hist.errorCode, "PROVIDER_UNAVAILABLE");
});

test("ageInDays(): makes freshness measurable without applying any policy", () => {
  const now = new Date("2026-09-03T00:00:00Z");
  assert.equal(ageInDays("2026-06-30", now), 65);
  assert.equal(ageInDays("2026-09-03", now), 0);
  assert.equal(ageInDays(null, now), null, "undateable evidence yields null, not 0 days old");
  assert.equal(ageInDays("not-a-date", now), null);
});

test("the schema produces no direction, confidence or score of any kind", () => {
  const snap = makeFundamentalsSnapshot({
    ticker: "AAPL", revenueGrowthYoY: "0.164", earningsGrowthYoY: "0.287",
    profitMargin: "0.276", eps: "8.71", peRatio: "37.33",
    asOf: "2026-06-30", provider: "alphavantage",
  });
  const hist = makeEarningsHistory({ ticker: "AAPL", periods: [], provider: "alphavantage" });
  for (const obj of [snap, hist]) {
    const keys = Object.keys(obj).join(",").toLowerCase();
    for (const banned of ["direction", "confidence", "score", "bullish", "bearish", "verdict"]) {
      assert.ok(!keys.includes(banned), `${banned} must not appear in the normalisation layer`);
    }
  }
});
