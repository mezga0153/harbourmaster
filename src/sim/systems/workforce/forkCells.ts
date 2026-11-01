import type { World } from '../../world';
import type { Dockhand, Stand } from '../../state';
import type { StandAt, StandPlan } from './stands';
import { Build } from '../../types';
import {
  bayCells,
  cellPath,
  CELL,
  pullStraight,
  SUB,
  turnedPoint,
  type CellPoint,
} from '../../rules/cells';
import { slotCells, usedSlots } from '../cargo/places';
import { lanePos, lengthOf } from '../roads/traffic';
import { craneHeld } from '../cranes';
import { drivable } from '../../rules';

// Dockhands and forklifts go across the port a quarter tile at a time: the
// tiles of their way (see pathFor) are the lane they keep to, and within
// those and the tiles beside them they go cell by cell, a dockhand one cell
// of it under it, a forklift two by two, round the crates on the ground (in
// storage, on a truck bay's stack, piled on the quay or on a jib crane's
// landing stack) and the trucks standing still, rather than from the middle
// of one tile to the next through them. Going to take a crate or set one
// down, they stop at the nearest free place they may work it from, facing
// it (see stands.ts); anywhere else, at the nearest clear spot on the tile
// they are going to.

/** How many tiles of its way ahead it plans its cells for at a time. */
const WINDOW = 10;
/** Half how wide a forklift is, and a dockhand, checking a straight way is clear: two cells across, and one. */
const HALF = { 2: 0.24, 1: 0.1 };
/** Half how wide a truck is, in tiles. */
const TRUCK_HALF_WIDTH = 0.16;
/** How far ahead of a standing truck's cab nobody goes. */
const CAB_CLEAR = 0.3;
/** Where a truck bay's sign post stands on its model, as drawn (see baySign), and how far a forklift keeps from it. */
const POST = [0.015, 0.9];
const POST_CLEAR = 0.5;
/** Ticks a worker waits with no room beside the crates to work them from before it works them from where it is. */
const TURN_PATIENCE = 30;
/** How far back from where it stands a forklift lines up on the load, to drive the last of it straight. */
const LINE_UP = 0.35;
/** How far apart points along a straight way are checked, in tiles. */
const LINE_STEP = 0.06;

/** The cells of each tile with crates or a truck on them kept from forklifts, this tick, as bits. */
interface Kept {
  tick: number;
  bits: Map<number, number>;
  /** Those kept just ahead of a truck's cab, from dockhands only. */
  cabs: Map<number, number>;
}
const keptBy = new WeakMap<World, Kept>();

/** Each forklift's way across the cells, as last planned: for the tiles of its way then, from the tile it was on. */
interface Plan {
  path: number[];
  len: number;
  tile: number;
  goal: number;
  points: CellPoint[];
  /** Where it ends, where that is the place it works a crate from. */
  stand?: Stand;
  /** Made while another was at work at the stack it goes to: it looks again before it gets there. */
  waits?: boolean;
  /** The stack the crate is in it goes to work, as it was when made. */
  lock?: string; /** The trucks standing close by when it was made: one pulling up or off, it looks again. */
  trucks: string;
}
const plans = new WeakMap<Dockhand, Plan>();

/**
 * How far a worker going to the place it works a crate from has still to
 * go along its way across the cells; Infinity where it is going on.
 */
export function toStand(p: Dockhand): number {
  const plan = plans.get(p);
  if (!plan?.stand) return Infinity;
  let [x, z] = [p.x, p.y];
  let d = 0;
  for (const q of plan.points) {
    d += Math.hypot(q.x - x, q.z - z);
    [x, z] = [q.x, q.z];
  }
  return d;
}

/** The corners a forklift is to drive by across the cells, the last where it stops; none if it drives tile by tile. */
export function forkCells(p: Dockhand): CellPoint[] | undefined {
  return plans.get(p)?.points;
}

/**
 * The cells of tile `i` kept from forklifts, as bits (cell cx, cz the bit
 * cz * SUB + cx): the middle two by two of crate storage or a pile on the
 * quay with crates on it, the row of a jib crane's landing stack, a truck
 * bay's stack and the half of it a truck stands in; for a dockhand
 * (`size` 1) those just ahead of a truck's cab too, which a forklift
 * (`size` 2) may drive across to load it.
 */
