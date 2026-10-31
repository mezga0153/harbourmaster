import {
  ACESFilmicToneMapping,
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  type Object3D,
  OrthographicCamera,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { C } from '../render/palette';

// A turntable for one model or rig: lit and toned as the game is, on a
// patch of ground or water, seen from any angle by dragging, or from the
// game's own isometric angle.

/** The game's isometric pitch, see render/camera.ts. */
const ISO_PITCH = Math.atan(1 / Math.SQRT2);

export interface Staged {
  object: Object3D;
  /** What to frame; the object's bounds if not given. */
  box?: Box3;
  /** Afloat: on water rather than on the ground. */
  water?: boolean;
  /** No ground at all, for things on their own patch of shore. */
  bare?: boolean;
  /** Every frame, with game time and the frame's length in seconds. */
  update?(time: number, dt: number): void;
  dispose?(): void;
}

export class Stage {
  private gl: WebGLRenderer;
  private scene = new Scene();
  private persp = new PerspectiveCamera(32, 1, 0.05, 500);
  private ortho = new OrthographicCamera(-1, 1, 1, -1, 0.1, 500);
  private sun: DirectionalLight;
  private ground: Mesh;
  private grid: GridHelper;
  private holder = new Group();
  private shown: Staged | null = null;
  private yaw = Math.PI / 4;
  private pitch = ISO_PITCH;
  private dist = 4;
  private target = new Vector3();
  private last = performance.now();
  private start = performance.now();
  private running = true;
  /** Turning slowly on its own. */
  spin = false;
  /** The game's orthographic view rather than perspective. */
  iso = false;
  /** Game time runs this much faster or slower than real time. */
  rate = 1;
  /** Stats of the last frame drawn, for the page. */
  info = '';

  constructor(private container: HTMLElement) {
    this.gl = new WebGLRenderer({ antialias: true });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = PCFShadowMap;
    this.gl.toneMapping = ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.15;
    container.appendChild(this.gl.domElement);
    this.scene.background = new Color(0x1a2633);
    this.scene.add(new HemisphereLight(0xeaf4ff, 0x8a7f6a, 1.6));
    this.sun = new DirectionalLight(0xfff1dc, 2.4);
    this.sun.position.set(-0.55 * 30, 30, 0.35 * 30);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -12;
    sc.right = sc.top = 12;
    sc.near = 1;
    sc.far = 100;
    this.scene.add(this.sun, this.sun.target, this.holder);
    this.ground = new Mesh(
      new PlaneGeometry(60, 60),
      new MeshLambertMaterial({ color: C.concrete }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.grid = new GridHelper(60, 60, 0x4a5a6a, 0x33404d);
    this.grid.position.y = 0.002;
    this.scene.add(this.ground, this.grid);
    this.pointer();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.gl.setAnimationLoop(() => this.tick());
  }

  get canvas(): HTMLCanvasElement {
    return this.gl.domElement;
  }

  /** Show this instead of what was shown, framed to fit. */
  show(s: Staged): void {
    this.clear();
    this.shown = s;
    s.object.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    this.holder.add(s.object);
    this.ground.visible = !s.bare;
    this.grid.visible = !s.bare && !s.water;
    (this.ground.material as MeshLambertMaterial).color.set(s.water ? 0x3f8fc9 : C.concrete);
    this.ground.position.y = s.water ? -0.02 : -0.001;
    s.object.updateMatrixWorld(true);
    const box = s.box ?? new Box3().setFromObject(s.object);
    if (!box.isEmpty()) this.frame(box);
  }

  clear(): void {
    if (!this.shown) return;
    this.holder.remove(this.shown.object);
    this.shown.dispose?.();
    this.shown = null;
  }

  /** Look at the middle of `box` from far enough to see all of it. */
  frame(box: Box3): void {
    box.getCenter(this.target);
    // Far enough back for the box's sphere to fit the narrower way across the view.
    const r = box.getSize(new Vector3()).length() / 2;
    const half = (this.persp.fov * Math.PI) / 360;
    const fit = Math.min(half, Math.atan(Math.tan(half) * this.persp.aspect));
    this.dist = Math.max(0.3, (r / Math.sin(fit)) * 1.15);
    this.sun.target.position.copy(this.target);
    this.sun.position
      .copy(this.target)
      .add(new Vector3(-0.55, 1, 0.35).normalize().multiplyScalar(30));
  }

  /** From the game's angle: a quarter turn from the axes, pitched as its camera is. */
  gameAngle(): void {
    this.yaw = Math.PI / 4;
    this.pitch = ISO_PITCH;
  }

  /** Paused: what is shown holds still. */
  set paused(p: boolean) {
    this.running = !p;
  }

  get paused(): boolean {
    return !this.running;
  }

  /** The view as a PNG data: URL. */
  png(): string {
    this.draw();
    return this.gl.domElement.toDataURL('image/png');
  }

  private pointer(): void {
    const c = this.gl.domElement;
    let drag: { x: number; y: number; pan: boolean } | null = null;
    c.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.pan) {
        const upp = this.dist / Math.max(1, c.clientHeight);
        const right = new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        const fwd = new Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
        this.target.addScaledVector(right, -dx * upp).addScaledVector(fwd, dy * upp);
      } else {
        this.yaw -= dx * 0.008;
        this.pitch = Math.max(-0.2, Math.min(Math.PI / 2 - 0.05, this.pitch + dy * 0.006));
      }
    });
    const up = () => (drag = null);
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.dist = Math.max(0.3, Math.min(80, this.dist * (e.deltaY > 0 ? 1.12 : 1 / 1.12)));
      },
      { passive: false },
    );
  }

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    const c = this.gl.domElement;
    if (c.clientWidth === w && c.clientHeight === h) return;
    this.gl.setSize(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
  }

  private camera(): PerspectiveCamera | OrthographicCamera {
    const cam = this.iso ? this.ortho : this.persp;
    const d = this.iso ? 200 : this.dist;
    cam.position.set(
      this.target.x + Math.cos(this.pitch) * Math.sin(this.yaw) * d,
      this.target.y + Math.sin(this.pitch) * d,
      this.target.z + Math.cos(this.pitch) * Math.cos(this.yaw) * d,
    );
    cam.lookAt(this.target);
    if (this.iso) {
      // As wide as the perspective view would be at this distance.
      const half = Math.tan((this.persp.fov * Math.PI) / 360) * this.dist;
      this.ortho.left = -half * this.persp.aspect;
      this.ortho.right = half * this.persp.aspect;
      this.ortho.top = half;
      this.ortho.bottom = -half;
      this.ortho.updateProjectionMatrix();
    }
    return cam;
  }

  private time = 0;

  private tick(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000) * (this.running ? this.rate : 0);
    this.last = now;
    this.time += dt;
    if (this.spin) this.yaw += dt * 0.4;
    this.shown?.update?.(this.time, dt);
    this.draw();
  }

  private draw(): void {
    this.gl.render(this.scene, this.camera());
    const r = this.gl.info.render;
    this.info = `${r.triangles.toLocaleString()} triangles · ${r.calls} draw calls · ${((performance.now() - this.start) / 1000).toFixed(0)} s`;
  }
}
