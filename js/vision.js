// MediaPipe tracking: body pose + silhouette every frame, plus face mesh and hands.
// At full-body distance the face and hands are only a few dozen pixels, too small for
// their detectors, so they run on zoomed crops that follow the pose landmarks.
import {
  PoseLandmarker, HandLandmarker, FaceLandmarker, FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs';
import { LandmarkSmoother } from './filter.js';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const MODELS = 'https://storage.googleapis.com/mediapipe-models';
const CROP = 256;

export const POSE_MODELS = {
  lite: 'Lite (fastest)',
  full: 'Full (balanced)',
  heavy: 'Heavy (most accurate)',
};

const pairs = (list) => list.map((c) => [c.start, c.end]);
export const CONNECTIONS = {
  pose: pairs(PoseLandmarker.POSE_CONNECTIONS),
  hand: pairs(HandLandmarker.HAND_CONNECTIONS),
  faceMesh: pairs(FaceLandmarker.FACE_LANDMARKS_TESSELATION),
  faceFeatures: pairs([
    ...FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,
    ...FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, ...FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
    ...FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, ...FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW,
    ...FaceLandmarker.FACE_LANDMARKS_LIPS,
  ]),
  irises: pairs([...FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, ...FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS]),
};

let filesetPromise;
async function createTask(Task, options) {
  filesetPromise ??= FilesetResolver.forVisionTasks(WASM);
  const fileset = await filesetPromise;
  const withDelegate = (delegate) => ({ ...options, baseOptions: { ...options.baseOptions, delegate } });
  try {
    return { task: await Task.createFromOptions(fileset, withDelegate('GPU')), delegate: 'GPU' };
  } catch (err) {
    console.warn(`${Task.name}: GPU unavailable, using CPU`, err);
    return { task: await Task.createFromOptions(fileset, withDelegate('CPU')), delegate: 'CPU' };
  }
}

const poseOptions = (model, runningMode) => ({
  baseOptions: { modelAssetPath: `${MODELS}/pose_landmarker/pose_landmarker_${model}/float16/1/pose_landmarker_${model}.task` },
  runningMode,
  numPoses: 1,
  outputSegmentationMasks: true,
});

const makeCanvas = (w, h = w) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// A square crop in source pixels, kept inside the frame.
function square(cx, cy, size, W, H) {
  const s = Math.min(size, W, H);
  return { x: Math.min(W - s, Math.max(0, cx - s / 2)), y: Math.min(H - s, Math.max(0, cy - s / 2)), s };
}

function copyMask(mask) {
  if (!mask) return null;
  return { data: new Float32Array(mask.getAsFloat32Array()), width: mask.width, height: mask.height };
}

export class Vision {
  static async create(model = 'full') {
    const { task, delegate } = await createTask(PoseLandmarker, poseOptions(model, 'VIDEO'));
    return new Vision(task, model, delegate);
  }

  constructor(pose, model, delegate) {
    this.pose = pose;
    this.model = model;
    this.delegate = delegate;
    this.lastTs = 0;
    this.face = null;
    this.hands = [null, null];
    this.faceCanvas = makeCanvas(CROP);
    this.handCanvas = [makeCanvas(CROP), makeCanvas(CROP)];
    this.crops = {};
    this.faceSmoother = new LandmarkSmoother({ minCutoff: 1.2, beta: 25 });
    this.handSmoothers = [new LandmarkSmoother({ minCutoff: 1.5, beta: 20 }), new LandmarkSmoother({ minCutoff: 1.5, beta: 20 })];
  }

  // Face and hand models load in the background; detail tracking starts once they're in.
  loadDetails() {
    const hand = () => createTask(HandLandmarker, {
      baseOptions: { modelAssetPath: `${MODELS}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task` },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.4,
    });
    this.detailsPromise ??= Promise.all([
      createTask(FaceLandmarker, {
        baseOptions: { modelAssetPath: `${MODELS}/face_landmarker/face_landmarker/float16/1/face_landmarker.task` },
        runningMode: 'VIDEO',
        numFaces: 1,
      }),
      hand(),
      hand(),
    ]).then(([face, h1, h2]) => {
      this.face = face.task;
      this.hands = [h1.task, h2.task];
    });
    return this.detailsPromise;
  }

  timestamp() {
    this.lastTs = Math.max(performance.now(), this.lastTs + 1);
    return this.lastTs;
  }

  // frame: the (downscaled) canvas the pose model sees. source: the full-resolution
  // video or image the detail crops are cut from.
  detect(frame, source, { details = true } = {}) {
    const ts = this.timestamp();
    const result = this.pose.detectForVideo(frame, ts);
    const landmarks = result.landmarks?.[0] ?? null;
    const mask = copyMask(result.segmentationMasks?.[0]);
    result.segmentationMasks?.forEach((m) => m.close());

    // face/hands stay undefined on frames where they weren't run, so callers keep the last ones.
    let face, hands;
    if (!landmarks) {
      this.faceSmoother.reset();
      this.handSmoothers.forEach((s) => s.reset());
      face = null;
      hands = [null, null];
    } else if (details) {
      const W = source.videoWidth || source.width, H = source.videoHeight || source.height;
      const px = landmarks.map((l) => ({ x: l.x * W, y: l.y * H, v: l.visibility ?? 1 }));
      if (this.face) face = this.trackFace(px, source, W, H, ts);
      if (this.hands[0]) hands = [0, 1].map((i) => this.trackHand(i, px, source, W, H, ts));
    }
    return { landmarks, mask, face, hands };
  }

  // Eases crop boxes so the zoomed views don't jitter with the pose.
  smoothCrop(key, next) {
    const prev = this.crops[key];
    const jump = prev && Math.hypot(prev.x - next.x, prev.y - next.y) > prev.s * 0.6;
    const c = !prev || jump ? next : {
      x: prev.x + 0.4 * (next.x - prev.x),
      y: prev.y + 0.4 * (next.y - prev.y),
      s: prev.s + 0.4 * (next.s - prev.s),
    };
    this.crops[key] = c;
    return c;
  }

  // Maps landmarks found in a crop back to full-frame normalized coordinates.
  static fromCrop(points, crop, W, H) {
    return points.map((p) => ({ x: (crop.x + p.x * crop.s) / W, y: (crop.y + p.y * crop.s) / H, z: p.z }));
  }

  trackFace(px, source, W, H, ts) {
    const [nose, eyeL, eyeR, earL, earR, mouthL, mouthR] = [0, 2, 5, 7, 8, 9, 10].map((i) => px[i]);
    if (nose.v < 0.5) {
      this.faceSmoother.reset();
      return null;
    }
    const eyes = { x: (eyeL.x + eyeR.x) / 2, y: (eyeL.y + eyeR.y) / 2 };
    const mouth = { x: (mouthL.x + mouthR.x) / 2, y: (mouthL.y + mouthR.y) / 2 };
    const size = 2.6 * Math.max(dist(earL, earR), 1.4 * Math.max(dist(nose, earL), dist(nose, earR)), 2.4 * dist(eyes, mouth), 24);
    const crop = this.smoothCrop('face', square((eyes.x + mouth.x) / 2, (eyes.y + mouth.y) / 2, size, W, H));
    this.faceCanvas.getContext('2d').drawImage(source, crop.x, crop.y, crop.s, crop.s, 0, 0, CROP, CROP);
    const found = this.face.detectForVideo(this.faceCanvas, ts).faceLandmarks?.[0];
    if (!found) {
      this.faceSmoother.reset();
      return null;
    }
    const landmarks = this.faceSmoother.smooth(Vision.fromCrop(found, crop, W, H), ts / 1000);
    return { landmarks, local: found, crop, image: this.faceCanvas };
  }

  trackHand(i, px, source, W, H, ts) {
    const [wrist, elbow, index, pinky] = (i === 0 ? [15, 13, 19, 17] : [16, 14, 20, 18]).map((k) => px[k]);
    const smoother = this.handSmoothers[i];
    if (wrist.v < 0.35) {
      smoother.reset();
      return null;
    }
    const knuckles = { x: (index.x + pinky.x) / 2, y: (index.y + pinky.y) / 2 };
    const size = Math.max(1.3 * dist(elbow, wrist), 3.8 * dist(wrist, knuckles), 32);
    const toward = dist(wrist, knuckles) > 2 ? knuckles : { x: 2 * wrist.x - elbow.x, y: 2 * wrist.y - elbow.y };
    const d = dist(wrist, toward) || 1;
    const cx = wrist.x + ((toward.x - wrist.x) / d) * 0.28 * size;
    const cy = wrist.y + ((toward.y - wrist.y) / d) * 0.28 * size;
    const crop = this.smoothCrop(`hand${i}`, square(cx, cy, size, W, H));
    const canvas = this.handCanvas[i];
    canvas.getContext('2d').drawImage(source, crop.x, crop.y, crop.s, crop.s, 0, 0, CROP, CROP);
    const found = this.hands[i].detectForVideo(canvas, ts).landmarks?.[0];
    if (!found) {
      smoother.reset();
      return null;
    }
    const landmarks = smoother.smooth(Vision.fromCrop(found, crop, W, H), ts / 1000);
    return { landmarks, local: found, crop, image: canvas };
  }

  // Single photos: a separate image-mode model, created on first use.
  async detectStill(canvas) {
    this.still ??= createTask(PoseLandmarker, poseOptions(this.model, 'IMAGE')).then((r) => r.task);
    const task = await this.still;
    const result = task.detect(canvas);
    const mask = copyMask(result.segmentationMasks?.[0]);
    result.segmentationMasks?.forEach((m) => m.close());
    return { landmarks: result.landmarks?.[0] ?? null, mask };
  }

  close() {
    this.pose.close();
    this.face?.close();
    this.hands.forEach((h) => h?.close());
    this.still?.then((t) => t.close());
  }
}
