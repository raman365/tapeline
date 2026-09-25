import { Vision, POSE_MODELS } from './vision.js';
import { LandmarkSmoother } from './filter.js';
import { getToken, setToken, verifyToken, readHistory, saveScans, fileUrl } from './history.js';
import {
  measureView, mergeFrames, computeMeasurements, report, checkPose, extent, MEASURES, bodyFatBands, TORSO_FRACS,
} from './body.js';
import {
  bodyRows, drawBodyMesh, drawSkeleton, drawFace, drawHand, drawHeightTape, drawTapeRing, drawCaliper, drawDetail,
  pill, mapper, mapPx, C,
} from './render.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------- Stored data ----------

const load = (key, fallback) => {
  try {
    const raw = localStorage.getItem(`tapeline:${key}`);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
const save = (key, value) => {
  try {
    localStorage.setItem(`tapeline:${key}`, JSON.stringify(value));
  } catch {
    // Storage unavailable (private browsing etc.); nothing persists.
  }
};

const settings = {
  units: 'metric', poseModel: 'full', mirror: true, voice: true, sound: true, details: true, calibration: 1,
  ...load('settings', {}),
};
const profile = { sex: null, age: null, heightCm: null, weightKg: null, ...load('profile', {}) };
const saveSettings = () => save('settings', settings);

// ---------- Units ----------

const CM_PER_IN = 2.54, LB_PER_KG = 2.20462;
const imperial = () => settings.units === 'imperial';
const fmtLen = (cm, digits = 1) => (cm == null ? '–' : imperial() ? `${(cm / CM_PER_IN).toFixed(digits)} in` : `${cm.toFixed(digits)} cm`);
const fmtMass = (kg) => (imperial() ? `${(kg * LB_PER_KG).toFixed(1)} lb` : `${kg.toFixed(1)} kg`);
function fmtHeight(cm) {
  if (!imperial()) return `${Math.round(cm)} cm`;
  const total = Math.round(cm / CM_PER_IN);
  return `${Math.floor(total / 12)}′${total % 12}″`;
}

// ---------- Sound & voice ----------

const audio = {
  ctx: null,
  unlock() {
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  },
  tone(freq, dur, { gain = 0.1, at = 0, type = 'sine' } = {}) {
    const c = this.ctx, t0 = c.currentTime + at;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  },
  shutter() {
    const c = this.ctx, len = Math.round(c.sampleRate * 0.12);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'bandpass';
    f.frequency.value = 2400;
    g.gain.value = 0.5;
    src.buffer = buf;
    src.connect(f).connect(g).connect(c.destination);
    src.start();
  },
  play(kind) {
    if (!settings.sound || !this.ctx) return;
    if (kind === 'shutter') this.shutter();
    if (kind === 'done') [523, 659, 784].forEach((f, i) => this.tone(f, 0.25, { at: i * 0.1 }));
  },
};

function speak(text) {
  if (!settings.voice || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(text), { rate: 1.02 }));
}

// ---------- State ----------

const video = $('#srcVideo');
const stage = $('#stageCanvas');
const sctx = stage.getContext('2d');
const input = document.createElement('canvas'); // the frame the models see
const ictx = input.getContext('2d');

const state = {
  vision: null,
  visionPromise: null,
  source: null,
  stream: null,
  lastVideoTime: -1,
  frameNo: 0,
  detectMs: 0,
  detailEvery: 1,
  lms: null,
  mask: null,
  face: null,
  hands: [null, null],
  ext: null,
  live: null,
  motion: [],
  smoother: new LandmarkSmoother(),
  scan: null,
  results: null,
  paused: false,
  history: [], // scans from the GitHub history file, newest first
  historyState: 'off', // off | loading | ready | error
  historyError: '',
};

const isMirrored = () => state.source === 'camera' && settings.mirror;
const setText = (el, text) => {
  if (el.textContent !== text) el.textContent = text;
};

// ---------- Profile ----------

function renderProfile() {
  $$('[data-sex]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.sex === profile.sex)));
  $('#ageInput').value = profile.age ?? '';
  $$('[data-metric]').forEach((el) => (el.hidden = imperial()));
  $$('[data-imperial]').forEach((el) => (el.hidden = !imperial()));
  if (profile.heightCm) {
    const inches = profile.heightCm / CM_PER_IN;
    $('#heightCm').value = Math.round(profile.heightCm * 2) / 2;
    $('#heightFt').value = Math.floor(inches / 12);
    $('#heightIn').value = Math.round((inches % 12) * 2) / 2;
  }
  $('#weightInput').value = profile.weightKg ? (imperial() ? (profile.weightKg * LB_PER_KG).toFixed(1) : profile.weightKg.toFixed(1)) : '';
  $('#weightUnit').textContent = imperial() ? 'lb' : 'kg';
}

function readProfile() {
  const num = (id) => (($(`#${id}`).value ?? '').trim() === '' ? null : Number($(`#${id}`).value));
  profile.age = num('ageInput');
  if (imperial()) {
    const ft = num('heightFt'), inch = num('heightIn') ?? 0;
    profile.heightCm = ft === null ? null : (ft * 12 + inch) * CM_PER_IN;
  } else {
    profile.heightCm = num('heightCm');
  }
  const w = num('weightInput');
  profile.weightKg = w === null ? null : imperial() ? w / LB_PER_KG : w;
  save('profile', profile);
  $('#profileError').hidden = true;
}

function profileProblem() {
  if (!profile.sex) return { field: '[data-sex]', text: 'Choose your sex. The body-fat formulas are different for men and women.' };
  if (!(profile.age >= 13 && profile.age <= 90)) return { field: '#ageInput', text: 'Enter your age, between 13 and 90.' };
  if (!(profile.heightCm >= 120 && profile.heightCm <= 230)) {
    return { field: imperial() ? '#heightFt' : '#heightCm', text: 'Enter your height. It sets the scale for every measurement.' };
  }
  if (!(profile.weightKg >= 30 && profile.weightKg <= 250)) return { field: '#weightInput', text: 'Enter your weight.' };
  return null;
}

function showProfileProblem() {
  const p = profileProblem();
  if (!p) return false;
  const el = $('#profileError');
  el.textContent = p.text;
  el.hidden = false;
  $(p.field)?.focus();
  return true;
}

// ---------- Tracking models ----------

function setStatus(text, kind = '') {
  const el = $('#modelStatus');
  el.textContent = text;
  el.dataset.state = kind;
}

async function loadVision() {
  setStatus('Loading body tracking…');
  state.vision?.close();
  state.vision = null;
  updateButtons();
  const pending = Vision.create(settings.poseModel);
  state.visionPromise = pending;
  try {
    const v = await pending;
    if (state.visionPromise !== pending) return v.close();
    state.vision = v;
    state.smoother.reset();
    updateButtons();
    if (!settings.details) return setStatus('Body tracking ready');
    setStatus('Body tracking ready. Loading face and hand tracking…');
    await v.loadDetails();
    if (state.vision === v) setStatus(`Body, face and hand tracking ready${v.delegate === 'CPU' ? ' (on CPU)' : ''}`);
  } catch (err) {
    console.error(err);
    if (state.visionPromise === pending) setStatus("Couldn't load tracking. Check your internet connection, then reload.", 'error');
  }
}

// ---------- Camera ----------

function cameraError(err) {
  if (!navigator.mediaDevices) return 'Camera access needs a secure page. Open Tapeline with start.command (it serves http://localhost) instead of opening the file directly.';
  if (err.name === 'NotAllowedError') return 'Camera access is blocked. Allow it for this page in your browser, and on a Mac also under System Settings › Privacy & Security › Camera.';
  if (err.name === 'NotFoundError') return 'No camera found. Connect one, or measure from photos instead.';
  if (err.name === 'NotReadableError') return 'Another app is using the camera. Close it and try again.';
  return `The camera didn't start (${err.name || err.message}).`;
}

function showEmpty(error) {
  $('#emptyState').hidden = !!state.source;
  const el = $('#emptyError');
  el.hidden = !error;
  el.textContent = error || '';
  updateButtons();
}

async function startCamera(deviceId = settings.cameraId) {
  audio.unlock();
  let stream;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('insecure');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (err) {
    if (deviceId && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) return startCamera('');
    return showEmpty(cameraError(err));
  }
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = stream;
  state.source = 'camera';
  video.srcObject = stream;
  await video.play().catch(() => {});
  settings.cameraId = stream.getVideoTracks()[0]?.getSettings().deviceId || '';
  saveSettings();
  state.smoother.reset();
  showEmpty();
  listCameras();
}

async function listCameras() {
  const select = $('#cameraSelect');
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  select.replaceChildren(...cams.map((c, i) => {
    const o = new Option(c.label || `Camera ${i + 1}`, c.deviceId);
    o.selected = c.deviceId === settings.cameraId;
    return o;
  }));
  select.hidden = state.source !== 'camera' || cams.length < 2;
}

// ---------- Frame loop ----------

function fitCanvases() {
  const vw = video.videoWidth, vh = video.videoHeight;
  const k = Math.min(1, 1280 / Math.max(vw, vh));
  const w = Math.round(vw * k), h = Math.round(vh * k);
  if (input.width !== w || input.height !== h) {
    input.width = stage.width = w;
    input.height = stage.height = h;
    state.smoother.reset();
  }
}

function processFrame() {
  fitCanvases();
  ictx.drawImage(video, 0, 0, input.width, input.height);
  const v = state.vision;
  if (!v) return;
  const t = performance.now() / 1000;
  const detailsOn = settings.details && !!v.face;
  // Face and hands every other frame if tracking everything is too slow to keep up.
  const t0 = performance.now();
  const r = v.detect(input, video, { details: detailsOn && state.frameNo % state.detailEvery === 0 });
  state.detectMs = 0.9 * state.detectMs + 0.1 * (performance.now() - t0);
  if (state.detectMs > 45) state.detailEvery = 2;
  else if (state.detectMs < 22) state.detailEvery = 1;
  state.frameNo++;

  state.mask = r.mask;
  state.lms = r.landmarks ? state.smoother.smooth(r.landmarks, t) : null;
  if (!r.landmarks) state.smoother.reset();
  if (!detailsOn) {
    state.face = null;
    state.hands = [null, null];
  } else {
    if (r.face !== undefined) state.face = r.face;
    if (r.hands !== undefined) state.hands = r.hands;
  }

  state.ext = null;
  if (state.lms && state.mask) {
    const px = state.lms.map((l) => ({ x: l.x * state.mask.width, y: l.y * state.mask.height }));
    state.ext = extent(state.mask, px);
    const S = { x: (px[11].x + px[12].x) / 2, y: (px[11].y + px[12].y) / 2 };
    state.motion.push({ t, x: S.x, y: S.y, nx: px[0].x, ny: px[0].y });
    const view = state.scan?.step ?? (Math.abs(px[11].x - px[12].x) / Math.max(1, (px[23].y + px[24].y) / 2 - S.y) > 0.4 ? 'front' : 'side');
    if (state.scan || state.frameNo % 3 === 0) state.live = measureView(state.lms, state.mask, view);
  } else {
    state.live = null;
  }
  while (state.motion.length && t - state.motion[0].t > 0.6) state.motion.shift();

  if (state.scan) scanTick(t);
  updateRail();
}

function render() {
  const W = stage.width, H = stage.height;
  if (!W || !input.width) return;
  const mirror = isMirrored();
  sctx.save();
  if (mirror) {
    sctx.translate(W, 0);
    sctx.scale(-1, 1);
  }
  sctx.drawImage(input, 0, 0);
  sctx.restore();
  sctx.fillStyle = 'rgba(8, 20, 17, 0.4)';
  sctx.fillRect(0, 0, W, H);

  const shownW = Math.min(stage.clientWidth, (stage.clientHeight * W) / H) || W;
  const u = Math.min(4, Math.max(0.5, W / shownW));
  const P = mapper(W, H, mirror);
  if (!state.lms) return;

  let rows = null;
  if (state.mask) {
    const step = Math.max(8, Math.round(H / 64));
    rows = bodyRows(state.mask, W, H, mirror, step);
    let scanY = null;
    if (state.ext) {
      const period = state.scan ? 1.6 : 3.4;
      const k = (performance.now() / 1000 / period) % 1;
      scanY = state.ext.top + (state.ext.bottom - state.ext.top) * k;
    }
    drawBodyMesh(sctx, rows, { u, step, scanY });
  }
  drawSkeleton(sctx, state.lms, W, H, mirror, u);
  if (state.face) drawFace(sctx, state.face.landmarks, P, u, { dense: true });
  state.hands.forEach((h) => h && drawHand(sctx, h.landmarks, P, u));

  // Tape rings where the chest, waist and hips will be measured.
  const live = state.live;
  if (live) {
    const X = mapPx(W, mirror);
    for (const f of [0.25, 0.74, 1.05]) {
      const s = live.torso[TORSO_FRACS.indexOf(f)];
      if (s) drawTapeRing(sctx, X(s.a), X(s.b), u, { width: 4 });
    }
  }

  // A height tape beside the body, scaled to the height you entered.
  if (state.ext && rows && profile.heightCm) {
    const xs = [11, 12, 15, 16, 23, 24, 27, 28].map((i) => P(state.lms[i]).x);
    const reach = 0.2 * state.ext.px;
    const edges = rows.flatMap((row) => row.runs.flat()).filter((x) => x > Math.min(...xs) - reach && x < Math.max(...xs) + reach);
    const gap = 0.06 * state.ext.px;
    const left = Math.min(...xs, ...edges) - gap - 20 * u;
    const x = left > 8 * u ? left : Math.max(...xs, ...edges) + gap;
    drawHeightTape(sctx, {
      x, top: state.ext.top, bottom: state.ext.bottom, heightCm: profile.heightCm, imperial: imperial(), u,
      label: fmtHeight(profile.heightCm),
    });
  }
}

function tick() {
  requestAnimationFrame(tick);
  if (state.source !== 'camera' || state.paused) return;
  if (video.readyState >= 2 && video.videoWidth && video.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = video.currentTime;
    processFrame();
  }
  render();
}

// ---------- Rail ----------

function updateRail() {
  const mirror = isMirrored();
  drawDetail($('#faceInset'), state.face, 'face', mirror);
  state.hands.forEach((h, i) => drawDetail($(`#handInset${i}`), h, 'hand', mirror));

  // Rough live sizes from the height scale.
  const cmPerPx = state.ext && profile.heightCm ? profile.heightCm / state.ext.px : null;
  const len = (lm, a, b) => Math.hypot((lm[a].x - lm[b].x) * input.width, (lm[a].y - lm[b].y) * input.height) * cmPerPx;
  setText($('#faceStat'), state.face && cmPerPx ? `${fmtLen(len(state.face.landmarks, 234, 454), 0)} wide` : state.face ? 'Tracking' : 'Not in view');
  state.hands.forEach((h, i) => {
    setText($(`#handStat${i}`), h && cmPerPx ? `${fmtLen(len(h.landmarks, 0, 12), 0)} long` : h ? 'Tracking' : 'Not in view');
  });
}

// ---------- Scan ----------

const HOLD_SECONDS = 1.8;
const STEPS = {
  front: { n: 1, title: 'Face the camera, arms out', say: 'Stand back so your whole body is in view. Face the camera and hold your arms out and down, like an A.' },
  side: { n: 2, title: 'Turn to your side, arms down', say: 'Got it. Now turn ninety degrees to your side, and let your arms hang by your sides.' },
};

function isStill() {
  const m = state.motion;
  if (m.length < 6 || m.at(-1).t - m[0].t < 0.4) return false;
  const limit = 0.012 * input.height;
  const mx = m.reduce((a, p) => a + p.x, 0) / m.length, my = m.reduce((a, p) => a + p.y, 0) / m.length;
  return m.every((p) => Math.hypot(p.x - mx, p.y - my) < limit);
}

function startScan() {
  readProfile();
  if (showProfileProblem()) return;
  audio.unlock();
  const t = performance.now() / 1000;
  state.scan = {
    step: 'front', frames: [], since: null, captures: {}, readyAt: t + 3, progress: 0,
    hint: null, hintSince: t, spokenAt: t, spoken: null,
  };
  speak(STEPS.front.say);
  $('#guide').hidden = false;
  updateScanUi();
  updateButtons();
}

function cancelScan() {
  state.scan = null;
  window.speechSynthesis?.cancel();
  $('#guide').hidden = $('#hold').hidden = $('#hint').hidden = true;
  updateScanUi();
  updateButtons();
}

function scanTick(t) {
  const sc = state.scan;
  let check = { ok: false, checks: [], hint: 'Step into the frame' };
  if (state.lms && state.mask) check = checkPose(state.lms, state.mask, sc.step);
  const warming = t < sc.readyAt;
  const still = check.ok && isStill();
  const ready = !warming && check.ok && still;
  const hint = warming ? `Get into position… ${Math.ceil(sc.readyAt - t)}` : !check.ok ? check.hint : still ? null : 'Hold still';

  if (ready) {
    sc.since ??= t;
    if (state.live) sc.frames.push(state.live);
    if (sc.frames.length > 14) sc.frames.shift();
  } else {
    sc.since = null;
    sc.frames = [];
  }
  sc.progress = sc.since === null ? 0 : Math.min(1, (t - sc.since) / HOLD_SECONDS);

  // Say what to fix if it's been the same problem for a while; the person is across the room.
  if (hint !== sc.hint) {
    sc.hint = hint;
    sc.hintSince = t;
  }
  if (hint && !warming && hint !== sc.spoken && t - sc.hintSince > 1.5 && t - sc.spokenAt > 4) {
    speak(hint);
    sc.spoken = hint;
    sc.spokenAt = t;
  }

  $('#guideChecks').innerHTML = check.checks.map((c) => `<li data-ok="${c.ok}">${c.label}</li>`).join('');
  const hold = $('#hold'), hintEl = $('#hint');
  hold.hidden = !ready;
  hintEl.hidden = ready || !hint;
  if (hint) setText(hintEl, hint);
  $('#holdFill').style.strokeDashoffset = String(326.7 * (1 - sc.progress));

  if (sc.progress >= 1) capture(t);
}

function flash() {
  const el = $('#flash');
  el.dataset.on = 'false';
  void el.offsetWidth;
  el.dataset.on = 'true';
}

function copyCanvas(src) {
  const c = Object.assign(document.createElement('canvas'), { width: src.width, height: src.height });
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

function capture(t) {
  const sc = state.scan;
  const merged = mergeFrames(sc.frames);
  if (!merged) {
    sc.since = null;
    return;
  }
  sc.captures[sc.step] = {
    merged,
    image: copyCanvas(input),
    mask: { ...state.mask, data: state.mask.data.slice() },
    lms: state.lms,
    mirror: isMirrored(),
    face: state.face?.landmarks ?? null,
    hands: state.hands.map((h) => h?.landmarks ?? null),
  };
  flash();
  audio.play('shutter');
  if (sc.step === 'front') {
    Object.assign(sc, { step: 'side', frames: [], since: null, progress: 0, readyAt: t + 1.5, spoken: null });
    speak(STEPS.side.say);
    updateScanUi();
    return;
  }
  const { front, side } = sc.captures;
  cancelScan();
  audio.play('done');
  speak('Scan complete.');
  showResults(buildResult(front, side, 'camera'));
}

function updateScanUi() {
  const sc = state.scan;
  if (sc) {
    const s = STEPS[sc.step];
    setText($('#guideStep'), `Step ${s.n} of 2`);
    setText($('#guideTitle'), s.title);
  }
  $('#stepFront').dataset.state = sc?.step === 'front' ? 'active' : sc?.captures.front ? 'done' : '';
  $('#stepSide').dataset.state = sc?.step === 'side' ? 'active' : '';
}

function updateButtons() {
  const btn = $('#scanBtn');
  btn.textContent = state.scan ? 'Cancel scan' : 'Start scan';
  btn.disabled = !state.scan && !(state.source === 'camera' && state.vision);
}

// ---------- Results ----------

function detailSizes(cap) {
  const W = cap.image.width, H = cap.image.height;
  const cmPerPx = profile.heightCm / cap.merged.bodyPx;
  const len = (lm, a, b) => Math.hypot((lm[a].x - lm[b].x) * W, (lm[a].y - lm[b].y) * H) * cmPerPx;
  const hands = cap.hands.filter(Boolean).map((h) => len(h, 0, 12));
  return {
    handLength: hands.length ? hands.reduce((a, b) => a + b, 0) / hands.length : null,
    faceWidth: cap.face ? len(cap.face, 234, 454) : null,
  };
}

function buildResult(front, side, source) {
  const result = { at: Date.now(), profile: { ...profile }, front, side, source };
  return compute(result);
}

function compute(result) {
  result.calibration = settings.calibration;
  result.meas = computeMeasurements(result.front.merged, result.side.merged, result.profile.heightCm, settings.calibration);
  result.extras = detailSizes(result.front);
  result.report = report(result.profile, result.meas.values);
  return result;
}

// ---------- History (a JSON file in the GitHub repo) ----------

const round = (x, digits = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** digits) / 10 ** digits);
const roundAll = (obj) => Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [k, round(v)]));
const stamp = (at) => new Date(at).toISOString().slice(0, 16).replace('T', ' ');

