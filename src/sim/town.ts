import * as B from './balance';
import type { Cargo } from './cargo';
import type { GameMap } from './map';
import { fbm, hash01 } from './noise';
import { MinHeap } from './path';
import { exitError, HIGHWAY_COLUMNS, isHighway, linked, setExit } from './roads';
import { Build, Deco, isPublicRoad, isTownBuilding, Terrain } from './types';

// The town up the coast. It starts as a fishing village and grows with
// the port: every job at the port and every crate it sends out by road
// keeps more people in town, and its shops and works take some of the
// port's goods themselves. The player has no say in it: the town lays out
// its own streets and puts up and rebuilds its own buildings.

/** Marks a road the town laid, in `GameMap.orient`; the player cannot touch it. */
export const TOWN = 128;

/**
 * Where the highway ran, past the west edge of the map, before it was laid
 * on the map itself: trucks from older saves still on their way round it
 * finish the trip this way.
 */
export const HIGHWAY_X = -3.5;

/** Towns laid out under older rules are cleared and laid out again when a save loads. */
export const TOWN_LAYOUT = 5;

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
  /** The kinds of crate it takes; any other kind goes on out by road. None for containers. */
  takes: Cargo[];
  /** Crates or containers it takes a day. */
  perDay: number;
  /** Out on the edge of town rather than in the middle. */
  industry: boolean;
}

/** The town's shops and works, which the hauliers deliver some of the port's goods to. */
export const BUSINESSES: Partial<Record<number, Business>> = {
  [Build.FishMarket]: {
    label: 'fish market',
    boxes: false,
    takes: ['fish'],
    perDay: 12,
    industry: false,
  },
  [Build.Restaurant]: {
    label: 'seafood restaurant',
    boxes: false,
    takes: ['lobster'],
    perDay: 6,
    industry: false,
  },
  [Build.Cannery]: { label: 'cannery', boxes: false, takes: ['fish'], perDay: 24, industry: true },
  [Build.Store]: {
    label: 'department store',
    boxes: false,
    takes: ['goods'],
    perDay: 20,
    industry: false,
  },
  [Build.BuildersYard]: {
    label: "builders' yard",
    boxes: false,
    takes: ['timber'],
    perDay: 10,
    industry: true,
  },
  [Build.Factory]: { label: 'factory', boxes: true, takes: [], perDay: 10, industry: true },
};

/**
 * The landmarks a town opens one after another as the port keeps it
 * supplied (see progression.md): each has a goal the port meets, lifts how
 * many people the town may grow to, and opens something for the port.
 */
export interface Landmark {
  code: number;
  name: string;
  /**
   * What the port must do: crates of `cargo` trucked out, `perDay` for
   * `days` days running or `total` in all; `aboard`, put on board ships
   * rather than trucked out.
   */
  goal: {
    cargo: Cargo;
    perDay?: number;
    days?: number;
    total?: number;
    aboard?: boolean;
  };
  /** The goal in words, for the town panel. */
  aim: string;
  /** What opening it brings, in words. */
  opens: string;
  /** People the town may grow to once it is open. */
  cap: number;
  /** The port tier the goal waits on: nothing counts towards it before then. */
  tier?: number;
}

export const LANDMARKS: Landmark[] = [
  {
    code: Build.FishMarket,
    name: 'Fish market',
    goal: { cargo: 'fish', perDay: 12, days: 3 },
    aim: 'Truck out 12 crates of fish a day, 3 days running',
    opens:
      'The market wants ice to keep its fish: an ice works offers its ice for the fishing boats',
    cap: 150,
  },
  {
    code: Build.IceHouse,
    name: 'Ice house',
    goal: { cargo: 'ice', total: 20, aboard: true },
    aim: 'Put 20 crates of ice on board fishing boats',
    opens: 'With ice on board, boats go further out: lobster boats offer their catch',
    cap: 200,
  },
  {
    code: Build.Restaurant,
    name: 'Seafood restaurant',
    // In all rather than a day: the lobster boats come every day or two.
    goal: { cargo: 'lobster', total: 15 },
    aim: 'Truck out 15 crates of lobster',
    opens:
      'Visitors come for the seafood: the town grows past 300, so the port may become a Coastal Wharf',
    cap: 400,
  },
  // The Coastal Wharf's: coasters bring more than the fishing boats can.
  {
    code: Build.Cannery,
    name: 'Cannery',
    // More than the fishing boats bring: coasters' days make it up.
    goal: { cargo: 'fish', perDay: 30, days: 2 },
    aim: 'Truck out 30 crates of fish a day, 2 days running',
    opens:
      'The cannery sends its canned fish to the port by truck, to go out on the coasters: its offer is on the contracts board',
    cap: 500,
    tier: 1,
  },
  {
    code: Build.BuildersYard,
    name: "Builders' yard",
    goal: { cargo: 'canned', total: 25, aboard: true },
    aim: 'Put 25 crates of canned fish on board ships',
    opens:
      "Valley Timber Co.'s coasters bring timber for the builders' yard, and the town builds flats",
    cap: 600,
    tier: 1,
  },
  {
    code: Build.School,
    name: 'School',
    goal: { cargo: 'timber', total: 25 },
    aim: 'Truck out 25 crates of timber',
    opens:
      'Families settle, and a department store opens: a shipping line offers its coasters of goods for it',
    cap: 700,
    tier: 1,
  },
  {
    code: Build.TownHall,
    name: 'Town hall',
    // In all: the coasters bring it a load at a time, not every day.
    goal: { cargo: 'goods', total: 60 },
    aim: 'Truck out 60 crates of goods',
    opens: 'The town gets its charter: it grows past 800, so the port may become a Container Port',
    cap: Infinity,
    tier: 1,
  },
];

