import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFamineInput, FamineDataStatus } from "../src/famine/buildFamineInput.js";
import { famineAnalysis, FamineDirection, DIRECTION_THRESHOLD } from "../src/famine/famineAnalysis.js";
import { Freshness } from "../src/famine/evidenceQuality.js";
import {
  NOW, RECENT_QUARTER, AGEING_QUARTER, STALE_QUARTER,
  fundamentals, unavailableFundamentals, earnings, emptyEarnings, unavailableEarnings,
  ordinaryNews,
} from "./fixtures/famineFixtures.js";

/**
 * Famine V2 analysis. Every fixture is constructed directly from the
 * normalised schema — NO HTTP request is made and no Alpha Vantage quota
 * is consumed anywhere in this file.
 */
function assess(f, e, now = NOW, newsEv = ordinaryNews()) {
  // Ordinary, directionally-unremarkable news is supplied so these tests
  // isolate the FUNDAMENTALS behaviour. News-specific behaviour is covered
  // in famineNews.test.js.
  return famineAnalysis(buildFamineInput({ ticker: "AAPL", fundamentals: f, earnings: e, news: newsEv, now }));
}

/* ---------------- direction ---------------- */

test("strong positive fundamentals produce BULLISH", () => {
  const r = assess(fundamentals(), earnings());
  assert.equal(r.direction, FamineDirection.BULLISH);
  assert.ok(r.confidence > 50);
  assert.ok(r.strongestSupporting.length >= 2);
  assert.equal(r.strongestOpposing.length, 0);
});

test("strong negative fundamentals produce BEARISH", () => {
  const r = assess(
    fundamentals({ revenueGrowthYoY: "-0.12", earningsGrowthYoY: "-0.31" }),
    earnings({ surprises: [-8.2, -5.1, -6.0, -4.4] })
  );
  assert.equal(r.direction, FamineDirection.BEARISH);
  assert.ok(r.strongestSupporting.length >= 2, "supporting = supporting the bearish read");
  assert.equal(r.strongestOpposing.length, 0);
});

test("genuinely flat reported figures produce NEUTRAL — real evidence of flatness", () => {
  const r = assess(
    fundamentals({ revenueGrowthYoY: "0.01", earningsGrowthYoY: "0.02" }),
    earnings({ surprises: [0.5, -0.4, 0.2, 0.1] })
  );
  assert.equal(r.direction, FamineDirection.NEUTRAL);
  assert.equal(r.completeness.score, 1, "NEUTRAL here comes from complete evidence, not absence");
  assert.equal(r.dataStatus, FamineDataStatus.COMPLETE);
});

test("a real reported ZERO remains valid evidence, not a missing value", () => {
  const r = assess(fundamentals({ revenueGrowthYoY: "0", earningsGrowthYoY: "0" }), earnings());
  assert.equal(r.completeness.score, 1, "a reported 0 counts toward completeness");
  assert.ok(r.completeness.present.includes("revenueGrowthYoY"));
  assert.ok(!r.missingEvidence.some(m => m.field === "revenueGrowthYoY"));
  assert.ok(r.signals.some(s => s.key === "revenueGrowthYoY" && s.value === 0));
});

/* ---------------- UNKNOWN, never NEUTRAL ---------------- */

test("no evidence at all produces UNKNOWN, never NEUTRAL", () => {
  const r = assess(unavailableFundamentals(), unavailableEarnings());
  assert.equal(r.direction, FamineDirection.UNKNOWN);
  assert.notEqual(r.direction, FamineDirection.NEUTRAL);
  assert.equal(r.confidence, null, "there is no assessment to be confident about");
  assert.equal(r.dataStatus, FamineDataStatus.EVIDENCE_UNAVAILABLE);
  assert.equal(r.strongestSupporting.length, 0);
  assert.equal(r.strongestOpposing.length, 0);
});

test("provider rate limit produces UNKNOWN and names the cause", () => {
  const r = assess(unavailableFundamentals("RATE_LIMITED"), unavailableEarnings("RATE_LIMITED"));
  assert.equal(r.direction, FamineDirection.UNKNOWN);
  assert.ok(r.statusReasons.some(x => x.includes("RATE_LIMITED")));
  assert.ok(r.uncertainties.some(u => u.includes("could not be obtained")));
});

test("earnings surprises alone are too thin for a direction — UNKNOWN, not NEUTRAL", () => {
  const r = assess(unavailableFundamentals(), earnings({ surprises: [9.1, 8.4, 7.7, 6.2] }));
  assert.equal(r.direction, FamineDirection.UNKNOWN);
  assert.ok(r.uncertainties.some(u => u.includes("too thin a base")));
});

