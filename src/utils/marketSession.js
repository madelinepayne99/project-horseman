/**
 * Provisional-bar detection.
 *
 * A daily OHLCV bar dated *today* is still being built while the exchange
 * is open: its close will move and â€” the reason this module exists â€” its
 * volume is only the volume accumulated so far. Comparing a part-day
 * volume against a trailing average of *full* days produces a number that
 * is arithmetically correct and analytically meaningless.
 *
 * Observed in production on 2026-09-02: AAPL's latest bar reported
 * 973,020 shares against a 20-day average of 40.6M â€” i.e. "-97.6% vs
 * average" â€” purely because the request happened at 14:33 America/New_York,
 * roughly 1.5 hours before the close. A second provider (Yahoo, via
 * api/analyse.js) reported 0.55x for the same instant, because providers
 * accumulate intraday volume at different rates. Neither figure described
 * a real collapse in participation.
 *
 * This module answers only one question â€” "is the latest bar still
 * forming?" â€” and makes no decision about what to do about it. The
 * consequences live in deriveTechnicalFacts.js (suppress the volume
 * comparison) and buildWarInput.js (surface the flag), keeping detection
 * separately testable from policy.
 */

// Regular US equity session close. Twelve Data's daily bars are regular-session
// bars, so post-market prints are not what makes a bar provisional here.
const SESSION_CLOSE_HOUR = 16; // 16:00 in the exchange's own timezone

// Grace period after the close before a bar is treated as final. The closing
// auction and the provider's own aggregation both take a few minutes to
// settle, so a bar read at 16:01 may still be incomplete.
const POST_CLOSE_SETTLE_MINUTES = 20;

// This phase is gated to US equities (see supportedScope.js), so this is a
// safe fallback when the canonical exchangeTimezone is absent, rather than
// a guess about an arbitrary venue.
const DEFAULT_EXCHANGE_TIMEZONE = "America/New_York";

/**
 * Returns the wall-clock date and time at a given IANA timezone.
 * Uses Intl rather than any date library â€” no dependencies, and Node's
 * full-ICU build (Node 20+ on Vercel, and locally) resolves real zone
 * rules including DST transitions.
 *
 * @returns {{date: string, hour: number, minute: number} | null}
 *   date is "YYYY-MM-DD"; null if the timezone is unusable.
 */
export function wallClockAt(timeZone, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now);

    const get = type => parts.find(p => p.type === type)?.value;
    const year = get("year"), month = get("month"), day = get("day");
    if (!year || !month || !day) return null;

    // Intl can render midnight as "24" in some locales/zones; normalise it.
    const hour = parseInt(get("hour"), 10) % 24;
    const minute = parseInt(get("minute"), 10);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;

    return { date: `${year}-${month}-${day}`, hour, minute };
  } catch {
    return null; // invalid/unknown timezone
  }
}

/**
 * Is the latest daily bar still forming?
 *
 * True only when the bar is dated today *in the exchange's own timezone*
 * and the session has not yet closed (plus the settle grace period).
 *
 * Deliberately returns false â€” treating the bar as final â€” when the answer
 * can't be established (missing bar date, unusable timezone). A wrongly
 * suppressed volume comparison silently removes real information; a
 * wrongly kept one is at least visible and traceable in the debug block.
 *
 * Weekends, holidays, and any pre-open request are handled implicitly: the
 * latest available bar is dated earlier than today, so it isn't provisional.
 *
 * @param {{ date?: string }} latestPoint - the newest normalised OHLCV point
 * @param {object|null} marketMeta - canonical market metadata from
 *   series.source (may carry exchangeTimezone). Provider-neutral: each
 *   adapter translates its own vendor field names into this at the
 *   normalisation boundary.
 * @param {Date} [now] - injectable for testing
 */
export function isProvisionalBar(latestPoint, marketMeta, now = new Date()) {
  const barDate = latestPoint?.date;
  if (!barDate) return false;

  const timeZone = marketMeta?.exchangeTimezone || DEFAULT_EXCHANGE_TIMEZONE;
  const wall = wallClockAt(timeZone, now);
  if (!wall) return false;

  if (barDate !== wall.date) return false; // not today's bar -> already final

  const minutesNow = wall.hour * 60 + wall.minute;
  const minutesFinal = SESSION_CLOSE_HOUR * 60 + POST_CLOSE_SETTLE_MINUTES;
  return minutesNow < minutesFinal;
}

export const PROVISIONAL_BAR_CONFIG = Object.freeze({
  SESSION_CLOSE_HOUR,
  POST_CLOSE_SETTLE_MINUTES,
  DEFAULT_EXCHANGE_TIMEZONE,
});