// One scan as it's stored in history.json: readable, rounded, no photos.
function toEntry(r) {
  const rep = r.report, p = r.profile;
  return {
    at: r.at,
    date: new Date(r.at).toISOString(),
    sex: p.sex,
    age: p.age,
    heightCm: round(p.heightCm),
    weightKg: round(p.weightKg),
    bodyFat: round(rep.bf),
    bodyFatRange: [round(rep.low), round(rep.high)],
    band: rep.band,
    bmi: round(rep.bmi),
    fatMassKg: round(rep.fatKg),
    leanMassKg: round(rep.leanKg),
    measurementsCm: roundAll(r.meas.values),
    calibration: round(r.calibration, 3),
    source: r.source,
  };
}

// Scans saved in this browser by earlier versions, converted to the file's format.
const fromLocal = (h) => ({
  at: h.at, date: new Date(h.at).toISOString(), sex: h.sex, weightKg: round(h.weightKg),
  bodyFat: round(h.bf), bodyFatRange: [round(h.low), round(h.high)], measurementsCm: roundAll(h.values),
});

async function loadHistory() {
  if (!getToken()) {
    state.historyState = 'off';
    return renderHistory();
  }
  state.historyState = 'loading';
  renderHistory();
  try {
    state.history = (await readHistory()).scans;
    state.historyState = 'ready';
    const local = load('history', []);
    const known = new Set(state.history.map((h) => h.at));
    const fresh = local.filter((h) => !known.has(h.at)).map(fromLocal);
    if (fresh.length) state.history = await saveScans(fresh, `Import ${fresh.length} scan${fresh.length > 1 ? 's' : ''} saved in the browser`);
    if (local.length) localStorage.removeItem('tapeline:history');
  } catch (err) {
    state.historyState = 'error';
    state.historyError = err.message;
  }
  renderHistory();
  if (state.results) renderResults();
}

