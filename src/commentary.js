import { hexLabel, pick, rint } from './util.js';

// The scroller is the game's colour commentator. Rather than a fixed greetz
// blob it reacts to the last few things the player did, falling back to
// observations about the board when nothing interesting just happened.
//
// This module deliberately does NOT import game.js -- the bundler flattens
// everything into one scope and rejects import cycles, so game.js pushes facts
// in here instead of the commentary reaching back for them.

// Board facts, refreshed by game.js at the end of every turn.
export const CTX = {
  wave: 1, orbs: 0, shots: 0,
  topByte: 2, edgeKinds: 0, buried: 0, rowsToSpare: 99, bufferIn: 99,
  entropy: 0, hyper: false, dud: false
};

const pending = [];        // event lines, drained before any ambient chatter
const PENDING_MAX = 8;
let sinceEvent = 0;

function push(line) {
  if (pending.length >= PENDING_MAX) return;
  // Never queue the same line twice in a row; cascades fire a lot at once.
  if (pending[pending.length - 1] === line) return;
  pending.push(line);
}

/* ------------------------------------------------------------------ events */
export function onEvent(kind, d = {}) {
  switch (kind) {
    case 'fuse':
      if (d.chain >= 4) push(`CHAIN x${d.chain}!! THE WHOLE LATTICE IS GOING OFF`);
      else if (d.chain === 3) push(`TRIPLE CHAIN - ${hexLabel(d.v)} AND STILL FALLING`);
      else if (d.pairs > 1) push(`${d.pairs} PAIRS AT ONCE - ${d.pairs} FRESH ${hexLabel(d.v)}s`);
      else if (d.v >= 0x40) push(`${hexLabel(d.v)} ON THE BOARD. GETTING SPICY`);
      else if (d.v >= 0x10) push(pick([
        `THAT IS A ${hexLabel(d.v)}. HALFWAY UP THE LADDER`,
        `${hexLabel(d.v)} FUSED - KEEP CLIMBING`
      ]));
      break;
    case 'burn':
      if (d.blast > 3) { push(`FF DETONATION!  ${d.blast} CELLS WENT UP WITH IT`); break; }
      push(pick([
        'FF!!!  EIGHT BITS SET AND GONE OFF THE BOARD',
        'BYTE OVERFLOW - THAT IS HOW YOU CLEAR A LATTICE',
        'FF BURNED. NOTHING LEFT BUT PHOTONS'
      ]));
      break;
    case 'drop':
      push(d.n >= 6
        ? `AVALANCHE!  ${d.n} ORBS KNOCKED CLEAN OFF THE CEILING`
        : `${d.n} ORB${d.n > 1 ? 'S' : ''} CUT LOOSE AND DROPPED`);
      break;
    case 'wave':
      push(`WAVE ${d.wave} SWEPT CLEAN.  BONUS ${d.bonus}.  BRACE FOR THE NEXT ONE`);
      break;
    case 'push':
      push(pick([
        'INBOUND BUFFER FLUSHED - FRESH ROW ON THE STACK',
        'THE WALL JUST CAME DOWN A NOTCH. TICK TOCK'
      ]));
      break;
    case 'warp':
      push('WARP ORB BURNED - IT BECOMES WHATEVER IT TOUCHES');
      break;
    case 'dud':
      if (d.streak >= 3) push(pick([
        `${d.streak} SHOTS AND NOT ONE FUSION. TAKE YOUR TIME, DUDE`,
        'THE LATTICE IS JUST GETTING FATTER OVER HERE'
      ]));
      break;
    case 'over':
      push(`STACK BREACHED ON WAVE ${d.wave}. GAME OVER MAN, GAME OVER`);
      break;
    case 'start':
      push('NEW RUN. CLEAR EVERY ORB AND THE WAVE IS YOURS');
      break;
    case 'hyper':
      push(d.on
        ? '*** HYPER MODE ENGAGED *** THE BUFFER NEVER STOPS NOW. QUADRUPLE SCORE, IF YOU LIVE'
        : 'HYPER MODE DISENGAGED. BREATHE');
      break;
  }
}