test("missing evidence cannot add a neutral score — proven by comparing lean", () => {
  // Identical present evidence, different amounts of missing evidence.
  const complete = assess(fundamentals({ revenueGrowthYoY: "0.20", earningsGrowthYoY: "0.25" }), earnings({ surprises: [9, 8, 7, 6] }));
  const partial = assess(
    fundamentals({ revenueGrowthYoY: "0.20", earningsGrowthYoY: "0.25", profitMargin: "None", eps: "None", peRatio: "None" }),
    unavailableEarnings()
  );
  // The lean is identical because absent facts never entered the arithmetic.
  assert.equal(complete.lean, 1);
  assert.equal(partial.lean, 1, "missing facts must not drag the lean toward 0");
  assert.equal(partial.direction, FamineDirection.BULLISH);
  // What DID change is how much we know, and therefore confidence.
  assert.ok(partial.completeness.score < complete.completeness.score);
  assert.ok(partial.confidence < complete.confidence, "less knowledge must mean less confidence");
});

/* ---------------- completeness ---------------- */

test("missing evidence reduces completeness and is itemised", () => {
  const r = assess(fundamentals({ peRatio: "None", profitMargin: "None" }), earnings());
  assert.ok(r.completeness.score < 1);
  assert.ok(r.missingEvidence.some(m => m.field === "peRatio"));
  assert.ok(r.missingEvidence.some(m => m.field === "profitMargin"));
  assert.equal(r.dataStatus, FamineDataStatus.PARTIAL_EVIDENCE);
});

test("one missing OPTIONAL fact does not destroy an otherwise useful assessment", () => {
  const r = assess(fundamentals({ peRatio: "None" }), earnings());
  assert.equal(r.direction, FamineDirection.BULLISH);
  assert.ok(r.completeness.score > 0.85, "losing a supplementary field is a dent, not a collapse");
  assert.ok(r.confidence > 50);
});

test("required evidence is weighted above supplementary context", () => {
  const missingRequired = assess(fundamentals({ revenueGrowthYoY: "None" }), earnings());
  const missingOptional = assess(fundamentals({ peRatio: "None" }), earnings());
  assert.ok(missingRequired.completeness.score < missingOptional.completeness.score,
    "losing revenue growth must cost more completeness than losing P/E");
});

test("an unavailable earnings category is reported distinctly from an empty one", () => {
  const unavailable = assess(fundamentals(), unavailableEarnings());
  const empty = assess(fundamentals(), emptyEarnings());
  assert.ok(unavailable.completeness.unavailableCategories.some(c => c.category === "earnings"));
  assert.equal(empty.completeness.unavailableCategories.length, 0,
    "a company with genuinely no reported quarters is not a provider outage");
  assert.equal(unavailable.direction, FamineDirection.BULLISH, "fundamentals alone still support a view");
});

/* ---------------- freshness ---------------- */

test("current, ageing, stale and unknown freshness are distinguished", () => {
  assert.equal(assess(fundamentals({ asOf: RECENT_QUARTER }), earnings()).freshness.fundamentals.status, Freshness.CURRENT);
  assert.equal(assess(fundamentals({ asOf: AGEING_QUARTER }), earnings({ asOf: AGEING_QUARTER })).freshness.overall, Freshness.AGEING);
  assert.equal(assess(fundamentals({ asOf: STALE_QUARTER }), earnings({ asOf: STALE_QUARTER })).freshness.overall, Freshness.STALE);
  assert.equal(assess(fundamentals({ asOf: null }), emptyEarnings()).freshness.fundamentals.status, Freshness.UNKNOWN);
});

test("stale evidence does not score as if current", () => {
  const fresh = assess(fundamentals({ asOf: RECENT_QUARTER }), earnings({ asOf: RECENT_QUARTER }));
  const stale = assess(fundamentals({ asOf: STALE_QUARTER }), earnings({ asOf: STALE_QUARTER }));
  assert.equal(fresh.direction, stale.direction, "the same figures still point the same way");
  assert.ok(stale.confidence < fresh.confidence, "but we must be less confident in old figures");
  assert.equal(stale.dataStatus, FamineDataStatus.STALE_EVIDENCE);
  assert.ok(stale.uncertainties.some(u => u.includes("days old")));
  assert.ok(stale.freshness.fundamentals.asOf, "the actual date is preserved for explanation");
});

test("unknown freshness reduces confidence and is stated", () => {
  const known = assess(fundamentals({ asOf: RECENT_QUARTER }), emptyEarnings());
  const unknown = assess(fundamentals({ asOf: null }), emptyEarnings());
  assert.ok(unknown.confidence < known.confidence);
  assert.ok(unknown.uncertainties.some(u => u.includes("age of this evidence could not be established")));
});

/* ---------------- disagreement ---------------- */

