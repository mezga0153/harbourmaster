import type { GameMap } from '../../sim/map';
import { FACING } from '../../sim/rules';
import { Build, isDock, isPublicRoad, isTownBuilding } from '../../sim/types';

// What the tile builders ask of the map round a tile.

export function offset(m: GameMap, i: number, dx: number, dy: number): number {
  const x = m.xOf(i) + dx;
  const y = m.yOf(i) + dy;
  return m.inBounds(x, y) ? m.idx(x, y) : -1;
}

export function is(m: GameMap, i: number, dx: number, dy: number, ...codes: number[]): boolean {
  const x = m.xOf(i) + dx;
  const y = m.yOf(i) + dy;
  if (!m.inBounds(x, y)) return false;
  return codes.includes(m.build[m.idx(x, y)]);
}

export function landAt(m: GameMap, i: number, dx: number, dy: number): boolean {
  const x = m.xOf(i) + dx;
  const y = m.yOf(i) + dy;
  return m.inBounds(x, y) && m.isLand(m.idx(x, y));
}

/** Whether the side of `i` towards dx, dy faces water a boat could lie in. */
export function openWater(m: GameMap, i: number, dx: number, dy: number): boolean {
  const n = offset(m, i, dx, dy);
  return n >= 0 && !m.isLand(n) && !isDock(m.build[n]);
}

/** Whether a path on tile `i` should run out to the neighbour at dx, dy. */
export function leadsTo(m: GameMap, i: number, dx: number, dy: number): boolean {
  const x = m.xOf(i) + dx;
  const y = m.yOf(i) + dy;
  if (!m.inBounds(x, y)) return i === m.entry;
  return m.build[m.idx(x, y)] !== Build.None;
}

/** Whether the street on `i` carries on to dx, dy: another road, or off the map edge. */
export function streetAt(m: GameMap, i: number, dx: number, dy: number): boolean {
  const x = m.xOf(i) + dx;
  const y = m.yOf(i) + dy;
  if (!m.inBounds(x, y)) return dx < 0;
  return isPublicRoad(m.build[m.idx(x, y)]);
}

/** Whether the town has built anything next to `i`; out in the country its road has no pavements. */
export function builtUp(m: GameMap, i: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const n = offset(m, i, dx, dy);
      if (n >= 0 && isTownBuilding(m.build[n])) return true;
    }
  }
  return false;
}

/**
 * Whether the building on tile `i` joins another of its kind beside it,
 * facing the same way, on its left (-x) and right (+x) as it is drawn,
 * facing +z before it is turned (see turn).
 */
export function joins(m: GameMap, i: number): { left: boolean; right: boolean } {
  const f = m.orient[i] & 3;
  const [dx, dy] = FACING[f];
  // Its +x in the world, once turned to face (dx, dy).
  const [rx, ry] = [dy, -dx];
  const same = (sx: number, sy: number) => {
    const x = m.xOf(i) + sx;
    const y = m.yOf(i) + sy;
    if (!m.inBounds(x, y)) return false;
    const n = m.idx(x, y);
    return m.build[n] === m.build[i] && (m.orient[n] & 3) === f;
  };
  return { left: same(-rx, -ry), right: same(rx, ry) };
}

/** Which half of a crane tile faces land, for its landing stack. */
export function landwardOffset(m: GameMap, i: number): { alongX: boolean; side: number } {
  const water = (dx: number, dy: number) => {
    const x = m.xOf(i) + dx;
    const y = m.yOf(i) + dy;
    return m.inBounds(x, y) && !m.isLand(m.idx(x, y)) && !isDock(m.build[m.idx(x, y)]);
  };
  if (water(0, -1)) return { alongX: true, side: 1 };
  if (water(0, 1)) return { alongX: true, side: -1 };
  if (water(-1, 0)) return { alongX: false, side: 1 };
  return { alongX: false, side: -1 };
}

/** The tiles of the storage area `i` is in: those marked out the same, joined up. */
export function storeArea(m: GameMap, i: number): number[] {
  const code = m.store[i];
  const seen = new Set([i]);
  const queue = [i];
  for (let k = 0; k < queue.length; k++) {
    for (const n of m.neighbors4(queue[k])) {
      if (seen.has(n) || m.store[n] !== code) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return queue;
}
