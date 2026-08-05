// Resume-in-progress storage.
//
// This is deliberately dumb: read, write, clear, and a version stamp. All the
// knowledge of what a game *is* stays in game.js, which hands over a plain
// object. Anything unreadable, from a corrupt entry to a save written by an
// older rule set, is discarded rather than half-applied -- restoring a board
// into mismatched rules would be far worse than losing one run.

const SAVE_KEY = 'spacescience.save';

// Bump whenever the shape or the rules change enough that an old board would
// be wrong. Old saves are then dropped instead of loaded.
export const SAVE_VERSION = 3;

export function writeSave(obj) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ v: SAVE_VERSION, ...obj }));
    return true;
  } catch (e) {
    return false;                       // private mode, quota, file:// - fine
  }
}

export function readSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || s.v !== SAVE_VERSION) return null;
    return s;
  } catch (e) {
    return null;
  }
}

export function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* nothing to do */ }
}
