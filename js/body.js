// Body measurements from a person-segmentation mask plus pose landmarks, and the
// body-fat estimates built on them.
//
// A front view gives each body part's width and a side view gives its depth. Your
// entered height sets the scale (cm per pixel). Circumferences treat each cross-section
// as an ellipse. Everything is in mask pixels until it's converted to cm.

export const LM = {
  NOSE: 0, L_EYE: 2, R_EYE: 5, L_EAR: 7, R_EAR: 8, MOUTH_L: 9, MOUTH_R: 10,
  L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30, L_TOE: 31, R_TOE: 32,
};

// Torso levels as a fraction of the way from the shoulder joints (0) to the hip joints (1).
export const TORSO_FRACS = Array.from({ length: 141 }, (_, i) => Math.round((-0.05 + i * 0.01) * 100) / 100);
// Neck levels as a fraction of the way from the mouth (0) to the shoulder joints (1).
export const NECK_FRACS = Array.from({ length: 61 }, (_, i) => Math.round((0.3 + i * 0.01) * 100) / 100);
const LIMB_FRACS = {
  upperArm: [0.35, 0.7],
  forearm: [0.1, 0.45],
  thigh: [0.2, 0.55],
  calf: [0.1, 0.5],
};
const LIMBS = {
  upperArmL: [11, 13, 'upperArm'], upperArmR: [12, 14, 'upperArm'],
  forearmL: [13, 15, 'forearm'], forearmR: [14, 16, 'forearm'],
  thighL: [23, 25, 'thigh'], thighR: [24, 26, 'thigh'],
  calfL: [25, 27, 'calf'], calfR: [26, 28, 'calf'],
};

const EDGE = 0.5; // mask confidence treated as the body's edge

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const median = (xs) => {
  const v = xs.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const range = (lo, hi, fracs = TORSO_FRACS) => fracs.map((f, i) => (f >= lo - 1e-9 && f <= hi + 1e-9 ? i : -1)).filter((i) => i >= 0);

export function ellipseCircumference(width, depth) {
  const a = width / 2, b = depth / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b))); // Ramanujan
}

// ---------- Mask sampling ----------

function sample(m, x, y) {
  const { width: w, height: h, data } = m;
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
  const x0 = x | 0, y0 = y | 0, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const top = data[y0 * w + x0] * (1 - fx) + data[y0 * w + x1] * fx;
  const bot = data[y1 * w + x0] * (1 - fx) + data[y1 * w + x1] * fx;
  return top * (1 - fy) + bot * fy;
}

// Distance from p along a unit direction to the body's edge, interpolated to sub-pixel.
// A cap stops the walk early (e.g. where an arm touches the torso) and marks it capped.
function reach(m, p, dir, cap) {
  const limit = Math.max(0, Math.min(cap, m.width + m.height));
  let prev = sample(m, p.x, p.y);
  for (let t = 1; t <= limit; t++) {
    const v = sample(m, p.x + dir.x * t, p.y + dir.y * t);
    if (v < EDGE) return { d: t - 1 + (prev - EDGE) / (prev - v || 1), capped: false };
    prev = v;
  }
  return { d: limit, capped: Number.isFinite(cap) };
}

// The body's extent through p along dir. Returns null if p isn't on the body (after
// looking up to maxShift px either way along dir).
function span(m, p, dir, { capNeg = Infinity, capPos = Infinity, maxShift = 0 } = {}) {
  let c = null;
  for (let s = 0; s <= maxShift && !c; s++) {
    for (const sg of s ? [1, -1] : [1]) {
      const q = { x: p.x + dir.x * s * sg, y: p.y + dir.y * s * sg };
      if (sample(m, q.x, q.y) >= EDGE) {
        c = q;
        break;
      }
    }
  }
  if (!c) return null;
  const shift = (c.x - p.x) * dir.x + (c.y - p.y) * dir.y;
  const f = reach(m, c, dir, capPos - shift);
  const b = reach(m, c, { x: -dir.x, y: -dir.y }, capNeg + shift);
  return {
    len: f.d + b.d,
    a: { x: c.x - dir.x * b.d, y: c.y - dir.y * b.d },
    b: { x: c.x + dir.x * f.d, y: c.y + dir.y * f.d },
    capped: f.capped || b.capped,
  };
}

