import {
  VW, VH, R, COLS, ROWH, TAU, PF_X, PF_W, PF_TOP, DANGER_Y,
  FRAME, LEFT_PANEL, RIGHT_PANEL, LAUNCH, TIERS, FULL, TITLE, SITE, REPO, VERSION
} from './config.js';
import { cvs, ctx, wc, w, VIEW, SCREEN } from './canvas.js';
import { clamp, rnd, rint, vcol, hexLabel } from './util.js';
import { drawBubble, hexPath } from './sprites.js';
import { FX, drawFX } from './fx.js';
import { drawStars, drawCopper, drawWire, plasmaCanvas } from './backdrop.js';
import { neon, chromeLogo, drawScroller, SCROLL_Y } from './text.js';
import {
  G, cellX, cellY, rowShift, trace,
  edgeValues, boardValues, entropy, resumeAvailable
} from './game.js';
import { keys, HELP_PAGE_COUNT } from './input.js';
import { Snd } from './audio.js';
import { begin, lap } from './profile.js';
import { RNG } from './rng.js';
import { STATS, formatDuration } from './stats.js';

/* ------------------------------------------------------------ panel chrome */
// Panel borders are large blurred strokes and never change, so each distinct
// panel is rasterised once and blitted after that.
const panelCache = new Map();

// Panel titles are baked into their cached canvases, so a font-ready refresh
// has to invalidate these as well as the ordinary text/sprite caches.
export function clearPanelCache() { panelCache.clear(); }

// `chromeOnly` skips the tinted backing plate. The HUD panels are drawn before
// their contents so they want it, but the playfield frame goes on top of the
// board -- filling there would lay a 62% dark veil over every orb.
function panel(g, x, y, wd, h, hue, title, chromeOnly) {
  const key = `${wd}|${h}|${hue}|${title || ''}|${chromeOnly ? 'c' : 'f'}`;
  let sp = panelCache.get(key);
  if (!sp) {
    const pad = 28;                       // covers the glow and the title tab
    const cv = document.createElement('canvas');
    cv.width = wd + pad * 2;
    cv.height = h + pad * 2;
    drawPanelChrome(cv.getContext('2d'), pad, pad, wd, h, hue, title, chromeOnly);
    sp = { cv, pad };
    panelCache.set(key, sp);
  }
  g.drawImage(sp.cv, x - sp.pad, y - sp.pad);
}

function drawPanelChrome(g, x, y, wd, h, hue, title, chromeOnly) {
  g.save();
  if (!chromeOnly) {
    g.fillStyle = 'rgba(4,2,20,0.62)';
    g.fillRect(x, y, wd, h);
  }

  g.strokeStyle = `hsla(${hue},100%,62%,.85)`;
  g.lineWidth = 2;
  g.shadowColor = `hsl(${hue},100%,60%)`;
  g.shadowBlur = 12;
  g.strokeRect(x + .5, y + .5, wd - 1, h - 1);
  g.shadowBlur = 0;

  g.strokeStyle = `hsla(${hue},100%,80%,.30)`;
  g.lineWidth = 1;
  g.strokeRect(x + 4.5, y + 4.5, wd - 9, h - 9);

  g.strokeStyle = `hsl(${hue},100%,75%)`;
  g.lineWidth = 2.5;
  const L = 16;
  for (const [px, py, sx, sy] of
    [[x, y, 1, 1], [x + wd, y, -1, 1], [x, y + h, 1, -1], [x + wd, y + h, -1, -1]]) {
    g.beginPath();
    g.moveTo(px + sx * L, py);
    g.lineTo(px, py);
    g.lineTo(px, py + sy * L);
    g.stroke();
  }

  if (title) {
    g.fillStyle = '#05001a';
    g.fillRect(x + 14, y - 9, title.length * 11 + 14, 18);
    neon(g, title, x + 21, y + 4, 13, `hsl(${hue},100%,70%)`, { track: 2, glow: 10 });
  }
  g.restore();
}

/* --------------------------------------------------------------- playfield */
// The empty-cell lattice has two parity variants. An inbound row flips the
// board's parity, so cache one blit for each instead of rebuilding ~190 paths.
const meshSprites = [null, null];
function hexMesh(parity) {
  parity &= 1;
  if (meshSprites[parity]) return meshSprites[parity];
  const cv = document.createElement('canvas');
  cv.width = FRAME.w;
  cv.height = FRAME.h;
  const g = cv.getContext('2d');
  g.translate(-FRAME.x, -FRAME.y);
  g.globalAlpha = .085;
  g.strokeStyle = '#3af';
  g.lineWidth = 1;
  for (let r = 0; r < 16; r++) {
    const y = PF_TOP + R + r * ROWH;
    if (y - R > FRAME.y + FRAME.h) break;
    for (let c = 0; c < COLS; c++) {
      const x = PF_X + R + (((r + parity) & 1) ? R : 0) + c * 2 * R;
      if (x + R > PF_X + PF_W + 1) break;
      g.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = i * TAU / 6 - Math.PI / 6;
        const px = x + Math.cos(a) * (R - 1), py = y + Math.sin(a) * (R - 1);
        if (i) g.lineTo(px, py); else g.moveTo(px, py);
      }
      g.closePath(); g.stroke();
    }
  }
  meshSprites[parity] = cv;
  return cv;
}

