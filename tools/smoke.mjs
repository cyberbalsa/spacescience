#!/usr/bin/env node
// Headless smoke test: drives dist/index.html through a few hundred shots and
// asserts the rules hold. Talks CDP directly so it can step the simulation
// faster than a headless browser produces frames.
//
//   node tools/smoke.mjs [shots] [--shot title|play]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAGE = 'file://' + path.join(ROOT, 'dist', 'index.html') + '#debug';
const SHOTS = Number(process.argv[2]) || 500;
const shotFlag = process.argv.indexOf('--shot');
const SCREENSHOT = shotFlag > 0 ? process.argv[shotFlag + 1] : null;

const CHROME = ['google-chrome-stable', 'google-chrome', 'chromium']
  .find(c => { try { return !!process.env.PATH && fs.existsSync(which(c)); } catch { return false; } });

function which(cmd) {
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, cmd);
    if (fs.existsSync(p)) return p;
  }
  return '/nonexistent';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------- cdp  */
async function connect(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('chrome devtools endpoint never came up');
}

function client(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}

async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  }
  return r.result.value;
}

/* ------------------------------------------------------- in-page autoplay */
// Inverse of the game's own screen->virtual mapping, letterbox included.
// Getting this wrong silently skews every shot, so it lives in one place.
const POINTER = `
  const toClient = (vx, vy) => {
    const c = document.getElementById('c');
    const r = c.getBoundingClientRect();
    const sc = Math.min(c.width / 1280, c.height / 720);
    const ox = (c.width - 1280 * sc) / 2, oy = (c.height - 720 * sc) / 2;
    return [
      r.left + (vx * sc + ox) * r.width / c.width,
      r.top + (vy * sc + oy) * r.height / c.height
    ];
  };
  const aimAt = (vx, vy) => {
    const [cx, cy] = toClient(vx, vy);
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: cx, clientY: cy }));
  };
  const key = k => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: k }));
  };
`;
// Runs inside the page: fires shots at random angles and audits invariants
// after every landing.
const AUTOPLAY = shots => `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  const errs = [];
  window.addEventListener('error', e => errs.push(e.message));

  ${POINTER}
  const aim = () => {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.3;
    aimAt(640 + Math.cos(a) * 400, 656 + Math.sin(a) * 400);
  };

  const st = {
    shots: 0, games: 0, waves: 0, maxLevel: 1, ffBurned: 0,
    ffResting: 0, ammoViolations: 0, badValues: {}, overlaps: 0,
    outOfRange: 0, maxOrbs: 0, maxEnclosed: 0, iterations: 0, states: {},
    buriedSightings: 0, guaranteeChecks: 0
  };


  const audit = () => {
    let orbs = 0, enclosed = 0;
    const occupied = new Set();
    for (let r = 0; r < G.grid.length; r++) {
      for (let c = 0; c < G.grid[r].length; c++) {
        const b = G.grid[r][c];
        if (!b) continue;
        orbs++;
        // Every byte in play must stay even and inside a byte; 01 was removed
        // and FF is only ever transient.
        if (b.v === 0xFF) st.ffResting++;
        else if ((b.v & 1) || b.v < 2 || b.v > 0xFE)
          st.badValues[b.v] = (st.badValues[b.v] || 0) + 1;
        const key2 = r + ',' + c;
        if (occupied.has(key2)) st.overlaps++;
        occupied.add(key2);
        // a cell index must be inside its row's parity-derived width
        const width = ((r + G.parity) & 1) ? 11 : 12;
        if (G.grid[r].length !== width || c >= width) st.outOfRange++;
        if (!isEdge(r, c)) enclosed++;
      }
    }
    if (orbs > st.maxOrbs) st.maxOrbs = orbs;
    if (enclosed > st.maxEnclosed) st.maxEnclosed = enclosed;
  };

  let lastState = G.state;
  for (let i = 0; i < 400000 && st.shots < ${shots}; i++) {
    st.iterations = i;
    st.states[G.state] = (st.states[G.state] || 0) + 1;

    if (G.state === 'title') key(' ');
    else if (G.state === 'over') key(' ');
    else if (G.state === 'play' && !G.ball) {
      audit();
      // the chambered value must be present on an exposed edge
      if (G.grid.some(row => row.some(Boolean))) {
        const edgeVals = new Set(), allVals = new Set();
        for (let r = 0; r < G.grid.length; r++)
          for (let c = 0; c < G.grid[r].length; c++) {
            const b = G.grid[r][c];
            if (!b) continue;
            allVals.add(b.v);
            if (isEdge(r, c)) edgeVals.add(b.v);
          }
        // The cannon only promises usable ammo while entropy is 0; past that
        // duds are the mechanic, so only police the guarantee at wave 1.
        if (G.level === 1 && !G.hyper) {
          st.guaranteeChecks++;
          if (!edgeVals.has(G.cur)) st.ammoViolations++;
        }
        // proves the edge rule is doing work rather than passing vacuously
        for (const v of allVals) if (!edgeVals.has(v)) st.buriedSightings++;
      }
      aim(); key(' '); st.shots++;
    }

    S.step();

    if (G.state !== lastState) {
      if (G.state === 'over') st.games++;
      if (G.state === 'clear') st.waves++;
      lastState = G.state;
    }
    if (G.level > st.maxLevel) st.maxLevel = G.level;
    if (G.bytes > st.ffBurned) st.ffBurned = G.bytes;
  }

  // local mirror of game.isEdge so the audit does not need it exported
  function isEdge(r, c) {
    const odd = (r + G.parity) & 1;
    const o = odd
      ? [[0,-1],[0,1],[-1,0],[-1,1],[1,0],[1,1]]
      : [[0,-1],[0,1],[-1,-1],[-1,0],[1,-1],[1,0]];
    for (const [dr, dc] of o) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0) continue;
      if (rr >= G.grid.length) return true;
      if (cc < 0 || cc >= G.grid[rr].length) continue;
      if (!G.grid[rr][cc]) return true;
    }
    return false;
  }

  return Object.assign(st, {
    errors: errs,
    score: G.score, level: G.level, merges: G.merges,
    bestChain: G.bestCombo, bytes: G.bytes,
    topByte: G.maxTile.toString(16).toUpperCase(),
    finalState: G.state
  });
})()`;

