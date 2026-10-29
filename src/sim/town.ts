import * as B from './balance';
import type { GameMap } from './map';
import { fbm, hash01 } from './noise';
import { MinHeap } from './path';
import { Build, Deco, isPublicRoad, isTownBuilding, Terrain } from './types';

// The town up the coast. It starts as a fishing village and grows with
// the port: every job at the port and every crate it sends out by road
// keeps more people in town, and its shops and works take some of the
// port's goods themselves. The player has no say in it: the town lays out
// its own streets and puts up and rebuilds its own buildings.

/** Marks a road the town laid, in `GameMap.orient`; the player cannot touch it. */
export const TOWN = 128;

/** Towns laid out under older rules are cleared and laid out again when a save loads. */
export const TOWN_LAYOUT = 2;

export const TOWN_STAGES = [
  { name: 'Fishing village', from: 0 },
  { name: 'Village', from: 100 },
  { name: 'Town', from: 300 },
  { name: 'Large town', from: 800 },
  { name: 'City', from: 2000 },
] as const;

/** Homes, from a fisher's cottage to a tower block. */
export const LEVELS = [Build.Cottage, Build.House, Build.Shop, Build.Flats, Build.Tower] as const;

export const HOMES: Partial<Record<number, number>> = {
  [Build.Cottage]: 5,
  [Build.House]: 10,
  [Build.Shop]: 16,
  [Build.Flats]: 45,
  [Build.Tower]: 120,
};

export interface Business {
  label: string;
  /** Takes containers rather than crates. */
  boxes: boolean;
  /** Crates or containers it takes a day. */
  perDay: number;
  /** Out on the edge of town rather than in the middle. */
  industry: boolean;
}

/** The town's shops and works, which the hauliers deliver some of the port's goods to. */
export const BUSINESSES: Partial<Record<number, Business>> = {
  [Build.FishMarket]: { label: 'fish market', boxes: false, perDay: 12, industry: false },
  [Build.Cannery]: { label: 'cannery', boxes: false, perDay: 24, industry: true },
  [Build.Store]: { label: 'department store', boxes: false, perDay: 20, industry: false },
  [Build.Factory]: { label: 'factory', boxes: true, perDay: 10, industry: true },
};

/** Businesses a town has by each stage. */
const WANTED: readonly (readonly [number, number])[][] = [
  [[Build.FishMarket, 1]],
  [
    [Build.FishMarket, 1],
    [Build.Cannery, 1],
  ],
  [
    [Build.FishMarket, 1],
    [Build.Cannery, 1],
    [Build.Store, 1],
  ],
  [
    [Build.FishMarket, 1],
    [Build.Cannery, 1],
    [Build.Store, 1],
    [Build.Factory, 1],
  ],
  [
    [Build.FishMarket, 1],
    [Build.Cannery, 2],
    [Build.Store, 2],
    [Build.Factory, 2],
  ],
];

export interface Town {
  name: string;
  /** The chapel square; the town grows outwards from here. */
  centre: number;
  /** People who would live here if there were homes; builders put them up to match. */
  demand: number;
  /** Crates' worth of goods the port sent out by road per day, over the last few days. */
  goods: number;
  /** Goods sent out so far today. */
  today: number;
  /** Crates' worth delivered to the town's businesses per day, lately. */
  supplied: number;
  /** Delivered to them so far today. */
  local: number;
  /** What the town's businesses will still take today. */
  wants: { crates: number; boxes: number };
  /** Jobs at the port and with its hauliers, as of this morning. */
  jobs: number;
  /** Index into TOWN_STAGES; a town never shrinks back down a stage. */
  stage: number;
  /** TOWN_LAYOUT when it was laid out. */
  layout: number;
}

/** Steps for facing 0 (+x), 1 (+y), 2 (-x), 3 (-y). */
const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
] as const;

/** People the port's jobs and trade support. */
export function townTarget(t: Town): number {
  return (
    B.TOWN_BASE +
    B.TOWN_PER_JOB * t.jobs +
    B.TOWN_PER_GOODS * t.goods +
    B.TOWN_PER_LOCAL * t.supplied
  );
}

