import { VW, VH } from './config.js';

// Everything is drawn into an offscreen 1280x720 buffer, then blitted to the
// visible canvas. That buffer is also what the RGB-split glitch samples from.
export const cvs = document.getElementById('c');
export const ctx = cvs.getContext('2d');

export const wc = document.createElement('canvas');
wc.width = VW; wc.height = VH;
export const w = wc.getContext('2d');

// Mutated in place so importers keep a live view.
export const VIEW = { s: 1, ox: 0, oy: 0, dpr: 1 };
export const SCREEN = { scan: null, vig: null };

export function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const iw = window.innerWidth, ih = window.innerHeight;
  cvs.width = Math.max(1, Math.floor(iw * dpr));
  cvs.height = Math.max(1, Math.floor(ih * dpr));
  cvs.style.width = iw + 'px';
  cvs.style.height = ih + 'px';

  const s = Math.min(cvs.width / VW, cvs.height / VH);
  VIEW.s = s;
  VIEW.ox = (cvs.width - VW * s) / 2;
  VIEW.oy = (cvs.height - VH * s) / 2;
  VIEW.dpr = dpr;

  const sp = document.createElement('canvas');
  sp.width = 4; sp.height = 4;
  const sc = sp.getContext('2d');
  sc.fillStyle = 'rgba(0,0,0,0.30)'; sc.fillRect(0, 2, 4, 2);
  sc.fillStyle = 'rgba(0,0,0,0.12)'; sc.fillRect(0, 1, 4, 1);
  SCREEN.scan = ctx.createPattern(sp, 'repeat');

  const g = ctx.createRadialGradient(
    cvs.width / 2, cvs.height / 2, Math.min(cvs.width, cvs.height) * 0.28,
    cvs.width / 2, cvs.height / 2, Math.max(cvs.width, cvs.height) * 0.72);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.65, 'rgba(0,0,0,0.35)');
  g.addColorStop(1, 'rgba(0,0,0,0.92)');
  SCREEN.vig = g;
}