// Engineered scenario: a board holding a single 80. Landing a second one makes
// a clean pair, which doubles to 100 -- too big for a byte -- so it saturates to
// FF, burns off, and leaves an empty board -> wave clear.
const CLEAR_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  ${POINTER}
  G.state = 'play'; G.parity = 0; G.ball = null;
  G.shots = 0; G.pendingPush = false; G.pushAnim = 0; G.clearAnim = 0;
  const startLevel = G.level, startBytes = G.bytes;
  G.grid = [new Array(12).fill(null)];
  G.grid[0][5] = { v: 0x80, pop: 1, born: 0 };
  G.cur = 0x80; G.next = [0x80, 0x80];

  // straight up the middle, between the two orbs
  aimAt(640, 100);
  key(' ');

  let sawClear = false, steps = 0;
  for (; steps < 600; steps++) {
    S.step();
    if (G.state === 'clear') sawClear = true;
    if (sawClear && G.state === 'play') break;
  }
  let orbs = 0;
  for (const row of G.grid) for (const b of row) if (b) orbs++;
  return {
    sawClear, steps, state: G.state,
    levelAdvanced: G.level === startLevel + 1,
    ffBurned: G.bytes - startBytes,
    freshBoardOrbs: orbs
  };
})()`;

// Regression for the merge rule: a touching group of four 02s must collapse
// PAIRWISE into two 04s -- not one 10 (doubling per extra orb) and not a single
// 04. The landing cell is on the ceiling row so nothing drops as a floater.
const MERGE_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  ${POINTER}
  G.state = 'play'; G.parity = 0; G.ball = null;
  G.shots = 0; G.pendingPush = false; G.pushAnim = 0;
  // All three sit on the ceiling row, clear of the flight path, so the shot
  // can only land in the gap at col 5 and the fused orb stays anchored.
  G.grid = [new Array(12).fill(null)];
  G.grid[0][3] = { v: 2, pop: 1, born: 0 };
  G.grid[0][4] = { v: 2, pop: 1, born: 0 };
  G.grid[0][6] = { v: 2, pop: 1, born: 0 };
  G.cur = 2; G.next = [2, 2];

  aimAt(616, 60);                 // straight up into the gap at row 0, col 5
  key(' ');
  for (let i = 0; i < 400 && G.ball; i++) S.step();
  for (let i = 0; i < 5; i++) S.step();

  const orbs = [];
  for (let r = 0; r < G.grid.length; r++)
    for (let c = 0; c < G.grid[r].length; c++)
      if (G.grid[r][c]) orbs.push({ r, c, v: G.grid[r][c].v });
  return { count: orbs.length, values: orbs.map(o => o.v), state: G.state };
})()`;

