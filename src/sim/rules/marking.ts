// Marks on port road and quay tiles: machines only, storage areas, one-way roads, lights, gates and roundabouts, and what each may and may not be.

import { FORKLIFT_ONLY, ON_PORT_ROAD } from '../orient';
import * as B from '../balance';
import { landError, OUTSIDE } from '../land';
import type { GameMap } from '../map';
import type { CostFn } from '../path';
import { canBeOneWay, LIGHTS, linked, ONE_WAY, GATE_IN, GATE_OUT, isHighway } from '../roads';
import { ownedByTown } from '../town';
import {
  Build,
  Deco,
  isCrane,
  isPublicRoad,
  STORE_CODE,
  Terrain,
  type BuildCode,
  type StoreKind,
} from '../types';
import { gantryOver } from './footprint';
import { nearCrane } from './placement';
import { truckCost } from './truckNav';
import { BUILDABLES } from './buildables';

export function forkliftOnly(map: GameMap, i: number): boolean {
  return (map.orient[i] & FORKLIFT_ONLY) !== 0;
}

export { OUTSIDE } from '../land';

/** Only port roads and plain quay can be marked for port machines only. */
export function forkliftOnlyError(map: GameMap, i: number): string | null {
  const land = landError(map, i);
  if (land) return land;
  if (forkliftOnly(map, i) && gantryOver(map, i, true) >= 0) {
    return 'Kept for port machines round a gantry crane’s rails';
  }
  const b = map.build[i];
  return b === Build.PortRoad || b === Build.Quay
    ? null
    : 'Only port roads and quays can be marked for port machines only';
}

/**
 * Kept for the port's machines: marked so, or round a crane. People on foot
 * and the hauliers' trucks keep off.
 */
export function machinesOnly(map: GameMap, i: number): boolean {
  const b = map.build[i];
  const paved = b === Build.PortRoad || b === Build.Quay || isCrane(b);
  return paved && (forkliftOnly(map, i) || nearCrane(map, i));
}

/** What marking out storage costs a tile. */
export const STORE_COST: Record<StoreKind, number> = {
  crates: B.CRATE_STORE_COST,
  boxes: B.BOX_STORE_COST,
  cratesOut: B.CRATE_STORE_COST,
  boxesOut: B.BOX_STORE_COST,
};

export const STORE_TIER: Record<StoreKind, number> = {
  crates: B.CRATE_STORE_TIER,
  boxes: B.BOX_STORE_TIER,
  cratesOut: B.CRATE_STORE_TIER,
  boxesOut: B.BOX_STORE_TIER,
};

export const STORE_LABEL: Record<StoreKind, string> = {
  crates: 'Crate storage, in',
  boxes: 'Container yard, in',
  cratesOut: 'Crate storage, out',
  boxesOut: 'Container yard, out',
};

export function storeKindAt(map: GameMap, i: number): StoreKind | null {
  const s = map.store[i];
  for (const [kind, code] of Object.entries(STORE_CODE)) if (code === s) return kind as StoreKind;
  return null;
}

/** Whether a tile can be marked out as storage, or cleared of it, with `on` false. */
export function storeError(map: GameMap, i: number, kind: StoreKind, on: boolean): string | null {
  const land = landError(map, i);
  if (land) return land;
  const code = STORE_CODE[kind];
  if (!on)
    return map.store[i] === code ? null : `Not marked out as ${STORE_LABEL[kind].toLowerCase()}`;
  if (map.store[i] === code) return 'Already marked out';
  if (map.store[i]) return 'Marked out for other storage: clear that first';
  if (gantryOver(map, i) >= 0) return 'Kept clear for a gantry crane’s rails';
  const b = map.build[i];
  return b === Build.PortRoad || b === Build.Quay
    ? null
    : 'Storage is marked out on port roads and quays';
}

/**
 * What the Unmark tool takes off a tile: its storage, and its mark for port
 * machines only, but never the ground kept for machines round a crane or a
 * gantry crane's rails. With what clearing the storage gives back.
 */
export function unmarkable(
  map: GameMap,
  i: number,
): { store: boolean; machines: boolean; road: boolean; parking: boolean } {
  if (!map.owns(i)) return { store: false, machines: false, road: false, parking: false };
  return {
    store: map.store[i] !== 0,
    machines: forkliftOnly(map, i) && gantryOver(map, i, true) < 0,
    // One way, or traffic lights: back to a plain road.
    road: canBeOneWay(map.build[i]) && (map.orient[i] & (ONE_WAY | LIGHTS)) !== 0,
    // Parking marked out on a road: the road again.
    parking: map.build[i] === Build.Parking,
  };
}

/**
 * The road a parking tile is marked out on, which it is again once
 * unmarked: as it was marked; for parking laid before it was marked out on
 * roads, port road inside the port, public road outside.
 */
export function roadUnderParking(map: GameMap, i: number): BuildCode {
  if (map.orient[i] & ON_PORT_ROAD) return Build.PortRoad;
  const near = map.neighbors4(i).map((n) => map.build[n]);
  const port = near.some((b) => b === Build.PortRoad || b === Build.Quay);
  return port && !near.some((b) => isPublicRoad(b)) ? Build.PortRoad : Build.Road;
}

