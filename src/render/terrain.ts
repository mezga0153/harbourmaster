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
  type Object3D,
} from 'three';
import type { GameMap } from '../sim/map';
import { hash01 } from '../sim/noise';
import { Build, Deco, Terrain } from '../sim/types';
import { C } from './palette';
import { hasAsset, instanced, ROCKS, TREES, type AssetName } from './assets';

/** How far the scenery continues past the playable map edge, in tiles. */
export const MARGIN = 40;
/** Bottom of cliffs, piles and quay walls; below the deepest seabed shown. */
export const SEABED = -1.1;
export const DECK_Y = 0.42;
export const QUAY_Y = 0.36;

const up = new Vector3(0, 1, 0);

const TOP: Record<number, number> = {
  [Terrain.Water]: SEABED,
  [Terrain.Sand]: 0.3,
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
  if (
    b === Build.Quay ||
    b === Build.JibCrane ||
    b === Build.HarbourCrane ||
    b === Build.PortRoad
  ) {
    return QUAY_Y;
  }
  const t = map.terrain[i];
  if (t === Terrain.Water) return 0;
  return TOP[t] + (b === Build.None ? 0 : b === Build.Footpath ? 0.03 : 0.05);
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
  const material = new MeshLambertMaterial({ vertexColors: true });
  // Sand ripples in the shallows and caustics: sunlight focused by the waves.
  const time = { value: 0 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSeaWorld;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvSeaWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SEABED_GLSL}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float shallow = smoothstep(-0.6, -0.12, vSeaWorld.y);
        float sandRipple = sin(dot(vSeaWorld.xz, vec2(3.1, 1.4)) + seaNoise(vSeaWorld.xz * 0.8) * 3.0);
        diffuseColor.rgb *= 1.0 + 0.08 * sandRipple * shallow;
        diffuseColor.rgb *= 0.92 + 0.16 * seaNoise(vSeaWorld.xz * 0.35);`,
      )
      .replace(
        '#include <opaque_fragment>',
        `#include <opaque_fragment>
        float caustics = causticLight(vSeaWorld.xz, uTime);
        gl_FragColor.rgb += vec3(0.85, 1.0, 0.95) * caustics * shallow * 0.35;`,
      );
  };
  const mesh = new Mesh(geo, material);
  mesh.userData.time = time;
  mesh.receiveShadow = true;
  return mesh;
}

const SEABED_GLSL = /* glsl */ `
  uniform float uTime;
  varying vec3 vSeaWorld;

  float seaHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float seaNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(seaHash(i), seaHash(i + vec2(1.0, 0.0)), u.x),
      mix(seaHash(i + vec2(0.0, 1.0)), seaHash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  // A web of bright lines where two drifting noise ridges meet.
  float causticLight(vec2 p, float t) {
    float a = abs(seaNoise(p * 1.6 + vec2(t * 0.35, t * 0.2)) - 0.5);
    float b = abs(seaNoise(p * 2.4 - vec2(t * 0.25, -t * 0.3) + 7.3) - 0.5);
    return pow(1.0 - min(a, b) * 2.0, 12.0);
  }
`;

/** Pebbles, rocks and clumps of seaweed scattered across the seabed. */
export function buildSeabedDetail(map: GameMap): Group {
  const rocks: { x: number; y: number; z: number; s: number; v: number }[] = [];
  const weed: { x: number; y: number; z: number; s: number; v: number; tilt: number }[] = [];
  for (let i = 0; i < map.terrain.length; i++) {
    if (map.isLand(i) || map.build[i] === Build.Quay || map.build[i] === Build.JibCrane) continue;
    const d = map.depth[i];
    const x = map.xOf(i);
    const y = map.yOf(i);
    const floor = seabedY(d);
    if (d > 0.6 && d < 8 && hash01(41, x, y) < 0.16) {
      const n = 1 + Math.floor(hash01(43, x, y) * 3);
      for (let k = 0; k < n; k++) {
        rocks.push({
          x: x + 0.15 + hash01(47 + k, x, y) * 0.7,
          y: floor,
          z: y + 0.15 + hash01(53 + k, x, y) * 0.7,
          s: 0.5 + hash01(59 + k, x, y) * 1.1,
          v: hash01(61 + k, x, y),
        });
      }
    }
    if (d > 1.2 && d < 6.5 && hash01(67, x, y) < 0.2) {
      const n = 3 + Math.floor(hash01(71, x, y) * 4);
      const cx = x + 0.25 + hash01(73, x, y) * 0.5;
      const cz = y + 0.25 + hash01(79, x, y) * 0.5;
      for (let k = 0; k < n; k++) {
        weed.push({
          x: cx + (hash01(83 + k, x, y) - 0.5) * 0.3,
          y: floor,
          z: cz + (hash01(89 + k, x, y) - 0.5) * 0.3,
          s: 0.6 + hash01(97 + k, x, y) * 0.9,
          v: hash01(101 + k, x, y),
          tilt: (hash01(103 + k, x, y) - 0.5) * 0.5,
        });
      }
    }
  }

  const group = new Group();
  const m = new Matrix4();
  const q = new Quaternion();
  const p = new Vector3();
  const sc = new Vector3();
  const e = new Euler();
  const color = new Color();

  const rockMesh = new InstancedMesh(
    new DodecahedronGeometry(0.09, 0),
    new MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
    Math.max(1, rocks.length),
  );
  rocks.forEach((r, k) => {
    p.set(r.x, r.y + 0.02, r.z);
    q.setFromEuler(e.set(r.v * 3, r.v * 7, r.v * 5));
    sc.set(r.s, r.s * 0.6, r.s);
    m.compose(p, q, sc);
    rockMesh.setMatrixAt(k, m);
    rockMesh.setColorAt(
      k,
      color.setHex(r.v < 0.5 ? C.rock : C.seabedRock).multiplyScalar(0.8 + r.v * 0.3),
    );
  });
  rockMesh.count = rocks.length;

  const strand = new ConeGeometry(0.035, 0.32, 4);
  strand.translate(0, 0.16, 0);
  const weedMesh = new InstancedMesh(
    strand,
    new MeshLambertMaterial({ color: 0xffffff, flatShading: true }),
    Math.max(1, weed.length),
  );
  weed.forEach((w, k) => {
    p.set(w.x, w.y, w.z);
    q.setFromEuler(e.set(w.tilt, w.v * 6, w.tilt * 0.6));
    sc.set(1, w.s, 1);
    m.compose(p, q, sc);
    weedMesh.setMatrixAt(k, m);
    weedMesh.setColorAt(k, color.setHex(C.seaweed[Math.floor(w.v * C.seaweed.length)]));
  });
  weedMesh.count = weed.length;

  for (const mesh of [rockMesh, weedMesh]) {
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
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

  const kenney = kenneyScatter(
    TREES,
    spots.map((t) => ({
      x: t.x + 0.5 + (t.v - 0.5) * 0.3,
      y: TOP[Terrain.Grass],
      z: t.y + 0.5,
      yaw: t.v * Math.PI * 2,
      scale: 0.75 + (t.s - 0.8) * 0.9,
      pick: hash01(19, t.x, t.y),
    })),
  );
  if (kenney) return kenney;

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

interface Scatter {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  /** 0..1, chooses which model variant goes here. */
  pick: number;
}

/** Place a mix of Kenney models, or null if they did not load. */
function kenneyScatter(variants: AssetName[], spots: Scatter[]): Group | null {
  const available = variants.filter(hasAsset);
  if (available.length === 0) return null;
  const byVariant = available.map(() => [] as Matrix4[]);
  const q = new Quaternion();
  const p = new Vector3();
  const s = new Vector3();
  for (const t of spots) {
    const k = Math.min(available.length - 1, Math.floor(t.pick * available.length));
    q.setFromAxisAngle(up, t.yaw);
    byVariant[k].push(new Matrix4().compose(p.set(t.x, t.y, t.z), q, s.setScalar(t.scale)));
  }
  const group = new Group();
  available.forEach((name, k) => {
    const part = byVariant[k].length > 0 ? instanced(name, byVariant[k]) : null;
    if (part) group.add(part);
  });
  return group;
}

/** Low-poly boulders on rock tiles. Rock is static, so this is built once. */
export function buildRocks(map: GameMap): Object3D {
  const spots: { x: number; y: number; k: number }[] = [];
  for (let i = 0; i < map.terrain.length; i++) {
    if (map.terrain[i] !== Terrain.Rock) continue;
    const x = map.xOf(i);
    const y = map.yOf(i);
    const n = 1 + Math.floor(hash01(21, x, y) * 3);
    for (let k = 0; k < n; k++) spots.push({ x, y, k });
  }
  const kenney = kenneyScatter(
    ROCKS,
    spots.map(({ x, y, k }) => {
      const r = (o: number) => hash01(31 + k * 7 + o, x, y);
      return {
        x: x + 0.2 + r(2) * 0.6,
        y: TOP[Terrain.Rock],
        z: y + 0.2 + r(3) * 0.6,
        yaw: r(5) * 6,
        scale: k === 0 ? 1.1 + r(1) * 0.5 : 0.6 + r(1) * 0.4,
        pick: r(9),
      };
    }),
  );
  if (kenney) return kenney;
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
