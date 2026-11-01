import type { World } from '../../world';
import type { Boat, Dockhand, Stand, Truck } from '../../state';
import type { HandAt } from '../../../protocol/views';
import { Build } from '../../types';
import { craneTicks } from '../../helpers';
import { CELL, STORE_ROWS, SUB, turnedCell, turnedPoint } from '../../rules/cells';
import { forksAlongZ } from '../../rules';
import * as B from '../../balance';
import { stackEnds, usedSlots } from '../cargo/places';
import { crateAt } from '../yardGantry';
import { pickupSpots } from '../cargo/stores';
import { lanePos, lengthOf } from '../roads/traffic';
import { farSide } from '../cargo/beds';
import { mooredTiles } from '../boats/berthing';
import { boatHalf } from '../boats/berthing';

// Where a dockhand or forklift stands to take a crate or set one down: on
// the staff's grid (rules/cells.ts), beside the crate or the place it goes
// and facing it, a dockhand in a cell within arm's reach of it, a forklift
// with its forks square on to it, a pallet in storage from the end of the
// stack its row faces, a truck's bed from its side, a truck bay's stack
// from behind. It walks or drives there, works the crate where it stands,
// and the view draws it just there, leaning or putting its forks in.
//
// One at a time works a stack of crates: in a tile of crate storage, on a
// truck bay's stack, a heap on the quay, a jib crane's landing stack, or a
// side of a truck's bed. Another going to the same one waits by it till
// the first is done there, as does a jib crane swinging a crate onto it.

/** A place a worker may stand, and the node of the grid it is at; see planCells. */
export interface StandAt extends Stand {
  node: [number, number];
  /** Taken only where none of a lower rank can be got to, as across a truck from its far side. */
  rank?: number;
}

/**
 * Where a worker may stand to work the crate it goes for: the places, the
 * stack the crate is in (see lockOf), and whether another is at work on
 * that stack, so it waits its turn.
 */
export interface StandPlan {
  stands: StandAt[];
  lock?: string;
  busy: boolean;
}

/** How far through its swing a jib crane has the stack it swings a crate onto to itself. */
const CRANE_COMING = 0.5;
/** How far a dockhand reaches to a crate, from the middle of the cell it stands in. */
export const ARM = 0.55;
/** How far it stands from a truck in a truck bay, leaning over its side, where the stack is in the way. */
const BAY_ARM = 0.65;
/** How far a dockhand stands from a truck bay's stack, reaching over its near row to the back one. */
const STACK_ARM = 0.6;
/** How far apart the rows of a truck bay's stack are. */
const ROW_GAP = 0.18;
/** How far a forklift stands back from a crate it lines up on, to its middle: its body, and its forks. */
const FORK_BACK = [0.45, 0.55, 0.65];
/** How far apart the columns of a truck's bed are. */
const COLUMN = 0.19;
/** How much further back a forklift stands to reach a truck's crates from across its bed. */
const ACROSS_BED = 0.2;

/**
 * Where the crate a worker is about to take or set down is, on the ground,
 * and which ways a forklift may come at it (from the stand towards the
 * crate); a dockhand's on the side `side` points to, where given.
 */
interface Spot {
  x: number;
  y: number;
  /** A forklift's ways in; any square way if none. */
  ways?: [number, number][];
  /** A forklift's exact places, as in storage, where it must stand at the end of a stack. */
  exact?: Stand[];
  /** A dockhand only on this side of it. */
  side?: [number, number];
  /** A dockhand only in these cells, as on the quay edge beside a boat. */
  cells?: [number, number][];
  /** How far a dockhand may stand from it, more than ARM where it must lean over to it. */
  arm?: number;
  /** Cells a dockhand never stands in, kept for the stack the crate is in, crates there or not. */
  avoid?: Set<number>;
  /** The stack the crate is in, which one worker works at a time; none for a boat. */
  lock?: string;
  /** Along a truck's bed: a forklift may stand a column either way of its load, failing that. */
  along?: [number, number];
  /** A dockhand only behind it, past the row behind it, along its first way: as at a truck bay's stack. */
  behind?: boolean;
}

/** A cell's key, x * 65536 + z. */
const key = (cx: number, cz: number) => cx * 65536 + cz;

/** The middle two by two cells of tile `t`, where a stack of crates stands. */
function middleOf(w: World, t: number): Set<number> {
  const [x, z] = [w.map.xOf(t) * SUB, w.map.yOf(t) * SUB];
  return new Set([key(x + 1, z + 1), key(x + 2, z + 1), key(x + 1, z + 2), key(x + 2, z + 2)]);
}

