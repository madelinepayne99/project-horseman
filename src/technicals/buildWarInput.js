import { deriveTechnicalFacts } from "./deriveTechnicalFacts.js";
import { assessFreshness, assessCompleteness } from "../utils/dataQuality.js";
import { isSupportedUsEquity } from "../utils/supportedScope.js";

const MIN_POINTS_FOR_ANY_ANALYSIS = 5;
const CALCULATION_VERSION = "war-technicals-v1"; // bump when calculation logic changes materially

/**
 * PIPELINE LAYER: War input assembler (final stage).
 *
 *   Provider response
 *     -> Normalised OHLCV        (src/schema/ohlcv.js, done by the provider adapter)
 *     -> Derived technical facts (src/technicals/deriveTechnicalFacts.js — pure calc)
 *     -> Data-quality assessment (src/utils/dataQuality.js — freshness/completeness)
 *     -> War input object        (this module — assembly + status decision only)
 *
 * No provider-specific field name is read past the normalisation layer —
 * this module only ever touches `series.points`, `series.source`, and the
 * output of deriveTechnicalFacts(). If Twelve Data is swapped for another
 * provider, nothing below the adapter needs to change.
 *
 * dataStatus values (mutually exclusive, checked in this order):
 *   INSUFFICIENT_EVIDENCE  - too few data points to analyse at all
 *   UNSUPPORTED_SECURITY   - real data, but outside this phase's US-equity
 *                            scope (see utils/supportedScope.js). Never
 *                            silently swapped for simulated data.
 *   STALE_DATA             - enough data, but the latest point is too old
 *   PARTIAL_DATA           - fresh enough, but one or more indicators
 *                            couldn't be computed (e.g. no 200DMA yet)
 *   COMPLETE               - fresh and every indicator computed
 *
 * The `debug` block is preserved specifically so an incorrect War result
 * can be traced to its layer: provider (source/providerMeta), calculation
 * (technicalFacts), or data quality (freshness/completeness) — without
 * needing to reproduce the original request.
 */
export function buildWarInput(series) {
  const points = series.points;

  if (!points || points.length < MIN_POINTS_FOR_ANY_ANALYSIS) {
    return {
      ticker: series.ticker,
      dataStatus: "INSUFFICIENT_EVIDENCE",
      reason: `Only ${points ? points.length : 0} data point(s) available; need at least ${MIN_POINTS_FOR_ANY_ANALYSIS}.`,
      source: series.source,
      debug: { calculationVersion: CALCULATION_VERSION },
    };
  }

  if (!series.source.simulated && !isSupportedUsEquity(series.source.providerMeta)) {
    return {
      ticker: series.ticker,
      dataStatus: "UNSUPPORTED_SECURITY",
      reason: "This phase supports US equities only. The provider did not report this security as a recognised US exchange listing.",
      source: series.source,
      debug: { calculationVersion: CALCULATION_VERSION, providerMeta: series.source.providerMeta },
    };
  }

  const technicalFacts = deriveTechnicalFacts(series);

  const freshness = assessFreshness(technicalFacts.latestPoint);
  const completeness = assessCompleteness({
    ma20: technicalFacts.movingAverages.ma20,
    ma50: technicalFacts.movingAverages.ma50,
    ma200: technicalFacts.movingAverages.ma200,
    rsi14: technicalFacts.rsi14,
    percentChange1d: technicalFacts.percentChange.oneDay,
    percentChange5d: technicalFacts.percentChange.fiveDay,
    percentChange20d: technicalFacts.percentChange.twentyDay,
    volumeAverage: technicalFacts.volume.average,
    support: technicalFacts.supportResistance.support,
    resistance: technicalFacts.supportResistance.resistance,
  });

  let dataStatus = "COMPLETE";
  if (freshness.status === "stale") dataStatus = "STALE_DATA";
  else if (completeness.missing.length > 0) dataStatus = "PARTIAL_DATA";

  return {
    ticker: series.ticker,
    companyName: series.companyName,
    dataStatus,
    latestPrice: technicalFacts.latestPrice,
    latestDataTimestamp: freshness.latestDataTimestamp,
    freshness,
    completeness,
    trend: technicalFacts.trend,
    priceVsMa20Pct: technicalFacts.priceVsMa20Pct,
    priceVsMa50Pct: technicalFacts.priceVsMa50Pct,
    priceVsMa200Pct: technicalFacts.priceVsMa200Pct,
    movingAverages: technicalFacts.movingAverages,
    rsi14: technicalFacts.rsi14,
    percentChange: technicalFacts.percentChange,
    volume: technicalFacts.volume,
    volatility: technicalFacts.volatility,
    supportResistance: technicalFacts.supportResistance,
    dataPointsUsed: points.length,
    source: series.source,
    debug: {
      calculationVersion: CALCULATION_VERSION,
      oldestDate: points[0].date,
      newestDate: points[points.length - 1].date,
      providerMeta: series.source.providerMeta,
      technicalFacts,
      freshness,
      completeness,
    },
  };
}
