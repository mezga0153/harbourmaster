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
import type { EntityView, Snapshot, TileChange } from '../protocol';
import type { GameMap } from '../sim/map';
import { IsoCamera } from './camera';
import { Entities } from './entities';
import { Overlay } from './overlay';
import { C } from './palette';
import { Structures } from './structures';
import { buildLand, buildRocks, buildSeabed, buildSeabedDetail, buildTrees } from './terrain';
import { Water } from './water';

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
  entities: Entities;
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
  private keys = new Set<string>();
  private raycaster = new Raycaster();
  private last = performance.now();
  private start = performance.now();
  private selectedId: number | null = null;
  private tmp = new Vector3();
  private sunTarget = new Vector3();
  private viewDir = new Vector3();

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

  setMap(map: GameMap): void {
    if (this.layers) {
      this.scene.remove(this.layers.root);
      this.layers.water.dispose();
    }
    const water = new Water(map, SUN_DIR);
    const structures = new Structures(map);
    const entities = new Entities(map);
    const scenery = new Group();
    const trees = buildTrees(map);
    const land = buildLand(map);
    const rocks = buildRocks(map);
    const seabed = buildSeabed(map);
    const seabedDetail = buildSeabedDetail(map);
    scenery.add(seabed, seabedDetail, land, rocks, trees);
    const root = new Group();
    root.add(water.mesh, scenery, structures.group, entities.group);
    this.scene.add(root);
    this.layers = {
      map,
      root,
      water,
      structures,
      entities,
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
    l.water = new Water(l.map, SUN_DIR);
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
    this.layers.structures.setBays(s.bays);
    this.layers.structures.setYards(s.yards);
    this.layers.structures.setCranes(s.cranes);
    this.layers.structures.setGates(s.entities.filter((e) => e.kind === 'truck'));
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
      const s = this.tmp
        .copy(pos)
        .setY(pos.y + 0.25)
        .project(this.cam.camera);
      const sx = rect.left + ((s.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - s.y) / 2) * rect.height;
      const d = Math.hypot(sx - clientX, sy - clientY);
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
    const s = this.tmp.set(x, height, y).project(this.cam.camera);
    return {
      x: rect.left + ((s.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - s.y) / 2) * rect.height,
    };
  }

  showMoney(amount: number, x: number, y: number): void {
    const el = document.createElement('div');
    el.className = `floater ${amount >= 0 ? 'gain' : 'loss'}`;
    el.textContent = `${amount >= 0 ? '+' : '−'}$${Math.abs(amount).toLocaleString()}`;
    this.floaterLayer.appendChild(el);
    this.floaters.push({ el, pos: new Vector3(x, 0.8, y), born: performance.now() });
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
      );
      this.layers.entities.update(now, time);
      this.layers.water.setWakes(this.layers.entities.wakes());
      this.layers.structures.update(dt, time);
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
    this.floaters = this.floaters.filter((f) => {
      const age = (now - f.born) / 1600;
      if (age >= 1) {
        f.el.remove();
        return false;
      }
      const s = this.tmp
        .copy(f.pos)
        .setY(f.pos.y + age * 1.2)
        .project(this.cam.camera);
      f.el.style.transform = `translate(${((s.x + 1) / 2) * rect.width}px, ${((1 - s.y) / 2) * rect.height}px) translate(-50%, -50%)`;
      f.el.style.opacity = String(1 - age * age);
      return true;
    });
  }
}
