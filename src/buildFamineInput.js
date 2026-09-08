import { EvidenceAvailability } from "../schema/fundamentals.js";
import { assessFreshness, assessCompleteness, detectDisagreement, Freshness } from "./evidenceQuality.js";
import { assessNewsEvidence } from "./newsEvidence.js";

/**
 * FAMINE V2 — INPUT ASSEMBLY
 *
 * Combines the Step 1 normalised structures with the quality assessment
 * into the single object Famine's analysis reasons from. Still no
 * direction and no confidence — this describes the evidence base only.
 *
 * Deliberately accepts ONLY fundamentals and earnings. There is no
 * parameter through which technical, crowd or headline data could enter
 * Famine, which is the structural guarantee that those cannot leak in.
 */

export const FamineDataStatus = Object.freeze({
  COMPLETE: "COMPLETE",
  PARTIAL_EVIDENCE: "PARTIAL_EVIDENCE",
  STALE_EVIDENCE: "STALE_EVIDENCE",
  EVIDENCE_UNAVAILABLE: "EVIDENCE_UNAVAILABLE",
});

// Below this, too little of the evidence base was obtained to describe the
// result as merely "partial".
const UNAVAILABLE_COMPLETENESS_FLOOR = 0.2;

/**
 * A single headline status must not hide a second condition, so the status
 * is accompanied by statusReasons[]: evidence can be both stale AND partial,
 * and both are reported. This is the clearer representation the brief
 * invited rather than collapsing combinations into one label.
 */
function decideDataStatus({ completeness, freshness, fundamentals, earnings }) {
  const reasons = [];

  const nothingObtained =
    fundamentals.availability !== EvidenceAvailability.PRESENT &&
    earnings.availability !== EvidenceAvailability.PRESENT;

  if (nothingObtained || completeness.score < UNAVAILABLE_COMPLETENESS_FLOOR) {
    for (const c of completeness.unavailableCategories) {
      reasons.push(`${c.category} unavailable${c.errorCode ? ` (${c.errorCode})` : ""}`);
    }
    if (!reasons.length) reasons.push("insufficient evidence obtained");
    return { status: FamineDataStatus.EVIDENCE_UNAVAILABLE, reasons };
  }

  if (completeness.score < 1) reasons.push(`completeness ${(completeness.score * 100).toFixed(0)}%`);
  for (const c of completeness.unavailableCategories) {
    reasons.push(`${c.category} unavailable${c.errorCode ? ` (${c.errorCode})` : ""}`);
  }
  if (freshness.overall === Freshness.STALE) {
    reasons.push(`evidence is stale (${freshness.fundamentals.ageDays ?? freshness.earnings.ageDays} days old)`);
    return { status: FamineDataStatus.STALE_EVIDENCE, reasons };
  }
  if (freshness.overall === Freshness.AGEING) reasons.push("evidence is ageing but within one reporting cycle");
  if (freshness.overall === Freshness.UNKNOWN) reasons.push("reporting dates unavailable, so freshness is unknown");

  if (completeness.score < 1 || completeness.unavailableCategories.length) {
    return { status: FamineDataStatus.PARTIAL_EVIDENCE, reasons };
  }
  return { status: FamineDataStatus.COMPLETE, reasons };
}

export function buildFamineInput({ ticker, fundamentals, earnings, news = null, now = new Date() }) {
  const freshness = assessFreshness(fundamentals, earnings, now);
  // Event evidence is assessed separately and kept separately, so
  // fundamentals and current events remain independently inspectable.
  // The company name lets the relevance layer recognise stories that name
  // the company without its ticker. Taken from fundamentals when available.
  const companyNameForNews = fundamentals.availability === EvidenceAvailability.PRESENT
    ? fundamentals.companyName : null;
  const newsEvidence = assessNewsEvidence(news, now, { companyName: companyNameForNews });
  const completeness = assessCompleteness(fundamentals, earnings, news);
  const disagreement = detectDisagreement(fundamentals, earnings);
  const { status, reasons } = decideDataStatus({ completeness, freshness, fundamentals, earnings });

  return Object.freeze({
    ticker: ticker || fundamentals.ticker || earnings.ticker,
    companyName: fundamentals.availability === EvidenceAvailability.PRESENT ? fundamentals.companyName : null,
    dataStatus: status,
    statusReasons: Object.freeze(reasons),
    completeness,
    freshness,
    disagreement,
    newsEvidence,
    // The normalised evidence itself, carried through untouched.
    fundamentals,
    earnings,
    news,
    source: Object.freeze({
      providers: Object.freeze([...new Set([fundamentals.source?.provider, earnings.source?.provider, news?.source?.provider].filter(Boolean))]),
      fundamentalsFetchedAt: fundamentals.source?.fetchedAt || null,
      earningsFetchedAt: earnings.source?.fetchedAt || null,
      newsFetchedAt: news?.source?.fetchedAt || null,
      cached: !!(fundamentals.source?.cached || earnings.source?.cached),
    }),
  });
}
