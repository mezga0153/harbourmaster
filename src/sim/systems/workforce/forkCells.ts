import type { World } from '../../world';
import type { Dockhand } from '../../state';
import { Build } from '../../types';
import {
  bayCells,
  cellPath,
  CELL,
  pullStraight,
  SUB,
  unturned,
  type CellPoint,
} from '../../rules/cells';
import { slotCells, usedSlots } from '../cargo/places';
import { lengthOf } from '../roads/traffic';
import { craneHeld } from '../cranes';

// Forklifts drive across the port a quarter tile at a time: the tiles of
// their way (see pathFor) are the lane they keep to, and within those and
// the tiles beside them they go cell by cell, two by two cells of it under
// them, round the crates on the ground (in storage, on a truck bay's
// stack, piled on the quay or on a jib crane's landing stack) and the half
// of a truck bay a truck stands in, rather than from the middle of one
// tile to the next through them. Where they are going, they stop at the
// nearest clear spot on its tile, short of its crates.

/** How many tiles of its way ahead a forklift plans its cells for at a time. */
const WINDOW = 10;
/** Half how wide a forklift is, checking a straight way is clear: two cells across. */
const HALF = 0.24;
/** Half how wide a truck is, in tiles. */
const TRUCK_HALF_WIDTH = 0.16;
/** How far apart points along a straight way are checked, in tiles. */
const LINE_STEP = 0.06;

/** The cells of each tile with crates or a truck on them kept from forklifts, this tick, as bits. */
interface Kept {
  tick: number;
  bits: Map<number, number>;
}
const keptBy = new WeakMap<World, Kept>();

/** Each forklift's way across the cells, as last planned: for the tiles of its way then, from the tile it was on. */
interface Plan {
  path: number[];
  len: number;
  tile: number;
  goal: number;
  points: CellPoint[];
}
const plans = new WeakMap<Dockhand, Plan>();

/** The corners a forklift is to drive by across the cells, the last where it stops; none if it drives tile by tile. */
export function forkCells(p: Dockhand): CellPoint[] | undefined {
  return plans.get(p)?.points;
}

/**
 * The cells of tile `i` kept from forklifts, as bits (cell cx, cz the bit
 * cz * SUB + cx): the middle two by two of crate storage or a pile on the
 * quay with crates on it, the row of a jib crane's landing stack, a truck
 * bay's stack and the half of it a truck stands in.
 */
export function keptCells(w: World, i: number): number {
  let kept = keptBy.get(w);
  if (!kept || kept.tick !== w.tick) {
    kept = { tick: w.tick, bits: workKept(w) };
    keptBy.set(w, kept);
  }
  return kept.bits.get(i) ?? 0;
}

function workKept(w: World): Map<number, number> {
  const m = w.map;
  const bits = new Map<number, number>();
  const put = (i: number, b: number) => bits.set(i, (bits.get(i) ?? 0) | b);
  // Crates in storage, on a truck bay's stack and piled on the quay, by the slots they are in.
  for (const b of [...w.bays.values(), ...w.piles.values()]) {
    if (b.yard) continue;
    for (const k of usedSlots(w, b)) {
      const { tile, cells } = slotCells(w, b, k);
      put(tile, cells);
    }
  }
  for (const c of w.cranes.values()) {
    if (c.kind !== 'jib' || craneHeld(c) === 0) continue;
    // Along the landward edge of its tile, as the view stacks them.
    const water = (dx: number, dy: number) => {
      const x = m.xOf(c.idx) + dx;
      const y = m.yOf(c.idx) + dy;
      return m.inBounds(x, y) && !m.isLand(m.idx(x, y)) && !isDockAt(w, m.idx(x, y));
    };
    let b = 0;
    const row = (cz: number) => {
      for (let cx = 0; cx < SUB; cx++) b |= 1 << (cz * SUB + cx);
    };
    const col = (cx: number) => {
      for (let cz = 0; cz < SUB; cz++) b |= 1 << (cz * SUB + cx);
    };
    if (water(0, -1)) row(3);
    else if (water(0, 1)) row(0);
    else if (water(-1, 0)) col(3);
    else col(0);
    put(c.idx, b);
  }
  // A cell's width off the walls of a depot, where there is room.
  const depots = new Set<number>();
  for (const q of w.people) if (q.home >= 0 && m.build[q.home] === Build.Depot) depots.add(q.home);
  for (const d of depots) {
    const [x, y] = [m.xOf(d), m.yOf(d)];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx === 0 && dy === 0) || !m.inBounds(x + dx, y + dy)) continue;
        let b = 0;
        for (let cz = 0; cz < SUB; cz++) {
          for (let cx = 0; cx < SUB; cx++) {
            const near =
              (dx === 0 || cx === (dx > 0 ? 0 : SUB - 1)) &&
              (dy === 0 || cz === (dy > 0 ? 0 : SUB - 1));
            if (near) b |= 1 << (cz * SUB + cx);
          }
        }
        put(m.idx(x + dx, y + dy), b);
      }
    }
  }
  for (const t of w.trucks) {
    if (t.path.length > 0) continue;
    const [tx, ty] = [Math.floor(t.x), Math.floor(t.y)];
    if (!m.inBounds(tx, ty)) continue;
    const i = m.idx(tx, ty);
    // A truck standing in its truck bay: the whole half of the bay it stands in.
    if (m.build[i] === Build.TruckBay && !t.pickup) {
      const [lx] = unturned(m.orient[i], t.x - tx, t.y - ty);
      put(i, bayCells(m.orient[i], lx, false, false));
      continue;
    }
    // Anywhere else, the cells its body is over.
    const half = lengthOf(w, t) / 2 + 0.02;
    const side = TRUCK_HALF_WIDTH + 0.02;
    const [c, sn] = [Math.cos(t.dir), Math.sin(t.dir)];
    const reach = (CELL / 2) * (Math.abs(c) + Math.abs(sn));
    const r = Math.ceil((half + CELL) * SUB);
    const [ux, uz] = [Math.floor(t.x * SUB), Math.floor(t.y * SUB)];
    for (let cz = uz - r; cz <= uz + r; cz++) {
      for (let cx = ux - r; cx <= ux + r; cx++) {
        const mx = (cx + 0.5) * CELL - t.x;
        const mz = (cz + 0.5) * CELL - t.y;
        const along = mx * c + mz * sn;
        const across = -mx * sn + mz * c;
        if (Math.abs(along) - reach >= half || Math.abs(across) - reach >= side) continue;
        const [qx, qz] = [Math.floor(cx / SUB), Math.floor(cz / SUB)];
        if (!m.inBounds(qx, qz)) continue;
        put(m.idx(qx, qz), 1 << ((cz - qz * SUB) * SUB + (cx - qx * SUB)));
      }
    }
  }
  return bits;
}

