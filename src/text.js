import { VW, VH } from './config.js';
import { clamp } from './util.js';
import { nextPhrase } from './commentary.js';

/* ------------------------------------------------------------ text sprites */
// shadowBlur is the single most expensive thing this game asks a 2D canvas to
// do, and Firefox rasterises it off the main thread, so it never shows up in a
// performance.now() delta -- it just caps the frame rate. Every glow string is
// therefore rendered once into its own little canvas and blitted from then on.
// The HUD is almost entirely static text, so the hit rate is near total.
const scratch = document.createElement('canvas').getContext('2d');
const textCache = new Map();
const TEXT_CACHE_MAX = 600;

const FAMILY = '"VGA437","Courier New",monospace';
// The bitmap face ships a single weight. Asking for 900 makes engines
// smear a synthetic bold over it, so requested weights are ignored.
const fontStr = size => `${size}px ${FAMILY}`;

function buildTextSprite(txt, size, col, glow, track, weight) {
  scratch.font = fontStr(size);
  const chars = [...txt];
  const adv = chars.map(c => scratch.measureText(c).width);
  let totalW = 0;
  for (const a of adv) totalW += a;
  if (track) totalW += track * (chars.length - 1);

  const m = scratch.measureText(txt);
  const ascent = Math.ceil(m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || size);
  const descent = Math.ceil(m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || size * 0.3);
  const pad = Math.ceil(glow * 1.6) + 4;

  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.ceil(totalW) + pad * 2);
  cv.height = Math.max(1, ascent + descent + pad * 2);

  const g = cv.getContext('2d');
  g.font = fontStr(size);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = col;
  if (glow > 0) { g.shadowColor = col; g.shadowBlur = glow; }

  const base = pad + ascent;
  if (track) {
    let cx = pad;
    for (let i = 0; i < chars.length; i++) { g.fillText(chars[i], cx, base); cx += adv[i] + track; }
  } else {
    g.fillText(txt, pad, base);
  }
  return { cv, pad, base, w: totalW };
}

function textSprite(txt, size, col, glow, track, weight) {
  const key = `${size}|${col}|${glow}|${track}|${weight}|${txt}`;
  const hit = textCache.get(key);
  if (hit) return hit;
  const sp = buildTextSprite(txt, size, col, glow, track, weight);
  // Map iterates in insertion order, so the first key is the oldest.
  if (textCache.size >= TEXT_CACHE_MAX) textCache.delete(textCache.keys().next().value);
  textCache.set(key, sp);
  return sp;
}

// Every cached sprite baked in whatever font was active when it was built, so
// they all have to go once the webfont finishes loading.
export function clearTextCaches() {
  textCache.clear();
  glyphCache.clear();
}

// Glow text. Honours the caller's globalAlpha, since drawImage does.
export function neon(g, txt, x, y, size, col, opt = {}) {
  if (txt === '' || txt == null) return;
  const glow = opt.glow === undefined ? 14 : opt.glow;
  const sp = textSprite(String(txt), size, col, glow, opt.track || 0, opt.weight || 900);
  const anchor = opt.align === 'center' ? sp.w / 2 : opt.align === 'right' ? sp.w : 0;
  g.drawImage(sp.cv, Math.round(x - sp.pad - anchor), Math.round(y - sp.base));
}

/* ------------------------------------------------------------------- logo */
// The logo animates every frame (per-letter bob and a shifting gradient) so it
// cannot be a static sprite, but it is only 13 glyphs.
export function chromeLogo(g, txt, cx, y, size, t) {
  const chars = [...txt];
  g.save();
  g.font = `${size}px ${FAMILY}`;
  g.textBaseline = 'middle';
  g.textAlign = 'center';

  const tr = size * 0.10;
  let total = 0;
  for (const c of chars) total += g.measureText(c).width + tr;
  total -= tr;

  let x = cx - total / 2;
  chars.forEach((c, i) => {
    const cw = g.measureText(c).width;
    const yy = y + Math.sin(t * 2.6 + i * 0.42) * 6;
    const px = x + cw / 2;
    const sh = Math.sin(t * 1.6 + i * .3) * .12;

    const grd = g.createLinearGradient(0, yy - size * .55, 0, yy + size * .55);
    grd.addColorStop(0.00, '#ffffff');
    grd.addColorStop(clamp(0.30 + sh, 0.05, .60), '#7ff2ff');
    grd.addColorStop(clamp(0.48 + sh, 0.10, .70), '#0d3f8f');
    grd.addColorStop(clamp(0.52 + sh, 0.15, .75), '#ff2fd0');
    grd.addColorStop(0.78, '#ffd23f');
    grd.addColorStop(1.00, '#ff6a00');

    g.lineWidth = size * 0.14;
    g.strokeStyle = 'rgba(6,0,30,.95)';
    g.strokeText(c, px, yy);
    g.fillStyle = grd;
    g.fillText(c, px, yy);
    g.lineWidth = 1.1;
    g.strokeStyle = 'rgba(255,255,255,.65)';
    g.strokeText(c, px, yy);

    x += cw + tr;
  });
  g.restore();
}