/** How many of LANDMARKS a town of `pop` people from an older save is past, at least. */
export function landmarksByPopulation(pop: number): number {
  // A town past 300 has its restaurant; past each later cap, that step.
  if (pop < 300) return 0;
  let n = 3;
  while (n < LANDMARKS.length && Number.isFinite(LANDMARKS[n].cap) && pop >= LANDMARKS[n].cap) n++;
  return n;
}

/** The landmark the town is working towards, if the port's tier lets its goal count yet. */
export function landmarkGoal(t: Town, tier: number): Landmark | null {
  const l = LANDMARKS[t.landmarks];
  return l && tier >= (l.tier ?? 0) ? l : null;
}

/** Where the builders' yard and the school come in LANDMARKS. */
const YARD = LANDMARKS.findIndex((l) => l.code === Build.BuildersYard);
const SCHOOL = LANDMARKS.findIndex((l) => l.code === Build.School);

/** People a village with none of its landmarks yet may grow to. */
export const VILLAGE_CAP = 100;

/** How many people the town may grow to, as far as its landmarks let it. */
export function townCap(t: Town): number {
  return t.landmarks > 0 ? LANDMARKS[t.landmarks - 1].cap : VILLAGE_CAP;
}

/**
 * Businesses a town has by each stage, besides its landmarks (the cannery
 * is one, and the department store opens with the school).
 */
const WANTED: readonly (readonly [number, number])[][] = [
  [],
  [],
  [],
  [
    [Build.Cannery, 1],
    [Build.Store, 1],
    [Build.Factory, 1],
  ],
  [
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
  /** Crates of each kind (or `container`s) the port sent out by road so far today. */
  sent?: Partial<Record<string, number>>;
  /**
   * Crates' worth a day sent out by road, lately, of what the town's
   * businesses take, up to as much as they take: delivered or not.
   */
  sentFor?: number;
  /**
   * What the town's businesses will still take today, by the code of the
   * building: so crates of one kind never use up what a business of another
   * kind takes.
   */
  wants: Wants;
  /** Jobs at the port and with its hauliers, as of this morning. */
  jobs: number;
  /** Index into TOWN_STAGES; a town never shrinks back down a stage. */
  stage: number;
  /** TOWN_LAYOUT when it was laid out. */
  layout: number;
  /** Where its road leaves the map for the highway, or -1. */
  gate: number;
  /** How many of LANDMARKS it has opened. */
  landmarks: number;
  /** Towards the next landmark: days running its goal was met, or crates so far towards a total. */
  streak: number;
  /** Crates of each kind trucked out so far today, or put on board, for the landmark's goal. */
  goal: number;
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
    !isHighway(b) &&
    !isTownBuilding(b)
  );
}