function isDockAt(w: World, i: number): boolean {
  const b = w.map.build[i];
  return b === Build.Jetty || b === Build.Quay;
}

/**
 * The way a forklift drives across the cells from where it is along the
 * tiles of its way, WINDOW of them at a time: the corners it goes by, the
 * last where it stops (on its goal's tile, short of the crates there), or
 * null where it is to drive tile by tile, as into and out of a depot.
 */
export function planCells(w: World, p: Dockhand): CellPoint[] | null {
  const m = w.map;
  if (p.path.length === 0) return null;
  const here = w.tileOf(p);
  const tiles = [here, ...p.path.slice(0, WINDOW)];
  // Into or out of its depot, and on the tile at its door, it drives tile by tile, through the door.
  if (tiles.some((t) => m.build[t] === Build.Depot)) return null;
  if (p.came !== undefined && p.came >= 0 && m.build[p.came] === Build.Depot) return null;
  const end = tiles[tiles.length - 1];
  const last = p.path.length <= WINDOW;
  // The tiles of its way, and those beside them it may drive on, to go round crates.
  const lane = new Set<number>(tiles);
  for (const t of tiles) {
    const [x, y] = [m.xOf(t), m.yOf(t)];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!m.inBounds(x + dx, y + dy)) continue;
        const n = m.idx(x + dx, y + dy);
        if (lane.has(n) || m.build[n] === Build.Depot) continue;
        if (Number.isFinite(w.driveCost(n))) lane.add(n);
      }
    }
  }
  const tileOfCell = (cx: number, cz: number) => {
    const [tx, tz] = [Math.floor(cx / SUB), Math.floor(cz / SUB)];
    return m.inBounds(tx, tz) ? m.idx(tx, tz) : -1;
  };
  // A cell is off the way, or kept from it by crates or a truck.
  const off = (cx: number, cz: number) => !lane.has(tileOfCell(cx, cz));
  const kept = (cx: number, cz: number) => {
    const t = tileOfCell(cx, cz);
    if (t < 0 || !lane.has(t)) return true;
    const bits = keptCells(w, t);
    return (
      bits !== 0 && (bits & (1 << ((cz - m.yOf(t) * SUB) * SUB + (cx - m.xOf(t) * SUB)))) !== 0
    );
  };
  // A node is the corner its two by two cells meet at.
  const cellsOf = (vx: number, vz: number): [number, number][] => [
    [vx - 1, vz - 1],
    [vx, vz - 1],
    [vx - 1, vz],
    [vx, vz],
  ];
  const free = (vx: number, vz: number) => cellsOf(vx, vz).every(([x, z]) => !kept(x, z));
  const walled = (vx: number, vz: number) => cellsOf(vx, vz).some(([x, z]) => off(x, z));
  const at = (vx: number, vz: number): CellPoint => ({ x: vx * CELL, z: vz * CELL });
  const blockedAt = (x: number, z: number) => {
    for (let cz = Math.floor((z - HALF) * SUB); cz <= Math.floor((z + HALF) * SUB); cz++) {
      for (let cx = Math.floor((x - HALF) * SUB); cx <= Math.floor((x + HALF) * SUB); cx++) {
        if (kept(cx, cz)) return true;
      }
    }
    return false;
  };
  const lineBlocked = (a: CellPoint, b: CellPoint) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / LINE_STEP));
    let k = 0;
    for (let s = 0; s <= n; s++) {
      if (blockedAt(a.x + ((b.x - a.x) * s) / n, a.z + ((b.z - a.z) * s) / n)) k++;
    }
    return k;
  };
  // Where it stops: the middle of the tile, where that is clear; else the
  // nearest clear corner on it, its edges too.
  const [gx, gz] = [m.xOf(end) * SUB, m.yOf(end) * SUB];
  const middle = free(gx + 2, gz + 2) && !walled(gx + 2, gz + 2);
  const goal = (vx: number, vz: number) =>
    middle
      ? vx === gx + 2 && vz === gz + 2
      : vx >= gx && vx <= gx + SUB && vz >= gz && vz <= gz + SUB && free(vx, vz) && !walled(vx, vz);
  const cx = (m.xOf(end) + 0.5) * SUB;
  const cz = (m.yOf(end) + 0.5) * SUB;
  const guess = (vx: number, vz: number) =>
    Math.max(0, Math.hypot(vx - cx, vz - cz) * CELL - (middle ? 0 : 0.71));
  let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const t of lane) {
    x0 = Math.min(x0, m.xOf(t) * SUB);
    z0 = Math.min(z0, m.yOf(t) * SUB);
    x1 = Math.max(x1, (m.xOf(t) + 1) * SUB);
    z1 = Math.max(z1, (m.yOf(t) + 1) * SUB);
  }
  const start: [number, number] = [Math.round(p.x * SUB), Math.round(p.y * SUB)];
  const nodes = cellPath({
    bounds: [x0, z0, x1, z1],
    free: (vx, vz) => free(vx, vz),
    wall: walled,
    at,
    lineBlocked,
    start,
    goal,
    guess,
  });
  if (!nodes || nodes.length === 0) return null;
  const [ex, ez] = nodes[nodes.length - 1];
  // Stopped on the edge of its goal's tile, it is just inside it.
  const stop = at(ex, ez);
  const inside = (v: number, lo: number) => Math.min(lo + 1 - 0.02, Math.max(lo + 0.02, v));
  if (last) {
    stop.x = inside(stop.x, m.xOf(end));
    stop.z = inside(stop.z, m.yOf(end));
  }
  const points = [{ x: p.x, z: p.y }, ...nodes.slice(1, -1).map(([x, z]) => at(x, z)), stop];
  return [...pullStraight(points, lineBlocked), stop];
}