/* --------------------------------------------------------------- scroller */
// Per-character glyph sprites, keyed by character and a quantised hue. The
// colour cycles continuously along the scroller, so quantising to 32 buckets
// keeps it looking smooth while bounding the cache at a few hundred sprites.
const CHAR_W = 17, SCROLL_SPEED = 3.1, HUE_STEPS = 32;

// The scroller only owns the sliver below the playfield frame. WAVE has to be
// small enough that a glyph at the crest still fits inside it, and the wave is
// enveloped so characters enter and leave the screen flat: the undulation is a
// function of screen x, so without the taper a character rides up as it exits
// and the message appears to tail off the top.
const BAND = 24;          // half-height of the strip the text may occupy
const WAVE = 7;           // peak vertical travel, before the envelope
const RIPPLE = 2.5;
const glyphCache = new Map();

// The text is generated on the fly, so the scroller keeps a rolling buffer:
// consumed characters fall off the front, fresh commentary is appended to the
// back whenever the buffer gets short enough to run dry on screen.
let buf = '';
let scrollX = VW;
const SCREEN_CHARS = Math.ceil(VW / CHAR_W) + 4;

function glyph(ch, hueBucket) {
  const key = ch + '|' + hueBucket;
  const hit = glyphCache.get(key);
  if (hit) return hit;
  const hue = hueBucket * (360 / HUE_STEPS);
  const size = 26, pad = 22;
  const cv = document.createElement('canvas');
  cv.width = CHAR_W + pad * 2;
  cv.height = size + pad * 2;
  const g = cv.getContext('2d');
  g.font = `${size}px ${FAMILY}`;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.shadowColor = `hsl(${hue},100%,60%)`;
  g.shadowBlur = 12;
  g.fillStyle = 'rgba(0,0,0,.9)';
  g.fillText(ch, pad + 2, pad + size / 2 + 2);
  g.fillStyle = `hsl(${hue},100%,78%)`;
  g.fillText(ch, pad, pad + size / 2);
  const sp = { cv, pad, mid: pad + size / 2 };
  glyphCache.set(key, sp);
  return sp;
}

export function drawScroller(g, t, y) {
  // Retire characters that have scrolled off the left, then top the buffer up.
  while (scrollX <= -CHAR_W && buf.length) { buf = buf.slice(1); scrollX += CHAR_W; }
  let guard = 0;
  while (buf.length < SCREEN_CHARS + Math.ceil(-Math.min(scrollX, 0) / CHAR_W) && guard++ < 40) {
    buf += nextPhrase();
  }

  g.save();
  // Clip to the strip that actually exists: from the top of the band down to
  // the bottom of the frame, never past it.
  g.beginPath();
  g.rect(0, y - BAND, VW, Math.max(0, VH - (y - BAND)));
  g.clip();

  let x = scrollX;
  for (let i = 0; i < buf.length; i++) {
    if (x > VW + 30) break;
    if (x > -30) {
      const ch = buf[i];
      if (ch !== ' ') {
        // 0 at both screen edges, 1 across the middle
        const env = Math.sin(Math.PI * clamp(x / VW, 0, 1));
        const yy = y + (Math.sin(x * 0.011 + t * 2.2) * WAVE +
          Math.sin(x * 0.031 - t) * RIPPLE) * env;
        let hb = Math.floor(((x * 0.6 - t * 90) % 360 + 360) % 360 / (360 / HUE_STEPS));
        if (hb >= HUE_STEPS) hb = 0;
        const sp = glyph(ch, hb);
        g.drawImage(sp.cv, Math.round(x - sp.pad), Math.round(yy - sp.mid));
      }
    }
    x += CHAR_W;
  }

  scrollX -= SCROLL_SPEED;
  g.restore();
}
