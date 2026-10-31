import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  Object3D,
  PCFShadowMap,
  Plane,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { EntityView, ProblemView, Snapshot, TileChange } from '../protocol';
import type { GameMap } from '../sim/map';
import { IsoCamera } from './camera';
import { Entities } from './entities';
import { KeyedObjects } from './keyed';
import { alertMarker } from './models';
import { Overlay } from './overlay';
import { C } from './palette';
import { Structures } from './structures';
import { Designations } from './structures/labels';
import { Trains } from './trains';
import { buildLand, buildRocks, buildSeabed, buildSeabedDetail, buildTrees } from './terrain';
import { Water } from './water';
import { DEFAULT_GRAPHICS, PIXEL_RATIO, SHADOW_SIZE, WATER_LEVEL, type Graphics } from './graphics';
import { toCanvas, toClient } from './util/screen';

const SUN_DIR = new Vector3(-0.55, 1, 0.35).normalize();
// Light-space axes, used to snap the shadow camera to whole shadow-map texels.
const SUN_RIGHT = new Vector3().crossVectors(SUN_DIR, new Vector3(0, 1, 0)).normalize();
const SUN_UP = new Vector3().crossVectors(SUN_RIGHT, SUN_DIR).normalize();
const PICK_PLANE = new Plane(new Vector3(0, 1, 0), -0.28);

interface Floater {
  el: HTMLElement;
  pos: Vector3;
  born: number;
}

interface MapLayers {
  map: GameMap;
  root: Group;
  water: Water;
  structures: Structures;
  /** Each place's designation, on its sign or painted on the ground. */
  designations: Designations;
  entities: Entities;
  trains: Trains;
  scenery: Group;
  seabed: Mesh;
  seabedDetail: Object3D;
  land: Mesh;
  rocks: Object3D;
  trees: Group;
}

export class Renderer {
  readonly cam = new IsoCamera();
  readonly overlay = new Overlay();
  private gl: WebGLRenderer;
  private scene = new Scene();
  private sun: DirectionalLight;
  private layers: MapLayers | null = null;
  private floaters: Floater[] = [];
  /** Words pinned to places on the map, such as what plots of land cost; see setLabels. */
  private labels: { el: HTMLElement; pos: Vector3 }[] = [];
  private keys = new Set<string>();
  private raycaster = new Raycaster();
  private last = performance.now();
  private start = performance.now();
  private selectedId: number | null = null;
  private tmp = new Vector3();
  private sunTarget = new Vector3();
  private viewDir = new Vector3();
  private graphics: Graphics = { ...DEFAULT_GRAPHICS };

  constructor(
    private container: HTMLElement,
    private floaterLayer: HTMLElement,
  ) {
    this.gl = new WebGLRenderer({ antialias: true });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = PCFShadowMap;
    this.gl.toneMapping = ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.15;
    container.appendChild(this.gl.domElement);

    this.scene.background = new Color(C.waterDeep);
    this.scene.add(new HemisphereLight(0xeaf4ff, 0x8a7f6a, 1.6));
    this.sun = new DirectionalLight(0xfff1dc, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target, this.overlay.group);

    window.addEventListener('resize', () => this.resize());
    window.addEventListener('keydown', (e) => this.keys.add(e.key.toLowerCase()));
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    this.resize();
    this.gl.setAnimationLoop(() => this.frame());
  }

  get canvas(): HTMLCanvasElement {
    return this.gl.domElement;
  }

  /**
   * The view as a JPEG data: URL, at most `width` pixels across: drawn afresh
   * so the canvas still holds it, for a bug report (src/log/feedback.ts).
   */
  picture(width = 1280): string {
    this.gl.render(this.scene, this.cam.camera);
    const c = this.canvas;
    const scale = Math.min(1, width / c.width);
    const out = document.createElement('canvas');
    out.width = Math.round(c.width * scale);
    out.height = Math.round(c.height * scale);
    out.getContext('2d')?.drawImage(c, 0, 0, out.width, out.height);
    return out.toDataURL('image/jpeg', 0.75);
  }

