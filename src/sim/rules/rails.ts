// The port's sidings off the main line: where track may be laid, and the
// sidings it makes. A siding is straight, a row of track running from
// beside the main line, out across the port's land to its buffer stop; it
// leaves the line by a switch on the main line's tile beside its first.

import * as B from '../balance';
import type { GameMap } from '../map';
import { railColumn } from '../railway';
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

/** Siding track, on its own or across a port road. */
export function isTrack(map: GameMap, i: number): boolean {
  return i >= 0 && (map.build[i] === Build.Siding || portCrossing(map, i));
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

/** Why siding tile `i` cannot be taken up yet: only from the buffer stop back. */
export function sidingBulldozeError(map: GameMap, i: number): string | null {
  // Bulldozing a crossing, or a gantry over the track, leaves the track.
  if (portCrossing(map, i)) return null;
  const s = sidingAt(map, i);
  if (!s || s.tiles.at(-1) === i) return null;
  return 'Take a siding up from its buffer stop back';
}