// Top of the head and bottom of the feet, in mask rows.
export function extent(m, px) {
  const feet = [27, 28, 29, 30, 31, 32].map((i) => px[i]);
  const footY = Math.max(...feet.map((p) => p.y));
  const bodyH = Math.max(1, footY - px[0].y);
  const rowHas = (y, x0, x1) => {
    const off = y * m.width;
    for (let x = Math.max(0, x0 | 0); x <= Math.min(m.width - 1, x1 | 0); x++) if (m.data[off + x] >= EDGE) return true;
    return false;
  };
  const hx0 = px[0].x - 0.12 * bodyH, hx1 = px[0].x + 0.12 * bodyH;
  let top = -1;
  for (let y = 0; y < px[0].y && top < 0; y++) if (rowHas(y, hx0, hx1)) top = y;
  const fx0 = Math.min(...feet.map((p) => p.x)) - 0.05 * bodyH, fx1 = Math.max(...feet.map((p) => p.x)) + 0.05 * bodyH;
  let bottom = -1;
  for (let y = m.height - 1; y > footY - 0.1 * bodyH && bottom < 0; y--) if (rowHas(y, fx0, fx1)) bottom = y + 1;
  if (top < 0 || bottom < 0) return null;
  // Shadows and the floor can bleed into the mask below the feet.
  bottom = Math.min(bottom, footY + 0.03 * bodyH);
  return { top, bottom, px: bottom - top, clippedTop: top <= 1, clippedBottom: bottom >= m.height - 2 };
}

// ---------- One view ----------

// Measures one frame. `view` is 'front' or 'side'. Landmarks are normalized (0..1).
export function measureView(lms, m, view) {
  const px = lms.map((l) => ({ x: l.x * m.width, y: l.y * m.height, v: l.visibility ?? l.v ?? 1 }));
  const ext = extent(m, px);
  if (!ext) return null;
  const S = mid(px[11], px[12]), Hp = mid(px[23], px[24]), M = mid(px[9], px[10]);
  const T = Math.max(1, Hp.y - S.y);
  const across = { x: 1, y: 0 };

  // Where an arm crosses a given row: along shoulder→elbow→wrist.
  const armX = ([s, e, w], y) => {
    for (const [a, b] of [[px[s], px[e]], [px[e], px[w]]]) {
      if ((y - a.y) * (y - b.y) <= 0 && a.y !== b.y) return a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y);
    }
    return null;
  };
  const armR = 0.09 * T; // about half an upper arm's width

  const torso = TORSO_FRACS.map((f) => {
    const c = { x: S.x + (Hp.x - S.x) * f, y: S.y + T * f };
    let capNeg = Infinity, capPos = Infinity;
    if (view === 'front') {
      for (const arm of [[11, 13, 15], [12, 14, 16]]) {
        const x = armX(arm, c.y);
        if (x === null) continue;
        const d = Math.max(0, Math.abs(x - c.x) - armR);
        if (x > c.x) capPos = Math.min(capPos, d);
        else capNeg = Math.min(capNeg, d);
      }
    }
    // Below the hips, a gap at the centre means the legs have split.
    const maxShift = view === 'front' && f > 0.85 ? 0 : Math.round(0.05 * T);
    return span(m, c, across, { capNeg, capPos, maxShift });
  });

  const neck = NECK_FRACS.map((g) => span(m, lerp(M, S, g), across, { maxShift: Math.round(0.03 * T) }));

  // Crotch: first row below the hips where the centre line leaves the body.
  let crotchY = null;
  if (view === 'front') {
    for (let y = Hp.y; y < ext.bottom; y++) {
      if (sample(m, Hp.x, y) < EDGE) {
        crotchY = y;
        break;
      }
    }
  }

  // Limbs: widths perpendicular to the bone. In the front view, walks toward the body's
  // midline stop there so touching thighs aren't counted twice.
  const midX = Hp.x;
  const limbs = {};
  const sideLeg = view === 'side' ? (px[25].v + px[27].v >= px[26].v + px[28].v ? 'L' : 'R') : null;
  for (const [name, [ai, bi, kind]] of Object.entries(LIMBS)) {
    const isLeg = kind === 'thigh' || kind === 'calf';
    if (view === 'side' && (!isLeg || !name.endsWith(sideLeg))) continue;
    const a = px[ai], b = px[bi];
    const len = dist(a, b);
    if (len < 4) continue;
    const dir = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    const [lo, hi] = LIMB_FRACS[kind];
    limbs[name] = [];
    for (let f = lo; f <= hi + 1e-9; f += 0.025) {
      const c = lerp(a, b, f);
      const opts = { maxShift: Math.round(0.03 * T) };
      if (view === 'front' && isLeg && Math.abs(dir.x) > 0.2) {
        const toMid = (midX - c.x) / dir.x;
        if (toMid > 0) opts.capPos = toMid;
        else opts.capNeg = -toMid;
      }
      const s = span(m, c, dir, opts);
      limbs[name].push(s && { ...s, f });
    }
  }

  const armLen = (dist(px[11], px[13]) + dist(px[13], px[15]) + dist(px[12], px[14]) + dist(px[14], px[16])) / 2;
  return { view, ext, px, S, Hp, M, T, torso, neck, crotchY, limbs, armLen, sideLeg };
}