  setMap(map: GameMap): void {
    if (this.layers) {
      this.scene.remove(this.layers.root);
      this.layers.water.dispose();
    }
    const water = new Water(map, SUN_DIR, WATER_LEVEL[this.graphics.water]);
    const structures = new Structures(map);
    const entities = new Entities(map);
    // A yard gantry reaches for the container slot on the truck it works.
    structures.truckSlot = (id, k, out) => entities.slotPosition(id, k, out);
    structures.slotShown = (id, k) => entities.slotShown(id, k);
    structures.slotObject = (id, k) => entities.slotObject(id, k);
    // Stackers and tractors pull up to the container they take or set down.
    entities.containerAt = (at, out) => structures.containerAt(at, out);
    // Forklifts keep their bodies off the crates.
    entities.crateIn = (x, z, pad) => structures.crateIn(x, z, pad);
    structures.slotTurn = (id, k) => entities.slotTurn(id, k);
    const trains = new Trains(map);
    const scenery = new Group();
    const trees = buildTrees(map);
    const land = buildLand(map);
    const rocks = buildRocks(map);
    const seabed = buildSeabed(map);
    const seabedDetail = buildSeabedDetail(map);
    scenery.add(seabed, seabedDetail, land, rocks, trees);
    const root = new Group();
    const designations = new Designations(map, (i) => structures.tileObject(i));
    root.add(water.mesh, scenery, structures.group, entities.group, trains.group, this.marks);
    root.add(designations.group);
    this.scene.add(root);
    this.layers = {
      map,
      root,
      water,
      structures,
      designations,
      entities,
      trains,
      scenery,
      seabed,
      seabedDetail,
      land,
      rocks,
      trees,
    };

    this.cam.setBounds(map.w, map.h);
    const entry = map.yOf(map.entry);
    // Start looking at the shore end of the entry road.
    let x = 0;
    while (x < map.w - 1 && map.build[map.idx(x + 1, entry)] !== 0) x++;
    this.cam.target.set(x - 2, 0, entry + 0.5);
  }

  /** Call after the changes are applied to the map. */
  applyTiles(
    changes: TileChange[],
    treesChanged: boolean,
    terrainChanged: boolean,
    seaChanged = false,
  ): void {
    if (!this.layers || changes.length === 0) return;
    this.layers.structures.apply(changes);
    if (treesChanged) this.refreshTrees();
    if (terrainChanged || seaChanged) this.refreshTerrain();
    if (seaChanged) this.refreshSea();
  }

  /** After dredging or reclaiming: the seabed and the water over it. */
  private refreshSea(): void {
    const l = this.layers!;
    l.scenery.remove(l.seabed, l.seabedDetail);
    l.seabed.geometry.dispose();
    l.seabed = buildSeabed(l.map);
    l.seabedDetail = buildSeabedDetail(l.map);
    l.scenery.add(l.seabed, l.seabedDetail);
    l.root.remove(l.water.mesh);
    l.water.dispose();
    l.water = new Water(l.map, SUN_DIR, WATER_LEVEL[this.graphics.water]);
    l.root.add(l.water.mesh);
  }

  private refreshTerrain(): void {
    const l = this.layers!;
    l.scenery.remove(l.land, l.rocks);
    l.land.geometry.dispose();
    l.land = buildLand(l.map);
    l.rocks = buildRocks(l.map);
    l.scenery.add(l.land, l.rocks);
  }

  private refreshTrees(): void {
    const l = this.layers!;
    l.scenery.remove(l.trees);
    l.trees = buildTrees(l.map);
    l.scenery.add(l.trees);
  }

  applySnapshot(s: Snapshot): void {
    if (!this.layers) return;
    this.layers.entities.push(s.entities, performance.now(), s.tick);
    this.layers.trains.push(s.train, s.speed, performance.now());
    this.layers.structures.setBays(s.bays);
    this.layers.structures.setYards(s.yards);
    this.layers.structures.setSpeed(s.speed);
    this.layers.structures.setTick(s.tick);
    this.layers.structures.setPiles(s.piles);
    this.layers.structures.setCranes(s.cranes);
    this.layers.designations.set(s.bays, s.yards, s.parking);
    this.layers.structures.setGates(s.entities.filter((e) => e.kind === 'truck'));
    this.setProblems(s.problems ?? []);
  }

