import { sma, percentVsReference } from "./movingAverage.js";
import { percentChangeOverPeriods } from "./percentChange.js";
import { rsi } from "./rsi.js";
import { volumeVsAverage } from "./volume.js";
import { realisedVolatility } from "./volatility.js";
import { nearestSupportResistance } from "./supportResistance.js";
import { classifyTrend } from "./trend.js";

/**
 * PIPELINE LAYER: Derived technical facts.
 *
 *   Normalised OHLCV  --(this module)-->  technicalFacts  --(dataQuality.js + buildWarInput.js)--> War input
 *
 * Pure calculation only — this module makes no judgement about whether
 * the result is fresh, complete, or good enough to show anyone. That's
 * deliberately left to utils/dataQuality.js and technicals/buildWarInput.js
 * so a bug in "is this data good enough" can never be confused with a bug
 * in "is this number computed correctly."
 */
export function deriveTechnicalFacts(series) {
  const points = series.points;
  const closes = points.map(p => p.close);
  const highs = points.map(p => p.high);
  const lows = points.map(p => p.low);
  const volumes = points.map(p => p.volume);
  const latestPoint = points[points.length - 1];
  const latestPrice = latestPoint.close;

  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);

  const trend = classifyTrend({ price: latestPrice, ma20, ma50, ma200 });

  return {
    latestPrice,
    latestPoint,
    movingAverages: { ma20, ma50, ma200 },
    priceVsMa20Pct: percentVsReference(latestPrice, ma20),
    priceVsMa50Pct: percentVsReference(latestPrice, ma50),
    priceVsMa200Pct: percentVsReference(latestPrice, ma200),
    rsi14: rsi(closes, 14),
    percentChange: {
      oneDay: percentChangeOverPeriods(closes, 1),
      fiveDay: percentChangeOverPeriods(closes, 5),
      twentyDay: percentChangeOverPeriods(closes, 20),
    },
    volume: volumeVsAverage(volumes, 20),
    volatility: realisedVolatility(closes, 20),
    supportResistance: nearestSupportResistance(highs, lows, latestPrice),
    trend,
  };
}