async function saveResult(r, message) {
  if (!getToken()) {
    r.saveState = 'off';
    return renderSaveState();
  }
  r.saveState = 'saving';
  renderSaveState();
  try {
    state.history = await saveScans([toEntry(r)], message);
    state.historyState = 'ready';
    r.saveState = 'saved';
  } catch (err) {
    r.saveState = 'error';
    r.saveError = err.message;
  }
  if (state.results === r) renderResults();
}

function renderSaveState() {
  const r = state.results, el = $('#saveStatus');
  if (!r) return;
  el.dataset.state = r.saveState;
  el.innerHTML = {
    saving: 'Saving to your history file…',
    saved: `Saved to your <a href="${fileUrl()}" target="_blank" rel="noopener">history file</a> on GitHub.`,
    error: `Not saved: ${r.saveError} <button type="button" class="link-btn" data-retry-save>Try again</button>`,
    off: 'Not saved. <button type="button" class="link-btn" data-open-settings>Connect GitHub</button> to keep every scan in a history file.',
  }[r.saveState] ?? '';
}

function renderHistory() {
  const note = $('#historyNote'), table = $('#historyTable');
  $('#historyFileLink').href = fileUrl();
  $('#historyFileLink').hidden = state.historyState !== 'ready';
  note.innerHTML = {
    off: 'Scans on this device aren\'t being saved. <button type="button" class="link-btn" data-open-settings>Connect GitHub</button> to keep a permanent history.',
    loading: 'Loading your history from GitHub…',
    error: `Couldn't load your history: ${state.historyError} <button type="button" class="link-btn" data-retry-history>Try again</button>`,
    ready: state.history.length ? '' : 'No scans saved yet.',
  }[state.historyState];
  note.hidden = !note.innerHTML;
  const h = state.history;
  table.hidden = state.historyState !== 'ready' || !h.length;
  const current = state.results?.at;
  table.innerHTML = `<thead><tr><th>Date</th><th>Body fat</th><th>Waist</th><th>Hips</th><th>Weight</th></tr></thead><tbody>${h.map((s, i) => {
    const older = h[i + 1];
    const d = older && s.bodyFat != null && older.bodyFat != null ? s.bodyFat - older.bodyFat : null;
    const change = d !== null && Math.abs(d) >= 0.1 ? `<small>${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}</small>` : '';
    return `<tr${s.at === current ? ' aria-current="true"' : ''}><td>${new Date(s.at).toLocaleDateString(undefined, { dateStyle: 'medium' })}</td>
      <td>${s.bodyFat == null ? '–' : `${Number(s.bodyFat).toFixed(1)}%`}${change}</td>
      <td>${fmtLen(s.measurementsCm?.waist)}</td><td>${fmtLen(s.measurementsCm?.hips)}</td><td>${s.weightKg ? fmtMass(s.weightKg) : '–'}</td></tr>`;
  }).join('')}</tbody>`;
}

