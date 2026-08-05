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

// Local mirror of game.launcherVoids/isEdge. An empty neighbour only exposes an
// orb when that empty space is connected to the launcher below the board;
// sealed holes do not count as firing lanes.
const REACHABLE_EDGE = `
  const auditRowCols = r => ((r + G.parity) & 1) ? 11 : 12;
  const auditOffsets = r => ((r + G.parity) & 1)
    ? [[0,-1],[0,1],[-1,0],[-1,1],[1,0],[1,1]]
    : [[0,-1],[0,1],[-1,-1],[-1,0],[1,-1],[1,0]];
  const launcherOpen = () => {
    const bottom = G.grid.length, seen = new Set(), q = [];
    for (let c = 0; c < auditRowCols(bottom); c++) {
      seen.add(bottom + ',' + c); q.push([bottom, c]);
    }
    while (q.length) {
      const [r, c] = q.pop();
      for (const [dr, dc] of auditOffsets(r)) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr > bottom || cc < 0 || cc >= auditRowCols(rr)) continue;
        if (rr < bottom && G.grid[rr][cc]) continue;
        const k = rr + ',' + cc;
        if (seen.has(k)) continue;
        seen.add(k); q.push([rr, cc]);
      }
    }
    return seen;
  };
  const isReachableEdge = (r, c, open) => {
    for (const [dr, dc] of auditOffsets(r)) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr > G.grid.length || cc < 0 || cc >= auditRowCols(rr)) continue;
      if (rr < G.grid.length && G.grid[rr][cc]) continue;
      if (open.has(rr + ',' + cc)) return true;
    }
    return false;
  };
`;
// Runs inside the page: fires shots at random angles and audits invariants
// after every landing.
const AUTOPLAY = shots => `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  const errs = [];
  window.addEventListener('error', e => errs.push(e.message));

  ${POINTER}
  ${REACHABLE_EDGE}
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
    const open = launcherOpen();
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
        if (!isReachableEdge(r, c, open)) enclosed++;
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
        const open = launcherOpen();
        for (let r = 0; r < G.grid.length; r++)
          for (let c = 0; c < G.grid[r].length; c++) {
            const b = G.grid[r][c];
            if (!b) continue;
            allVals.add(b.v);
            if (isReachableEdge(r, c, open)) edgeVals.add(b.v);
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
  G.shots = 0; G.bufferLeft = G.shotsPerRow;
  G.pendingPush = false; G.pushAnim = 0; G.clearAnim = 0;
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

// Regression for the merge rule: this compact group forces both products onto
// adjacent ceiling cells. They are siblings from one pairwise collapse and must
// remain two 04s rather than immediately consuming each other into an 08.
const MERGE_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  ${POINTER}
  G.state = 'play'; G.parity = 0; G.ball = null;
  G.shots = 0; G.bufferLeft = G.shotsPerRow;
  G.pendingPush = false; G.pushAnim = 0;
  G.grid = [new Array(12).fill(null), new Array(11).fill(null)];
  G.grid[0][5] = { v: 2, pop: 1, born: 0 };
  G.grid[0][6] = { v: 2, pop: 1, born: 0 };
  G.grid[1][4] = { v: 2, pop: 1, born: 0 };
  G.cur = 2; G.next = [2, 2];

  aimAt(640, 60);                 // lands at row 1, col 5 under the pair
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
  ${REACHABLE_EDGE}
  const aim = () => {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.3;
    aimAt(640 + Math.cos(a) * 400, 656 + Math.sin(a) * 400);
  };
  // Dying would restart at wave 1 and quietly measure entropy 0 instead, so
  // the probe re-enters a deep wave every time the board resets.
  const deepen = () => { G.level = 11; S.nextWave(); };
  deepen();
  const edgeSet = () => {
    const m = new Set(), open = launcherOpen();
    for (let r = 0; r < G.grid.length; r++)
      for (let c = 0; c < G.grid[r].length; c++)
        if (G.grid[r][c] && isReachableEdge(r, c, open)) m.add(G.grid[r][c].v);
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
  G.shots = 0; G.bufferLeft = G.shotsPerRow;
  G.pendingPush = false; G.pushAnim = 0;
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
  G.shots = 0; G.bufferLeft = G.shotsPerRow;
  G.pendingPush = false; G.pushAnim = 0;
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
  G.shots = 0; G.bufferLeft = G.shotsPerRow;
  G.pendingPush = false; G.pushAnim = 0;
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
  G.shots = 0; G.bufferLeft = G.shotsPerRow;
  G.pendingPush = false; G.pushAnim = 0;
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

// An FF blast removes the only anchor above two tail cells. They drop on the
// same shot that made the inbound buffer due, buying two shots per dropped cell
// and cancelling that pending row.
const DROP_BUFFER_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  ${POINTER}
  G.state = 'play'; G.hyper = false; G.parity = 0; G.ball = null;
  G.level = 1; G.shotsPerRow = 8; G.shots = 0; G.bufferLeft = 1;
  G.pendingPush = false; G.pushAnim = 0;
  G.grid = [new Array(12).fill(null), new Array(11).fill(null),
            new Array(12).fill(null), new Array(11).fill(null)];
  G.grid[0][5] = { v: 0x80, pop: 1, born: 0 };  // overflows with the shot
  G.grid[0][10] = { v: 2, pop: 1, born: 0 };    // keeps the board non-empty
  G.grid[1][4] = { v: 0x10, pop: 1, born: 0 };  // blasted anchor
  G.grid[2][4] = { v: 0x20, pop: 1, born: 0 };  // DROP 1
  G.grid[3][4] = { v: 0x40, pop: 1, born: 0 };  // DROP 2
  G.cur = 0x80; G.next = [2, 2];

  aimAt(640, 100); key(' ');
  for (let i = 0; i < 500 && G.ball; i++) S.step();
  for (let i = 0; i < 8; i++) S.step();
  const cells = [];
  for (let r = 0; r < G.grid.length; r++)
    for (let c = 0; c < G.grid[r].length; c++)
      if (G.grid[r][c]) cells.push({ r, c, v: G.grid[r][c].v });
  return { bufferLeft: G.bufferLeft, pendingPush: G.pendingPush,
           parity: G.parity, pushAnim: G.pushAnim, cells, state: G.state };
})()`;

