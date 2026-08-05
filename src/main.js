/*
 * SPACE SCIENCE - a hexadecimal bubble-fusion cracktro
 * Copyright (C) 2026 Balsa
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 2 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details. You should have received a copy of the GNU General Public
 * License along with this program; if not, see <https://www.gnu.org/licenses/>.
 *
 * The soundtrack is from Frozen Bubble (GPL-2.0). The bundled font is
 * CC BY-SA 4.0 and keeps its own licence; see README.md.
 */
import { resize, ctx, cvs } from './canvas.js';
import { G, moveBall, nudgeAim, seedAttract, nextWave, newGame, resumeGame, resumeAvailable, LOG } from './game.js';
import { stepFX } from './fx.js';
import { renderWorld, present } from './render.js';
import { initInput, keys } from './input.js';
import { Snd } from './audio.js';
import { clearTextCaches } from './text.js';
import { clearSprites } from './sprites.js';
import { RNG, initSeed, setSeed } from './rng.js';
import { track, trackPlaytime, ANALYTICS } from './analytics.js';
import { STATS, addPlaytime, flushStats } from './stats.js';
import { PROF, profInit, begin, lap, frameDone, drawReport, drawLive, summary } from './profile.js';

const STEP = 1 / 60;
let T = 0, last = 0, acc = 0;

export function step() {
  T += STEP;
  G.tick++;
  if (G.state === 'play') {
    if (G.ball) moveBall();
    if (G.pushAnim > 0) G.pushAnim = Math.max(0, G.pushAnim - 0.06);
    if (keys.left) nudgeAim(-0.028);
    if (keys.right) nudgeAim(0.028);
  } else if (G.state === 'clear') {
    G.clearAnim += STEP;
    if (G.clearAnim >= 2.6) nextWave();
  } else if (G.state === 'over') {
    // Drives both the fade-in and the gate on the retry prompt, so it belongs
    // here rather than in the render pass.
    G.over = Math.min(1, G.over + 0.03);
  }
  // Playtime counts time actually spent playing, not idling on the menu.
  if (G.state === 'play') {
    addPlaytime(STEP * 1000);
    trackPlaytime(STATS.totalMs);
  }
  stepFX();
}

// Bench mode drives itself with setTimeout: headless browsers throttle rAF
// almost to a standstill, which measures the vsync policy instead of the code.
function schedule() {
  if (PROF.bench) setTimeout(() => loop(performance.now()), 0);
  else requestAnimationFrame(loop);
}

function loop(now) {
  if (PROF.halted) return;
  schedule();
  const frameStart = PROF.on ? performance.now() : 0;
  begin();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;         // tab was backgrounded; don't fast-forward
  // Fixed timestep, capped so a slow frame can't spiral. The accumulator is
  // clamped too: without it, a run of long frames leaves acc permanently
  // saturated and the sim never drops back to real time.
  acc = Math.min(acc + dt, STEP * 5);
  while (acc >= STEP) { acc -= STEP; step(); }
  lap('sim');
  renderWorld(T);
  present();
  if (PROF.on) {
    frameDone(performance.now() - frameStart);
    if (PROF.bench) drawReport(ctx, cvs.width, cvs.height);
    else drawLive(ctx, cvs.width);
  }
}

export function boot() {
  profInit();
  initSeed();
  resize();
  seedAttract();
  initInput();
  // Opt-in inspection hook. Exposing step() lets the smoke test advance the
  // simulation far faster than a headless browser will produce frames.
  if (/debug|bench|profile/.test(location.hash)) {
    window.SPACESCIENCE = { G, nextWave, step, PROF, summary, Snd, LOG,
      setSeed, newGame, resumeGame, resumeAvailable, STATS, ANALYTICS };
    LOG.chains = location.hash.includes('debug');
  }
  const el = document.getElementById('boot');
  if (el) el.remove();
  track('/load');
  // Persist career stats on the way out; pagehide fires where unload does not.
  window.addEventListener('pagehide', flushStats);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushStats();
  });
  // Second hiding place for the same fun fact, for anyone who opens devtools.
  console.log('%c SPACE SCIENCE ', 'background:#0ff;color:#000;font-weight:bold',
    '\n♪ the soundtrack is lifted from Frozen Bubble (GPL-2.0, 2002).' +
    '\n  press F in-game for the whole story.' +
    '\n  press L to trace every fusion chain to this console.' +
    `\n  board seed ${RNG.seed} - replay it with #seed-${RNG.seed}`);
  // Sprites built before the webfont arrives would cache the fallback face
  // forever, so drop every cache once it is really available.
  if (document.fonts && document.fonts.load) {
    const refresh = () => { clearTextCaches(); clearSprites(); };
    document.fonts.load('16px "VGA437"').then(refresh).catch(refresh);
    if (document.fonts.ready) document.fonts.ready.then(refresh).catch(() => {});
  }

  last = performance.now();
  schedule();
}

boot();