function showResults(result) {
  state.results = result;
  state.paused = true;
  saveResult(result, `Save scan from ${stamp(result.at)} UTC`);
  $('#app').inert = true;
  $('#results').hidden = false;
  $('#results').scrollTop = 0;
  renderResults();
  $('#scanAgainBtn').focus();
}

function hideResults() {
  state.results = null;
  state.paused = false;
  $('#results').hidden = true;
  $('#app').inert = false;
  showEmpty();
}

function renderScale(sex, rep) {
  const MAX = sex === 'female' ? 50 : 42;
  const bands = bodyFatBands(sex);
  const pct = (v) => `${(Math.min(MAX, Math.max(0, v)) / MAX) * 100}%`;
  const segs = bands.map(([name, from], i) => ({ name, from, to: bands[i + 1]?.[1] ?? MAX }));
  $('#bfScale').innerHTML = `
    <div class="bf-bands">${segs.map((s) => `<span style="width:${((s.to - s.from) / MAX) * 100}%" data-active="${s.name === rep.band}"></span>`).join('')}</div>
    <div class="bf-band-labels">${segs.map((s) => `<span style="left:${pct((s.from + s.to) / 2)}" data-active="${s.name === rep.band}">${s.name}</span>`).join('')}</div>
    <div class="bf-range-bar" style="left:${pct(rep.low)};width:calc(${pct(rep.high)} - ${pct(rep.low)})"></div>
    <div class="bf-marker" style="left:${pct(rep.bf)}"></div>`;
  // The first band starts at its own lower bound, so pad before it.
  $('#bfScale .bf-bands').style.paddingLeft = pct(segs[0].from);
}

