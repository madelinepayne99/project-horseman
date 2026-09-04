/**
 * FAMINE V2 — provider-neutral evidence schema.
 *
 * This is the boundary Alpha Vantage (or any future fundamentals provider)
 * must translate into. Nothing downstream of this file should ever read a
 * vendor field name such as QuarterlyRevenueGrowthYOY or surprisePercentage.
 *
 * ---------------------------------------------------------------------
 * THE CENTRAL DESIGN RULE: MISSING EVIDENCE IS NOT NEUTRAL EVIDENCE
 * ---------------------------------------------------------------------
 * Famine V1's defect was that an absent figure simply contributed nothing
 * to a running score, so "we could not obtain the fundamentals" and "the
 * fundamentals are genuinely mixed" both produced 0 — i.e. NEUTRAL. That
 * was observed live: Alpha Vantage exhausted its daily quota and Famine
 * reported NEUTRAL as though it had looked and found balance.
 *
 * Facts here are therefore NOT bare numbers-or-null. They are small
 * wrapper objects:
 *
 *     { state: "PRESENT", value: 0.164 }
 *     { state: "MISSING", value: null, reason: "NOT_REPORTED" }
 *
 * A wrapper is deliberately useless in arithmetic. `fact > 0.05` is false
 * for BOTH states and `fact + 1` yields "[object Object]1" — a loud,
 * obviously-wrong result. A bare null, by contrast, silently coerces to 0
 * in arithmetic and compares as 0, which is exactly how a missing figure
 * becomes a neutral signal without anyone noticing. Downstream code is
 * forced through isPresent()/factValue() and cannot skip the check by
 * accident.
 *
 * This file performs NO scoring, NO direction and NO confidence. It only
 * describes what evidence was obtained and how good it is.
 */

/** Whether an individual figure was obtained. */
export const FactState = Object.freeze({
  PRESENT: "PRESENT",
  MISSING: "MISSING",
});

/** Why an individual figure is missing, when that is knowable. */
export const MissingReason = Object.freeze({
  NOT_REPORTED: "NOT_REPORTED",       // provider answered, but omitted/nulled this field
  NOT_PARSEABLE: "NOT_PARSEABLE",     // provider supplied something non-numeric
  CATEGORY_UNAVAILABLE: "CATEGORY_UNAVAILABLE", // the whole request failed
});

/**
 * Availability of a whole evidence CATEGORY (fundamentals, earnings…).
 * Distinguishing these four is what lets later stages reduce completeness
 * for an outage while treating a genuinely quiet result as information.
 */
export const EvidenceAvailability = Object.freeze({
  PRESENT: "PRESENT",                         // provider answered with usable content
  EMPTY: "EMPTY",                             // provider answered; there is genuinely nothing (e.g. no earnings history exists)
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE", // we could not obtain it — NEVER neutral
  MALFORMED: "MALFORMED",                     // provider answered with something unusable
});

// Alpha Vantage (and others) render absent numerics as these strings.
const NON_VALUES = new Set(["none", "n/a", "na", "-", "", "null", "undefined"]);

/**
 * Wraps a raw provider value as a fact. Anything not finitely numeric
 * becomes MISSING — never 0.
 */
export function makeFact(raw, { reason = MissingReason.NOT_REPORTED } = {}) {
  if (raw === null || raw === undefined) {
    return Object.freeze({ state: FactState.MISSING, value: null, reason });
  }
  if (typeof raw === "string" && NON_VALUES.has(raw.trim().toLowerCase())) {
    return Object.freeze({ state: FactState.MISSING, value: null, reason: MissingReason.NOT_REPORTED });
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) {
    return Object.freeze({ state: FactState.MISSING, value: null, reason: MissingReason.NOT_PARSEABLE });
  }
  return Object.freeze({ state: FactState.PRESENT, value: n });
}

/** A fact that is missing because its whole category could not be obtained. */
export function missingFact(reason = MissingReason.CATEGORY_UNAVAILABLE) {
  return Object.freeze({ state: FactState.MISSING, value: null, reason });
}

export function isPresent(fact) {
  return !!fact && fact.state === FactState.PRESENT;
}

/** Returns the number, or null. Callers must handle null explicitly. */
export function factValue(fact) {
  return isPresent(fact) ? fact.value : null;
}

