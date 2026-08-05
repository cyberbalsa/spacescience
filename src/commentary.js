import { hexLabel, pick } from './util.js';

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

const pending = [];        // the only source of scroller text
const PENDING_MAX = 8;

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
      if (d.super) {
        push(`SUPER FF!  WARP DROPPED A ${d.super}-ORB SUPPORT PATH TO THE CEILING`);
        break;
      }
      if (d.blast > 3) { push(`FF DETONATION!  ${d.blast} CELLS WENT UP WITH IT`); break; }
      push(pick([
        'FF!!!  EIGHT BITS SET AND GONE OFF THE BOARD',
        'BYTE OVERFLOW - THAT IS HOW YOU CLEAR A LATTICE',
        'FF BURNED. NOTHING LEFT BUT PHOTONS'
      ]));
      break;
    case 'drop':
      if (d.super) {
        push(`SUPER FF ROUTE!  ${d.n} SUPPORT ORB${d.n > 1 ? 'S' : ''} DROPPED`);
        break;
      }
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

/* -------------------------------------------------------- observations */
// The scroller used to fill dead air with rules and greetz on a loop, which
// meant it was always saying something and therefore never worth reading.
// Board facts are now EDGE triggered: a line fires the moment a condition
// becomes true and stays quiet until it changes back. Between events the
// scroller has nothing to say, and says nothing.
const seen = {
  danger: false, dud: false, buried: false, oneEdge: false,
  entropy: false, lowBuffer: false, wave: 0
};

export function observe() {
  const danger = CTX.rowsToSpare <= 2 && CTX.orbs > 0;
  if (danger !== seen.danger) {
    seen.danger = danger;
    if (danger) push('WATCH THE RED LINE - ONE MORE ROW AND IT IS OVER');
  }

  const dud = !!CTX.dud;
  if (dud !== seen.dud) {
    seen.dud = dud;
    if (dud) push('THAT ONE MATCHES NOTHING ON AN EDGE. PLACE IT WHERE IT WILL PAIR LATER');
  }

  const buried = CTX.buried > 0;
  if (buried !== seen.buried) {
    seen.buried = buried;
    if (buried) push(`${CTX.buried} VALUE${CTX.buried > 1 ? 'S' : ''} BURIED WITH NOTHING ON AN EDGE`);
  }

  const oneEdge = CTX.edgeKinds === 1 && CTX.orbs > 0;
  if (oneEdge !== seen.oneEdge) {
    seen.oneEdge = oneEdge;
    if (oneEdge) push('ONLY ONE VALUE LEFT ON AN EDGE. THE CANNON HAS NO CHOICE');
  }

  const hot = CTX.entropy > 0.6;
  if (hot !== seen.entropy) {
    seen.entropy = hot;
    if (hot) push(`ENTROPY AT ${Math.round(CTX.entropy * 100)} PERCENT - WATCH FOR CHAINS ` +
      'THAT CANNOT MERGE WITH ANYTHING OUT THERE');
  }

  const low = CTX.bufferIn <= 2;
  if (low !== seen.lowBuffer) {
    seen.lowBuffer = low;
    if (low) push(`INBOUND BUFFER IN ${CTX.bufferIn}`);
  }

  if (CTX.wave !== seen.wave) {
    seen.wave = CTX.wave;
    if (CTX.wave >= 3) push(`WAVE ${CTX.wave} AND STILL STANDING`);
  }
}

/* ---------------------------------------------------------------- the feed */
// Returns null when there is genuinely nothing to report, which is the signal
// for the scroller to stop rather than invent something.
export function nextPhrase() {
  if (!pending.length) return null;
  return pending.shift() + '   ...   ';
}

export function hasSomethingToSay() { return pending.length > 0; }

export function resetCommentary() {
  pending.length = 0;
  for (const k of Object.keys(seen)) seen[k] = (k === 'wave' ? 0 : false);
}
