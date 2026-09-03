import { deriveTechnicalFacts } from "./deriveTechnicalFacts.js";
import { assessFreshness, assessCompleteness } from "../utils/dataQuality.js";
import { isSupportedUsEquity } from "../utils/supportedScope.js";

const MIN_POINTS_FOR_ANY_ANALYSIS = 5;
// Bump when calculation logic changes materially. Visible in every response's
// debug block, so a production request confirms which logic is deployed.
//   v1 -> v2: provisional (still-forming) daily bars no longer produce a
//             volume-vs-average comparison. See utils/marketSession.js.
const CALCULATION_VERSION = "war-technicals-v2";

/**
 * PIPELINE LAYER: War input assembler (final stage).
 *
 *   Provider response
 *     -> Normalised OHLCV        (src/schema/ohlcv.js, done by the provider adapter)
 *     -> Derived technical facts (src/technicals/deriveTechnicalFacts.js â€” pure calc)
 *     -> Data-quality assessment (src/utils/dataQuality.js â€” freshness/completeness)
 *     -> War input object        (this module â€” assembly + status decision only)
 *
 * No provider-specific field name is read past the normalisation layer â€”
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
 * (technicalFacts), or data quality (freshness/completeness) â€” without
 * needing to reproduce the original request.
 */
export function buildWarInput(series, { now = new Date() } = {}) {
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

  if (!series.source.simulated && !isSupportedUsEquity(series.source)) {
    return {
      ticker: series.ticker,
      dataStatus: "UNSUPPORTED_SECURITY",
      reason: "This phase supports US equities only. The provider did not report this security as a recognised US exchange listing.",
      source: series.source,
      debug: { calculationVersion: CALCULATION_VERSION, providerMeta: series.source.providerMeta },
    };
  }

  const technicalFacts = deriveTechnicalFacts(series, { now });

  const freshness = assessFreshness(technicalFacts.latestPoint);

  // Completeness answers "did we get the data we needed?". A suppressed
  // volume comparison during an open session is not a data shortfall â€” the
  // data is exactly as complete as it can be at that moment â€” so it is
  // excluded from the check rather than counted as missing. Counting it
  // would mark every intraday request PARTIAL_DATA, which would both
  // devalue that status (it exists to flag genuine gaps, e.g. no 200DMA
  // yet) and hide real problems behind an expected daily condition. The
  // condition is instead reported explicitly via latestBarIsProvisional
  // and volume.reason.
  const completenessInputs = {
    ma20: technicalFacts.movingAverages.ma20,
    ma50: technicalFacts.movingAverages.ma50,
    ma200: technicalFacts.movingAverages.ma200,
    rsi14: technicalFacts.rsi14,
    percentChange1d: technicalFacts.percentChange.oneDay,
    percentChange5d: technicalFacts.percentChange.fiveDay,
    percentChange20d: technicalFacts.percentChange.twentyDay,
    support: technicalFacts.supportResistance.support,
    resistance: technicalFacts.supportResistance.resistance,
  };
  if (!technicalFacts.latestBarIsProvisional) {
    completenessInputs.volumeAverage = technicalFacts.volume.average;
  }
  const completeness = assessCompleteness(completenessInputs);

  let dataStatus = "COMPLETE";
  if (freshness.status === "stale") dataStatus = "STALE_DATA";
  else if (completeness.missing.length > 0) dataStatus = "PARTIAL_DATA";

  return {
    ticker: series.ticker,
    companyName: series.companyName,
    dataStatus,
    latestPrice: technicalFacts.latestPrice,
    latestDataTimestamp: freshness.latestDataTimestamp,
    latestBarIsProvisional: technicalFacts.latestBarIsProvisional,
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