// Combines several frames of the same view: medians of every measurement, with the last
// frame kept for drawing.
export function mergeFrames(frames) {
  const ok = frames.filter(Boolean);
  if (!ok.length) return null;
  const rep = ok.at(-1);
  const at = (get) => median(ok.map(get));
  const limbs = {};
  for (const name of Object.keys(rep.limbs)) {
    limbs[name] = rep.limbs[name].map((_, i) => at((v) => v.limbs[name]?.[i]?.len ?? null));
  }
  return {
    view: rep.view,
    rep,
    bodyPx: at((v) => v.ext.px),
    bottom: at((v) => v.ext.bottom),
    torso: TORSO_FRACS.map((_, i) => at((v) => v.torso[i]?.len ?? null)),
    capped: TORSO_FRACS.map((_, i) => ok.filter((v) => v.torso[i]?.capped).length > ok.length / 2),
    neck: NECK_FRACS.map((_, i) => at((v) => v.neck[i]?.len ?? null)),
    crotchPx: at((v) => (v.crotchY === null ? null : v.ext.bottom - v.crotchY)),
    armLen: at((v) => v.armLen),
    limbs,
  };
}

// ---------- Both views → measurements ----------

export const MEASURES = [
  { id: 'neck', name: 'Neck', kind: 'circ' },
  { id: 'shoulders', name: 'Shoulders', kind: 'width' },
  { id: 'chest', name: 'Chest', kind: 'circ' },
  { id: 'waistNatural', name: 'Waist (narrowest)', kind: 'circ' },
  { id: 'waist', name: 'Waist (at navel)', kind: 'circ' },
  { id: 'hips', name: 'Hips', kind: 'circ' },
  { id: 'thigh', name: 'Thigh', kind: 'circ' },
  { id: 'calf', name: 'Calf', kind: 'circ' },
  { id: 'upperArm', name: 'Upper arm', kind: 'circ' },
  { id: 'forearm', name: 'Forearm', kind: 'circ' },
  { id: 'inseam', name: 'Inseam', kind: 'length' },
  { id: 'armLength', name: 'Arm length', kind: 'length' },
];

