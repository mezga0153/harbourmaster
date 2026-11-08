import type { GameMap } from './map';
import type { Crate } from './state';
import type { Rng } from './rng';
import { Build, Deco, Terrain, TICKS_PER_DAY } from './types';

// The main line: a railway running the length of the map, inland, that
// trains pass along now and then, and the port's own trains turn off into
// its sidings (systems/trains.ts). Each train runs along a way, a line of
// points; one at a time is under way, while those in sidings stand.

/** How far beyond the map ends trains start and finish, in tiles. */
export const RAIL_RUN = 44;
/** Length of one locomotive or wagon, in tiles. */
export const CAR_LENGTH = 1.3;
/** Barriers come down when a train is this many tiles from a crossing… */
export const CROSSING_WARN = 20;
/** …and lift once its last wagon is this far past. */
export const CROSSING_CLEAR = 1.5;

export type CarKind = 'loco' | 'coach' | 'box' | 'tank' | 'hopper' | 'flat';

/** A point in tiles, x then y: a tile's middle is its index plus a half. */
export type Point = [number, number];

/** What a port train is doing on its visit; see systems/trains.ts. */
export type PortTrainState = 'due' | 'in' | 'standing' | 'out' | 'away';

export interface PortVisit {
  /** The main line's tile its siding's switch is on. */
  switch: number;
  state: PortTrainState;
  /** The way along the main line it came, +1 towards +y; it goes on that way. */
  dir: 1 | -1;
  /** Ticks it stands in the siding to be worked. */
  stand: number;
  /** The tick it pulls out again, once standing. */
  leaves: number;
  /** The rail line that sent it, by contract id. */
  contractId?: number;
  /**
   * Its flat wagons' containers, a cell for each place one stands: wagon
   * `n` (counted from the locomotive, the first 1) has cells (n-1)*2 and
   * (n-1)*2+1. Exports it brought are `out`; see cargo/wagons.ts.
   */
  cells?: (Crate | null)[];
  /** Containers off the feeders it takes away, at most. */
  take?: number;
  /** Containers stackers are bringing it. */
  coming?: number;
  /** Containers stackers are taking off it. */
  taking?: number;
}

export interface Train {
  id: number;
  /** In the order they run, the front first; the locomotive at the back when it backs. */
  cars: CarKind[];
  /** Paint scheme. */
  variant: number;
  /** Tiles a tick, now. */
  speed: number;
  /** Tiles a tick at most. */
  top: number;
  /** Where it runs, from where it set out; on past the ends in straight lines. */
  way: Point[];
  /** How far along `way` its front is, in tiles; the cars trail behind. */
  at: number;
  /** Backing, the locomotive at the back. */
  back?: boolean;
  /** Stops at the end of its way rather than running on off the map. */
  stops?: boolean;
  /** A train calling at the port, rather than passing along the main line. */
  port?: PortVisit;
}

