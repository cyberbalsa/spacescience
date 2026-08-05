import { LAUNCH, KONAMI } from './config.js';
import { cvs, VIEW, resize } from './canvas.js';
import { G, fire, newGame, setAim, nextWave, toggleHyper, resumeGame, resumeAvailable, LOG } from './game.js';
import { Snd } from './audio.js';

export const keys = { left: false, right: false, shift: false };

// Up up down down left right left right. The arrows still steer the cannon
// while you type it, which is half the fun.
const konami = [];
function trackKonami(k) {
  if (!k.startsWith('Arrow')) return;
  konami.push(k);
  if (konami.length > KONAMI.length) konami.shift();
  if (konami.length === KONAMI.length && konami.every((v, i) => v === KONAMI[i])) {
    konami.length = 0;
    toggleHyper();
  }
}

function toVirtual(clientX, clientY) {
  const rect = cvs.getBoundingClientRect();
  const px = (clientX - rect.left) * (cvs.width / rect.width);
  const py = (clientY - rect.top) * (cvs.height / rect.height);
  return [(px - VIEW.ox) / VIEW.s, (py - VIEW.oy) / VIEW.s];
}

function aimAt(clientX, clientY) {
  const [x, y] = toVirtual(clientX, clientY);
  setAim(Math.atan2(y - LAUNCH.y, x - LAUNCH.x));
}

// Title / game-over / pause all advance on the same "any confirm" press.
// Returns true when the press was consumed by a screen transition.
function advanceScreen() {
  if (G.state === 'title') {
    // Browsers only let audio start on a real gesture, and that same gesture
    // would otherwise launch the run and cut the intro track off instantly.
    // So the title takes a coin first, the way the machines it apes did.
    if (!G.coin) { G.coin = true; Snd.start(); Snd.music('menu'); return true; }
    // A run in progress picks up where it left off; only an explicit restart
    // throws it away.
    if (!resumeAvailable() || !resumeGame()) newGame();
    return true;
  }
  if (G.state === 'over') { if (G.over > 0.7) newGame(); return true; }
  if (G.state === 'pause') { G.state = 'play'; return true; }
  // Skip the rest of the wave-clear fanfare.
  if (G.state === 'clear') { if (G.clearAnim > 0.6) nextWave(); return true; }
  return false;
}

export function initInput() {
  window.addEventListener('resize', resize);

  window.addEventListener('mousemove', e => aimAt(e.clientX, e.clientY));

  window.addEventListener('mousedown', e => {
    Snd.start();
    if (advanceScreen()) return;
    aimAt(e.clientX, e.clientY);
    fire(e.shiftKey && G.warpReady);
  });

  window.addEventListener('touchstart', e => {
    e.preventDefault();
    Snd.start();
    const t = e.touches[0];
    if (t) aimAt(t.clientX, t.clientY);
    advanceScreen();
  }, { passive: false });

  window.addEventListener('touchmove', e => {
    e.preventDefault();
    const t = e.touches[0];
    if (t) aimAt(t.clientX, t.clientY);
  }, { passive: false });

  window.addEventListener('touchend', e => {
    e.preventDefault();
    if (G.state === 'play') fire(G.warpReady && e.touches.length > 0);
  }, { passive: false });

  window.addEventListener('keydown', e => {
    const k = e.key;
    trackKonami(k);
    if (k === 'Shift') keys.shift = true;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.left = true;
    if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.right = true;

    if (k === ' ' || k === 'Enter') {
      e.preventDefault();
      Snd.start();
      if (!advanceScreen()) fire(keys.shift && G.warpReady);
      return;
    }
    if (k === 'p' || k === 'P' || k === 'Escape') {
      if (G.state === 'play') G.state = 'pause';
      else if (G.state === 'pause') G.state = 'play';
    }
    if ((k === 'r' || k === 'R') && G.state !== 'title') newGame();
    if (k === 'm' || k === 'M') { Snd.start(); Snd.toggleMusic(); }
    if (k === 's' || k === 'S') Snd.S.sfx = !Snd.S.sfx;
    if (k === 'f' || k === 'F') G.funFact = !G.funFact;   // easter egg
    if (k === 'l' || k === 'L') {
      LOG.chains = !LOG.chains;
      console.log('[SS] chain logging ' + (LOG.chains ? 'ON' : 'off'));
    }
  });

  window.addEventListener('keyup', e => {
    const k = e.key;
    if (k === 'Shift') keys.shift = false;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.left = false;
    if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.right = false;
  });

  // Losing focus mid-hold would otherwise leave the cannon spinning.
  window.addEventListener('blur', () => {
    keys.left = keys.right = keys.shift = false;
  });
}