/**
 * The places a worker may stand to take (`pick`) the crate it goes for, or
 * set down the load it carries: none where there is no crate or place, or
 * the worker is not one that stands to it (a reach stacker or tractor).
 */
export function standsFor(w: World, p: Dockhand, pick: boolean): StandPlan {
  if (p.kind !== 'dockhand' && p.kind !== 'forklift') return { stands: [], busy: false };
  const at = crateAt(w, p, pick);
  const spot = at ? spotOf(w, p, at) : null;
  if (!spot) return { stands: [], busy: false };
  const holder = spot.lock ? locks(w).get(spot.lock) : undefined;
  const busy = !!holder && holder !== p;
  const stands = busy ? [] : p.kind === 'forklift' ? forkStands(spot) : handStands(spot);
  return { stands, lock: spot.lock, busy };
}

/** Who is at work at each stack, right now: workers going to or at one, and jib cranes swinging onto one. */
export function locks(w: World): Map<string, object> {
  const at = new Map<string, object>();
  for (const q of w.people) if (q.lock) at.set(q.lock, q);
  // A jib crane from when its crate is coming down onto the stack.
  for (const c of w.cranes.values()) {
    const into = c.setInto;
    const b = into && w.bays.get(into.store);
    if (!b?.tiles || into!.slot < 0 || c.timer < craneTicks(c) * CRANE_COMING) continue;
    at.set(storeLock(b.idx, into!.slot), c);
  }
  return at;
}

/** The lock of the stack slot `slot` of crate storage `store` is in: its tile's. */
export function storeLock(store: number, slot: number): string {
  return `s${store}:${Math.floor(slot / B.CRATES_PER_STORE_TILE)}`;
}

/** Whether a worker is at work at the stack slot `slot` of crate storage `store` is in. */
export function storeBusy(w: World, store: number, slot: number): boolean {
  const q = locks(w).get(storeLock(store, slot));
  return !!q && 'name' in q;
}

/** Where crate or place `at` is, and how it may be come at. */
function spotOf(w: World, p: Dockhand, at: HandAt): Spot | null {
  const m = w.map;
  if (at.store !== undefined) {
    const b = w.bays.get(at.store) ?? w.piles.get(at.store);
    if (!b?.tiles) return null;
    const per = B.CRATES_PER_STORE_TILE;
    const slot = at.slot ?? (at.place !== undefined ? at.place * B.FORKLIFT_CAPACITY : -1);
    if (slot < 0) return null;
    const t = b.tiles[Math.floor(slot / per)];
    if (t === undefined) return null;
    const r = slot % per;
    const row = Math.floor(Math.floor(r / B.FORKLIFT_CAPACITY) / 2);
    const z = forksAlongZ(m, t);
    const across =
      0.5 + (at.place === undefined && p.kind !== 'forklift' ? (r % 2 ? 0.08 : -0.08) : 0);
    const along = STORE_ROWS[row];
    const [x, y] = z
      ? [m.xOf(t) + across, m.yOf(t) + along]
      : [m.xOf(t) + along, m.yOf(t) + across];
    const lock = storeLock(b.idx, slot);
    if (p.kind !== 'forklift') return { x, y, avoid: middleOf(w, t), lock };
    // From the end of the stack its row faces, or through the other row
    // while that is empty.
    const { now } = stackEnds(w, t);
    const used = usedSlots(w, b);
    const first = Math.floor(slot / per) * per;
    const empty = (rw: number) => {
      for (let k = first + rw * 8; k < first + rw * 8 + 8; k++) if (used.has(k)) return false;
      return true;
    };
    const exact: Stand[] = [];
    for (const end of [row, 1 - row]) {
      if (!now[end] || (end !== row && !empty(end))) continue;
      const edge = end === 0 ? 0 : 1;
      const d = end === 0 ? 1 : -1;
      const [sx, sy] = z ? [m.xOf(t) + 0.5, m.yOf(t) + edge] : [m.xOf(t) + edge, m.yOf(t) + 0.5];
      const dir = z ? Math.atan2(d, 0) : Math.atan2(0, d);
      exact.push({ x: sx, y: sy, dir, reach: Math.abs(along - edge) });
    }
    return { x, y, exact, lock };
  }
  if (at.bay !== undefined) {
    if (m.build[at.bay] !== Build.TruckBay || at.slot === undefined || at.slot < 0) return null;
    const o = m.orient[at.bay];
    const row = Math.floor(at.slot / 8);
    // A forklift's load two crates wide across the stack, a dockhand's the one crate.
    const x = p.kind === 'forklift' ? 0.8 : [0.71, 0.89][at.slot % 2];
    const [lx, lz] = turnedPoint(o, x, [0.89, 0.71][row] ?? 0.71);
    const [bx, bz] = turnedPoint(o, 0.8, 0.3);
    // From behind its stack, away from the road.
    const [fx, fz] = [lx - bx, lz - bz];
    const n = Math.hypot(fx, fz) || 1;
    const avoid = new Set<number>();
    for (const [cx, cz] of [
      [2, 2],
      [3, 2],
      [2, 3],
      [3, 3],
    ]) {
      const [tx, tz] = turnedCell(o, cx, cz);
      avoid.add(key(m.xOf(at.bay) * SUB + tx, m.yOf(at.bay) * SUB + tz));
    }
    return {
      x: m.xOf(at.bay) + lx,
      y: m.yOf(at.bay) + lz,
      ways: [[Math.round(fx / n), Math.round(fz / n)]],
      arm: STACK_ARM,
      avoid,
      behind: true,
      lock: `b${at.bay}`,
    };
  }
  if (at.pile !== undefined) {
    const k = Math.max(0, at.slot ?? 0) % 4;
    const [px, pz] = [
      [0.38, 0.38],
      [0.62, 0.38],
      [0.38, 0.62],
      [0.62, 0.62],
    ][k];
    return {
      x: m.xOf(at.pile) + px,
      y: m.yOf(at.pile) + pz,
      avoid: middleOf(w, at.pile),
      lock: `p${at.pile}`,
    };
  }
  if (at.crane !== undefined) {
    const c = at.crane;
    const water = (dx: number, dy: number) => {
      const x = m.xOf(c) + dx;
      const y = m.yOf(c) + dy;
      return m.inBounds(x, y) && !m.isLand(m.idx(x, y));
    };
    // Along the landward edge of its tile, as the view stacks them.
    const [px, pz, way]: [number, number, [number, number]] = water(0, -1)
      ? [0.5, 0.875, [0, 1]]
      : water(0, 1)
        ? [0.5, 0.125, [0, -1]]
        : water(-1, 0)
          ? [0.875, 0.5, [1, 0]]
          : [0.125, 0.5, [-1, 0]];
    return { x: m.xOf(c) + px, y: m.yOf(c) + pz, ways: [way], lock: `c${c}` };
  }
  if (at.truck !== undefined) {
    const t = w.trucks.find((q) => q.id === at.truck);
    if (t) return bedSpot(w, t, at);
    const boat = w.boats.find((q) => q.id === at.truck);
    if (boat) return boatSpot(w, p, boat);
  }
  return null;
}