export function townHomes(map: GameMap): number {
  let n = 0;
  for (let i = 0; i < map.build.length; i++) n += HOMES[map.build[i]] ?? 0;
  return n;
}

export function population(t: Town, map: GameMap): number {
  return Math.round(Math.min(townHomes(map), t.demand));
}

export function isTownStreet(map: GameMap, i: number): boolean {
  const b = map.build[i];
  return (b === Build.Road || b === Build.Crossing) && (map.orient[i] & TOWN) !== 0;
}

export function ownedByTown(map: GameMap, i: number): boolean {
  return isTownBuilding(map.build[i]) || isTownStreet(map, i);
}

/** Something the player built, which the town keeps its distance from. */
function playerBuilt(map: GameMap, i: number): boolean {
  const b = map.build[i];
  return (
    b !== Build.None &&
    b !== Build.Road &&
    b !== Build.Rail &&
    b !== Build.Crossing &&
    !isTownBuilding(b)
  );
}

/** Open land the town may take: off the beach and clear of the port. */
function free(map: GameMap, i: number): boolean {
  if (i < 0 || map.build[i] !== Build.None || !map.isLand(i)) return false;
  const x = map.xOf(i);
  const y = map.yOf(i);
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (!map.inBounds(x + dx, y + dy)) continue;
      const n = map.idx(x + dx, y + dy);
      if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && map.ocean[n]) return false;
      if (playerBuilt(map, n)) return false;
    }
  }
  return true;
}

function step(map: GameMap, i: number, d: number, n = 1): number {
  const x = map.xOf(i) + DIRS[d & 3][0] * n;
  const y = map.yOf(i) + DIRS[d & 3][1] * n;
  return map.inBounds(x, y) ? map.idx(x, y) : -1;
}

const road = (map: GameMap, i: number) => i >= 0 && isPublicRoad(map.build[i]);

/** How far out from the centre, with a little noise so the edge is ragged. */
function reach(map: GameMap, t: Town, i: number): number {
  const dx = map.xOf(i) - map.xOf(t.centre);
  const dy = map.yOf(i) - map.yOf(t.centre);
  return Math.hypot(dx, dy) + hash01(t.centre, map.xOf(i), map.yOf(i)) * 1.5;
}

/** The tallest home allowed this far out: the centre builds up as the town grows. */
function maxLevel(t: Town, pop: number, r: number): number {
  const core = Math.sqrt(pop) / 5.5;
  if (t.stage >= 4 && r <= core * 0.4) return 4;
  if (t.stage >= 3 && r <= core * 0.7) return 3;
  if (t.stage >= 2 && r <= core) return 2;
  return t.stage >= 1 ? 1 : 0;
}

/** Which way a building on `i` faces: onto a town street, rows first. */
function facingStreet(map: GameMap, i: number): number {
  for (const f of [1, 3, 0, 2]) {
    const n = step(map, i, f);
    if (n >= 0 && isTownStreet(map, n)) return f;
  }
  return 1;
}

function place(map: GameMap, i: number, code: number, orient: number, touch: (i: number) => void) {
  map.build[i] = code;
  map.orient[i] = orient;
  map.deco[i] = Deco.None;
  if (map.terrain[i] === Terrain.Rock) map.terrain[i] = Terrain.Grass;
  touch(i);
}

/**
 * Whether a street can go on `n`, coming from `from`: open land, and no
 * other road alongside it, so streets never run two wide. Running into a
 * road straight ahead makes a junction, which is fine.
 */
function canStreet(map: GameMap, n: number, from: number): boolean {
  if (!free(map, n)) return false;
  const ahead = n + (n - from);
  return map.neighbors4(n).every((m) => m === from || m === ahead || !road(map, m));
}

interface StreetPlan {
  tile: number;
  score: number;
}

/**
 * Where the streets can grow next: on from the end of a street, now and
 * then turning a corner, or off to the side of a straight stretch, which
 * makes a side street. Those tiles are kept clear of houses.
 */
