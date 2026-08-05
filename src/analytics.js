// Cloudflare Web Analytics reporting.
//
// Read this before adding a metric, because CF's beacon is far more limited
// than most analytics SDKs:
//
//   * There is NO custom-event API. Cloudflare's own FAQ: "Not yet, but we may
//     add support for this in the future." You cannot send a score as data.
//   * Query strings are deliberately NOT logged, so `?score=1234` is dropped.
//   * What it does offer is SPA tracking: the beacon overrides
//     history.pushState and records a pageview for whatever path you push.
//
// So every finding is encoded as a short virtual PATH, which shows up in the
// dashboard's page list. The real URL is restored immediately with
// replaceState (which the beacon does not hook), otherwise the address bar
// would hold a path that 404s on refresh and the #seed would be lost.
//
// Consequences worth knowing:
//   * Paths must be LOW CARDINALITY. Exact scores would produce thousands of
//     one-hit rows, so everything is bucketed.
//   * This only works over http(s). Opened from file:// there is no origin to
//     beacon from, so reporting silently disables itself.
//   * static.cloudflareinsights.com is a common ad-block target, so treat all
//     numbers as a floor, not a count.

const PREFIX = '/_ss';

function usable() {
  try {
    // file:// has no usable origin for the beacon, and pushState throws there.
    if (!/^https?:$/.test(location.protocol)) return false;
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1' ||
      navigator.msDoNotTrack === '1') return false;
    return typeof history.pushState === 'function';
  } catch (e) {
    return false;
  }
}

export const ANALYTICS = { enabled: usable(), sent: 0, last: '', trail: [] };

// A single game event can reach the reporter twice through adjacent state
// transitions, but the same bucket can also be earned legitimately later (all
// waves from 15 onward share one path, for example). Suppress only a short
// per-path burst instead of suppressing that path until some other event fires.
const ANALYTICS_DEDUPE_MS = 1000;
const ANALYTICS_RECENT = new Map();

export function track(path) {
  if (!ANALYTICS.enabled) return;
  const now = performance.now();
  const previous = ANALYTICS_RECENT.get(path);
  if (previous !== undefined && now - previous < ANALYTICS_DEDUPE_MS) return;
  ANALYTICS_RECENT.set(path, now);
  ANALYTICS.last = path;
  ANALYTICS.sent++;
  if (ANALYTICS.trail.length < 40) ANALYTICS.trail.push(path);
  const real = location.pathname + location.search + location.hash;
  try {
    history.pushState(null, '', PREFIX + path);
    history.replaceState(null, '', real);
  } catch (e) {
    ANALYTICS.enabled = false;      // never let reporting break the game
  }
}

/* ---------------------------------------------------------------- buckets */
// Bounded label sets, so the dashboard stays readable.
export function scoreBucket(n) {
  if (n < 1000) return 'under-1k';
  if (n < 5000) return '1k-5k';
  if (n < 20000) return '5k-20k';
  if (n < 50000) return '20k-50k';
  if (n < 100000) return '50k-100k';
  if (n < 250000) return '100k-250k';
  return 'over-250k';
}

export function waveBucket(w) { return w >= 15 ? '15plus' : String(w); }

// Minute marks worth knowing about: did they bounce, or settle in?
const MINUTE_MARKS = [1, 3, 5, 10, 20, 30, 45, 60];
let markIndex = 0;
let playtimeLastMs = 0;
let playtimePrimed = false;

// Career playtime survives reloads. Prime the cursor from that persisted total
// without reporting old thresholds again; only crossings made while this page
// is alive should become new virtual pageviews.
export function primePlaytimeMarks(totalMs) {
  const safe = Number.isFinite(totalMs) && totalMs >= 0 ? totalMs : 0;
  markIndex = 0;
  while (markIndex < MINUTE_MARKS.length &&
    safe >= MINUTE_MARKS[markIndex] * 60000) markIndex++;
  playtimeLastMs = safe;
  playtimePrimed = true;
}

export function trackPlaytime(totalMs) {
  if (!Number.isFinite(totalMs) || totalMs < 0) return;
  if (!playtimePrimed) { primePlaytimeMarks(totalMs); return; }
  // Clearing career stats starts a genuinely new lifetime.
  if (totalMs < playtimeLastMs) { primePlaytimeMarks(totalMs); return; }
  const mins = totalMs / 60000;
  while (markIndex < MINUTE_MARKS.length && mins >= MINUTE_MARKS[markIndex]) {
    track('/played/' + MINUTE_MARKS[markIndex] + 'm');
    markIndex++;
  }
  playtimeLastMs = totalMs;
}

// Kept as the run-lifecycle hook used by game.js. These are career milestones,
// not per-run milestones, so starting or resuming a run must not rewind them.
export function resetPlaytimeMarks() {}