/**
 * Where slot(s) `at` of a crate truck's bed are: rows of two, one on each
 * side of the truck, from the cab back, as vehicles.ts draws them; a
 * dockhand works each from its own side, a forklift side on.
 */
function bedSpot(w: World, t: Truck, at: HandAt): Spot {
  const slots = at.slots?.length ? at.slots : [Math.max(0, at.slot ?? 0)];
  const per = Math.max(1, t.capacity);
  const cols = Math.ceil(per / 2);
  const len = lengthOf(w, t);
  const [fx, fy] = [Math.cos(t.dir), Math.sin(t.dir)];
  // Its left, as it faces; side 0 of its bed.
  const [lx, ly] = [Math.sin(t.dir), -Math.cos(t.dir)];
  // Where it is drawn, to the side of its lane.
  const [tx, ty] = lanePos(w, t);
  let [x, y, side] = [0, 0, 0];
  for (const s of slots) {
    const k = Math.floor((s % per) / 2);
    const left = s % 2 === 0 ? 1 : -1;
    const along = -len / 2 + (cols - k) * 0.19 - 0.07;
    x += tx + fx * along + lx * 0.08 * left;
    y += ty + fy * along + ly * 0.08 * left;
    side += left;
  }
  x /= slots.length;
  y /= slots.length;
  // In a truck bay a forklift comes at it from behind its stack, and a
  // dockhand from wherever there is room, leaning over the side to it;
  // anywhere else from the side the crates go on.
  const m = w.map;
  const tile = w.tileOf(t);
  const inBay = m.build[tile] === Build.TruckBay && t.bayIdx === tile;
  const near = farSide(w, t) === 0 ? -1 : 1;
  const left = inBay ? near : side >= 0 ? 1 : -1;
  const out: [number, number] = [lx * left, ly * left];
  const lock = `t${t.id}`;
  const along: [number, number] = [fx, fy];
  if (inBay) return { x, y, ways: [[-out[0], -out[1]]], arm: BAY_ARM, lock, along };
  return { x, y, ways: [[-out[0], -out[1]]], side: out, lock, along };
}