// A warp-created overflow is a SUPER FF: it removes the occupied support route
// from the burn site to row zero. The same board fired with an ordinary 80 only
// gets the normal one-ring blast, making the distinction deterministic.
const SUPER_FF_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  ${POINTER}
  const run = (warp, startBuffer = 8) => {
    G.state = 'play'; G.hyper = false; G.parity = 0; G.ball = null;
    G.level = 1; G.shotsPerRow = 8; G.shots = 0; G.bufferLeft = startBuffer;
    G.pendingPush = false; G.pushAnim = 0; G.clearAnim = 0;
    G.score = 0; G.merges = 0; G.bytes = 0; G.maxTile = 2;
    G.lastBonus = 0; G.charge = warp ? 1 : 0; G.warpReady = warp;
    G.grid = [new Array(12).fill(null), new Array(11).fill(null),
              new Array(12).fill(null), new Array(11).fill(null),
              new Array(12).fill(null)];
    // A three-orb support stem leads from the 80 target to the ceiling.
    G.grid[0][5] = { v: 2, pop: 1, born: 0 };
    G.grid[1][5] = { v: 4, pop: 1, born: 0 };
    G.grid[2][5] = { v: 8, pop: 1, born: 0 };
    G.grid[3][5] = { v: 0x80, pop: 1, born: 0 };
    G.cur = 0x80; G.next = [2, 2];

    aimAt(640, 60);
    if (warp) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    key(' ');
    if (warp) window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
    for (let i = 0; i < 500 && G.ball; i++) S.step();

    const cells = [];
    for (let r = 0; r < G.grid.length; r++)
      for (let c = 0; c < G.grid[r].length; c++)
        if (G.grid[r][c]) cells.push({ r, c, v: G.grid[r][c].v });
    return { state: G.state, cells, bufferLeft: G.bufferLeft, score: G.score,
             actionScore: G.score - (G.state === 'clear' ? G.lastBonus : 0),
             bonus: G.lastBonus, bytes: G.bytes };
  };
  return { ordinary: run(false), warp: run(true), capped: run(true, 31) };
})()`;

// Starting a run must write its initial board immediately, and a readable but
// malformed same-version payload must fail closed rather than throwing.
const SAVE_GUARD_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  localStorage.removeItem('spacescience.save');
  S.newGame();
  const immediate = S.resumeAvailable();
  const initialCells = G.grid.reduce((n, row) => n + row.filter(Boolean).length, 0);

  const valid = JSON.parse(localStorage.getItem('spacescience.save'));
  const malformed = structuredClone(valid);
  delete malformed.next;
  localStorage.setItem('spacescience.save', JSON.stringify(malformed));
  let threw = false, available = null, resumed = null;
  try { available = S.resumeAvailable(); resumed = S.resumeGame(); }
  catch (e) { threw = true; }

  const rejectedBuffers = [];
  for (const bad of [null, '99']) {
    const malformedBuffer = structuredClone(valid);
    malformedBuffer.bufferLeft = bad;
    localStorage.setItem('spacescience.save', JSON.stringify(malformedBuffer));
    rejectedBuffers.push(S.resumeAvailable());
  }

  const legacy = structuredClone(valid);
  legacy.score = 321;
  legacy.grid = legacy.grid.map(row => row.map(() => 0));
  legacy.grid[0][0] = 2;                 // legitimate ceiling anchor
  legacy.grid[3][legacy.grid[3].length - 1] = 4; // disconnected legacy artifact
  localStorage.setItem('spacescience.save', JSON.stringify(legacy));
  const repairedOk = S.resumeGame();
  const repaired = { score: G.score,
    values: G.grid.flatMap(row => row.filter(Boolean).map(b => b.v)) };

  const artifactOnly = structuredClone(valid);
  artifactOnly.score = 654;
  artifactOnly.grid = artifactOnly.grid.map(row => row.map(() => 0));
  artifactOnly.grid[3][artifactOnly.grid[3].length - 1] = 4;
  localStorage.setItem('spacescience.save', JSON.stringify(artifactOnly));
  const artifactOk = S.resumeGame();
  const artifactResult = { score: G.score, level: G.level,
    cells: G.grid.reduce((n, row) => n + row.filter(Boolean).length, 0) };

  const overCap = structuredClone(valid);
  overCap.bufferLeft = 99;
  localStorage.setItem('spacescience.save', JSON.stringify(overCap));
  const capResume = S.resumeGame(), cappedBuffer = G.bufferLeft;

  return { immediate, initialCells,
           malformed: { threw, available, resumed, rejectedBuffers },
           repairedOk, repaired, artifactOk, artifactResult,
           artifactLevel: artifactOnly.level, capResume, cappedBuffer };
})()`;

