// One Euro filter (Casiez et al.) — smooths jitter at rest while staying
// responsive during fast movement.

const alpha = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

class OneEuro {
  constructor(minCutoff, beta, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  filter(x, t) {
    if (this.x === null) {
      this.x = x;
      this.t = t;
      return x;
    }
    const dt = Math.max(1e-3, t - this.t);
    this.t = t;
    const rawDx = (x - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (x - this.x);
    return this.x;
  }
}

// Smooths all 33 pose landmarks. Coordinates are normalized (0..1), time in seconds.
export class LandmarkSmoother {
  constructor({ minCutoff = 2.0, beta = 4.0 } = {}) {
    this.opts = { minCutoff, beta };
    this.filters = [];
    this.vis = [];
  }

  reset() {
    this.filters = [];
    this.vis = [];
  }

  smooth(landmarks, t) {
    const { minCutoff, beta } = this.opts;
    // Some tasks-vision builds report visibility as 0 for every landmark; treat that as "unknown".
    const hasVisibility = landmarks.some((l) => (l.visibility ?? 0) > 0);
    return landmarks.map((l, i) => {
      if (!this.filters[i]) {
        this.filters[i] = [new OneEuro(minCutoff, beta), new OneEuro(minCutoff, beta), new OneEuro(minCutoff, beta)];
        this.vis[i] = hasVisibility ? l.visibility : 1;
      }
      const [fx, fy, fz] = this.filters[i];
      const v = hasVisibility ? l.visibility : 1;
      this.vis[i] += 0.35 * (v - this.vis[i]);
      return { x: fx.filter(l.x, t), y: fy.filter(l.y, t), z: fz.filter(l.z, t), v: this.vis[i] };
    });
  }
}