/**
 * A forklift driving `speed` tiles this tick along its way across the
 * cells (see planCells), waiting short of a tile it may not `enter`: as
 * World.move does tile by tile, which it falls back on (null) where it
 * drives tile by tile.
 */
export function moveCells(
  w: World,
  p: Dockhand,
  speed: number,
  enter?: (i: number) => boolean,
): 'moving' | 'arrived' | 'waiting' | null {
  const m = w.map;
  let plan = plans.get(p);
  const here = w.tileOf(p);
  if (
    !plan ||
    plan.path !== p.path ||
    plan.len !== p.path.length ||
    plan.tile !== here ||
    plan.goal !== p.goal
  ) {
    const points = p.path.length > 0 ? planCells(w, p) : null;
    if (!points) {
      plans.delete(p);
      return null;
    }
    plan = { path: p.path, len: p.path.length, tile: here, goal: p.goal, points };
    plans.set(p, plan);
  }
  let budget = speed;
  while (budget > 1e-6 && plan.points.length > 0) {
    const to = plan.points[0];
    const dx = to.x - p.x;
    const dz = to.z - p.y;
    const d = Math.hypot(dx, dz);
    if (d > 1e-6) p.dir = Math.atan2(dz, dx);
    // A cell at most at a time, so it holds back at the edge of a tile it may not enter.
    const step = Math.min(budget, d, CELL);
    const nx = d > 1e-6 ? p.x + (dx / d) * step : to.x;
    const nz = d > 1e-6 ? p.y + (dz / d) * step : to.z;
    const now = w.tileOf(p);
    const next = m.idx(Math.floor(nx), Math.floor(nz));
    if (next !== now && enter && !enter(next)) {
      p.v = 0;
      return 'waiting';
    }
    p.x = nx;
    p.y = nz;
    budget -= step;
    if (step >= d - 1e-9) plan.points.shift();
    // Through a tile of its way: those up to it are behind it, but for where it is going.
    const k = p.path.indexOf(w.tileOf(p));
    if (k >= 0) p.path.splice(0, k === p.path.length - 1 ? k : k + 1);
  }
  plan.len = p.path.length;
  plan.tile = w.tileOf(p);
  if (plan.points.length === 0) {
    if (w.tileOf(p) === p.goal && p.path[p.path.length - 1] === p.goal && p.path.length <= 1) {
      p.path = [];
      p.v = 0;
      plans.delete(p);
      return 'arrived';
    }
    // The end of what it planned, short of where it is going: on from here next tick.
    plans.delete(p);
  }
  return 'moving';
}