// Closing during BOARD CLEAR should retain the awarded score and consume the
// clear marker by loading the following wave on resume.
const CLEAR_RESUME_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  ${POINTER}
  S.newGame();
  const startScore = 1234, startLevel = G.level;
  G.score = startScore; G.parity = 0; G.ball = null;
  G.shots = 0; G.bufferLeft = G.shotsPerRow;
  G.pendingPush = false; G.pushAnim = 0; G.clearAnim = 0;
  G.grid = [new Array(12).fill(null)];
  G.grid[0][5] = { v: 0x80, pop: 1, born: 0 };
  G.cur = 0x80; G.next = [2, 2];
  aimAt(640, 100); key(' ');
  for (let i = 0; i < 500 && G.state !== 'clear'; i++) S.step();

  const cleared = { state: G.state, score: G.score, bonus: G.lastBonus,
                    earned: G.score - startScore, level: G.level,
                    available: S.resumeAvailable() };
  G.grid = []; G.score = 0; G.level = 99; G.lastBonus = 0;
  let threw = false, ok = false;
  try { ok = S.resumeGame(); } catch (e) { threw = true; }
  const cells = G.grid.reduce((n, row) => n + row.filter(Boolean).length, 0);
  return { cleared, threw, ok, state: G.state, score: G.score,
           level: G.level, cells, expectedLevel: startLevel + 1 };
})()`;

// A save is an atomic settled-board checkpoint. Toggling Hyper while a shot is
// flying must not persist the consumed ammo/countdown without the unrepresented
// ball, while settled pause and BOARD CLEAR toggles should survive a reload.
const HYPER_SAVE_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  ${POINTER}
  const code = () => {
    for (const k of ['ArrowUp','ArrowUp','ArrowDown','ArrowDown',
                     'ArrowLeft','ArrowRight','ArrowLeft','ArrowRight']) key(k);
  };
  const raw = () => localStorage.getItem('spacescience.save');
  const saved = () => JSON.parse(raw());

  S.newGame();
  const beforeRaw = raw(), before = saved();
  aimAt(760, 100); key(' ');
  const launched = { ball: !!G.ball, shots: G.shots, bufferLeft: G.bufferLeft };
  code();
  const duringRaw = raw();
  const liveHyper = G.hyper;
  const flightResume = S.resumeGame();
  const afterFlight = { hyper: G.hyper, ball: !!G.ball, shots: G.shots,
                        bufferLeft: G.bufferLeft,
                        grid: JSON.stringify(G.grid.map(row => row.map(b => b ? b.v : 0))) };

  S.newGame();
  G.state = 'pause';
  code();
  const paused = saved();
  const pauseResume = S.resumeGame();
  const afterPause = { hyper: G.hyper, state: G.state };

  S.newGame();
  const clearLevel = G.level;
  G.grid = []; G.ball = null; G.state = 'clear'; G.clearAnim = 1;
  code();
  const cleared = saved(), clearAvailable = S.resumeAvailable();
  const clearResume = S.resumeGame();
  const afterClear = { hyper: G.hyper, state: G.state, level: G.level,
                       shotsPerRow: G.shotsPerRow, cells: G.grid.reduce(
                         (n, row) => n + row.filter(Boolean).length, 0) };

  return {
    before, sameDuringFlight: beforeRaw === duringRaw, launched, liveHyper,
    flightResume, afterFlight,
    expectedGrid: JSON.stringify(before.grid),
    paused, pauseResume, afterPause,
    cleared, clearAvailable, clearResume, afterClear,
    expectedClearLevel: clearLevel + 1
  };
})()`;