function streetPlans(t: Town, map: GameMap): StreetPlan[] {
  const out: StreetPlan[] = [];
  const seed = t.centre ^ 0x5bd1;
  for (let s = 0; s < map.build.length; s++) {
    if (!isTownStreet(map, s) || map.build[s] === Build.Crossing) continue;
    const links = [0, 1, 2, 3].filter((d) => road(map, step(map, s, d)));
    const x = map.xOf(s);
    const y = map.yOf(s);
    if (links.length === 1) {
      // A dead end carries on the way it was going, or turns a corner.
      const d = (links[0] + 2) & 3;
      const n = step(map, s, d);
      if (n >= 0 && canStreet(map, n, s)) out.push({ tile: n, score: reach(map, t, n) });
      const run = road(map, step(map, s, d + 2, 2)) && road(map, step(map, s, d + 2, 3));
      if (run && hash01(seed, x, y) < 0.35) {
        const turn = (d + (hash01(seed, y, x) < 0.5 ? 1 : 3)) & 3;
        const m = step(map, s, turn);
        if (m >= 0 && canStreet(map, m, s)) out.push({ tile: m, score: reach(map, t, m) + 1 });
      }
    } else if (links.length === 2 && links[0] + 2 === links[1]) {
      // A side street now and then off a straight stretch, never two close together.
      for (const side of [(links[0] + 1) & 3, (links[0] + 3) & 3]) {
        if (hash01(seed, x * 4 + side, y) > 0.3) continue;
        const n = step(map, s, side);
        if (n < 0 || !canStreet(map, n, s)) continue;
        const near = [-2, 2].some((k) => road(map, step(map, step(map, s, links[0], k), side)));
        if (!near) out.push({ tile: n, score: reach(map, t, n) + 0.5 });
      }
    }
  }
  return out;
}

/**
 * The builders' next job: put up a business the town is missing, rebuild
 * a home taller near the centre, put up a new one on a street, or lay a new
 * stretch of street so there is room to build. Returns false when the town
 * has nowhere left to go.
 */
export function growTown(t: Town, map: GameMap, touch: (i: number) => void): boolean {
  const pop = population(t, map);
  const plans = streetPlans(t, map);
  const kept = new Set(plans.map((p) => p.tile));
  let up = -1;
  let upScore = Infinity;
  const plots: { tile: number; score: number }[] = [];
  let parks = 0;
  let edge = 0;
  const have = new Map<number, number>();
  for (let i = 0; i < map.build.length; i++) {
    const b = map.build[i];
    if (b === Build.Park) parks++;
    if (BUSINESSES[b]) have.set(b, (have.get(b) ?? 0) + 1);
    const level = (LEVELS as readonly number[]).indexOf(b);
    if (level >= 0) {
      const r = reach(map, t, i);
      edge = Math.max(edge, r);
      if (level < maxLevel(t, pop, r) && r < upScore) {
        up = i;
        upScore = r;
      }
      continue;
    }
    if (kept.has(i) || !free(map, i)) continue;
    if (map.neighbors4(i).some((n) => isTownStreet(map, n))) {
      plots.push({ tile: i, score: reach(map, t, i) });
    }
  }
  plots.sort((a, b) => a.score - b.score);
  const plot = plots[0];
  const street = plans.reduce<StreetPlan | undefined>(
    (best, p) => (!best || p.score < best.score ? p : best),
    undefined,
  );

  const missing = WANTED[t.stage].find(([code, n]) => (have.get(code) ?? 0) < n);
  if (missing && plot) {
    // Shops in the middle of town; works out on its edge, but not beyond it.
    const def = BUSINESSES[missing[0]]!;
    const site = def.industry ? (plots.filter((p) => p.score <= edge + 1).pop() ?? plot) : plot;
    place(map, site.tile, missing[0], facingStreet(map, site.tile), touch);
  } else if (plot && t.stage >= 2 && parks < t.stage - 1) {
    // Each bigger town gets another green square near the middle.
    place(map, plot.tile, Build.Park, facingStreet(map, plot.tile), touch);
  } else if (up >= 0 && (!plot || upScore <= plot.score)) {
    const level = (LEVELS as readonly number[]).indexOf(map.build[up]);
    place(map, up, LEVELS[level + 1], map.orient[up], touch);
  } else if (plot && (!street || plot.score <= street.score + 2)) {
    const level = Math.min(1, maxLevel(t, pop, plot.score));
    place(map, plot.tile, LEVELS[level], facingStreet(map, plot.tile), touch);
  } else if (street) {
    place(map, street.tile, Build.Road, TOWN, touch);
  } else return false;
  return true;
}