test("revenue up with earnings down is recorded as disagreement and reduces confidence", () => {
  const conflicted = assess(fundamentals({ revenueGrowthYoY: "0.18", earningsGrowthYoY: "-0.22" }), earnings({ surprises: [1, 1, 1, 1] }));
  const agreeing = assess(fundamentals({ revenueGrowthYoY: "0.18", earningsGrowthYoY: "0.20" }), earnings({ surprises: [1, 1, 1, 1] }));
  assert.ok(conflicted.disagreement.some(c => c.type === "REVENUE_UP_EARNINGS_DOWN"));
  assert.ok(conflicted.confidence < agreeing.confidence);
});

test("positive growth with repeated negative surprises is flagged, and does not force NEUTRAL", () => {
  const r = assess(fundamentals({ revenueGrowthYoY: "0.20", earningsGrowthYoY: "0.18" }), earnings({ surprises: [-9, -7, -6, -5] }));
  assert.ok(r.disagreement.some(c => c.type === "GROWTH_UP_SURPRISES_DOWN"));
  assert.equal(r.direction, FamineDirection.BULLISH, "a net lean survives disagreement");
  assert.ok(r.strongestOpposing.length >= 1, "the opposing evidence is preserved, not discarded");
});

test("negative growth with repeated positive surprises is flagged", () => {
  const r = assess(fundamentals({ revenueGrowthYoY: "-0.14", earningsGrowthYoY: "-0.10" }), earnings({ surprises: [9, 8, 7, 6] }));
  assert.ok(r.disagreement.some(c => c.type === "GROWTH_DOWN_SURPRISES_UP"));
  assert.equal(r.direction, FamineDirection.BEARISH);
  assert.ok(r.strongestOpposing.length >= 1);
});

test("a single earnings surprise is never scored on its own", () => {
  const one = assess(fundamentals(), earnings({ surprises: [45.0] }));
  assert.ok(!one.signals.some(s => s.key === "earningsSurprises"),
    "one quarter is noise and must not become a signal");
});

/* ---------------- structure, leakage, determinism ---------------- */

test("macro is always declared as a limitation, never implied to have been checked", () => {
  const r = assess(fundamentals(), earnings());
  assert.ok(r.limitations.some(l => /macroeconomic/i.test(l)));
  const serialised = JSON.stringify(r).toLowerCase();
  assert.ok(!serialised.includes("macro conditions are supportive"));
});

test("P/E and margin are retained as context but never scored", () => {
  const r = assess(fundamentals(), earnings());
  assert.ok(r.completeness.present.includes("peRatio"));
  assert.ok(r.completeness.present.includes("profitMargin"));
  assert.ok(!r.signals.some(s => s.key === "peRatio" || s.key === "profitMargin"),
    "valuation and margin need sector context we do not have");
  assert.ok(r.limitations.some(l => /P\/E/.test(l)));
});

test("no technical, crowd or headline fields can enter Famine", () => {
  const r = assess(fundamentals(), earnings());
  const serialised = JSON.stringify(r).toLowerCase();
  // NOTE: "support" is deliberately excluded from this substring check — it
  // collides with the required strongestSupporting field. Technical support
  // is covered by the unambiguous "support level"/"resistance" terms.
  // NOTE: "news"/"headline" are NOT banned — company news is Famine's own
  // canonical territory. What must never appear is technical or crowd data.
  for (const banned of ["rsi", "movingaverage", "ma20", "ma50", "ma200", "support level", "resistance",
                        "volatility", "volume", "crowding", "attention", "sentiment", "tone"]) {
    assert.ok(!serialised.includes(banned), `${banned} must not appear anywhere in a Famine assessment`);
  }
  // Structural guarantee: buildFamineInput accepts only fundamentals and
  // earnings, so there is no parameter through which such data could arrive.
  assert.deepEqual(Object.keys(r).filter(k => /technical|crowd|social|price|chart/i.test(k)), []);
});

test("every directional claim is traceable to underlying evidence", () => {
  const r = assess(fundamentals(), earnings());
  for (const s of [...r.strongestSupporting, ...r.strongestOpposing]) {
    assert.ok(s.claim && s.basis, "each claim must carry the basis it was derived from");
    assert.ok(typeof s.weight === "number");
  }
});

test("identical input produces identical output", () => {
  const a = assess(fundamentals(), earnings());
  const b = assess(fundamentals(), earnings());
  const strip = o => JSON.stringify({ ...o, source: null });
  assert.equal(strip(a), strip(b));
});

test("the direction threshold is explicit and behaves at its boundary", () => {
  // One positive growth signal (w3) + one flat (w3) + flat surprises (w2)
  // -> lean = 3/8 = 0.375, above the 0.34 threshold.
  const r = assess(fundamentals({ revenueGrowthYoY: "0.20", earningsGrowthYoY: "0.01" }), earnings({ surprises: [0.5, 0.2, 0.1, 0.3] }));
  assert.ok(r.lean >= DIRECTION_THRESHOLD);
  assert.equal(r.direction, FamineDirection.BULLISH);
});
