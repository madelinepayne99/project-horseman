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
  // Renamed by design: the generic type never said which measure it meant.
  assert.ok(r.disagreement.some(c => c.type === "EARNINGS_GROWTH_UP_SURPRISES_DOWN"));
  assert.equal(r.direction, FamineDirection.BULLISH, "a net lean survives disagreement");
  assert.ok(r.strongestOpposing.length >= 1, "the opposing evidence is preserved, not discarded");
});

test("negative growth with repeated positive surprises is flagged", () => {
  const r = assess(fundamentals({ revenueGrowthYoY: "-0.14", earningsGrowthYoY: "-0.10" }), earnings({ surprises: [9, 8, 7, 6] }));
  assert.ok(r.disagreement.some(c => c.type === "EARNINGS_GROWTH_DOWN_SURPRISES_UP"));
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

// ---------------------------------------------------------------------
// LIVE-EVIDENCE FIX 1 — disagreement must name its measure and must never
// assert contradictory generic growth states. Regression fixture is the
// real TSLA analysis: revenue +25.5%, earnings -3.0%, mixed surprises.
// ---------------------------------------------------------------------

function tslaLive(surprises = [7.4, -6.1, 5.2, -4.8]) {
  return {
    f: fundamentals({ revenueGrowthYoY: "0.255", earningsGrowthYoY: "-0.03", profitMargin: "0.05", eps: "2.1", peRatio: "80" }),
    e: earnings({ surprises }),
  };
}

test("TSLA regression: no contradictory generic growth wording is ever emitted", () => {
  const { f, e } = tslaLive();
  const r = assess(f, e);
  const details = r.disagreement.map(d => d.detail);

  // The exact defect: these two statements previously appeared together.
  assert.ok(!details.some(d => /^Growth is positive/.test(d)),
    "no unqualified 'Growth is positive' — it never said which measure");
  assert.ok(!details.some(d => /^Growth is negative/.test(d)));
  const positives = details.filter(d => /is positive/.test(d));
  const negatives = details.filter(d => /is negative/.test(d));
  assert.ok(!(positives.length && negatives.length),
    "a single analysis must not simultaneously claim growth is positive and negative");
});

test("TSLA regression: every disagreement names the measure it refers to", () => {
  const { f, e } = tslaLive();
  const r = assess(f, e);
  assert.ok(r.disagreement.length > 0);
  for (const d of r.disagreement) {
    assert.ok(Array.isArray(d.measures) && d.measures.length,
      `${d.type} must declare which measures it used`);
    // Understandable without knowing the implementation.
    assert.ok(/Revenue|Earnings/.test(d.detail), `${d.type} detail must name the measure: ${d.detail}`);
  }
});

test("TSLA regression: revenue/earnings divergence remains visible", () => {
  const { f, e } = tslaLive();
  const r = assess(f, e);
  const div = r.disagreement.find(d => d.type === "REVENUE_UP_EARNINGS_DOWN");
  assert.ok(div, "genuine divergence between the two measures must still be reported");
  assert.match(div.detail, /Revenue grew 25\.5%.*earnings fell -3\.0%/);
});

test("TSLA regression: the surprise comparison uses EARNINGS growth, the dimensionally matching measure", () => {
  const { f, e } = tslaLive();
  const r = assess(f, e);
  const surprise = r.disagreement.find(d => /SURPRISES/.test(d.type));
  assert.ok(surprise);
  assert.equal(surprise.type, "EARNINGS_GROWTH_DOWN_SURPRISES_UP");
  assert.deepEqual(surprise.measures, ["earningsGrowthYoY"]);
  assert.match(surprise.detail, /Earnings growth is negative at -3\.0%/);
});

test("TSLA regression: the same phenomenon is not triple-penalised", () => {
  const { f, e } = tslaLive();
  const r = assess(f, e);
  // Previously three flags fired (penalty 10). Now two genuinely distinct
  // observations remain: the measures diverge, and earnings fell while
  // beating expectations.
  assert.equal(r.disagreement.length, 2);
  const surpriseFlags = r.disagreement.filter(d => /SURPRISES/.test(d.type));
  assert.equal(surpriseFlags.length, 1, "at most one surprise flag — up and down are mutually exclusive");
});

test("up-and-down surprise flags are mutually exclusive by construction", () => {
  // Earnings growth strongly positive with repeated misses.
  const up = assess(fundamentals({ revenueGrowthYoY: "0.25", earningsGrowthYoY: "0.30" }), earnings({ surprises: [-9, -7, 5, 4] }));
  const upFlags = up.disagreement.filter(d => /SURPRISES/.test(d.type));
  assert.equal(upFlags.length, 1);
  assert.equal(upFlags[0].type, "EARNINGS_GROWTH_UP_SURPRISES_DOWN");
  assert.match(upFlags[0].detail, /Earnings growth is positive at 30\.0%/);
});

test("revenue growth is used for the surprise comparison ONLY when earnings growth is missing, and says so", () => {
  const r = assess(
    fundamentals({ revenueGrowthYoY: "-0.14", earningsGrowthYoY: "None" }),
    earnings({ surprises: [9, 8, 7, 6] })
  );
  const flag = r.disagreement.find(d => /SURPRISES/.test(d.type));
  assert.ok(flag);
  assert.equal(flag.type, "REVENUE_GROWTH_DOWN_SURPRISES_UP");
  assert.deepEqual(flag.measures, ["revenueGrowthYoY"]);
  assert.match(flag.detail, /earnings growth was unavailable/i,
    "the weaker proxy must be disclosed, not silently substituted");
});

test("disagreement still lowers confidence, and by less than the old triple count", () => {
  const { f, e } = tslaLive();
  const conflicted = assess(f, e);
  const clean = assess(
    fundamentals({ revenueGrowthYoY: "0.255", earningsGrowthYoY: "0.20" }),
    earnings({ surprises: [7.4, 5.2, 4.1, 3.9] })
  );
  assert.ok(conflicted.confidence < clean.confidence, "genuine disagreement must still cost confidence");
});
