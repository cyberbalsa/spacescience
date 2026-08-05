// Tunables and layout constants. Virtual resolution is fixed; the whole
// frame is letterboxed onto whatever the window happens to be.

export const TAU = Math.PI * 2;

export const VW = 1280, VH = 720;

export const R = 24;                                  // bubble radius
export const COLS = 12;                               // cells on a "full" row
export const ROWH = R * 1.7320508;                    // r * sqrt(3)
export const PF_W = COLS * 2 * R;                     // 576
export const PF_X = (VW - PF_W) / 2;                  // 352
export const PF_TOP = 78;                             // top edge of row 0
export const DANGER_ROW = 12;
export const DANGER_Y = PF_TOP + R + DANGER_ROW * ROWH;

export const FRAME = { x: PF_X - 8, y: 62, w: PF_W + 16, h: 626 };
export const LEFT_PANEL = { x: 16, y: 62, w: 320, h: 626 };
export const RIGHT_PANEL = { x: 944, y: 62, w: 320, h: 626 };

export const LAUNCH = { x: VW / 2, y: 656 };
export const AIM_LIMIT = 0.26;                        // radians off horizontal
export const SPEED = 15.5;                            // px per 1/60s

/* ------------------------------------------------------------ the ladder */
// Orbs are bytes. Fusing N of a kind doubles N-1 times, so a pair of 80s
// makes 100, which does not fit in a byte: it saturates to FF, all bits set,
// and an orb with every bit set pops off the board. Clearing the board is the
// whole point, so FF is the only exit an orb has.
// The powers of two are the spine of the game, but they are not the only
// chain. Doubling any byte keeps you inside the even bytes, so 0A has its own
// ladder -- 0A 14 28 50 A0 -- that also dead-ends at FF. Two orbs only ever
// merge on an exact match, so an 0A can never pair with an 08: seeding more
// chains is what puts genuinely unusable values on the board.
export const TIERS = [0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80];
export const FULL = 0xFF;
export const OVERFLOW = 0x100;

// Every byte in play is even -- 01 never appears, and doubling an even byte
// keeps it even. Seeds are listed in the order entropy unlocks them: the first
// three are the clean powers of two, everything after drags a fresh chain onto
// the board that cannot merge with them.
export const SEEDS = [
  0x02, 0x04, 0x08,
  0x06, 0x0A, 0x0C, 0x0E,
  0x10, 0x12, 0x14, 0x16, 0x18, 0x1A, 0x1C, 0x1E,
  0x20, 0x24, 0x28, 0x2C, 0x30, 0x38
];

export const FULL_HUE = 45;
// Hue identifies the chain a byte belongs to; each doubling nudges it along,
// so a ladder reads as a gradient and separate chains sit apart on the wheel.
export const ROOT_BASE = 190;     // powers of two start in cyan
export const ROOT_SPREAD = 137.508;
export const STEP_SHIFT = 19;

/* ---------------------------------------------------------------- entropy */
// How strange a wave is allowed to get. 0 on wave 1 (tidy board, the cannon
// always hands you something usable), 1 by CHAOS_FULL: exotic layouts, lone
// high bytes with no partner, and ammo that matches nothing you can reach.
export const CHAOS_FULL = 10;
export const baseEntropy = lvl =>
  Math.max(0, Math.min(1, (lvl - 1) / (CHAOS_FULL - 1)));

export const holeRate = e => 0.12 + 0.20 * e;
export const dudChance = e => 0.40 * e;      // odds of an off-edge orb
export const flatOdds = e => e;              // odds of ignoring the low-tier bias

/* ------------------------------------------------------------ hyper mode */
export const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown',
  'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight'];
export const HYPER_SHOTS = 2;    // the wall comes down every other shot
export const HYPER_ROWS = 2;     // and it starts deeper
export const HYPER_MULT = 4;     // the only compensation you get
export const MAX_BUFFER = 32;     // drops can postpone, never bank forever

/* ------------------------------------------------------------ wave curve */
export const BASE_ROWS = 5;
export const BASE_SHOTS_PER_ROW = 8;

export const waveRows = lvl => Math.min(7, BASE_ROWS + ((lvl - 1) >> 1));
export const waveShots = lvl => Math.max(4, BASE_SHOTS_PER_ROW - ((lvl - 1) >> 1));
// Wave 1 seeds 01/02/04; deeper waves start salting in the higher bytes.
export const waveSeeds = (lvl, e) => {
  const n = Math.round(3 + e * (SEEDS.length - 3));
  return SEEDS.slice(0, Math.max(3, Math.min(SEEDS.length, n)));
};

/* ---------------------------------------------------------------- scoring */
export const PTS_FUSE = 8;          // x orb value x chain
export const PTS_OVERFLOW = 4096;   // x chain, for every FF popped
export const PTS_DROP = 4;          // x orb value, per orb knocked loose
export const PTS_WAVE = 5000;       // x wave number

export const TITLE = 'SPACE SCIENCE';
export const SITE = 'spacescience.tech';
export const REPO = 'github.com/cyberbalsa';

// build.mjs rewrites the stamp below. Unbundled (npm run dev) it stays as the
// marker, which does not start with a digit, so it reads as "dev".
const STAMP = '@@VERSION@@';
export const VERSION = /^\d/.test(STAMP) ? STAMP : 'dev';
