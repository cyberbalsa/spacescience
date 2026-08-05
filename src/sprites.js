import { R, TAU, FULL } from './config.js';
import { cellStyle, hexLabel } from './util.js';

// Cells are pre-rendered once per value into a sprite canvas. Value -1 is the
// rainbow "warp" cell; FULL (FF) is the overflow byte.
const sprCache = new Map();

// Pointy-top hexagons, matching the lattice: neighbours sit at 0/60/120/... so
// the flats face them and the vertices land at 30/90/150/...
//
// Cell centres are 2R apart, so a hexagon whose flat-to-flat width is 2R would
// tessellate exactly. HEX_R is nudged just under that, leaving a couple of
// pixels of grout so individual cells stay readable in a dense board.
export const HEX_R = R * 1.08;

export function hexPath(g, cx, cy, rad) {
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = i * TAU / 6 - Math.PI / 6;
    const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
    if (i) g.lineTo(px, py); else g.moveTo(px, py);
  }
  g.closePath();
}

// The texture channel. Each chain family gets its own weave, so cells stay
// distinguishable with no colour perception whatsoever -- and it reads as
// honest CRT dithering rather than an accessibility bolt-on.
function weave(g, cx, cy, rad, pat, light) {
  if (pat === 0) return;
  g.save();
  hexPath(g, cx, cy, rad - 2);
  g.clip();
  const ink = light < 55 ? 'rgba(255,255,255,.46)' : 'rgba(0,0,0,.48)';
  g.strokeStyle = ink;
  g.fillStyle = ink;
  g.lineWidth = 2.8;
  const lo = -rad, hi = rad;
  g.beginPath();
  switch (pat) {
    case 1:                                            // horizontal rules
      for (let y = lo; y <= hi; y += 8) { g.moveTo(cx + lo, cy + y); g.lineTo(cx + hi, cy + y); }
      break;
    case 2:                                            // diagonals
      for (let d = lo * 2; d <= hi * 2; d += 9) {
        g.moveTo(cx + d, cy + lo); g.lineTo(cx + d + rad * 2, cy + hi);
      }
      break;
    case 3:                                            // dots
      for (let y = lo; y <= hi; y += 8)
        for (let x = lo; x <= hi; x += 8)
          g.rect(cx + x - 2, cy + y - 2, 4, 4);
      g.fill();
      g.restore();
      return;
    case 4:                                            // cross-hatch
      for (let d = lo * 2; d <= hi * 2; d += 8) {
        g.moveTo(cx + d, cy + lo); g.lineTo(cx + d + rad * 2, cy + hi);
        g.moveTo(cx + d, cy + hi); g.lineTo(cx + d + rad * 2, cy + lo);
      }
      break;
    case 5:                                            // verticals
      for (let x = lo; x <= hi; x += 8) { g.moveTo(cx + x, cy + lo); g.lineTo(cx + x, cy + hi); }
      break;
    case 6:                                            // chevrons
      for (let y = lo; y <= hi; y += 8) {
        g.moveTo(cx + lo, cy + y + 5); g.lineTo(cx, cy + y); g.lineTo(cx + hi, cy + y + 5);
      }
      break;
    case 7:                                            // FF: concentric rings
      for (let k = 0.3; k < 1; k += 0.22) hexPath(g, cx, cy, rad * k);
      break;
  }
  g.stroke();
  g.restore();
}

