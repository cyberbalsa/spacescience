import { VW, VH, TAU } from './config.js';
import { clamp, rnd } from './util.js';

/* ------------------------------------------------------------------ stars */
const stars = [];
for (let i = 0; i < 340; i++)
  stars.push({ x: rnd(2, -1), y: rnd(2, -1), z: rnd(1, .02), px: 0, py: 0, pz: 0 });

export function drawStars(g) {
  g.globalCompositeOperation = 'lighter';
  for (const s of stars) {
    s.z -= 0.0042;
    if (s.z <= 0.02) { s.x = rnd(2, -1); s.y = rnd(2, -1); s.z = 1; s.pz = 0; }
    const k = 0.42 / s.z;
    const x = VW / 2 + s.x * VW * k * 0.55;
    const y = VH / 2 + s.y * VH * k * 0.55;
    if (x < -50 || x > VW + 50 || y < -50 || y > VH + 50) { s.z = 1; s.pz = 0; continue; }
    const b = clamp((1 - s.z) * 1.2, 0, 1);
    const sz = clamp((1 - s.z) * 2.8, 0.4, 3);
    g.fillStyle = `rgba(${180 + b * 75},${210 + b * 45},255,${b * .95})`;
    g.fillRect(x, y, sz, sz);
    if (s.pz) {
      g.strokeStyle = `rgba(120,200,255,${b * .35})`;
      g.lineWidth = sz * .6;
      g.beginPath(); g.moveTo(x, y); g.lineTo(s.px, s.py); g.stroke();
    }
    s.px = x; s.py = y; s.pz = 1;
  }
  g.globalCompositeOperation = 'source-over';
}

/* ----------------------------------------------------------------- plasma */
// Classic low-res sine plasma, scaled up with smoothing for that soft
// 90s-intro gradient. 80x46 pixels is plenty once it is blown up to 1280x720.
const PW = 80, PH = 46;
const pcv = document.createElement('canvas');
pcv.width = PW; pcv.height = PH;
const pctx = pcv.getContext('2d');
const pimg = pctx.createImageData(PW, PH);

const SINT = new Float32Array(2048);
for (let i = 0; i < 2048; i++) SINT[i] = Math.sin(i / 2048 * TAU);
const sn = a => SINT[((a * 325.949) | 0) & 2047];

// Precomputed radial distance from the plasma centre.
const PDIST = new Float32Array(PW * PH);
for (let y = 0, i = 0; y < PH; y++)
  for (let x = 0; x < PW; x++, i++)
    PDIST[i] = Math.sqrt((x - 40) * (x - 40) + (y - 23) * (y - 23));

export function plasmaCanvas(t) {
  const d = pimg.data;
  const t1 = t * 0.7, t2 = t * 0.41, t3 = t * 0.93;
  let i = 0, j = 0;
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++, j++) {
      const v = sn(x * 0.09 + t1)
        + sn(y * 0.11 - t2)
        + sn((x + y) * 0.055 + t3)
        + sn(PDIST[j] * 0.14 - t1);
      const n = (v + 4) / 8;
      d[i++] = 18 + ((n * n * 70) | 0);
      d[i++] = 4 + ((n * 34) | 0);
      d[i++] = 46 + ((n * n * 150) | 0);
      d[i++] = 255;
    }
  }
  pctx.putImageData(pimg, 0, 0);
  return pcv;
}

/* ------------------------------------------------------------ copper bars */
export function drawCopper(g, t, y0, h) {
  g.save();
  g.beginPath(); g.rect(0, y0, VW, h); g.clip();
  for (let i = 0; i < 10; i++) {
    const yy = y0 + h / 2 + Math.sin(t * 1.1 + i * 0.55) * (h * 0.42) - 6;
    const hue = (t * 40 + i * 26) % 360;
    const gr = g.createLinearGradient(0, yy - 7, 0, yy + 7);
    gr.addColorStop(0, `hsla(${hue},100%,50%,0)`);
    gr.addColorStop(.5, `hsla(${hue},100%,66%,.55)`);
    gr.addColorStop(1, `hsla(${hue},100%,50%,0)`);
    g.fillStyle = gr;
    g.fillRect(0, yy - 7, VW, 14);
  }
  g.restore();
}

/* --------------------------------------------------------- vector objects */
const CUBE_V = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
const CUBE_E = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
const OCT_V = [[0,-1.35,0],[1.35,0,0],[0,0,1.35],[-1.35,0,0],[0,0,-1.35],[0,1.35,0]];
const OCT_E = [[0,1],[0,2],[0,3],[0,4],[5,1],[5,2],[5,3],[5,4],[1,2],[2,3],[3,4],[4,1]];

function project(V, cx, cy, sc, ax, ay, az) {
  const ca = Math.cos(ax), sa = Math.sin(ax);
  const cb = Math.cos(ay), sb = Math.sin(ay);
  const cg = Math.cos(az), sg = Math.sin(az);
  return V.map(([x, y, z]) => {
    const y1 = y * ca - z * sa;
    let z1 = y * sa + z * ca;
    const x1 = x * cb + z1 * sb;
    z1 = -x * sb + z1 * cb;
    const x2 = x1 * cg - y1 * sg, y2 = x1 * sg + y1 * cg;
    const p = 3.4 / (3.4 + z1);
    return [cx + x2 * sc * p, cy + y2 * sc * p, p];
  });
}

export function drawWire(g, cx, cy, sc, t, hue) {
  const draw = (P, E, hu, lw) => {
    for (const [a, b] of E) {
      const p = P[a], q = P[b], d = (p[2] + q[2]) / 2;
      g.strokeStyle = `hsla(${hu},100%,${40 + d * 34}%,${0.25 + d * 0.7})`;
      g.lineWidth = lw * d;
      g.beginPath(); g.moveTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.stroke();
    }
    for (const p of P) {
      g.fillStyle = `hsla(${hu},100%,85%,${p[2] * .8})`;
      g.fillRect(p[0] - 1.5, p[1] - 1.5, 3, 3);
    }
  };
  g.globalCompositeOperation = 'lighter';
  draw(project(CUBE_V, cx, cy, sc, t * 0.7, t * 0.95, t * 0.4), CUBE_E, hue, 1.8);
  draw(project(OCT_V, cx, cy, sc, -t * 0.5, t * 1.3, t * 0.25), OCT_E, (hue + 160) % 360, 1.2);
  g.globalCompositeOperation = 'source-over';
}
