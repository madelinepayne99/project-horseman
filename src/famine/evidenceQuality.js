import { isPresent, factValue, EvidenceAvailability, ageInDays } from "../schema/fundamentals.js";

/**
 * FAMINE V2 — EVIDENCE QUALITY
 *
 * Freshness, completeness and disagreement. This module describes how good
 * the evidence is; it never says what the evidence MEANS. No direction, no
 * confidence, no score of market opinion is produced here.
 *
 * All functions are pure and take an injectable `now`, so identical input
 * always yields identical output.
 */

/* ------------------------------------------------------------------ */
/* FRESHNESS                                                           */
/* ------------------------------------------------------------------ */

export const Freshness = Object.freeze({
  CURRENT: "CURRENT",
  AGEING: "AGEING",
  STALE: "STALE",
  UNKNOWN: "UNKNOWN",   // no usable date — NOT the same as stale
});

/**
 * Quarterly financial data is not market-price data and must not be judged
 * on the same clock. A company reports roughly every 90 days, and there is
 * a reporting lag after each period ends, so figures a couple of months old
 * are entirely current in the only sense that matters here.
 *
 * CURRENT  <= 100 days  — within the normal reporting cycle
 * AGEING   <= 200 days  — roughly one missed cycle; usable, worth flagging
 * STALE     > 200 days  — more than two cycles; must not read as current
 *
 * These are cadence-derived, not statistically calibrated, and are stated
 * as such deliberately.
 */
export const FRESHNESS_THRESHOLDS = Object.freeze({
  CURRENT_MAX_DAYS: 100,
  AGEING_MAX_DAYS: 200,
});

export function classifyFreshness(isoDate, now = new Date()) {
  const days = ageInDays(isoDate, now);
  if (days === null) return { status: Freshness.UNKNOWN, asOf: null, ageDays: null };
  if (days <= FRESHNESS_THRESHOLDS.CURRENT_MAX_DAYS) return { status: Freshness.CURRENT, asOf: isoDate, ageDays: days };
  if (days <= FRESHNESS_THRESHOLDS.AGEING_MAX_DAYS) return { status: Freshness.AGEING, asOf: isoDate, ageDays: days };
  return { status: Freshness.STALE, asOf: isoDate, ageDays: days };
}

/**
 * Freshness of both evidence categories, plus the worst case across them,
 * which is what confidence is later reduced against. Categories that were
 * never obtained report UNKNOWN rather than STALE — we cannot describe the
 * age of evidence we do not have.
 */
export function assessFreshness(fundamentals, earnings, now = new Date()) {
  const fundamentalsFresh = fundamentals && fundamentals.availability === EvidenceAvailability.PRESENT
    ? classifyFreshness(fundamentals.asOf, now)
    : { status: Freshness.UNKNOWN, asOf: null, ageDays: null };

  // Prefer the reported date; fall back to the period end, which is older
  // but real. Never invent one.
  const earningsDate = earnings && earnings.availability === EvidenceAvailability.PRESENT
    ? (earnings.mostRecentReportedDate || earnings.mostRecentPeriodEnd)
    : null;
  const earningsFresh = earningsDate
    ? classifyFreshness(earningsDate, now)
    : { status: Freshness.UNKNOWN, asOf: null, ageDays: null };

  const rank = { [Freshness.CURRENT]: 0, [Freshness.AGEING]: 1, [Freshness.UNKNOWN]: 2, [Freshness.STALE]: 3 };
  const considered = [fundamentalsFresh, earningsFresh].filter(f => f.status !== Freshness.UNKNOWN);
  const overall = considered.length
    ? considered.reduce((worst, f) => (rank[f.status] > rank[worst.status] ? f : worst)).status
    : Freshness.UNKNOWN;

  return Object.freeze({ fundamentals: fundamentalsFresh, earnings: earningsFresh, overall });
}

/* ------------------------------------------------------------------ */
/* COMPLETENESS                                                        */
/* ------------------------------------------------------------------ */

/**
 * Not every fact matters equally. Growth figures are what Famine actually
 * reasons from; margin, EPS level and P/E are context we deliberately do
 * not score (see famineAnalysis.js). Weighting reflects that: losing a
 * supplementary field should dent completeness, not destroy it.
 */
export const COMPLETENESS_WEIGHTS = Object.freeze({
  revenueGrowthYoY: 3,
  earningsGrowthYoY: 3,
  earningsSurpriseHistory: 2,
  companyNews: 2,
  profitMargin: 1,
  eps: 1,
  peRatio: 1,
});
const TOTAL_WEIGHT = Object.values(COMPLETENESS_WEIGHTS).reduce((a, b) => a + b, 0); // 13