export function keptCells(w: World, i: number, size = 1): number {
  let kept = keptBy.get(w);
  if (!kept || kept.tick !== w.tick) {
    kept = { tick: w.tick, ...workKept(w) };
    keptBy.set(w, kept);
  }
  const bits = kept.bits.get(i) ?? 0;
  return size === 2 ? bits : bits | (kept.cabs.get(i) ?? 0);
}

function workKept(w: World): { bits: Map<number, number>; cabs: Map<number, number> } {
  const m = w.map;
  const bits = new Map<number, number>();
  const cabs = new Map<number, number>();
  const put = (i: number, b: number, to = bits) => to.set(i, (to.get(i) ?? 0) | b);
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
    // One on its way into a truck bay close by: the half of it it backs into.
    const g = t.path.length > 0 ? t.goal : -1;
    if (g >= 0 && m.build[g] === Build.TruckBay && !t.pickup && t.bayIdx === g) {
      if (Math.hypot(m.xOf(g) + 0.5 - t.x, m.yOf(g) + 0.5 - t.y) < 2) {
        put(g, bayCells(m.orient[g], 0.25, false, false));
      }
    }
    if (t.path.length > 0) continue;
    const [tx, ty] = [Math.floor(t.x), Math.floor(t.y)];
    if (!m.inBounds(tx, ty)) continue;
    const i = m.idx(tx, ty);
    // A truck standing in its truck bay: the whole half of the bay away
    // from its stack, where the view has it stand, and its body where it
    // reaches out of it.
    if (m.build[i] === Build.TruckBay && !t.pickup)
      put(i, bayCells(m.orient[i], 0.25, false, false));
    // The cells its body is over, and those just ahead of its cab, where
    // nobody walks across in front of it.
    const half = lengthOf(w, t) / 2 + 0.05;
    const side = TRUCK_HALF_WIDTH + 0.04;
    const [c, sn] = [Math.cos(t.dir), Math.sin(t.dir)];
    const reach = (CELL / 2) * (Math.abs(c) + Math.abs(sn));
    const r = Math.ceil((half + CAB_CLEAR + CELL) * SUB);
    // Where it is drawn, to the side of its lane.
    const [px, py] = lanePos(w, t);
    const [ux, uz] = [Math.floor(px * SUB), Math.floor(py * SUB)];
    for (let cz = uz - r; cz <= uz + r; cz++) {
      for (let cx = ux - r; cx <= ux + r; cx++) {
        const mx = (cx + 0.5) * CELL - px;
        const mz = (cz + 0.5) * CELL - py;
        const along = mx * c + mz * sn;
        const across = -mx * sn + mz * c;
        const ahead = along > 0 ? CAB_CLEAR : 0;
        if (along - reach >= half + ahead || -along - reach >= half) continue;
        // Across, only cells mostly over it: between two standing side by
        // side, the room there is between them stays.
        if (Math.abs(across) >= side) continue;
        const [qx, qz] = [Math.floor(cx / SUB), Math.floor(cz / SUB)];
        if (!m.inBounds(qx, qz)) continue;
        const cab = along - reach >= half;
        put(m.idx(qx, qz), 1 << ((cz - qz * SUB) * SUB + (cx - qx * SUB)), cab ? cabs : bits);
      }
    }
  }
  return { bits, cabs };
}

/** Whether the cell at x, y is kept from the staff, by crates or a truck. */
export function keptAt(w: World, x: number, y: number): boolean {
  const m = w.map;
  const [tx, ty] = [Math.floor(x), Math.floor(y)];
  if (!m.inBounds(tx, ty)) return false;
  const [cx, cz] = [Math.floor((x - tx) * SUB), Math.floor((y - ty) * SUB)];
  return (keptCells(w, m.idx(tx, ty)) & (1 << (cz * SUB + cx))) !== 0;
}

function isDockAt(w: World, i: number): boolean {
  const b = w.map.build[i];
  return b === Build.Jetty || b === Build.Quay;
}

/** How many cells across a worker takes up: a forklift two by two, a dockhand one. */
export function sizeOf(p: Dockhand): 1 | 2 {
  return p.kind === 'forklift' ? 2 : 1;
}

