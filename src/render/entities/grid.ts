import type { GameMap } from '../../sim/map';
import { drivable } from '../../sim/rules';
import { Build } from '../../sim/types';
import { bayCells, CELL, cellPath, pullStraight, SUB, unturned } from '../../sim/rules/cells';
import { surfaceY } from '../terrain';

// The ground the port's staff find their way across, a tile cut into four
// by four cells: which cells crates (in storage, on a truck bay's stack,
// piled on the quay or on a jib crane's landing stack), trucks standing
// still and the ground off the port keep them out of. A dockhand takes up
// a cell, a forklift two by two; each finds its way from cell to cell
// round what is in the way, rather than walking or driving through it.
// Worked out a tile at a time as it is asked about, and afresh with each
// snapshot from the game.

export { CELL, SUB };

/** What is in a cell, as bits. */
export const CELL_CRATE = 1;
export const CELL_TRUCK = 2;
/** Just ahead of a truck's cab, where dockhands never walk (they go round its back). */
export const CELL_CAB = 4;
/** Off the ground forklifts drive on: not a port road, quay or bay, or into a depot. */
export const CELL_NO_DRIVE = 8;
/** Off the ground people walk on: in the water. */
export const CELL_NO_WALK = 16;

export type Staff = 'dockhand' | 'forklift';

/** What keeps each kind of staff out of a cell. */
export const KEEPS_OUT: Record<Staff, number> = {
  dockhand: CELL_CRATE | CELL_TRUCK | CELL_CAB | CELL_NO_WALK,
  forklift: CELL_CRATE | CELL_TRUCK | CELL_NO_DRIVE,
};

/** A point on the ground. */
export interface Point {
  x: number;
  z: number;
}

/** A crate showing on the ground: its middle, and half its width. */
export interface CrateBox {
  x: number;
  z: number;
  half: number;
}

/** A truck standing still: its middle, which way it faces, how far its body reaches each way. */
export interface StillTruck {
  x: number;
  z: number;
  dir: number;
  /** Along it (+ towards its cab) and across it, from its middle. */
  back: number;
  front: number;
  left: number;
  right: number;
  /** A pickup, which people walk past the front of to load. */
  pickup: boolean;
}

/** Where the grid learns what is in the way; see Entities. */
export interface GridSources {
  map: GameMap;
  /** The crates showing on tile `i`. */
  crates(i: number): CrateBox[];
  /** The trucks standing still. */
  trucks(): StillTruck[];
}

/** How far round a truck's body its cells are kept clear. */
const TRUCK_PAD = 0.02;
/** How far ahead of a truck's cab dockhands keep out; see FRONT_CLEAR in trucks.ts. */
const CAB_CLEAR = 0.5;
/** How far apart points along a way are checked, in tiles. */
const LINE_STEP = 0.06;
/** Half how wide a dockhand and a forklift are, checking a point or a way is clear. */
export const HALF: Record<Staff, number> = { dockhand: 0.05, forklift: 0.24 };

export class StaffGrid {
  /** Bumped with each snapshot, so tiles are worked out afresh as they are asked about. */
  stamp = 1;
  /** The stamp each tile's cells were last worked out at. */
  private done: Uint32Array;
  /** Each tile's sixteen cells' bits, row by row. */
  private bits: Uint8Array;
  private crateCache = new Map<number, CrateBox[]>();
  private truckCache: StillTruck[] | null = null;
  /** Tiles worked out since the last snapshot, for a debug overlay or test. */
  worked = 0;

  constructor(private src: GridSources) {
    const n = src.map.w * src.map.h;
    this.done = new Uint32Array(n);
    this.bits = new Uint8Array(n * SUB * SUB);
  }

  /** Cells across and down the whole map. */
  get width(): number {
    return this.src.map.w * SUB;
  }
  get height(): number {
    return this.src.map.h * SUB;
  }

