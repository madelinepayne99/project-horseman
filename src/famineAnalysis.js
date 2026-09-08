import { isPresent, factValue, EvidenceAvailability } from "../schema/fundamentals.js";
import { Freshness, MATERIAL_GROWTH, MATERIAL_SURPRISE } from "./evidenceQuality.js";
import { DirectionalImpact, Materiality } from "./eventClassification.js";
import { NewsAvailability } from "../schema/news.js";
import { FamineDataStatus } from "./buildFamineInput.js";

/**
 * FAMINE V2 — ANALYSIS
 *
 * ---------------------------------------------------------------------
 * THE CORE SEPARATION
 * ---------------------------------------------------------------------
 *   DIRECTION    is computed ONLY from evidence we actually possess.
 *                Missing facts appear in neither the numerator nor the
 *                denominator of the lean, so they cannot pull it toward
 *                zero. They cost completeness instead.
 *   COMPLETENESS is how much of the expected evidence we obtained.
 *   CONFIDENCE   is direction strength DISCOUNTED by completeness,
 *                freshness and internal disagreement.
 *
 * Famine V1's defect was one number doing all three jobs: an absent figure
 * contributed 0 to the score, and 0 meant NEUTRAL. Here, absence cannot
 * reach the direction arithmetic at all.
 *
 * ---------------------------------------------------------------------
 * WHAT IS SCORED, AND WHAT IS DELIBERATELY NOT
 * ---------------------------------------------------------------------
 * SCORED (weight):
 *   revenueGrowthYoY   (3) — direction of the top line, YoY, self-comparing
 *   earningsGrowthYoY  (3) — direction of the bottom line, YoY
 *   earningsSurprises  (2) — execution against expectations, and only when
 *                            at least MIN_SURPRISES_TO_SCORE quarters are
 *                            available, so one quarter cannot swing Famine
 *
 * NOT SCORED, retained as context:
 *   peRatio      — a P/E is only high or low relative to sector, growth
 *                  rate and rate environment. We have none of those. A
 *                  bare threshold would be a fabricated valuation opinion.
 *   profitMargin — same problem: a 4% margin is excellent for a grocer and
 *                  alarming for a software firm. Sector context is out of
 *                  scope, so scoring it would be guesswork.
 *   eps          — an absolute EPS level says nothing directional without
 *                  price, which belongs to War, not Famine.
 *
 * These thresholds are cadence- and materiality-derived judgements, NOT
 * statistically calibrated, and are documented as such.
 */

export const FamineDirection = Object.freeze({
  BULLISH: "BULLISH",
  BEARISH: "BEARISH",
  NEUTRAL: "NEUTRAL",
  UNKNOWN: "UNKNOWN",   // insufficient reliable evidence — NOT a market view
});

export const SIGNAL_WEIGHTS = Object.freeze({
  revenueGrowthYoY: 3,
  earningsGrowthYoY: 3,
  earningsSurprises: 2,
  // Current catalysts carry real weight but stay below the two growth
  // signals: a single headline should not outvote the company's reported
  // financial direction. Only EXPLICIT, MATERIAL, CURRENT events reach
  // here at all (see newsEvidence.js) — general coverage never does.
  currentCatalysts: 2,
});

/** One quarter is noise; two is the minimum that can indicate a pattern. */
export const MIN_SURPRISES_TO_SCORE = 2;

/** |lean| at or above this reads as directional rather than balanced. */
export const DIRECTION_THRESHOLD = 0.34;

/**
 * Growth bands. Above +5% YoY is materially growing; below 0 is materially
 * shrinking; the band between is real evidence of flatness — which is a
 * genuine NEUTRAL contribution from a fact we DO have, quite different
 * from a fact we lack.
 */
function scoreGrowth(value) {
  if (value > MATERIAL_GROWTH) return 1;
  if (value < 0) return -1;
  return 0;
}

