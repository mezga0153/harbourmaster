import { FACING } from './footprint';
// The ground cut finer than tiles, four by four cells a tile, for the
// port's staff to find their way across round crates: the search itself,
// over whatever says which cells are clear. The sim drives forklifts by it
// (systems/workforce/forkCells.ts); the view walks dockhands and lines
// forklifts up by it (render/entities/grid.ts).

/** Cells across a tile, each way. */
export const SUB = 4;
/** How wide a cell is, in tiles. */
export const CELL = 1 / SUB;

/** A point on the ground, in tiles. */
export interface CellPoint {
  x: number;
  z: number;
}

/** What a search across the cells is asked to do; nodes are numbered nx, nz. */
export interface CellSearch {
  /** The nodes it may go by, inclusive: x0, z0, x1, z1. */
  bounds: [number, number, number, number];
  /** Whether it may stand at node nx, nz. */
  free(nx: number, nz: number): boolean;
  /** Whether node nx, nz is never to be gone by at all, as off its way; none if not given. */
  wall?(nx: number, nz: number): boolean;
  /** Where node nx, nz is. */
  at(nx: number, nz: number): CellPoint;
  /** How many points along the straight way from a to b are not clear. */
  lineBlocked(a: CellPoint, b: CellPoint): number;
  /** The node it starts from. */
  start: [number, number];
  /** Whether node nx, nz is somewhere it may end. */
  goal(nx: number, nz: number): boolean;
  /** Roughly how far node nx, nz is from the nearest place it may end, never more. */
  guess(nx: number, nz: number): number;
}

/** How much more a step onto a node it may not stand at costs than one across clear ground. */
const BLOCKED_COST = 40;

/** The eight steps across the cells, orthogonal first. */
const STEPS: [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1],
];

/**
 * The shortest way across the nodes from `start` to the nearest goal,
 * never across the corner of a node it may not stand at, through nodes it
 * may not stand at only where there is no other way (at a cost); the
 * nodes it goes by, start and end included, or null if no goal is in
 * bounds.
 */
export function cellPath(s: CellSearch): [number, number][] | null {
  const [x0, z0, x1, z1] = s.bounds;
  const nx = x1 - x0 + 1;
  const nz = z1 - z0 + 1;
  if (nx <= 0 || nz <= 0) return null;
  const count = nx * nz;
  const index = (x: number, z: number) =>
    Math.min(nx - 1, Math.max(0, x - x0)) + Math.min(nz - 1, Math.max(0, z - z0)) * nx;
  const start = index(s.start[0], s.start[1]);
  const g = new Float64Array(count).fill(Infinity);
  const came = new Int32Array(count).fill(-1);
  const state = new Uint8Array(count);
  const clear = new Int8Array(count);
  const isClear = (n: number) => {
    if (clear[n] === 0) clear[n] = s.free((n % nx) + x0, Math.floor(n / nx) + z0) ? 1 : -1;
    return clear[n] === 1;
  };
  const heap = new Heap();
  g[start] = 0;
  heap.push(start, s.guess((start % nx) + x0, Math.floor(start / nx) + z0));
  let end = -1;
  while (heap.size > 0) {
    const cur = heap.pop();
    if (state[cur] === 2) continue;
    state[cur] = 2;
    const cx = cur % nx;
    const cz = Math.floor(cur / nx);
    if (s.goal(cx + x0, cz + z0)) {
      end = cur;
      break;
    }
    for (let k = 0; k < 8; k++) {
      const [dx, dz] = STEPS[k];
      const x = cx + dx;
      const z = cz + dz;
      if (x < 0 || x >= nx || z < 0 || z >= nz) continue;
      const n = x + z * nx;
      if (state[n] === 2) continue;
      if (s.wall?.(x + x0, z + z0)) {
        state[n] = 2;
        continue;
      }
      // Never across the corner of a node it may not stand at, but getting out from among them.
      if (k >= 4 && isClear(cur) && (!isClear(x + cz * nx) || !isClear(cx + z * nx))) continue;
      const step = (k >= 4 ? Math.SQRT2 : 1) * CELL * (isClear(n) ? 1 : BLOCKED_COST);
      const cost = g[cur] + step;
      if (cost >= g[n]) continue;
      g[n] = cost;
      came[n] = cur;
      heap.push(n, cost + s.guess(x + x0, z + z0));
    }
  }
  if (end < 0) return null;
  const nodes: [number, number][] = [];
  for (let n = end; n >= 0; n = n === start ? -1 : came[n]) {
    nodes.push([(n % nx) + x0, Math.floor(n / nx) + z0]);
  }
  return nodes.reverse();
}

