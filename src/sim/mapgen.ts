import { BOAT_DRAFT, MAX_JETTY_DEPTH, MAX_QUAY_DEPTH } from './balance';
import { ownOnly, startPlots } from './land';
import { GameMap } from './map';
import { fbm } from './noise';
import { Rng } from './rng';
import { HIGHWAY_COLUMNS, layHighway, setExit } from './roads';
import { Build, Deco, MAP_SIZE, Terrain, townBand } from './types';

export interface GeneratedMap {
  map: GameMap;
  /** Tile where the first dockhand starts, at the root of the jetty. */
  spawn: number;
}

/**
 * Seeded coastline: land on the low-x side, open sea on the high-x side.
 * The port's land is `size` square; `band` more rows of the same coast run
 * on past it to the south, where the town is. See plan.md §11, Map generation.
 */
export function generateMap(seed: number, size = MAP_SIZE, band = townBand(size)): GeneratedMap {
  const W = size;
  const H = size + band;
  const map = new GameMap(W, H, size);
  const rng = new Rng(seed ^ 0x9e3779b9);

  // Wobbly shoreline per row, then 2D noise for bays, headlands and islands.
  for (let y = 0; y < H; y++) {
    // On the bigger maps the coast keeps nearer the highway, with more sea off it;
    // the 96-tile maps of old saves come out as they always did.
    const big = W > 96;
    const shore =
      W * (big ? 0.32 : 0.42) +
      (fbm(seed, 3.7, y * (big ? 0.02 : 0.03), 3) - 0.5) * W * (big ? 0.4 : 0.45);
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
      const d = seaDepth(
        distToLand[i],
        fbm(seed + 23, x * 0.1, y * 0.1),
        fbm(seed + 29, x * 0.05, y * 0.05),
        W,
      );
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

  layHighway(map, []);
  const spawn = layoutStart(map);
  return { map, spawn };
}

/** Just too deep for a quay: one go of filling in, and a quay can stand there. */
export const SHELF_DEPTH = MAX_QUAY_DEPTH + 1.2;

/**
 * How deep the sea is `dist` tiles out from land, with `n` and `slow` two
 * noise values from 0 to 1. It shelves down from the beach as it always
 * did, past where a quay can stand, then lies a little too deep for one
 * over a broad shelf, a third of the way across the map's sea, before
 * dropping away to the deep water off the edge.
 */
export function seaDepth(dist: number, n: number, slow: number, size: number): number {
  const slope = 0.8 + dist * 0.55 + (n - 0.5) * 6;
  // Where the slope reaches the shelf, and how far out the shelf runs.
  const start = (SHELF_DEPTH - 0.8) / 0.55;
  const width = size * 0.12 + (slow - 0.5) * size * 0.08;
  const shelf = SHELF_DEPTH - 0.3 + (n - 0.5) * 1.2;
  if (dist <= start + width) return Math.min(slope, shelf);
  const drop = SHELF_DEPTH + (dist - start - width) * 0.55 + (n - 0.5) * 4;
  return Math.max(shelf, drop);
}

/** Find a row where a small jetty fits and lay out road, bay, path and jetty. */
function layoutStart(map: GameMap): number {
  const { w: W } = map;
  const cy = map.limit >> 1;
  const isOcean = (x: number, y: number) => map.inBounds(x, y) && map.ocean[map.idx(x, y)] === 1;
  const firstOcean = (r: number) => {
    for (let x = 0; x < W; x++) if (isOcean(x, r)) return x;
    return -1;
  };

  let row = -1;
  let shoreX = -1;
  const fits = (r: number, xl: number) =>
    [1, 2, 3, 4].every((d) => isOcean(xl + d, r)) &&
    isOcean(xl + 3, r - 1) &&
    isOcean(xl + 3, r + 1) &&
    // Room for a boat to moor across the jetty tip.
    isOcean(xl + 4, r - 1) &&
    isOcean(xl + 4, r + 1) &&
    map.depth[map.idx(xl + 4, r)] >= BOAT_DRAFT;
  if (W > 96) {
    // A big map: on a point of land running out into the sea, with the
    // coast either side of it further in, rather than in a bay, well away
    // from the ends of the port's land; the furthest out, nearest the
    // middle as far out.
    const LOOK = 5;
    let most = 1;
    for (let r = Math.round(map.limit * 0.25); r <= Math.round(map.limit * 0.75); r++) {
      const xw = firstOcean(r);
      if (xw < 16 || xw > W - 12 || !fits(r, xw - 1)) continue;
      const sides = [firstOcean(r - LOOK), firstOcean(r + LOOK)];
      if (sides.some((x) => x < 0)) continue;
      // Deep enough for a boat a tile off the shore beside it, for quays.
      const deep = [-3, -2, -1, 1, 2, 3].every((d) => {
        const x = firstOcean(r + d);
        return x >= 0 && map.depth[map.idx(x + 1, r + d)] >= BOAT_DRAFT;
      });
      if (!deep) continue;
      const out = Math.min(...sides.map((x) => xw - x));
      const better =
        out > most || (out === most && row >= 0 && Math.abs(r - cy) < Math.abs(row - cy));
      if (better) {
        most = out;
        row = r;
        shoreX = xw - 1;
      }
    }
  }
  if (W > 96 && row < 0) {
    // No point: where the coast comes in nearest the highway.
    for (let r = Math.round(map.limit * 0.25); r <= Math.round(map.limit * 0.75); r++) {
      const xw = firstOcean(r);
      if (xw < 16 || xw > W - 12 || !fits(r, xw - 1)) continue;
      const better =
        row < 0 || xw < shoreX + 1 || (xw === shoreX + 1 && Math.abs(r - cy) < Math.abs(row - cy));
      if (better) {
        row = r;
        shoreX = xw - 1;
      }
    }
  }
  for (let k = 0; k < 60 && row < 0; k++) {
    const r = cy + (k % 2 === 0 ? k / 2 : -(k + 1) / 2);
    if (r < 3 || r > map.limit - 4) continue;
    const xw = firstOcean(r);
    if (xw < 16 || xw > W - 12) continue;
    if (fits(r, xw - 1)) {
      row = r;
      shoreX = xw - 1;
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
  // No rock on the shore round the jetty, where the port starts building.
  for (let y = row - 5; y <= row + 5; y++) {
    for (let x = shoreX - 12; x <= shoreX; x++) {
      const i = map.inBounds(x, y) ? map.idx(x, y) : -1;
      if (i >= 0 && map.terrain[i] === Terrain.Rock) map.terrain[i] = Terrain.Grass;
    }
  }

  // The road off the highway's first exit down to the jetty, and a path on
  // to it from the road's end, where the crates are heaped for the pickups
  // (see kerbOf) until the port may build truck bays.
  for (let x = HIGHWAY_COLUMNS; x <= shoreX - 5; x++) map.build[map.idx(x, row)] = Build.Road;
  setExit(map, row, true);
  for (let x = shoreX - 4; x <= shoreX; x++) map.build[map.idx(x, row)] = Build.Footpath;
  for (let x = shoreX + 1; x <= shoreX + 3; x++) {
    const i = map.idx(x, row);
    map.build[i] = Build.Jetty;
    map.depth[i] = Math.min(map.depth[i], MAX_JETTY_DEPTH - 0.5);
  }
  map.entry = map.idx(HIGHWAY_COLUMNS - 1, row);
  // The port starts owning the land round its jetty; the rest it buys.
  ownOnly(map, startPlots(map, row, shoreX));

  return map.idx(shoreX, row);
}

/** Where a new port heaps its crates for the pickups: the path's first tile past the road's end. */
export function kerbOf(map: GameMap, spawn: number): number {
  return map.idx(map.xOf(spawn) - 4, map.yOf(spawn));
}

/**
 * The road's end beside the heap at `kerb` made two wide, for the pickups
 * to turn about in: with no truck bay at its end, they could not.
 */
export function turnAbout(map: GameMap, kerb: number): void {
  const y = map.yOf(kerb) + 1;
  for (let x = map.xOf(kerb) - 2; x <= map.xOf(kerb) - 1; x++) {
    const i = map.idx(x, y);
    map.terrain[i] = Terrain.Grass;
    map.ocean[i] = 0;
    map.depth[i] = 0;
    map.deco[i] = Deco.None;
    map.build[i] = Build.Road;
  }
}

/**
 * A map from a save made before the country past the port's land: the
 * same port, with that country added on from the map it was made from.
 */
export function extendMap(old: GameMap, seed: number): GameMap {
  // Made at the size it was then.
  const fresh = generateMap(seed, old.w).map;
  if (old.h >= fresh.h || old.w !== fresh.w) return old;
  const map = new GameMap(old.w, fresh.h, old.h);
  const n = old.w * old.h;
  for (const key of ['terrain', 'depth', 'ocean', 'deco', 'build', 'orient', 'store'] as const) {
    map[key].set(old[key]);
    map[key].set(fresh[key].subarray(n), n);
  }
  // Nothing of the start site lies out there, but clear anything built just in case.
  for (let i = n; i < map.build.length; i++) {
    map.build[i] = Build.None;
    map.orient[i] = 0;
  }
  map.entry = old.entry;
  map.plots.set(old.plots);
  map.plotsBought = old.plotsBought;
  return map;
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