/** What the town's businesses take in a day. */
export function townWants(map: GameMap): { crates: number; boxes: number } {
  const wants = { crates: 0, boxes: 0 };
  for (let i = 0; i < map.build.length; i++) {
    const def = BUSINESSES[map.build[i]];
    if (def) wants[def.boxes ? 'boxes' : 'crates'] += def.perDay;
  }
  return wants;
}

/** After a day's trade: how many want to live in town now. */
export function townDay(t: Town, jobs: number, map: GameMap): void {
  t.goods = t.goods * 0.7 + t.today * 0.3;
  t.supplied = t.supplied * 0.7 + t.local * 0.3;
  t.today = 0;
  t.local = 0;
  t.jobs = jobs;
  t.wants = townWants(map);
  t.demand += (townTarget(t) - t.demand) * B.TOWN_GROWTH;
}

/** The stage the town has grown into, if it just moved up one. */
export function townStageUp(t: Town, map: GameMap): string | null {
  const pop = population(t, map);
  let stage = t.stage;
  while (stage + 1 < TOWN_STAGES.length && pop >= TOWN_STAGES[stage + 1].from) stage++;
  if (stage === t.stage) return null;
  t.stage = stage;
  return TOWN_STAGES[stage].name;
}

/** Steps from each tile to the nearest thing the player built. */
function portDistance(map: GameMap): Int32Array {
  const dist = new Int32Array(map.w * map.h).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < map.build.length; i++) {
    if (playerBuilt(map, i)) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    for (const n of map.neighbors4(i)) {
      if (dist[n] < 0) {
        dist[n] = dist[i] + 1;
        queue.push(n);
      }
    }
  }
  return dist;
}

/** Public road the trucks can reach from the highway. */
function truckRoads(map: GameMap): Uint8Array {
  const out = new Uint8Array(map.w * map.h);
  const queue = [map.entry];
  out[map.entry] = 1;
  for (let head = 0; head < queue.length; head++) {
    for (const n of map.neighbors4(queue[head])) {
      if (!out[n] && isPublicRoad(map.build[n])) {
        out[n] = 1;
        queue.push(n);
      }
    }
  }
  return out;
}

/**
 * The cheapest road from `from` to a tile `goal` accepts: round the hills,
 * rocks and woods, clear of the port and of `used`, over the railway square
 * on, in long runs with now and then a bend. Returns the tiles after
 * `from`, up to and including the goal, or [] when there is no way.
 */