  /** Red marks over what cannot work as it is built: see ProblemView. */
  private marks = new Group();
  private problems: ProblemView[] = [];
  /** One mark for each problem in the list, by its place in it. */
  private markOf = new KeyedObjects<number, Object3D>((mark) => this.marks.remove(mark));

  private setProblems(list: ProblemView[]): void {
    this.problems = list;
    this.markOf.sync(list.keys(), () => {
      const mark = alertMarker();
      mark.scale.setScalar(3.4);
      this.marks.add(mark);
      return mark;
    });
    list.forEach((p, k) => {
      const mark = this.markOf.get(k)!;
      mark.position.set(p.x, p.h, p.y);
      mark.userData.h = p.h;
    });
  }

  /** The red mark nearest a point on the screen, within reach of a click. */
  pickProblem(clientX: number, clientY: number): ProblemView | null {
    const rect = this.canvas.getBoundingClientRect();
    let best: ProblemView | null = null;
    let bestD = 30;
    this.problems.forEach((p, k) => {
      const mark = this.markOf.get(k);
      if (!mark) return;
      const s = toClient(
        this.tmp.copy(mark.position).setY(mark.position.y + 0.25),
        this.cam.camera,
        rect,
      );
      const d = Math.hypot(s.x - clientX, s.y - clientY);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    });
    return best;
  }

  select(id: number | null): void {
    this.selectedId = id;
  }

  /** Tile index under a screen point, or null outside the map. */
  pickTile(clientX: number, clientY: number): number | null {
    const map = this.layers?.map;
    if (!map) return null;
    const p = this.groundPoint(clientX, clientY);
    if (!p) return null;
    const x = Math.floor(p.x);
    const y = Math.floor(p.z);
    return map.inBounds(x, y) ? map.idx(x, y) : null;
  }

  /** Nearest entity to a screen point, within a small radius. */
  pickEntity(clientX: number, clientY: number): EntityView | null {
    if (!this.layers) return null;
    const rect = this.canvas.getBoundingClientRect();
    let best: EntityView | null = null;
    let bestD = 28;
    for (const { view, pos } of this.layers.entities.worldPositions()) {
      const s = toClient(this.tmp.copy(pos).setY(pos.y + 0.25), this.cam.camera, rect);
      const d = Math.hypot(s.x - clientX, s.y - clientY);
      if (d < bestD) {
        bestD = d;
        best = view;
      }
    }
    return best;
  }

