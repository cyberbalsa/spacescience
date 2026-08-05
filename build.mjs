#!/usr/bin/env node
// Flattens src/ into a single self-contained dist/index.html.
//
// The "bundler" is deliberately tiny: every module ends up concatenated into
// one scope, so `import`/`export` lines are simply stripped after a topological
// sort. That only works because the source obeys two rules, both of which are
// enforced below:
//   1. imports are relative, and contain no quotes or semicolons before `from`
//      (multi-line specifier lists are fine)
//   2. no two modules declare the same top-level name

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'dist');
const ENTRY = path.join(SRC, 'main.js');

// `[^;'"]*` is allowed to span newlines, which is what lets a multi-line
// `import { a, b } from './x.js'` match as a single statement, while the
// excluded characters stop it from swallowing whatever came before it.
const IMPORT_RE = /^[ \t]*import\b[^;'"]*from[ \t]*['"]([^'"]+)['"][ \t]*;?[ \t]*$/gm;
const BARE_IMPORT_RE = /^[ \t]*import[ \t]+['"]([^'"]+)['"][ \t]*;?[ \t]*$/gm;

/* ------------------------------------------------------------ dependency  */
const visiting = new Set();
const done = new Set();
const order = [];

function resolveDep(from, spec) {
  if (!spec.startsWith('.')) {
    throw new Error(`${path.relative(ROOT, from)}: bare import "${spec}" is not supported`);
  }
  const p = path.resolve(path.dirname(from), spec);
  if (!fs.existsSync(p)) throw new Error(`${path.relative(ROOT, from)}: cannot resolve "${spec}"`);
  return p;
}

function collect(file) {
  if (done.has(file)) return;
  if (visiting.has(file)) {
    // Concatenation flattens cycles into one scope; hoisted functions survive
    // it but top-level initialisation order would not. Fail loudly instead.
    throw new Error(`import cycle through ${path.relative(ROOT, file)}`);
  }
  visiting.add(file);

  const code = fs.readFileSync(file, 'utf8');
  for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code))) collect(resolveDep(file, m[1]));
  }

  visiting.delete(file);
  done.add(file);
  order.push(file);
}

/* ----------------------------------------------------------- transform    */
// `import { a as b }` has to become a real binding once the scope is flattened,
// otherwise `b` simply does not exist and the failure only shows up at runtime.
// Default and namespace imports cannot be expressed this way at all, so they
// are rejected outright rather than silently dropped.
const aliasOwner = new Map();

function expandImport(file, whole, spec) {
  const braces = whole.match(/\{([\s\S]*?)\}/);
  const where = `${path.relative(ROOT, file)}: `;
  if (!braces) {
    throw new Error(`${where}only named imports are supported, got: ${whole.trim()}`);
  }
  if (/^\s*import\s+[A-Za-z_$]/.test(whole)) {
    throw new Error(`${where}default imports are not supported: ${whole.trim()}`);
  }
  const lines = [];
  for (const part of braces[1].split(',')) {
    const t = part.trim();
    if (!t) continue;
    const m = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(t);
    if (!m) continue;                       // plain name: already in scope
    const [, from, to] = m;
    const prev = aliasOwner.get(to);
    if (prev === from) continue;            // same alias twice is harmless
    if (prev) throw new Error(`${where}alias "${to}" already means "${prev}"`);
    aliasOwner.set(to, from);
    lines.push(`const ${to} = ${from};`);
  }
  return lines.join('\n');
}

function strip(file, code) {
  const out = code
    .replace(IMPORT_RE, (whole, spec) => expandImport(file, whole, spec))
    .replace(BARE_IMPORT_RE, '')
    .replace(/^[ \t]*export[ \t]*\{[^}]*\}[ \t]*;?[ \t]*$/gm, '')
    .replace(/^([ \t]*)export[ \t]+default[ \t]+/gm, '$1')
    .replace(/^([ \t]*)export[ \t]+(?=(?:const|let|var|function|class|async)\b)/gm, '$1');

  // A survivor here would be a hard SyntaxError in a classic <script>, and
  // Node's ESM auto-detection happily parses it, so check explicitly.
  const bad = out.split('\n').findIndex(l => /^[ \t]*(import|export)\b/.test(l));
  if (bad >= 0) {
    throw new Error(
      `${path.relative(ROOT, file)}:${bad + 1}: module syntax survived stripping\n` +
      `    ${out.split('\n')[bad].trim()}`);
  }
  return out;
}

