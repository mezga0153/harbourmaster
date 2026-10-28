import { BOAT_DRAFT, MAX_JETTY_DEPTH } from './balance';
import { GameMap } from './map';
import { fbm } from './noise';
import { Rng } from './rng';
import { Build, Deco, MAP_SIZE, Terrain } from './types';

export interface GeneratedMap {
  map: GameMap;
  /** Tile where the first dockhand starts, at the root of the jetty. */
  spawn: number;
}

/**
 * Seeded coastline: land on the low-x side, open sea on the high-x side.
 * See plan.md §11, Map generation.
 */
export function generateMap(seed: number, size = MAP_SIZE): GeneratedMap {
  const W = size;
  const H = size;
  const map = new GameMap(W, H);
  const rng = new Rng(seed ^ 0x9e3779b9);

  // Wobbly shoreline per row, then 2D noise for bays, headlands and islands.
  for (let y = 0; y < H; y++) {
    const shore = W * 0.42 + (fbm(seed, 3.7, y * 0.03, 3) - 0.5) * W * 0.45;
    for (let x = 0; x < W; x++) {
      const s = shore + (fbm(seed + 11, x * 0.07, y * 0.07) - 0.5) * 26;
      let land = x < s;
      if (x < 8) land = true;
      if (x >= W - 4) land = false;
      map.terrain[map.idx(x, y)] = land ? Terrain.Grass : Terrain.Water;
    }
  }

  // Ocean = water reachable from the open-sea edge. Inland ponds become land.
  const seaEdge: number[] = [];
  for (let y = 0; y < H; y++) seaEdge.push(map.idx(W - 1, y));
  floodFill(map, seaEdge, (i) => !map.isLand(i), map.ocean);
  for (let i = 0; i < W * H; i++) {
    if (!map.isLand(i) && !map.ocean[i]) map.terrain[i] = Terrain.Grass;
  }

  const landTiles: number[] = [];
  const oceanTiles: number[] = [];
  for (let i = 0; i < W * H; i++) (map.isLand(i) ? landTiles : oceanTiles).push(i);
  const distToLand = bfsDistance(map, landTiles);
  const distToSea = bfsDistance(map, oceanTiles);

  for (let i = 0; i < W * H; i++) {
    const x = map.xOf(i);
    const y = map.yOf(i);
    if (!map.isLand(i)) {
      const d = 0.8 + distToLand[i] * 0.55 + (fbm(seed + 23, x * 0.1, y * 0.1) - 0.5) * 6;
      // Rounded once here so saving (which keeps one decimal) never changes the map.
      map.depth[i] = Math.round(Math.min(24, Math.max(0.5, d)) * 10) / 10;
      continue;
    }
    const near = distToSea[i];
    if (near <= 1 || (near === 2 && fbm(seed + 31, x * 0.3, y * 0.3) > 0.55)) {
      map.terrain[i] = Terrain.Sand;
    } else if (near >= 3 && fbm(seed + 41, x * 0.12, y * 0.12) > 0.66) {
      map.terrain[i] = Terrain.Rock;
    } else if (fbm(seed + 53, x * 0.09, y * 0.09) > 0.53 && rng.next() < 0.55) {
      map.deco[i] = Deco.Tree;
    }
  }

  const spawn = layoutStart(map);
  return { map, spawn };
}