// Input transitions are gesture-sized: a touch used to leave the title cannot
// leak through and fire, a repeated Space cannot pay for coin and launch, and R
// on the title replaces a held run with a fresh save.
const INPUT_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  const press = (key, repeat = false) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key, repeat }));
  const touch = (type, touches) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'touches', { value: touches });
    window.dispatchEvent(e);
  };

  localStorage.removeItem('spacescience.save');
  G.state = 'title'; G.coin = true; G.ball = null; G.shots = 0;
  touch('touchstart', [{ clientX: 640, clientY: 360 }]);
  touch('touchend', []);
  const touchResult = { state: G.state, shots: G.shots, ball: !!G.ball };

  localStorage.removeItem('spacescience.save');
  G.state = 'title'; G.coin = false; G.ball = null;
  press(' ');
  const afterCoin = { state: G.state, coin: G.coin };
  press(' ', true);
  const afterRepeat = { state: G.state, ball: !!G.ball };

  S.newGame();
  const held = JSON.parse(localStorage.getItem('spacescience.save'));
  held.score = 777;
  localStorage.setItem('spacescience.save', JSON.stringify(held));
  G.state = 'title'; G.coin = false;
  const beforeR = S.resumeAvailable();
  press('R');
  const afterR = S.resumeAvailable();
  const helpBefore = G.state;
  press('H');
  const helpOpen = { state: G.state, returnState: G.helpState, page: G.helpPage };
  press('ArrowRight');
  const helpPage = G.helpPage;
  press('Escape');
  const helpClosed = { state: G.state, returnState: G.helpState };
  return { touchResult, afterCoin, afterRepeat, beforeR, afterR,
           rState: helpBefore, rCoin: G.coin, helpOpen, helpPage, helpClosed };
})()`;

// Exercise multiple generators/entropy levels and independently prove every
// generated cell is connected to at least one occupied ceiling cell.
const GENERATED_CONNECTIVITY_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  const offsets = r => ((r + G.parity) & 1)
    ? [[0,-1],[0,1],[-1,0],[-1,1],[1,0],[1,1]]
    : [[0,-1],[0,1],[-1,-1],[-1,0],[1,-1],[1,0]];
  const detached = [];
  let boards = 0, empty = 0;
  const audit = label => {
    boards++;
    const seen = new Set(), q = [];
    for (let c = 0; c < (G.grid[0] || []).length; c++) if (G.grid[0][c]) {
      seen.add('0,' + c); q.push([0, c]);
    }
    while (q.length) {
      const [r, c] = q.pop();
      for (const [dr, dc] of offsets(r)) {
        const rr = r + dr, cc = c + dc, k = rr + ',' + cc;
        if (rr < 0 || rr >= G.grid.length || cc < 0 || cc >= G.grid[rr].length ||
            !G.grid[rr][cc] || seen.has(k)) continue;
        seen.add(k); q.push([rr, cc]);
      }
    }
    let cells = 0;
    for (let r = 0; r < G.grid.length; r++)
      for (let c = 0; c < G.grid[r].length; c++) if (G.grid[r][c]) {
        cells++;
        if (!seen.has(r + ',' + c)) detached.push(label + ':' + r + ',' + c);
      }
    if (!cells) empty++;
  };
  for (let seed = 1; seed <= 12; seed++) {
    S.setSeed(seed * 104729); S.newGame(); audit(seed + '/1');
    for (const level of [4, 8, 12]) {
      G.level = level - 1; S.nextWave(); audit(seed + '/' + level);
    }
  }
  return { boards, empty, detached: detached.slice(0, 20), count: detached.length };
})()`;