  /** What is in the way changed (a new snapshot): work each tile out afresh as it is next asked about. */
  invalidate(): void {
    this.stamp++;
    this.crateCache.clear();
    this.truckCache = null;
    this.worked = 0;
  }

  /** The bits of cell cx, cz (see CELL_*); off the map, everything. */
  flags(cx: number, cz: number): number {
    const m = this.src.map;
    const tx = Math.floor(cx / SUB);
    const tz = Math.floor(cz / SUB);
    if (!m.inBounds(tx, tz)) return 0xff;
    const t = m.idx(tx, tz);
    if (this.done[t] !== this.stamp) this.work(t, tx, tz);
    return this.bits[t * SUB * SUB + (cz - tz * SUB) * SUB + (cx - tx * SUB)];
  }

  /** Whether `kind` may stand in cell cx, cz: a forklift, in the two by two cells cx..cx+1, cz..cz+1. */
  free(kind: Staff, cx: number, cz: number): boolean {
    const keep = KEEPS_OUT[kind];
    if (kind === 'dockhand') return (this.flags(cx, cz) & keep) === 0;
    return (
      (this.flags(cx, cz) & keep) === 0 &&
      (this.flags(cx + 1, cz) & keep) === 0 &&
      (this.flags(cx, cz + 1) & keep) === 0 &&
      (this.flags(cx + 1, cz + 1) & keep) === 0
    );
  }