/** Find a row where a small jetty fits and lay out road, bay, path and jetty. */
function layoutStart(map: GameMap): number {
  const { w: W, h: H } = map;
  const cy = H >> 1;
  const isOcean = (x: number, y: number) => map.inBounds(x, y) && map.ocean[map.idx(x, y)] === 1;
  const firstOcean = (r: number) => {
    for (let x = 0; x < W; x++) if (isOcean(x, r)) return x;
    return -1;
  };

  let row = -1;
  let shoreX = -1;
  for (let k = 0; k < 60 && row < 0; k++) {
    const r = cy + (k % 2 === 0 ? k / 2 : -(k + 1) / 2);
    if (r < 3 || r > H - 4) continue;
    const xw = firstOcean(r);
    if (xw < 16 || xw > W - 12) continue;
    const xl = xw - 1;
    const fits =
      [1, 2, 3, 4].every((d) => isOcean(xl + d, r)) &&
      isOcean(xl + 3, r - 1) &&
      isOcean(xl + 3, r + 1) &&
      // Room for a boat to moor across the jetty tip.
      isOcean(xl + 4, r - 1) &&
      isOcean(xl + 4, r + 1) &&
      map.depth[map.idx(xl + 4, r)] >= BOAT_DRAFT;
    if (fits) {
      row = r;
      shoreX = xl;
    }
  }

  if (row < 0) {
    // Fallback: carve a small harbour into the middle row.
    row = cy;
    const xw = Math.max(16, firstOcean(row) < 0 ? W - 12 : firstOcean(row));
    shoreX = xw - 1;
    for (let y = row - 1; y <= row + 1; y++) {
      for (let x = shoreX + 1; x <= Math.min(W - 1, shoreX + 5); x++) {
        const i = map.idx(x, y);
        map.terrain[i] = Terrain.Water;
        map.ocean[i] = 1;
        map.deco[i] = Deco.None;
        map.depth[i] = Math.max(map.depth[i], BOAT_DRAFT + 0.5);
      }
    }
  }

  for (let x = 0; x <= shoreX; x++) {
    const i = map.idx(x, row);
    if (map.terrain[i] === Terrain.Rock || map.terrain[i] === Terrain.Water) {
      map.terrain[i] = Terrain.Grass;
      map.ocean[i] = 0;
      map.depth[i] = 0;
    }
    map.deco[i] = Deco.None;
  }
  for (let y = row - 2; y <= row + 2; y++) {
    for (let x = shoreX - 7; x <= shoreX; x++) {
      if (map.inBounds(x, y)) map.deco[map.idx(x, y)] = Deco.None;
    }
  }

  for (let x = 0; x <= shoreX - 5; x++) map.build[map.idx(x, row)] = Build.Road;
  map.build[map.idx(shoreX - 4, row)] = Build.TruckBay;
  map.orient[map.idx(shoreX - 4, row)] = 2; // entrance towards the road, -x
  for (let x = shoreX - 3; x <= shoreX; x++) map.build[map.idx(x, row)] = Build.Footpath;
  for (let x = shoreX + 1; x <= shoreX + 3; x++) {
    const i = map.idx(x, row);
    map.build[i] = Build.Jetty;
    map.depth[i] = Math.min(map.depth[i], MAX_JETTY_DEPTH - 0.5);
  }
  map.entry = map.idx(0, row);

  return map.idx(shoreX, row);
}

function floodFill(
  map: GameMap,
  seeds: number[],
  passable: (i: number) => boolean,
  out: Uint8Array,
): void {
  const stack = seeds.filter(passable);
  for (const s of stack) out[s] = 1;
  while (stack.length > 0) {
    const i = stack.pop()!;
    for (const n of map.neighbors4(i)) {
      if (!out[n] && passable(n)) {
        out[n] = 1;
        stack.push(n);
      }
    }
  }
}

/** 4-neighbour distance from the nearest source tile. */
function bfsDistance(map: GameMap, sources: number[]): Int32Array {
  const dist = new Int32Array(map.w * map.h).fill(-1);
  const queue = new Int32Array(map.w * map.h);
  let head = 0;
  let tail = 0;
  for (const s of sources) {
    dist[s] = 0;
    queue[tail++] = s;
  }
  while (head < tail) {
    const i = queue[head++];
    for (const n of map.neighbors4(i)) {
      if (dist[n] === -1) {
        dist[n] = dist[i] + 1;
        queue[tail++] = n;
      }
    }
  }
  return dist;
}
