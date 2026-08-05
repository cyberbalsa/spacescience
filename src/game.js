import {
  R, COLS, ROWH, PF_X, PF_W, PF_TOP, DANGER_Y, DANGER_ROW, LAUNCH, SPEED, AIM_LIMIT, VW,
  TIERS, FULL, OVERFLOW, waveRows, waveShots, waveSeeds,
  baseEntropy, holeRate, dudChance, flatOdds,
  HYPER_SHOTS, HYPER_ROWS, HYPER_MULT,
  PTS_FUSE, PTS_OVERFLOW, PTS_DROP, PTS_WAVE
} from './config.js';
import { clamp, vcol, hexLabel } from './util.js';
import { RNG, setSeed, random, randInt, choose, getRngState, setRngState } from './rng.js';
import { burst, sparks, popText, clearFX, blast, bump } from './fx.js';
import { Snd } from './audio.js';
import { onEvent as say, CTX, resetCommentary, observe } from './commentary.js';
import { track, scoreBucket, waveBucket, resetPlaytimeMarks } from './analytics.js';
import { STATS, recordRun, noteWaveCleared, flushStats } from './stats.js';
import { writeSave, readSave, clearSave } from './save.js';

// Firefox can throw SecurityError for localStorage on a file:// origin, and
// Safari does the same in private mode. A missing high score is not worth
// taking the whole game down for.
function loadBest() {
  try { return +(localStorage.getItem('spacescience.best') || 0) || 0; }
  catch (e) { return 0; }
}
function saveBest(n) {
  try { localStorage.setItem('spacescience.best', String(n)); }
  catch (e) { /* no persistence available */ }
}

export const G = {
  grid: [],           // grid[row][col] = {v, pop, born} | null
  parity: 0,          // flips whenever a row is pushed in at the top
  ball: null,
  next: [], cur: TIERS[0],
  angle: -Math.PI / 2,
  score: 0,
  best: loadBest(),
  level: 1, shotsPerRow: waveShots(1),
  combo: 0, bestCombo: 0,
  shots: 0, merges: 0, bytes: 0, maxTile: TIERS[0],
  state: 'title',     // title | play | pause | clear | over
  over: 0,            // game-over animation progress
  clearAnim: 0,       // wave-clear interstitial progress
  lastBonus: 0,
  pushAnim: 0,        // 1 -> 0 as a freshly pushed row slides down
  pendingPush: false,
  charge: 0, warpReady: false,
  coin: false,        // audio woken on the title screen
  funFact: false,     // easter egg card, F key
  hyper: false,       // konami mode: entropy pinned to max
  dud: false,         // chambered value matches nothing on an edge
  dudStreak: 0,
  startedAt: 0,
  tick: 0
};

/* ------------------------------------------------------------ grid basics */
// Even-parity rows hold COLS cells flush left; odd-parity rows hold COLS-1
// cells indented by one radius. Pushing a row flips the parity of every index
// at once, which is why parity is a global offset rather than per-row state.
export const par = r => (r + G.parity) & 1;
export const rowCols = r => (par(r) ? COLS - 1 : COLS);
export const cellX = (r, c) => PF_X + R + (par(r) ? R : 0) + c * 2 * R;
export const cellY = r => PF_TOP + R + r * ROWH;
export const rowShift = () => -G.pushAnim * ROWH;

export function ensureRow(r) {
  while (G.grid.length <= r) G.grid.push(new Array(rowCols(G.grid.length)).fill(null));
}

export function at(r, c) {
  if (r < 0 || r >= G.grid.length) return null;
  const row = G.grid[r];
  if (c < 0 || c >= row.length) return null;
  return row[c];
}

const NB_ODD = [[0, -1], [0, 1], [-1, 0], [-1, 1], [1, 0], [1, 1]];
const NB_EVEN = [[0, -1], [0, 1], [-1, -1], [-1, 0], [1, -1], [1, 0]];

export function neighbors(r, c) {
  const o = par(r) ? NB_ODD : NB_EVEN;
  const out = [];
  for (const [dr, dc] of o) {
    const rr = r + dr, cc = c + dc;
    if (rr < 0 || rr >= G.grid.length) continue;
    if (cc < 0 || cc >= G.grid[rr].length) continue;
    out.push([rr, cc]);
  }
  return out;
}

// An orb is on an edge if a shot could physically reach it: it has an empty
// neighbour, or open space below the bottom of the stack. Side walls and the
// ceiling do not count as openings.
export function isEdge(r, c) {
  const o = par(r) ? NB_ODD : NB_EVEN;
  for (const [dr, dc] of o) {
    const rr = r + dr, cc = c + dc;
    if (rr < 0) continue;
    if (rr >= G.grid.length) return true;
    if (cc < 0 || cc >= G.grid[rr].length) continue;
    if (!G.grid[rr][cc]) return true;
  }
  return false;
}

export function boardValues() {
  const m = new Map();
  for (const row of G.grid)
    for (const b of row)
      if (b) m.set(b.v, (m.get(b.v) || 0) + 1);
  return m;
}

// The cannon may only load a value that is currently sitting on an exposed
// edge. Bury the last 01 behind a wall of 20s and 01 stops being offered.
export function edgeValues() {
  const m = new Map();
  for (let r = 0; r < G.grid.length; r++) {
    const row = G.grid[r];
    for (let c = 0; c < row.length; c++) {
      if (!row[c] || !isEdge(r, c)) continue;
      m.set(row[c].v, (m.get(row[c].v) || 0) + 1);
    }
  }
  return m;
}