function renderResults() {
  const r = state.results;
  if (!r) return;
  const rep = r.report, v = r.meas.values, sex = r.profile.sex;
  setText($('#resultsDate'), new Date(r.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));

  setText($('#bfValue'), rep.bf === null ? '–' : rep.bf.toFixed(1));
  $('#bfRange').innerHTML = rep.bf === null
    ? 'Not enough measurements to estimate. Try the scan again with your whole body in frame.'
    : `Likely between <b>${Math.round(rep.low)}%</b> and <b>${Math.round(rep.high)}%</b>, in the ${rep.band.toLowerCase()} range for ${sex === 'male' ? 'men' : 'women'}.`;
  if (rep.bf !== null) renderScale(sex, rep);

  const dd = (value, note) => `<dd>${value}${note ? `<small>${note}</small>` : ''}</dd>`;
  $('#composition').innerHTML = [
    ['Fat mass', rep.fatKg !== null ? dd(fmtMass(rep.fatKg)) : dd('–')],
    ['Lean mass', rep.leanKg !== null ? dd(fmtMass(rep.leanKg)) : dd('–')],
    ['BMI', dd(rep.bmi.toFixed(1), rep.bmiBand)],
    ['Fat-free mass index', rep.ffmi !== null ? dd(rep.ffmi.toFixed(1), `${rep.ffmiNorm.toFixed(1)} adjusted for height`) : dd('–')],
    ['Waist to height', rep.whtr !== null ? dd(rep.whtr.toFixed(2), rep.whtr < 0.5 ? 'Healthy is under 0.50' : 'Above the healthy 0.50') : dd('–')],
    ['Waist to hip', rep.whr !== null ? dd(rep.whr.toFixed(2)) : dd('–')],
  ].map(([dt, d]) => `<div><dt>${dt}</dt>${d}</div>`).join('');

  renderPhoto($('#frontCanvas'), r.front, r, 'front');
  renderPhoto($('#sideCanvas'), r.side, r, 'side');

  // Measurements, with the change since your previous scan.
  const prev = state.history.find((h) => h.at < r.at);
  const rows = MEASURES.map((m) => [m.name, v[m.id], prev?.measurementsCm?.[m.id]]);
  if (r.extras.handLength) rows.push(['Hand length', r.extras.handLength, null]);
  if (r.extras.faceWidth) rows.push(['Face width', r.extras.faceWidth, null]);
  $('#measureTable').innerHTML = rows.map(([name, val, before]) => {
    const delta = val != null && before != null ? val - before : null;
    const d = delta === null || Math.abs(delta) < 0.1 ? '' : `<small>${delta > 0 ? '+' : '−'}${fmtLen(Math.abs(delta))}</small>`;
    return `<tr><th scope="row">${name}</th><td>${fmtLen(val)}${d}</td></tr>`;
  }).join('');
  const contact = r.meas.contact;
  const note = $('#contactNote');
  note.hidden = !contact.length;
  note.textContent = contact.length
    ? 'Your arms were close to your sides at chest or waist height in the front shot, so those widths may read high. Hold your arms further out next time.'
    : '';

  $('#methods').innerHTML = rep.methods.map((m) =>
    `<li><b>${m.name}</b><span>${m.detail}. Counts for ${Math.round(m.weight * 100)}% of the estimate.</span><strong>${m.value === null ? '–' : `${m.value.toFixed(1)}%`}</strong></li>`,
  ).join('');

  $('#calibUnit').textContent = imperial() ? 'in' : 'cm';
  const calibrated = Math.abs(r.calibration - 1) > 1e-4;
  $('#calibReset').hidden = !calibrated;
  setText($('#calibStatus'), calibrated ? `Circumferences are scaled by ×${r.calibration.toFixed(3)} to match your tape measure.` : '');

  renderSaveState();
  renderHistory();
}