function route(
  map: GameMap,
  from: number,
  goal: (i: number) => boolean,
  near: Int32Array,
  roads: Uint8Array,
  seed: number,
  used: ReadonlySet<number>,
): number[] {
  const n = map.w * map.h;
  const cost = new Float32Array(n * 4).fill(Infinity);
  const came = new Int32Array(n * 4).fill(-1);
  const heap = new MinHeap();
  for (let d = 0; d < 4; d++) {
    cost[from * 4 + d] = 0;
    heap.push(from * 4 + d, 0);
  }
  let end = -1;
  while (heap.size > 0) {
    const s = heap.pop();
    const i = s >> 2;
    const d = s & 3;
    if (i !== from && goal(i)) {
      end = s;
      break;
    }
    const onRail = map.build[i] === Build.Rail;
    for (let nd = 0; nd < 4; nd++) {
      if (onRail && nd !== d) continue;
      const j = step(map, i, nd);
      if (j < 0 || !map.isLand(j) || used.has(j)) continue;
      const b = map.build[j];
      let c: number;
      // Joins the trucks' road well inland of the port, leaving it room to grow.
      if (roads[j] && b !== Build.Crossing) c = 0.5 + Math.max(0, 10 - near[j]) * 4;
      else if (b === Build.Rail) {
        // Over the line square on, never next to another crossing.
        const along = (nd & 1) === 1;
        const crowded = map.neighbors4(j).some((m) => map.build[m] === Build.Crossing);
        if (along || crowded) continue;
        c = 4;
      } else if (b === Build.None) {
        const x = map.xOf(j);
        const y = map.yOf(j);
        c = 1 + fbm(seed, x * 0.16, y * 0.16, 3) ** 2 * 14;
        if (map.terrain[j] === Terrain.Rock) c += 3;
        if (map.terrain[j] === Terrain.Sand) c += 1.5;
        if (map.deco[j] === Deco.Tree) c += 0.6;
        if (near[j] >= 0 && near[j] <= 1) continue;
        // Never alongside another road, only into one where it joins.
        const beside = (m: number) => m !== i && (road(map, m) || used.has(m)) && !goal(m);
        if (map.neighbors4(j).some(beside)) continue;
        if (near[j] < 10) c += (10 - near[j]) * 1.5;
        // Keep off the line's side, where a siding may go one day.
        if (map.neighbors4(j).some((m) => map.build[m] === Build.Rail)) c += 2;
        // The map edge only when there is no other way out.
        if (x === 0 && !roads[j]) c += 1000;
      } else continue;
      if (nd !== d && i !== from) c += 2;
      const next = cost[s] + c;
      const k = j * 4 + nd;
      if (next < cost[k]) {
        cost[k] = next;
        came[k] = s;
        heap.push(k, next);
      }
    }
  }
  if (end < 0) return [];
  const tiles: number[] = [];
  for (let s = end; s >= 0 && s >> 2 !== from; s = came[s]) tiles.push(s >> 2);
  return tiles.reverse();
}

/**
 * The country road from the town out to the road the trucks come in on,
 * by way of a spot off to one side so it bends rather than running
 * straight; without a way through, to the edge of the map. Returns the
 * tiles after `from`.
 */
function countryRoute(map: GameMap, from: number, seed: number): number[] {
  const roads = truckRoads(map);
  const near = portDistance(map);
  const out = (i: number) =>
    (roads[i] === 1 && map.build[i] !== Build.Crossing) || map.xOf(i) === 0;
  // Halfway to the nearest truck road, pushed off to one side.
  let to = -1;
  for (let i = 0; i < roads.length; i++) {
    if (roads[i] && (to < 0 || dist(map, i, from) < dist(map, to, from))) to = i;
  }
  let way = -1;
  if (to >= 0) {
    const fx = map.xOf(from);
    const fy = map.yOf(from);
    const vx = map.xOf(to) - fx;
    const vy = map.yOf(to) - fy;
    const len = Math.hypot(vx, vy);
    const side = (hash01(seed, fx, fy) * 2 - 1) * Math.min(12, len / 3);
    const wx = Math.round(fx + vx / 2 - (vy / len) * side);
    const wy = Math.round(fy + vy / 2 + (vx / len) * side);
    for (let r = 0; r <= 5 && way < 0; r++) {
      for (let dy = -r; dy <= r && way < 0; dy++) {
        for (let dx = -r; dx <= r && way < 0; dx++) {
          if (!map.inBounds(wx + dx, wy + dy)) continue;
          const i = map.idx(wx + dx, wy + dy);
          if (map.build[i] === Build.None && map.isLand(i) && near[i] > 3) way = i;
        }
      }
    }
  }
  if (way >= 0) {
    const first = route(map, from, (i) => i === way, near, roads, seed, new Set());
    if (first.length > 0) {
      const second = route(map, way, out, near, roads, seed, new Set([from, ...first]));
      if (second.length > 0) return [...first, ...second];
    }
  }
  return route(map, from, out, near, roads, seed, new Set());
}

function dist(map: GameMap, a: number, b: number): number {
  return Math.hypot(map.xOf(a) - map.xOf(b), map.yOf(a) - map.yOf(b));
}

/**
 * Found the fishing village on the coast, as far from the port as there is
 * room, with a street along the shore, a chapel, a fish market, fish sheds
 * on the beach, cottages and a country road to the trucks' road. Works on
 * a map the player has already built on. Returns null when there is no
 * room for a town.
 */