// Deep waves must actually hand out unusable ammo, otherwise the whole
// escalation is decorative.
const DUD_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  ${POINTER}
  const aim = () => {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.3;
    aimAt(640 + Math.cos(a) * 400, 656 + Math.sin(a) * 400);
  };
  // Dying would restart at wave 1 and quietly measure entropy 0 instead, so
  // the probe re-enters a deep wave every time the board resets.
  const deepen = () => { G.level = 11; S.nextWave(); };
  deepen();
  const isEdge = (r, c) => {
    const odd = (r + G.parity) & 1;
    const o = odd ? [[0,-1],[0,1],[-1,0],[-1,1],[1,0],[1,1]]
                  : [[0,-1],[0,1],[-1,-1],[-1,0],[1,-1],[1,0]];
    for (const [dr, dc] of o) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0) continue;
      if (rr >= G.grid.length) return true;
      if (cc < 0 || cc >= G.grid[rr].length) continue;
      if (!G.grid[rr][cc]) return true;
    }
    return false;
  };
  const edgeSet = () => {
    const m = new Set();
    for (let r = 0; r < G.grid.length; r++)
      for (let c = 0; c < G.grid[r].length; c++)
        if (G.grid[r][c] && isEdge(r, c)) m.add(G.grid[r][c].v);
    return m;
  };
  let checks = 0, duds = 0, odd = 0;
  const seen = new Set();
  for (let i = 0; i < 300000 && checks < 140; i++) {
    if (G.state === 'play' && !G.ball) {
      const ev = edgeSet();
      if (ev.size) { checks++; if (!ev.has(G.cur)) duds++; }
      for (const row of G.grid) for (const b of row) if (b) {
        seen.add(b.v); if (b.v & 1) odd++;
      }
      aim(); key(' ');
    } else if (G.state !== 'play') {
      deepen();
      continue;
    }
    S.step();
  }
  return { level: G.level, checks, duds, oddValues: odd,
           distinctValues: [...seen].sort((a, b) => a - b).map(v => v.toString(16)) };
})()`;

const HYPER_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  const arrow = k => window.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
  const before = { hyper: G.hyper, shots: G.shotsPerRow };
  for (const k of ['ArrowUp','ArrowUp','ArrowDown','ArrowDown',
                   'ArrowLeft','ArrowRight','ArrowLeft','ArrowRight']) arrow(k);
  const on = { hyper: G.hyper, shots: G.shotsPerRow };
  // a wrong sequence must not toggle it back
  for (const k of ['ArrowUp','ArrowDown','ArrowUp','ArrowDown']) arrow(k);
  const stillOn = G.hyper;
  return { before, on, stillOn };
})()`;

// A given seed must produce byte-identical boards, otherwise a reported seed
// is worthless for reproducing a bug.
const SEED_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  const snapshot = () => G.grid.map(row =>
    row.map(b => (b ? b.v.toString(16) : '.')).join(',')).join('|');
  const runFrom = seed => {
    S.setSeed(seed);
    S.newGame();
    const first = snapshot();
    G.level = 4; S.nextWave();
    return first + '#' + snapshot() + '#' + G.cur + ',' + G.next.join(',');
  };
  const a = runFrom(1238123);
  const b = runFrom(1238123);
  const c = runFrom(999);
  return { reproducible: a === b, differs: a !== c, len: a.length };
})()`;

// Merging at the ceiling must not orphan its own result. A 04 on the ceiling
// row plus a 04 landing below it fuses to 08 -- and if the survivor is placed
// on the lower cell, the fusion has just eaten its only anchor and the 08 drops
// straight off the board. From the player's seat the merge simply vanished.
const CEILING_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  ${POINTER}
  G.state = 'play'; G.parity = 0; G.ball = null;
  G.shots = 0; G.pendingPush = false; G.pushAnim = 0;
  G.grid = [new Array(12).fill(null), new Array(11).fill(null)];
  G.grid[0][5] = { v: 4, pop: 1, born: 0 };
  G.cur = 4; G.next = [4, 4];

  aimAt(640, 60);                    // straight up, lands under the ceiling cell
  key(' ');
  for (let i = 0; i < 400 && G.ball; i++) S.step();
  for (let i = 0; i < 6; i++) S.step();

  const cells = [];
  for (let r = 0; r < G.grid.length; r++)
    for (let c = 0; c < G.grid[r].length; c++)
      if (G.grid[r][c]) cells.push({ r, c, v: G.grid[r][c].v });
  return { cells, count: cells.length, state: G.state };
})()`;

