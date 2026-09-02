/**
 * SUPPORT / RESISTANCE — deterministic v1 algorithm.
 * ---------------------------------------------------------------------
 * Method: fractal swing pivots (the standard 5-bar fractal pattern), the
 * same well-known technique behind Bill Williams' Fractals indicator —
 * chosen over an ad-hoc min/max scan specifically because it's a named,
 * reproducible, widely-documented rule rather than an invented heuristic.
 *
 * DEFINITIONS (fixed constants, not tunable per-call, so a given OHLCV
 * input always produces the same output):
 *
 *   FRACTAL_WING = 2
 *     A bar at index i is a SWING HIGH if its high is strictly greater
 *     than the high of every bar in [i-2, i+2] except itself (a "5-bar
 *     fractal": 2 bars before, 2 bars after). A bar is a SWING LOW under
 *     the mirror rule on lows. Ties (an equal neighbour) do NOT count as
 *     a pivot — this keeps the rule unambiguous rather than needing a
 *     tie-breaking policy.
 *     Consequence: the most recent 2 bars can never be confirmed pivots
 *     yet, because there isn't enough future data to confirm them. This
 *     is intentional, not a bug — a real swing point cannot be confirmed
 *     until price has moved away from it on both sides.
 *
 *   LOOKBACK_DAYS = 60
 *     Only pivots found within the most recent 60 trading days are
 *     eligible to be reported as the "current" support/resistance.
 *     Older pivots are considered stale for this purpose.
 *
 * SELECTION RULE:
 *   - Nearest support = the highest-priced swing low that is still below
 *     the current price (i.e. the closest one underneath it).
 *   - Nearest resistance = the lowest-priced swing high that is still
 *     above the current price (i.e. the closest one above it).
 *   - FALLBACK (explicit, not a guess): if no qualifying swing low/high
 *     exists below/above the current price within the lookback window,
 *     fall back to the single lowest low / highest high in that same
 *     window, and mark the result as `fallback: true` so a caller can
 *     tell the difference between "a confirmed swing point" and "the
 *     deepest/highest print we happened to see."
 *
 * Requires at least LOOKBACK_DAYS + 2*FRACTAL_WING bars of history to run
 * at all; returns nulls with a reason otherwise rather than guessing.
 */

export const SUPPORT_RESISTANCE_PARAMS = Object.freeze({
  FRACTAL_WING: 2,
  LOOKBACK_DAYS: 60,
});

export function findFractalPivots(highs, lows, wing = SUPPORT_RESISTANCE_PARAMS.FRACTAL_WING) {
  const swingHighs = []; // { index, price }
  const swingLows = [];

  for (let i = wing; i < highs.length - wing; i++) {
    if (isStrictExtreme(highs, i, wing, "max")) {
      swingHighs.push({ index: i, price: highs[i] });
    }
    if (isStrictExtreme(lows, i, wing, "min")) {
      swingLows.push({ index: i, price: lows[i] });
    }
  }
  return { swingHighs, swingLows };
}

function isStrictExtreme(arr, i, wing, mode) {
  const center = arr[i];
  for (let j = i - wing; j <= i + wing; j++) {
    if (j === i) continue;
    if (mode === "max" && arr[j] >= center) return false;
    if (mode === "min" && arr[j] <= center) return false;
  }
  return true;
}

export function nearestSupportResistance(highs, lows, currentPrice, params = SUPPORT_RESISTANCE_PARAMS) {
  const { FRACTAL_WING: wing, LOOKBACK_DAYS: lookback } = params;

  if (!Array.isArray(highs) || !Array.isArray(lows) || highs.length !== lows.length) {
    return { support: null, resistance: null, reason: "highs/lows missing or misaligned" };
  }
  if (highs.length < lookback + 2 * wing) {
    return {
      support: null,
      resistance: null,
      reason: `Need at least ${lookback + 2 * wing} bars for a ${lookback}-day lookback with a ${wing}-bar fractal wing; got ${highs.length}.`,
    };
  }

  const { swingHighs, swingLows } = findFractalPivots(highs, lows, wing);

  const windowStart = highs.length - lookback;
  const recentHighs = swingHighs.filter(p => p.index >= windowStart);
  const recentLows = swingLows.filter(p => p.index >= windowStart);

  const belowPrice = recentLows.filter(p => p.price < currentPrice);
  const abovePrice = recentHighs.filter(p => p.price > currentPrice);

  let support, supportFallback;
  if (belowPrice.length) {
    support = Math.max(...belowPrice.map(p => p.price));
    supportFallback = false;
  } else {
    support = Math.min(...lows.slice(windowStart));
    supportFallback = true;
  }

  let resistance, resistanceFallback;
  if (abovePrice.length) {
    resistance = Math.min(...abovePrice.map(p => p.price));
    resistanceFallback = false;
  } else {
    resistance = Math.max(...highs.slice(windowStart));
    resistanceFallback = true;
  }

  return {
    support,
    resistance,
    supportIsFallback: supportFallback,
    resistanceIsFallback: resistanceFallback,
    confirmedSwingHighsInWindow: recentHighs.length,
    confirmedSwingLowsInWindow: recentLows.length,
  };
}