// front/side are mergeFrames() results. `calibration` scales circumferences, from a
// tape-measured waist.
export function computeMeasurements(front, side, heightCm, calibration = 1) {
  const kF = heightCm / front.bodyPx, kS = heightCm / side.bodyPx;
  const values = {}, where = {};
  const circ = (w, d) => ellipseCircumference(w, d) * calibration;

  // Neck: narrowest in both views.
  const neckW = Math.min(...front.neck.filter((x) => x !== null));
  const neckD = Math.min(...side.neck.filter((x) => x !== null));
  values.neck = circ(neckW * kF, neckD * kS);
  where.neck = { front: front.neck.indexOf(neckW), side: side.neck.indexOf(neckD) };

  const torsoCirc = (i) =>
    front.torso[i] === null || side.torso[i] === null ? null : circ(front.torso[i] * kF, side.torso[i] * kS);
  const pick = (idxs, better) => {
    let best = null;
    for (const i of idxs) {
      const c = torsoCirc(i);
      if (c !== null && (best === null || better(c, best.c))) best = { i, c };
    }
    return best;
  };

  // Shoulders: straight width across the deltoids.
  const sh = range(-0.02, 0.04).map((i) => front.torso[i]).filter((x) => x !== null);
  values.shoulders = sh.length ? Math.max(...sh) * kF : null;
  where.shoulders = { i: range(-0.02, 0.04).find((i) => front.torso[i] === Math.max(...sh)) };

  const chest = pick(range(0.15, 0.35), (a, b) => a > b);
  values.chest = chest?.c ?? null;
  where.chest = chest && { i: chest.i };

  // Natural waist: the narrowest point in the front view.
  let wi = null;
  for (const i of range(0.45, 0.85)) if (front.torso[i] !== null && (wi === null || front.torso[i] < front.torso[wi])) wi = i;
  values.waistNatural = wi === null ? null : torsoCirc(wi);
  where.waistNatural = { i: wi };

  // Navel: about a quarter of the way up from the hip joints to the shoulders.
  const navel = range(0.72, 0.76).map(torsoCirc).filter((x) => x !== null);
  values.waist = navel.length ? navel.reduce((a, b) => a + b, 0) / navel.length : null;
  where.waist = { i: range(0.74, 0.74)[0] };

  // Hips: widest point above where the legs split.
  const hipIdx = [];
  for (const i of range(0.85, 1.3)) {
    if (front.torso[i] === null) break;
    hipIdx.push(i);
  }
  const hips = pick(hipIdx, (a, b) => a > b);
  values.hips = hips?.c ?? null;
  where.hips = hips && { i: hips.i };

  // Legs: fullest point, front width with side depth. Side depth is capped because
  // overlapping legs in a side view can read deeper than one leg really is.
  const leg = (kind) => {
    const res = [];
    for (const s of ['L', 'R']) {
      const w = front.limbs[kind + s];
      if (!w) continue;
      let bi = -1;
      w.forEach((x, i) => { if (x !== null && (bi < 0 || x > w[bi])) bi = i; });
      if (bi < 0) continue;
      const d = side.limbs[kind + side.rep.sideLeg]?.[bi] ?? null;
      const wCm = w[bi] * kF;
      const dCm = d === null ? wCm : Math.min(d * kS, 1.35 * wCm);
      res.push({ side: s, i: bi, c: circ(wCm, dCm) });
    }
    return res;
  };
  for (const kind of ['thigh', 'calf']) {
    const r = leg(kind);
    values[kind] = r.length ? r.reduce((a, b) => a + b.c, 0) / r.length : null;
    where[kind] = r;
  }

  // Arms: round enough to use the front width alone.
  for (const kind of ['upperArm', 'forearm']) {
    const r = [];
    for (const s of ['L', 'R']) {
      const w = front.limbs[kind + s];
      if (!w) continue;
      let bi = -1;
      w.forEach((x, i) => { if (x !== null && (bi < 0 || x > w[bi])) bi = i; });
      if (bi >= 0) r.push({ side: s, i: bi, c: Math.PI * w[bi] * kF * calibration });
    }
    values[kind] = r.length ? r.reduce((a, b) => a + b.c, 0) / r.length : null;
    where[kind] = r;
  }

  values.inseam = front.crotchPx === null ? null : front.crotchPx * kF;
  values.armLength = front.armLen * kF;

  // Arm contact at chest or waist level makes those widths unreliable.
  const contact = ['chest', 'waistNatural', 'waist'].filter((k) => where[k]?.i != null && front.capped[where[k].i]);
  return { values, where, contact, scale: { front: kF, side: kS } };
}

