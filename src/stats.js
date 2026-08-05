// Career stats, kept locally.
//
// Cloudflare Web Analytics cannot store a score (no custom events), so the
// scoreboard lives here in localStorage. This is also the half that keeps
// working offline, from file://, and with the beacon blocked -- which is how
// most people will actually play this.

const KEY = 'spacescience.stats';
const TOP_N = 5;

const EMPTY = {
  games: 0,          // runs finished
  totalMs: 0,        // time actually spent playing, not idling on the menu
  bestScore: 0,
  bestWave: 1,
  bestChain: 0,
  ffBurned: 0,
  cellsFused: 0,
  wavesCleared: 0,
  top: []            // [{ score, wave, ff, at }]
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const v = JSON.parse(raw);
    return { ...EMPTY, ...v, top: Array.isArray(v.top) ? v.top : [] };
  } catch (e) {
    return { ...EMPTY };            // corrupt or unavailable: start clean
  }
}

function write(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); }
  catch (e) { /* private mode / file:// - stats just do not persist */ }
}

export const STATS = read();

// Called every frame while a run is live.
export function addPlaytime(ms) {
  STATS.totalMs += ms;
}

export function noteWaveCleared() {
  STATS.wavesCleared++;
}

// One finished run.
export function recordRun(run) {
  STATS.games++;
  STATS.ffBurned += run.ff;
  STATS.cellsFused += run.fused;
  if (run.score > STATS.bestScore) STATS.bestScore = run.score;
  if (run.wave > STATS.bestWave) STATS.bestWave = run.wave;
  if (run.chain > STATS.bestChain) STATS.bestChain = run.chain;

  STATS.top.push({ score: run.score, wave: run.wave, ff: run.ff, at: run.at });
  STATS.top.sort((a, b) => b.score - a.score);
  STATS.top.length = Math.min(STATS.top.length, TOP_N);
  write(STATS);
}

export function flushStats() { write(STATS); }

export function clearStats() {
  Object.assign(STATS, EMPTY, { top: [] });
  write(STATS);
}

// 1h 04m / 7m 12s / 42s
export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return m + 'm ' + String(rs).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
}