export function boardEmpty() {
  for (const row of G.grid) for (const b of row) if (b) return false;
  return true;
}

// Weighted by how much of each value is actually exposed, so ammo tracks what
// is reachable rather than what merely exists.
export function spawnValue() {
  const m = edgeValues();
  if (!m.size) return TIERS[0];

  // The dud. Late waves stop guaranteeing the cannon gives you something you
  // can actually reach: you get a buried value, or a tier that is not on the
  // board at all. It is not wasted -- two duds of a kind still pair -- but
  // stack them carelessly and they clog the lattice.
  if (random() < dudChance(entropy())) {
    const all = [...boardValues().keys()].filter(v => !m.has(v));
    const pool = all.length ? all : waveSeeds(G.level, entropy()).filter(v => !m.has(v));
    if (pool.length) return choose(pool);
  }

  // Entropy also erodes the bias toward whatever is most exposed.
  if (random() < flatOdds(entropy())) return choose([...m.keys()]);

  let total = 0;
  for (const n of m.values()) total += n;
  let x = random() * total;
  let lastV = TIERS[0];
  for (const [v, n] of m) {
    lastV = v;
    x -= n;
    if (x <= 0) return v;
  }
  return lastV;
}

// Drop any queued orb whose value is no longer reachable.
function refreshAmmo() {
  const m = edgeValues();
  if (!m.size) return;
  G.dud = !m.has(G.cur);
  // Below the dud threshold the cannon still promises usable ammo, so stale
  // values get re-rolled. Above it, being handed junk is the whole point.
  if (dudChance(entropy()) > 0) return;
  if (!m.has(G.cur)) G.cur = spawnValue();
  for (let i = 0; i < G.next.length; i++)
    if (!m.has(G.next[i])) G.next[i] = spawnValue();
}

// How weird this wave is allowed to be. Hyper mode pins it at maximum.
export const entropy = () => (G.hyper ? 1 : baseEntropy(G.level));

const orb = v => ({ v, pop: 1, born: G.tick });

// Lower tiers stay common so there is always something cheap to build on.
function wavePool(lvl) {
  const t = waveSeeds(lvl, entropy());
  const pool = [];
  t.forEach((v, i) => {
    const n = Math.max(1, t.length - i);
    for (let k = 0; k < n; k++) pool.push(v);
  });
  return pool;
}

/* ------------------------------------------------------ board generators */
// Wave 1 always gets `uniform`. As entropy climbs the exotic layouts take
// over, and they are deliberately awkward: bands and veins make big same-value
// clumps that collapse in one go and leave nothing behind, while scatter
// strands single orbs you have to manufacture partners for.

function uniform(rows, tiers, hole) {
  const pool = wavePool(G.level);
  for (let r = 0; r < rows; r++) {
    ensureRow(r);
    for (let c = 0; c < G.grid[r].length; c++)
      if (random() >= hole) G.grid[r][c] = orb(choose(pool));
  }
}

function strata(rows, tiers, hole) {
  for (let r = 0; r < rows; r++) {
    ensureRow(r);
    const a = choose(tiers), b = choose(tiers);
    for (let c = 0; c < G.grid[r].length; c++)
      if (random() >= hole) G.grid[r][c] = orb(random() < 0.75 ? a : b);
  }
}

function veins(rows, tiers, hole) {
  uniform(rows, tiers, Math.min(0.55, hole + 0.2));
  for (let i = 0, n = 2 + randInt(3); i < n; i++) {
    const v = choose(tiers);
    let r = randInt(rows), c = randInt(G.grid[Math.min(r, G.grid.length - 1)].length);
    for (let step = 0, len = 4 + randInt(6); step < len; step++) {
      if (r < 0 || r >= rows) break;
      ensureRow(r);
      if (c >= 0 && c < G.grid[r].length) G.grid[r][c] = orb(v);
      const nb = neighbors(r, c).filter(([nr]) => nr < rows);
      if (!nb.length) break;
      [r, c] = choose(nb);
    }
  }
}

function scatter(rows, tiers, hole) {
  // flat distribution, lots of gaps: maximum orphans
  const h = Math.min(0.5, hole + 0.18);
  for (let r = 0; r < rows; r++) {
    ensureRow(r);
    for (let c = 0; c < G.grid[r].length; c++)
      if (random() >= h) G.grid[r][c] = orb(choose(tiers));
  }
}

function checker(rows, tiers, hole) {
  const a = choose(tiers);
  const rest = tiers.filter(v => v !== a);
  const b = rest.length ? choose(rest) : a;
  for (let r = 0; r < rows; r++) {
    ensureRow(r);
    for (let c = 0; c < G.grid[r].length; c++)
      if (random() >= hole) G.grid[r][c] = orb(((r + c) & 1) ? a : b);
  }
}

const EXOTIC = [strata, veins, scatter, checker];

// Lone high bytes, dropped in with no partner anywhere on the board. Dead
// weight until you climb a whole ladder to match them.
function spikes(rows, tiers, n) {
  const high = tiers.slice(-3);
  if (!high.length) return;
  for (let i = 0; i < n; i++) {
    const r = randInt(rows);
    ensureRow(r);
    G.grid[r][randInt(G.grid[r].length)] = orb(choose(high));
  }
}

