import { FULL, FULL_HUE, ROOT_BASE, STEP_SHIFT } from './config.js';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rnd = (a = 1, b = 0) => b + Math.random() * (a - b);
export const rint = n => (Math.random() * n) | 0;
export const pick = a => a[(Math.random() * a.length) | 0];

// Strip the trailing zeros and you have the odd number a chain started from:
// 01 for the powers of two, 03 for 06/0C/18, 05 for 0A/14/28, and so on.
// Two bytes can only ever merge if they are identical, so the root tells you
// which orbs are even theoretically compatible.
export function chainRoot(v) {
  let r = v;
  while (r > 1 && (r & 1) === 0) r >>= 1;
  return r;
}

// How many doublings above its root a byte is.
export function chainStep(v) { return Math.round(Math.log2(v / chainRoot(v))); }

// Hue alone is not enough. Red-green colour blindness affects roughly one man
// in twelve, and under it orange / green / vermillion collapse toward the same
// muddy yellow, so a purely hue-coded board turns into porridge. Every cell
// therefore carries three redundant signals:
//
//   hue        which chain it belongs to      (trichromats)
//   luminance  how far up that chain it is    (survives every kind of CVD)
//   texture    which chain it belongs to      (survives total colour loss)
//
// and the hex digits printed on the face remain the final word.
//
// Family hues are adapted from the Okabe-Ito palette, which is designed to
// stay separable under protanopia and deuteranopia.
// The rung carries hue and texture, NOT the chain. The powers of two --
// 02 04 08 10 20 40 80 -- are a single chain and by far the most common thing
// on the board, so coding chains by hue painted almost everything one colour
// and left 02 and 04 nearly identical. What actually decides whether two cells
// merge is the exact value, so the rung gets the loudest channels.
const STEP_HUE = [140, 190, 275, 320, 352, 32, 58, 104];
const STEP_PAT = [0, 0, 1, 2, 3, 4, 5, 6];

// Chains are then separated by a hue rotation, a saturation shift and their own
// luminance band, so 02 and 06 (same rung, different chains) still differ.
export const FAMILIES = [
  { rot: 0, s: 92, lo: 0 },
  { rot: 26, s: 74, lo: -11 },
  { rot: -24, s: 100, lo: 10 },
  { rot: 44, s: 66, lo: -6 },
  { rot: -42, s: 88, lo: 6 },
  { rot: 16, s: 58, lo: -15 },
  { rot: -14, s: 96, lo: 14 }
];

export function familyIndex(v) {
  return (((chainRoot(v) - 1) / 2) | 0) % FAMILIES.length;
}

// Luminance climbs with every doubling, so a ladder still reads dark-to-bright
// with no colour perception at all.
export function cellStyle(v) {
  if (v === FULL) return { h: FULL_HUE, s: 100, l: 68, pat: 7 };
  if (v === -1) return { h: 0, s: 0, l: 74, pat: 0 };
  const f = FAMILIES[familyIndex(v)];
  const step = clamp(chainStep(v), 0, 7);
  return {
    h: (STEP_HUE[step] + f.rot + 360) % 360,
    s: f.s,
    l: clamp(28 + (step / 7) * 56 + f.lo, 16, 88),
    pat: STEP_PAT[step]
  };
}

export function vhue(v) { return cellStyle(v).h; }

// Callers may override lightness/saturation for glows and rings; the hue and
// the family identity still come from cellStyle.
export function vcol(v, l, s, a = 1) {
  const st = cellStyle(v);
  return `hsla(${st.h},${s === undefined ? st.s : s}%,${l === undefined ? st.l : l}%,${a})`;
}

// Orbs are bytes, so they wear their hex value: 01 02 04 08 10 20 40 80 FF.
// The VGA face is code page 437, so the warp orb wears a CP437 glyph (the
// sun, char 15) rather than a star that would fall back to another font.
export function hexLabel(v) {
  if (v === -1) return '\u263C';
  return v.toString(16).toUpperCase().padStart(2, '0');
}
