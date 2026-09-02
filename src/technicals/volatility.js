/**
 * Realised volatility: standard deviation of daily log returns over the
 * trailing `period` days, annualised by sqrt(252) and expressed as a
 * percentage. This is a standard, widely-used definition — chosen over
 * something bespoke so the number means the same thing a chart platform's
 * "historical volatility" would show.
 *
 * Classification thresholds below are a first-pass heuristic, not a
 * statistically derived cutoff — they are named constants specifically so
 * a future Council-facing explanation can say *why* a volatility reading
 * was classified a given way, rather than hiding a magic number.
 */
const CLASSIFICATION_THRESHOLDS = Object.freeze({
  LOW_MAX: 20,       // annualised realised vol below this -> "Low"
  MODERATE_MAX: 40,  // below this -> "Moderate"; at/above -> "Elevated"
});

export function realisedVolatility(closes, period = 20) {
  if (!Array.isArray(closes) || closes.length < period + 1) {
    return { annualisedPct: null, classification: null };
  }
  const window = closes.slice(closes.length - 1 - period);
  const logReturns = [];
  for (let i = 1; i < window.length; i++) {
    if (window[i - 1] <= 0 || window[i] <= 0) continue;
    logReturns.push(Math.log(window[i] / window[i - 1]));
  }
  if (logReturns.length < 2) return { annualisedPct: null, classification: null };

  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (logReturns.length - 1);
  const dailyStdDev = Math.sqrt(variance);
  const annualisedPct = dailyStdDev * Math.sqrt(252) * 100;

  return { annualisedPct, classification: classify(annualisedPct) };
}

function classify(annualisedPct) {
  if (annualisedPct < CLASSIFICATION_THRESHOLDS.LOW_MAX) return "Low";
  if (annualisedPct < CLASSIFICATION_THRESHOLDS.MODERATE_MAX) return "Moderate";
  return "Elevated";
}

export const VOLATILITY_CLASSIFICATION_THRESHOLDS = CLASSIFICATION_THRESHOLDS;