  /** Screen position (client pixels) of a point in tile space. */
  screenOf(x: number, y: number, height = 0.3): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const s = toClient(this.tmp.set(x, height, y), this.cam.camera, rect);
    return { x: s.x, y: s.y };
  }

  showMoney(amount: number, x: number, y: number): void {
    const el = document.createElement('div');
    el.className = `floater ${amount >= 0 ? 'gain' : 'loss'}`;
    el.textContent = `${amount >= 0 ? '+' : '−'}$${Math.abs(amount).toLocaleString()}`;
    this.floaterLayer.appendChild(el);
    this.floaters.push({ el, pos: new Vector3(x, 0.8, y), born: performance.now() });
  }

  /**
   * Pin words to places on the map, `x`, `y` in tiles, replacing those
   * shown before; `tone` styles one (see .map-label in style.css).
   */
  setLabels(labels: { x: number; y: number; text: string; tone?: string }[]): void {
    for (const l of this.labels) l.el.remove();
    this.labels = labels.map((l) => {
      const el = document.createElement('div');
      el.className = `map-label ${l.tone ?? ''}`;
      el.textContent = l.text;
      this.floaterLayer.appendChild(el);
      return { el, pos: new Vector3(l.x, 0.5, l.y) };
    });
  }

  private groundPoint(clientX: number, clientY: number): Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.cam.camera);
    return this.raycaster.ray.intersectPlane(PICK_PLANE, new Vector3());
  }

  /**
   * Draw the game as the player has it: the sea's detail, the sun's
   * shadows, and how many pixels.
   */
  setGraphics(g: Graphics): void {
    this.graphics = { ...g };
    this.layers?.water.setQuality(WATER_LEVEL[g.water]);
    this.sun.castShadow = g.shadows !== 'off';
    if (g.shadows !== 'off') {
      const size = SHADOW_SIZE[g.shadows];
      if (this.sun.shadow.mapSize.x !== size) {
        this.sun.shadow.mapSize.set(size, size);
        // Made again at the new size when next drawn.
        this.sun.shadow.map?.dispose();
        this.sun.shadow.map = null;
      }
    }
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO[g.resolution]));
    // Fast draws fewer pixels than the screen has: scaled up sharp and
    // blocky, like pixel art, rather than blurred.
    this.gl.domElement.style.imageRendering = g.resolution === 'fast' ? 'pixelated' : '';
    this.resize();
  }

  private resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.gl.setSize(w, h);
    this.cam.resize(w, h);
  }

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const time = (now - this.start) / 1000;

    this.keyPan(dt);
    this.cam.update(dt);
    this.followSun();

    if (this.layers) {
      this.layers.water.update(
        time,
        this.viewDir.copy(this.cam.camera.position).sub(this.cam.target).normalize(),
        this.sun.shadow.camera.right * 2,
      );
      const eye = this.cam.camera.position;
      const to = this.cam.target;
      this.layers.entities.viewer = Math.atan2(eye.z - to.z, eye.x - to.x);
      this.layers.entities.update(now, time);
      this.layers.water.setWakes(this.layers.entities.wakes());
      this.layers.water.setStirs(this.layers.entities.stirs());
      this.layers.structures.setTrain(this.layers.trains.update(now));
      this.layers.structures.update(dt, time);
      // The red marks bob above what is wrong.
      for (const mark of this.marks.children) {
        mark.position.y = (mark.userData.h ?? 1.1) + Math.sin(time * 4) * 0.08;
      }
      (this.layers.seabed.userData.time as { value: number }).value = time;
      const pos =
        this.selectedId !== null
          ? this.layers.entities.positionOf(this.selectedId, this.tmp)
          : null;
      this.overlay.setRing(pos, 1);
    }
    this.updateFloaters(now);
    this.gl.render(this.scene, this.cam.camera);
  }

  private keyPan(dt: number): void {
    const k = this.keys;
    const speed = this.cam.viewSize * 0.9 * dt;
    let right = 0;
    let fwd = 0;
    if (k.has('a') || k.has('arrowleft')) right -= speed;
    if (k.has('d') || k.has('arrowright')) right += speed;
    if (k.has('w') || k.has('arrowup')) fwd += speed;
    if (k.has('s') || k.has('arrowdown')) fwd -= speed;
    if (right || fwd) this.cam.panWorld(right, fwd);
  }

  private followSun(): void {
    const s = this.cam.viewSize * 1.1;
    // Moving the shadow camera by fractions of a texel makes shadow edges
    // shimmer while panning, so snap it to the shadow-map grid.
    const texel = (2 * s) / this.sun.shadow.mapSize.x;
    const t = this.sunTarget.copy(this.cam.target);
    const r = t.dot(SUN_RIGHT);
    const u = t.dot(SUN_UP);
    t.addScaledVector(SUN_RIGHT, Math.round(r / texel) * texel - r);
    t.addScaledVector(SUN_UP, Math.round(u / texel) * texel - u);
    this.sun.position.copy(t).addScaledVector(SUN_DIR, 60);
    this.sun.target.position.copy(t);
    const sc = this.sun.shadow.camera;
    if (sc.right !== s) {
      sc.left = -s;
      sc.right = s;
      sc.top = s;
      sc.bottom = -s;
      sc.near = 1;
      sc.far = 140;
      sc.updateProjectionMatrix();
    }
  }

  private updateFloaters(now: number): void {
    const rect = this.canvas.getBoundingClientRect();
    for (const l of this.labels) {
      const s = toCanvas(l.pos, this.cam.camera, rect);
      l.el.style.display = s.off ? 'none' : '';
      if (!s.off) l.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -50%)`;
    }
    this.floaters = this.floaters.filter((f) => {
      const age = (now - f.born) / 1600;
      if (age >= 1) {
        f.el.remove();
        return false;
      }
      const s = toCanvas(this.tmp.copy(f.pos).setY(f.pos.y + age * 1.2), this.cam.camera, rect);
      f.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -50%)`;
      f.el.style.opacity = String(1 - age * age);
      return true;
    });
  }
}
