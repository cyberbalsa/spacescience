// Seeded RNG for everything that decides what the *game* looks like: board
// layouts, seed values, ammo, incoming rows.
//
// Visual noise (particles, starfield, glitch slices) deliberately stays on
// Math.random(). If effects drew from this stream, the number of draws would
// depend on how many sparks happened to be alive, and the same seed would stop
// reproducing the same boards.
//
//   index.html#seed-1238123    replay an exact run
//   index.html#seed-anything   any word works; it gets hashed

export const RNG = { seed: 0 };

let state = 1;

export function setSeed(n) {
  RNG.seed = n >>> 0;
  state = RNG.seed || 1;
}

// Turn an arbitrary label into a usable 32-bit seed (FNV-1a).
export function hashSeed(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32: small, fast, and good enough that boards do not visibly pattern.
export function random() {
  state = (state + 0x6D2B79F5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// The stream position, so a resumed game keeps rolling the same sequence
// instead of silently re-rolling the wave from the top.
export function getRngState() { return state; }
export function setRngState(n) { state = n | 0; }

export const randInt = n => (random() * n) | 0;
export const choose = a => a[(random() * a.length) | 0];

// Reads #seed-... if present, otherwise rolls one and reports it so a good run
// can be shared or replayed.
export function initSeed() {
  const m = /seed-([A-Za-z0-9_]+)/.exec(location.hash);
  if (m) setSeed(/^\d+$/.test(m[1]) ? Number(m[1]) : hashSeed(m[1]));
  else setSeed((Math.random() * 0xFFFFFFFF) >>> 0);
  return RNG.seed;
}