function generateBoard() {
  const e = entropy();
  const rows = Math.min(DANGER_ROW - 2, waveRows(G.level) + (G.hyper ? HYPER_ROWS : 0));
  const tiers = waveSeeds(G.level, entropy());
  const gen = random() < e ? choose(EXOTIC) : uniform;
  gen(rows, tiers, holeRate(e));
  if (random() < e) spikes(rows, tiers, 1 + randInt(3));
}

function loadWave() {
  TURN.live = false;
  G.grid = [];
  G.parity = 0;
  G.shots = 0;
  G.pendingPush = false;
  G.pushAnim = 0;
  G.ball = null;
  G.shotsPerRow = G.hyper ? HYPER_SHOTS : waveShots(G.level);
  generateBoard();
  G.next = [spawnValue(), spawnValue()];
  G.cur = spawnValue();
  updateCommentaryContext();
}

export function toggleHyper() {
  G.hyper = !G.hyper;
  if (G.hyper) track('/hyper');
  G.shotsPerRow = G.hyper ? HYPER_SHOTS : waveShots(G.level);
  say('hyper', { on: G.hyper });
  bump('flash', 1); bump('glitch', 1); bump('shake', 28);
  Snd.fx(G.hyper ? 'overflow' : 'drop');
  updateCommentaryContext();
}

export function newGame() {
  // Restart the stream so the same seed replays the same run.
  setSeed(RNG.seed);
  G.score = 0; G.combo = 0; G.bestCombo = 0;
  G.merges = 0; G.bytes = 0; G.maxTile = TIERS[0];
  G.level = 1; G.over = 0; G.clearAnim = 0; G.lastBonus = 0;
  G.charge = 0; G.warpReady = false; G.dudStreak = 0;
  G.hyper = false;
  G.startedAt = Date.now();
  loadWave();
  G.state = 'play';
  clearFX();
  resetCommentary();
  say('start', {});
  resetPlaytimeMarks();
  clearSave();
  track('/run/start');
  Snd.music('game');
}

export function seedAttract() {
  G.level = 1;
  loadWave();
}

function pushRow() {
  G.parity ^= 1;
  const e = entropy();
  // At high entropy the incoming row ignores the low-tier bias entirely.
  const pool = random() < flatOdds(e) ? waveSeeds(G.level, entropy()) : wavePool(G.level);
  const hole = 0.10 + 0.15 * e;
  const row = new Array(rowCols(0)).fill(null);
  for (let c = 0; c < row.length; c++)
    if (random() >= hole) row[c] = orb(choose(pool));
  G.grid.unshift(row);
  const pushed = [];
  for (let c = 0; c < row.length; c++) if (row[c]) pushed.push([0, c, row[c].v]);
  TURN.added += pushed.length;
  logAdded('inbound buffer row', pushed);
  G.pushAnim = 1;
  say('push', {});
  bump('shake', 7);
  bump('glitch', 0.5);
  Snd.fx('stick');
}

/* ---------------------------------------------------------------- aiming  */
export function setAim(a) {
  G.angle = clamp(a, -Math.PI + AIM_LIMIT, -AIM_LIMIT);
}
export function nudgeAim(d) { setAim(G.angle + d); }

/* --------------------------------------------------------------- shooting */
export function fire(warp) {
  if (G.ball || G.state !== 'play') return;
  const v = warp ? -1 : G.cur;
  if (warp) {
    G.charge = 0; G.warpReady = false;
    say('warp', {});
    Snd.fx('warp');
  } else {
    Snd.fx('shoot');
  }
  G.ball = {
    x: LAUNCH.x, y: LAUNCH.y - 6, v,
    vx: Math.cos(G.angle) * SPEED,
    vy: Math.sin(G.angle) * SPEED
  };
  if (!warp) { G.cur = G.next.shift(); G.next.push(spawnValue()); }
  G.shots++;
  if (G.shots % G.shotsPerRow === 0) G.pendingPush = true;
}

export function hitTest(x, y) {
  const rr = Math.round((y - PF_TOP - R) / ROWH);
  const lo = Math.max(0, rr - 2), hi = Math.min(G.grid.length - 1, rr + 2);
  const lim = (2 * R - 3) * (2 * R - 3);
  for (let r = lo; r <= hi; r++) {
    const row = G.grid[r], cy = cellY(r);
    for (let c = 0; c < row.length; c++) {
      if (!row[c]) continue;
      const dx = x - cellX(r, c), dy = y - cy;
      if (dx * dx + dy * dy < lim) return [r, c];
    }
  }
  return null;
}

// Nearest empty cell that is either on the ceiling row or touching something.
function freeCellNear(x, y) {
  const rr = Math.round((y - PF_TOP - R) / ROWH);
  for (const span of [2, 4, 7]) {
    let best = null, bd = Infinity;
    for (let r = Math.max(0, rr - span); r <= rr + span; r++) {
      ensureRow(r);
      const row = G.grid[r], cy = cellY(r);
      for (let c = 0; c < row.length; c++) {
        if (row[c]) continue;
        if (r > 0 && !neighbors(r, c).some(([a, b]) => at(a, b))) continue;
        const dx = x - cellX(r, c), dy = y - cy, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = [r, c]; }
      }
    }
    if (best) return best;
  }
  return null;
}