/** ISO date string or null — never a fabricated date. */
function normaliseDate(raw) {
  if (!raw || typeof raw !== "string") return null;
  const t = Date.parse(raw.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/**
 * Provider-neutral fundamentals snapshot.
 *
 * `asOf` is the period the figures describe (the provider's reporting
 * date). `fetchedAt` is when we retrieved them. Both are kept so a later
 * stage can measure staleness objectively; NO staleness policy is applied
 * here.
 */
export function makeFundamentalsSnapshot({
  ticker,
  companyName = null,
  currency = null,
  revenueGrowthYoY,
  earningsGrowthYoY,
  profitMargin,
  eps,
  peRatio,
  asOf = null,
  provider,
  fetchedAt = new Date().toISOString(),
  providerMeta = null,
}) {
  const facts = Object.freeze({
    revenueGrowthYoY: makeFact(revenueGrowthYoY),
    earningsGrowthYoY: makeFact(earningsGrowthYoY),
    profitMargin: makeFact(profitMargin),
    eps: makeFact(eps),
    peRatio: makeFact(peRatio),
  });
  return Object.freeze({
    ticker,
    companyName: companyName || null,
    currency: currency || null,
    availability: EvidenceAvailability.PRESENT,
    facts,
    asOf: normaliseDate(asOf),
    source: Object.freeze({ provider, fetchedAt, cached: false, providerMeta }),
  });
}

/** Fundamentals we could not obtain. Every fact is explicitly MISSING. */
export function makeUnavailableFundamentals({
  ticker, provider, availability, errorCode, message = null,
  fetchedAt = new Date().toISOString(),
}) {
  const missing = missingFact();
  return Object.freeze({
    ticker,
    companyName: null,
    currency: null,
    availability,
    facts: Object.freeze({
      revenueGrowthYoY: missing, earningsGrowthYoY: missing,
      profitMargin: missing, eps: missing, peRatio: missing,
    }),
    asOf: null,
    errorCode,
    message,
    source: Object.freeze({ provider, fetchedAt, cached: false, providerMeta: null }),
  });
}

/** One reported quarter, provider-neutral. */
export function makeEarningsPeriod({
  fiscalPeriodEnd, reportedDate = null, reportedEps, estimatedEps, surprisePct,
}) {
  return Object.freeze({
    fiscalPeriodEnd: normaliseDate(fiscalPeriodEnd),
    reportedDate: normaliseDate(reportedDate),
    reportedEps: makeFact(reportedEps),
    estimatedEps: makeFact(estimatedEps),
    surprisePct: makeFact(surprisePct),
  });
}

/**
 * Provider-neutral earnings history, newest first.
 *
 * An empty history from a provider that answered successfully is EMPTY,
 * not PROVIDER_UNAVAILABLE — a company may genuinely have no reported
 * quarters. Later stages must be able to tell those apart.
 */
export function makeEarningsHistory({
  ticker, periods = [], provider, fetchedAt = new Date().toISOString(), providerMeta = null,
}) {
  const cleaned = periods.filter(p => p && p.fiscalPeriodEnd);
  return Object.freeze({
    ticker,
    availability: cleaned.length ? EvidenceAvailability.PRESENT : EvidenceAvailability.EMPTY,
    periods: Object.freeze(cleaned),
    mostRecentPeriodEnd: cleaned.length ? cleaned[0].fiscalPeriodEnd : null,
    mostRecentReportedDate: cleaned.length ? cleaned[0].reportedDate : null,
    source: Object.freeze({ provider, fetchedAt, cached: false, providerMeta }),
  });
}

/** Earnings history we could not obtain. */
export function makeUnavailableEarnings({
  ticker, provider, availability, errorCode, message = null,
  fetchedAt = new Date().toISOString(),
}) {
  return Object.freeze({
    ticker,
    availability,
    periods: Object.freeze([]),
    mostRecentPeriodEnd: null,
    mostRecentReportedDate: null,
    errorCode,
    message,
    source: Object.freeze({ provider, fetchedAt, cached: false, providerMeta: null }),
  });
}

/**
 * Age in whole days between a reporting date and a reference time, or null
 * if undateable. Measurement only — no thresholds, no penalties, no policy.
 */
export function ageInDays(isoDate, now = new Date()) {
  if (!isoDate) return null;
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86400000);
}