// Seed 75's first wave contains a sealed pocket. Prove that the ammo picker
// treats only launcher-connected empty space as exposure: cells bordering the
// pocket are false edges under the old local-hole rule, while the chambered
// byte still comes from a genuinely reachable edge.
const SEALED_CAVITY_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  ${REACHABLE_EDGE}
  S.setSeed(75); S.newGame();
  const open = launcherOpen(), edgeValues = new Set();
  let sealedVoids = 0, falseEdges = 0;
  for (let r = 0; r < G.grid.length; r++) {
    for (let c = 0; c < G.grid[r].length; c++) {
      const b = G.grid[r][c], key = r + ',' + c;
      if (!b) {
        if (!open.has(key)) sealedVoids++;
        continue;
      }
      if (isReachableEdge(r, c, open)) {
        edgeValues.add(b.v);
        continue;
      }
      // This is exactly the old predicate: any in-bounds empty neighbour.
      if (auditOffsets(r).some(([dr, dc]) => {
        const rr = r + dr, cc = c + dc;
        return rr >= 0 && rr < G.grid.length && cc >= 0 &&
          cc < auditRowCols(rr) && !G.grid[rr][cc];
      })) falseEdges++;
    }
  }
  return { sealedVoids, falseEdges, cur: G.cur,
           curReachable: edgeValues.has(G.cur), edgeValues: [...edgeValues] };
})()`;

// The renderer's ghost cell must be a property of the real projectile path,
// not a second approximate simulation. Sweep the complete legal aim range,
// alternate both lattice parities, and compare trace() with the cell that the
// live shot actually occupies. Calling trace() must itself be read-only.
const AIM_GUIDE_SCENARIO = `(() => {
  const S = window.SPACESCIENCE, G = S.G;
  ${POINTER}
  const failures = [];
  let mutations = 0, maxBounces = 0, directMatched = false;
  const parityChecks = [0, 0];
  const lo = -Math.PI + 0.26, hi = -0.26;

  for (let i = 0; i < 41; i++) {
    const parity = i & 1;
    // This near-limit angle was a concrete coarse-trace failure: the old
    // vx*.5 preview chose (0,9), while five-substep live motion chose (0,8).
    const angle = i === 2 ? -2.871106 : lo + (hi - lo) * i / 40;
    G.parity = parity;
    G.grid = [new Array(parity ? 11 : 12).fill(null)];
    G.grid[0][5] = { v: 2, pop: 1, born: 0 };
    G.state = 'play'; G.ball = null; G.angle = angle;
    G.shots = 0; G.bufferLeft = 32; G.pendingPush = false;
    G.pushAnim = 0; G.clearAnim = 0; G.over = 0;
    G.cur = 0xFE; G.next = [2, 4]; G.warpReady = false;

    const before = JSON.stringify(G);
    const predicted = S.trace();
    if (JSON.stringify(G) !== before) mutations++;
    maxBounces = Math.max(maxBounces, Math.max(0, predicted.pts.length - 2));

    key(' ');
    let steps = 0;
    while (G.ball && steps++ < 500) S.step();
    let actual = null;
    for (let r = 0; r < G.grid.length; r++)
      for (let c = 0; c < G.grid[r].length; c++)
        if (G.grid[r][c]?.v === 0xFE) actual = [r, c];

    const match = !!predicted.cell && !!actual &&
      predicted.cell[0] === actual[0] && predicted.cell[1] === actual[1];
    parityChecks[parity]++;
    if (i === 20) directMatched = match;
    if (!match) failures.push({ i, parity, angle, predicted: predicted.cell, actual, steps });
  }
  return { checks: 41, mutations, maxBounces, directMatched, parityChecks,
           failures: failures.slice(0, 8), mismatchCount: failures.length };
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
    const db = await evaluate(send, DROP_BUFFER_SCENARIO);
    const sf = await evaluate(send, SUPER_FF_SCENARIO);
    const sg = await evaluate(send, SAVE_GUARD_SCENARIO);
    const cr = await evaluate(send, CLEAR_RESUME_SCENARIO);
    const hs = await evaluate(send, HYPER_SAVE_SCENARIO);
    const ip = await evaluate(send, INPUT_SCENARIO);
    const gc = await evaluate(send, GENERATED_CONNECTIVITY_SCENARIO);
    const sc = await evaluate(send, SEALED_CAVITY_SCENARIO);
    const ag = await evaluate(send, AIM_GUIDE_SCENARIO);

    const checks = [
      ['no runtime errors', r.errors.length === 0, r.errors.join(' | ')],
      ['shots fired', r.shots >= SHOTS, `${r.shots}/${SHOTS}`],
      ['FF never rests on the board', r.ffResting === 0, `${r.ffResting} sightings`],
      ['only legal byte values on board', Object.keys(r.badValues).length === 0,
        JSON.stringify(r.badValues)],
      ['wave-1 ammo always matches an edge', r.ammoViolations === 0,
        `${r.ammoViolations}/${r.guaranteeChecks} violations`],
      ['no cells outside their row width', r.outOfRange === 0, `${r.outOfRange}`],
      // Screenshot runs intentionally stop at 80 shots; random aim can miss
      // every natural match that early. The deterministic merge scenarios
      // below cover the rule, while the full 500-shot gate must exercise it.
      ['fusions actually happen', SHOTS < 400 || r.merges > 0, `${r.merges}`],
      ['the ladder actually climbs', SHOTS < 400 || parseInt(r.topByte, 16) > 2,
        `top byte ${r.topByte}`],
      ['constrained 4x02 collapses pairwise to 2', mg.count === 2, JSON.stringify(mg)],
      ['and remains exactly two 04s', mg.values.length === 2 &&
        mg.values.every(v => v === 4), JSON.stringify(mg)],
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
        JSON.stringify(rs)],
      ['DROP x2 buys four buffer shots', db.bufferLeft === 4, JSON.stringify(db)],
      ['DROP cancels the due push', !db.pendingPush && db.parity === 0 &&
        db.pushAnim === 0 && db.state === 'play', JSON.stringify(db)],
      ['DROP removes only the detached tail', db.cells.length === 1 &&
        db.cells[0].r === 0 && db.cells[0].c === 10 && db.cells[0].v === 2,
        JSON.stringify(db)],
      ['ordinary FF keeps the upper support stem', sf.ordinary.state === 'play' &&
        sf.ordinary.cells.length === 2 && sf.ordinary.cells.every((x, i) =>
          x.r === i && x.c === 5 && x.v === (i ? 4 : 2)) &&
        sf.ordinary.bufferLeft === 7, JSON.stringify(sf)],
      ['warp overflow becomes a SUPER FF ceiling-route drop',
        sf.warp.state === 'clear' && sf.warp.cells.length === 0 &&
        sf.warp.bytes === 1 && sf.warp.actionScore === 4184 &&
        sf.warp.bufferLeft === 13, JSON.stringify(sf)],
      ['inbound buffer never banks above 32', sf.capped.state === 'clear' &&
        sf.capped.bufferLeft === 32, JSON.stringify(sf)],
      ['new game is immediately resumable', !!sg.immediate &&
        sg.immediate.cells === sg.initialCells && sg.initialCells > 0,
        JSON.stringify(sg)],
      ['malformed same-version save fails closed', !sg.malformed.threw &&
        sg.malformed.available === null && sg.malformed.resumed === false,
        JSON.stringify(sg)],
      ['malformed buffer values are not coerced',
        sg.malformed.rejectedBuffers.length === 2 &&
        sg.malformed.rejectedBuffers.every(v => v === null), JSON.stringify(sg)],
      ['legacy detached save cells are pruned without rewards', sg.repairedOk &&
        sg.repaired.score === 321 && sg.repaired.values.length === 1 &&
        sg.repaired.values[0] === 2, JSON.stringify(sg)],
      ['artifact-only legacy save reloads the same wave', sg.artifactOk &&
        sg.artifactResult.score === 654 &&
        sg.artifactResult.level === sg.artifactLevel &&
        sg.artifactResult.cells > 0, JSON.stringify(sg)],
      ['legacy over-cap buffer resumes at 32', sg.capResume &&
        sg.cappedBuffer === 32, JSON.stringify(sg)],
      ['clear interstitial save retains its bonus', cr.cleared.state === 'clear' &&
        cr.cleared.bonus === 5000 && cr.cleared.earned >= cr.cleared.bonus &&
        !!cr.cleared.available && cr.cleared.available.score === cr.cleared.score,
        JSON.stringify(cr)],
      ['clear interstitial resumes into the next wave', !cr.threw && cr.ok &&
        cr.state === 'play' && cr.level === cr.expectedLevel &&
        cr.score === cr.cleared.score && cr.cells > 0, JSON.stringify(cr)],
      ['in-flight Hyper cannot save a partial shot', hs.launched.ball &&
        hs.launched.shots === hs.before.shots + 1 && hs.liveHyper &&
        hs.sameDuringFlight && hs.flightResume && !hs.afterFlight.hyper &&
        !hs.afterFlight.ball && hs.afterFlight.shots === hs.before.shots &&
        hs.afterFlight.bufferLeft === hs.before.bufferLeft &&
        hs.afterFlight.grid === hs.expectedGrid, JSON.stringify(hs)],
      ['paused Hyper toggle survives reload', hs.paused.hyper &&
        !hs.paused.clearPending && hs.pauseResume && hs.afterPause.hyper &&
        hs.afterPause.state === 'play', JSON.stringify(hs)],
      ['wave-clear Hyper toggle survives into the next wave', hs.cleared.hyper &&
        hs.cleared.clearPending && hs.clearAvailable.clearPending &&
        hs.clearResume && hs.afterClear.hyper && hs.afterClear.state === 'play' &&
        hs.afterClear.level === hs.expectedClearLevel &&
        hs.afterClear.shotsPerRow === 2 && hs.afterClear.cells > 0,
        JSON.stringify(hs)],
      ['title touch transition does not auto-fire', ip.touchResult.state === 'play' &&
        ip.touchResult.shots === 0 && !ip.touchResult.ball, JSON.stringify(ip)],
      ['repeated Space cannot pay and fire', ip.afterCoin.state === 'title' &&
        ip.afterCoin.coin && ip.afterRepeat.state === 'title' &&
        !ip.afterRepeat.ball, JSON.stringify(ip)],
      ['title R discards a held run', ip.beforeR && ip.beforeR.score === 777 &&
        ip.afterR && ip.afterR.score === 0 && ip.rState === 'play' && ip.rCoin,
        JSON.stringify(ip)],
      ['help opens, pages, and restores play', ip.helpOpen.state === 'help' &&
        ip.helpOpen.returnState === 'play' && ip.helpOpen.page === 0 &&
        ip.helpPage === 1 && ip.helpClosed.state === 'play' &&
        ip.helpClosed.returnState === null, JSON.stringify(ip)],
      ['generated boards remain ceiling-connected', gc.boards === 48 &&
        gc.empty === 0 && gc.count === 0, JSON.stringify(gc)],
      ['seed 75 contains a genuinely sealed cavity', sc.sealedVoids > 0 &&
        sc.falseEdges > 0, JSON.stringify(sc)],
      ['sealed cavities cannot define wave-1 ammo', sc.curReachable,
        JSON.stringify(sc)],
      ['aim prediction is read-only', ag.mutations === 0, JSON.stringify(ag)],
      ['ghost cell matches all 41 live landings', ag.checks === 41 &&
        ag.mismatchCount === 0, JSON.stringify(ag)],
      ['aim sweep covers direct, banked and both-parity shots', ag.directMatched &&
        ag.maxBounces >= 2 && ag.parityChecks.every(n => n > 0), JSON.stringify(ag)]
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
