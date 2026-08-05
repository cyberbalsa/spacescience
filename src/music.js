// Soundtrack manifest.
//
// The tracks live in music/ as OGG. build.mjs base64-encodes them straight
// into EMBEDDED so dist/index.html stays one self-contained file; when the
// sources are served unbundled that object is empty and the relative paths are
// used instead, so `npm run dev` still has music without a 10 MB bundle.

// build.mjs replaces the literal on the next line. Do not reformat it.
export const EMBEDDED = /* @music-embed */ {};

export function trackUrl(file) {
  return EMBEDDED[file] || ('../music/' + file);
}

export const TRACK_FILES = {
  intro: 'introzik.ogg',
  p1: 'frozen-mainzik-1p.ogg',
  p2: 'frozen-mainzik-2p.ogg'
};

// introzik owns the menu and loops there. Launching a run drops straight into
// 2p, and from then on 2p and 1p trade off for as long as you survive.
export const MENU_TRACK = 'intro';
export const GAME_ROTATION = ['p2', 'p1'];