export function bubbleSprite(v) {
  const hit = sprCache.get(v);
  if (hit) return hit;

  const P = 12, S = (R + P) * 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const cx = S / 2, cy = S / 2;
  const wild = v === -1;
  const st = cellStyle(v);
  const hue = st.h;
  const rad = HEX_R;

  // outer bloom
  const bg = g.createRadialGradient(cx, cy, R * 0.6, cx, cy, R + P);
  bg.addColorStop(0, wild ? 'rgba(255,255,255,.7)' : `hsla(${hue},${st.s}%,${Math.min(72, st.l + 14)}%,.72)`);
  bg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = bg;
  g.fillRect(0, 0, S, S);

  g.save();
  hexPath(g, cx, cy, rad - 1);
  g.clip();

  if (wild) {
    for (let i = 0; i < 12; i++) {
      g.fillStyle = `hsl(${i * 30},100%,58%)`;
      g.beginPath();
      g.moveTo(cx, cy);
      g.arc(cx, cy, rad, i * TAU / 12, (i + 1) * TAU / 12);
      g.fill();
    }
    const sh = g.createRadialGradient(cx - rad * .35, cy - rad * .4, 1, cx, cy, rad);
    sh.addColorStop(0, 'rgba(255,255,255,.85)');
    sh.addColorStop(1, 'rgba(0,0,0,.45)');
    g.fillStyle = sh;
    g.fillRect(0, 0, S, S);
  } else {
    const L = st.l;
    const bd = g.createRadialGradient(cx - rad * .38, cy - rad * .45, rad * .12, cx, cy, rad * 1.15);
    bd.addColorStop(0.00, `hsl(${hue},${st.s}%,${Math.min(98, L + 34)}%)`);
    bd.addColorStop(0.30, `hsl(${hue},${st.s}%,${Math.min(92, L + 17)}%)`);
    bd.addColorStop(0.72, `hsl(${hue},${st.s}%,${L}%)`);
    bd.addColorStop(1.00, `hsl(${hue},${st.s}%,${Math.max(12, L - 18)}%)`);
    g.fillStyle = bd;
    g.fillRect(0, 0, S, S);

    weave(g, cx, cy, rad, st.pat, L);

    g.globalAlpha = .08;
    g.fillStyle = '#000';
    for (let y = 0; y < S; y += 3) g.fillRect(0, y, S, 1);
    g.globalAlpha = 1;

    // bevel: a bright top-left edge and a dark bottom-right one, so the cell
    // reads as a chamfered tile rather than a flat sticker
    g.lineWidth = 3;
    g.strokeStyle = `hsla(${hue},100%,${Math.min(97, st.l + 40)}%,.6)`;
    g.beginPath();
    g.moveTo(cx - rad * .87, cy + rad * .5);
    g.lineTo(cx - rad * .87, cy - rad * .5);
    g.lineTo(cx, cy - rad);
    g.lineTo(cx + rad * .87, cy - rad * .5);
    g.stroke();
    g.strokeStyle = 'rgba(0,0,0,.35)';
    g.beginPath();
    g.moveTo(cx + rad * .87, cy - rad * .5);
    g.lineTo(cx + rad * .87, cy + rad * .5);
    g.lineTo(cx, cy + rad);
    g.lineTo(cx - rad * .87, cy + rad * .5);
    g.stroke();

    // inner facet ring
    g.strokeStyle = `hsla(${hue},100%,${Math.min(95, st.l + 30)}%,.3)`;
    g.lineWidth = 1;
    hexPath(g, cx, cy, rad * .68);
    g.stroke();
  }
  g.restore();

  g.strokeStyle = wild ? '#fff' : `hsl(${hue},100%,${Math.min(90, st.l + 30)}%)`;
  g.lineWidth = 2;
  hexPath(g, cx, cy, rad - 1);
  g.stroke();
  g.strokeStyle = 'rgba(0,0,0,.35)';
  g.lineWidth = 1;
  hexPath(g, cx, cy, rad - 2.5);
  g.stroke();

  g.fillStyle = 'rgba(255,255,255,.6)';
  g.beginPath();
  g.ellipse(cx - rad * .28, cy - rad * .42, rad * .24, rad * .12, -0.5, 0, TAU);
  g.fill();

  // FF wears its eight set bits as a ring of ticks.
  if (v === FULL) {
    weave(g, cx, cy, rad, 7, st.l);
    g.strokeStyle = 'rgba(255,255,255,.9)';
    g.lineWidth = 2;
    for (let i = 0; i < 8; i++) {
      const a = i * TAU / 8 - Math.PI / 2;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (rad - 7), cy + Math.sin(a) * (rad - 7));
      g.lineTo(cx + Math.cos(a) * (rad - 3), cy + Math.sin(a) * (rad - 3));
      g.stroke();
    }
  }

  const label = hexLabel(v);
  const fs = label.length === 1 ? 22 : 20;
  g.font = `${fs}px "VGA437","Courier New",monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 3.5;
  g.strokeStyle = 'rgba(0,0,0,.85)';
  g.strokeText(label, cx, cy + 1);
  g.fillStyle = '#fff';
  g.fillText(label, cx, cy + 1);

  sprCache.set(v, cv);
  return cv;
}

export function clearSprites() { sprCache.clear(); }

export function drawBubble(g, x, y, v, sc = 1, alpha = 1) {
  const sp = bubbleSprite(v), s = sp.width * sc;
  g.globalAlpha = alpha;
  g.drawImage(sp, x - s / 2, y - s / 2, s, s);
  g.globalAlpha = 1;
}
