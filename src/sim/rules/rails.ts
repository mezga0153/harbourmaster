// The port's sidings off the main line: where track may be laid, and the
// sidings it makes. A siding is straight, a row of track running from
// beside the main line, out across the port's land to its buffer stop; it
// leaves the line by a switch on the main line's tile beside its first.

import * as B from '../balance';
import type { GameMap } from '../map';
import { CAR_LENGTH, railColumn } from '../railway';
import { Build, Terrain } from '../types';
import { RAILS } from '../orient';

export interface Siding {
  /** The main line's tile its switch is on. */
  switch: number;
  /** Its tiles, from beside the main line out to the buffer stop. */
  tiles: number[];
  /** +1 runs off east of the line, -1 west. */
  side: 1 | -1;
}

/**
 * Port ground the siding track runs across: a port road crossing it on the
 * level, or a yard gantry standing over it.
 */
export function portCrossing(map: GameMap, i: number): boolean {
  const b = map.build[i];
  return (
    i >= 0 &&
    (b === Build.PortRoad || b === Build.YardGantry || b === Build.Loadout) &&
    (map.orient[i] & RAILS) !== 0
  );
}

/** Loading track, with or without a rail gantry standing over it. */
export function isLoading(map: GameMap, i: number): boolean {
  const b = map.build[i];
  return i >= 0 && (b === Build.LoadingTrack || b === Build.RailGantry);
}

/** Siding track, on its own, as loading track or across a port road. */
export function isTrack(map: GameMap, i: number): boolean {
  return i >= 0 && (map.build[i] === Build.Siding || isLoading(map, i) || portCrossing(map, i));
}

/** A siding's loading track: its tiles in one stretch, out from the main line; none without. */
export function loadingTrack(map: GameMap, s: Siding): number[] {
  return s.tiles.filter((t) => isLoading(map, t));
}

/**
 * How far out from the middle of the main line, in tiles along the siding,
 * a train standing on its loading track has its front: the locomotive on
 * the plain track past the loading track where there is room for it, else
 * up against the buffer stop. A tile `k` out (from 0) has its middle at
 * k + 1; with no loading track, the train stands at the buffer stop.
 */
export function standOffset(
  map: GameMap,
  s: Siding,
  on: (t: number) => boolean = (t) => isLoading(map, t),
): number {
  const buffer = s.tiles.length + 0.35;
  let last = -1;
  s.tiles.forEach((t, k) => {
    if (on(t)) last = k;
  });
  return last < 0 ? buffer : Math.min(buffer, last + 1.5 + CAR_LENGTH);
}

/** Leeway for a wagon's ends over the ends of loading track, in tiles. */
const WAGON_LEEWAY = 0.2;
/** How far out the back of a train standing in a siding stays, clear of the main line's trains. */
const CLEAR_OF_LINE = 0.85;

/**
 * How many wagons a train standing on a siding's loading track has on it,
 * the locomotive past it: the longest train the siding takes to be worked.
 * Zero without loading track.
 */
export function trackWagons(map: GameMap, s: Siding, more?: ReadonlySet<number>): number {
  const on = (t: number) => isLoading(map, t) || !!more?.has(t);
  const first = s.tiles.findIndex(on);
  if (first < 0) return 0;
  const front = standOffset(map, s, on) - CAR_LENGTH;
  const back = Math.max(first + 0.5 - WAGON_LEEWAY, CLEAR_OF_LINE);
  const n = Math.floor((front - back) / CAR_LENGTH);
  return Math.max(0, Math.min(B.TRAIN_MAX_WAGONS, n));
}

/** The longest train, in wagons, any siding's loading track takes. */
export function longestTrack(map: GameMap): number {
  return sidings(map).reduce((n, s) => Math.max(n, trackWagons(map, s)), 0);
}

/**
 * Why loading track cannot go on `i`, or null when it can: along a plain
 * siding, in one stretch with what is laid on it already (or queued in
 * the same drag, `pending`).
 */
export function loadingTrackError(
  map: GameMap,
  i: number,
  pending?: ReadonlySet<number>,
): string | null {
  if (isLoading(map, i)) return 'Loading track is laid here already';
  if (portCrossing(map, i)) return 'Loading track goes on plain siding track, not across a road';
  if (map.build[i] !== Build.Siding)
    return 'Loading track goes along a siding: lay the siding first';
  const s = sidingAt(map, i);
  if (!s) return 'Loading track goes along a siding: lay the siding first';
  const on = s.tiles
    .map((t, k) => (t === i || isLoading(map, t) || pending?.has(t) ? k : -1))
    .filter((k) => k >= 0);
  if (on.some((k, n) => n > 0 && k !== on[n - 1] + 1)) {
    return 'Loading track runs in one stretch along a siding: lay it on from an end of what is there';
  }
  return null;
}