// A fusion must not saw off the branch it is standing on. A tail of two 20s
// hangs below a 04 bridge at (1,4); the fusion consumes the bridge, so unless a
// survivor is placed back on it the tail drops. The bridge is worth nothing to
// a greedy first pick -- it only pays off once it is chosen -- so this also
// covers the connectivity scoring.
//
// Two 02s sit on the ceiling purely as backstops, so the shot always lands at
// (1,5) instead of sailing on to the ceiling and landing somewhere arbitrary.
const TAIL_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  ${POINTER}
  G.state = 'play'; G.parity = 0; G.ball = null;
  G.shots = 0; G.pendingPush = false; G.pushAnim = 0;
  G.grid = [new Array(12).fill(null), new Array(11).fill(null),
            new Array(12).fill(null), new Array(11).fill(null)];
  G.grid[0][5] = { v: 2, pop: 1, born: 0 };     // backstop / anchor
  G.grid[0][6] = { v: 2, pop: 1, born: 0 };     // backstop / anchor
  G.grid[1][4] = { v: 4, pop: 1, born: 0 };     // the bridge
  G.grid[1][6] = { v: 4, pop: 1, born: 0 };
  G.grid[2][4] = { v: 0x20, pop: 1, born: 0 };  // tail
  G.grid[3][4] = { v: 0x20, pop: 1, born: 0 };  // tail
  G.cur = 4; G.next = [4, 4];

  aimAt(640, 60);                               // straight up, lands at (1,5)
  key(' ');
  for (let i = 0; i < 400 && G.ball; i++) S.step();
  for (let i = 0; i < 8; i++) S.step();

  const cells = [];
  for (let r = 0; r < G.grid.length; r++)
    for (let c = 0; c < G.grid[r].length; c++)
      if (G.grid[r][c]) cells.push({ r, c, v: G.grid[r][c].v });
  return { cells, count: cells.length,
           tailKept: cells.filter(x => x.v === 0x20).length,
           bridgeHeld: cells.some(x => x.r === 1 && x.c === 4 && x.v === 8) };
})()`;

// FF does not just vanish, it detonates: everything touching it goes too.
const BLAST_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  ${POINTER}
  G.state = 'play'; G.parity = 0; G.ball = null;
  G.shots = 0; G.pendingPush = false; G.pushAnim = 0;
  G.grid = [new Array(12).fill(null), new Array(11).fill(null)];
  G.grid[0][5] = { v: 0x80, pop: 1, born: 0 };  // pairs with the shot -> FF
  G.grid[0][6] = { v: 2, pop: 1, born: 0 };     // touching: should be blasted
  G.grid[0][4] = { v: 2, pop: 1, born: 0 };     // not touching: should survive
  G.cur = 0x80; G.next = [0x80, 0x80];

  const before = G.bytes;
  aimAt(640, 60);
  key(' ');
  for (let i = 0; i < 400 && G.ball; i++) S.step();
  for (let i = 0; i < 8; i++) S.step();

  const cells = [];
  for (let r = 0; r < G.grid.length; r++)
    for (let c = 0; c < G.grid[r].length; c++)
      if (G.grid[r][c]) cells.push({ r, c, v: G.grid[r][c].v });
  return { cells, count: cells.length, ffBurned: G.bytes - before,
           survivorIsFarOne: cells.length === 1 && cells[0].c === 4 };
})()`;