// A captured shot, cropped to the body, with the mesh, skeleton and tape measures drawn on it.
function renderPhoto(canvas, cap, r, view) {
  const img = cap.image, W = img.width, H = img.height, mirror = cap.mirror;
  const rep = cap.merged.rep, ext = rep.ext, where = r.meas.where, v = r.meas.values;
  const X = mapPx(W, mirror);

  // Crop with room either side for labels and the height tape. The silhouette's edges
  // (not the joints, which sit inside it) bound the body; stray blobs far away don't count.
  const step = Math.max(6, Math.round(ext.px / 56));
  const rows = bodyRows(cap.mask, W, H, mirror, step);
  const xs = rep.px.slice(11).map((p) => X(p).x);
  const near = (x) => x > Math.min(...xs) - 0.2 * ext.px && x < Math.max(...xs) + 0.2 * ext.px;
  const edges = rows.flatMap((row) => row.runs.flat()).filter(near);
  const bodyL = Math.min(...xs, ...edges), bodyR = Math.max(...xs, ...edges);
  const y0 = Math.max(0, Math.floor(ext.top - 0.07 * ext.px)), y1 = Math.min(H, Math.ceil(ext.bottom + 0.03 * ext.px));
  // Labels are sized in screen pixels, so how much room they need depends on how big the
  // photo will be shown. Estimate that first, then leave space for tags and the tape.
  const shown = (w, h) => Math.min(canvas.clientWidth || 560, (window.innerHeight * 0.78 * w) / h);
  const guessW = bodyR - bodyL + 0.6 * ext.px;
  const u0 = Math.max(0.5, guessW / shown(guessW, y1 - y0));
  const tagSize = shown(guessW, y1 - y0) < 520 ? 11.5 : 14;
  const tagRoom = tagSize * 9 * u0;
  const padL = Math.max(0.25 * ext.px, view === 'front' ? tagRoom : 40 * u0);
  const padR = Math.max(0.25 * ext.px, (view === 'front' ? tagRoom : 0) + 44 * u0);
  const x0 = Math.max(0, Math.floor(bodyL - padL)), x1 = Math.min(W, Math.ceil(bodyR + padR));
  canvas.width = x1 - x0;
  canvas.height = y1 - y0;
  const ctx = canvas.getContext('2d');
  ctx.translate(-x0, -y0);
  ctx.save();
  if (mirror) {
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(img, 0, 0);
  ctx.restore();
  ctx.fillStyle = 'rgba(8, 20, 17, 0.5)';
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

  const u = Math.max(0.5, canvas.width / shown(canvas.width, canvas.height));
  drawBodyMesh(ctx, rows, { u, step, alpha: 0.75 });
  drawSkeleton(ctx, cap.lms, W, H, mirror, u, 0.45);
  const P = mapper(W, H, mirror);
  if (cap.face) drawFace(ctx, cap.face, P, u, { dense: true });
  cap.hands.forEach((h) => h && drawHand(ctx, h, P, u));

  // Height tape first, so tags sit on top if space is tight.
  const tapeW = 20 * u, gap = 0.04 * ext.px;
  const tx = bodyR + gap + (view === 'front' ? tagRoom * (u / u0) : 0);
  drawHeightTape(ctx, {
    x: tx + tapeW <= x1 - 2 * u ? tx : Math.min(x1 - tapeW - 2 * u, bodyR + gap), top: ext.top, bottom: ext.bottom,
    heightCm: r.profile.heightCm, imperial: imperial(), u, label: fmtHeight(r.profile.heightCm),
  });

  const bodyMid = X(rep.Hp).x;
  const placed = [];
  // Torso and leg tags go to the right of the body, arm tags to the left.
  const tag = (s, name, value, right = true) => {
    const a = X(s.a), b = X(s.b);
    const end = (a.x > b.x) === right ? a : b;
    pill(ctx, `${name} ${fmtLen(value)}`, end.x + (right ? 14 : -14) * u, end.y, u,
      { align: right ? 'left' : 'right', bg: C.tape, color: C.tapeInk, weight: 700, size: tagSize, outline: C.ink }, placed);
  };
  const ring = (s, name, value, { tilt, right = true } = {}) => {
    if (!s) return;
    drawTapeRing(ctx, X(s.a), X(s.b), u, { tilt });
    if (view === 'front' && value != null) tag(s, name, value, right);
  };

  if (view === 'front') {
    const sh = rep.torso[where.shoulders.i];
    if (sh) {
      drawCaliper(ctx, X(sh.a), X(sh.b), u);
      tag(sh, 'Shoulders', v.shoulders);
    }
  }
  ring(rep.neck[view === 'front' ? where.neck.front : where.neck.side], 'Neck', v.neck);
  for (const k of ['chest', 'waist', 'hips']) ring(where[k] && rep.torso[where[k].i], k[0].toUpperCase() + k.slice(1), v[k]);
  const names = { upperArm: 'Upper arm', forearm: 'Forearm', thigh: 'Thigh', calf: 'Calf' };
  for (const kind of Object.keys(names)) {
    // Arms are labelled on the screen's left side of the body, legs on the right.
    const isArm = kind === 'upperArm' || kind === 'forearm';
    const onScreenLeft = (w) => X(rep.px[w.side === 'L' ? 11 : 12]).x < bodyMid;
    const w = where[kind]?.find((e) => onScreenLeft(e) === isArm) ?? where[kind]?.[0];
    if (!w) continue;
    const limb = view === 'front' ? rep.limbs[kind + w.side] : rep.limbs[kind + rep.sideLeg];
    ring(limb?.[w.i], names[kind], v[kind], { tilt: 0.3, right: !isArm });
  }
}

// ---------- Photos ----------

const photos = { front: null, side: null };
let pickTarget = null;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = Object.assign(document.createElement('canvas'), { width: Math.round(img.naturalWidth * k), height: Math.round(img.naturalHeight * k) });
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('unreadable'));
    };
    img.src = url;
  });
}