function drawPlayfield(g, t, frameScale) {
  const sy = rowShift();
  g.save();
  g.beginPath(); g.rect(FRAME.x, FRAME.y, FRAME.w, FRAME.h); g.clip();

  g.fillStyle = 'rgba(2,0,14,0.68)';
  g.fillRect(FRAME.x, FRAME.y, FRAME.w, FRAME.h);

  g.drawImage(hexMesh(G.parity), FRAME.x, FRAME.y);

  // danger line
  const dz = 0.55 + Math.sin(t * 6) * 0.35;
  g.strokeStyle = `rgba(255,40,80,${dz})`;
  g.lineWidth = 2;
  g.setLineDash([12, 9]);
  g.lineDashOffset = -t * 40;
  g.beginPath();
  g.moveTo(PF_X, DANGER_Y + R);
  g.lineTo(PF_X + PF_W, DANGER_Y + R);
  g.stroke();
  g.setLineDash([]);
  const dg = g.createLinearGradient(0, DANGER_Y + R, 0, FRAME.y + FRAME.h);
  dg.addColorStop(0, `rgba(255,20,70,${0.20 * dz})`);
  dg.addColorStop(1, 'rgba(255,0,60,0)');
  g.fillStyle = dg;
  g.fillRect(PF_X, DANGER_Y + R, PF_W, FRAME.h);

  // aim guide
  if (G.state === 'play' && !G.ball) {
    const guide = trace();
    const pts = guide.pts;
    const warp = G.warpReady && keys.shift;
    g.save();
    g.setLineDash([7, 10]);
    g.lineDashOffset = -t * 90;
    g.strokeStyle = warp ? 'rgba(255,255,255,.8)' : 'rgba(120,255,240,.55)';
    g.lineWidth = 2;
    g.shadowColor = '#0ff';
    g.shadowBlur = 10;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.stroke();
    g.restore();
    if (guide.cell) {
      const [r, c] = guide.cell;
      const x = cellX(r, c), y = cellY(r) + sy;
      const pulse = 1 + Math.sin(t * 7) * .035;
      g.save();
      g.globalCompositeOperation = 'lighter';
      drawBubble(g, x, y, warp ? -1 : G.cur, pulse, .30);
      g.globalCompositeOperation = 'source-over';
      g.setLineDash([5, 4]);
      g.lineDashOffset = t * 32;
      g.strokeStyle = warp ? 'rgba(255,255,255,.85)' : 'rgba(140,255,245,.78)';
      g.lineWidth = 1.5;
      g.shadowColor = warp ? '#fff' : '#0ff';
      g.shadowBlur = 8;
      hexPath(g, x, y, R * (1.08 + Math.sin(t * 7) * .025));
      g.stroke();
      g.restore();
    }
  }

  // orbs
  for (let r = 0; r < G.grid.length; r++) {
    const y = cellY(r) + sy;
    if (y < FRAME.y - 40 || y > FRAME.y + FRAME.h + 40) continue;
    const row = G.grid[r];
    for (let c = 0; c < row.length; c++) {
      const b = row[c];
      if (!b) continue;
      if (b.pop > 1) b.pop += (1 - b.pop) * (1 - Math.pow(0.84, frameScale));
      const x = cellX(r, c);
      const bob = Math.sin(t * 2 + r * 0.5 + c * 0.35) * 1.1;
      drawBubble(g, x, y + bob, b.v, b.pop);
      if (b.pop > 1.02) {
        g.globalCompositeOperation = 'lighter';
        g.strokeStyle = vcol(b.v, 85, 100, (b.pop - 1) * 1.4);
        g.lineWidth = 3;
        g.beginPath();
        g.arc(x, y + bob, R * b.pop * 1.15, 0, TAU);
        g.stroke();
        g.globalCompositeOperation = 'source-over';
      }
    }
  }

  // in-flight orb with a motion trail
  if (G.ball) {
    const b = G.ball;
    g.globalCompositeOperation = 'lighter';
    for (let i = 1; i <= 5; i++) {
      g.globalAlpha = 0.12 * (6 - i);
      drawBubble(g, b.x - b.vx * i * .35, b.y - b.vy * i * .35, b.v, 1 - i * .06);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    drawBubble(g, b.x, b.y, b.v, 1 + Math.sin(t * 22) * .04);
  }

  drawFX(g);
  g.restore();
  panel(g, FRAME.x, FRAME.y, FRAME.w, FRAME.h, G.hyper ? 350 : 195, null, true);
}

/* ---------------------------------------------------------------- launcher */
function drawLauncher(g, t) {
  const x = LAUNCH.x, y = LAUNCH.y;

  g.save();
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {
    const rr = 26 + i * 9 + Math.sin(t * 3 - i) * 2;
    const dir = i % 2 ? -1 : 1;
    g.strokeStyle = `hsla(${190 + i * 30},100%,60%,${.35 - i * .08})`;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(x, y, rr, t * dir + i, t * dir + i + 2.2);
    g.stroke();
  }
  g.restore();

  g.save();
  g.translate(x, y);
  g.rotate(G.angle + Math.PI / 2);
  const bg = g.createLinearGradient(-9, 0, 9, 0);
  bg.addColorStop(0, '#0a2a44');
  bg.addColorStop(.5, '#7fe8ff');
  bg.addColorStop(1, '#0a2a44');
  g.fillStyle = bg;
  g.shadowColor = '#0ff';
  g.shadowBlur = 14;
  g.fillRect(-8, -44, 16, 46);
  g.fillStyle = 'rgba(255,255,255,.85)';
  g.fillRect(-8, -46, 16, 4);
  g.shadowBlur = 0;
  g.strokeStyle = 'rgba(0,255,255,.5)';
  g.lineWidth = 1;
  for (let i = -40; i < 0; i += 6) {
    g.beginPath(); g.moveTo(-8, i); g.lineTo(8, i); g.stroke();
  }
  g.restore();

  g.save();
  g.globalCompositeOperation = 'lighter';
  const cg = g.createRadialGradient(x, y, 2, x, y, 40);
  cg.addColorStop(0, G.warpReady ? 'rgba(255,255,255,.5)' : 'rgba(0,220,255,.35)');
  cg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = cg;
  g.fillRect(x - 40, y - 40, 80, 80);
  g.restore();

  drawBubble(g, x, y, G.warpReady && keys.shift ? -1 : G.cur, 1 + Math.sin(t * 9) * .04);
}

/* --------------------------------------------------------------- hud left */
// Reused every frame so the analyser does not allocate; PEAKS adds the falling
// cap so the bars decay instead of strobing.
const SPECTRUM = new Float32Array(26);
const PEAKS = new Float32Array(26);

function drawLeftPanel(g, t, frameScale) {
  const { x: LX, y: LY, w: LW, h: LH } = LEFT_PANEL;
  panel(g, LX, LY, LW, LH, G.hyper ? 350 : 300, G.hyper ? 'STATUS //HYPER' : 'STATUS');

  let y = LY + 40;
  neon(g, 'SCORE', LX + 22, y, 15, '#ff5ce0', { track: 3, glow: 8 });
  y += 44;
  neon(g, String(G.score).padStart(8, '0'), LX + 22, y, 38, '#ffe66d', { glow: 22, track: 1 });
  y += 34;
  neon(g, 'HI ' + String(G.best).padStart(8, '0'), LX + 22, y, 17, '#7fffd4', { track: 2, glow: 8 });

  y += 40;
  g.strokeStyle = 'rgba(255,255,255,.15)';
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(LX + 18, y); g.lineTo(LX + LW - 18, y); g.stroke();

  y += 30;
  for (const [k, v] of [
    ['WAVE', G.level],
    ['ORBS LEFT', orbCount()],
    ['FF BURNED', G.bytes],
    ['FUSIONS', G.merges],
    ['BEST CHAIN', 'x' + G.bestCombo]
  ]) {
    neon(g, k, LX + 22, y, 14, '#89b4ff', { track: 2, glow: 6 });
    neon(g, String(v), LX + LW - 22, y, 16, '#fff', { align: 'right', track: 1, glow: 8 });
    y += 27;
  }

  const mw = LW - 44;

  // descent meter
  y += 16;
  const left = G.bufferLeft;
  const danger = left <= 2;
  neon(g, 'INBOUND BUFFER ' + left, LX + 22, y, 14,
    danger ? '#ff4060' : '#ffb347', { track: 2, glow: danger ? 14 : 6 });
  y += 12;
  g.fillStyle = 'rgba(255,255,255,.10)';
  g.fillRect(LX + 22, y, mw, 10);
  const mg = g.createLinearGradient(LX + 22, 0, LX + 22 + mw, 0);
  mg.addColorStop(0, '#ffb347');
  mg.addColorStop(1, '#ff2d55');
  g.fillStyle = mg;
  g.fillRect(LX + 22, y, mw * clamp(1 - left / G.shotsPerRow, 0, 1), 10);
  g.strokeStyle = 'rgba(255,255,255,.3)';
  g.strokeRect(LX + 22.5, y + .5, mw - 1, 9);

  // warp charge
  y += 44;
  neon(g, G.warpReady ? 'WARP ORB READY [SHIFT]' : 'WARP CHARGE', LX + 22, y, 14,
    G.warpReady ? '#fff' : '#4de1ff', { track: 2, glow: G.warpReady ? 18 : 6 });
  y += 12;
  g.fillStyle = 'rgba(255,255,255,.10)';
  g.fillRect(LX + 22, y, mw, 12);
  if (G.warpReady) {
    for (let i = 0; i < mw; i += 4) {
      g.fillStyle = `hsl(${(i * 2 + t * 260) % 360},100%,62%)`;
      g.fillRect(LX + 22 + i, y, 3, 12);
    }
  } else {
    const cg = g.createLinearGradient(LX + 22, 0, LX + 22 + mw, 0);
    cg.addColorStop(0, '#0af');
    cg.addColorStop(1, '#0ff');
    g.fillStyle = cg;
    g.fillRect(LX + 22, y, mw * G.charge, 12);
  }
  g.strokeStyle = 'rgba(255,255,255,.3)';
  g.strokeRect(LX + 22.5, y + .5, mw - 1, 11);

  // spectrum analyser, fed by an AnalyserNode on the master bus
  y += 44;
  const bars = SPECTRUM.length, bw = (mw - (bars - 1) * 2) / bars;
  const live = Snd.spectrum(bars, SPECTRUM);
  for (let i = 0; i < bars; i++) {
    // Before the first user gesture there is no audio graph at all, so idle on
    // a sine shimmer rather than showing a dead flat row.
    const level = live ? live[i]
      : (0.10 + 0.10 * Math.sin(t * 6 + i * 0.7) * Math.sin(t * 2.3 + i * 0.21));
    // Decay caps make the bars fall smoothly instead of strobing.
    if (level >= PEAKS[i]) PEAKS[i] = level;
    else PEAKS[i] = Math.max(level, PEAKS[i] - 0.02 * frameScale);
    const h = PEAKS[i] * 46 + 3;
    const hue = 200 + i * 5;
    const bx = LX + 22 + i * (bw + 2);
    g.fillStyle = `hsla(${hue},100%,60%,.85)`;
    g.fillRect(bx, y + 50 - h, bw, h);
    g.fillStyle = `hsla(${hue},100%,85%,.9)`;
    g.fillRect(bx, y + 50 - h, bw, 2);
  }
  neon(g, 'AUDIO :: ' + (Snd.S.music ? 'ONLINE' : 'MUTED'), LX + 22, y + 70, 12,
    Snd.S.music ? '#5cff9d' : '#ff5c5c', { track: 2, glow: 6 });

  let cy = LY + LH - 84;
  for (const s of [
    'MOUSE / ARROWS   AIM',
    'CLICK / SPACE    FIRE',
    'SHIFT+FIRE       WARP ORB',
    'M / S   MUSIC / SFX',
    'P PAUSE   R RESTART   H HELP'
  ]) {
    neon(g, s, LX + 22, cy, 12, '#7a8cc9', { track: 1.2, glow: 4 });
    cy += 18;
  }
}

/* -------------------------------------------------------------- hud right */
const LADDER = [...TIERS, FULL];

function orbCount() {
  let n = 0;
  for (const row of G.grid) for (const b of row) if (b) n++;
  return n;
}

function drawRightPanel(g, t) {
  const { x: RX, y: RY, w: RW, h: RH } = RIGHT_PANEL;
  panel(g, RX, RY, RW, RH, 165, 'MAGAZINE');

  neon(g, 'IN CHAMBER', RX + 22, RY + 44, 14, '#5cffb0', { track: 2, glow: 8 });
  if (G.dud) {
    g.globalAlpha = 0.6 + 0.4 * Math.sin(t * 7);
    neon(g, 'DUD - NO EDGE MATCH', RX + 128, RY + 44, 11, '#ff4060', { track: 1, glow: 12 });
    g.globalAlpha = 1;
  }
  drawBubble(g, RX + 70, RY + 92, G.cur, 1.12 + Math.sin(t * 4) * .03);
  neon(g, 'NEXT UP', RX + 130, RY + 78, 13, '#89b4ff', { track: 2, glow: 6 });
  G.next.forEach((v, i) => drawBubble(g, RX + 152 + i * 58, RY + 104, v, 0.82 - i * 0.12));

  g.strokeStyle = 'rgba(255,255,255,.15)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(RX + 18, RY + 150);
  g.lineTo(RX + RW - 18, RY + 150);
  g.stroke();

  neon(g, 'ON THE LATTICE', RX + 22, RY + 180, 14, '#5cffb0', { track: 2, glow: 8 });
  neon(g, 'RINGED = ON AN EDGE, LOADABLE', RX + 22, RY + 198, 10, '#7a8cc9',
    { track: 1, glow: 4 });

  // Values change from wave to wave now that chains other than the powers of
  // two get seeded, so this lists what is actually out there rather than a
  // fixed ladder. FF always tails it as the only exit.
  const edge = edgeValues();
  const present = [...boardValues().keys()].sort((a, b) => a - b).slice(0, 8);
  [...present, FULL].forEach((v, i) => {
    const x = RX + 52 + (i % 3) * 74;
    const y = RY + 240 + ((i / 3) | 0) * 60;
    const loadable = edge.has(v);
    g.globalAlpha = loadable || v === FULL ? 1 : 0.3;
    drawBubble(g, x, y, v, 0.62);
    g.globalAlpha = 1;
    if (loadable) {
      g.strokeStyle = `rgba(255,255,255,${0.45 + Math.sin(t * 5 + i) * 0.2})`;
      g.lineWidth = 1.5;
      hexPath(g, x, y, 20);
      g.stroke();
      neon(g, String(edge.get(v)), x, y + 28, 10, '#7fffd4',
        { align: 'center', track: 0.5, glow: 5 });
    } else if (v === FULL) {
      neon(g, 'BURNS OFF', x, y + 28, 9, '#ffe66d', { align: 'center', track: 0.5, glow: 6 });
    } else {
      neon(g, 'BURIED', x, y + 28, 9, '#ff6a80', { align: 'center', track: 0.5, glow: 5 });
    }
  });

  // Entropy: how weird the next wave is allowed to get.
  const e = entropy();
  const ew = RW - 44;
  neon(g, G.hyper ? 'ENTROPY // HYPER' : 'ENTROPY ' + Math.round(e * 100) + '%',
    RX + 22, RY + 452, 13, G.hyper ? '#ff4060' : '#89b4ff', { track: 2, glow: G.hyper ? 16 : 6 });
  g.fillStyle = 'rgba(255,255,255,.10)';
  g.fillRect(RX + 22, RY + 462, ew, 9);
  const eg = g.createLinearGradient(RX + 22, 0, RX + 22 + ew, 0);
  eg.addColorStop(0, '#4de1ff');
  eg.addColorStop(1, '#ff2d55');
  g.fillStyle = eg;
  g.fillRect(RX + 22, RY + 462, ew * e, 9);
  g.strokeStyle = 'rgba(255,255,255,.3)';
  g.lineWidth = 1;
  g.strokeRect(RX + 22.5, RY + 462.5, ew - 1, 8);

  // Wireframe sits a little higher to clear the three footer lines.
  drawWire(g, RX + RW / 2, RY + RH - 114, 36, t, (t * 30) % 360);
  neon(g, 'SEED ' + RNG.seed, RX + RW / 2, RY + RH - 52, 9, '#7a8cc9',
    { align: 'center', track: 1, glow: 4 });
  neon(g, SITE, RX + RW / 2, RY + RH - 34, 12, '#5cffb0',
    { align: 'center', track: 2, glow: 8 });
  neon(g, REPO + '  //  v' + VERSION, RX + RW / 2, RY + RH - 18, 9, '#7a8cc9',
    { align: 'center', track: 1, glow: 4 });
}

/* --------------------------------------------------------------- fun fact */
// Tucked behind the F key. Nothing points at it in the UI on purpose.
const FUN_FACT = [
  ['THE MUSIC IS NOT OURS', 20, '#ffe66d'],
  ['', 8, '#fff'],
  ['EVERY NOTE YOU HAVE BEEN HEARING COMES', 14, '#fff'],
  ['STRAIGHT OUT OF  F R O Z E N   B U B B L E ,', 14, '#0ff'],
  ['THE GPL-2.0 PENGUIN CLASSIC FROM 2002 BY', 14, '#fff'],
  ['GUILLAUME COTTENCEAU AND CONTRIBUTORS -', 14, '#fff'],
  ['THE SAME GAME THIS ONE STOLE ITS', 14, '#fff'],
  ['BOUNCE-AND-STICK PHYSICS FROM.', 14, '#fff'],
  ['', 10, '#fff'],
  ['INTROZIK HOLDS THE MENU.', 13, '#5cffb0'],
  ['MAINZIK 2P TAKES YOU IN, 1P TRADES OFF.', 13, '#5cffb0'],
  ['', 10, '#fff'],
  ['SO: THANK YOU, PENGUINS.', 14, '#ff5ce0'],
  ['', 12, '#fff'],
  ['PRESS  F  TO CLOSE', 12, '#7a8cc9']
];

function drawFunFact(g, t) {
  const bw = 620, bh = 360, bx = VW / 2 - bw / 2, by = 200;
  g.fillStyle = 'rgba(2,0,14,.93)';
  g.fillRect(bx, by, bw, bh);
  panel(g, bx, by, bw, bh, 48, 'FUN FACT');
  let y = by + 56;
  for (const [line, size, col] of FUN_FACT) {
    if (line) neon(g, line, VW / 2, y, size, col, { align: 'center', track: 1.5, glow: 8 });
    y += size + 8;
  }
}

/* ------------------------------------------------------------ field manual */
const HELP_PAGES = [
  {
    title: 'MISSION // FIRE CONTROL',
    sections: [
      ['OBJECTIVE', [
        'CLEAR EVERY ORB TO FINISH THE WAVE. A DEEPER, FASTER BOARD FOLLOWS.',
        'CELLS LEAVE THROUGH FF BURNS OR WHEN THEIR CEILING SUPPORT IS CUT.'
      ]],
      ['BASIC SHOOTING', [
        'MOVE THE MOUSE OR HOLD LEFT / RIGHT TO AIM THE CANNON.',
        'CLICK OR PRESS SPACE TO FIRE THE VALUE SHOWN IN CHAMBER.',
        'THE NEXT QUEUE IS VISIBLE IN THE MAGAZINE. PLAN MORE THAN ONE SHOT.',
        'BANK SHOTS OFF SIDE WALLS; THE DOTTED LINE SHOWS THE PHYSICAL ROUTE.',
        'THE GHOST HEX MARKS THE EXACT LATTICE CELL WHERE THE SHOT WILL SNAP.'
      ]],
      ['STICKING', [
        'A SHOT STICKS TO THE CEILING OR THE FIRST ORB IT REACHES.',
        'MATCH EXACT HEX VALUES. CLOSE COLOURS ARE NOT NECESSARILY A MATCH.'
      ]]
    ]
  },
  {
    title: 'PAIRWISE // ODD GROUPS // CASCADES',
    sections: [
      ['PAIRWISE FUSION', [
        'TWO TOUCHING EQUAL VALUES BECOME ONE ORB WORTH TWICE AS MUCH.',
        'FOUR 02s MAKE TWO 04s. THEY DO NOT JUMP STRAIGHT TO ONE 08.'
      ]],
      ['ODD GROUPS', [
        'AN ODD CELL IS ABSORBED INSTEAD OF BEING LEFT STRANDED.',
        'THREE 04s MAKE ONE 08; THE SPARE 04 VALUE IS LOST.',
        'FIVE MATCHES MAKE TWO DOUBLED ORBS, AND SO ON.'
      ]],
      ['CASCADES', [
        'A NEW RESULT CAN FUSE AGAIN WITH A MATCH THAT WAS ALREADY ON THE BOARD.',
        'SIBLINGS CREATED TOGETHER DO NOT EAT EACH OTHER IN THAT SAME PASS.',
        'DEEPER CASCADES SCORE MORE. SURVIVORS TRY TO KEEP CEILING SUPPORT.'
      ]]
    ]
  },
  {
    title: 'BYTE LADDERS // FF // DROPS',
    sections: [
      ['BYTE LADDERS', [
        'THE MAIN CLIMB IS 02 04 08 10 20 40 80. VALUES ARE HEXADECIMAL.',
        'OTHER EVEN ROOTS HAVE THEIR OWN LADDERS: 0A 14 28 50 A0, FOR EXAMPLE.',
        'ONLY EXACT VALUES FUSE. 0A NEVER MATCHES 08.'
      ]],
      ['FF OVERFLOW', [
        'WHEN DOUBLING NO LONGER FITS IN ONE BYTE, THE RESULT SATURATES TO FF.',
        '80 + 80 IS THE CLASSIC OVERFLOW. FF NEVER RESTS ON THE LATTICE.',
        'AN FF BURN ALSO DETONATES EVERY ORB TOUCHING IT, ONE TILE OUT.',
        'A WARP-CAUSED OVERFLOW BECOMES SUPER FF INSTEAD.',
        'SUPER FF DROPS THE SHORTEST OCCUPIED SUPPORT PATH TO THE CEILING.',
        'ANY BRANCHES LEFT UNSUPPORTED BY THAT CUT FALL TOO.'
      ]],
      ['CUTTING SUPPORT', [
        'ANY CLUSTER NO LONGER CONNECTED TO THE CEILING FALLS FOR DROP POINTS.',
        'FUSIONS AND HOLES IN A NEW INBOUND ROW CAN BOTH CUT A BRANCH LOOSE.'
      ]]
    ]
  },
  {
    title: 'REACHABLE AMMO // ENTROPY // DUDS',
    sections: [
      ['REACHABLE EDGES', [
        'THE CANNON LOADS VALUES BESIDE OPEN SPACE REACHABLE FROM THE LAUNCHER.',
        'A SEALED INTERNAL HOLE IS NOT A FIRING LANE AND DOES NOT COUNT.',
        'RINGED MAGAZINE VALUES ARE LOADABLE; BURIED VALUES ARE NOT.'
      ]],
      ['ENTROPY', [
        'WAVE 1 GUARANTEES REACHABLE AMMO. LATER WAVES RELAX THAT PROMISE.',
        'ENTROPY ADDS STRANGE LAYOUTS, EXTRA BYTE LADDERS AND LONE HIGH VALUES.',
        'WATCH THE ENTROPY METER AS THE BOARD BECOMES LESS PREDICTABLE.'
      ]],
      ['DUDS', [
        'A DUD HAS NO EXACT MATCH ON ANY CURRENTLY REACHABLE EDGE.',
        'IT STILL STICKS. A SECOND DUD OF THE SAME VALUE CAN FORM A NEW PAIR.',
        'THE RED CHAMBER WARNING TELLS YOU BEFORE YOU COMMIT THE SHOT.'
      ]]
    ]
  },
  {
    title: 'INBOUND BUFFER // DROP TIME // WARP',
    sections: [
      ['INBOUND BUFFER', [
        'EVERY LAUNCH USES ONE INBOUND SHOT. AT ZERO, A FRESH ROW IS DUE.',
        'THE ROW ARRIVES AFTER THAT SHOT RESOLVES; LET IT CROSS RED AND THE RUN ENDS.',
        'THE HUD SHOWS THE FULL COUNTDOWN, EVEN WHEN IT EXCEEDS THE NORMAL INTERVAL.'
      ]],
      ['DROP BUYS TIME', [
        'DROP xN ADDS 2N INBOUND SHOTS, UP TO THE 32-SHOT CAP.',
        'A DROP CAN CANCEL A DUE ROW; THE COUNT MAY EXCEED THE NORMAL INTERVAL.'
      ]],
      ['WARP ORB', [
        'FUSIONS CHARGE WARP. WHEN READY, HOLD SHIFT WHILE FIRING.',
        'THE WILDCARD BECOMES THE VALUE IT LANDS AGAINST, THEN RESOLVES NORMALLY.',
        'WARP IS CONSUMED ON USE AND STILL COUNTS AS AN INBOUND SHOT.'
      ]]
    ]
  },
  {
    title: 'SCORING // CONTROLS // ACCESS // SEEDS',
    sections: [
      ['SCORING', [
        'FUSION: NEW BYTE x8 x PAIRS x CASCADE DEPTH.',
        'FF: 4096 x PAIRS x DEPTH. DROP: FALLEN BYTE VALUE x4.',
        'WAVE CLEAR: 5000 x WAVE. HYPER MULTIPLIES ALL OF THESE x4.'
      ]],
      ['CONTROLS', [
        'MOUSE OR LEFT / RIGHT AIM  |  CLICK OR SPACE FIRE  |  SHIFT+FIRE WARP',
        'P OR ESC PAUSE  |  R RESTART  |  M MUSIC  |  S SFX  |  H HELP',
        'TOUCH: DRAG TO AIM, LIFT TO FIRE; KEEP A SECOND TOUCH DOWN FOR WARP.'
      ]],
      ['ACCESSIBILITY', [
        'EACH ORB REPEATS ITS VALUE AS HEX DIGITS, HUE, BRIGHTNESS AND TEXTURE.',
        'THE DIGITS ARE FINAL; TEXTURES AND LUMINANCE REMAIN USEFUL WITHOUT COLOUR.'
      ]],
      ['SHAREABLE SEEDS', [
        'THE SEED IS PRINTED AT LOWER RIGHT. REPLAY WITH #seed-NUMBER OR #seed-WORD.',
        'A SEED REPEATS GAME DECISIONS; STARS, PARTICLES AND GLITCH NOISE MAY DIFFER.'
      ]]
    ]
  }
];

function drawHelp(g) {
  const bx = 120, by = 66, bw = 1040, bh = 620;
  const pageIndex = clamp(G.helpPage | 0, 0, HELP_PAGE_COUNT - 1);
  const page = HELP_PAGES[pageIndex];

  g.save();
  g.fillStyle = 'rgba(0,0,8,.88)';
  g.fillRect(0, 0, VW, VH);
  g.fillStyle = 'rgba(2,0,18,.97)';
  g.fillRect(bx, by, bw, bh);
  panel(g, bx, by, bw, bh, 195, 'FIELD MANUAL');

  neon(g, page.title, VW / 2, by + 62, 22, '#7fffd4',
    { align: 'center', track: 3, glow: 14 });
  g.strokeStyle = 'rgba(120,220,255,.25)';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(bx + 36, by + 84);
  g.lineTo(bx + bw - 36, by + 84);
  g.stroke();

  let y = by + 118;
  for (const [heading, lines] of page.sections) {
    neon(g, heading, bx + 48, y, 14, '#ffe66d', { track: 2, glow: 7 });
    y += 27;
    for (const line of lines) {
      neon(g, line, bx + 48, y, 13, '#d8e6ff', { track: .7, glow: 4 });
      y += 20;
    }
    y += 13;
  }

  const fy = by + bh - 68;
  g.strokeStyle = 'rgba(120,220,255,.25)';
  g.beginPath();
  g.moveTo(bx + 36, fy);
  g.lineTo(bx + bw - 36, fy);
  g.stroke();
  neon(g, `LEFT / RIGHT : CHANGE PAGE     PAGE ${pageIndex + 1} / ${HELP_PAGE_COUNT}`,
    VW / 2, fy + 28, 13, '#89b4ff', { align: 'center', track: 1.5, glow: 6 });
  neon(g, 'H OR ESC : CLOSE', VW / 2, fy + 50, 13, '#fff',
    { align: 'center', track: 2, glow: 9 });
  g.restore();
}

/* --------------------------------------------------------------- overlays */
function drawOverlays(g, t) {
  const state = G.state === 'help' ? G.helpState : G.state;
  if (state === 'title') {
    g.fillStyle = 'rgba(2,0,14,.78)';
    g.fillRect(FRAME.x, FRAME.y, FRAME.w, FRAME.h);

    neon(g, 'EVERY CELL IS AN EVEN BYTE', VW / 2, 132, 19, '#0ff', { align: 'center', track: 3 });
    neon(g, 'TOUCH TWO OF A KIND', VW / 2, 168, 17, '#ff5ce0', { align: 'center', track: 3 });
    neon(g, 'AND THEY DOUBLE', VW / 2, 192, 17, '#ff5ce0', { align: 'center', track: 3 });

    // 01 02 04 08 ... 80, the whole climb in one row
    TIERS.slice(0, 4).forEach((v, i) =>
      drawBubble(g, 470 + i * 80, 250 + Math.sin(t * 3 + i) * 6, v, 0.92));
    neon(g, '...', 772, 258, 18, '#7a8cc9', { align: 'center', track: 3 });
    drawBubble(g, 834, 250 + Math.sin(t * 3 + 4) * 6, 0x80, 0.92);

    neon(g, '80 + 80 OVERFLOWS THE BYTE', VW / 2, 322, 17, '#ffe66d',
      { align: 'center', track: 3 });
    drawBubble(g, VW / 2, 376, FULL, 1.05 + Math.sin(t * 6) * 0.06);
    neon(g, 'FF BURNS OFF THE BOARD', VW / 2, 428, 17, '#ffe66d',
      { align: 'center', track: 3 });

    neon(g, 'CLEAR EVERY CELL TO TAKE THE WAVE', VW / 2, 480, 17, '#5cffb0',
      { align: 'center', track: 2 });
    neon(g, 'THE CANNON ONLY LOADS VALUES SITTING ON AN EDGE -', VW / 2, 512, 12, '#89b4ff',
      { align: 'center', track: 1.5 });
    neon(g, 'UNTIL THE LATER WAVES, WHICH START HANDING YOU DUDS', VW / 2, 530, 12, '#89b4ff',
      { align: 'center', track: 1.5 });

    const held = resumeAvailable();
    g.globalAlpha = 0.55 + 0.45 * Math.sin(t * 5);
    neon(g, !G.coin ? '> PRESS SPACE TO INSERT COIN <'
      : held ? '> PRESS SPACE TO RESUME <' : '> PRESS SPACE TO LAUNCH <',
      VW / 2, 596, 20, '#fff', { align: 'center', track: 3, glow: 24 });
    g.globalAlpha = 1;
    if (held) {
      const heldLine = held.clearPending
        ? `WAVE ${held.level} READY - ${held.score} PTS   (R FOR A NEW RUN)`
        : `RUN IN PROGRESS - WAVE ${held.level}, ${held.score} PTS, ` +
          `${held.cells} CELLS   (R FOR A NEW RUN)`;
      neon(g, heldLine, VW / 2, 616, 11, '#5cffb0',
        { align: 'center', track: 1.5, glow: 6 });
    }
    neon(g, 'HI-SCORE  ' + String(G.best).padStart(8, '0'), VW / 2, 634, 15, '#7fffd4',
      { align: 'center', track: 2 });
    if (STATS.games) {
      neon(g, `${STATS.games} RUNS  ${formatDuration(STATS.totalMs)} PLAYED  ` +
        `BEST WAVE ${STATS.bestWave}  ${STATS.ffBurned} FF BURNED`,
        VW / 2, 658, 11, '#7a8cc9', { align: 'center', track: 1.5, glow: 4 });
    }
    return;
  }

  if (state === 'clear') {
    const k = Math.min(1, G.clearAnim * 2);
    g.fillStyle = `rgba(0,14,10,${.72 * k})`;
    g.fillRect(FRAME.x, FRAME.y, FRAME.w, FRAME.h);

    const s = 0.6 + k * 0.4;
    g.save();
    g.translate(VW / 2, 300);
    g.scale(s, s);
    neon(g, 'BOARD CLEAR', 0, 0, 42, '#5cffb0', { align: 'center', track: 5, glow: 28 });
    g.restore();

    neon(g, 'WAVE ' + G.level + ' COMPLETE', VW / 2, 356, 20, '#fff',
      { align: 'center', track: 3 });
    neon(g, '+' + G.lastBonus, VW / 2, 400, 30, '#ffe66d', { align: 'center', track: 2 });

    // countdown to the next wave
    const bw = 300, bx = VW / 2 - bw / 2;
    g.fillStyle = 'rgba(255,255,255,.12)';
    g.fillRect(bx, 450, bw, 8);
    g.fillStyle = '#5cffb0';
    g.fillRect(bx, 450, bw * Math.min(1, G.clearAnim / 2.6), 8);
    neon(g, 'WAVE ' + (G.level + 1) + ' INCOMING', VW / 2, 490, 15, '#5cffb0',
      { align: 'center', track: 2 });
    return;
  }

  if (state === 'over') {
    g.fillStyle = `rgba(20,0,10,${.75 * G.over})`;
    g.fillRect(FRAME.x, FRAME.y, FRAME.w, FRAME.h);

    const s = 1 + (1 - G.over) * 1.6;
    g.save();
    g.translate(VW / 2, 300);
    g.scale(s, s);
    neon(g, 'GAME OVER', 0, 0, 46, '#ff2d55', { align: 'center', track: 6, glow: 30 });
    g.restore();

    neon(g, 'SCORE ' + G.score, VW / 2, 370, 24, '#ffe66d', { align: 'center', track: 3 });
    neon(g, 'BEST  ' + G.best, VW / 2, 404, 18, '#7fffd4', { align: 'center', track: 3 });
    neon(g, 'WAVE ' + G.level + '   BEST BYTE ' + hexLabel(G.maxTile) +
      '   FF x' + G.bytes, VW / 2, 440, 15, '#89b4ff', { align: 'center', track: 2 });
    // The scoreboard Cloudflare cannot hold: kept in localStorage.
    if (STATS.top.length) {
      neon(g, 'BEST RUNS', VW / 2, 480, 13, '#5cffb0', { align: 'center', track: 2 });
      STATS.top.forEach((run, i) => {
        const mine = run.score === G.score && run.wave === G.level;
        neon(g, `${i + 1}.  ${String(run.score).padStart(8, '0')}   WAVE ${run.wave}` +
          `   FF ${run.ff}`, VW / 2, 502 + i * 19, 13,
          mine ? '#ffe66d' : '#89b4ff', { align: 'center', track: 1.5, glow: mine ? 12 : 5 });
      });
    }
    neon(g, `${STATS.games} RUNS   ${formatDuration(STATS.totalMs)} PLAYED` +
      `   ${STATS.wavesCleared} WAVES CLEARED`, VW / 2, 612, 11, '#7a8cc9',
      { align: 'center', track: 1.5, glow: 4 });
    if (G.over > .7) {
      g.globalAlpha = 0.55 + 0.45 * Math.sin(t * 5);
      neon(g, '> PRESS SPACE TO RETRY <', VW / 2, 645, 17, '#fff',
        { align: 'center', track: 3, glow: 22 });
      g.globalAlpha = 1;
    }
    return;
  }

  if (state === 'pause') {
    g.fillStyle = 'rgba(0,0,20,.7)';
    g.fillRect(FRAME.x, FRAME.y, FRAME.w, FRAME.h);
    neon(g, 'PAUSED', VW / 2, 340, 44, '#0ff', { align: 'center', track: 6, glow: 26 });
    neon(g, 'PRESS P TO RESUME', VW / 2, 396, 16, '#fff', { align: 'center', track: 3 });
  }
}

/* ------------------------------------------------------------ world frame */
let lastRenderT = null;

export function renderWorld(t) {
  // A value of 1 reproduces the original 60 Hz tuning. T advances on the
  // fixed simulation clock, so duplicate 120/144 Hz renders get a scale of 0
  // and slower displays advance by the corresponding number of sim frames.
  const frameScale = lastRenderT === null ? 1 : clamp((t - lastRenderT) * 60, 0, 5);
  lastRenderT = t;
  begin();
  w.setTransform(1, 0, 0, 1, 0, 0);
  w.globalAlpha = 1;
  w.globalCompositeOperation = 'source-over';
  w.fillStyle = '#03000c';
  w.fillRect(0, 0, VW, VH);

  w.globalAlpha = .55;
  w.drawImage(plasmaCanvas(t), 0, 0, VW, VH);
  w.globalAlpha = 1;
  lap('plasma');

  drawStars(w, frameScale);
  lap('stars');
  drawCopper(w, t, 0, 60);
  lap('copper');

  w.save();
  if (FX.shake > 0.2) w.translate(rnd(FX.shake, -FX.shake), rnd(FX.shake, -FX.shake) * .6);
  chromeLogo(w, TITLE, VW / 2, 33, 40, t);
  lap('logo');
  drawPlayfield(w, t, frameScale);
  lap('playfield');
  drawLauncher(w, t);
  lap('launcher');
  drawLeftPanel(w, t, frameScale);
  lap('hud.left');
  drawRightPanel(w, t);
  lap('hud.right');
  drawOverlays(w, t);
  if (G.funFact) drawFunFact(w, t);
  lap('overlays');
  w.restore();

  drawScroller(w, t, SCROLL_Y, frameScale);
  lap('scroller');

  if (FX.flash > 0.01) {
    w.fillStyle = `rgba(255,255,255,${FX.flash * .5})`;
    w.fillRect(0, 0, VW, VH);
  }

  // torn horizontal slices, sampled from the buffer back onto itself
  if (FX.glitch > 0.12) {
    const n = 2 + ((FX.glitch * 5) | 0);
    for (let i = 0; i < n; i++) {
      const gy = rint(VH), gh = 4 + rint(26);
      w.drawImage(wc, 0, gy, VW, gh, rnd(30, -30) * FX.glitch, gy, VW, gh);
    }
  }
  lap('glitch.slices');

  // Draw the manual last so shake, flashes, glitches and the scroller remain
  // behind a stable, readable modal.
  if (G.state === 'help') {
    drawHelp(w);
    lap('help');
  }
}

/* ------------------------------------------------------------- compositor */
// Channel-split buffers, only touched while a glitch is active.
const rcv = document.createElement('canvas'); rcv.width = VW; rcv.height = VH;
const rcx = rcv.getContext('2d');
const bcv = document.createElement('canvas'); bcv.width = VW; bcv.height = VH;
const bcx = bcv.getContext('2d');

function channel(c, col) {
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.clearRect(0, 0, VW, VH);
  c.drawImage(wc, 0, 0);
  c.globalCompositeOperation = 'multiply';
  c.fillStyle = col;
  c.fillRect(0, 0, VW, VH);
  c.globalCompositeOperation = 'source-over';
}

export function present() {
  begin();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cvs.width, cvs.height);

  const { s, ox, oy } = VIEW;
  if (FX.glitch > 0.08) {
    const dx = FX.glitch * 9 * s;
    channel(rcx, '#f00');
    channel(bcx, '#0ff');
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(rcv, ox - dx, oy, VW * s, VH * s);
    ctx.drawImage(bcv, ox + dx, oy, VW * s, VH * s);
    ctx.globalCompositeOperation = 'source-over';
  } else {
    ctx.drawImage(wc, ox, oy, VW * s, VH * s);
  }
  lap('present.blit');

  if (SCREEN.scan) { ctx.fillStyle = SCREEN.scan; ctx.fillRect(0, 0, cvs.width, cvs.height); }
  if (SCREEN.vig) { ctx.fillStyle = SCREEN.vig; ctx.fillRect(0, 0, cvs.width, cvs.height); }

  ctx.strokeStyle = 'rgba(0,200,255,.10)';
  ctx.lineWidth = 2 * VIEW.dpr;
  ctx.strokeRect(ox, oy, VW * s, VH * s);
  lap('present.crt');
}
