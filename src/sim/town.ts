import * as B from './balance';
import type { GameMap } from './map';
import { hash01 } from './noise';
import { Build, Deco, isTownBuilding, Terrain } from './types';

// The town up the coast. It starts as a fishing village and grows with
// the port: every job at the port and every crate it sends out by road
// keeps more people in town. The player has no say in it: the town lays
// out its own streets and puts up and rebuilds its own buildings.

/** Marks a road the town laid, in `GameMap.orient`; the player cannot touch it. */
export const TOWN = 128;

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

export interface Town {
  name: string;
  /** The chapel square; streets run on a grid from here and the town grows outwards. */
  centre: number;
  /** People who would live here if there were homes; builders put them up to match. */
  demand: number;
  /** Crates' worth of goods the port sent out by road per day, over the last few days. */
  goods: number;
  /** Goods sent out so far today. */
  today: number;
  /** Jobs at the port and with its hauliers, as of this morning. */
  jobs: number;
  /** Index into TOWN_STAGES; a town never shrinks back down a stage. */
  stage: number;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** People the port's jobs and trade support. */
export function townTarget(t: Town): number {
  return B.TOWN_BASE + B.TOWN_PER_JOB * t.jobs + B.TOWN_PER_GOODS * t.goods;
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
  if (map.build[i] !== Build.None || !map.isLand(i)) return false;
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

/** Streets run along every third row and every sixth column through the centre. */
function streetLine(map: GameMap, t: Town, i: number): { row: boolean; col: boolean } {
  return {
    row: mod(map.yOf(i) - map.yOf(t.centre), 3) === 0,
    col: mod(map.xOf(i) - map.xOf(t.centre), 6) === 0,
  };
}

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

/** Which way a building on `i` faces: onto a street, rows first. */
function facingStreet(map: GameMap, i: number): number {
  const x = map.xOf(i);
  const y = map.yOf(i);
  // FACING order: 0 +x, 1 +y, 2 -x, 3 -y.
  for (const [f, dx, dy] of [
    [1, 0, 1],
    [3, 0, -1],
    [0, 1, 0],
    [2, -1, 0],
  ] as const) {
    if (map.inBounds(x + dx, y + dy) && isTownStreet(map, map.idx(x + dx, y + dy))) return f;
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
 * The builders' next job: rebuild a home taller near the centre, put up a
 * new one on a street, or lay a new stretch of street so there is room to
 * build. Returns false when the town has nowhere left to go.
 */
export function growTown(t: Town, map: GameMap, touch: (i: number) => void): boolean {
  const pop = population(t, map);
  let up = -1;
  let upScore = Infinity;
  let plot = -1;
  let plotScore = Infinity;
  let street = -1;
  let streetScore = Infinity;
  let parks = 0;
  for (let i = 0; i < map.build.length; i++) {
    const b = map.build[i];
    if (b === Build.Park) parks++;
    const level = (LEVELS as readonly number[]).indexOf(b);
    if (level >= 0) {
      const r = reach(map, t, i);
      if (level < maxLevel(t, pop, r) && r < upScore) {
        up = i;
        upScore = r;
      }
      continue;
    }
    if (!free(map, i)) continue;
    const line = streetLine(map, t, i);
    const x = map.xOf(i);
    const y = map.yOf(i);
    const streetAt = (dx: number, dy: number) =>
      map.inBounds(x + dx, y + dy) && isTownStreet(map, map.idx(x + dx, y + dy));
    const r = reach(map, t, i);
    if (line.row || line.col) {
      // Streets grow straight on along their line.
      const joins =
        (line.row && (streetAt(1, 0) || streetAt(-1, 0))) ||
        (line.col && (streetAt(0, 1) || streetAt(0, -1)));
      if (joins && r < streetScore) {
        street = i;
        streetScore = r;
      }
    } else if (
      (streetAt(1, 0) || streetAt(-1, 0) || streetAt(0, 1) || streetAt(0, -1)) &&
      r < plotScore
    ) {
      plot = i;
      plotScore = r;
    }
  }

  if (plot >= 0 && t.stage >= 2 && parks < t.stage - 1) {
    // Each bigger town gets another green square near the middle.
    place(map, plot, Build.Park, facingStreet(map, plot), touch);
  } else if (up >= 0 && (plot < 0 || upScore <= plotScore)) {
    const level = (LEVELS as readonly number[]).indexOf(map.build[up]);
    place(map, up, LEVELS[level + 1], map.orient[up], touch);
  } else if (plot >= 0 && (street < 0 || plotScore <= streetScore + 2)) {
    const level = Math.min(1, maxLevel(t, pop, plotScore));
    place(map, plot, LEVELS[level], facingStreet(map, plot), touch);
  } else if (street >= 0) {
    place(map, street, Build.Road, TOWN, touch);
  } else return false;
  return true;
}

/** After a day's trade: how many want to live in town now. */
export function townDay(t: Town, jobs: number): void {
  t.goods = t.goods * 0.7 + t.today * 0.3;
  t.today = 0;
  t.jobs = jobs;
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

/**
 * Found the fishing village on the coast, well away from the port, with a
 * main street out to the edge of the map, a chapel, fish sheds on the beach
 * and cottages. Works on a map the player has already built on. Returns
 * null when there is no room for a town.
 */
export function foundTown(map: GameMap, name: string, touch: (i: number) => void): Town | null {
  const portRow = map.yOf(map.entry);
  let best = -1;
  let bestScore = -Infinity;
  for (let cy = 10; cy < map.h - 10; cy++) {
    const away = Math.abs(cy - portRow);
    if (away < 18) continue;
    let shore = -1;
    for (let x = 0; x < map.w && shore < 0; x++) if (!map.isLand(map.idx(x, cy))) shore = x;
    if (shore < 24) continue;
    const cx = shore - 3;
    // The main street runs straight inland to the edge of the map.
    let clear = true;
    for (let x = 0; x <= cx && clear; x++) {
      const i = map.idx(x, cy);
      const b = map.build[i];
      clear =
        map.isLand(i) &&
        (b === Build.None || b === Build.Rail || b === Build.Road || b === Build.Crossing);
    }
    if (!clear || !free(map, map.idx(cx, cy))) continue;
    let room = 0;
    for (let dy = -9; dy <= 9; dy++) {
      for (let dx = -9; dx <= 9; dx++) {
        if (dx * dx + dy * dy > 81 || !map.inBounds(cx + dx, cy + dy)) continue;
        if (free(map, map.idx(cx + dx, cy + dy))) room++;
      }
    }
    const score = room - Math.abs(away - 26) * 2;
    if (score > bestScore) {
      bestScore = score;
      best = map.idx(cx, cy);
    }
  }
  if (best < 0) return null;

  const t: Town = {
    name,
    centre: best,
    demand: B.TOWN_START,
    goods: 0,
    today: 0,
    jobs: 0,
    stage: 0,
  };
  const cx = map.xOf(best);
  const cy = map.yOf(best);
  for (let x = 0; x <= cx; x++) {
    const i = map.idx(x, cy);
    if (map.build[i] === Build.None) place(map, i, Build.Road, TOWN, touch);
    else if (map.build[i] === Build.Rail) place(map, i, Build.Crossing, TOWN, touch);
  }
  // Fish sheds on the beach below the village, doors to the sea.
  let sheds = 0;
  for (let r = 1; r <= 5 && sheds < 2; r++) {
    for (let dy = -r; dy <= r && sheds < 2; dy++) {
      for (let dx = -r; dx <= r + 2 && sheds < 2; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!map.inBounds(x, y) || Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const i = map.idx(x, y);
        if (map.build[i] !== Build.None || !map.isLand(i)) continue;
        if (map.neighbors4(i).some((n) => isTownBuilding(map.build[n]))) continue;
        const sea = [
          [0, 1, 0],
          [1, 0, 1],
          [2, -1, 0],
          [3, 0, -1],
        ].find(([, sx, sy]) => map.inBounds(x + sx, y + sy) && map.ocean[map.idx(x + sx, y + sy)]);
        if (!sea) continue;
        let nearPort = false;
        for (let k = -2; k <= 2 && !nearPort; k++) {
          for (let m = -2; m <= 2 && !nearPort; m++) {
            if (map.inBounds(x + m, y + k)) nearPort = playerBuilt(map, map.idx(x + m, y + k));
          }
        }
        if (nearPort) continue;
        place(map, i, Build.FishShed, sea[0], touch);
        sheds++;
      }
    }
  }
  // The chapel goes on the square, then the fishers' cottages.
  const chapel = [map.idx(cx, cy + 1), map.idx(cx, cy - 1), map.idx(cx - 1, cy + 1)].find((i) =>
    free(map, i),
  );
  if (chapel !== undefined) place(map, chapel, Build.Chapel, facingStreet(map, chapel), touch);
  for (let k = 0; k < 100 && townHomes(map) < B.TOWN_START; k++) {
    if (!growTown(t, map, touch)) break;
  }
  return t;
}
