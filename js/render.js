// Drawing: the silhouette body mesh, skeleton, face mesh, hands, and the tailor's-tape
// measuring marks. Points are mirrored here rather than with a canvas transform so
// text stays readable.
import { CONNECTIONS } from './vision.js';

export const C = {
  chalk: '#F1F3EC',
  tape: '#F5C73B',
  tapeInk: '#2A2106',
  blue: '#7CC0FF',
  red: '#FF6B5B',
  ink: '#0D1C18',
};

const TEXT = '"Archivo", system-ui, sans-serif';

export const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export const mapper = (W, H, mirror) => (p) => ({ x: (mirror ? 1 - p.x : p.x) * W, y: p.y * H });
export const mapPx = (W, mirror) => (p) => ({ x: mirror ? W - p.x : p.x, y: p.y });

function line(ctx, a, b) {
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
}

// ---------- Labels ----------

// Text in a capsule. With `placed`, the label moves up or down until it clears the others.
export function pill(ctx, text, x, y, u, opts = {}, placed = null) {
  const { align = 'left', color = C.chalk, bg = 'rgba(13, 28, 24, 0.82)', size = 14, weight = 600, outline = null } = opts;
  ctx.font = `${weight} ${size * u}px ${TEXT}`;
  const w = ctx.measureText(text).width, padX = 8 * u, h = size * u * 1.75;
  let left = align === 'left' ? x : align === 'right' ? x - w - padX * 2 : x - w / 2 - padX;
  // Keep it on the visible canvas, allowing for a translated context.
  const m = ctx.getTransform();
  const minX = -m.e / m.a, maxX = (ctx.canvas.width - m.e) / m.a;
  left = Math.max(minX + 2 * u, Math.min(maxX - w - padX * 2 - 2 * u, left));
  const rect = { x: left, y: y - h / 2, w: w + padX * 2, h };
  if (placed) {
    const hits = (r) => placed.some((p) => r.x < p.x + p.w && p.x < r.x + r.w && r.y < p.y + p.h && p.y < r.y + r.h);
    for (let i = 1; hits(rect) && i <= 8; i++) rect.y = y - h / 2 + Math.ceil(i / 2) * (h + 3 * u) * (i % 2 ? 1 : -1);
    placed.push(rect);
  }
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 4 * u);
  ctx.fill();
  if (outline) {
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.5 * u;
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, rect.x + padX, rect.y + h / 2 + 0.5 * u);
  return rect;
}

// ---------- Silhouette mesh ----------

// Horizontal runs of the body mask, one scanline every `step` canvas px.
export function bodyRows(mask, W, H, mirror, step) {
  const sx = mask.width / W, sy = mask.height / H;
  const stride = Math.max(1, Math.round(mask.width / 480));
  const minRun = 3 * stride;
  const rows = [];
  for (let y = step / 2; y < H; y += step) {
    const off = Math.min(mask.height - 1, Math.floor(y * sy)) * mask.width;
    const runs = [];
    let start = -1;
    for (let mx = 0; mx < mask.width; mx += stride) {
      const inside = mask.data[off + mx] >= 0.5;
      if (inside && start < 0) start = mx;
      else if (!inside && start >= 0) {
        if (mx - start >= minRun) runs.push([start / sx, mx / sx]);
        start = -1;
      }
    }
    if (start >= 0 && mask.width - start >= minRun) runs.push([start / sx, mask.width / sx]);
    rows.push({ y, runs: mirror ? runs.map(([a, b]) => [W - b, W - a]).reverse() : runs });
  }
  return rows;
}

const MERIDIANS = [-1.15, -0.6, 0, 0.6, 1.15]; // azimuths around each cross-section, radians

