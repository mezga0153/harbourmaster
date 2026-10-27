import {
  BufferGeometry,
  DodecahedronGeometry,
  Euler,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three';
import type { GameMap } from '../sim/map';
import { hash01 } from '../sim/noise';
import { Build, Deco, Terrain } from '../sim/types';
import { C } from './palette';

/** How far the scenery continues past the playable map edge, in tiles. */
export const MARGIN = 40;
/** Bottom of cliffs, piles and quay walls; below the deepest seabed shown. */
export const SEABED = -1.1;
export const DECK_Y = 0.42;
export const QUAY_Y = 0.36;

const up = new Vector3(0, 1, 0);

const TOP: Record<number, number> = {
  [Terrain.Water]: SEABED,
  [Terrain.Sand]: 0.24,
  [Terrain.Grass]: 0.3,
  [Terrain.Rock]: 0.3,
};
const TOP_COLOR: Record<number, number> = {
  [Terrain.Sand]: C.sand,
  [Terrain.Grass]: C.grass,
  [Terrain.Rock]: C.rockGround,
};
const SIDE_COLOR: Record<number, number> = {
  [Terrain.Sand]: C.sandSide,
  [Terrain.Grass]: C.grassSide,
  [Terrain.Rock]: C.grassSide,
};

/** Terrain code, continuing edge tiles outward beyond the map. */
function terrainAt(map: GameMap, x: number, y: number): number {
  if (x < -MARGIN || y < -MARGIN || x >= map.w + MARGIN || y >= map.h + MARGIN) {
    return Terrain.Water;
  }
  const inside = map.inBounds(x, y);
  const cx = Math.min(map.w - 1, Math.max(0, x));
  const cy = Math.min(map.h - 1, Math.max(0, y));
  const t = map.terrain[map.idx(cx, cy)];
  return !inside && t === Terrain.Rock ? Terrain.Grass : t;
}

/** Height of the walkable surface at a tile: deck, paving or ground. */
export function surfaceY(map: GameMap, x: number, y: number): number {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (!map.inBounds(tx, ty)) return TOP[terrainAt(map, tx, ty)];
  const i = map.idx(tx, ty);
  const b = map.build[i];
  if (b === Build.Jetty) return DECK_Y;
  if (b === Build.Quay || b === Build.JibCrane) return QUAY_Y;
  const t = map.terrain[i];
  if (t === Terrain.Water) return 0;
  return TOP[t] + (b === Build.None ? 0 : 0.05);
}

export function landTop(t: number): number {
  return TOP[t];
}

/** Seabed height for a water depth in metres (squashed so it reads well). */
export function seabedY(depth: number): number {
  return -0.06 - Math.min(depth, 10) * 0.1;
}

/**
 * Smooth seabed under the transparent sea: sand in the shallows, weed and
 * then dark water further out. Heights follow the real depth.
 */
export function buildSeabed(map: GameMap): Mesh {
  const tileDepth = (x: number, y: number) => {
    if (x < -MARGIN || y < -MARGIN || x >= map.w + MARGIN || y >= map.h + MARGIN) return 12;
    const cx = Math.min(map.w - 1, Math.max(0, x));
    const cy = Math.min(map.h - 1, Math.max(0, y));
    const i = map.idx(cx, cy);
    return map.isLand(i) ? 0 : map.depth[i];
  };
  const x0 = -MARGIN;
  const y0 = -MARGIN;
  const nx = map.w + MARGIN * 2 + 1;
  const ny = map.h + MARGIN * 2 + 1;
  const pos = new Float32Array(nx * ny * 3);
  const col = new Float32Array(nx * ny * 3);
  const sand = new Color(C.seabedSand);
  const weed = new Color(C.seabedWeed);
  const deep = new Color(C.seabedDeep);
  const c = new Color();
  for (let j = 0; j < ny; j++) {
    for (let k = 0; k < nx; k++) {
      const x = x0 + k;
      const y = y0 + j;
      // Corner height: average of the four tiles that meet here.
      const d =
        (tileDepth(x - 1, y - 1) + tileDepth(x, y - 1) + tileDepth(x - 1, y) + tileDepth(x, y)) / 4;
      const v = (j * nx + k) * 3;
      pos[v] = x;
      pos[v + 1] = seabedY(d);
      pos[v + 2] = y;
      if (d < 2.5) c.copy(sand).lerp(weed, d / 2.5);
      else c.copy(weed).lerp(deep, Math.min(1, (d - 2.5) / 6));
      c.multiplyScalar(0.94 + hash01(5, x, y) * 0.08);
      col[v] = c.r;
      col[v + 1] = c.g;
      col[v + 2] = c.b;
    }
  }
  const index: number[] = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let k = 0; k < nx - 1; k++) {
      const a = j * nx + k;
      index.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const mesh = new Mesh(geo, new MeshLambertMaterial({ vertexColors: true }));
  mesh.receiveShadow = true;
  return mesh;
}

/** One merged, flat-shaded mesh of blocky land tiles with cliff sides. */
export function buildLand(map: GameMap): Mesh {
  const pos: number[] = [];
  const col: number[] = [];
  const c = new Color();
  const a = new Vector3();
  const b = new Vector3();
  const n = new Vector3();

  const tri = (p: number[][], color: Color, normal: Vector3) => {
    // Flip winding when needed so faces point the expected way.
    a.set(p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]);
    b.set(p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]);
    n.crossVectors(a, b);
    const order = n.dot(normal) >= 0 ? [0, 1, 2] : [0, 2, 1];
    for (const k of order) {
      pos.push(...p[k]);
      col.push(color.r, color.g, color.b);
    }
  };
  const quad = (p: number[][], color: Color, normal: Vector3) => {
    tri([p[0], p[1], p[2]], color, normal);
    tri([p[0], p[2], p[3]], color, normal);
  };

  const sides = [
    { dx: 1, dy: 0, n: new Vector3(1, 0, 0) },
    { dx: -1, dy: 0, n: new Vector3(-1, 0, 0) },
    { dx: 0, dy: 1, n: new Vector3(0, 0, 1) },
    { dx: 0, dy: -1, n: new Vector3(0, 0, -1) },
  ];

  for (let y = -MARGIN; y < map.h + MARGIN; y++) {
    for (let x = -MARGIN; x < map.w + MARGIN; x++) {
      const t = terrainAt(map, x, y);
      if (t === Terrain.Water) continue;
      const h = TOP[t];
      const outside = !map.inBounds(x, y);
      const jitter = 0.96 + hash01(17, x, y) * 0.06;
      c.setHex(TOP_COLOR[t]).multiplyScalar(jitter * (outside ? 0.9 : 1));
      quad(
        [
          [x, h, y],
          [x + 1, h, y],
          [x + 1, h, y + 1],
          [x, h, y + 1],
        ],
        c,
        up,
      );

      for (const s of sides) {
        const nh = TOP[terrainAt(map, x + s.dx, y + s.dy)];
        if (nh >= h) continue;
        c.setHex(SIDE_COLOR[t]).multiplyScalar(outside ? 0.9 : 1);
        // Edge shared with the neighbour, as two corner points.
        const x0 = s.dx === 1 ? x + 1 : x;
        const z0 = s.dy === 1 ? y + 1 : y;
        const x1 = s.dx === 0 ? x + 1 : x0;
        const z1 = s.dy === 0 ? y + 1 : z0;
        quad(
          [
            [x0, nh, z0],
            [x1, nh, z1],
            [x1, h, z1],
            [x0, h, z0],
          ],
          c,
          s.n,
        );
      }
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mesh = new Mesh(geo, new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return mesh;
}

/** Instanced low-poly trees for tree tiles, plus scenery trees outside the map. */
export function buildTrees(map: GameMap): Group {
  const spots: { x: number; y: number; s: number; v: number }[] = [];
  for (let y = -MARGIN; y < map.h + MARGIN; y++) {
    for (let x = -MARGIN; x < map.w + MARGIN; x++) {
      const inside = map.inBounds(x, y);
      const tree = inside
        ? map.deco[map.idx(x, y)] === Deco.Tree
        : terrainAt(map, x, y) === Terrain.Grass && hash01(7, x, y) < 0.1;
      if (!tree) continue;
      // Keep the scenery road clear.
      if (!inside && y === map.yOf(map.entry) && x < 0) continue;
      spots.push({ x, y, s: 0.8 + hash01(9, x, y) * 0.5, v: hash01(13, x, y) });
    }
  }

  const trunkGeo = new CylinderGeometry(0.05, 0.07, 0.25, 5);
  trunkGeo.translate(0, 0.125, 0);
  const leafGeo = new ConeGeometry(0.3, 0.7, 6);
  leafGeo.translate(0, 0.55, 0);
  const trunks = new InstancedMesh(
    trunkGeo,
    new MeshLambertMaterial({ color: C.trunk, flatShading: true }),
    Math.max(1, spots.length),
  );
  const leaves = new InstancedMesh(
    leafGeo,
    new MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
    Math.max(1, spots.length),
  );
  const m = new Matrix4();
  const q = new Quaternion();
  const p = new Vector3();
  const s = new Vector3();
  const color = new Color();
  spots.forEach((t, k) => {
    p.set(t.x + 0.5 + (t.v - 0.5) * 0.3, TOP[Terrain.Grass], t.y + 0.5);
    q.setFromAxisAngle(up, t.v * Math.PI * 2);
    s.setScalar(t.s);
    m.compose(p, q, s);
    trunks.setMatrixAt(k, m);
    leaves.setMatrixAt(k, m);
    leaves.setColorAt(k, color.setHex(C.leaves[Math.floor(t.v * C.leaves.length)]));
  });
  trunks.count = leaves.count = spots.length;
  for (const mesh of [trunks, leaves]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  const group = new Group();
  group.add(trunks, leaves);
  return group;
}

/** Low-poly boulders on rock tiles. Rock is static, so this is built once. */
export function buildRocks(map: GameMap): InstancedMesh {
  const spots: { x: number; y: number; k: number }[] = [];
  for (let i = 0; i < map.terrain.length; i++) {
    if (map.terrain[i] !== Terrain.Rock) continue;
    const x = map.xOf(i);
    const y = map.yOf(i);
    const n = 1 + Math.floor(hash01(21, x, y) * 3);
    for (let k = 0; k < n; k++) spots.push({ x, y, k });
  }
  const mesh = new InstancedMesh(
    new DodecahedronGeometry(0.3, 0),
    new MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
    Math.max(1, spots.length),
  );
  const m = new Matrix4();
  const q = new Quaternion();
  const p = new Vector3();
  const s = new Vector3();
  const e = new Euler();
  const color = new Color();
  spots.forEach(({ x, y, k }, j) => {
    const r = (o: number) => hash01(31 + k * 7 + o, x, y);
    const size = k === 0 ? 0.9 + r(1) * 0.5 : 0.45 + r(1) * 0.4;
    p.set(x + 0.2 + r(2) * 0.6, TOP[Terrain.Rock] + 0.05, y + 0.2 + r(3) * 0.6);
    q.setFromEuler(e.set(r(4) * 3, r(5) * 6, r(6) * 3));
    s.set(size, size * (0.6 + r(7) * 0.4), size);
    m.compose(p, q, s);
    mesh.setMatrixAt(j, m);
    mesh.setColorAt(j, color.setHex(C.rock).multiplyScalar(0.85 + r(8) * 0.25));
  });
  mesh.count = spots.length;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
