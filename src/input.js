import { LAUNCH, KONAMI } from './config.js';
import { cvs, VIEW, resize } from './canvas.js';
import { G, fire, newGame, setAim, nextWave, toggleHyper, resumeGame, resumeAvailable, LOG } from './game.js';
import { Snd } from './audio.js';

export const keys = { left: false, right: false, shift: false };
export const HELP_PAGE_COUNT = 6;
const HELP_STATES = new Set(['title', 'play', 'pause', 'clear', 'over']);

// A touch that advances an interstitial is one complete confirm gesture. Keep
// its matching lift from leaking through into play and launching an orb.
let touchConsumed = false;

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

function openHelp() {
  if (!HELP_STATES.has(G.state)) return;
  G.helpState = G.state;
  G.helpPage = 0;
  G.state = 'help';
  keys.left = keys.right = keys.shift = false;
  konami.length = 0;
  // If help opened while a touch was held, its eventual lift must not fire
  // after the modal closes. A fresh gesture resets this on touchstart.
  touchConsumed = true;
}

function closeHelp() {
  if (G.state !== 'help') return;
  G.state = HELP_STATES.has(G.helpState) ? G.helpState : 'title';
  G.helpState = null;
  keys.left = keys.right = keys.shift = false;
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

  window.addEventListener('mousemove', e => {
    if (G.state !== 'help') aimAt(e.clientX, e.clientY);
  });

  window.addEventListener('mousedown', e => {
    if (e.button !== 0 || G.state === 'help') return;
    Snd.start();
    if (advanceScreen()) return;
    aimAt(e.clientX, e.clientY);
    fire(e.shiftKey && G.warpReady);
  });

  window.addEventListener('contextmenu', e => e.preventDefault());

  window.addEventListener('touchstart', e => {
    e.preventDefault();
    if (e.touches.length === 1) touchConsumed = false;
    if (G.state === 'help') { touchConsumed = true; return; }
    Snd.start();
    const t = e.touches[0];
    if (t) aimAt(t.clientX, t.clientY);
    if (advanceScreen()) touchConsumed = true;
  }, { passive: false });

  window.addEventListener('touchmove', e => {
    e.preventDefault();
    if (G.state === 'help') return;
    const t = e.touches[0];
    if (t) aimAt(t.clientX, t.clientY);
  }, { passive: false });

  window.addEventListener('touchend', e => {
    e.preventDefault();
    if (touchConsumed) {
      if (e.touches.length === 0) touchConsumed = false;
      return;
    }
    if (G.state === 'play') fire(G.warpReady && e.touches.length > 0);
  }, { passive: false });

  window.addEventListener('touchcancel', e => {
    if (e.touches.length === 0) touchConsumed = false;
  });

  window.addEventListener('keydown', e => {
    const k = e.key;

    // Help is a real modal state: its navigation never steers the launcher,
    // feeds the cheat sequence, or falls through to any gameplay shortcut.
    if (G.state === 'help') {
      e.preventDefault();
      if (e.repeat) return;
      if (k === 'h' || k === 'H' || k === 'Escape') closeHelp();
      else if (k === 'ArrowLeft')
        G.helpPage = (G.helpPage + HELP_PAGE_COUNT - 1) % HELP_PAGE_COUNT;
      else if (k === 'ArrowRight')
        G.helpPage = (G.helpPage + 1) % HELP_PAGE_COUNT;
      return;
    }
    if (k === 'h' || k === 'H') {
      e.preventDefault();
      if (!e.repeat) openHelp();
      return;
    }

    if (!e.repeat) trackKonami(k);
    if (k === 'Shift') keys.shift = true;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.left = true;
    if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.right = true;

    // Key repeat is useful for held steering only. Every action below is a
    // discrete press; letting repeats through can launch the title screen and
    // fire without a release, or rapidly oscillate pause/audio toggles.
    if (e.repeat) {
      if (k === ' ' || k === 'Enter') e.preventDefault();
      return;
    }

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
    if (k === 'r' || k === 'R') {
      // The title advertises R as the way to discard a held run. newGame()
      // clears that save; wake audio here because this may be the first input.
      if (G.state === 'title') {
        if (resumeAvailable()) {
          Snd.start();
          G.coin = true;
          newGame();
        }
      } else {
        newGame();
      }
    }
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
    touchConsumed = false;
  });
}