  /** Whether a crate shows at x, z, `pad` round it, as crateIn in Structures, from the crates the grid keeps. */
  crateAt(x: number, z: number, pad = 0): boolean {
    const m = this.src.map;
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!m.inBounds(tx + dx, tz + dz)) continue;
        for (const c of this.cratesOn(m.idx(tx + dx, tz + dz))) {
          const h = c.half + pad;
          if (Math.abs(c.x - x) < h && Math.abs(c.z - z) < h) return true;
        }
      }
    }
    return false;
  }

  /** The cell x, z is in. */
  cellOf(x: number, z: number): [number, number] {
    return [Math.floor(x * SUB), Math.floor(z * SUB)];
  }

  /**
   * How many of the cells a square `half` round x, z (a dockhand's or
   * forklift's width, by default) covers keep `kind` out, counting only
   * the bits in `mask`; 0 if it is clear.
   */
  blockedAt(kind: Staff, x: number, z: number, half = HALF[kind], mask = KEEPS_OUT[kind]): number {
    const x0 = Math.floor((x - half) * SUB);
    const x1 = Math.floor((x + half) * SUB);
    const z0 = Math.floor((z - half) * SUB);
    const z1 = Math.floor((z + half) * SUB);
    let n = 0;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) if (this.flags(cx, cz) & mask) n++;
    }
    return n;
  }

  /** Whether `kind` going straight from a to b keeps out of every cell kept from it (by `mask`). */
  clearLine(kind: Staff, a: Point, b: Point, mask = KEEPS_OUT[kind], half = HALF[kind]): boolean {
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(d / LINE_STEP));
    for (let k = 0; k <= n; k++) {
      const x = a.x + ((b.x - a.x) * k) / n;
      const z = a.z + ((b.z - a.z) * k) / n;
      if (this.blockedAt(kind, x, z, half, mask) > 0) return false;
    }
    return true;
  }

  /** How many of the points along the way from a to b are not clear for `kind`. */
  lineBlocked(kind: Staff, a: Point, b: Point, mask = KEEPS_OUT[kind], half = HALF[kind]): number {
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(d / LINE_STEP));
    let blocked = 0;
    for (let k = 0; k <= n; k++) {
      const x = a.x + ((b.x - a.x) * k) / n;
      const z = a.z + ((b.z - a.z) * k) / n;
      if (this.blockedAt(kind, x, z, half, mask) > 0) blocked++;
    }
    return blocked;
  }

  /**
   * Where `kind` stands on the grid nearest x, z, clear of what keeps it
   * out (all of it, or the bits in `mask`), within `reach` tiles; x, z itself if it is clear, null if
   * nowhere near is.
   */
  nearestFree(
    kind: Staff,
    x: number,
    z: number,
    reach = 0.75,
    mask = KEEPS_OUT[kind],
  ): Point | null {
    if (this.blockedAt(kind, x, z, HALF[kind], mask) === 0) return { x, z };
    let best: Point | null = null;
    let least = Infinity;
    const r = Math.ceil(reach * SUB);
    const [cx, cz] =
      kind === 'forklift' ? [Math.round(x * SUB), Math.round(z * SUB)] : this.cellOf(x, z);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const p = this.node(kind, cx + dx, cz + dz);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d >= least || d > reach) continue;
        if (this.blockedAt(kind, p.x, p.z, HALF[kind], mask) > 0) continue;
        [best, least] = [p, d];
      }
    }
    return best;
  }

  /**
   * Where a node of `kind`'s grid is: a dockhand's, a cell's middle; a
   * forklift's, the corner its two by two cells meet at.
   */
  node(kind: Staff, nx: number, nz: number): Point {
    return kind === 'dockhand'
      ? { x: (nx + 0.5) * CELL, z: (nz + 0.5) * CELL }
      : { x: nx * CELL, z: nz * CELL };
  }

  /** Whether `kind` may stand at node nx, nz; see node. */
  nodeFree(kind: Staff, nx: number, nz: number): boolean {
    return kind === 'dockhand' ? this.free(kind, nx, nz) : this.free(kind, nx - 1, nz - 1);
  }

  /**
   * The corners `kind` goes by from `from` to `to`, keeping out of the cells
   * kept from it: the shortest way across the grid within `room` tiles of
   * the two, pulled straight between corners wherever the straight way is
   * clear (or, starting among crates, through fewer of them). None when the straight way is clear already; where there is no
   * clear way at all, the way through the fewest cells kept from it.
   */
  route(kind: Staff, from: Point, to: Point, room = 1): Point[] {
    if (this.clearLine(kind, from, to)) return [];
    const m = this.src.map;
    // Forklifts' nodes are the corners between cells: one more each way.
    const extra = kind === 'forklift' ? 1 : 0;
    const nodeOf = (p: Point): [number, number] =>
      kind === 'dockhand'
        ? [Math.floor(p.x * SUB), Math.floor(p.z * SUB)]
        : [Math.round(p.x * SUB), Math.round(p.z * SUB)];
    const end = nodeOf(to);
    const goalAt = this.node(kind, ...end);
    const nodes = cellPath({
      bounds: [
        Math.max(0, Math.floor((Math.min(from.x, to.x) - room) * SUB)),
        Math.max(0, Math.floor((Math.min(from.z, to.z) - room) * SUB)),
        Math.min(m.w * SUB - 1 + extra, Math.ceil((Math.max(from.x, to.x) + room) * SUB)),
        Math.min(m.h * SUB - 1 + extra, Math.ceil((Math.max(from.z, to.z) + room) * SUB)),
      ],
      free: (nx, nz) => this.nodeFree(kind, nx, nz),
      at: (nx, nz) => this.node(kind, nx, nz),
      lineBlocked: (a, b) => this.lineBlocked(kind, a, b),
      start: nodeOf(from),
      goal: (nx, nz) => nx === end[0] && nz === end[1],
      guess: (nx, nz) => {
        const p = this.node(kind, nx, nz);
        return Math.hypot(p.x - goalAt.x, p.z - goalAt.z);
      },
    });
    if (!nodes) return [];
    const points = [from, ...nodes.slice(1).map(([x, z]) => this.node(kind, x, z)), to];
    return pullStraight(points, (a, b) => this.lineBlocked(kind, a, b));
  }

  /** Work out tile t's cells afresh. */
  private work(t: number, tx: number, tz: number): void {
    const m = this.src.map;
    this.done[t] = this.stamp;
    this.worked++;
    const base = t * SUB * SUB;
    const b = m.build[t];
    const drive = drivable(b) && b !== Build.Depot;
    for (let k = 0; k < SUB * SUB; k++) {
      const x = tx + ((k % SUB) + 0.5) * CELL;
      const z = tz + (Math.floor(k / SUB) + 0.5) * CELL;
      this.bits[base + k] =
        (drive ? 0 : CELL_NO_DRIVE) | (surfaceY(m, x, z) > 0 ? 0 : CELL_NO_WALK);
    }
    const mark = (
      x0: number,
      x1: number,
      z0: number,
      z1: number,
      bit: number,
      hit?: (cx: number, cz: number) => boolean,
    ) => {
      // The cells of this tile the box x0..x1, z0..z1 overlaps, any part of them.
      const e = 1e-4;
      const cx0 = Math.max(0, Math.floor((x0 + e - tx) * SUB));
      const cx1 = Math.min(SUB - 1, Math.floor((x1 - e - tx) * SUB));
      const cz0 = Math.max(0, Math.floor((z0 + e - tz) * SUB));
      const cz1 = Math.min(SUB - 1, Math.floor((z1 - e - tz) * SUB));
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          if (hit && !hit(cx, cz)) continue;
          this.bits[base + cz * SUB + cx] |= bit;
        }
      }
    };
    // Crates on this tile, and any on those round it reaching over.
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!m.inBounds(tx + dx, tz + dz)) continue;
        for (const c of this.cratesOn(m.idx(tx + dx, tz + dz))) {
          mark(c.x - c.half, c.x + c.half, c.z - c.half, c.z + c.half, CELL_CRATE);
        }
      }
    }
    // A truck standing in a truck bay keeps the whole half of the bay it stands in.
    if (b === Build.TruckBay) {
      for (const tr of this.trucks()) {
        if (Math.floor(tr.x) !== tx || Math.floor(tr.z) !== tz) continue;
        const [lx] = unturned(m.orient[t], tr.x - tx, tr.z - tz);
        const half = bayCells(m.orient[t], lx, false, false);
        for (let k = 0; k < SUB * SUB; k++) if (half & (1 << k)) this.bits[base + k] |= CELL_TRUCK;
      }
    }
    for (const tr of this.trucks()) {
      if (Math.abs(tr.x - tx - 0.5) > 2.5 || Math.abs(tr.z - tz - 0.5) > 2.5) continue;
      const box = (back: number, front: number, left: number, right: number, bit: number) => {
        const c = Math.cos(tr.dir);
        const s = Math.sin(tr.dir);
        // Its corners on the map, for the cells it may overlap.
        const xs: number[] = [];
        const zs: number[] = [];
        for (const a of [back, front]) {
          for (const r of [left, right]) {
            xs.push(tr.x + a * c - r * s);
            zs.push(tr.z + a * s + r * c);
          }
        }
        // A cell overlaps it unless one of its axes or the cell's parts them.
        const hit = (cx: number, cz: number) => {
          const mx = tx + (cx + 0.5) * CELL - tr.x;
          const mz = tz + (cz + 0.5) * CELL - tr.z;
          const h = CELL / 2;
          const along = mx * c + mz * s;
          const across = -mx * s + mz * c;
          const reach = h * (Math.abs(c) + Math.abs(s));
          return (
            along + reach > back &&
            along - reach < front &&
            across + reach > left &&
            across - reach < right
          );
        };
        mark(Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs), bit, hit);
      };
      const p = TRUCK_PAD;
      box(tr.back - p, tr.front + p, tr.left - p, tr.right + p, CELL_TRUCK);
      if (!tr.pickup)
        box(tr.front + p, tr.front + p + CAB_CLEAR, tr.left - p, tr.right + p, CELL_CAB);
    }
  }

  private cratesOn(i: number): CrateBox[] {
    let c = this.crateCache.get(i);
    if (!c) {
      c = this.src.crates(i);
      this.crateCache.set(i, c);
    }
    return c;
  }

  private trucks(): StillTruck[] {
    return (this.truckCache ??= this.src.trucks());
  }
}