export function moveBall() {
  const b = G.ball;
  if (!b) return;
  const SUB = 5;
  for (let s = 0; s < SUB; s++) {
    b.x += b.vx / SUB;
    b.y += b.vy / SUB;
    if (b.x - R < PF_X) {
      b.x = PF_X + R; b.vx = Math.abs(b.vx);
      Snd.fx('bounce'); sparks(b.x, b.y, b.v === -1 ? '#fff' : vcol(b.v, 80));
    } else if (b.x + R > PF_X + PF_W) {
      b.x = PF_X + PF_W - R; b.vx = -Math.abs(b.vx);
      Snd.fx('bounce'); sparks(b.x, b.y, b.v === -1 ? '#fff' : vcol(b.v, 80));
    }
    if (b.y - R <= PF_TOP) { land(b); return; }
    if (hitTest(b.x, b.y)) { land(b); return; }
  }
}

function land(b) {
  G.ball = null;
  TURN.before = cellCount();
  TURN.added = 0;
  TURN.removed = 0;
  TURN.live = true;
  const cell = freeCellNear(b.x, b.y);
  logShot(b.v, cell);
  if (!cell) { resolveTurn(); return; }
  const [r, c] = cell;

  let v = b.v;
  if (v === -1) {
    // Warp orb takes on whichever neighbouring value it touches most.
    const tally = new Map();
    for (const [nr, nc] of neighbors(r, c)) {
      const n = at(nr, nc);
      if (n) tally.set(n.v, (tally.get(n.v) || 0) + 1);
    }
    v = tally.size
      ? [...tally.entries()].sort((a, d) => d[1] - a[1] || d[0] - a[0])[0][0]
      : spawnValue();
    burst(cellX(r, c), cellY(r) + rowShift(), -1, 26);
    bump('flash', 0.45);
  }

  G.grid[r][c] = { v, pop: 1.5, born: G.tick };
  TURN.added++;
  logAdded('shot landed', [[r, c, v]]);
  Snd.fx('stick');
  bump('shake', 2.5);
  resolveMerges(r, c);
}

/* ---------------------------------------------------------------- merging */
// Chain tracing. Off unless the page was loaded with #debug or you hit L.
// Every collapse prints what it consumed and what it produced, so a confusing
// result can be pasted back verbatim instead of described.
export const LOG = { chains: false };

const cellList = cells => cells.map(([r, c]) => `(${r},${c})`).join('');

function logShot(v, cell) {
  if (!LOG.chains) return;
  console.log(`%c[SS] shot ${hexLabel(v)} -> ${cell ? `landed (${cell[0]},${cell[1]})` : 'no cell'}`,
    'color:#0ff;font-weight:bold');
}

function logCollapse(chain, v, grp, pairs, raw, overflows, keep, gain, d) {
  if (!LOG.chains) return;
  // One block per collapse. The earlier format printed a +1/-1 pair per cell
  // and it read like the same cell was being added twice: every group cell is
  // cleared, then the survivors are written back, so "landed" and "spare" can
  // legitimately name the same square. Spelling out the four outcomes avoids
  // that.  `saves N` = how many cells stay hung off the ceiling because a
  // survivor was placed there rather than elsewhere in the group.
  const spot = cells => cells.map(([r, c, extra]) =>
    `(${r},${c})` + (extra === undefined ? '' : `[saves ${extra}]`)).join('');
  const plain = cells => cells.map(([r, c]) => `(${r},${c})`).join('');
  console.log(`[SS]   collapse#${chain}  ${hexLabel(v)} x${grp.length} ${plain(grp)}` +
    `  ->  ${pairs} pair(s)` +
    (grp.length & 1 ? ', 1 absorbed' : '') + `   +${gain}`);
  if (d.made.length) {
    console.log(`[SS]      fused   ${hexLabel(raw)} at ` +
      spot(keep.slice(0, pairs).map(([r, c, s2]) => [r, c, s2])));
  }
  if (d.burned.length) {
    console.log(`[SS]      burned  FF at ${plain(d.burned)} (overflowed the byte)`);
  }
  if (d.blasted.length) {
    console.log(`[SS]      blast   ${d.blasted.length} caught in the FF detonation ` +
      d.blasted.map(([r, c, bv]) => `(${r},${c})=${hexLabel(bv)}`).join(''));
  }
  if (d.consumed.length) {
    console.log(`[SS]      used up ${plain(d.consumed)}`);
  }
}

// Per-turn bookkeeping. Every cell that appears or disappears is counted, and
// the totals are reconciled at the end of the turn -- so a cell can never go
// missing without either a log line naming the reason, or a loud warning.
const TURN = { before: 0, added: 0, removed: 0, live: false };

function cellCount() {
  let n = 0;
  for (const row of G.grid) for (const b of row) if (b) n++;
  return n;
}

function logRemoved(reason, cells) {
  if (!LOG.chains || !cells.length) return;
  console.log(`[SS]   -${cells.length} removed [${reason}]  ` +
    cells.map(([r, c, v]) => `(${r},${c})=${hexLabel(v)}`).join(''));
}

function logAdded(reason, cells) {
  if (!LOG.chains || !cells.length) return;
  console.log(`[SS]   +${cells.length} added [${reason}]  ` +
    cells.map(([r, c, v]) => `(${r},${c})=${hexLabel(v)}`).join(''));
}