// Catches the one failure mode of scope flattening: a duplicated top-level
// binding that would silently shadow across modules.
const DECL_RE = /^(?:const|let|var|function|class)[ \t]+([A-Za-z_$][\w$]*)/;
function topLevelNames(code) {
  const names = [];
  for (const line of code.split('\n')) {
    const m = DECL_RE.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/* ----------------------------------------------------------------- music  */
// Inlines music/*.ogg as data URIs so the bundle needs no sidecar files. This
// is most of dist/index.html's weight, and that is the deliberate trade for
// "one file you can double-click".
const MUSIC_MARKER = '/* @music-embed */ {}';
const MUSIC_DIR = path.join(ROOT, 'music');

function embedMusic(js) {
  if (!js.includes(MUSIC_MARKER)) {
    if (fs.existsSync(MUSIC_DIR)) console.warn('  warn: music present but no @music-embed marker');
    return js;
  }
  if (!fs.existsSync(MUSIC_DIR)) {
    console.warn('  warn: no music/ directory - bundling without a soundtrack');
    return js.replace(MUSIC_MARKER, '{}');
  }
  const files = fs.readdirSync(MUSIC_DIR).filter(f => f.toLowerCase().endsWith('.ogg')).sort();
  if (!files.length) return js.replace(MUSIC_MARKER, '{}');

  let bytes = 0;
  const entries = files.map(f => {
    const buf = fs.readFileSync(path.join(MUSIC_DIR, f));
    bytes += buf.length;
    return `${JSON.stringify(f)}:${JSON.stringify('data:audio/ogg;base64,' + buf.toString('base64'))}`;
  });
  console.log(`  embedded ${files.length} tracks (${(bytes / 1048576).toFixed(1)} MB of ogg)`);
  return js.replace(MUSIC_MARKER, '{\n' + entries.join(',\n') + '\n}');
}

/* ------------------------------------------------------------------ font  */
// Same trick as the music: the @font-face url becomes a data: payload so the
// bundle carries its own typeface.
//
// This silently not running once already shipped a broken site. The relative
// path resolves fine from file:// and from the dev server, so the font looked
// correct locally while the deployed page had no /fonts/ to fetch. Hence the
// assertion below rather than a warning.
const FONT_URL_RE = /url\(["']?\.\.\/fonts\/([^"')]+)["']?\)/g;

function embedFonts(css) {
  const out = css.replace(FONT_URL_RE, (whole, file) => {
    const f = path.join(ROOT, 'fonts', file);
    if (!fs.existsSync(f)) {
      throw new Error(`@font-face references fonts/${file}, which does not exist`);
    }
    const buf = fs.readFileSync(f);
    const mime = file.endsWith('.woff2') ? 'font/woff2' : 'font/woff';
    console.log(`  embedded font ${file} (${(buf.length / 1024).toFixed(1)} kB)`);
    return `url("data:${mime};base64,${buf.toString('base64')}")`;
  });

  // A stray relative url() here means the deployed page would try to fetch it
  // from the origin and get whatever the 404 handler returns.
  if (/url\(["']?\.{0,2}\/?fonts\//.test(out)) {
    throw new Error('a font url() survived inlining; the deployed page would 404 on it');
  }
  return out;
}

/* --------------------------------------------------------------- version  */
// A UTC build stamp, so what is on screen identifies exactly which build is
// deployed. Sortable, and precise enough to tell two deploys on the same day
// apart -- which matters when the deploy is a file copy with no image tag.
const VERSION_MARKER = '@@VERSION@@';

function stampVersion(js) {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `1.${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}` +
    `${p(d.getUTCDate())}.${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  if (!js.includes(VERSION_MARKER)) {
    throw new Error('version marker missing; the page would display "dev"');
  }
  console.log(`  version v${stamp}`);
  return js.replace(VERSION_MARKER, stamp);
}

/* ----------------------------------------------------------------- build  */
function build() {
  collect(ENTRY);

  const chunks = [];
  const owner = new Map();
  const clashes = [];

  for (const file of order) {
    const rel = path.relative(SRC, file);
    const code = strip(file, fs.readFileSync(file, 'utf8')).replace(/\n{3,}/g, '\n\n').trim();
    for (const n of topLevelNames(code)) {
      if (owner.has(n)) clashes.push(`${n} (${owner.get(n)} vs ${rel})`);
      else owner.set(n, rel);
    }
    chunks.push(
      `/* ${'='.repeat(72)}\n   ${rel}\n   ${'='.repeat(72) } */\n\n${code}\n`);
  }

  if (clashes.length) {
    throw new Error('duplicate top-level names after flattening:\n  - ' + clashes.join('\n  - '));
  }

  const banner = '/* SPACE SCIENCE (C) 2026 Balsa - GPL-2.0 - ' +
    'https://github.com/cyberbalsa/spacescience */\n';
  let js = banner + `(function () {\n"use strict";\n\n${chunks.join('\n')}\n})();`;
  js = stampVersion(js);
  js = embedMusic(js);
  const css = embedFonts(fs.readFileSync(path.join(SRC, 'style.css'), 'utf8').trim());

  const LINK_RE = /[ \t]*<link[^>]*href="style\.css"[^>]*>\n?/;
  const SCRIPT_RE = /[ \t]*<script[^>]*src="main\.js"[^>]*><\/script>\n?/;
  let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  if (!LINK_RE.test(html) || !SCRIPT_RE.test(html)) {
    throw new Error('src/index.html is missing the style.css / main.js tags to inline');
  }
  // Function replacements: `$&`-style patterns in the source must stay literal.
  html = html.replace(LINK_RE, () => `<style>\n${css}\n</style>\n`);
  html = html.replace(SCRIPT_RE, () => `<script>\n${js}\n</script>\n`);

  fs.mkdirSync(OUT, { recursive: true });
  const outFile = path.join(OUT, 'index.html');
  fs.writeFileSync(outFile, html);

  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`bundled ${order.length} modules -> dist/index.html (${kb} kB)`);
  console.log('  ' + order.map(f => path.relative(SRC, f)).join(' -> '));
}

try {
  build();
} catch (e) {
  console.error('build failed: ' + e.message);
  process.exit(1);
}
