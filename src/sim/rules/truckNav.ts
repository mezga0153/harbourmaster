// How trucks find their way: what each road tile costs, lanes along a road, how far they reach and where they load.

import type { GameMap } from '../map';
import type { CostFn } from '../path';
import { flowOk, GATE_IN, GATE_OUT, hasHighway, highwayIns, isHighway, oneWay } from '../roads';
import { Build, isPublicRoad } from '../types';
import { nearCrane } from './placement';
import { forkliftOnly, machinesOnly } from './marking';
import { anchorOf } from './footprint';

/**
 * Trucks drive on public roads, and on port roads once they are through a
 * port gate: never straight from one to the other. A truck bay is only
 * enterable as the destination, or the one being left, from any side of it
 * that touches a road. Storage areas they load beside, never drive into, and
 * they keep off machines-only ground.
 */
export function truckCost(
  map: GameMap,
  target = -1,
  home = -1,
  /** The parking space a truck is driving into or out of; other parking it keeps off. */
  space?: ReadonlySet<number>,
  /** How far each road runs across from each tile, from laneRuns; worked out as needed without. */
  runs?: Uint8Array,
): CostFn {
  const way = (i: number): 'road' | 'port' | 'gate' | null => {
    const b = map.build[i];
    if (map.store[i] || nearCrane(map, i)) return null;
    if (isPublicRoad(b) || isHighway(b)) return 'road';
    // A parking space is driven through from the road on one side to the
    // road on the other, which are of a kind; see parkingLots.
    if (b === Build.Parking) return space?.has(i) ? 'gate' : null;
    // Trucks drive under a yard gantry, to load from it.
    const paved = b === Build.PortRoad || b === Build.Quay || b === Build.YardGantry;
    if (paved) return forkliftOnly(map, i) ? null : 'port';
    if (b === Build.Gate) return 'gate';
    const a = anchorOf(map, i);
    return a === target || a === home ? 'gate' : null;
  };
  return (i, from) => {
    const here = way(i);
    if (!here) return Infinity;
    const known = from !== undefined && from >= 0;
    // Along the highway its own way, on and off at the exits, and never
    // the wrong way down a one-way road.
    if (known && !flowOk(map, from, i)) return Infinity;
    const there = known ? way(from) : null;
    const jump = (here === 'road' && there === 'port') || (here === 'port' && there === 'road');
    if (jump) return Infinity;
    // A port gate for trucks only coming in, or only going out.
    if (known && map.build[i] === Build.Gate) {
      if (there === 'road' && map.orient[i] & GATE_OUT) return Infinity;
      if (there === 'port' && map.orient[i] & GATE_IN) return Infinity;
    }
    if (known && map.build[from] === Build.Gate) {
      if (here === 'port' && map.orient[from] & GATE_OUT) return Infinity;
      if (here === 'road' && map.orient[from] & GATE_IN) return Infinity;
    }
    // Keep to the right on a road wider than one: the left half of the road
    // it is on, across the way it is going, is the oncoming lane; across a
    // road three wide, the middle is either's, and on paving wider still
    // the right half is all its own. A one-way road has no oncoming lane.
    if (known && here !== 'gate' && oneWay(map, i) < 0) {
      const dx = map.xOf(i) - map.xOf(from);
      const dy = map.yOf(i) - map.yOf(from);
      if (leftHalf(map, i, -dy, dx, runs)) {
        return 1 + KEEP_RIGHT;
      }
    }
    return 1;
  };
}

/**
 * The kind of road a tile is for trucks, whatever they are going to: public
 * road (and the highway), or port road and quay; null for anything else,
 * and for storage, machines-only ground and the ground round a crane.
 */
function roadKind(map: GameMap, i: number): 'road' | 'port' | null {
  const b = map.build[i];
  if (map.store[i] || nearCrane(map, i)) return null;
  if (isPublicRoad(b) || isHighway(b)) return 'road';
  // Trucks drive under a yard gantry, to load from it.
  const paved = b === Build.PortRoad || b === Build.Quay || b === Build.YardGantry;
  return paved && !forkliftOnly(map, i) ? 'port' : null;
}

/** How far across a road the keep-right rule looks either way, in tiles. */
const LANE_SCAN = 4;

/** The grid steps along +x, -x, +y and -y, by their place in laneRuns. */
const STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function stepIndex(dx: number, dy: number): number {
  return dx > 0 ? 0 : dx < 0 ? 1 : dy > 0 ? 2 : 3;
}