/**
 * The way a dockhand walks or a forklift drives across the cells from
 * where it is along the tiles of its way, WINDOW of them at a time: the
 * corners it goes by, the last where it stops, and with that its end
 * its way there is a place in `stands` (see stands.ts), the nearest free
 * one of those it can get to; else on its goal's tile, short of the
 * crates there. Null where it is to go tile by tile, as into and out of a
 * depot.
 */
export function planCells(
  w: World,
  p: Dockhand,
  stands: StandAt[] = [],
  wide = 1,
  short = false,
): { points: CellPoint[]; stand?: Stand } | null {
  const m = w.map;
  const size = sizeOf(p);
  if (p.path.length === 0 && stands.length === 0) return null;
  // The places it likes best, if it can get to one; else any.
  const best = stands.filter((q) => !q.rank);
  if (best.length > 0 && best.length < stands.length) {
    const made = planCells(w, p, best, wide);
    if (made?.stand) return made;
  }
  const here = w.tileOf(p);
  const tiles = [here, ...p.path.slice(0, short ? Math.min(WINDOW, p.path.length - 1) : WINDOW)];
  // Into or out of its depot, and on the tile at its door, it drives tile by tile, through the door.
  if (tiles.some((t) => m.build[t] === Build.Depot)) return null;
  if (p.came !== undefined && p.came >= 0 && m.build[p.came] === Build.Depot) return null;
  const end = tiles[tiles.length - 1];
  const last = !short && p.path.length <= WINDOW;
  // Nowhere free to work a crate in storage from: up to the tile before
  // it, to wait there for room rather than drive in among the crates; from
  // there, in.
  const stored = w.bays.get(w.storeOf[p.goal])?.tiles !== undefined;
  const toTile = () =>
    stands.length > 0 && stored && p.path.length > 1
      ? planCells(w, p, [], 1, true)
      : planCells(w, p);
  // The tiles of its way, and those beside them it may go on, to go round crates.
  const cost = size === 2 ? w.driveCost : w.walkCost;
  const lane = new Set<number>(tiles);
  for (const t of tiles) {
    const [x, y] = [m.xOf(t), m.yOf(t)];
    for (let dy = -wide; dy <= wide; dy++) {
      for (let dx = -wide; dx <= wide; dx++) {
        if (!m.inBounds(x + dx, y + dy)) continue;
        const n = m.idx(x + dx, y + dy);
        if (lane.has(n) || m.build[n] === Build.Depot) continue;
        if (Number.isFinite(cost(n))) lane.add(n);
      }
    }
  }
  // And round where it stands to work a crate, as on the road on the far
  // side of a truck.
  const near = new Set<number>();
  for (const s of stands) {
    const [tx, tz] = [Math.floor(s.x), Math.floor(s.y)];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (m.inBounds(tx + dx, tz + dz)) near.add(m.idx(tx + dx, tz + dz));
      }
    }
  }
  // Onto the road too, beside a pickup they load at the roadside.
  for (const t of near) {
    const b = m.build[t];
    if (b !== Build.Depot && (Number.isFinite(cost(t)) || drivable(b) || b === Build.Road)) {
      lane.add(t);
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
    const bits = keptCells(w, t, size);
    return (
      bits !== 0 && (bits & (1 << ((cz - m.yOf(t) * SUB) * SUB + (cx - m.xOf(t) * SUB)))) !== 0
    );
  };
  // A forklift's node is the corner its two by two cells meet at; a dockhand's, its cell.
  const cellsOf = (vx: number, vz: number): [number, number][] =>
    size === 2
      ? [
          [vx - 1, vz - 1],
          [vx, vz - 1],
          [vx - 1, vz],
          [vx, vz],
        ]
      : [[vx, vz]];
  // A forklift keeps its forks clear of a truck bay's sign post as it turns.
  const posts: CellPoint[] = [];
  if (size === 2) {
    for (const t of lane) {
      if (m.build[t] !== Build.TruckBay) continue;
      const [px, pz] = turnedPoint(m.orient[t], POST[0], POST[1]);
      posts.push({ x: m.xOf(t) + px, z: m.yOf(t) + pz });
    }
  }
  const nearPost = (vx: number, vz: number) =>
    posts.some((q) => Math.hypot(vx * CELL - q.x, vz * CELL - q.z) < POST_CLEAR);
  const free = (vx: number, vz: number) =>
    cellsOf(vx, vz).every(([x, z]) => !kept(x, z)) && !(size === 2 && nearPost(vx, vz));
  const walled = (vx: number, vz: number) => cellsOf(vx, vz).some(([x, z]) => off(x, z));
  const mid = size === 2 ? 0 : 0.5;
  const at = (vx: number, vz: number): CellPoint => ({
    x: (vx + mid) * CELL,
    z: (vz + mid) * CELL,
  });
  const half = HALF[size];
  const blockedAt = (x: number, z: number) => {
    for (let cz = Math.floor((z - half) * SUB); cz <= Math.floor((z + half) * SUB); cz++) {
      for (let cx = Math.floor((x - half) * SUB); cx <= Math.floor((x + half) * SUB); cx++) {
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
  // Going to work a crate: to the nearest free place to work it from, none
  // another has taken.
  const taken = takenStands(w, p);
  const places = new Map<number, StandAt>();
  if (last) {
    for (const s of stands) {
      const [vx, vz] = s.node;
      const key = vx * 65536 + vz;
      if (taken.has(key) || !free(vx, vz) || walled(vx, vz)) continue;
      const old = places.get(key);
      if (!old || s.reach < old.reach) places.set(key, s);
    }
    if (stands.length > 0 && places.size === 0) return toTile();
  }
  // Else where it stops: the middle of the tile, where that is clear; else
  // the nearest clear corner on it, its edges too.
  const [gx, gz] = [m.xOf(end) * SUB, m.yOf(end) * SUB];
  const c0 = size === 2 ? 2 : 1;
  // A dockhand stops a step from where another stands about, and nobody
  // stops where crates are stacked in storage, crates there or not.
  const stack = (cx: number, cz: number) => {
    const t = tileOfCell(cx, cz);
    if (t < 0 || !w.bays.has(w.storeOf[t])) return false;
    const [lx, lz] = [cx - m.xOf(t) * SUB, cz - m.yOf(t) * SUB];
    return lx >= 1 && lx <= 2 && lz >= 1 && lz <= 2;
  };
  const room = (vx: number, vz: number) =>
    !cellsOf(vx, vz).some(([x, z]) => stack(x, z)) && (size === 2 || !taken.has(vx * 65536 + vz));
  const middle = room(gx + c0, gz + c0) && free(gx + c0, gz + c0) && !walled(gx + c0, gz + c0);
  const onTile = (vx: number, vz: number) =>
    middle
      ? vx === gx + c0 && vz === gz + c0
      : vx >= gx &&
        vx <= gx + SUB &&
        vz >= gz &&
        vz <= gz + SUB &&
        free(vx, vz) &&
        !walled(vx, vz) &&
        room(vx, vz);
  const goal = places.size > 0 ? (vx: number, vz: number) => places.has(vx * 65536 + vz) : onTile;
  const cx = (m.xOf(end) + 0.5) * SUB;
  const cz = (m.yOf(end) + 0.5) * SUB;
  const ends = [...places.values()];
  const guess =
    places.size > 0
      ? (vx: number, vz: number) =>
          Math.min(...ends.map((s) => Math.hypot(vx - s.node[0], vz - s.node[1]) * CELL))
      : (vx: number, vz: number) =>
          Math.max(0, Math.hypot(vx - cx, vz - cz) * CELL - (middle ? 0 : 0.71));
  let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const t of lane) {
    x0 = Math.min(x0, m.xOf(t) * SUB);
    z0 = Math.min(z0, m.yOf(t) * SUB);
    x1 = Math.max(x1, (m.xOf(t) + 1) * SUB);
    z1 = Math.max(z1, (m.yOf(t) + 1) * SUB);
  }
  const start: [number, number] =
    size === 2
      ? [Math.round(p.x * SUB), Math.round(p.y * SUB)]
      : [Math.floor(p.x * SUB), Math.floor(p.y * SUB)];
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
  if (!nodes || nodes.length === 0) {
    // No way to a place to work the crate from: to its tile, as anywhere else.
    if (places.size > 0 && wide === 1) return planCells(w, p, stands, 2);
    return places.size > 0 ? toTile() : null;
  }
  const [ex, ez] = nodes[nodes.length - 1];
  const stand = places.get(ex * 65536 + ez);
  // No way round to its place but across crates or a truck: it works the
  // crate from where it gets to instead, as anywhere else.
  if (stand) {
    let k = 0;
    while (k < nodes.length && !free(...nodes[k])) k++;
    if (nodes.slice(k).some(([x, z]) => !free(x, z))) {
      // Round further off, if that finds a way; else from where it gets to.
      return wide === 1 ? planCells(w, p, stands, 2) : toTile();
    }
  }
  // Stopped on the edge of its goal's tile, it is just inside it.
  const stop = stand ? { x: stand.x, z: stand.y } : at(ex, ez);
  const inside = (v: number, lo: number) => Math.min(lo + 1 - 0.02, Math.max(lo + 0.02, v));
  if (last && !stand) {
    stop.x = inside(stop.x, m.xOf(end));
    stop.z = inside(stop.z, m.yOf(end));
  }
  const points = [{ x: p.x, z: p.y }, ...nodes.slice(1, -1).map(([x, z]) => at(x, z)), stop];
  // Straight on where nothing is in the way, but for where it sets off
  // or stops among crates, getting out or going in.
  const among = [points[0], stop].filter((q) => blockedAt(q.x, q.z));
  const by = (x: number, z: number) =>
    among.some((q) => Math.hypot(x - q.x, z - q.z) < half + CELL);
  const pullBlocked = (a: CellPoint, b: CellPoint) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / LINE_STEP));
    let k = 0;
    for (let s = 0; s <= n; s++) {
      const [x, z] = [a.x + ((b.x - a.x) * s) / n, a.z + ((b.z - a.z) * s) / n];
      if (!by(x, z) && blockedAt(x, z)) k++;
    }
    return k;
  };
  const corners = [...pullStraight(points, pullBlocked), stop];
  // A forklift comes the last bit straight at the load, square on, rather
  // than turn on the spot where it stands.
  if (stand && size === 2) {
    const pre = {
      x: stand.x - Math.cos(stand.dir) * LINE_UP,
      z: stand.y - Math.sin(stand.dir) * LINE_UP,
    };
    const from = corners.length > 1 ? corners[corners.length - 2] : { x: p.x, z: p.y };
    const far = Math.hypot(from.x - stand.x, from.z - stand.y) > LINE_UP;
    if (
      far &&
      !blockedAt(pre.x, pre.z) &&
      lineBlocked(pre, stop) === 0 &&
      lineBlocked(from, pre) === 0
    ) {
      corners.splice(corners.length - 1, 0, pre);
    }
  }
  return stand
    ? { points: corners, stand: { x: stand.x, y: stand.y, dir: stand.dir, reach: stand.reach } }
    : { points: corners };
}

