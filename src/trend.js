/**
 * TREND CLASSIFICATION — deterministic v1 rules.
 * ---------------------------------------------------------------------
 * Inputs: latest price, MA20, MA50, and optionally MA200.
 *
 * DEFINITIONS (named constants, not hidden inside conditionals):
 *
 *   MIN_STACK_SEPARATION_PCT = 0.5
 *     MA20 and MA50 must differ by at least this percentage (of MA50)
 *     for their ordering to count as meaningful. Without a minimum
 *     separation, two averages sitting within noise of each other would
 *     flip the classification on trivial daily wiggle — which is exactly
 *     the "hidden judgement inside vague indicator combinations" this
 *     module is meant to avoid.
 *
 * RULE (evaluated in this order):
 *
 *   1. BULLISH  if price > MA20  AND  MA20 > MA50  AND
 *               (MA20 - MA50) / MA50 * 100 >= MIN_STACK_SEPARATION_PCT
 *
 *   2. BEARISH  if price < MA20  AND  MA20 < MA50  AND
 *               (MA50 - MA20) / MA50 * 100 >= MIN_STACK_SEPARATION_PCT
 *
 *   3. NEUTRAL  in every other case — this explicitly includes: mixed
 *      stacking (e.g. price above MA20 but MA20 below MA50), and cases
 *      where MA20/MA50 are within MIN_STACK_SEPARATION_PCT of each other
 *      even if price sits cleanly on one side.
 *
 * MA200 CONFIRMATION (reported separately, never overrides the primary
 * call above):
 *   - For a BULLISH read: `longTermConfirmation: "confirmed"` if
 *     MA50 > MA200, else `"early"` (short/medium trend is up, but the
 *     long-term average hasn't caught up yet).
 *   - For a BEARISH read: mirrored, using MA50 < MA200 for "confirmed".
 *   - `null` if MA200 is unavailable (insufficient history) — reported
 *     as unavailable, never guessed.
 *
 * Requires price, MA20 and MA50 to classify at all; returns "Insufficient
 * data" otherwise rather than defaulting to Neutral (Neutral is a real
 * judgement about the evidence; "insufficient data" is the absence of
 * evidence, and the two must not be conflated).
 */

export const TREND_PARAMS = Object.freeze({
  MIN_STACK_SEPARATION_PCT: 0.5,
});

export function classifyTrend({ price, ma20, ma50, ma200 }, params = TREND_PARAMS) {
  if (price === null || ma20 === null || ma50 === null) {
    return { classification: "Insufficient data", longTermConfirmation: null, detail: null };
  }

  const separationPct = ((ma20 - ma50) / ma50) * 100; // positive => MA20 above MA50
  const { MIN_STACK_SEPARATION_PCT } = params;

  let classification = "Neutral";
  if (price > ma20 && ma20 > ma50 && separationPct >= MIN_STACK_SEPARATION_PCT) {
    classification = "Bullish";
  } else if (price < ma20 && ma20 < ma50 && -separationPct >= MIN_STACK_SEPARATION_PCT) {
    classification = "Bearish";
  }

  let longTermConfirmation = null;
  if (ma200 !== null) {
    if (classification === "Bullish") longTermConfirmation = ma50 > ma200 ? "confirmed" : "early";
    else if (classification === "Bearish") longTermConfirmation = ma50 < ma200 ? "confirmed" : "early";
  }

  return {
    classification,
    longTermConfirmation,
    detail: { priceVsMa20Pct: ((price - ma20) / ma20) * 100, ma20VsMa50Pct: separationPct },
  };
}