/** The siding tile `i` is part of, if it is one. */
export function sidingAt(map: GameMap, i: number): Siding | null {
  if (!isTrack(map, i)) return null;
  const rail = railColumn(map);
  if (rail < 0) return null;
  const y = map.yOf(i);
  const side = map.xOf(i) > rail ? 1 : -1;
  const tiles: number[] = [];
  for (let x = rail + side; x >= 0 && x < map.w; x += side) {
    const t = map.idx(x, y);
    if (!isTrack(map, t)) break;
    tiles.push(t);
  }
  if (!tiles.includes(i)) return null;
  return { switch: map.idx(rail, y), tiles, side };
}

/** Every siding off the main line, north to south. */
export function sidings(map: GameMap): Siding[] {
  const rail = railColumn(map);
  if (rail < 0) return [];
  const out: Siding[] = [];
  for (let y = 0; y < map.h; y++) {
    for (const side of [1, -1] as const) {
      const x = rail + side;
      if (x < 0 || x >= map.w) continue;
      const s = sidingAt(map, map.idx(x, y));
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * Why siding track cannot be laid on `i`, or null when it can: straight
 * out from the main line along a row, joined to it tile by tile (or by
 * tiles queued in the same drag, `pending`), its switch clear of the
 * line's crossings and other switches.
 */
export function sidingError(map: GameMap, i: number, pending?: ReadonlySet<number>): string | null {
  const rail = railColumn(map);
  if (rail < 0) return 'There is no railway on this map';
  // Across a port road, a level crossing; nothing else is built over.
  const road = map.build[i] === Build.PortRoad;
  if (road && map.orient[i] & RAILS) return 'The track runs here already';
  if (road && map.store[i]) return 'Clear the storage marked out here first';
  if (map.build[i] !== Build.None && !road) return 'Something is already built here';
  if (!map.isLand(i)) return 'Track goes on land';
  if (map.terrain[i] === Terrain.Rock) return 'Rock is in the way: bulldoze it first';
  const x = map.xOf(i);
  const y = map.yOf(i);
  if (x === rail) return 'The main line runs here';
  const side = x > rail ? 1 : -1;
  // Joined to the main line by track all the way.
  for (let k = rail + side; k !== x; k += side) {
    const t = map.idx(k, y);
    if (!isTrack(map, t) && !pending?.has(t)) {
      return 'A siding runs straight out from the main line: lay it from beside the line, along the row';
    }
  }
  const sw = map.idx(rail, y);
  if (map.build[sw] !== Build.Rail) return 'A siding cannot leave the line at a level crossing';
  // A new switch keeps its distance from the line's crossings and other switches.
  if (x === rail + side) {
    for (let dy = -B.SWITCH_GAP; dy <= B.SWITCH_GAP; dy++) {
      if (!map.inBounds(rail, y + dy)) continue;
      const near = map.idx(rail, y + dy);
      if (dy !== 0 && Math.abs(dy) <= 1 && map.build[near] === Build.Crossing) {
        return 'Too close to a level crossing for a switch';
      }
      const other = [-1, 1].some((s) => {
        if (dy === 0 && s === side) return false;
        if (!map.inBounds(rail + s, y + dy)) return false;
        const t = map.idx(rail + s, y + dy);
        return isTrack(map, t) || (pending?.has(t) && t !== i);
      });
      if (other) return `Switches need ${B.SWITCH_GAP} rows of plain line between them`;
    }
  }
  return null;
}

/**
 * Why siding tile `i` cannot be taken up yet: only from the buffer stop
 * back, and loading track only from an end of it.
 */
export function sidingBulldozeError(map: GameMap, i: number): string | null {
  // Bulldozing a crossing, or a gantry or loadout over the track, leaves the track.
  if (portCrossing(map, i) || map.build[i] === Build.RailGantry) return null;
  const s = sidingAt(map, i);
  if (s && map.build[i] === Build.LoadingTrack) {
    const run = loadingTrack(map, s);
    return run[0] === i || run.at(-1) === i ? null : 'Take loading track up from either end of it';
  }
  if (!s || s.tiles.at(-1) === i) return null;
  return 'Take a siding up from its buffer stop back';
}
