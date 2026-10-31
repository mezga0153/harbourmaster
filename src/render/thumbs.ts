import {
  ACESFilmicToneMapping,
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  type Object3D,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { BayView, YardView } from '../protocol';
import { GameMap } from '../sim/map';
import { bestFacing, BUILDABLES, footprint, FORKLIFT_ONLY, partOrient } from '../sim/rules';
import { Build, Store, Terrain, type BuildKind } from '../sim/types';
import { forklift, stacker, tractor } from './machines';
import { boat } from './model';
import { Structures } from './structures';
import { buildLand, surfaceY } from './terrain';

/**
 * Pictures of what the build menu offers, Cities: Skylines style: each
 * building laid out on a little patch of shore, as it looks in the game,
 * and each machine on its own, rendered once and kept as an image.
 */

const W = 8;
const H = 7;
/** Land up to this column, sea beyond it. */
const COAST = 4;
const SIZE = [176, 120] as const;

type Patch = { map: GameMap; focus: number[]; stock?: { tiles: number[]; boxes: boolean } };

function patch(): GameMap {
  const m = new GameMap(W, H);
  for (let i = 0; i < W * H; i++) {
    const sea = m.xOf(i) >= COAST;
    m.terrain[i] = sea ? Terrain.Water : Terrain.Sand;
    m.depth[i] = sea ? 6 : 0;
    m.ocean[i] = sea ? 1 : 0;
  }
  m.entry = -1;
  return m;
}

const at = (m: GameMap, x: number, y: number) => m.idx(x, y);

function lay(m: GameMap, code: number, tiles: number[]): number[] {
  for (const t of tiles) m.build[t] = code;
  return tiles;
}

function row(m: GameMap, y: number, x0: number, x1: number): number[] {
  return Array.from({ length: x1 - x0 + 1 }, (_, k) => at(m, x0 + k, y));
}

function block(m: GameMap, x0: number, y0: number, x1: number, y1: number): number[] {
  const out: number[] = [];
  for (let y = y0; y <= y1; y++) out.push(...row(m, y, x0, x1));
  return out;
}

/** A building of `kind` with its main tile at `i`, facing the first way that works. */
function place(m: GameMap, kind: BuildKind, i: number): number[] {
  const f = bestFacing(m, kind, i);
  const tiles = footprint(m, kind, i, f).filter((t) => t >= 0);
  tiles.forEach((t, k) => {
    m.build[t] = BUILDABLES[kind].code;
    m.orient[t] = partOrient(f, k);
  });
  return tiles;
}

/** The quay along the shore, `deep` tiles in from the water. */
function quay(m: GameMap, deep: number, y0 = 1, y1 = H - 2): number[] {
  return lay(m, Build.Quay, block(m, COAST - deep, y0, COAST - 1, y1));
}

function scene(tool: string): Patch | null {
  const m = patch();
  const mid = 3;
  switch (tool) {
    case 'road':
    case 'footpath':
    case 'portRoad': {
      const code =
        tool === 'road' ? Build.Road : tool === 'footpath' ? Build.Footpath : Build.PortRoad;
      return {
        map: m,
        focus: lay(m, code, [...row(m, mid, 0, 3), at(m, 2, mid - 1), at(m, 2, mid + 1)]),
      };
    }
    case 'portGate': {
      lay(m, Build.Road, row(m, mid, 0, 1));
      lay(m, Build.PortRoad, row(m, mid, 3, 3));
      return {
        map: m,
        focus: [...place(m, 'portGate', at(m, 2, mid)), at(m, 1, mid), at(m, 3, mid)],
      };
    }
    case 'parking': {
      lay(m, Build.Road, [...row(m, 1, 0, 3), ...row(m, 4, 0, 3), at(m, 0, 2), at(m, 0, 3)]);
      return { map: m, focus: lay(m, Build.Parking, block(m, 1, 2, 3, 3)) };
    }
    case 'forkliftOnly': {
      const tiles = lay(m, Build.PortRoad, block(m, 1, 2, 3, 4));
      for (const t of tiles) m.orient[t] |= FORKLIFT_ONLY;
      return { map: m, focus: tiles };
    }
    case 'crateStore':
    case 'crateOutStore':
    case 'boxStore':
    case 'boxOutStore': {
      const code = {
        crateStore: Store.Crates,
        crateOutStore: Store.CratesOut,
        boxStore: Store.Boxes,
        boxOutStore: Store.BoxesOut,
      }[tool];
      lay(m, Build.PortRoad, block(m, 0, 1, 3, 5));
      const tiles = block(m, 1, 2, 2, 4);
      for (const t of tiles) m.store[t] = code;
      const boxes = tool === 'boxStore' || tool === 'boxOutStore';
      return { map: m, focus: tiles, stock: { tiles, boxes } };
    }
    case 'yardGantry': {
      lay(m, Build.PortRoad, block(m, 0, 1, 3, 5));
      const tiles = block(m, 1, 1, 2, 5);
      for (const t of tiles) m.store[t] = Store.Boxes;
      const g = place(m, 'yardGantry', at(m, 3, mid));
      return { map: m, focus: [...tiles, ...g], stock: { tiles, boxes: true } };
    }
    case 'jetty':
      lay(m, Build.Road, row(m, mid, 0, COAST - 1));
      return { map: m, focus: lay(m, Build.Jetty, row(m, mid, COAST, COAST + 2)) };
    case 'quay':
      return { map: m, focus: lay(m, Build.Quay, block(m, COAST, 1, COAST, 5)) };
    case 'buoyIn':
    case 'buoyOut':
      return {
        map: m,
        focus: lay(m, tool === 'buoyIn' ? Build.BuoyIn : Build.BuoyOut, [at(m, 5, mid)]),
      };
    case 'tugBerth': {
      quay(m, 2);
      return { map: m, focus: [...place(m, 'tugBerth', at(m, COAST, mid)), at(m, COAST - 1, mid)] };
    }
    case 'jibCrane':
    case 'harbourCrane': {
      quay(m, 2);
      return { map: m, focus: place(m, tool, at(m, COAST - 1, mid)) };
    }
    case 'gantryCrane': {
      quay(m, 3, 0, H - 1);
      return { map: m, focus: place(m, 'gantryCrane', at(m, COAST - 1, 2)) };
    }
    case 'office':
    case 'harbourHut':
    case 'depot':
    case 'breakHut':
    case 'truckBay':
    case 'largeBay': {
      lay(
        m,
        tool === 'truckBay' || tool === 'largeBay' ? Build.Road : Build.Footpath,
        row(m, 4, 0, 3),
      );
      return { map: m, focus: place(m, tool, at(m, 1, mid)) };
    }
    default:
      return null;
  }
}

/** A machine or tug on its own. */
function machine(tool: string): Object3D | null {
  switch (tool) {
    case 'forklift':
      return forklift().root;
    case 'stacker':
      return stacker().root;
    case 'tractor':
      return tractor().root;
    case 'tug':
      return boat(0, 'tug', 1).root;
    default:
      return null;
  }
}

/** The tools that have a picture, and so a stage. */
export const PICTURED: readonly string[] = [
  'road',
  'footpath',
  'portRoad',
  'portGate',
  'parking',
  'forkliftOnly',
  'crateStore',
  'crateOutStore',
  'boxStore',
  'boxOutStore',
  'yardGantry',
  'jetty',
  'quay',
  'buoyIn',
  'buoyOut',
  'tugBerth',
  'jibCrane',
  'harbourCrane',
  'gantryCrane',
  'office',
  'harbourHut',
  'depot',
  'breakHut',
  'truckBay',
  'largeBay',
  'forklift',
  'stacker',
  'tractor',
  'tug',
];

let gl: WebGLRenderer | null = null;

function renderer(): WebGLRenderer {
  if (gl) return gl;
  gl = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  gl.setPixelRatio(2);
  gl.setSize(SIZE[0], SIZE[1], false);
  gl.outputColorSpace = SRGBColorSpace;
  gl.toneMapping = ACESFilmicToneMapping;
  gl.toneMappingExposure = 1.15;
  return gl;
}

function shoot(content: Object3D, box: Box3): string {
  const s = new Scene();
  s.add(new HemisphereLight(0xeaf4ff, 0x8a7f6a, 1.6));
  const sun = new DirectionalLight(0xfff1dc, 2.4);
  sun.position.set(-4, 8, 3);
  s.add(sun, content);
  const centre = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3());
  const cam = new OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const pitch = Math.atan(1 / Math.SQRT2);
  const yaw = Math.PI / 4;
  cam.position.set(
    centre.x + Math.cos(pitch) * Math.sin(yaw) * 30,
    centre.y + Math.sin(pitch) * 30,
    centre.z + Math.cos(pitch) * Math.cos(yaw) * 30,
  );
  cam.lookAt(centre);
  cam.updateMatrixWorld();
  // Half extents of the box as the camera sees it.
  const corners: Vector3[] = [];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z])
        corners.push(new Vector3(x, y, z).applyMatrix4(cam.matrixWorldInverse));
  const hw = Math.max(...corners.map((c) => Math.abs(c.x))) * 1.04;
  const hh = Math.max(...corners.map((c) => Math.abs(c.y))) * 1.04;
  const aspect = SIZE[0] / SIZE[1];
  const half = Math.max(hw / aspect, hh, size.length() * 0.05);
  cam.left = -half * aspect;
  cam.right = half * aspect;
  cam.top = half;
  cam.bottom = -half;
  cam.updateProjectionMatrix();
  const r = renderer();
  r.render(s, cam);
  return r.domElement.toDataURL('image/png');
}