function logSettled() {
  if (!LOG.chains) return;
  let orbs = 0, highest = 0;
  for (const row of G.grid) for (const b of row) if (b) {
    orbs++;
    if (b.v > highest) highest = b.v;
  }
  // `best` is the high-water mark for the whole run, so it can name a byte that
  // has long since merged away or dropped off. `highest` is what is out there
  // right now.
  console.log(`[SS] settled: ${orbs} cells, ` +
    `highest on board ${highest ? hexLabel(highest) : '--'}, ` +
    `best this run ${hexLabel(G.maxTile)}, score ${G.score}`);
  const dump = [];
  for (let r = 0; r < G.grid.length; r++)
    for (let c = 0; c < G.grid[r].length; c++)
      if (G.grid[r][c]) dump.push(`(${r},${c})=${hexLabel(G.grid[r][c].v)}`);
  console.log('[SS]   board: ' + (dump.join('') || 'empty'));
}

function reconcile() {
  if (!TURN.live) return;
  TURN.live = false;
  const now = cellCount();
  const expect = TURN.before + TURN.added - TURN.removed;
  if (now !== expect) {
    console.warn(`[SS] !! UNACCOUNTED CELL CHANGE: board has ${now}, expected ${expect} ` +
      `(started ${TURN.before}, +${TURN.added}, -${TURN.removed}). ` +
      'Something removed cells without logging a reason.');
  } else if (LOG.chains) {
    console.log(`[SS]   accounting ok: ${TURN.before} +${TURN.added} -${TURN.removed} = ${now}`);
  }
}

function cluster(r, c, v) {
  const seen = new Set([r + ',' + c]);
  const out = [[r, c]], q = [[r, c]];
  while (q.length) {
    const [cr, cc] = q.pop();
    for (const [nr, nc] of neighbors(cr, cc)) {
      const k = nr + ',' + nc;
      if (seen.has(k)) continue;
      const n = at(nr, nc);
      if (!n || n.v !== v) continue;
      seen.add(k); out.push([nr, nc]); q.push([nr, nc]);
    }
  }
  return out;
}

