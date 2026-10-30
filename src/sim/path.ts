/**
 * Cost of entering tile `i`, from the neighbouring tile `from` when that is
 * known. Infinity means blocked.
 */
export type CostFn = (i: number, from?: number) => number;

const DIRS4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
const DIRS8 = [...DIRS4, [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

/**
 * Working arrays for a search, kept from one to the next rather than made
 * afresh: on a big map each search would otherwise allocate megabytes. An
 * entry counts only when its stamp is the current search's, so nothing
 * needs clearing between searches.
 */
class Scratch {
  g = new Float32Array(0);
  came = new Int32Array(0);
  seen = new Uint32Array(0);
  done = new Uint32Array(0);
  gen = 0;

  begin(n: number): number {
    if (this.g.length < n) {
      this.g = new Float32Array(n);
      this.came = new Int32Array(n);
      this.seen = new Uint32Array(n);
      this.done = new Uint32Array(n);
      this.gen = 0;
    }
    if (++this.gen === 0xffffffff) {
      this.seen.fill(0);
      this.done.fill(0);
      this.gen = 1;
    }
    return this.gen;
  }

  cost(i: number): number {
    return this.seen[i] === this.gen ? this.g[i] : Infinity;
  }

  set(i: number, g: number, from: number): void {
    this.g[i] = g;
    this.came[i] = from;
    this.seen[i] = this.gen;
  }

  closed(i: number): boolean {
    return this.done[i] === this.gen;
  }

  close(i: number): void {
    this.done[i] = this.gen;
  }
}

const walkScratch = new Scratch();
const driveScratch = new Scratch();

/**
 * A* on the tile grid. Returns the tiles to walk through, excluding `start`
 * and including `goal`, or null when there is no route. Costs must be >= 1.
 */
export function findPath(
  w: number,
  h: number,
  start: number,
  goal: number,
  cost: CostFn,
  diagonal: boolean,
): number[] | null {
  if (start === goal) return [];
  if (!Number.isFinite(cost(goal))) return null;

  const sc = walkScratch;
  sc.begin(w * h);
  const heap = new MinHeap();
  const gx = goal % w;
  const gy = Math.floor(goal / w);
  const heuristic = (i: number) => {
    const dx = Math.abs((i % w) - gx);
    const dy = Math.abs(Math.floor(i / w) - gy);
    return diagonal ? Math.max(dx, dy) + 0.4142 * Math.min(dx, dy) : dx + dy;
  };

  sc.set(start, 0, -1);
  heap.push(start, heuristic(start));
  const dirs = diagonal ? DIRS8 : DIRS4;

  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === goal) break;
    if (sc.closed(cur)) continue;
    sc.close(cur);
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (sc.closed(ni)) continue;
      const c = cost(ni, cur);
      if (!Number.isFinite(c)) continue;
      let step = c;
      if (dx !== 0 && dy !== 0) {
        // No cutting corners past blocked tiles.
        if (!Number.isFinite(cost(cy * w + nx)) || !Number.isFinite(cost(ny * w + cx))) continue;
        step *= Math.SQRT2;
      }
      const ng = sc.cost(cur) + step;
      if (ng < sc.cost(ni)) {
        sc.set(ni, ng, cur);
        heap.push(ni, ng + heuristic(ni));
      }
    }
  }

  if (!Number.isFinite(sc.cost(goal))) return null;
  const path: number[] = [];
  for (let i = goal; i !== start; i = sc.came[i]) path.push(i);
  return path.reverse();
}

/**
 * A* for a vehicle that cannot turn about on the spot: no going straight
 * back the way it came, except on a tile where `canTurn` says there is room
 * to come round. It sets off from `start` having come from `cameFrom`
 * (-1: either way). Orthogonal moves only; like findPath otherwise.
 */
export function findDrivePath(
  w: number,
  h: number,
  start: number,
  cameFrom: number,
  goal: number,
  cost: CostFn,
  canTurn: (i: number) => boolean,
): number[] | null {
  if (start === goal) return [];
  if (!Number.isFinite(cost(goal))) return null;
  // State: tile × the direction it was entered by (4 = none, at the start).
  const sc = driveScratch;
  sc.begin(w * h * 5);
  const heap = new MinHeap();
  const gx = goal % w;
  const gy = Math.floor(goal / w);
  const heuristic = (i: number) => Math.abs((i % w) - gx) + Math.abs(Math.floor(i / w) - gy);
  const dirOf = (a: number, b: number) => {
    const d = b - a;
    return d === 1 ? 0 : d === -1 ? 1 : d === w ? 2 : 3;
  };
  const startDir = cameFrom >= 0 ? dirOf(cameFrom, start) : 4;
  const s0 = start * 5 + startDir;
  sc.set(s0, 0, -1);
  heap.push(s0, heuristic(start));
  let end = -1;
  while (heap.size > 0) {
    const cur = heap.pop();
    if (sc.closed(cur)) continue;
    sc.close(cur);
    const tile = Math.floor(cur / 5);
    if (tile === goal) {
      end = cur;
      break;
    }
    const din = cur % 5;
    const cx = tile % w;
    const cy = Math.floor(tile / w);
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      const dout = dirOf(tile, ni);
      // Straight back the way it came, only where it has room to turn.
      if (din < 4 && (din ^ 1) === dout && !canTurn(tile)) continue;
      const c = cost(ni, tile);
      if (!Number.isFinite(c)) continue;
      const ns = ni * 5 + dout;
      if (sc.closed(ns)) continue;
      const ng = sc.cost(cur) + c;
      if (ng < sc.cost(ns)) {
        sc.set(ns, ng, cur);
        heap.push(ns, ng + heuristic(ni));
      }
    }
  }
  if (end < 0) return null;
  const path: number[] = [];
  for (let s = end; s !== s0; s = sc.came[s]) path.push(Math.floor(s / 5));
  return path.reverse();
}

export class MinHeap {
  private items: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    const { items, keys } = this;
    let i = items.length;
    items.push(item);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      items[i] = items[p];
      keys[i] = keys[p];
      i = p;
    }
    items[i] = item;
    keys[i] = key;
  }

  pop(): number {
    const { items, keys } = this;
    const top = items[0];
    const lastItem = items.pop()!;
    const lastKey = keys.pop()!;
    const n = items.length;
    if (n > 0) {
      let i = 0;
      while (true) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastKey) break;
        items[i] = items[c];
        keys[i] = keys[c];
        i = c;
      }
      items[i] = lastItem;
      keys[i] = lastKey;
    }
    return top;
  }
}