export interface RailState {
  trains: Train[];
  /** Tick the next train along the main line may set out. */
  nextTrain: number;
  /** Ids for new trains. */
  nextId: number;
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

/** The length of each leg of a way, and all of it. */
function legs(way: Point[]): { len: number[]; total: number } {
  const len: number[] = [];
  let total = 0;
  for (let k = 1; k < way.length; k++) {
    const d = Math.hypot(way[k][0] - way[k - 1][0], way[k][1] - way[k - 1][1]);
    len.push(d);
    total += d;
  }
  return { len, total };
}

/** How long a way is, in tiles. */
export function wayLength(way: Point[]): number {
  return legs(way).total;
}

/**
 * The point `s` tiles along a way, and the way it runs there (a unit
 * step); before its start and past its end, on in a straight line.
 */
export function pointAt(way: Point[], s: number): { x: number; y: number; dx: number; dy: number } {
  const { len } = legs(way);
  let k = 0;
  let rest = s;
  while (k < len.length - 1 && rest > len[k]) {
    rest -= len[k];
    k++;
  }
  const [ax, ay] = way[k];
  const [bx, by] = way[k + 1];
  const d = len[k] || 1;
  const dx = (bx - ax) / d;
  const dy = (by - ay) / d;
  return { x: ax + dx * rest, y: ay + dy * rest, dx, dy };
}

/** How far along a way the point nearest (x, y) is, when the way passes within `near` of it. */
export function along(way: Point[], x: number, y: number, near = 0.3): number | null {
  const { len } = legs(way);
  let s = 0;
  let best: number | null = null;
  let bestD = near;
  for (let k = 0; k < len.length; k++) {
    const [ax, ay] = way[k];
    const [bx, by] = way[k + 1];
    const d = len[k];
    if (d > 0) {
      const t = Math.max(0, Math.min(d, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / d));
      const off = Math.hypot(ax + ((bx - ax) * t) / d - x, ay + ((by - ay) * t) / d - y);
      if (off <= bestD) {
        bestD = off;
        best = s + t;
      }
    }
    s += d;
  }
  return best;
}

/**
 * Whether the train is under way: one waiting off the map to come in, or
 * standing in a siding, holds no line.
 */
export function moving(t: Train): boolean {
  return t.port?.state !== 'standing' && t.port?.state !== 'due';
}

/**
 * Whether the crossing on tile (x, y) has its barriers down for any of the
 * trains: from when one is CROSSING_WARN tiles off till its last car is
 * past, `ahead` ticks on.
 */
export function crossingClosed(trains: readonly Train[], x: number, y: number, ahead = 0): boolean {
  for (const t of trains) {
    if (!moving(t)) continue;
    const at = along(t.way, x + 0.5, y + 0.5);
    if (at === null) continue;
    const head = t.at + t.speed * ahead;
    if (head >= at - CROSSING_WARN && head - trainLength(t) <= at + CROSSING_CLEAR) return true;
  }
  return false;
}

/** Days between trains; a bigger town gets more of them. */
function trainGap(rng: Rng, stage: number): number {
  return Math.round((TICKS_PER_DAY * rng.range(0.35, 0.9)) / (1 + stage * 0.2));
}

/** The main line's whole length, the way `dir` runs, from past one end of the map to past the other. */
export function mainWay(column: number, mapH: number, dir: 1 | -1): Point[] {
  const x = column + 0.5;
  const a: Point = [x, -RAIL_RUN];
  const b: Point = [x, mapH + RAIL_RUN];
  return dir > 0 ? [a, b] : [b, a];
}

function makeTrain(rng: Rng, id: number, column: number, mapH: number, stage: number): Train {
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
  const speed = passenger ? 1.1 : 0.8;
  return {
    id,
    cars,
    variant: rng.int(0, 3),
    speed,
    top: speed,
    way: mainWay(column, mapH, dir),
    at: 0,
  };
}

export function newRail(rng: Rng): RailState {
  return { trains: [], nextTrain: trainGap(rng, 0), nextId: 1 };
}

/** A railway kept by an older save, which ran one train at a time. */
export function railFromSave(r: RailState | { train?: unknown; nextTrain: number }): RailState {
  if ('trains' in r && Array.isArray(r.trains)) return structuredClone(r);
  return { trains: [], nextTrain: r.nextTrain, nextId: 1 };
}

/** Port trains slow to a stop by this much a tick, and gather speed by half as much. */
const BRAKE = 0.006;

/** Move a train on a tick: up to its top speed, slowing to stop at the end of its way if it stops. */
export function runTrain(t: Train): void {
  if (!moving(t)) {
    t.speed = 0;
    return;
  }
  let v = Math.min(t.top, t.speed + BRAKE / 2);
  if (t.stops) {
    const left = wayLength(t.way) - t.at;
    v = Math.min(v, Math.max(0.02, Math.sqrt(2 * BRAKE * Math.max(0, left))));
    if (left <= v) {
      t.at += Math.max(0, left);
      t.speed = 0;
      return;
    }
  }
  t.speed = v;
  t.at += v;
}

/** The middle of a train, in tiles. */
export function trainSpot(t: Train): { x: number; y: number } {
  return pointAt(t.way, t.at - trainLength(t) / 2);
}

/** Whether a train that stops has come to the end of its way. */
export function arrived(t: Train): boolean {
  return !!t.stops && t.at >= wayLength(t.way) - 1e-6;
}

/**
 * Run the trains passing along the main line, one at a time and only while
 * no other train is under way (`busy`): a port train pulling in or out
 * has the line, and the next waits for it.
 */
export function stepThrough(
  rail: RailState,
  rng: Rng,
  tick: number,
  column: number,
  mapH: number,
  stage: number,
  busy: boolean,
): void {
  for (const t of [...rail.trains]) {
    if (t.port) continue;
    runTrain(t);
    if (t.at - trainLength(t) > wayLength(t.way)) {
      rail.trains.splice(rail.trains.indexOf(t), 1);
      rail.nextTrain = tick + trainGap(rng, stage);
    }
  }
  if (column < 0 || busy || tick < rail.nextTrain || rail.trains.some(moving)) return;
  rail.trains.push(makeTrain(rng, rail.nextId++, column, mapH, stage));
}