/** The cells on the quay edge beside a boat a dockhand works it from, facing it. */
function boatSpot(w: World, _p: Dockhand, b: Boat): Spot {
  const m = w.map;
  const hull = new Set(
    mooredTiles(w, b.berth, b.jetty, boatHalf(w, b.vessel === 'feeder')) ?? [b.berth],
  );
  const cells: [number, number][] = [];
  for (const t of pickupSpots(w, b)) {
    const [x, y] = [m.xOf(t), m.yOf(t)];
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const n = m.inBounds(x + dx, y + dy) ? m.idx(x + dx, y + dy) : -1;
      if (n < 0 || (!hull.has(n) && m.isLand(n))) continue;
      // The row of cells along that edge of the tile.
      for (let k = 0; k < SUB; k++) {
        const cx = dx ? x * SUB + (dx > 0 ? SUB - 1 : 0) : x * SUB + k;
        const cz = dy ? y * SUB + (dy > 0 ? SUB - 1 : 0) : y * SUB + k;
        cells.push([cx, cz]);
      }
    }
  }
  return { x: b.x, y: b.y, cells };
}

/** A dockhand's places by a spot: cells within arm's reach of it, on its side if it has one, facing it. */
function handStands(s: Spot): StandAt[] {
  const out: StandAt[] = [];
  const near = (cx: number, cz: number) => {
    const [x, y] = [(cx + 0.5) * CELL, (cz + 0.5) * CELL];
    const reach = Math.hypot(s.x - x, s.y - y);
    out.push({ node: [cx, cz], x, y, dir: Math.atan2(s.y - y, s.x - x), reach });
  };
  if (s.cells) {
    for (const [cx, cz] of s.cells) near(cx, cz);
    return out.sort((a, b) => a.reach - b.reach).slice(0, 6);
  }
  // On its side if it has one; failing that, across from the other,
  // leaning over to it.
  const arm = s.arm ?? ARM;
  const far = s.side ? BAY_ARM : arm;
  const r = Math.ceil(far * SUB) + 1;
  const [ux, uz] = [Math.floor(s.x * SUB), Math.floor(s.y * SUB)];
  for (let cz = uz - r; cz <= uz + r; cz++) {
    for (let cx = ux - r; cx <= ux + r; cx++) {
      const [x, y] = [(cx + 0.5) * CELL, (cz + 0.5) * CELL];
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < CELL * 0.5 || s.avoid?.has(key(cx, cz))) continue;
      const way = s.behind && s.ways?.[0];
      if (way && (x - s.x) * way[0] + (y - s.y) * way[1] > -ROW_GAP) continue;
      const across = !!s.side && (x - s.x) * s.side[0] + (y - s.y) * s.side[1] <= 0;
      if (d > (across ? far : arm)) continue;
      near(cx, cz);
      if (across) out[out.length - 1].rank = 1;
    }
  }
  return out;
}

/** A forklift's places by a spot: square on to it, its forks lined up on it. */
function forkStands(s: Spot): StandAt[] {
  const node = (x: number, y: number): [number, number] => [
    Math.round(x * SUB),
    Math.round(y * SUB),
  ];
  if (s.exact) return s.exact.map((e) => ({ ...e, node: node(e.x, e.y) }));
  const ways = s.ways ?? [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const out: StandAt[] = [];
  // Square on to it; failing that, a column along a truck's bed either
  // way, edging over to it as it drives in, or from across the bed, its
  // forks reaching over to the crates on the far side.
  const shifts = s.along ? [0, -COLUMN, COLUMN] : [0];
  const all = s.side ? [...ways, s.side] : ways;
  all.forEach(([dx, dy], k) => {
    const n = Math.hypot(dx, dy) || 1;
    const [ux, uy] = [dx / n, dy / n];
    for (const shift of shifts) {
      const [ax, ay] = s.along ? [s.along[0] * shift, s.along[1] * shift] : [0, 0];
      for (const near of FORK_BACK) {
        // Across the bed, the width of it further back.
        const back = k >= ways.length ? near + ACROSS_BED : near;
        const [vx, vz] = node(s.x + ax - ux * back, s.y + ay - uy * back);
        const [x, y] = [vx * CELL, vz * CELL];
        const reach = Math.hypot(s.x - x, s.y - y);
        const rank = shift || k >= ways.length ? 1 : 0;
        out.push({ node: [vx, vz], x, y, dir: Math.atan2(uy, ux), reach, rank });
      }
    }
  });
  return out;
}