// Three of a kind must leave exactly one cell: one pair fuses and the odd cell
// is absorbed, never stranded next to the result.
const ODD_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  ${POINTER}
  G.state = 'play'; G.parity = 0; G.ball = null;
  G.shots = 0; G.pendingPush = false; G.pushAnim = 0;
  G.grid = [new Array(12).fill(null)];
  G.grid[0][4] = { v: 4, pop: 1, born: 0 };
  G.grid[0][6] = { v: 4, pop: 1, born: 0 };
  G.cur = 4; G.next = [4, 4];

  aimAt(616, 60);                    // lands at (0,5), touching both
  key(' ');
  for (let i = 0; i < 400 && G.ball; i++) S.step();
  for (let i = 0; i < 6; i++) S.step();

  const cells = [];
  for (let r = 0; r < G.grid.length; r++)
    for (let c = 0; c < G.grid[r].length; c++)
      if (G.grid[r][c]) cells.push({ r, c, v: G.grid[r][c].v });
  return { cells, count: cells.length };
})()`;

// A run must survive a reload. The board is written every time it settles, so
// wiping the live state and resuming has to give back exactly what was there.
const RESUME_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  ${POINTER}
  const aim = () => {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.3;
    aimAt(640 + Math.cos(a) * 400, 656 + Math.sin(a) * 400);
  };
  S.newGame();
  let shots = 0;
  for (let i = 0; i < 200000 && shots < 12; i++) {
    if (G.state === 'play' && !G.ball) { aim(); key(' '); shots++; }
    S.step();
  }
  for (let i = 0; i < 400 && G.ball; i++) S.step();   // let the last one settle
  if (G.state !== 'play') return { skipped: G.state };

  const dump = () => G.grid.map(r => r.map(b => (b ? b.v : 0)).join(',')).join('|');
  const before = dump();
  const was = { score: G.score, level: G.level, cur: G.cur,
                next: G.next.join(','), bytes: G.bytes, parity: G.parity };
  const avail = S.resumeAvailable();

  // Wipe the live state the way a page reload would.
  G.grid = []; G.score = 0; G.level = 99; G.cur = 2; G.next = [2, 2];
  G.bytes = 0; G.parity = 0;

  const ok = S.resumeGame();
  return {
    ok, avail,
    boardMatches: dump() === before,
    scoreOk: G.score === was.score,
    levelOk: G.level === was.level,
    ammoOk: G.cur === was.cur && G.next.join(',') === was.next,
    parityOk: G.parity === was.parity,
    statsOk: G.bytes === was.bytes
  };
})()`;