// ---------- Body fat ----------

const log10 = Math.log10;

// Hodgdon & Beckett (1984), the US Navy circumference method. All values in cm.
export function navyBodyFat(sex, heightCm, neck, waist, hips) {
  if (sex === 'male') {
    if (!(waist > neck)) return null;
    return 495 / (1.0324 - 0.19077 * log10(waist - neck) + 0.15456 * log10(heightCm)) - 450;
  }
  if (!(waist + hips > neck)) return null;
  return 495 / (1.29579 - 0.35004 * log10(waist + hips - neck) + 0.221 * log10(heightCm)) - 450;
}

// Relative fat mass, Woolcott & Bergman (2018).
export const relativeFatMass = (sex, heightCm, waist) => (sex === 'male' ? 64 : 76) - 20 * (heightCm / waist);

// Deurenberg et al. (1991), from BMI, age and sex.
export const bmiBodyFat = (sex, bmi, age) => 1.2 * bmi + 0.23 * age - 10.8 * (sex === 'male' ? 1 : 0) - 5.4;

// American Council on Exercise ranges.
const BF_BANDS = {
  male: [['Essential', 2], ['Athletic', 6], ['Fit', 14], ['Average', 18], ['High', 25]],
  female: [['Essential', 10], ['Athletic', 14], ['Fit', 21], ['Average', 25], ['High', 32]],
};
export const bodyFatBands = (sex) => BF_BANDS[sex] ?? BF_BANDS.male;
export function bodyFatBand(sex, bf) {
  const bands = bodyFatBands(sex);
  let name = bands[0][0];
  for (const [n, from] of bands) if (bf >= from) name = n;
  return name;
}

export function bmiBand(bmi) {
  if (bmi < 18.5) return 'Underweight';
  if (bmi < 25) return 'Healthy range';
  if (bmi < 30) return 'Overweight';
  return 'Obese range';
}

export function whtrBand(r) {
  if (r < 0.4) return 'Low';
  if (r < 0.5) return 'Healthy';
  if (r < 0.6) return 'Increased risk';
  return 'High risk';
}

export function report(profile, values) {
  const { sex, age, heightCm, weightKg } = profile;
  const h = heightCm / 100;
  const bmi = weightKg / (h * h);
  const methods = [
    {
      id: 'navy',
      name: 'US Navy tape method',
      detail: sex === 'male' ? 'From your neck and waist' : 'From your neck, waist and hips',
      value: navyBodyFat(sex, heightCm, values.neck, sex === 'male' ? values.waist : values.waistNatural, values.hips),
      weight: 0.5,
    },
    {
      id: 'rfm',
      name: 'Relative fat mass',
      detail: 'From your height and waist',
      value: values.waist ? relativeFatMass(sex, heightCm, values.waist) : null,
      weight: 0.3,
    },
    {
      id: 'bmi',
      name: 'BMI-based estimate',
      detail: 'From your weight, height, age and sex',
      value: bmiBodyFat(sex, bmi, age),
      weight: 0.2,
    },
  ].map((m) => ({ ...m, value: Number.isFinite(m.value) && m.value > 1 && m.value < 70 ? m.value : null }));

  const valid = methods.filter((m) => m.value !== null);
  const wsum = valid.reduce((a, m) => a + m.weight, 0);
  const bf = valid.length ? valid.reduce((a, m) => a + m.value * m.weight, 0) / wsum : null;
  const vals = valid.map((m) => m.value);
  // Circumference methods land within about ±3.5 points of a DEXA scan; widen for disagreement.
  const low = bf === null ? null : Math.max(2, Math.min(bf - 3.5, ...vals));
  const high = bf === null ? null : Math.max(bf + 3.5, ...vals);

  const fatKg = bf === null ? null : (weightKg * bf) / 100;
  const leanKg = fatKg === null ? null : weightKg - fatKg;
  const ffmi = leanKg === null ? null : leanKg / (h * h);
  return {
    bf, low, high, methods,
    band: bf === null ? null : bodyFatBand(sex, bf),
    bmi, bmiBand: bmiBand(bmi),
    fatKg, leanKg, ffmi,
    ffmiNorm: ffmi === null ? null : ffmi + 6.1 * (1.8 - h),
    whtr: values.waist ? values.waist / heightCm : null,
    whr: values.waist && values.hips ? values.waist / values.hips : null,
  };
}

