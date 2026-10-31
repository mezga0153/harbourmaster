import { Group, type BufferGeometry } from 'three';
import type { GameMap } from '../../sim/map';
import { Build, isPublicRoad } from '../../sim/types';
import { C } from '../palette';
import { box } from '../parts';
import { bake } from '../town';
import { offset } from './map';
import { BARRIER, STEEL } from './paints';

// The fence round the port: along the sides of its port roads that face
// the public road or the edge of the map, never those facing its own
// ground, with the gate the one way through it.

/** How far in from the tile's edge the fence stands. */
const IN = 0.06;
const HEIGHT = 0.24;
const POST = 0.035;
/** The gate's fence runs in from either side to here, leaving the lane and its barrier between. */
export const GATE_SIDE = 0.14;

const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Whether the ground beyond tile `i` towards dx, dy is the public road or off the map. */
function outside(m: GameMap, i: number, dx: number, dy: number): boolean {
  const n = offset(m, i, dx, dy);
  return n < 0 || isPublicRoad(m.build[n]) || m.build[n] === Build.Highway;
}

/** Which sides of port road `i` face the public road or the edge of the map, in SIDES order. */
export function fencedSides(m: GameMap, i: number): boolean[] {
  return SIDES.map(([dx, dy]) => outside(m, i, dx, dy));
}

/**
 * A run of fence on the ground at `y`, from (x0, z0) to (x1, z1) along one
 * axis: panels between a top and a bottom rail, and a post at each place
 * in `posts`, measured along it from its start.
 */
function run(
  g: Group,
  y: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  posts: number[],
): void {
  const alongX = z0 === z1;
  const len = alongX ? x1 - x0 : z1 - z0;
  if (len <= 0) return;
  const mx = (x0 + x1) / 2;
  const mz = (z0 + z1) / 2;
  const [w, d] = alongX ? [len, 0.006] : [0.006, len];
  g.add(box(w, HEIGHT - 0.05, d, BARRIER, mx, y + 0.025, mz));
  const [rw, rd] = alongX ? [len, 0.016] : [0.016, len];
  g.add(box(rw, 0.016, rd, STEEL, mx, y + HEIGHT - 0.016, mz));
  g.add(box(rw, 0.012, rd, STEEL, mx, y + 0.012, mz));
  for (const p of posts) {
    const [px, pz] = alongX ? [x0 + p, z0] : [x0, z0 + p];
    g.add(box(POST, HEIGHT + 0.015, POST, C.chassis, px, y, pz));
  }
}

/**
 * The fence along the sides of port road `i` that face the public road or
 * the edge of the map, standing at `y`: each side's run clipped where it
 * meets another's at a corner, with a post there, posts along it, and one
 * at an end where the fence stops.
 */
export function fences(m: GameMap, g: Group, i: number, y: number, owned?: BufferGeometry[]): void {
  const sides = fencedSides(m, i);
  if (!sides.some(Boolean)) return;
  const f = new Group();
  /** Whether the fence on side `k` carries on into the tile towards dx, dy along it. */
  const carriesOn = (k: number, dx: number, dy: number) => {
    const n = offset(m, i, dx, dy);
    if (n < 0) return false;
    if (m.build[n] === Build.Gate) return true;
    return m.build[n] === Build.PortRoad && fencedSides(m, n)[k];
  };
  sides.forEach((fenced, k) => {
    if (!fenced) return;
    const [dx, dy] = SIDES[k];
    const alongX = dx === 0;
    // The two sides at the ends of this run, in SIDES order: the lower end first.
    const [lo, hi] = alongX ? [1, 0] : [3, 2];
    let a = 0;
    let b = 1;
    const posts: number[] = [];
    if (sides[lo]) {
      a = IN;
      // The corner post goes with the side of the lower index, drawn once.
      if (k < lo) posts.push(0);
    } else if (!carriesOn(k, alongX ? -1 : 0, alongX ? 0 : -1)) posts.push(0);
    if (sides[hi]) {
      b = 1 - IN;
      if (k < hi) posts.push(b - a);
    } else if (!carriesOn(k, alongX ? 1 : 0, alongX ? 0 : 1)) posts.push(b - a);
    for (const p of [0.25, 0.75]) if (p > a + 0.04 && p < b - 0.04) posts.push(p - a);
    const at = dx > 0 || dy > 0 ? 1 - IN : IN;
    if (alongX) run(f, y, a, at, b, at, posts);
    else run(f, y, at, a, at, b, posts);
  });
  g.add(bake(f, owned));
}

/**
 * The fence either side of a port gate's lane, along its front (+z before
 * it is turned to face the road), joining the fence along the port roads
 * beside it and stopping at posts where the barrier takes over.
 */
export function gateFence(g: Group, y: number, owned?: BufferGeometry[]): void {
  const f = new Group();
  const z = 1 - IN;
  run(f, y, 0, z, GATE_SIDE, z, [GATE_SIDE]);
  run(f, y, 1 - GATE_SIDE, z, 1, z, [0]);
  g.add(bake(f, owned));
}
