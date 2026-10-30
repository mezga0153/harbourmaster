import type { GameMap } from './map';
import type { Rng } from './rng';
import { Build, Deco, Terrain, TICKS_PER_DAY } from './types';

// The main line: a railway running the length of the map, inland, that
// trains pass along now and then. One day the port gets a siding off it.

/** How far beyond the map ends trains start and finish, in tiles. */
export const RAIL_RUN = 44;
/** Length of one locomotive or wagon, in tiles. */
export const CAR_LENGTH = 1.3;
/** Barriers come down when a train is this many tiles from a crossing… */
export const CROSSING_WARN = 20;
/** …and lift once its last wagon is this far past. */
export const CROSSING_CLEAR = 1.5;

export type CarKind = 'loco' | 'coach' | 'box' | 'tank' | 'hopper' | 'flat';

export interface Train {
  /** The front of the train, in tiles along the line (y for a north–south line). */
  head: number;
  /** +1 runs towards +y, -1 towards -y. */
  dir: 1 | -1;
  /** Tiles a tick. */
  speed: number;
  /** Locomotive first. */
  cars: CarKind[];
  /** Paint scheme. */
  variant: number;
}

export interface RailState {
  train: Train | null;
  /** Tick the next train sets out. */
  nextTrain: number;
}

export function trainLength(t: Train): number {
  return t.cars.length * CAR_LENGTH;
}

/** The column the line runs down, or -1 on a map without one. */
export function railColumn(map: GameMap): number {
  for (let x = 0; x < map.w; x++) {
    const b = map.build[map.idx(x, 0)];
    if (b === Build.Rail || b === Build.Crossing) return x;
  }
  return -1;
}

/**
 * Lay the line north to south down a column of open land, inland and clear
 * of the sea, crossing public roads on the level. Works on a map the player
 * has already built on. Returns the tiles changed.
 */
export function layRailway(map: GameMap): number[] {
  const laid = railColumn(map);
  if (laid >= 0) return continueLine(map, laid);
  let best = -1;
  let bestScore = -Infinity;
  for (let x = 3; x <= Math.min(16, map.w - 1); x++) {
    let score = x;
    for (let y = 0; y < map.h && score > -Infinity; y++) {
      const i = map.idx(x, y);
      const b = map.build[i];
      const road = b === Build.Road;
      // Only straight across a road, never along one or through a building.
      const along =
        road &&
        ((y > 0 && map.build[i - map.w] === Build.Road) ||
          (y < map.h - 1 && map.build[i + map.w] === Build.Road));
      if (!map.isLand(i) || (b !== Build.None && !road) || along) {
        score = -Infinity;
        break;
      }
      // Keep a few fields between the line and the sea, and out of the port.
      for (let d = 1; d <= 6; d++) {
        if (x + d >= map.w) break;
        const n = map.idx(x + d, y);
        if (!map.isLand(n)) {
          score -= (7 - d) * 2;
          break;
        }
        if (map.build[n] !== Build.None && map.build[n] !== Build.Road) {
          score -= 7 - d;
          break;
        }
      }
      if (map.terrain[i] === Terrain.Rock) score -= 0.5;
      if (road) score -= 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = x;
    }
  }
  if (best < 0) return [];
  const changed: number[] = [];
  for (let y = 0; y < map.h; y++) {
    const i = map.idx(best, y);
    map.build[i] = map.build[i] === Build.Road ? Build.Crossing : Build.Rail;
    // A cutting through rock.
    if (map.terrain[i] === Terrain.Rock) map.terrain[i] = Terrain.Grass;
    map.deco[i] = Deco.None;
    changed.push(i);
  }
  return changed;
}

/**
 * Carry a line laid on an older, shorter map on down the rows added since,
 * on an embankment where it meets the sea.
 */
function continueLine(map: GameMap, x: number): number[] {
  const changed: number[] = [];
  for (let y = 0; y < map.h; y++) {
    const i = map.idx(x, y);
    if (map.build[i] === Build.Rail || map.build[i] === Build.Crossing) continue;
    map.build[i] = map.build[i] === Build.Road ? Build.Crossing : Build.Rail;
    if (!map.isLand(i) || map.terrain[i] === Terrain.Rock) {
      map.terrain[i] = Terrain.Grass;
      map.ocean[i] = 0;
      map.depth[i] = 0;
    }
    map.deco[i] = Deco.None;
    changed.push(i);
  }
  return changed;
}

/** Whether a crossing at row `y` has its barriers down for the train. */
export function crossingClosed(train: Train | null, y: number, ahead = 0): boolean {
  if (!train) return false;
  // Positions measured along the way the train is going: `ahead` ticks on.
  const head = train.dir * train.head + train.speed * ahead;
  const at = train.dir * (y + 0.5);
  return head >= at - CROSSING_WARN && head - trainLength(train) <= at + CROSSING_CLEAR;
}

/** Days between trains; a bigger town gets more of them. */
function trainGap(rng: Rng, stage: number): number {
  return Math.round((TICKS_PER_DAY * rng.range(0.35, 0.9)) / (1 + stage * 0.2));
}

function makeTrain(rng: Rng, mapH: number, stage: number): Train {
  const dir = rng.next() < 0.5 ? 1 : -1;
  const passenger = rng.next() < 0.25 + stage * 0.12;
  const cars: CarKind[] = ['loco'];
  if (passenger) {
    const n = rng.int(3, 4 + stage);
    for (let k = 0; k < n; k++) cars.push('coach');
  } else {
    // Freight runs in blocks of the same wagon.
    const n = rng.int(6, 12);
    let kind: CarKind = 'box';
    for (let k = 0; k < n; k++) {
      if (k === 0 || rng.next() < 0.3) kind = rng.pick(['box', 'tank', 'hopper', 'flat'] as const);
      cars.push(kind);
    }
  }
  return {
    head: dir > 0 ? -RAIL_RUN : mapH + RAIL_RUN,
    dir,
    speed: passenger ? 1.1 : 0.8,
    cars,
    variant: rng.int(0, 3),
  };
}

export function newRail(rng: Rng): RailState {
  return { train: null, nextTrain: trainGap(rng, 0) };
}

/** Run trains along the line, one at a time. */
export function stepRail(
  rail: RailState,
  rng: Rng,
  tick: number,
  mapH: number,
  stage: number,
): void {
  const t = rail.train;
  if (!t) {
    if (tick >= rail.nextTrain) rail.train = makeTrain(rng, mapH, stage);
    return;
  }
  t.head += t.dir * t.speed;
  const tail = t.head - t.dir * trainLength(t);
  if ((t.dir > 0 && tail > mapH + RAIL_RUN) || (t.dir < 0 && tail < -RAIL_RUN)) {
    rail.train = null;
    rail.nextTrain = tick + trainGap(rng, stage);
  }
}