export function assessCompleteness(fundamentals, earnings, news = null) {
  const present = [];
  const missing = [];
  const unavailableCategories = [];
  let obtained = 0;

  const fundamentalsObtained = fundamentals && fundamentals.availability === EvidenceAvailability.PRESENT;
  // Same rule as earnings below: only a genuine failure counts as unavailable.
  if (!fundamentalsObtained && fundamentals?.availability !== EvidenceAvailability.EMPTY) {
    unavailableCategories.push({
      category: "fundamentals",
      availability: (fundamentals && fundamentals.availability) || "ABSENT",
      errorCode: (fundamentals && fundamentals.errorCode) || null,
    });
  }

  for (const key of ["revenueGrowthYoY", "earningsGrowthYoY", "profitMargin", "eps", "peRatio"]) {
    const fact = fundamentalsObtained ? fundamentals.facts[key] : null;
    if (isPresent(fact)) { present.push(key); obtained += COMPLETENESS_WEIGHTS[key]; }
    else missing.push({ field: key, reason: fact ? fact.reason : "CATEGORY_UNAVAILABLE" });
  }

  const earningsObtained = earnings && earnings.availability === EvidenceAvailability.PRESENT;
  // EMPTY means the provider answered and the company genuinely has no
  // reported quarters. That is a finding, not an outage, and must not be
  // reported as an unavailable category — the same NO-EVIDENCE vs
  // NEUTRAL-EVIDENCE distinction applied at category level. It still costs
  // completeness below, via the absent surprise history.
  const earningsUnavailable = !earningsObtained && earnings?.availability !== EvidenceAvailability.EMPTY;
  if (earningsUnavailable) {
    unavailableCategories.push({
      category: "earnings",
      availability: (earnings && earnings.availability) || "ABSENT",
      errorCode: (earnings && earnings.errorCode) || null,
    });
  }
  const usableSurprises = earningsObtained
    ? earnings.periods.filter(p => isPresent(p.surprisePct)).length
    : 0;
  if (usableSurprises > 0) { present.push("earningsSurpriseHistory"); obtained += COMPLETENESS_WEIGHTS.earningsSurpriseHistory; }
  else missing.push({ field: "earningsSurpriseHistory", reason: earningsObtained ? "NOT_REPORTED" : "CATEGORY_UNAVAILABLE" });

  // News: a successful "the company is quiet" result COUNTS as obtained
  // evidence — we looked and learned something. Only a provider failure
  // costs completeness, which is the NO-EVIDENCE vs NEUTRAL distinction
  // applied to news.
  const newsAvailability = news ? news.availability : null;
  const newsObtained = newsAvailability === "PRESENT" || newsAvailability === "NO_RECENT_NEWS";
  if (newsObtained) { present.push("companyNews"); obtained += COMPLETENESS_WEIGHTS.companyNews; }
  else {
    missing.push({ field: "companyNews", reason: "CATEGORY_UNAVAILABLE" });
    unavailableCategories.push({
      category: "companyNews",
      availability: newsAvailability || "ABSENT",
      errorCode: (news && news.errorCode) || null,
    });
  }

  return Object.freeze({
    score: Number((obtained / TOTAL_WEIGHT).toFixed(4)),
    obtainedWeight: obtained,
    totalWeight: TOTAL_WEIGHT,
    present: Object.freeze(present),
    missing: Object.freeze(missing),
    unavailableCategories: Object.freeze(unavailableCategories),
    usableSurpriseCount: usableSurprises,
  });
}

/* ------------------------------------------------------------------ */
/* DISAGREEMENT                                                        */
/* ------------------------------------------------------------------ */

export const MATERIAL_GROWTH = 0.05;   // ±5% YoY — the band used for "materially" up or down
export const MATERIAL_SURPRISE = 3;    // ±3% EPS surprise — beyond routine rounding

/**
 * Detects evidence that materially disagrees with itself. Disagreement
 * lowers confidence and is reported structurally; it does NOT force
 * NEUTRAL, because a genuinely mixed picture with a clear net lean is
 * still a lean.
 */
export function detectDisagreement(fundamentals, earnings) {
  const conflicts = [];
  const f = fundamentals && fundamentals.availability === EvidenceAvailability.PRESENT ? fundamentals.facts : null;

  const rev = f ? factValue(f.revenueGrowthYoY) : null;
  const earn = f ? factValue(f.earningsGrowthYoY) : null;

  if (rev !== null && earn !== null) {
    if (rev > MATERIAL_GROWTH && earn < 0) {
      conflicts.push({ type: "REVENUE_UP_EARNINGS_DOWN",
        detail: `Revenue grew ${(rev * 100).toFixed(1)}% year-on-year while earnings fell ${(earn * 100).toFixed(1)}%.` });
    }
    if (rev < 0 && earn > MATERIAL_GROWTH) {
      conflicts.push({ type: "REVENUE_DOWN_EARNINGS_UP",
        detail: `Revenue fell ${(rev * 100).toFixed(1)}% year-on-year while earnings grew ${(earn * 100).toFixed(1)}%.` });
    }
  }

  const surprises = (earnings && earnings.availability === EvidenceAvailability.PRESENT ? earnings.periods : [])
    .filter(p => isPresent(p.surprisePct)).map(p => factValue(p.surprisePct));
  const beats = surprises.filter(s => s > MATERIAL_SURPRISE).length;
  const misses = surprises.filter(s => s < -MATERIAL_SURPRISE).length;
  const growthPositive = (rev !== null && rev > MATERIAL_GROWTH) || (earn !== null && earn > MATERIAL_GROWTH);
  const growthNegative = (rev !== null && rev < 0) || (earn !== null && earn < 0);

  if (growthPositive && misses >= 2) {
    conflicts.push({ type: "GROWTH_UP_SURPRISES_DOWN",
      detail: `Growth is positive, but ${misses} of the last ${surprises.length} reported quarters missed expectations.` });
  }
  if (growthNegative && beats >= 2) {
    conflicts.push({ type: "GROWTH_DOWN_SURPRISES_UP",
      detail: `Growth is negative, but ${beats} of the last ${surprises.length} reported quarters beat expectations.` });
  }

  return Object.freeze(conflicts);
}
