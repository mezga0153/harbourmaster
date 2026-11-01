import type { CostFn } from '../sim/path';
import { forkCells } from '../sim/systems/workforce/forkCells';
import { truckCost } from '../sim/rules';
import type { Agent, Bay, Dockhand } from '../sim/state';
import { cratesAt } from '../sim/helpers';
import { reserved, slotted, usedSlots } from '../sim/systems/cargo/places';
import { truckCostFor } from '../sim/systems/roads/bays';
import { forkCost } from '../sim/systems/workforce/crowding';
import { Build } from '../sim/types';
import type { World } from '../sim/world';
import {
  PASS_BLOCKED,
  PASS_COSTLY,
  PASS_HIDDEN,
  PASS_OK,
  type DebugGrid,
  type DebugPath,
  type DebugSlots,
  type DebugView,
  type DebugWant,
  type PassKind,
} from './types';

// Dev server only: what the debug overlays show, worked out from the sim
// where it runs (the worker in the game, the page in the dev lab), as the
// sim's own path searches see it. Nothing here changes the world.

/** Crate slots in each tile of crate storage, and in a truck bay or a large one. */
const PER_TILE = 16;
const BAY_SLOTS = 16;
const LARGE_SLOTS = 28;

/** Every agent there is: workers and machines, trucks, boats, tugs. */
function agents(w: World): { a: Agent; kind: string }[] {
  return [
    ...w.people.map((a) => ({ a: a as Agent, kind: a.kind })),
    ...w.trucks.map((a) => ({ a: a as Agent, kind: 'truck' })),
    ...w.boats.map((a) => ({ a: a as Agent, kind: 'boat' })),
    ...w.tugs.map((a) => ({ a: a as Agent, kind: 'tug' })),
  ];
}

function pathOf(a: Agent, kind: string): DebugPath {
  const round = (a as { round?: number[] }).round;
  return {
    id: a.id,
    kind,
    x: a.x,
    y: a.y,
    path: a.path.slice(),
    goal: a.goal,
    state: (a as { state?: string }).state,
    round: round?.length ? round.slice() : undefined,
    cells: kind === 'forklift' ? forkCells(a as Dockhand)?.flatMap((c) => [c.x, c.z]) : undefined,
  };
}

/** An agent's state, field by field, short: arrays as their length and first few. */
function jobOf(a: Agent): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined || typeof v === 'function') continue;
    let s: string;
    if (Array.isArray(v)) {
      s = v.length === 0 ? '[]' : `[${v.length}] ${JSON.stringify(v.slice(0, 6)).slice(0, 80)}`;
    } else if (typeof v === 'number') {
      s = Number.isInteger(v) ? String(v) : v.toFixed(3);
    } else if (typeof v === 'object' && v !== null) {
      s = JSON.stringify(v).slice(0, 120);
    } else s = String(v);
    out.push([k, s]);
  }
  return out;
}

/** The cost function the sim's searches use for this kind, for the selected agent where it matters. */
function costFor(w: World, kind: PassKind, sel: Agent | undefined): CostFn {
  if (kind === 'walk') return w.walkCost;
  if (kind === 'drive') return w.driveCost;
  if (kind === 'fork') return forkCost(w, sel?.goal ?? -1);
  const t = sel && w.trucks.find((q) => q === sel);
  return t ? truckCostFor(w, t.bayIdx, -1, t) : truckCost(w.map);
}

/**
 * Each tile's passability for `kind`: green where it may go, amber where
 * it would rather not, red on built tiles it may not; open land and sea,
 * which nobody crosses, left out.
 */
export function passGrid(w: World, kind: PassKind, sel?: Agent): DebugGrid {
  const m = w.map;
  const cost = costFor(w, kind, sel);
  const values = new Uint8Array(m.w * m.h);
  for (let i = 0; i < values.length; i++) {
    const c = cost(i);
    if (Number.isFinite(c)) values[i] = c <= 1.0001 ? PASS_OK : PASS_COSTLY;
    else values[i] = m.build[i] === Build.None ? PASS_HIDDEN : PASS_BLOCKED;
  }
  return { x0: 0, y0: 0, cell: 1, nx: m.w, ny: m.h, values };
}

/** Every step a truck may take from one tile onto the next, as the plain road rules allow. */
export function roadGraph(w: World): Int32Array {
  const m = w.map;
  const cost = truckCost(m);
  const out: number[] = [];
  for (let i = 0; i < m.build.length; i++) {
    if (!Number.isFinite(cost(i))) continue;
    for (const j of m.neighbors4(i)) if (Number.isFinite(cost(j, i))) out.push(i, j);
  }
  return Int32Array.from(out);
}

function slotsOf(w: World, b: Bay): DebugSlots {
  const cap = b.tiles ? b.tiles.length * PER_TILE : b.large ? LARGE_SLOTS : BAY_SLOTS;
  const bits = [
    `${cratesAt(b)} crates`,
    cratesAt(b, true) ? `${cratesAt(b, true)} out` : '',
    b.incoming ? `${b.incoming} coming` : '',
    b.reserved ? `${b.reserved} kept` : '',
    b.shut ? 'shut' : '',
    b.noAccess ? `CUT OFF${b.noAccessWhy ? `: ${b.noAccessWhy}` : ''}` : '',
  ];
  const sl = slotted(b);
  return {
    idx: b.idx,
    name: b.name ?? (b.pile ? 'pile' : `#${b.idx}`),
    tiles: b.tiles ?? [b.idx],
    cap: sl ? cap : 0,
    perStack: b.tiles ? PER_TILE : cap,
    used: sl ? [...usedSlots(w, b)] : [],
    kept: sl ? [...reserved(w, b)] : [],
    note: bits.filter(Boolean).join(', '),
    noAccess: b.noAccess,
  };
}

/** What the overlays want, as the world now stands. */
export function collect(w: World, want: DebugWant): DebugView {
  const all = agents(w);
  const sel = want.selected === null ? undefined : all.find((q) => q.a.id === want.selected);
  const shown = want.allPaths ? all : sel ? [sel] : [];
  const view: DebugView = {
    tick: w.tick,
    paths: shown.map(({ a, kind }) => pathOf(a, kind)),
  };
  if (sel) view.job = 'kind' in sel.a ? jobOf(sel.a) : [['kind', sel.kind], ...jobOf(sel.a)];
  if (want.pass) {
    // A forklift's or truck's own way, where one is selected.
    const own = sel && (want.pass === 'fork' ? sel.kind === 'forklift' : sel.kind === 'truck');
    view.pass = { kind: want.pass, grid: passGrid(w, want.pass, own ? sel.a : undefined) };
  }
  if (want.roads) view.roads = roadGraph(w);
  if (want.slots) {
    view.slots = [...w.bays.values(), ...w.yards.values(), ...w.piles.values()].map((b) =>
      slotsOf(w, b),
    );
  }
  return view;
}