function photoError(text) {
  const el = $('#photosError');
  el.textContent = text;
  el.hidden = !text;
}

async function analyzePhotos() {
  readProfile();
  const problem = profileProblem();
  if (problem) return photoError(`Fill in "About you" first. ${problem.text}`);
  const btn = $('#analyzePhotos');
  btn.disabled = true;
  btn.textContent = 'Measuring…';
  photoError('');
  try {
    if (!state.vision) await state.visionPromise;
    if (!state.vision) throw new Error("Tracking didn't load. Check your internet connection and reload.");
    const caps = {};
    for (const view of ['front', 'side']) {
      const canvas = photos[view];
      const r = await state.vision.detectStill(canvas);
      if (!r.landmarks || !r.mask) throw new Error(`No person was found in the ${view} photo.`);
      const check = checkPose(r.landmarks, r.mask, view);
      const failed = (id) => check.checks.find((c) => c.id === id && !c.ok);
      if (failed('frame')) throw new Error(`Your whole body needs to be in the ${view} photo, from head to feet.`);
      if (failed('facing')) throw new Error(view === 'front' ? "The front photo doesn't look like it faces the camera." : "The side photo doesn't look side-on. Turn 90° to the camera.");
      const merged = mergeFrames([measureView(r.landmarks, r.mask, view)]);
      if (!merged) throw new Error(`Couldn't measure the ${view} photo.`);
      caps[view] = { merged, image: canvas, mask: r.mask, lms: r.landmarks, mirror: false, face: null, hands: [null, null] };
    }
    $('#photosDialog').close();
    showResults(buildResult(caps.front, caps.side, 'photos'));
  } catch (err) {
    console.error(err);
    photoError(err.message);
  } finally {
    btn.textContent = 'Measure';
    btn.disabled = !(photos.front && photos.side);
  }
}

// ---------- Wiring ----------

