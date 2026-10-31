import type { Renderer } from '../render/renderer';
import type { Entry } from '../render/entities/entry';
import { bodyBlocked, type ForkSite, type Point } from '../render/entities/forks';
import { inTruck, type TruckSite } from '../render/entities/trucks';
import type { GameMap } from '../sim/map';
import { drivable, walkableAt } from '../sim/rules';
import { Build } from '../sim/types';
import { PASS_BLOCKED, PASS_COSTLY, PASS_HIDDEN, PASS_OK, type DebugGrid } from './types';

// Dev server only: what the 3D view works out for itself as it moves the
// workers about, finer than the sim's tiles: where a forklift's body fits
// among the crates and trucks drawn, where a dockhand steps round a truck,
// and the corners each plans to go by. Read from the renderer's insides,
// which nothing else here should touch.

/** What the debug overlays read of the renderer's Entities, private as they are. */
interface Inside {
  entries: { get(id: number): Entry | undefined; values(): Iterable<Entry> };
  forkSite: ForkSite;
  trucks: TruckSite;
  grid?: StaffGridLike;
  staffGrid?: StaffGridLike;
}

/**
 * The staff's own grid of cells, a tile cut four by four, as the view's
 * way finding has it (render/entities/grid.ts, once it is in): read by its
 * shape only, so these overlays work with or without it.
 */
interface StaffGridLike {
  width: number;
  free(kind: 'dockhand' | 'forklift', cx: number, cz: number): boolean;
  flags(cx: number, cz: number): number;
}

/** Cell bits that are something in the way (crates, a truck, ahead of a cab) rather than off the ground. */
const IN_THE_WAY = 1 | 2 | 4;

function staffGrid(e: Inside): StaffGridLike | null {
  const g = e.staffGrid ?? e.grid ?? (e.forkSite as ForkSite & { grid?: StaffGridLike }).grid;
  return g && typeof g.free === 'function' ? g : null;
}

/** A source reading the staff's grid for `kind`: free green, in the way red, off the ground not shown. */
function gridSource(kind: 'dockhand' | 'forklift') {
  return (r: Renderer, map: GameMap): FineSource | null => {
    const e = inside(r);
    const g = e && staffGrid(e);
    if (!g) return null;
    const sub = g.width / map.w;
    return {
      label: `Staff grid: ${kind}`,
      cell: 1 / sub,
      at(x, z) {
        const [cx, cz] = [Math.floor(x * sub), Math.floor(z * sub)];
        if (g.free(kind, cx, cz)) return PASS_OK;
        return g.flags(cx, cz) & IN_THE_WAY ? PASS_BLOCKED : PASS_HIDDEN;
      },
    };
  };
}

function inside(r: Renderer): Inside | null {
  return (r as unknown as { layers: { entities: Inside } | null }).layers?.entities ?? null;
}

/**
 * A fine passability layer: how big its cells are, in tiles, and what each
 * cell is (PASS_OK, PASS_COSTLY, PASS_BLOCKED or PASS_HIDDEN) from the
 * point at its middle. A finer grid for the staff's way finding plugs in
 * here as one more of these.
 */
export interface FineSource {
  label: string;
  cell: number;
  at(x: number, z: number): number;
}

/** The ways of measuring there are, by name, given what the view has drawn. */
export const FINE: Record<
  string,
  { label: string; make(r: Renderer, map: GameMap): FineSource | null }
> = {
  gridFork: { label: 'Staff grid: forklift', make: gridSource('forklift') },
  gridWalk: { label: 'Staff grid: dockhand', make: gridSource('dockhand') },
  fork: {
    label: 'Forklift body (view)',
    make(r, map) {
      const e = inside(r);
      if (!e) return null;
      return {
        label: 'Forklift body',
        cell: 0.25,
        at(x, z) {
          const [tx, tz] = [Math.floor(x), Math.floor(z)];
          if (!map.inBounds(tx, tz)) return PASS_HIDDEN;
          const b = map.build[map.idx(tx, tz)];
          if (!drivable(b) || b === Build.Depot) return PASS_HIDDEN;
          // However it turns, the least it is in the way.
          let least = Infinity;
          for (let k = 0; k < 4 && least > 0; k++) {
            least = Math.min(least, bodyBlocked(e.forkSite, x, z, (k * Math.PI) / 4));
          }
          return least === 0 ? PASS_OK : least < 3 ? PASS_COSTLY : PASS_BLOCKED;
        },
      };
    },
  },
  walk: {
    label: 'Dockhand step (view)',
    make(r, map) {
      const e = inside(r);
      if (!e) return null;
      return {
        label: 'Dockhand step',
        cell: 0.25,
        at(x, z) {
          const [tx, tz] = [Math.floor(x), Math.floor(z)];
          if (!map.inBounds(tx, tz)) return PASS_HIDDEN;
          if (!walkableAt(map, map.idx(tx, tz))) return PASS_HIDDEN;
          if (inTruck(e.trucks, x, z)) return PASS_BLOCKED;
          return e.forkSite.crateIn(x, z, 0) ? PASS_COSTLY : PASS_OK;
        },
      };
    },
  },
};

/** A fine source's cells over the ground `half` tiles each way round cx, cz. */
export function fineGrid(src: FineSource, cx: number, cz: number, half: number): DebugGrid {
  const c = src.cell;
  const x0 = Math.floor((cx - half) / c) * c;
  const y0 = Math.floor((cz - half) / c) * c;
  const nx = Math.ceil((2 * half) / c);
  const ny = nx;
  const values = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      values[j * nx + i] = src.at(x0 + (i + 0.5) * c, y0 + (j + 0.5) * c);
    }
  }
  return { x0, y0, cell: c, nx, ny, values };
}

/** The way an entity is going as the view plans it, in parts, each a list of points. */
export interface FinePlan {
  /** Where it is drawn now. */
  at?: Point;
  /** Backing out of the last load, round to line up, in to the load. */
  legs: { name: string; points: Point[] }[];
}

/** How the view has the entity `id` working a load, or going round a truck, if it is. */
export function finePlan(r: Renderer, id: number): FinePlan | null {
  const e = inside(r)?.entries.get(id);
  if (!e) return null;
  const at = e.pose ? { x: e.pose.x, z: e.pose.z } : undefined;
  const legs: FinePlan['legs'] = [];
  const h = e.hand;
  if (h?.plan) {
    const p = h.plan;
    const start = p.out ?? h.from;
    if (p.out) legs.push({ name: 'out', points: [h.from, p.out] });
    legs.push({ name: 'via', points: [start, ...(p.via ?? []), p.line] });
    legs.push({ name: 'in', points: [p.line, p.goal] });
    if (p.away) legs.push({ name: 'away', points: [p.line, ...p.away] });
  } else if (h) {
    const goal = h.goal;
    if (goal) legs.push({ name: 'walk', points: [h.from, ...(h.via ?? []), goal] });
  }
  if (e.round) legs.push({ name: `round truck ${e.round.truck}`, points: [] });
  // The way the staff's grid has it going otherwise: its lane ahead as it
  // drives or walks, or round crates in the way (Entities.plannedPath).
  const route = e.route;
  if (route && route.length > 1 && !h?.plan && !h?.goal) legs.push({ name: 'grid', points: route });
  return { at, legs };
}
