import { clamp } from './util.js';
import { trackUrl, TRACK_FILES, MENU_TRACK, GAME_ROTATION } from './music.js';

// A tiny 4-bar chiptune loop plus one-shot SFX, all synthesised on the fly.
// Nothing is fetched; the WebAudio graph is the entire soundtrack.
export const Snd = (() => {
  let ac = null, master = null, musGain = null, sfxGain = null;
  let analyser = null, freq = null;
  let started = false, step = 0, nextT = 0;

  // 'tracks' once a real ogg is playing, 'synth' if none of them would load.
  let musicMode = 'none';
  const els = {};
  const wired = new Set();
  let scene = 'none', rotIdx = 0, current = null;
  const S = { music: true, sfx: true };
  const BPM = 126, SPB = 60 / BPM / 4;      // one sixteenth

  const ROOT = [55.00, 43.65, 32.70, 49.00];              // Am F C G
  const CH = [[0, 3, 7, 10], [0, 4, 7, 11], [0, 4, 7, 11], [0, 4, 7, 10]];
  const BASSPAT = [1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  const HATPAT = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0];
  const KICKPAT = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0];

  function init() {
    if (ac) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    master = ac.createGain(); master.gain.value = 0.85; master.connect(ac.destination);
    musGain = ac.createGain(); musGain.gain.value = 0.55; musGain.connect(master);
    sfxGain = ac.createGain(); sfxGain.gain.value = 0.42; sfxGain.connect(master);

    // Tapped off master so the HUD analyser shows the music AND the SFX.
    analyser = ac.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    master.connect(analyser);
    freq = new Uint8Array(analyser.frequencyBinCount);
  }

  function tone(t, f, dur, type, peak, dest, glide) {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(20, glide), t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.006 + dur);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
  }

  function noise(t, dur, peak, dest, hp) {
    const len = Math.ceil(ac.sampleRate * dur) + 1;
    const b = ac.createBuffer(1, len, ac.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const n = ac.createBufferSource(); n.buffer = b;
    const f = ac.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp || 4000;
    const g = ac.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f); f.connect(g); g.connect(dest);
    n.start(t); n.stop(t + dur + 0.02);
  }

  /* ------------------------------------------------------------ playlist */
  // Routing each element through the graph (rather than letting it play
  // straight to the speakers) is what lets the HUD analyser see the music.
  function wire(id, el) {
    if (wired.has(id) || !ac) return;
    wired.add(id);
    try {
      ac.createMediaElementSource(el).connect(musGain);
    } catch (e) {
      // Some engines refuse this for certain sources; the element still plays,
      // it just will not show up in the spectrum.
    }
  }

  function play(id, loop) {
    const el = els[id];
    if (!el) return;
    if (current && current !== el) { current.pause(); current.currentTime = 0; }
    current = el;
    el.loop = !!loop;
    wire(id, el);
    el.currentTime = 0;
    const p = el.play();
    if (p && p.catch) p.catch(() => { /* gesture policy; retried on next start() */ });
  }

  function onEnded() {
    if (scene !== 'game' || musicMode !== 'tracks' || !S.music) return;
    rotIdx = (rotIdx + 1) % GAME_ROTATION.length;
    play(GAME_ROTATION[rotIdx], false);
  }

  function initTracks() {
    let usable = 0;
    for (const id of Object.keys(TRACK_FILES)) {
      const el = new Audio();
      el.src = trackUrl(TRACK_FILES[id]);
      el.preload = 'auto';
      el.loop = false;
      el.addEventListener('ended', onEnded);
      el.addEventListener('error', () => {
        // If nothing at all loads, fall back to the built-in sequencer.
        if (--usable <= 0) musicMode = 'synth';
      });
      els[id] = el;
      usable++;
    }
    musicMode = usable ? 'tracks' : 'synth';
  }

  function stopTracks() {
    for (const id of Object.keys(els)) if (els[id]) els[id].pause();
  }

  function resumeScene() {
    if (musicMode !== 'tracks') return;
    if (scene === 'menu') play(MENU_TRACK, true);
    else if (scene === 'game') play(GAME_ROTATION[rotIdx], false);
  }

  // Schedules ~160ms ahead so a busy main thread never gaps the loop.
  // Only used when the ogg tracks are unavailable.
  function tick() {
    if (!ac || musicMode !== 'synth') return;
    // If the main thread stalled, nextT is now in the past. Scheduling notes
    // at past timestamps makes them all fire at once, which reads as silence
    // or a garbled blip, so skip the missed beats and resync to the clock.
    if (nextT < ac.currentTime) {
      const missed = Math.ceil((ac.currentTime - nextT) / SPB);
      nextT += missed * SPB;
      step = (step + missed) & 63;
    }
    while (nextT < ac.currentTime + 0.16) {
      const bar = (step >> 4) & 3, s16 = step & 15, ch = CH[bar], root = ROOT[bar];
      if (S.music) {
        if (BASSPAT[s16]) tone(nextT, root, 0.16, 'square', 0.5, musGain, root * 0.99);
        if (KICKPAT[s16]) tone(nextT, 130, 0.20, 'sine', 0.9, musGain, 38);
        if (HATPAT[s16]) noise(nextT, 0.045, 0.16, musGain, 7000);
        if (s16 % 2 === 0) {
          const n = ch[(s16 / 2 + bar) % ch.length];
          tone(nextT, root * 4 * Math.pow(2, n / 12), 0.11, 'sawtooth', 0.10, musGain);
        }
        if (s16 === 0 || s16 === 10) {
          const n = ch[(bar + 1) % ch.length];
          tone(nextT, root * 2 * Math.pow(2, n / 12), 0.42, 'triangle', 0.13, musGain);
        }
      }
      nextT += SPB;
      step = (step + 1) & 63;
    }
  }

  return {
    S,
    // 'menu' loops the intro; 'game' drops into 2p and alternates with 1p.
    music(next) {
      if (next === scene) return;
      scene = next;
      if (next === 'game') rotIdx = 0;
      if (!started || !S.music) return;
      resumeScene();
    },
    toggleMusic() {
      S.music = !S.music;
      if (!started) return S.music;
      if (S.music) resumeScene(); else stopTracks();
      return S.music;
    },
    // Per-track load/playback state, for the automated checks.
    debug() {
      const out = { mode: musicMode, scene, rotIdx, started };
      for (const id of Object.keys(els)) {
        const e = els[id];
        out[id] = {
          ready: e.readyState, net: e.networkState, paused: e.paused,
          t: +e.currentTime.toFixed(2), dur: isFinite(e.duration) ? +e.duration.toFixed(1) : null,
          err: e.error ? e.error.code : null
        };
      }
      return out;
    },
    get playing() {
      return musicMode === 'tracks' && current && !current.paused ? current : null;
    },
    // Peak magnitude in `bars` log-spaced buckets across the musical range,
    // 0..1 each. Null until the audio graph exists, so the HUD can fall back.
    spectrum(bars, out) {
      if (!analyser) return null;
      analyser.getByteFrequencyData(freq);
      // Everything this soundchip makes lives under ~8 kHz; a log-ish spread
      // over the low bins keeps the bars lively instead of flat on the left.
      const TOP = Math.min(freq.length, 48);
      for (let i = 0; i < bars; i++) {
        const lo = Math.floor(Math.pow(i / bars, 1.7) * TOP);
        const hi = Math.max(lo + 1, Math.floor(Math.pow((i + 1) / bars, 1.7) * TOP));
        let peak = 0;
        for (let b = lo; b < hi && b < freq.length; b++) if (freq[b] > peak) peak = freq[b];
        out[i] = peak / 255;
      }
      return out;
    },
    start() {
      init();
      if (!ac) return;
      if (ac.state === 'suspended') ac.resume();
      if (started) return;
      started = true;
      initTracks();
      nextT = ac.currentTime + 0.1;
      setInterval(tick, 40);
      if (S.music) resumeScene();
    },
    fx(kind, v) {
      if (!ac || !S.sfx) return;
      const t = ac.currentTime;
      switch (kind) {
        case 'shoot': tone(t, 880, 0.11, 'square', 0.20, sfxGain, 220); break;
        case 'stick':
          tone(t, 300, 0.06, 'triangle', 0.30, sfxGain, 180);
          noise(t, 0.04, 0.10, sfxGain, 3000); break;
        case 'bounce': tone(t, 620, 0.04, 'square', 0.12, sfxGain, 500); break;
        case 'merge': {
          const n = clamp(Math.log2(v || 4) - 1, 1, 12);
          for (let i = 0; i < 4; i++)
            tone(t + i * 0.035, 440 * Math.pow(2, (n + i * 3) / 12), 0.14, 'square', 0.18, sfxGain);
          break;
        }
        case 'overflow':
          // eight rising blips, one per bit, then a low boom
          for (let i = 0; i < 8; i++)
            tone(t + i * 0.028, 330 * Math.pow(2, i / 6), 0.10, 'square', 0.20, sfxGain);
          tone(t + 0.24, 220, 0.55, 'sawtooth', 0.34, sfxGain, 40);
          noise(t + 0.24, 0.35, 0.22, sfxGain, 900);
          break;
        case 'drop':
          for (let i = 0; i < 5; i++)
            tone(t + i * 0.03, 1400 - i * 180, 0.10, 'triangle', 0.14, sfxGain);
          break;
        case 'warp':
          for (let i = 0; i < 8; i++)
            tone(t + i * 0.025, 300 + i * 220, 0.09, 'sawtooth', 0.10, sfxGain);
          break;
        case 'over':
          for (let i = 0; i < 10; i++)
            tone(t + i * 0.09, 500 / (1 + i * 0.35), 0.30, 'square', 0.22, sfxGain);
          break;
        case 'win':
          for (let i = 0; i < 12; i++)
            tone(t + i * 0.06, 300 * Math.pow(2, i / 5), 0.22, 'square', 0.16, sfxGain);
          break;
      }
    }
  };
})();