function buildSignals(input) {
  const signals = [];
  const f = input.fundamentals.availability === EvidenceAvailability.PRESENT ? input.fundamentals.facts : null;

  for (const key of ["revenueGrowthYoY", "earningsGrowthYoY"]) {
    const fact = f ? f[key] : null;
    if (!isPresent(fact)) continue;                    // absent -> not a signal at all
    const v = factValue(fact);
    const score = scoreGrowth(v);
    signals.push({
      key, weight: SIGNAL_WEIGHTS[key], score, value: v,
      claim: `${key === "revenueGrowthYoY" ? "Revenue" : "Earnings"} ${v >= 0 ? "grew" : "fell"} ${Math.abs(v * 100).toFixed(1)}% year-on-year`,
      basis: `${key} = ${v}`,
    });
  }

  const periods = input.earnings.availability === EvidenceAvailability.PRESENT ? input.earnings.periods : [];
  const surprises = periods.filter(p => isPresent(p.surprisePct)).map(p => factValue(p.surprisePct));
  if (surprises.length >= MIN_SURPRISES_TO_SCORE) {
    const beats = surprises.filter(s => s > MATERIAL_SURPRISE).length;
    const misses = surprises.filter(s => s < -MATERIAL_SURPRISE).length;
    // Net of beats vs misses over the window, normalised to -1..+1, so a
    // lone beat among several in-line quarters cannot read as a strong
    // signal.
    const net = (beats - misses) / surprises.length;
    const score = net > 0.25 ? 1 : net < -0.25 ? -1 : 0;
    signals.push({
      key: "earningsSurprises", weight: SIGNAL_WEIGHTS.earningsSurprises, score, value: net,
      claim: `${beats} beat and ${misses} missed expectations across the last ${surprises.length} reported quarters`,
      basis: `surprises = [${surprises.map(s => s.toFixed(1)).join(", ")}]`,
    });
  }

  // ---- Current catalysts -------------------------------------------
  // Only groups that are material, current AND directionally explicit are
  // catalysts. Each GROUP counts once however many outlets ran it, so
  // repeated coverage cannot multiply directional weight.
  const catalysts = input.newsEvidence ? input.newsEvidence.materialCatalysts : [];
  if (catalysts.length) {
    const positive = catalysts.filter(c => c.classification.directionalImpact === DirectionalImpact.POSITIVE);
    const negative = catalysts.filter(c => c.classification.directionalImpact === DirectionalImpact.NEGATIVE);
    // HIGH materiality counts double against MEDIUM — still deterministic.
    const wt = g => (g.classification.materiality === Materiality.HIGH ? 2 : 1);
    const pos = positive.reduce((a, g) => a + wt(g), 0);
    const neg = negative.reduce((a, g) => a + wt(g), 0);
    if (pos !== neg) {
      const score = pos > neg ? 1 : -1;
      const describe = g => `${g.representative.headline}`;
      signals.push({
        key: "currentCatalysts", weight: SIGNAL_WEIGHTS.currentCatalysts, score,
        value: pos - neg,
        claim: score > 0
          ? `Current material catalyst: ${describe(positive[0])}`
          : `Current material catalyst: ${describe(negative[0])}`,
        basis: `${positive.length} positive and ${negative.length} negative explicit material catalysts in the last 72 hours`,
      });
    }
  }

  return signals;
}

/**
 * Famine V2 assessment. Pure and deterministic: identical input yields
 * identical output. Accepts ONLY a Famine input object, so technical,
 * crowd and headline data have no route in.
 */