/**
 * The corners of a way through `points`, from the first to the last,
 * pulled straight between them wherever that is clear (or, starting
 * among what is in the way, through less of it): the first and last
 * left out.
 */
export function pullStraight(
  points: CellPoint[],
  lineBlocked: (a: CellPoint, b: CellPoint) => number,
): CellPoint[] {
  const way: CellPoint[] = [points[0]];
  for (let i = 0; i < points.length - 1;) {
    let j = points.length - 1;
    while (j > i + 1) {
      const straight = lineBlocked(points[i], points[j]);
      if (straight === 0) break;
      let steps = 0;
      for (let k = i; k < j; k++) steps += lineBlocked(points[k], points[k + 1]);
      if (straight < steps) break;
      j--;
    }
    way.push(points[j]);
    i = j;
  }
  return way.slice(1, -1);
}

/** A binary heap of nodes, least first. */
class Heap {
  private nodes: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.nodes.length;
  }
  push(n: number, key: number): void {
    const { nodes, keys } = this;
    let i = nodes.length;
    nodes.push(n);
    keys.push(key);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (keys[up] <= key) break;
      nodes[i] = nodes[up];
      keys[i] = keys[up];
      i = up;
    }
    nodes[i] = n;
    keys[i] = key;
  }
  pop(): number {
    const { nodes, keys } = this;
    const top = nodes[0];
    const n = nodes.pop()!;
    const key = keys.pop()!;
    if (nodes.length > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= nodes.length) break;
        if (c + 1 < nodes.length && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        nodes[i] = nodes[c];
        keys[i] = keys[c];
        i = c;
      }
      nodes[i] = n;
      keys[i] = key;
    }
    return top;
  }
}

/** Which way a tile's model is turned to face `orient` (see turn in render/structures/tiles.ts), about y. */
function turnOf(orient: number): number {
  const [dx, dy] = FACING[orient & 3];
  return Math.atan2(dx, dy);
}

/**
 * Which cell of a tile is cell lx, lz of its model as it is drawn, facing
 * +z, once turned to face `orient`: as a truck bay's crates and the half
 * its truck stands in are laid out.
 */
export function turnedCell(orient: number, lx: number, lz: number): [number, number] {
  const a = turnOf(orient);
  const u = (lx + 0.5) * CELL - 0.5;
  const v = (lz + 0.5) * CELL - 0.5;
  const x = u * Math.cos(a) + v * Math.sin(a);
  const z = -u * Math.sin(a) + v * Math.cos(a);
  const at = (q: number) => Math.min(SUB - 1, Math.max(0, Math.floor((q + 0.5) * SUB)));
  return [at(x), at(z)];
}

/** Where x, z within a tile (0 to 1 each way) is on its model as it is drawn, facing +z, before it is turned to face `orient`. */
export function unturned(orient: number, x: number, z: number): [number, number] {
  const a = turnOf(orient);
  const [u, v] = [x - 0.5, z - 0.5];
  return [0.5 + u * Math.cos(a) - v * Math.sin(a), 0.5 + u * Math.sin(a) + v * Math.cos(a)];
}

/**
 * A truck bay's cells kept from the staff, as bits (cell cx, cz the bit
 * cz * SUB + cx): with a truck standing in it, the whole half of the bay
 * it stands in (`truck` the local x across the bay of its middle, as
 * drawn); with crates on its stack, the cells they are in, the front row
 * (`front`) and the row behind it (`back`), in the bay's front corner.
 */
export function bayCells(
  orient: number,
  truck: number | null,
  front: boolean,
  back: boolean,
): number {
  let bits = 0;
  const put = (lx: number, lz: number) => {
    const [cx, cz] = turnedCell(orient, lx, lz);
    bits |= 1 << (cz * SUB + cx);
  };
  if (truck !== null) {
    const xs = truck < 0.5 ? [0, 1] : [2, 3];
    for (const lx of xs) for (let lz = 0; lz < SUB; lz++) put(lx, lz);
  }
  // The stack two by two at x 0.71 and 0.89, the front row at z 0.89, the one behind at 0.71.
  if (front || back) for (const lx of [2, 3]) put(lx, 3);
  if (back) for (const lx of [2, 3]) put(lx, 2);
  return bits;
}