function syncUnits() {
  $$('[data-units]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.units === settings.units)));
}

$$('[data-units]').forEach((b) => b.addEventListener('click', () => {
  readProfile();
  settings.units = b.dataset.units;
  saveSettings();
  syncUnits();
  renderProfile();
  renderResults();
}));

$$('[data-sex]').forEach((b) => b.addEventListener('click', () => {
  profile.sex = b.dataset.sex;
  save('profile', profile);
  renderProfile();
  $('#profileError').hidden = true;
}));
$('#profileForm').addEventListener('input', readProfile);
$('#profileForm').addEventListener('submit', (e) => e.preventDefault());

$('#startCameraBtn').addEventListener('click', () => startCamera());
$('#cameraSelect').addEventListener('change', (e) => startCamera(e.target.value));
$('#scanBtn').addEventListener('click', () => (state.scan ? cancelScan() : startScan()));
$('#scanAgainBtn').addEventListener('click', () => {
  hideResults();
  if (state.source === 'camera') startScan();
});

$$('[data-open-photos]').forEach((b) => b.addEventListener('click', () => {
  photoError('');
  $('#photosDialog').showModal();
}));
$$('[data-pick]').forEach((b) => b.addEventListener('click', () => {
  pickTarget = b.dataset.pick;
  $('#photoFile').click();
}));
$('#photoFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !pickTarget) return;
  try {
    const canvas = await loadImage(file);
    photos[pickTarget] = canvas;
    const thumb = $(`#${pickTarget}Thumb`);
    thumb.style.backgroundImage = `url(${canvas.toDataURL('image/jpeg', 0.6)})`;
    thumb.dataset.set = 'true';
    photoError('');
  } catch {
    photoError("That file couldn't be opened as an image. Try a JPEG or PNG.");
  }
  $('#analyzePhotos').disabled = !(photos.front && photos.side);
});
$('#analyzePhotos').addEventListener('click', analyzePhotos);

$('#calibrateForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const r = state.results;
  const val = Number($('#calibInput').value);
  if (!r || !(val > 0)) return;
  const measured = imperial() ? val * CM_PER_IN : val;
  const raw = r.meas.values.waist / r.calibration;
  const factor = measured / raw;
  if (!(factor > 0.75 && factor < 1.3)) {
    setText($('#calibStatus'), `That's ${Math.round(Math.abs(factor - 1) * 100)}% off the scan. Measure around your navel with the tape level and snug, then try again.`);
    return;
  }
  settings.calibration = factor;
  saveSettings();
  compute(r);
  saveResult(r, `Update scan from ${stamp(r.at)} UTC with a tape-measured calibration`);
  $('#calibInput').value = '';
  renderResults();
});
$('#calibReset').addEventListener('click', () => {
  settings.calibration = 1;
  saveSettings();
  if (state.results) {
    compute(state.results);
    saveResult(state.results, `Update scan from ${stamp(state.results.at)} UTC without calibration`);
  }
  renderResults();
});
// Buttons inside rendered status text.
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-retry-save]') && state.results) saveResult(state.results, `Save scan from ${stamp(state.results.at)} UTC`);
  if (e.target.closest('[data-retry-history]')) loadHistory();
  if (e.target.closest('[data-open-settings]')) openSettings();
});

const settingsDialog = $('#settingsDialog');
$('#modelSelect').replaceChildren(...Object.entries(POSE_MODELS).map(([id, name]) => new Option(name, id)));
function openSettings() {
  $('#modelSelect').value = settings.poseModel;
  $('#detailsInput').checked = settings.details;
  $('#voiceInput').checked = settings.voice;
  $('#soundInput').checked = settings.sound;
  $('#mirrorInput').checked = settings.mirror;
  renderGithubSettings();
  settingsDialog.showModal();
}
$('#settingsBtn').addEventListener('click', openSettings);

function renderGithubSettings(message = '') {
  const connected = !!getToken();
  $('#ghConnect').hidden = connected;
  $('#ghDisconnect').hidden = !connected;
  setText($('#ghStatus'), message || (connected
    ? `Connected${settings.githubUser ? ` as ${settings.githubUser}` : ''}. Every scan is saved to the history file.`
    : "Not connected. Scans on this device aren't saved."));
}

async function connectGithub() {
  const input = $('#ghToken'), token = input.value.trim();
  if (!token) return input.focus();
  renderGithubSettings('Checking the token…');
  try {
    settings.githubUser = await verifyToken(token);
    saveSettings();
    setToken(token);
    input.value = '';
    renderGithubSettings();
    await loadHistory();
    // Save the scan on screen if it wasn't saved before connecting.
    if (state.results && state.results.saveState !== 'saved') saveResult(state.results, `Save scan from ${stamp(state.results.at)} UTC`);
  } catch (err) {
    renderGithubSettings(err.message);
  }
}
$('#ghConnectBtn').addEventListener('click', connectGithub);
$('#ghToken').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault(); // Enter would otherwise close the dialog
  connectGithub();
});
$('#ghDisconnect').addEventListener('click', () => {
  setToken('');
  settings.githubUser = '';
  saveSettings();
  state.history = [];
  state.historyState = 'off';
  renderGithubSettings();
  renderHistory();
  renderSaveState();
});
$('#modelSelect').addEventListener('change', (e) => {
  settings.poseModel = e.target.value;
  saveSettings();
  loadVision();
});
$('#detailsInput').addEventListener('change', (e) => {
  settings.details = e.target.checked;
  saveSettings();
  if (settings.details) state.vision?.loadDetails();
});
for (const [id, key] of [['voiceInput', 'voice'], ['soundInput', 'sound'], ['mirrorInput', 'mirror']]) {
  $(`#${id}`).addEventListener('change', (e) => {
    settings[key] = e.target.checked;
    saveSettings();
    if (key === 'sound' && e.target.checked) audio.unlock();
  });
}

// ---------- Boot ----------

syncUnits();
renderProfile();
showEmpty();
loadVision();
loadHistory();
requestAnimationFrame(tick);

navigator.permissions?.query({ name: 'camera' })
  .then((p) => {
    if (p.state === 'granted' && !state.source) startCamera();
  })
  .catch(() => {});