export function famineAnalysis(input) {
  const signals = buildSignals(input);

  const limitations = [
    // Never imply macro was considered.
    "Macroeconomic conditions, interest rates and sector context are not yet assessed by Famine.",
    "Valuation (P/E) and profit margin are reported as context only; they are not scored without sector and growth context.",
    "Fundamentals are historical evidence, not a forecast.",
    "Company news is assessed from headlines and publication metadata only; article text is not retrieved, so many events carry an explicitly unknown impact.",
  ];
  const uncertainties = [];
  const missingEvidence = input.completeness.missing.map(m => ({ field: m.field, reason: m.reason }));

  for (const c of input.completeness.unavailableCategories) {
    uncertainties.push(`The ${c.category} category could not be obtained${c.errorCode ? ` (${c.errorCode})` : ""}, so it contributed no evidence in either direction.`);
  }

  const news = input.newsEvidence;
  if (news && news.availability === NewsAvailability.NO_RECENT_NEWS) {
    // A successful quiet result is a finding, not a gap.
    uncertainties.push("No relevant recent company news was found, which suggests no current catalyst rather than an absence of information.");
  }
  if (news && news.unknownImpactEvents.length) {
    uncertainties.push(`${news.unknownImpactEvents.length} recent event(s) could not be assigned a directional impact from the available headline evidence.`);
  }

  // ---- No usable directional evidence -> UNKNOWN, never NEUTRAL ----
  const hasGrowthSignal = signals.some(s => s.key === "revenueGrowthYoY" || s.key === "earningsGrowthYoY");
  if (!signals.length || !hasGrowthSignal) {
    if (!signals.length) {
      uncertainties.push("No directional fundamental evidence was available on this run.");
    } else {
      uncertainties.push("Earnings surprises were available, but neither revenue nor earnings growth was, which is too thin a base for a directional view.");
    }
    return Object.freeze({
      ticker: input.ticker,
      direction: FamineDirection.UNKNOWN,
      // Null, not a number: there is no assessment to be confident about.
      confidence: null,
      dataStatus: input.dataStatus === FamineDataStatus.COMPLETE
        ? FamineDataStatus.EVIDENCE_UNAVAILABLE
        : input.dataStatus,
      statusReasons: input.statusReasons,
      completeness: input.completeness,
      freshness: input.freshness,
      disagreement: input.disagreement,
      newsAvailability: input.newsEvidence ? input.newsEvidence.availability : null,
      newsFreshness: input.newsEvidence ? input.newsEvidence.freshness : null,
      recentEvents: input.newsEvidence ? input.newsEvidence.eventGroups : Object.freeze([]),
    contextualEvents: input.newsEvidence ? input.newsEvidence.contextualEvents : Object.freeze([]),
    irrelevantNewsCount: input.newsEvidence ? input.newsEvidence.irrelevantCount : 0,
      contextualEvents: input.newsEvidence ? input.newsEvidence.contextualEvents : Object.freeze([]),
      irrelevantNewsCount: input.newsEvidence ? input.newsEvidence.irrelevantCount : 0,
      materialCatalysts: input.newsEvidence ? input.newsEvidence.materialCatalysts : Object.freeze([]),
      unknownImpactEvents: input.newsEvidence ? input.newsEvidence.unknownImpactEvents : Object.freeze([]),
      signals: Object.freeze(signals),
      strongestSupporting: Object.freeze([]),
      strongestOpposing: Object.freeze([]),
      uncertainties: Object.freeze(uncertainties),
      missingEvidence: Object.freeze(missingEvidence),
      limitations: Object.freeze(limitations),
      source: input.source,
    });
  }

  // ---- Direction: weighted lean over PRESENT evidence only ----
  const weightPresent = signals.reduce((a, s) => a + s.weight, 0);
  const weighted = signals.reduce((a, s) => a + s.weight * s.score, 0);
  const lean = weighted / weightPresent;   // -1..+1

  const direction = lean >= DIRECTION_THRESHOLD ? FamineDirection.BULLISH
    : lean <= -DIRECTION_THRESHOLD ? FamineDirection.BEARISH
    : FamineDirection.NEUTRAL;

  // ---- Fundamentals vs current events -------------------------------
  // "Strong fundamentals, but a material negative catalyst" must be
  // visible, not averaged away. Recorded as disagreement so it reduces
  // confidence and is reported, while the net lean still stands.
  const fundamentalLean = (() => {
    const f = signals.filter(s => s.key !== "currentCatalysts");
    const w = f.reduce((a, s) => a + s.weight, 0);
    return w ? f.reduce((a, s) => a + s.weight * s.score, 0) / w : 0;
  })();
  const catalystSignal = signals.find(s => s.key === "currentCatalysts");
  const eventConflicts = [];
  if (catalystSignal && fundamentalLean !== 0 && Math.sign(catalystSignal.score) !== Math.sign(fundamentalLean)) {
    eventConflicts.push({
      type: fundamentalLean > 0 ? "STRONG_FUNDAMENTALS_NEGATIVE_CATALYST" : "WEAK_FUNDAMENTALS_POSITIVE_CATALYST",
      detail: fundamentalLean > 0
        ? `Reported fundamentals point positively, but a current material catalyst points the other way: ${catalystSignal.claim}`
        : `Reported fundamentals point negatively, but a current material catalyst points the other way: ${catalystSignal.claim}`,
    });
  }
  const allDisagreement = Object.freeze([...input.disagreement, ...eventConflicts]);

  // ---- Confidence: strength, then discounts ----
  // Base rises with how decisively the evidence leans.
  const base = 40 + Math.abs(lean) * 30;                       // 40..70
  // Completeness is a multiplier, not a subtraction, so a thin evidence
  // base cannot yield a confident answer however decisive it looks.
  const completenessFactor = 0.5 + 0.5 * input.completeness.score; // 0.5..1.0
  let confidence = base * completenessFactor;

  const freshnessPenalty =
    input.freshness.overall === Freshness.STALE ? 10 :
    input.freshness.overall === Freshness.AGEING ? 4 :
    input.freshness.overall === Freshness.UNKNOWN ? 8 : 0;
  confidence -= freshnessPenalty;

  const disagreementPenalty = allDisagreement.length ? 6 + 2 * (allDisagreement.length - 1) : 0;
  confidence -= disagreementPenalty;

  confidence = Math.round(Math.max(25, Math.min(85, confidence)));

  // ---- Traceable evidence ----
  const ranked = [...signals].sort((a, b) => Math.abs(b.weight * b.score) - Math.abs(a.weight * a.score));
  const strongestSupporting = ranked
    .filter(s => (direction === FamineDirection.BEARISH ? s.score < 0 : s.score > 0))
    .map(s => ({ claim: s.claim, basis: s.basis, weight: s.weight, source: "fundamentals/earnings" }));
  const strongestOpposing = ranked
    .filter(s => (direction === FamineDirection.BEARISH ? s.score > 0 : s.score < 0))
    .map(s => ({ claim: s.claim, basis: s.basis, weight: s.weight, source: "fundamentals/earnings" }));

  for (const c of allDisagreement) uncertainties.push(c.detail);
  if (input.freshness.overall === Freshness.STALE) {
    uncertainties.push(`The most recent evidence is ${input.freshness.fundamentals.ageDays ?? input.freshness.earnings.ageDays} days old and may no longer describe the company's current position.`);
  }
  if (input.freshness.overall === Freshness.UNKNOWN) {
    uncertainties.push("Reporting dates were unavailable, so the age of this evidence could not be established.");
  }
  const inLine = signals.filter(s => s.score === 0);
  for (const s of inLine) uncertainties.push(`${s.claim} — recorded, but not directional.`);

  return Object.freeze({
    ticker: input.ticker,
    direction,
    confidence,
    dataStatus: input.dataStatus,
    statusReasons: input.statusReasons,
    completeness: input.completeness,
    freshness: input.freshness,
    disagreement: allDisagreement,
    newsAvailability: input.newsEvidence ? input.newsEvidence.availability : null,
    newsFreshness: input.newsEvidence ? input.newsEvidence.freshness : null,
    recentEvents: input.newsEvidence ? input.newsEvidence.eventGroups : Object.freeze([]),
    contextualEvents: input.newsEvidence ? input.newsEvidence.contextualEvents : Object.freeze([]),
    irrelevantNewsCount: input.newsEvidence ? input.newsEvidence.irrelevantCount : 0,
    materialCatalysts: input.newsEvidence ? input.newsEvidence.materialCatalysts : Object.freeze([]),
    unknownImpactEvents: input.newsEvidence ? input.newsEvidence.unknownImpactEvents : Object.freeze([]),
    signals: Object.freeze(signals),
    lean: Number(lean.toFixed(4)),
    strongestSupporting: Object.freeze(strongestSupporting),
    strongestOpposing: Object.freeze(strongestOpposing),
    uncertainties: Object.freeze(uncertainties),
    missingEvidence: Object.freeze(missingEvidence),
    limitations: Object.freeze(limitations),
    source: input.source,
  });
}
