/** Cost of entering a tile. Infinity means blocked. */
export type CostFn = (i: number) => number;

const DIRS4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
const DIRS8 = [...DIRS4, [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

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

  const n = w * h;
  const g = new Float32Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  const gx = goal % w;
  const gy = Math.floor(goal / w);
  const heuristic = (i: number) => {
    const dx = Math.abs((i % w) - gx);
    const dy = Math.abs(Math.floor(i / w) - gy);
    return diagonal ? Math.max(dx, dy) + 0.4142 * Math.min(dx, dy) : dx + dy;
  };

  g[start] = 0;
  heap.push(start, heuristic(start));
  const dirs = diagonal ? DIRS8 : DIRS4;

  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (closed[ni]) continue;
      const c = cost(ni);
      if (!Number.isFinite(c)) continue;
      let step = c;
      if (dx !== 0 && dy !== 0) {
        // No cutting corners past blocked tiles.
        if (!Number.isFinite(cost(cy * w + nx)) || !Number.isFinite(cost(ny * w + cx))) continue;
        step *= Math.SQRT2;
      }
      const ng = g[cur] + step;
      if (ng < g[ni]) {
        g[ni] = ng;
        came[ni] = cur;
        heap.push(ni, ng + heuristic(ni));
      }
    }
  }

  if (came[goal] === -1) return null;
  const path: number[] = [];
  for (let i = goal; i !== start; i = came[i]) path.push(i);
  return path.reverse();
}

class MinHeap {
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