// ---------- Pose checks during a scan ----------

const angleFromDown = (a, b) => (Math.atan2(Math.abs(b.x - a.x), b.y - a.y) * 180) / Math.PI;

// Returns the checklist for the current step; `hint` is the first thing to fix.
export function checkPose(lms, m, view) {
  const W = m?.width ?? 1, H = m?.height ?? 1;
  const px = lms.map((l) => ({ x: l.x * W, y: l.y * H, v: l.visibility ?? l.v ?? 1 }));
  const S = mid(px[11], px[12]), Hp = mid(px[23], px[24]);
  const T = Math.max(1, Hp.y - S.y);
  const key = [0, 11, 12, 23, 24, 27, 28];
  const ext = m ? extent(m, px) : null;
  const inFrame = key.every((i) => lms[i].x > 0.01 && lms[i].x < 0.99 && lms[i].y > 0.01 && lms[i].y < 0.99)
    && !!ext && !ext.clippedTop && !ext.clippedBottom;
  const bigEnough = !!ext && ext.px > 0.5 * H;
  const shoulderSpread = Math.abs(px[11].x - px[12].x) / T;
  const hipSpread = Math.abs(px[23].x - px[24].x) / T;
  const tilt = (Math.atan2(Math.abs(S.x - Hp.x), T) * 180) / Math.PI;

  const checks = [
    { id: 'frame', ok: inFrame, label: 'Whole body in frame', hint: 'Step back until your head and feet are both in frame' },
    { id: 'size', ok: !inFrame || bigEnough, label: 'Close enough', hint: 'Come a little closer to the camera' },
  ];
  if (view === 'front') {
    const armL = angleFromDown(px[11], px[15]), armR = angleFromDown(px[12], px[16]);
    checks.push(
      { id: 'facing', ok: shoulderSpread > 0.5 && hipSpread > 0.25, label: 'Facing the camera', hint: 'Turn to face the camera' },
      {
        id: 'arms', ok: armL > 20 && armR > 20 && armL < 70 && armR < 70,
        label: 'Arms out in an A', hint: armL >= 70 || armR >= 70 ? 'Lower your arms a little' : 'Hold your arms out and away from your body',
      },
    );
  } else {
    const wrists = [px[15], px[16]].filter((p) => p.v > 0.5);
    checks.push(
      { id: 'facing', ok: shoulderSpread < 0.22 && hipSpread < 0.22, label: 'Side-on to the camera', hint: 'Turn 90° so your side faces the camera' },
      {
        id: 'arms', ok: wrists.length > 0 && wrists.every((w) => w.y > S.y + 0.6 * T && Math.abs(w.x - Hp.x) < 0.35 * T),
        label: 'Arms relaxed at your sides', hint: 'Let your arms hang straight down by your sides',
      },
    );
  }
  checks.push({ id: 'upright', ok: tilt < 8, label: 'Standing tall', hint: 'Stand up straight' });
  const failing = checks.find((c) => !c.ok);
  return { ok: !failing, checks, hint: failing?.hint ?? null };
}
