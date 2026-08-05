import { R, TAU, FULL } from './config.js';
import { clamp, rnd, rint, vhue } from './util.js';
import { drawBubble } from './sprites.js';

export const parts = [], rings = [], pops = [], blasts = [];

// Screen-wide effect levels, kept on an object so other modules can bump them.
export const FX = { shake: 0, glitch: 0, flash: 0 };

export function bump(key, v) { if (v > FX[key]) FX[key] = v; }

export function burst(x, y, v, n = 18) {
  const hue = v === -1 ? rint(360) : vhue(v);
  for (let i = 0; i < n; i++) {
    const a = rnd(TAU), sp = rnd(7.5, 1.2);
    parts.push({
      x, y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1,
      life: 1, decay: rnd(0.035, 0.014), size: rnd(4.5, 1.4),
      col: `hsl(${hue + rnd(40, -40)},100%,${rnd(85, 55)}%)`
    });
  }
  rings.push({ x, y, r: R * .5, max: R * rnd(4.5, 2.6), life: 1, hue });
}

export function sparks(x, y, col, n = 4) {
  for (let i = 0; i < n; i++)
    parts.push({
      x, y, vx: rnd(2, -2), vy: rnd(2, -2),
      life: 1, decay: .06, size: 2.5, col
    });
}

// `hold` multiplies how long the text stays up. A bare score number is glanceable
// and can leave quickly, but anything that explains what just happened -- FF,
// DROP, which values fused -- needs long enough to actually read. Longer holds
// also drift more slowly, otherwise they simply sail off the top instead.
export function popText(x, y, txt, col, hold = 1) {
  pops.push({
    x, y, txt, col, life: 1,
    vy: -1.2 / hold,
    decay: 0.018 / hold,
    hold
  });
}

// The FF orb never rests on the board, so this is the only time you see one:
// it blooms out of the fusion and burns off.
export function blast(x, y) {
  blasts.push({ x, y, life: 1 });
  burst(x, y, FULL, 42);
  for (let i = 0; i < 3; i++) rings.push({ x, y, r: R, max: R * (6 + i * 3), life: 1, hue: 45 });
}

export function clearFX() {
  parts.length = 0; rings.length = 0; pops.length = 0; blasts.length = 0;
}

export function stepFX() {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.x += p.vx; p.y += p.vy; p.vy += 0.16; p.vx *= 0.985;
    p.life -= p.decay;
    if (p.life <= 0) parts.splice(i, 1);
  }
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.r += (r.max - r.r) * 0.18;
    r.life -= 0.045;
    if (r.life <= 0) rings.splice(i, 1);
  }
  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i];
    p.y += p.vy; p.vy *= 0.98; p.life -= p.decay;
    if (p.life <= 0) pops.splice(i, 1);
  }
  for (let i = blasts.length - 1; i >= 0; i--) {
    blasts[i].life -= 0.035;
    if (blasts[i].life <= 0) blasts.splice(i, 1);
  }
  FX.shake *= 0.88; if (FX.shake < 0.15) FX.shake = 0;
  FX.glitch *= 0.86; if (FX.glitch < 0.01) FX.glitch = 0;
  FX.flash *= 0.90; if (FX.flash < 0.01) FX.flash = 0;
}

export function drawFX(g) {
  for (const b of blasts) {
    const k = 1 - b.life;
    drawBubble(g, b.x, b.y, FULL, 1 + k * 2.6, b.life);
  }
  g.globalCompositeOperation = 'lighter';
  for (const r of rings) {
    g.strokeStyle = `hsla(${r.hue},100%,70%,${r.life * .8})`;
    g.lineWidth = 3 * r.life + 0.5;
    g.beginPath(); g.arc(r.x, r.y, r.r, 0, TAU); g.stroke();
  }
  for (const p of parts) {
    g.globalAlpha = p.life;
    g.fillStyle = p.col;
    g.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size * .7);
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';

  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '22px "VGA437","Courier New",monospace';
  for (const p of pops) {
    g.globalAlpha = clamp(p.life * 4, 0, 1);   // solid, then a short fade out
    g.lineWidth = 4; g.strokeStyle = 'rgba(0,0,0,.8)';
    g.strokeText(p.txt, p.x, p.y);
    g.fillStyle = p.col;
    g.fillText(p.txt, p.x, p.y);
  }
  g.globalAlpha = 1;
}
