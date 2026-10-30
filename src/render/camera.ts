import { MathUtils, OrthographicCamera, Vector3 } from 'three';

const PITCH = Math.atan(1 / Math.SQRT2); // true isometric, ~35.26°
const DISTANCE = 200;
const MIN_VIEW = 6;
const MAX_VIEW = 70;

/** Orthographic isometric camera with 90° rotation steps, pan and zoom. */
export class IsoCamera {
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 1, 1000);
  readonly target = new Vector3();
  viewSize = 16;
  private yawStep = 0;
  private yaw = Math.PI / 4;
  private aspect = 1;
  private bounds = { minX: 0, minZ: 0, maxX: 100, maxZ: 100 };
  /** Flying the view from one place and zoom to another, see flyTo. */
  private fly?: {
    from: { x: number; z: number; size: number };
    to: { x: number; z: number; size: number };
    t: number;
    time: number;
  };

  /**
   * Fly the view over to look at x, z this zoomed, over `time` seconds:
   * pulling back as it sets off and closing in as it gets there, so the
   * ground it crosses shows on the way.
   */
  flyTo(x: number, z: number, size: number, time = 1.4): void {
    const b = this.bounds;
    this.fly = {
      from: { x: this.target.x, z: this.target.z, size: this.viewSize },
      to: {
        x: MathUtils.clamp(x, b.minX, b.maxX),
        z: MathUtils.clamp(z, b.minZ, b.maxZ),
        size: MathUtils.clamp(size, MIN_VIEW, MAX_VIEW),
      },
      t: 0,
      time,
    };
  }

  /** Which way is right across the screen, on the ground. */
  get right(): [number, number] {
    return [Math.cos(this.yaw), -Math.sin(this.yaw)];
  }

  /** Where the view looks and how zoomed, to fly back to later. */
  get view(): { x: number; z: number; size: number } {
    const to = this.fly?.to;
    return to ? { ...to } : { x: this.target.x, z: this.target.z, size: this.viewSize };
  }

  setBounds(w: number, h: number): void {
    this.bounds = { minX: 0, minZ: 0, maxX: w, maxZ: h };
  }

  resize(width: number, height: number): void {
    this.aspect = width / Math.max(1, height);
  }

  rotate(dir: 1 | -1): void {
    this.yawStep += dir;
  }

  /** Quarter turns of the view from where it starts, 0 to 3. */
  get turns(): number {
    return ((this.yawStep % 4) + 4) % 4;
  }

  /** Turned this many quarter turns from the start, straight away. */
  setTurns(turns: number): void {
    this.yawStep = turns;
    this.yaw = Math.PI / 4 + (turns * Math.PI) / 2;
  }

  /** Looking at x, z on the ground, held within the map. */
  lookAt(x: number, z: number): void {
    const b = this.bounds;
    this.target.set(MathUtils.clamp(x, b.minX, b.maxX), 0, MathUtils.clamp(z, b.minZ, b.maxZ));
  }

  /** As zoomed as this, within the limits. */
  setViewSize(size: number): void {
    this.viewSize = MathUtils.clamp(size, MIN_VIEW, MAX_VIEW);
  }

  zoom(factor: number): void {
    this.fly = undefined;
    this.viewSize = MathUtils.clamp(this.viewSize * factor, MIN_VIEW, MAX_VIEW);
  }

  /** Pan by a screen-space pixel delta, so the ground follows the cursor. */
  panPixels(dx: number, dy: number, viewportHeight: number): void {
    const upp = this.viewSize / viewportHeight;
    this.panWorld(-dx * upp, (dy * upp) / Math.sin(PITCH));
  }

  /** Pan in camera-relative ground units (right, forward). */
  panWorld(right: number, forward: number): void {
    this.fly = undefined;
    const yaw = this.yaw;
    this.target.x += Math.cos(yaw) * right - Math.sin(yaw) * forward;
    this.target.z += -Math.sin(yaw) * right - Math.cos(yaw) * forward;
    const b = this.bounds;
    this.target.x = MathUtils.clamp(this.target.x, b.minX, b.maxX);
    this.target.z = MathUtils.clamp(this.target.z, b.minZ, b.maxZ);
  }

  update(dt: number): void {
    const f = this.fly;
    if (f) {
      f.t = Math.min(1, f.t + dt / f.time);
      const e = f.t * f.t * (3 - 2 * f.t);
      this.target.x = f.from.x + (f.to.x - f.from.x) * e;
      this.target.z = f.from.z + (f.to.z - f.from.z) * e;
      // Pulled back on the way, to see across the ground between.
      const far = Math.hypot(f.to.x - f.from.x, f.to.z - f.from.z);
      const over = Math.min(MAX_VIEW, Math.max(f.from.size, f.to.size, far * 0.9));
      const size = f.from.size + (f.to.size - f.from.size) * e;
      this.viewSize =
        size + (over - Math.max(f.from.size, f.to.size)) * Math.sin(Math.PI * e) * 0.6;
      if (f.t >= 1) this.fly = undefined;
    }
    const goal = Math.PI / 4 + (this.yawStep * Math.PI) / 2;
    this.yaw += (goal - this.yaw) * Math.min(1, dt * 10);

    const halfH = this.viewSize / 2;
    const cam = this.camera;
    cam.left = -halfH * this.aspect;
    cam.right = halfH * this.aspect;
    cam.top = halfH;
    cam.bottom = -halfH;
    cam.position.set(
      this.target.x + Math.cos(PITCH) * Math.sin(this.yaw) * DISTANCE,
      this.target.y + Math.sin(PITCH) * DISTANCE,
      this.target.z + Math.cos(PITCH) * Math.cos(this.yaw) * DISTANCE,
    );
    cam.lookAt(this.target);
    cam.updateProjectionMatrix();
  }
}