export function foundTown(map: GameMap, name: string, touch: (i: number) => void): Town | null {
  const near = portDistance(map);
  let best = -1;
  let bestScore = -Infinity;
  for (let cy = 10; cy < map.h - 10; cy++) {
    let shore = -1;
    for (let x = 0; x < map.w && shore < 0; x++) if (!map.isLand(map.idx(x, cy))) shore = x;
    if (shore < 24) continue;
    const c = map.idx(shore - 3, cy);
    if (!free(map, c) || near[c] < B.TOWN_MIN_DISTANCE) continue;
    let room = 0;
    for (let dy = -9; dy <= 9; dy++) {
      for (let dx = -9; dx <= 9; dx++) {
        const x = shore - 3 + dx;
        const y = cy + dy;
        if (dx * dx + dy * dy > 81 || !map.inBounds(x, y)) continue;
        if (free(map, map.idx(x, y))) room++;
      }
    }
    const score = room + Math.min(near[c], 50) * 3;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (best < 0) return null;

  const t: Town = {
    name,
    centre: best,
    demand: B.TOWN_START,
    goods: 0,
    today: 0,
    supplied: 0,
    local: 0,
    wants: { crates: 0, boxes: 0 },
    jobs: 0,
    stage: 0,
    layout: TOWN_LAYOUT,
  };
  const street = (i: number) => {
    if (i < 0) return;
    if (map.build[i] === Build.None) place(map, i, Build.Road, TOWN, touch);
    else if (map.build[i] === Build.Rail) place(map, i, Build.Crossing, TOWN, touch);
  };
  // A street along the shore through the square…
  street(best);
  for (const d of [1, 3]) {
    for (let k = 1; k <= 3; k++) {
      const i = step(map, best, d, k);
      if (!free(map, i)) break;
      street(i);
    }
  }
  // …and the country road inland, out to the trucks' road.
  for (const i of countryRoute(map, best, best ^ 0x2c1)) street(i);

  // Fish sheds on the beach below the village, doors to the sea.
  const cx = map.xOf(best);
  const cy = map.yOf(best);
  let sheds = 0;
  for (let r = 1; r <= 5 && sheds < 2; r++) {
    for (let dy = -r; dy <= r && sheds < 2; dy++) {
      for (let dx = -r; dx <= r + 2 && sheds < 2; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!map.inBounds(x, y) || Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const i = map.idx(x, y);
        if (map.build[i] !== Build.None || !map.isLand(i)) continue;
        if (map.neighbors4(i).some((n) => isTownBuilding(map.build[n]) || road(map, n))) continue;
        const sea = [0, 1, 2, 3].find((d) => {
          const n = step(map, i, d);
          return n >= 0 && map.ocean[n];
        });
        if (sea === undefined || near[i] < 3) continue;
        place(map, i, Build.FishShed, sea, touch);
        sheds++;
      }
    }
  }
  // The chapel and the fish market on the square, then the cottages.
  for (const code of [Build.Chapel, Build.FishMarket]) {
    const spot = [
      step(map, best, 0),
      step(map, step(map, best, 1), 0),
      step(map, step(map, best, 3), 0),
      step(map, step(map, best, 1), 2),
      step(map, step(map, best, 3), 2),
    ].find((i) => free(map, i) && map.neighbors4(i).some((n) => isTownStreet(map, n)));
    if (spot !== undefined) place(map, spot, code, facingStreet(map, spot), touch);
  }
  for (let k = 0; k < 100 && townHomes(map) < B.TOWN_START; k++) {
    if (!growTown(t, map, touch)) break;
  }
  t.wants = townWants(map);
  return t;
}

/** Take a town off the map, leaving the line where its roads crossed it. */
export function clearTown(map: GameMap, touch: (i: number) => void): void {
  for (let i = 0; i < map.build.length; i++) {
    if (!ownedByTown(map, i)) continue;
    map.build[i] = map.build[i] === Build.Crossing ? Build.Rail : Build.None;
    map.orient[i] = 0;
    touch(i);
  }
}
