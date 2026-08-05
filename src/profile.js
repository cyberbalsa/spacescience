// Section timer. Off by default and costs one branch per call when off.
//   #profile  live FPS + section breakdown drawn over the game
//   #bench    render N frames, halt, and paint a report that stays on screen
//             (so a headless screenshot can read it)

export const PROF = {
  on: false,
  bench: false,
  halted: false,
  frames: 0,
  seen: 0,
  target: 180,
  order: [],
  acc: {},
  frameMs: 0,
  worst: 0,
  report: null
};

const WARMUP = 12;
let mark = 0;

export function profInit() {
  const h = location.hash;
  PROF.bench = h.includes('bench');
  PROF.on = PROF.bench || h.includes('profile');
}

export function begin() { if (PROF.on) mark = performance.now(); }

export function lap(name) {
  if (!PROF.on) return;
  const now = performance.now();
  if (!(name in PROF.acc)) { PROF.acc[name] = 0; PROF.order.push(name); }
  PROF.acc[name] += now - mark;
  mark = now;
}

export function frameDone(ms) {
  if (!PROF.on) return;
  // The first frames pay for font loading, surface allocation and JIT warmup.
  // Averaging them in makes every section look an order of magnitude worse
  // than it steady-states at, so throw them away.
  if (++PROF.seen <= WARMUP) {
    PROF.acc = {};
    PROF.order = [];
    return;
  }
  PROF.frames++;
  PROF.frameMs += ms;
  if (ms > PROF.worst) PROF.worst = ms;
  if (PROF.bench && PROF.frames >= PROF.target) {
    PROF.halted = true;
    PROF.report = summary();
  }
}

export function summary() {
  const n = Math.max(1, PROF.frames);
  const rows = PROF.order
    .map(k => [k, PROF.acc[k] / n])
    .sort((a, b) => b[1] - a[1]);
  return {
    frames: PROF.frames,
    avg: PROF.frameMs / n,
    worst: PROF.worst,
    fps: 1000 / (PROF.frameMs / n),
    rows
  };
}

// Deliberately plain text: no glow, no gradients, nothing that could itself be
// the thing being measured.
export function drawReport(ctx, cw, ch) {
  const r = PROF.report || summary();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  const s = Math.max(1, Math.min(cw / 900, ch / 700));
  ctx.font = `${16 * s}px monospace`;
  ctx.fillStyle = '#0f0';
  let y = 24 * s;
  const put = (t, col) => {
    ctx.fillStyle = col || '#0f0';
    ctx.fillText(t, 24 * s, y);
    y += 21 * s;
  };

  put(`SPACE SCIENCE  render benchmark`, '#fff');
  put(`frames ${r.frames} (+${WARMUP} warmup dropped)   avg ${r.avg.toFixed(2)} ms   ` +
      `worst ${r.worst.toFixed(1)} ms   ${r.fps.toFixed(1)} fps`, '#ff0');
  put(`canvas ${cw}x${ch}  dpr ${(window.devicePixelRatio || 1).toFixed(2)}`, '#0ff');
  y += 10 * s;
  put('section                    ms/frame     %', '#fff');
  for (const [name, ms] of r.rows) {
    const pct = (ms / r.avg) * 100;
    const bar = '#'.repeat(Math.round(pct / 2.5));
    put(`${name.padEnd(24)} ${ms.toFixed(2).padStart(8)}  ${pct.toFixed(1).padStart(5)}  ${bar}`);
  }
}

// Compact live overlay for #profile.
export function drawLive(ctx, cw) {
  const r = summary();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = '14px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const lines = [`${r.fps.toFixed(1)} fps  ${r.avg.toFixed(2)} ms`]
    .concat(r.rows.slice(0, 10).map(([k, ms]) => `${k.padEnd(14)}${ms.toFixed(2)}`));
  ctx.fillStyle = 'rgba(0,0,0,.75)';
  ctx.fillRect(4, 4, 240, lines.length * 17 + 10);
  ctx.fillStyle = '#0f0';
  lines.forEach((l, i) => ctx.fillText(l, 12, 10 + i * 17));
}