/** Open land the town may take: off the beach and clear of the port. */
function free(map: GameMap, i: number): boolean {
  if (i < 0 || map.build[i] !== Build.None || !map.isLand(i)) return false;
  // Out in the country past the port's land, with a field's width to spare.
  if (map.yOf(i) <= map.limit) return false;
  // Off the highway's verge, where exits are opened.
  if (map.xOf(i) < HIGHWAY_COLUMNS + 2) return false;
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

/** How far from the square a town of `pop` people builds, in tiles. */
export function townSpread(pop: number): number {
  return 6 + Math.sqrt(pop) * 0.8;
}

/** The tallest home allowed this far out: the centre builds up as the town grows. */
function maxLevel(t: Town, pop: number, r: number): number {
  const core = Math.sqrt(pop) / 5.5;
  if (t.stage >= 4 && r <= core * 0.4) return 4;
  // Flats once the builders' yard is open.
  if ((t.stage >= 3 || t.landmarks > YARD) && r <= core * 0.7) return 3;
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
  // Built for the people wanting to live here, not only those who do yet.
  const pop = Math.max(population(t, map), t.demand);
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
    if (BUSINESSES[b] || LANDMARKS.some((l) => l.code === b)) have.set(b, (have.get(b) ?? 0) + 1);
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
  // Kept together round the square, as far out as a town its size spreads:
  // never strung out along its road to the highway. Past that it builds up.
  const spread = townSpread(pop);
  const plot = plots[0] && plots[0].score <= spread ? plots[0] : undefined;
  const street = plans
    .filter((p) => p.score <= spread)
    .reduce<StreetPlan | undefined>(
      (best, p) => (!best || p.score < best.score ? p : best),
      undefined,
    );

  const wanted: (readonly [number, number])[] = [
    ...LANDMARKS.slice(0, t.landmarks).map((l) => [l.code, 1] as const),
    // The department store opens with the school.
    ...(t.landmarks > SCHOOL ? [[Build.Store, 1] as const] : []),
    ...WANTED[t.stage],
  ];
  const missing = wanted.find(([code, n]) => (have.get(code) ?? 0) < n);
  if (missing && plot) {
    // Shops in the middle of town; works out on its edge, but not beyond it.
    const def = BUSINESSES[missing[0]];
    const site = def?.industry ? (plots.filter((p) => p.score <= edge + 1).pop() ?? plot) : plot;
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

/** Crates (or containers) each kind of business in town takes, by the code of its building. */
export type Wants = Partial<Record<number, number>>;

/** What the town's businesses take in a day. */
export function townWants(map: GameMap): Wants {
  const wants: Wants = {};
  for (let i = 0; i < map.build.length; i++) {
    const def = BUSINESSES[map.build[i]];
    if (def) wants[map.build[i]] = (wants[map.build[i]] ?? 0) + def.perDay;
  }
  return wants;
}

/**
 * How much of what each kind of business in town takes (by the code of its
 * building) the port sent out by road: crates of the kinds it takes, or
 * containers, shared out in turn among the businesses that take the same,
 * each up to what it takes in a day.
 */
export function sentTo(t: Town, map: GameMap): Partial<Record<number, number>> {
  const left = { ...(t.sent ?? {}) };
  const out: Partial<Record<number, number>> = {};
  for (const [code, want] of Object.entries(townWants(map))) {
    const def = BUSINESSES[Number(code)];
    if (!def || !want) continue;
    let got = 0;
    for (const k of def.boxes ? ['container'] : def.takes) {
      const n = Math.min(want - got, left[k] ?? 0);
      got += n;
      left[k] = (left[k] ?? 0) - n;
    }
    out[Number(code)] = got;
  }
  return out;
}

/** After a day's trade: how many want to live in town now. */
export function townDay(t: Town, jobs: number, map: GameMap): void {
  const sent = Object.entries(sentTo(t, map)).reduce(
    (n, [code, got]) => n + (got ?? 0) * (BUSINESSES[Number(code)]?.boxes ? B.CONTAINER_GOODS : 1),
    0,
  );
  t.sentFor = (t.sentFor ?? 0) * 0.7 + sent * 0.3;
  t.sent = {};
  t.goods = t.goods * 0.7 + t.today * 0.3;
  t.supplied = t.supplied * 0.7 + t.local * 0.3;
  t.today = 0;
  t.local = 0;
  t.jobs = jobs;
  t.wants = townWants(map);
  t.demand += (townTarget(t) - t.demand) * B.TOWN_GROWTH;
  // No more than its landmarks let it grow to.
  t.demand = Math.min(t.demand, townCap(t));
}

/**
 * At the end of a day, or as crates go on board: whether the town's next
 * landmark's goal is met. Returns the landmark it opens, if it does.
 */
export function landmarkDue(t: Town, endOfDay: boolean, tier = Infinity): Landmark | null {
  const next = landmarkGoal(t, tier);
  if (!next) return null;
  const g = next.goal;
  if (g.total !== undefined) {
    if (t.goal < g.total) return null;
  } else {
    if (!endOfDay) return null;
    t.streak = t.goal >= (g.perDay ?? 0) ? t.streak + 1 : 0;
    t.goal = 0;
    if (t.streak < (g.days ?? 1)) return null;
  }
  t.landmarks++;
  t.streak = 0;
  t.goal = 0;
  return next;
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
    const cur = queue[head];
    for (const n of map.neighbors4(cur)) {
      const b = map.build[n];
      if (!out[n] && (isPublicRoad(b) || isHighway(b)) && linked(map, cur, n)) {
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
      if (j < 0 || !map.isLand(j) || used.has(j) || map.yOf(j) <= map.limit) continue;
      const b = map.build[j];
      let c: number;
      // Onto the highway only at its own exit, the goal beside it.
      if (isHighway(b)) continue;
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
 * The town's road out to the highway down the west edge of the map, by
 * way of a spot off to one side so it bends rather than running straight.
 * Returns the tiles after `from`, the last beside the highway, where it
 * has an exit of its own, or [] when there is no way through.
 */
function highwayRoute(map: GameMap, from: number, seed: number): number[] {
  const roads = truckRoads(map);
  const near = portDistance(map);
  const out = (i: number) =>
    map.xOf(i) === HIGHWAY_COLUMNS && map.yOf(i) > map.limit && !exitError(map, map.yOf(i));
  const fx = map.xOf(from);
  const fy = map.yOf(from);
  // Halfway to the edge, pushed off up or down the coast.
  const side = (hash01(seed, fx, fy) * 2 - 1) * Math.min(10, fx / 3);
  const wx = Math.round(fx / 2);
  const wy = Math.round(Math.max(map.limit + 3, Math.min(map.h - 3, fy + side)));
  let way = -1;
  for (let r = 0; r <= 5 && way < 0; r++) {
    for (let dy = -r; dy <= r && way < 0; dy++) {
      for (let dx = -r; dx <= r && way < 0; dx++) {
        if (!map.inBounds(wx + dx, wy + dy)) continue;
        const i = map.idx(wx + dx, wy + dy);
        if (map.build[i] === Build.None && map.isLand(i) && map.yOf(i) > map.limit) way = i;
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

/**
 * Found the fishing village on the coast, as far from the port as there is
 * room, with a street along the shore, a chapel, a fish market, fish sheds
 * on the beach, cottages and a country road to the trucks' road. Works on
 * a map the player has already built on. Returns null when there is no
 * room for a town.
 */
export function foundTown(map: GameMap, name: string, touch: (i: number) => void): Town | null {
  let best = -1;
  let bestScore = -Infinity;
  for (let cy = map.limit + 8; cy < map.h - 7; cy++) {
    let shore = -1;
    for (let x = 0; x < map.w && shore < 0; x++) if (!map.isLand(map.idx(x, cy))) shore = x;
    if (shore < 24) continue;
    const c = map.idx(shore - 3, cy);
    if (!free(map, c)) continue;
    let room = 0;
    for (let dy = -9; dy <= 9; dy++) {
      for (let dx = -9; dx <= 9; dx++) {
        const x = shore - 3 + dx;
        const y = cy + dy;
        if (dx * dx + dy * dy > 81 || !map.inBounds(x, y)) continue;
        if (free(map, map.idx(x, y))) room++;
      }
    }
    // Room to grow, and well out past the port's land.
    const score = room + (cy - map.limit) * 0.5;
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
    wants: {},
    jobs: 0,
    stage: 0,
    layout: TOWN_LAYOUT,
    gate: -1,
    landmarks: 0,
    streak: 0,
    goal: 0,
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
  // …and the road inland, out to its own exit off the highway.
  const out = highwayRoute(map, best, best ^ 0x2c1);
  for (const i of out) street(i);
  const end = out.length > 0 ? out[out.length - 1] : -1;
  if (end >= 0 && map.xOf(end) === HIGHWAY_COLUMNS) {
    setExit(map, map.yOf(end), true);
    for (let x = 0; x < HIGHWAY_COLUMNS; x++) touch(map.idx(x, map.yOf(end)));
  }

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
        if (sea === undefined || map.yOf(i) <= map.limit) continue;
        place(map, i, Build.FishShed, sea, touch);
        sheds++;
      }
    }
  }
  // The chapel on the square, then the cottages: the fish market comes
  // once the port sends out fish enough (see LANDMARKS).
  for (const code of [Build.Chapel]) {
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
