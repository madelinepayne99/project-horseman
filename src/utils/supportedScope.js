/**
 * SUPPORTED SCOPE — US equities only, for this phase.
 * ---------------------------------------------------------------------
 * Deliberately NOT solved by pattern-matching the ticker string (e.g.
 * rejecting anything containing "."), because that would misclassify
 * real US securities like "BRK.B" (Berkshire Hathaway class B, NYSE).
 * Instead this checks what the provider itself reported about the
 * instrument it actually matched.
 *
 * A series is in-scope if the provider's metadata reports:
 *   - country === "United States", OR
 *   - exchange is one of ALLOWED_EXCHANGES
 * (either signal is sufficient; providers don't always populate both).
 *
 * If the provider returned no usable exchange/country info at all, the
 * security is treated as UNSUPPORTED rather than assumed to be in-scope —
 * silence is not evidence of eligibility.
 *
 * This check only applies to real (non-simulated) series. Simulated/demo
 * data is a separate explicit mode (see SimulatedProvider) and isn't
 * bound by real-market scope rules.
 */

export const ALLOWED_EXCHANGES = Object.freeze([
  "NASDAQ", "NYSE", "NYSE ARCA", "NYSE MKT", "AMEX", "BATS", "CBOE", "IEX",
]);

export function isSupportedUsEquity(providerMeta) {
  if (!providerMeta) return false;

  const country = normalise(providerMeta.country);
  const exchange = normalise(providerMeta.exchange);

  if (country === "united states") return true;
  if (exchange && ALLOWED_EXCHANGES.some(e => normalise(e) === exchange)) return true;

  return false;
}

function normalise(v) {
  return typeof v === "string" ? v.trim().toLowerCase() : null;
}