// Contour rings around every cross-section, meridians running down the body, and a
// glowing outline, so the silhouette reads as a 3D wireframe.
export function drawBodyMesh(ctx, rows, { u, step, scanY = null, alpha = 1 }) {
  const ringY = (rx) => Math.min(rx * 0.22, step * 0.9);
  const point = (run, y, phi) => {
    const cx = (run[0] + run[1]) / 2, rx = (run[1] - run[0]) / 2;
    return { x: cx + rx * Math.sin(phi), y: y + ringY(rx) * Math.cos(phi) };
  };
  const overlap = (a, b) => Math.min(a[1], b[1]) - Math.max(a[0], b[0]);

  ctx.save();
  ctx.lineCap = 'round';

  // Rings.
  const hot = [];
  ctx.beginPath();
  for (const row of rows) {
    const near = scanY !== null && Math.abs(row.y - scanY) < step * 2.5;
    for (const r of row.runs) {
      const cx = (r[0] + r[1]) / 2, rx = (r[1] - r[0]) / 2;
      if (near) {
        hot.push([row, r]);
        continue;
      }
      ctx.moveTo(cx + rx, row.y);
      ctx.ellipse(cx, row.y, rx, ringY(rx), 0, 0, Math.PI);
    }
  }
  ctx.strokeStyle = rgba(C.chalk, 0.3 * alpha);
  ctx.lineWidth = 1 * u;
  ctx.stroke();

  // Meridians, linking each run to the one it overlaps most in the row above.
  ctx.beginPath();
  const outline = [];
  for (let i = 1; i < rows.length; i++) {
    for (const r of rows[i].runs) {
      let best = null, bestO = 0;
      for (const p of rows[i - 1].runs) {
        const o = overlap(p, r);
        if (o > bestO) {
          best = p;
          bestO = o;
        }
      }
      if (!best) continue;
      for (const phi of MERIDIANS) line(ctx, point(best, rows[i - 1].y, phi), point(r, rows[i].y, phi));
      outline.push([{ x: best[0], y: rows[i - 1].y }, { x: r[0], y: rows[i].y }], [{ x: best[1], y: rows[i - 1].y }, { x: r[1], y: rows[i].y }]);
    }
  }
  ctx.strokeStyle = rgba(C.chalk, 0.16 * alpha);
  ctx.lineWidth = 1 * u;
  ctx.stroke();

  // Outline with a cool glow.
  ctx.beginPath();
  for (const [a, b] of outline) line(ctx, a, b);
  ctx.shadowColor = rgba(C.blue, 0.9 * alpha);
  ctx.shadowBlur = 10 * u;
  ctx.strokeStyle = rgba(C.blue, 0.75 * alpha);
  ctx.lineWidth = 1.8 * u;
  ctx.stroke();

  // The scan band.
  if (hot.length) {
    ctx.shadowColor = C.tape;
    ctx.shadowBlur = 14 * u;
    for (const [row, r] of hot) {
      const k = 1 - Math.abs(row.y - scanY) / (step * 2.5);
      const cx = (r[0] + r[1]) / 2, rx = (r[1] - r[0]) / 2;
      ctx.strokeStyle = rgba(C.tape, 0.35 + 0.65 * k);
      ctx.lineWidth = (1.2 + 2 * k) * u;
      ctx.beginPath();
      ctx.ellipse(cx, row.y, rx, ringY(rx), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ---------- Skeleton, face, hands ----------

export function drawSkeleton(ctx, lms, W, H, mirror, u, alpha = 1) {
  const P = mapper(W, H, mirror);
  const pts = lms.map(P);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [a, b] of CONNECTIONS.pose) if (a > 10 && b > 10) line(ctx, pts[a], pts[b]);
  ctx.strokeStyle = `rgba(0, 0, 0, ${0.35 * alpha})`;
  ctx.lineWidth = 5 * u;
  ctx.stroke();
  ctx.strokeStyle = rgba(C.chalk, 0.9 * alpha);
  ctx.lineWidth = 2.5 * u;
  ctx.stroke();
  for (let i = 11; i < 33; i++) {
    if (i >= 17 && i <= 22) continue; // finger stubs; the hand model draws those
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, 3.5 * u, 0, Math.PI * 2);
    ctx.fillStyle = rgba(C.ink, alpha);
    ctx.fill();
    ctx.strokeStyle = rgba(C.chalk, 0.95 * alpha);
    ctx.lineWidth = 1.6 * u;
    ctx.stroke();
  }
  ctx.restore();
}

export function drawFace(ctx, face, P, u, { dense = true } = {}) {
  const pts = face.map(P);
  ctx.save();
  if (dense) {
    ctx.beginPath();
    for (const [a, b] of CONNECTIONS.faceMesh) line(ctx, pts[a], pts[b]);
    ctx.strokeStyle = rgba(C.chalk, 0.28);
    ctx.lineWidth = 0.6 * u;
    ctx.stroke();
  }
  ctx.beginPath();
  for (const [a, b] of CONNECTIONS.faceFeatures) line(ctx, pts[a], pts[b]);
  ctx.strokeStyle = rgba(C.blue, 0.95);
  ctx.lineWidth = 1.3 * u;
  ctx.shadowColor = C.blue;
  ctx.shadowBlur = 6 * u;
  ctx.stroke();
  if (pts.length > 473) {
    ctx.beginPath();
    for (const [a, b] of CONNECTIONS.irises) line(ctx, pts[a], pts[b]);
    ctx.strokeStyle = C.tape;
    ctx.shadowColor = C.tape;
    ctx.stroke();
  }
  ctx.restore();
}

const FINGERTIPS = [4, 8, 12, 16, 20];

export function drawHand(ctx, hand, P, u) {
  const pts = hand.map(P);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [a, b] of CONNECTIONS.hand) line(ctx, pts[a], pts[b]);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.lineWidth = 4 * u;
  ctx.stroke();
  ctx.strokeStyle = rgba(C.chalk, 0.95);
  ctx.lineWidth = 2 * u;
  ctx.stroke();
  pts.forEach((p, i) => {
    const tip = FINGERTIPS.includes(i);
    ctx.beginPath();
    ctx.arc(p.x, p.y, (tip ? 3.4 : 2.4) * u, 0, Math.PI * 2);
    ctx.fillStyle = tip ? C.tape : C.ink;
    ctx.shadowColor = tip ? C.tape : 'transparent';
    ctx.shadowBlur = tip ? 8 * u : 0;
    ctx.fill();
    if (!tip) {
      ctx.strokeStyle = C.chalk;
      ctx.lineWidth = 1.2 * u;
      ctx.stroke();
    }
  });
  ctx.restore();
}

// ---------- Tape measure ----------

// A tailor's tape standing beside the body, from the floor to the top of the head.
// `top`/`bottom` are canvas rows; `x` is its left edge.
export function drawHeightTape(ctx, { x, top, bottom, heightCm, imperial, u, label }) {
  const pxPerCm = (bottom - top) / heightCm;
  const w = 20 * u;
  ctx.save();
  ctx.fillStyle = rgba(C.tape, 0.92);
  ctx.beginPath();
  ctx.roundRect(x, top, w, bottom - top, 2 * u);
  ctx.fill();

  const unit = imperial ? 2.54 : 1;
  const total = heightCm / unit;
  const minor = pxPerCm * unit >= 3 * u ? 1 : imperial ? 1 : 5;
  ctx.strokeStyle = C.tapeInk;
  ctx.fillStyle = C.tapeInk;
  ctx.font = `700 ${8.5 * u}px ${TEXT}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.beginPath();
  for (let v = 0; v <= total + 1e-6; v += minor) {
    const y = bottom - v * unit * pxPerCm;
    const major = imperial ? v % 12 === 0 : v % 10 === 0;
    const mid = imperial ? v % 6 === 0 : v % 5 === 0;
    const len = major ? 0.55 * w : mid ? 0.4 * w : 0.22 * w;
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y);
  }
  ctx.lineWidth = 0.9 * u;
  ctx.stroke();
  const labelEvery = imperial ? 12 : 20;
  for (let v = labelEvery; v < total - labelEvery / 3; v += labelEvery) {
    const y = bottom - v * unit * pxPerCm;
    ctx.fillStyle = (imperial ? v % 24 === 0 : v % 100 === 0) ? '#B3261E' : C.tapeInk;
    ctx.fillText(imperial ? `${v / 12}′` : String(v), x + w - 2 * u, y);
  }
  ctx.restore();
  pill(ctx, label, x, top - 16 * u, u, { bg: C.tape, color: C.tapeInk, weight: 700, size: 13 });
}

// A tape wrapped around the body between a and b: the front half is the tape, the back
// half is dashed.
export function drawTapeRing(ctx, a, b, u, { tilt = 0.24, width = 5 } = {}) {
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const rx = dist(a, b) / 2, ry = Math.max(2 * u, rx * tilt);
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  ctx.save();
  ctx.setLineDash([3 * u, 4 * u]);
  ctx.strokeStyle = rgba(C.tape, 0.5);
  ctx.lineWidth = 1.5 * u;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, ang, Math.PI, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = C.tape;
  ctx.lineWidth = width * u;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = 4 * u;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, ang, 0, Math.PI);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.setLineDash([0.9 * u, 3.2 * u]); // tick marks printed on the tape
  ctx.strokeStyle = C.tapeInk;
  ctx.lineWidth = (width - 2) * u;
  ctx.stroke();
  ctx.restore();
}

// A straight caliper between two points (for widths).
export function drawCaliper(ctx, a, b, u) {
  const d = dist(a, b) || 1;
  const nx = (-(b.y - a.y) / d) * 7 * u, ny = ((b.x - a.x) / d) * 7 * u;
  ctx.save();
  ctx.strokeStyle = C.tape;
  ctx.lineWidth = 2.5 * u;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = 4 * u;
  ctx.beginPath();
  line(ctx, a, b);
  line(ctx, { x: a.x - nx, y: a.y - ny }, { x: a.x + nx, y: a.y + ny });
  line(ctx, { x: b.x - nx, y: b.y - ny }, { x: b.x + nx, y: b.y + ny });
  ctx.stroke();
  ctx.restore();
}

// ---------- Detail views ----------

// Draws a zoomed crop (face or hand) with its landmarks.
export function drawDetail(canvas, detail, kind, mirror) {
  const ctx = canvas.getContext('2d');
  const S = canvas.width;
  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, S, S);
  if (!detail) return;
  ctx.save();
  if (mirror) {
    ctx.translate(S, 0);
    ctx.scale(-1, 1);
  }
  ctx.globalAlpha = 0.7;
  ctx.drawImage(detail.image, 0, 0, S, S);
  ctx.restore();
  const u = S / 220;
  const P = (p) => ({ x: (mirror ? 1 - p.x : p.x) * S, y: p.y * S });
  if (kind === 'face') drawFace(ctx, detail.local, P, u);
  else drawHand(ctx, detail.local, P, u * 1.2);
}