/**
 * For each tile and each of the four ways along the grid (see STEPS), how
 * many tiles of road of its own kind run on from it that way, LANE_SCAN at
 * most: how far a road runs across from each tile, for keeping right.
 */
export function laneRuns(map: GameMap): Uint8Array {
  const n = map.build.length;
  const kinds = new Array<'road' | 'port' | null>(n);
  for (let i = 0; i < n; i++) kinds[i] = roadKind(map, i);
  const out = new Uint8Array(n * 4);
  STEPS.forEach(([dx, dy], d) => {
    // From the far end back, each one more than the next along, if alike.
    const xs = dx > 0 ? [map.w - 1, -1, -1] : [0, map.w, 1];
    const ys = dy > 0 ? [map.h - 1, -1, -1] : [0, map.h, 1];
    for (let y = ys[0]; y !== ys[1]; y += ys[2]) {
      for (let x = xs[0]; x !== xs[1]; x += xs[2]) {
        const i = map.idx(x, y);
        const nx = x + dx;
        const ny = y + dy;
        if (!kinds[i] || !map.inBounds(nx, ny)) continue;
        const j = map.idx(nx, ny);
        if (kinds[j] !== kinds[i]) continue;
        out[i * 4 + d] = Math.min(LANE_SCAN, 1 + out[j * 4 + d]);
      }
    }
  });
  return out;
}

/** How many tiles of road of its kind run on from tile `i` the way (dx, dy). */
function runFrom(map: GameMap, i: number, dx: number, dy: number, runs?: Uint8Array): number {
  if (runs) return runs[i * 4 + stepIndex(dx, dy)];
  const kind = roadKind(map, i);
  let n = 0;
  let x = map.xOf(i);
  let y = map.yOf(i);
  while (n < LANE_SCAN) {
    x += dx;
    y += dy;
    if (!map.inBounds(x, y) || roadKind(map, map.idx(x, y)) !== kind) break;
    n++;
  }
  return n;
}

/**
 * Whether tile `i` is in the left half of the road across it, for a truck
 * going the way whose right is (rx, ry): more of the road lies to its
 * right than to its left.
 */
function leftHalf(map: GameMap, i: number, rx: number, ry: number, runs?: Uint8Array): boolean {
  const right = runFrom(map, i, rx, ry, runs);
  return right > 0 && runFrom(map, i, -rx, -ry, runs) < right;
}

/** What driving in the left-hand lane of a wide road costs a truck, on top of a tile. */
const KEEP_RIGHT = 1.5;

/**
 * How far trucks drive from the highway to each tile they can get to, or
 * -1: public roads, and port roads and quays through a port gate.
 */
export function truckReach(map: GameMap): Int32Array {
  const cost = truckCost(map);
  const dist = new Int32Array(map.build.length).fill(-1);
  const queue: number[] = [];
  // In off the ends of the highway; on maps without one, at the main road's end.
  const starts = hasHighway(map) ? highwayIns(map).map((s) => s.tile) : [map.entry];
  for (const s of starts) {
    if (s < 0 || !Number.isFinite(cost(s))) continue;
    dist[s] = 0;
    queue.push(s);
  }
  for (let k = 0; k < queue.length; k++) {
    const cur = queue[k];
    for (const n of map.neighbors4(cur)) {
      if (dist[n] >= 0 || !Number.isFinite(cost(n, cur))) continue;
      dist[n] = dist[cur] + 1;
      queue.push(n);
    }
  }
  return dist;
}

/**
 * Tiles beside a storage area where trucks can stand to load, nearest the
 * highway first. Storage is inside the port, so they load from a port road
 * or quay they reach through a port gate, never from a public road outside
 * it; and not beside storage on machines-only ground, which only the port's
 * own machines work.
 */
export function loadingSpots(map: GameMap, tiles: number[], reach: Int32Array): number[] {
  const area = new Set(tiles);
  const spots = new Set<number>();
  for (const t of tiles) {
    if (machinesOnly(map, t)) continue;
    for (const n of map.neighbors4(t)) {
      if (area.has(n) || reach[n] < 0 || map.store[n]) continue;
      const b = map.build[n];
      // Under a yard gantry too, which loads them there.
      if (b !== Build.PortRoad && b !== Build.Quay && b !== Build.YardGantry) continue;
      spots.add(n);
    }
  }
  return [...spots].sort((p, q) => reach[p] - reach[q] || p - q);
}