/** A tool laid out on its patch of shore, as `thumbnail` pictures it; the dev page (src/dev/) shows it live. */
export interface Staged {
  content: Group;
  /** What matters, from its ground to its top. */
  box: Box3;
  structures: Structures;
  map: GameMap;
}

/** `tool` on a little patch of shore, as its build menu card shows it, or null for a tool with no picture. */
export function stage(tool: string): Staged | null {
  const one = machine(tool);
  // A machine stands on a patch of port road; a tug lies off the quay.
  const p: Patch | null = one
    ? (() => {
        const m = patch();
        if (tool === 'tug') quay(m, 2);
        else lay(m, Build.PortRoad, block(m, 0, 1, 3, 5));
        return { map: m, focus: [] } as Patch;
      })()
    : scene(tool);
  if (!p) return null;
  const structures = new Structures(p.map, true);
  if (p.stock) {
    const { tiles, boxes } = p.stock;
    const n = tiles.length * (boxes ? 4 : 10);
    if (boxes)
      structures.setYards([{ tiles, boxes: n, exports: 0, looks: [] } as unknown as YardView]);
    else structures.setBays([{ tiles, stock: n, exports: 0 } as unknown as BayView]);
  }
  const land = buildLand(p.map);
  const water = new Mesh(
    new PlaneGeometry(W - COAST + 40, H + 40),
    new MeshLambertMaterial({ color: 0x3f8fc9 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(COAST + (W - COAST + 40) / 2, -0.02, H / 2);
  const content = new Group();
  content.add(land, water, structures.group);
  if (one) {
    const [x, y] = tool === 'tug' ? [COAST + 1, 3] : [2, 3];
    one.position.set(x + 0.5, tool === 'tug' ? 0 : surfaceY(p.map, x + 0.5, y + 0.5), y + 0.5);
    one.rotation.y = Math.PI / 2;
    content.add(one);
  }
  // Frame the tiles laid out, from their ground to their tops.
  content.updateMatrixWorld(true);
  const box = new Box3();
  if (one) box.expandByObject(one);
  for (const t of p.focus) {
    const obj = structures.tileObject(t);
    if (obj) box.expandByObject(obj);
  }
  if (box.isEmpty()) box.setFromObject(structures.group);
  // Seen as the game sees it: never the quay walls down to the seabed.
  box.min.y = Math.max(box.min.y, -0.05);
  return { content, box, structures, map: p.map };
}

function picture(tool: string): string | null {
  const s = stage(tool);
  return s ? shoot(s.content, s.box) : null;
}

const cache = new Map<string, string | null>();

/** A picture of `tool` for its build menu card, or null to show its icon. */
export function thumbnail(tool: string): string | null {
  if (!cache.has(tool)) {
    let url: string | null = null;
    try {
      url = picture(tool);
    } catch (err) {
      console.warn(`No picture for ${tool}`, err);
    }
    cache.set(tool, url);
  }
  return cache.get(tool) ?? null;
}