/** Why truck parking cannot be marked out on tile `i`, or null. */
export function parkingError(map: GameMap, i: number): string | null {
  const b = map.build[i];
  if (b === Build.Parking) return 'This is marked out for parking already';
  if (b !== Build.Road && b !== Build.PortRoad)
    return 'Parking is marked out on a public road or port road: build the road first';
  if (map.store[i]) return 'Clear the storage marked out here first';
  if (forkliftOnly(map, i)) return 'Kept for port machines: clear the mark first';
  if (nearCrane(map, i)) return 'The ground round a crane is kept for port machines';
  return null;
}

/** Why tile `i` cannot be made one way, or null. */
export function oneWayError(map: GameMap, i: number): string | null {
  const land = landError(map, i);
  if (land) return land;
  const b = map.build[i];
  if (isHighway(b)) return 'The highway is one way each side already';
  if (!canBeOneWay(b)) return 'Only public roads and port roads can be made one way';
  if (ownedByTown(map, i)) return 'This belongs to the town';
  return null;
}

/**
 * Whether trucks meet other traffic at tile `i`, given how they drive
 * (`road`): three or four ways off it, other than inside a block of road
 * two wide, which is open ground.
 */
export function junctionAt(map: GameMap, i: number, road: CostFn = truckCost(map)): boolean {
  if (!Number.isFinite(road(i))) return false;
  const ways = map.neighbors4(i).filter((n) => Number.isFinite(road(n)) && linked(map, i, n));
  if (ways.length < 3) return false;
  const ok = (x: number, y: number) =>
    map.inBounds(x, y) &&
    Number.isFinite(road(map.idx(x, y))) &&
    !isHighway(map.build[map.idx(x, y)]);
  const x = map.xOf(i);
  const y = map.yOf(i);
  return ![-1, 1].some((dx) =>
    [-1, 1].some((dy) => ok(x + dx, y) && ok(x, y + dy) && ok(x + dx, y + dy)),
  );
}

/** Why traffic lights cannot go up (or come down) at tile `i`, or null. */
export function lightsError(map: GameMap, i: number): string | null {
  const land = landError(map, i);
  if (land) return land;
  if (isHighway(map.build[i]))
    return 'Nobody waits on the highway: trucks out there pass through each other';
  if (!canBeOneWay(map.build[i])) return 'Traffic lights go at a road junction';
  if (ownedByTown(map, i)) return 'This belongs to the town';
  if (!junctionAt(map, i)) return 'Traffic lights go where three or four roads meet';
  return null;
}

/**
 * A roundabout's ring round its island, as steps from the island, each
 * with the way traffic goes on it: anticlockwise, keeping right, so the
 * island is always on the left.
 */
export const ROUNDABOUT_RING: readonly (readonly [number, number, number])[] = [
  [1, 1, 3],
  [1, 0, 3],
  [1, -1, 2],
  [0, -1, 2],
  [-1, -1, 1],
  [-1, 0, 1],
  [-1, 1, 0],
  [0, 1, 0],
];

/** Why a roundabout cannot go round an island at `c`, or null. */
export function roundaboutError(map: GameMap, c: number): string | null {
  const cx = map.xOf(c);
  const cy = map.yOf(c);
  const tiles = [[0, 0], ...ROUNDABOUT_RING].map(([dx, dy]) => [cx + dx, cy + dy]);
  for (const [x, y] of tiles) {
    if (!map.inBounds(x, y)) return OUTSIDE;
    const i = map.idx(x, y);
    const land = landError(map, i);
    if (land) return land;
    const b = map.build[i];
    if (isHighway(b)) return 'Too near the highway';
    if (b === Build.Rail || b === Build.Crossing) return 'The railway is in the way';
    if (ownedByTown(map, i)) return 'This belongs to the town';
    if (b === Build.Road) continue;
    if (b !== Build.None) return 'A roundabout needs 3×3 of public road or clear land';
    if (!map.isLand(i)) return 'Must be built on land';
    if (map.terrain[i] === Terrain.Rock) return 'Rock is in the way';
  }
  return null;
}

/** What a roundabout round the island at `c` costs: the junction, and road where there is none. */
export function roundaboutCost(map: GameMap, c: number): number {
  let cost = B.ROUNDABOUT_COST;
  for (const [dx, dy] of ROUNDABOUT_RING) {
    const i = map.idx(map.xOf(c) + dx, map.yOf(c) + dy);
    if (map.build[i] === Build.None) cost += BUILDABLES.road.cost;
    if (map.deco[i] === Deco.Tree) cost += B.TREE_CLEAR_COST;
  }
  return cost;
}

/** The tiles of the storage area tile `i` is in: those marked out the same that it touches, and so on. */
export function storeArea(map: GameMap, i: number): Set<number> {
  const kind = map.store[i];
  const out = new Set<number>();
  if (!kind) return out;
  const stack = [i];
  out.add(i);
  while (stack.length > 0) {
    for (const n of map.neighbors4(stack.pop()!)) {
      if (map.store[n] !== kind || out.has(n)) continue;
      out.add(n);
      stack.push(n);
    }
  }
  return out;
}

/** Which way trucks may go through a port gate. */
export function gateWay(map: GameMap, i: number): 'both' | 'in' | 'out' {
  if (map.build[i] !== Build.Gate) return 'both';
  return map.orient[i] & GATE_IN ? 'in' : map.orient[i] & GATE_OUT ? 'out' : 'both';
}

export function unmarkRefund(map: GameMap, i: number): number {
  if (map.build[i] === Build.Parking) return Math.floor(B.PARKING_COST * B.BULLDOZE_REFUND);
  const kind = storeKindAt(map, i);
  return kind ? Math.floor(STORE_COST[kind] * B.BULLDOZE_REFUND) : 0;
}
