#!/usr/bin/env node
// Drives a REAL (non-headless) Firefox window over WebDriver BiDi and pulls
// the profiler numbers out of it.
//
// Headless Firefox is useless for this: it throttles requestAnimationFrame to
// a near standstill and falls back to software rendering, so it measures the
// headless policy rather than the game. Firefox 129+ removed CDP, so BiDi is
// the remaining option.
//
//   node tools/ffdrive.mjs [seconds] [--url <url>] [--shot out.png]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const SECONDS = Number(argv[0]) || 8;
const urlFlag = argv.indexOf('--url');
const shotFlag = argv.indexOf('--shot');
const URL_ = urlFlag >= 0 ? argv[urlFlag + 1]
  : 'file://' + path.join(ROOT, 'dist', 'index.html') + '#profile';
const SHOT = shotFlag >= 0 ? argv[shotFlag + 1] : null;
const evalFlag = argv.indexOf('--eval');
const EVAL = evalFlag >= 0 ? argv[evalFlag + 1] : null;
// Runs after the first expression, in the SAME browser session, so a reload can
// be exercised: a second driver run gets a fresh profile and empty storage.
const thenFlag = argv.indexOf('--then');
const THEN = thenFlag >= 0 ? argv[thenFlag + 1] : null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ bidi  */
function bidi(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(`${m.error}: ${m.message}`));
    else p.resolve(m.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}

// With CDP gone, the remote agent advertises itself by writing the socket
// details into the profile directory rather than serving /json/version.
async function waitForAgent(profile, port) {
  const marker = path.join(profile, 'WebDriverBiDiServer.json');
  for (let i = 0; i < 250; i++) {
    try {
      const j = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (j.ws_port) return `ws://${j.ws_host || '127.0.0.1'}:${j.ws_port}/session`;
    } catch { /* not written yet */ }
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* nor that */ }
    await sleep(150);
  }
  throw new Error('firefox remote agent never came up');
}

/* ----------------------------------------------------------------- main   */
async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-ff-'));
  // A fresh profile would otherwise open onboarding tabs over the game.
  fs.writeFileSync(path.join(profile, 'user.js'), [
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("browser.aboutwelcome.enabled", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    'user_pref("browser.sessionstore.resume_from_crash", false);',
    'user_pref("remote.prefs.recommended", true);',
    // Synthetic events are untrusted, so without this the autoplay gate blocks
    // play() and the soundtrack can never be verified. A real player supplies a
    // real gesture; this only unblocks the automated check.
    'user_pref("media.autoplay.default", 0);',
    'user_pref("media.autoplay.blocking_policy", 0);',
    'user_pref("media.volume_scale", "0.0");'
  ].join('\n'));

  const port = 9400 + (process.pid % 300);
  // --no-remote matters: without it this attaches to the user's running
  // Firefox instead of starting a controllable one.
  const ff = spawn('firefox', [
    '--no-remote', '--new-instance',
    '--profile', profile,
    `--remote-debugging-port=${port}`,
    '--width', '1440', '--height', '900',
    URL_
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let ffErr = '';
  ff.stderr.on('data', d => { ffErr += d; });

  try {
    const wsUrl = await waitForAgent(profile, port).catch(e => {
      throw new Error(e.message + (ffErr ? '\n--- firefox stderr ---\n' + ffErr.slice(-1200) : ''));
    });
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('bidi socket failed')));
    });
    const send = bidi(ws);

    await send('session.new', { capabilities: {} });
    const tree = await send('browsingContext.getTree', {});
    const ctx = tree.contexts[0].context;

    await send('browsingContext.navigate', { context: ctx, url: URL_, wait: 'complete' });

    const evalJs = async expr => {
      const r = await send('script.evaluate', {
        expression: expr,
        target: { context: ctx },
        awaitPromise: true,
        resultOwnership: 'none'
      });
      if (r.type === 'exception') {
        throw new Error(r.exceptionDetails?.text || JSON.stringify(r).slice(0, 400));
      }
      if (process.env.FFDEBUG) console.log('  eval ->', JSON.stringify(r).slice(0, 300));
      return r.result?.value;
    };

    for (let i = 0; i < 60; i++) {
      if (await evalJs('typeof window.SPACESCIENCE === "object"')) break;
      await sleep(200);
    }

    if (EVAL) {
      await sleep(1200);
      console.log(await evalJs(EVAL));
      if (THEN) {
        await sleep(2500);
        for (let i = 0; i < 60; i++) {
          if (await evalJs('typeof window.SPACESCIENCE === "object"').catch(() => false)) break;
          await sleep(200);
        }
        console.log(await evalJs(THEN));
      }
      if (SHOT) {
        const img = await send('browsingContext.captureScreenshot', { context: ctx });
        fs.writeFileSync(SHOT, Buffer.from(img.data, 'base64'));
        console.log(`  wrote ${SHOT}`);
      }
      ws.close();
      return;
    }

    console.log(`\n  measuring a real Firefox window for ${SECONDS}s ...`);
    await evalJs('window.SPACESCIENCE.PROF.frames = 0; ' +
      'window.SPACESCIENCE.PROF.seen = 0; window.SPACESCIENCE.PROF.frameMs = 0; ' +
      'window.SPACESCIENCE.PROF.worst = 0; window.SPACESCIENCE.PROF.acc = {}; ' +
      'window.SPACESCIENCE.PROF.order = []; true');
    await sleep(SECONDS * 1000);

    const raw = await evalJs(`JSON.stringify((() => {
      const s = window.SPACESCIENCE.summary();
      return { frames: s.frames, avg: s.avg, worst: s.worst, fps: s.fps, rows: s.rows,
               dpr: window.devicePixelRatio,
               cw: document.getElementById('c').width,
               ch: document.getElementById('c').height };
    })())`);
    const r = JSON.parse(raw);
    if (!r.frames) {
      throw new Error(`no frames sampled in ${SECONDS}s - the page is slower than ` +
        `the warmup window, try a longer run`);
    }

    // Wall-clock fps is the number that matters. The JS-side average only
    // covers command submission: Firefox rasterises the canvas off-thread, so
    // paint cost never appears in a performance.now() delta.
    console.log(`\n  WALL ${(r.frames / SECONDS).toFixed(1)} fps  ` +
      `(${r.frames} frames in ${SECONDS}s)`);
    console.log(`  js-side avg ${r.avg.toFixed(2)} ms | worst ${r.worst.toFixed(1)} ms ` +
      `-- excludes off-thread rasterisation`);
    console.log(`  canvas ${r.cw}x${r.ch} @ dpr ${r.dpr}\n`);
    console.log('  section                   ms/frame      %');
    for (const [name, ms] of r.rows) {
      const pct = (ms / r.avg) * 100;
      console.log(`  ${name.padEnd(22)} ${ms.toFixed(3).padStart(9)}  ${pct.toFixed(1).padStart(6)}` +
        '  ' + '#'.repeat(Math.round(pct / 2.5)));
    }
    console.log('');

    if (SHOT) {
      const img = await send('browsingContext.captureScreenshot', { context: ctx });
      fs.writeFileSync(SHOT, Buffer.from(img.data, 'base64'));
      console.log(`  wrote ${SHOT}\n`);
    }
    ws.close();
  } finally {
    ff.kill();
    await sleep(400);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch(e => { console.error('ffdrive failed: ' + e.message); process.exit(1); });