/**
 * The nodes other workers have taken to stand at, as keys (x * 65536 +
 * z): to work a crate, or for a dockhand, where the others stand about.
 */
function takenStands(w: World, p: Dockhand): Set<number> {
  const out = new Set<number>();
  for (const q of w.people) {
    if (q === p) continue;
    if (!q.stand && sizeOf(p) === 1 && q.kind === 'dockhand' && q.path.length === 0) {
      out.add(Math.floor(q.x * SUB) * 65536 + Math.floor(q.y * SUB));
    }
    if (!q.stand) continue;
    const size = sizeOf(q);
    const [vx, vz] =
      size === 2
        ? [Math.round(q.stand.x * SUB), Math.round(q.stand.y * SUB)]
        : [Math.floor(q.stand.x * SUB), Math.floor(q.stand.y * SUB)];
    // A forklift takes the nodes round it, a dockhand its own.
    const r = size === 2 ? 1 : 0;
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) out.add((vx + dx) * 65536 + vz + dz);
  }
  return out;
}

/** The trucks standing within reach of a plan, where they stand. */
function trucksBy(w: World, p: Dockhand): string {
  let at = '';
  for (const t of w.trucks) {
    if (t.path.length > 0 || Math.abs(t.x - p.x) + Math.abs(t.y - p.y) > WINDOW) continue;
    at += `${t.id}:${t.x},${t.y};`;
  }
  return at;
}