/* ------------------------------------------------------------------ main  */
async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html missing - run `node build.mjs` first');
  }

  const port = 9300 + (process.pid % 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-smoke-'));
  const chrome = spawn(CHROME || 'google-chrome-stable', [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    '--hide-scrollbars', '--window-size=1440,900',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    PAGE
  ], { stdio: 'ignore' });

  let failed = false;
  try {
    const wsUrl = await connect(port);
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('devtools socket failed')));
    });
    const send = client(ws);
    await send('Runtime.enable');
    await send('Page.enable');

    // wait for the debug hook
    for (let i = 0; i < 100; i++) {
      if (await evaluate(send, 'typeof window.SPACESCIENCE === "object"')) break;
      await sleep(100);
    }
    if (!await evaluate(send, 'typeof window.SPACESCIENCE === "object"')) {
      throw new Error('game never booted (no debug hook)');
    }

    const r = await evaluate(send, AUTOPLAY(SHOTS));
    const mg = await evaluate(send, MERGE_SCENARIO);
    const wc = await evaluate(send, CLEAR_SCENARIO);
    const hy = await evaluate(send, HYPER_SCENARIO);
    const du = await evaluate(send, DUD_SCENARIO);
    const sd = await evaluate(send, SEED_SCENARIO);
    const cl = await evaluate(send, CEILING_SCENARIO);
    const tl = await evaluate(send, TAIL_SCENARIO);
    const od = await evaluate(send, ODD_SCENARIO);
    const bl = await evaluate(send, BLAST_SCENARIO);
    const rs = await evaluate(send, RESUME_SCENARIO);

    const checks = [
      ['no runtime errors', r.errors.length === 0, r.errors.join(' | ')],
      ['shots fired', r.shots >= SHOTS, `${r.shots}/${SHOTS}`],
      ['FF never rests on the board', r.ffResting === 0, `${r.ffResting} sightings`],
      ['only legal byte values on board', Object.keys(r.badValues).length === 0,
        JSON.stringify(r.badValues)],
      ['wave-1 ammo always matches an edge', r.ammoViolations === 0,
        `${r.ammoViolations}/${r.guaranteeChecks} violations`],
      ['no cells outside their row width', r.outOfRange === 0, `${r.outOfRange}`],
      ['fusions actually happen', r.merges > 0, `${r.merges}`],
      ['the ladder actually climbs', r.topByte !== '1', `top byte ${r.topByte}`],
      ['a group of 4 collapses pairwise to 2', mg.count === 2, JSON.stringify(mg)],
      ['and both are exactly one tier up', mg.values.every(v => v === 4), JSON.stringify(mg)],
      ['edge rule is non-vacuous', r.maxEnclosed > 0,
        'no orb was ever enclosed, so isEdge was never exercised'],
      // random aim rarely dies inside a short run, so only assert it on a long one
      ['reaches game over and restarts', SHOTS < 400 || r.games > 0, `${r.games} games`],
      ['80+80 clears the board', wc.sawClear, JSON.stringify(wc)],
      ['board clear burns exactly one FF', wc.ffBurned === 1, `${wc.ffBurned}`],
      ['board clear advances the wave', wc.levelAdvanced, JSON.stringify(wc)],
      ['next wave loads a fresh board', wc.freshBoardOrbs > 0, `${wc.freshBoardOrbs} orbs`],
      ['konami turns hyper on', hy.on.hyper === true && hy.before.hyper === false,
        JSON.stringify(hy)],
      ['hyper slams the buffer to 2', hy.on.shots === 2, JSON.stringify(hy)],
      ['a wrong sequence does not toggle it', hy.stillOn === true, JSON.stringify(hy)],
      ['deep waves hand out duds', du.duds > 0, `${du.duds}/${du.checks} shots`],
      ['deep waves stay even-only', du.oddValues === 0, `${du.oddValues} odd`],
      ['deep waves seed extra chains', du.distinctValues.length > 3,
        du.distinctValues.join(' ')],
      ['a seed reproduces its boards exactly', sd.reproducible, JSON.stringify(sd)],
      ['different seeds differ', sd.differs, JSON.stringify(sd)],
      ['a ceiling fusion survives', cl.count === 1, JSON.stringify(cl)],
      ['and it is the 08, still anchored', cl.count === 1 && cl.cells[0].v === 8 &&
        cl.cells[0].r === 0, JSON.stringify(cl)],
      ['a fusion keeps the tail hanging below it', tl.tailKept === 2, JSON.stringify(tl)],
      ['and nothing else fell with it', tl.count === 5, JSON.stringify(tl)],
      ['the bridge itself is the survivor', tl.bridgeHeld, JSON.stringify(tl)],
      ['three of a kind leaves exactly one cell', od.count === 1, JSON.stringify(od)],
      ['and that cell is the fused 08', od.count === 1 && od.cells[0].v === 8,
        JSON.stringify(od)],
      ['FF detonates its neighbours', bl.ffBurned === 1 && bl.count === 1,
        JSON.stringify(bl)],
      ['and spares cells it was not touching', bl.survivorIsFarOne, JSON.stringify(bl)],
      ['a settled board is offered for resume', !!rs.avail, JSON.stringify(rs)],
      ['resume restores the board exactly', rs.ok && rs.boardMatches, JSON.stringify(rs)],
      ['resume restores score, wave and ammo',
        rs.scoreOk && rs.levelOk && rs.ammoOk && rs.parityOk && rs.statsOk,
        JSON.stringify(rs)]
    ];

    console.log(`\n  autoplay: ${r.shots} shots, ${r.iterations} sim steps`);
    console.log(`  score ${r.score} | wave ${r.level} (max ${r.maxLevel}) | ` +
      `waves cleared ${r.waves} | games ${r.games}`);
    console.log(`  fusions ${r.merges} | best chain x${r.bestChain} | ` +
      `FF burned ${r.ffBurned} | top byte ${r.topByte} | peak orbs ${r.maxOrbs} ` +
      `(max enclosed ${r.maxEnclosed})\n`);

    console.log(`  deep-wave probe: wave ${du.level} | ${du.duds}/${du.checks} shots were duds | ` +
      `values seen: ${du.distinctValues.join(' ')}\n`);

    for (const [name, ok, detail] of checks) {
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + detail}`);
      if (!ok) failed = true;
    }
    console.log('');

    if (SCREENSHOT) {
      if (SCREENSHOT === 'title') await evaluate(send, 'location.reload()');
      await sleep(1200);
      const img = await send('Page.captureScreenshot', { format: 'png' });
      const out = path.join(ROOT, `screenshot-${SCREENSHOT}.png`);
      fs.writeFileSync(out, Buffer.from(img.data, 'base64'));
      console.log(`  wrote ${path.relative(ROOT, out)}\n`);
    }

    ws.close();
  } finally {
    chrome.kill();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('smoke failed: ' + e.message); process.exit(1); });