// Where the survivors land decides what stays on the board. A fusion can eat
// the one cell bridging a whole tail to the ceiling, and then that tail drops
// even though the fusion itself is fine -- so survivors are placed greedily to
// keep as much hanging on as possible.
//
// `rescue` is measured directly: how many more cells are ceiling-connected
// with this cell filled than without. A cell that only saves itself scores 1;
// one that also re-attaches a tail of four scores 5. Spreading survivors apart
// (so two fresh cells do not instantly re-merge) survives only as a tiebreak,
// because keeping the board intact matters more.
function pickSurvivors(ordered, need, ax, ay) {
  const chosen = [];
  let placed = new Set();
  const pool = ordered.slice();

  while (chosen.length < need && pool.length) {
    let bestAt = 0, best = null;
    for (let i = 0; i < pool.length; i++) {
      const [r, c] = pool[i];
      const key = r + ',' + c;
      const before = ceilingSet(placed).size;
      placed.add(key);
      const after = ceilingSet(placed).size;
      placed.delete(key);

      const touches = chosen.some(([sr, sc]) =>
        neighbors(sr, sc).some(([nr, nc]) => nr === r && nc === c)) ? 1 : 0;
      const dist = (cellX(r, c) - ax) ** 2 + (cellY(r) - ay) ** 2;
      const score = [-(after - before), touches, dist];

      if (!best || score[0] < best[0] ||
        (score[0] === best[0] && (score[1] < best[1] ||
          (score[1] === best[1] && score[2] < best[2])))) {
        best = score;
        bestAt = i;
      }
    }
    const cell = pool.splice(bestAt, 1)[0];
    chosen.push([cell[0], cell[1], -best[0]]);   // -score[0] is the rescue count
    placed.add(cell[0] + ',' + cell[1]);
  }

  // Greedy alone is order-dependent and misses bridges: a cell that is worth
  // nothing on its own can be worth a whole tail once a partner is placed, but
  // by then the slot is gone. Absorbing the odd cell left fewer survivors to
  // play with, so it is worth a couple of cheap improvement passes -- swap any
  // chosen cell for an unchosen one whenever that leaves more of the board
  // hanging off the ceiling.
  const keyOf = ([r, c]) => r + ',' + c;
  let best = ceilingSet(placed).size;
  for (let pass = 0; pass < 2; pass++) {
    let improved = false;
    for (let i = 0; i < chosen.length; i++) {
      for (let j = 0; j < pool.length; j++) {
        const trial = new Set(placed);
        trial.delete(keyOf(chosen[i]));
        trial.add(keyOf(pool[j]));
        const held = ceilingSet(trial).size;
        if (held > best) {
          best = held;
          const swap = chosen[i];
          chosen[i] = [pool[j][0], pool[j][1], undefined];
          pool[j] = [swap[0], swap[1]];
          placed = trial;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return chosen;
}

// A touching group collapses PAIRWISE, the way 2048 does: every two orbs
// become one of the next tier, and an odd orb out is left as it was. Four 01s
// give two 02s, not one 08 and not a single 02. Only 80 has nowhere left to
// go, so each 80 pair overflows to FF and burns off the board.
function collapse(r, c, chain) {
  const cell = at(r, c);
  if (!cell) return [];
  const grp = cluster(r, c, cell.v);
  if (grp.length < 2) return [];

  const v = cell.v;
  // Nothing is ever left sitting unmerged: an odd cell out is swallowed by a
  // pair rather than stranded next to it. Three 04s make one 08, not an 08 and
  // a lonely 04. That does quietly destroy the odd cell's value, which is the
  // accepted price of never seeing a spare.
  const pairs = grp.length >> 1;
  const raw = v * 2;
  const overflows = raw >= OVERFLOW;
  const sy = rowShift();
  const ax = cellX(r, c), ay = cellY(r);

  // Clear the whole group up front so anchoring can be judged against the
  // board as it will be AFTER the fusion, not as it was before.
  for (const [gr, gc] of grp) G.grid[gr][gc] = null;
  TURN.removed += grp.length;
  TURN.added += raw >= OVERFLOW ? 0 : pairs;

  // A fusion must never orphan its own result. Merging two cells stacked at
  // the ceiling eats the upper one -- the anchor -- so putting the survivor on
  // the lower cell drops it straight off the board, and the merge looks like
  // it simply vanished. Cells only leave via FF, so prefer a survivor cell
  // that is still hanging off the ceiling.
  const ordered = grp.slice().sort((p, q) => {
    const dp = (cellX(p[0], p[1]) - ax) ** 2 + (cellY(p[0]) - ay) ** 2;
    const dq = (cellX(q[0], q[1]) - ax) ** 2 + (cellY(q[0]) - ay) ** 2;
    return dp - dq;
  });
  const keep = pickSurvivors(ordered, pairs, ax, ay);

  // Put the cell the player aimed at first, so the fusion appears where they
  // shot whenever that cell survived.
  const anchorAt = keep.findIndex(([kr, kc]) => kr === r && kc === c);
  if (anchorAt > 0) keep.unshift(keep.splice(anchorAt, 1)[0]);
  const keepSet = new Set(keep.map(([kr, kc]) => kr + ',' + kc));

  const collapseDetail = { consumed: [], burned: [], made: [], blasted: [] };
  const consumed = [];
  for (const [gr, gc] of grp) {
    if (keepSet.has(gr + ',' + gc)) continue;
    consumed.push([gr, gc, v]);
    burst(cellX(gr, gc), cellY(gr) + sy, v, 10);
  }
  collapseDetail.consumed = consumed;

  G.merges += grp.length;
  G.combo = chain;
  if (chain > G.bestCombo) G.bestCombo = chain;
  G.charge = clamp(G.charge + 0.08 + pairs * 0.07, 0, 1);
  if (G.charge >= 1) G.warpReady = true;

  const fresh = [];
  const burned = [], made = [];
  const blasted = [], blastedSet = new Set();
  let blastGain = 0;
  for (let i = 0; i < pairs; i++) {
    const [nr, nc] = keep[i];
    const x = cellX(nr, nc), y = cellY(nr) + sy;
    if (overflows) {
      G.bytes++;
      G.maxTile = FULL;
      burned.push([nr, nc, FULL]);
      blast(x, y);
      // A byte going to FF does not just vanish, it detonates: everything
      // touching it goes with it, one tile out. That is what makes climbing
      // all the way to 80 worth the trouble.
      for (const [er, ec] of neighbors(nr, nc)) {
        const victim = at(er, ec);
        if (!victim) continue;
        const k = er + ',' + ec;
        if (blastedSet.has(k)) continue;
        blastedSet.add(k);
        blasted.push([er, ec, victim.v]);
        blastGain += victim.v * PTS_DROP * 2;
        G.grid[er][ec] = null;
        burst(cellX(er, ec), cellY(er) + sy, victim.v, 16);
      }
    } else {
      G.grid[nr][nc] = { v: raw, pop: 2.1, born: G.tick };
      if (raw > G.maxTile) G.maxTile = raw;
      burst(x, y, raw, 18);
      fresh.push([nr, nc]);
      made.push([nr, nc, raw]);
    }
  }
  // the pair that overflowed never lands: FF burns off where it was made
  collapseDetail.burned = burned;
  collapseDetail.made = made;
  collapseDetail.blasted = blasted;
  if (blasted.length) {
    TURN.removed += blasted.length;
    G.score += blastGain;
    bump('shake', 10 + blasted.length * 3);
    bump('flash', 0.3);
  }
  // the odd cell out survives untouched


  const mult = G.hyper ? HYPER_MULT : 1;
  const gain = (overflows ? PTS_OVERFLOW : raw * PTS_FUSE) * chain * pairs * mult;
  G.score += gain;
  logCollapse(chain, v, grp, pairs, raw, overflows, keep, gain, collapseDetail);
  const arrow = hexLabel(v) + '>' + (overflows ? 'FF' : hexLabel(raw));
  const tag = (chain > 1 ? 'x' + chain + ' ' : '') + arrow +
    (pairs > 1 ? ' x' + pairs : '') + ' +' + gain;
  popText(ax, ay + sy - 22 - (chain - 1) * 19, tag,
    overflows ? '#ffe66d' : vcol(raw, 78), overflows ? 3.2 : 1.8);

  if (overflows) {
    bump('shake', 20 + pairs * 4); bump('glitch', 1); bump('flash', 0.85);
    say('burn', { n: pairs, blast: blasted.length });
    Snd.fx('overflow');
  } else {
    bump('shake', 4 + chain * 3 + Math.log2(raw));
    bump('glitch', Math.min(1, 0.16 + chain * 0.16));
    bump('flash', 0.14 + chain * 0.09);
    say('fuse', { v: raw, chain, pairs });
    Snd.fx('merge', raw);
  }
  return fresh;
}

function resolveMerges(r, c) {
  let chain = 0;
  // Freshly doubled orbs can land next to their own kind, so cascades are
  // driven off a worklist rather than just re-checking the landing cell.
  const work = [[r, c]];
  while (work.length) {
    let picked = -1;
    for (let i = 0; i < work.length; i++) {
      const cell = at(work[i][0], work[i][1]);
      if (cell && cluster(work[i][0], work[i][1], cell.v).length >= 2) { picked = i; break; }
    }
    if (picked < 0) break;
    const [cr, cc] = work.splice(picked, 1)[0];
    // Each collapse strictly shrinks the group it consumed, so this terminates.
    work.push(...collapse(cr, cc, ++chain));
  }
  if (chain === 0) {
    G.combo = 0;
    say('dud', { streak: ++G.dudStreak });
  } else {
    G.dudStreak = 0;
  }
  resolveTurn();
}

// Every cell reachable from the ceiling row, as "row,col" keys. `extra` lets a
// caller ask "what would be connected if these cells were also filled", which
// is how survivor placement is scored before anything is committed.
function ceilingSet(extra) {
  const seen = new Set();
  if (!G.grid.length) return seen;
  const filled = (r, c) => !!at(r, c) || (extra ? extra.has(r + ',' + c) : false);
  const q = [];
  for (let c = 0; c < G.grid[0].length; c++)
    if (filled(0, c)) { seen.add('0,' + c); q.push([0, c]); }
  while (q.length) {
    const [r, c] = q.pop();
    for (const [nr, nc] of neighbors(r, c)) {
      const k = nr + ',' + nc;
      if (seen.has(k) || !filled(nr, nc)) continue;
      seen.add(k); q.push([nr, nc]);
    }
  }
  return seen;
}

// Anything no longer reachable from the ceiling row falls off for bonus points.
function dropFloaters() {
  if (!G.grid.length) return 0;
  const keep = ceilingSet();

  let n = 0, gain = 0;
  const fell = [];
  const sy = rowShift();
  for (let r = 0; r < G.grid.length; r++)
    for (let c = 0; c < G.grid[r].length; c++) {
      const b = G.grid[r][c];
      if (!b || keep.has(r + ',' + c)) continue;
      gain += b.v * PTS_DROP * (G.hyper ? HYPER_MULT : 1); n++;
      fell.push([r, c, b.v]);
      burst(cellX(r, c), cellY(r) + sy, b.v, 14);
      G.grid[r][c] = null;
    }
  if (n) {
    TURN.removed += n;
    logRemoved('cut loose from the ceiling', fell);
    G.score += gain;
    popText(VW / 2, 300, 'DROP x' + n + '  +' + gain, '#7fffd4', 3.2);
    say('drop', { n });
    bump('shake', 6 + n);
    Snd.fx('drop');
  }
  return n;
}

function trimRows() {
  while (G.grid.length && G.grid[G.grid.length - 1].every(x => !x)) G.grid.pop();
}

function resolveTurn() {
  dropFloaters();
  trimRows();

  // Clearing beats the wall: check for an empty board before pushing a row in.
  if (boardEmpty()) { waveClear(); return; }

  if (G.pendingPush) { G.pendingPush = false; pushRow(); }

  for (let r = 0; r < G.grid.length; r++) {
    if (cellY(r) <= DANGER_Y) continue;
    if (G.grid[r].some(x => x)) { gameOver(); return; }
  }
  refreshAmmo();
  updateCommentaryContext();
  logSettled();
  reconcile();
  persist();
}

// Hand the scroller the board facts it narrates. Kept here because game.js is
// the only place that knows all of them at once.
function updateCommentaryContext() {
  const edge = edgeValues();
  const all = boardValues();
  let orbs = 0;
  for (const n of all.values()) orbs += n;
  let deepest = -1;
  for (let r = G.grid.length - 1; r >= 0; r--) {
    if (G.grid[r].some(Boolean)) { deepest = r; break; }
  }
  CTX.wave = G.level;
  CTX.orbs = orbs;
  CTX.shots = G.shots;
  CTX.bufferIn = G.shotsPerRow - (G.shots % G.shotsPerRow);
  CTX.topByte = G.maxTile;
  CTX.edgeKinds = edge.size;
  CTX.buried = [...all.keys()].filter(v => !edge.has(v)).length;
  CTX.rowsToSpare = deepest < 0 ? 99 : DANGER_ROW - deepest;
  CTX.entropy = entropy();
  CTX.hyper = G.hyper;
  CTX.dud = G.dud = !edge.has(G.cur);
  observe();
}

function waveClear() {
  G.state = 'clear';
  G.clearAnim = 0;
  G.lastBonus = PTS_WAVE * G.level * (G.hyper ? HYPER_MULT : 1);
  G.score += G.lastBonus;
  say('wave', { wave: G.level, bonus: G.lastBonus });
  noteWaveCleared();
  track('/wave-clear/' + waveBucket(G.level));
  Snd.fx('win');
  bump('flash', 1); bump('glitch', 1); bump('shake', 20);
}

export function nextWave() {
  G.level++;
  loadWave();
  G.state = 'play';
  persist();
}

function gameOver() {
  G.state = 'over';
  G.over = 0;
  if (G.score > G.best) {
    G.best = G.score;
    saveBest(G.score);
  }
  recordRun({
    score: G.score, wave: G.level, ff: G.bytes,
    fused: G.merges, chain: G.bestCombo, at: G.startedAt
  });
  track('/over/wave-' + waveBucket(G.level));
  track('/score/' + scoreBucket(G.score));
  say('over', { wave: G.level });
  clearSave();
  flushStats();
  Snd.fx('over');
  bump('shake', 30); bump('glitch', 1); bump('flash', 0.7);
  for (let r = 0; r < G.grid.length; r++)
    for (let c = 0; c < G.grid[r].length; c++)
      if (G.grid[r][c]) burst(cellX(r, c), cellY(r), G.grid[r][c].v, 6);
}

/* ------------------------------------------------------------- save/resume */
// Written every time the board settles, so closing the tab mid-run costs at
// most the shot in flight. The RNG position rides along: without it a resumed
// wave would re-roll its ammo from the top of the stream and a #seed run would
// stop being reproducible.
export function snapshot() {
  return {
    grid: G.grid.map(row => row.map(b => (b ? b.v : 0))),
    parity: G.parity,
    level: G.level, shotsPerRow: G.shotsPerRow, shots: G.shots,
    score: G.score, combo: G.combo, bestCombo: G.bestCombo,
    merges: G.merges, bytes: G.bytes, maxTile: G.maxTile,
    cur: G.cur, next: G.next.slice(),
    charge: G.charge, warpReady: G.warpReady,
    hyper: G.hyper, dudStreak: G.dudStreak, startedAt: G.startedAt,
    pendingPush: G.pendingPush,
    seed: RNG.seed, rng: getRngState()
  };
}

export function persist() {
  // A finished run is not worth resuming into.
  if (G.state !== 'play') return;
  writeSave(snapshot());
}

// Rejects anything whose geometry does not match the current rules, rather
// than loading a board that cannot be played.
function validSnapshot(s) {
  if (!s || !Array.isArray(s.grid)) return false;
  if (typeof s.parity !== 'number' || (s.parity & 1) !== s.parity) return false;
  const saved = G.parity;
  G.parity = s.parity;
  let ok = true;
  for (let r = 0; r < s.grid.length; r++) {
    const row = s.grid[r];
    if (!Array.isArray(row) || row.length !== rowCols(r)) { ok = false; break; }
    for (const v of row) {
      if (v === 0) continue;
      if (typeof v !== 'number' || (v & 1) || v < 2 || v > 0xFE) { ok = false; break; }
    }
    if (!ok) break;
  }
  G.parity = saved;
  return ok;
}

export function resumeAvailable() {
  const s = readSave();
  if (!s || !validSnapshot(s)) return null;
  let cells = 0;
  for (const row of s.grid) for (const v of row) if (v) cells++;
  if (!cells) return null;
  return { level: s.level || 1, score: s.score || 0, cells };
}

export function resumeGame() {
  const s = readSave();
  if (!s || !validSnapshot(s)) return false;

  G.parity = s.parity;
  G.grid = s.grid.map(row => row.map(v => (v ? { v, pop: 1, born: 0 } : null)));
  G.level = s.level; G.shotsPerRow = s.shotsPerRow; G.shots = s.shots;
  G.score = s.score; G.combo = s.combo; G.bestCombo = s.bestCombo;
  G.merges = s.merges; G.bytes = s.bytes; G.maxTile = s.maxTile;
  G.cur = s.cur; G.next = s.next.slice();
  G.charge = s.charge; G.warpReady = s.warpReady;
  G.hyper = s.hyper; G.dudStreak = s.dudStreak;
  G.startedAt = s.startedAt || Date.now();
  G.pendingPush = !!s.pendingPush;
  G.ball = null; G.over = 0; G.clearAnim = 0; G.pushAnim = 0;

  setSeed(s.seed);
  setRngState(s.rng);

  G.state = 'play';
  clearFX();
  resetCommentary();
  resetPlaytimeMarks();
  updateCommentaryContext();
  track('/run/resume');
  Snd.music('game');
  return true;
}

/* ----------------------------------------------------------- aim trajectory */
export function trace() {
  let x = LAUNCH.x, y = LAUNCH.y - 6;
  let vx = Math.cos(G.angle) * SPEED, vy = Math.sin(G.angle) * SPEED;
  const pts = [[x, y]];
  for (let i = 0; i < 420; i++) {
    x += vx * 0.5; y += vy * 0.5;
    if (x - R < PF_X) { x = PF_X + R; vx = Math.abs(vx); pts.push([x, y]); }
    else if (x + R > PF_X + PF_W) { x = PF_X + PF_W - R; vx = -Math.abs(vx); pts.push([x, y]); }
    if (y - R <= PF_TOP) { pts.push([x, y]); break; }
    if (hitTest(x, y)) { pts.push([x, y]); break; }
  }
  if (pts.length < 2) pts.push([x, y]);
  return pts;
}