/**
 * A dockhand or forklift going `speed` tiles this tick along its way
 * across the cells (see planCells), to a place it works a crate from among
 * `stands` once that is in sight, waiting short of a tile it may not
 * `enter`: as World.move does tile by tile, which it falls back on (null)
 * where it goes tile by tile. Come to its place, it stands there facing
 * the crate, and keeps that place (`p.stand`).
 */
export function moveCells(
  w: World,
  p: Dockhand,
  speed: number,
  enter?: (i: number) => boolean,
  stands?: () => StandPlan,
): 'moving' | 'arrived' | 'waiting' | null {
  const m = w.map;
  let plan = plans.get(p);
  const here = w.tileOf(p);
  if (
    !plan ||
    plan.path !== p.path ||
    plan.len !== p.path.length ||
    plan.tile !== here ||
    plan.goal !== p.goal ||
    plan.trucks !== trucksBy(w, p)
  ) {
    const want = stands && p.path.length <= WINDOW ? stands() : undefined;
    const ends = want?.stands ?? [];
    let made = p.path.length > 0 || ends.length > 0 ? planCells(w, p, ends) : null;
    // Come up to the stack another works at, or with no way round to a
    // place to work the crate from: it waits there its turn, a while.
    const near = p.path.length <= 1;
    if (want && near && (want.busy || (ends.length > 0 && !made?.stand))) {
      p.turnWait = (p.turnWait ?? 0) + 1;
      // Another's turn it waits out however long; no room, a while.
      if (want.busy || p.turnWait < TURN_PATIENCE) {
        p.waitingWhy = want.busy
          ? 'Waiting its turn at the crates another is working'
          : 'Waiting for room beside the crates to work them from';
        plans.delete(p);
        p.v = 0;
        return 'moving';
      }
    }
    // Nowhere to stand for the crate on the tile it is on already: it works
    // it from here, unless it stands among crates or in a truck's way; the
    // stack its own meanwhile all the same.
    if (made && !made.stand && p.path.length === 0 && !keptAt(w, p.x, p.y)) made = null;
    if (want && near && !want.busy) p.lock = want.lock;
    if (!made) {
      plans.delete(p);
      return null;
    }
    plan = {
      path: p.path,
      len: p.path.length,
      tile: here,
      goal: p.goal,
      ...made,
      waits: want?.busy,
      lock: want?.lock,
      trucks: trucksBy(w, p),
    };
    plans.set(p, plan);
    // A place to work the crate from, and the stack, kept from others.
    p.stand = made.stand;
    p.lock = near ? want?.lock : undefined;
    if (made.stand) {
      p.turnWait = undefined;
      p.waitingWhy = undefined;
    }
  }
  // A truck has pulled in where it was to stand, or crates have been set
  // down there: it looks again.
  if (plan.stand && sizeOf(p) === 1 && keptAt(w, plan.stand.x, plan.stand.y)) {
    plans.delete(p);
    p.stand = p.lock = undefined;
    return 'moving';
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
  if (plan.points.length === 0 && plan.waits) {
    // Come up to the stack another was at work at: it looks again.
    plans.delete(p);
    return 'moving';
  }
  if (plan.points.length === 0) {
    // At the place it works the crate from: there, facing it, the stack
    // its own; unless another has come to work it first, or it goes on a
    // truck gone meanwhile, or one pulled in since, when it looks again.
    if (plan.stand) {
      const now = stands?.();
      if (now && (now.busy || now.lock !== plan.lock)) {
        plans.delete(p);
        p.stand = p.lock = undefined;
        return 'moving';
      }
      p.lock = now?.lock;
      p.x = plan.stand.x;
      p.y = plan.stand.y;
      p.dir = plan.stand.dir;
      p.path = [];
      p.v = 0;
      plans.delete(p);
      return 'arrived';
    }
    const through = p.path.length === 0 || (p.path.length === 1 && p.path[0] === p.goal);
    if (w.tileOf(p) === p.goal && through) {
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