/* ----------------------------------------------------------------- ambient */
const RULES = [
  'EVERY ORB IS AN EVEN BYTE. TOUCHING PAIRS COLLAPSE INTO THE NEXT TIER',
  'DOUBLING KEEPS A BYTE EVEN, SO 0A CLIMBS 14 28 50 A0 - ITS OWN LADDER',
  'AN 0A WILL NEVER PAIR WITH AN 08. DIFFERENT CHAINS, NO DEAL',
  'TWO 80s OVERFLOW TO FF AND BURN OFF - THAT IS THE ONLY WAY OUT',
  'THE CANNON ONLY LOADS WHAT IS SITTING ON AN EXPOSED EDGE',
  'HOLD SHIFT WHEN CHARGED TO BURN A WARP ORB',
  'KNOCK A CLUSTER OFF THE CEILING AND IT RAINS POINTS'
];

const FILLER = [
  'ONE HUNDRED PERCENT CLIENT SIDE - NO CDN, NO TRACKERS, NO NONSENSE',
  'CODE, GFX AND SOUNDCHIP HAND ROLLED',
  'GREETINGS TO EVERY CODER STILL PUSHING PIXELS FOR THE LOVE OF IT',
  'THE SCROLLER NEVER STOPS, IT ONLY WRAPS'
];

function ambient() {
  const bag = [];
  if (CTX.rowsToSpare <= 2 && CTX.orbs) bag.push('WATCH THE RED LINE. ONE MORE ROW AND IT IS OVER', 'THAT STACK IS GETTING AWFULLY CLOSE');
  if (CTX.orbs > 0) bag.push(`${CTX.orbs} ORBS STILL ON THE LATTICE`);
  if (CTX.topByte >= 8) bag.push(`TOP BYTE THIS RUN: ${hexLabel(CTX.topByte)}`);
  if (CTX.buried > 0) bag.push(`${CTX.buried} VALUE${CTX.buried > 1 ? 'S' : ''} BURIED WITH NOTHING ON AN EDGE`);
  if (CTX.edgeKinds === 1) bag.push('ONLY ONE VALUE LEFT ON AN EDGE. THE CANNON HAS NO CHOICE');
  if (CTX.bufferIn <= 2) bag.push(`INBOUND BUFFER IN ${CTX.bufferIn}`);
  if (CTX.wave >= 3) bag.push(`WAVE ${CTX.wave} AND STILL STANDING`);
  if (CTX.dud) bag.push('THE CHAMBER IS HOLDING A DUD. NOTHING ON AN EDGE MATCHES IT');
  if (CTX.hyper) bag.push('HYPER MODE. NO NOTES, JUST RESPECT', 'THE BUFFER IS RELENTLESS NOW');
  else if (CTX.entropy > 0.6) bag.push(
    `ENTROPY AT ${Math.round(CTX.entropy * 100)} PERCENT. THE CANNON IS GETTING CREATIVE`,
    'WATCH FOR CHAINS THAT CANNOT MERGE WITH ANYTHING OUT THERE');

  // Keep some cracktro filler in the mix so it still reads like a scroller.
  if (!bag.length || Math.random() < 0.45) bag.push(pick(RULES), pick(FILLER));
  return pick(bag);
}

/* ---------------------------------------------------------------- the feed */
export function nextPhrase() {
  let line;
  if (pending.length) {
    line = pending.shift();
    sinceEvent = 0;
  } else {
    line = ambient();
    sinceEvent++;
    // After a long quiet stretch, drop in a title card the way a real intro would.
    if (sinceEvent % 7 === 0) line = 'S P A C E   S C I E N C E';
  }
  return line + '   ...   ';
}

export function resetCommentary() {
  pending.length = 0;
  sinceEvent = rint(3);
}
