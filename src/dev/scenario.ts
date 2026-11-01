import type { Command } from '../protocol';
import type { FisheryTerms } from '../sim/contracts';
import { placementError } from '../sim/rules';
import { anchorOf } from '../sim/rules/footprint';
import type { Bay } from '../sim/state';
import { spawnBoat } from '../sim/systems/boats/berthing';
import { setDown } from '../sim/systems/cargo/places';
import { addContract } from '../sim/systems/economy';
import { spawnDockhand } from '../sim/systems/workforce/dockhands';
import { Build, type BuildKind } from '../sim/types';
import { World } from '../sim/world';
import { bayCap, cratesAt } from '../sim/helpers';

// Mini scenarios for the Scenes tab: a new game's map cleared down to its
// bit of shore (the road in, the truck bay, the path and the jetty, no
// boat, no hands), with things put on it one step at a time: the game's own
// commands (built from its build bar as a player would, or by a preset)
// and a few of the lab's own (crates set down, a dockhand, a boat in, a
// truck called). A scenario is its seed and those steps, each at the tick
// it was taken, so replaying it gives the same port in the same state.
// Nothing here changes the sim: it is built from World.create, commands
// and the systems' own spawn functions, and a few fields set by hand.

/** What the lab does that the game has no command for. Tiles are map indexes. */
export type LabStep =
  /** Crates set down in the truck bay, crate storage or yard at `tile`, as if long there. */
  | { lab: 'crates'; tile: number; n: number; out?: boolean }
  /** A new dockhand standing at `tile`. */
  | { lab: 'dockhand'; tile: number }
  /** A boat with `crates` aboard, coming in from just off the jetty to its berth. */
  | { lab: 'boat'; vessel: 'smack' | 'coaster'; crates: number }
  /** Every bay may have a truck sent for its crates at once, rather than when next due. */
  | { lab: 'truck' };

export type Step = { at: number } & ({ cmd: Command } | LabStep);

export interface Scenario {
  kind: 'harbourmaster-scenario';
  version: 1;
  name: string;
  seed: number;
  tier: number;
  steps: Step[];
}

export const SCENARIO_SEED = 7;

/** A scenario file this version can replay. */
export function isScenario(s: unknown): s is Scenario {
  const o = s as Scenario;
  return (
    !!o &&
    o.kind === 'harbourmaster-scenario' &&
    o.version === 1 &&
    typeof o.seed === 'number' &&
    Array.isArray(o.steps)
  );
}

/** Commands that change the port, and so belong in a scenario; not speed, saves and the like. */
export const RECORDED = new Set<Command['type']>([
  'build',
  'bulldoze',
  'forkliftOnly',
  'unmark',
  'store',
  'shutStore',
  'sailNow',
  'exit',
  'oneWay',
  'lights',
  'gateWay',
  'roundabout',
  'terraform',
  'buyPlot',
  'hire',
  'fire',
  'buyMachine',
  'buyTug',
  'signContract',
  'cancelContract',
  'upgrade',
]);

/** Each blank world's patch, as found before anything was built on it. */
const origins = new WeakMap<World, { shore: number; row: number }>();

/** Where the patch is: the shore tile at the jetty's foot, on the row of the road in. */
export function patch(w: World): { shore: number; row: number } {
  const known = origins.get(w);
  if (known) return known;
  const m = w.map;
  const row = m.yOf(m.entry);
  let x = 0;
  while (x < m.w - 1 && m.build[m.idx(x + 1, row)] !== Build.Jetty) x++;
  return { shore: x, row };
}

/**
 * A new game on `seed` at `tier`, owning all its land with money to spare,
 * cleared down to its bit of shore: no boat coming, nobody working, no
 * fishery sending boats. Paused.
 */
export function blank(seed: number, tier: number): World {
  const w = World.create(seed, undefined, true);
  w.debug({ type: 'debug', tier });
  w.cash = 10_000_000;
  w.boats.length = 0;
  w.people.length = 0;
  for (const c of w.contracts) if (c.terms.kind === 'fishery') c.nextBoatTick = Infinity;
  w.speed = 0;
  w.events = [];
  origins.set(w, patch(w));
  return w;
}

/** The truck bay, crate storage or container yard tile `i` is part of. */
export function bayAt(w: World, i: number): Bay | undefined {
  const s = w.storeOf[i];
  if (s >= 0) return w.bays.get(s) ?? w.yards.get(s);
  return w.bays.get(anchorOf(w.map, i)) ?? w.bays.get(i);
}

/** A lab line of boats of this kind, which sends none of its own. */
function labLine(w: World, vessel: FisheryTerms['vessel']): { id: number; terms: FisheryTerms } {
  const name = vessel === 'coaster' ? 'Lab Coastal Line' : 'Lab Fishery';
  const have = w.contracts.find((c) => c.terms.name === name);
  if (have) return have as { id: number; terms: FisheryTerms };
  const terms: FisheryTerms = {
    kind: 'fishery',
    vessel,
    name,
    color: 2,
    boatEvery: 99,
    cratesMin: vessel === 'smack' ? 4 : 16,
    cratesMax: vessel === 'smack' ? 6 : 21,
    fee: 25,
    catch: vessel === 'coaster' ? 'timber' : undefined,
  };
  return addContract(w, terms, Infinity, 0) as { id: number; terms: FisheryTerms };
}

/** Take one step of a scenario now; what it did, or why it could not. */
export function apply(w: World, s: Step): string {
  if ('cmd' in s) {
    w.command(s.cmd);
    return s.cmd.type;
  }
  const m = w.map;
  switch (s.lab) {
    case 'crates': {
      const b = bayAt(w, s.tile);
      if (!b) return 'No truck bay, storage or yard there';
      const room = bayCap(b) - cratesAt(b) - cratesAt(b, true);
      const n = Math.max(0, Math.min(s.n, room));
      if (n === 0) return `${b.name ?? 'It'} is full`;
      setDown(
        w,
        b,
        Array.from({ length: n }, () => 25),
        !!s.out,
        undefined,
        { cleared: true },
      );
      return `${n} crates set down in ${b.name ?? `bay ${b.idx}`}`;
    }
    case 'dockhand': {
      const p = spawnDockhand(w, s.tile, {
        id: 0,
        name: `Lab hand ${w.people.filter((q) => q.kind === 'dockhand').length + 1}`,
        skill: 3,
        trait: null,
        wage: 0,
      });
      return `Dockhand #${p.id} at (${m.xOf(s.tile)}, ${m.yOf(s.tile)})`;
    }
    case 'boat': {
      const line = labLine(w, s.vessel);
      const n = w.boats.length;
      spawnBoat(w, line.id, line.terms, true);
      const b = w.boats[n];
      if (!b) return 'No open sea to come in from';
      b.crates = s.crates;
      return `${s.vessel} #${b.id} coming in with ${s.crates} crates`;
    }
    case 'truck': {
      for (const b of [...w.bays.values(), ...w.yards.values()]) b.nextTruckTick = 0;
      return 'Trucks may be sent at once';
    }
  }
}

/** The scenario's port, as it stood when its last step was taken. Paused. */
export function replay(sc: Scenario, onError?: (step: Step, err: unknown) => void): World {
  const w = blank(sc.seed, sc.tier);
  for (const s of sc.steps) {
    while (w.tick < s.at) w.step();
    try {
      apply(w, s);
    } catch (err) {
      onError?.(s, err);
    }
  }
  w.speed = 0;
  return w;
}

// ── Presets ──────────────────────────────────────────────────

export interface ScenarioPreset {
  id: string;
  name: string;
  note: string;
  /** Its steps, on the blank patch of `w`, all taken at tick 0. */
  steps(w: World): Step[];
  tier: number;
}

/** Steps building the port as a player would, checking each tile takes what is put on it. */
class Plan {
  steps: Step[] = [];
  constructor(readonly w: World) {}
  at(dx: number, dy: number): number {
    const { shore, row } = patch(this.w);
    return this.w.map.idx(shore + dx, row + dy);
  }
  /** Build, and take it at once on `w` too so the next check sees it. */
  do(s: Step): void {
    apply(this.w, s);
    this.steps.push(s);
  }
  build(kind: BuildKind, tiles: number[], facing?: number): void {
    const m = this.w.map;
    const busy = 'Something is already built here';
    const clear = tiles.filter((i) => placementError(m, kind, i, undefined, facing) === busy);
    if (clear.length) this.do({ at: 0, cmd: { type: 'bulldoze', tiles: clear } });
    for (const i of tiles) {
      const why = placementError(m, kind, i, undefined, facing);
      if (why) throw new Error(`${kind} at (${m.xOf(i)}, ${m.yOf(i)}): ${why}`);
    }
    this.do({ at: 0, cmd: { type: 'build', kind, tiles, facing } });
  }
  /** Build one `kind` on the first tile near (dx, dy), outward, that takes it. */
  near(kind: BuildKind, dx: number, dy: number, facing?: number): number {
    const m = this.w.map;
    for (let r = 0; r < 8; r++) {
      for (let y = dy - r; y <= dy + r; y++) {
        for (let x = dx - r; x <= dx + r; x++) {
          if (Math.max(Math.abs(x - dx), Math.abs(y - dy)) !== r) continue;
          const i = this.at(x, y);
          if (placementError(m, kind, i, undefined, facing)) continue;
          this.do({ at: 0, cmd: { type: 'build', kind, tiles: [i], facing } });
          return i;
        }
      }
    }
    throw new Error(`Nowhere near (${dx}, ${dy}) takes a ${kind}`);
  }
  rect(x0: number, y0: number, x1: number, y1: number): number[] {
    const out: number[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(this.at(x, y));
    return out;
  }
}

/** Steps for a preset, built on a throwaway copy of the blank patch. */
export function presetScenario(p: ScenarioPreset, seed = SCENARIO_SEED): Scenario {
  const w = blank(seed, p.tier);
  return {
    kind: 'harbourmaster-scenario',
    version: 1,
    name: p.name,
    seed,
    tier: p.tier,
    steps: p.steps(w),
  };
}

// Facing: 0 +x, 1 +y, 2 -x, 3 -y. On the patch the sea is at +x, the road
// in comes from -x along row 0, its truck bay at -4, the path from -3 to 0
// and the jetty from 1 to 3.
export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: 'empty',
    name: 'The bare patch',
    note: 'The road in, its truck bay, the path and the jetty: nothing working. Build on it from the build bar.',
    tier: 1,
    steps: () => [],
  },
  {
    id: 'hands',
    name: 'Two dockhands, a boat, a truck bay',
    note: 'A fishing boat with 6 crates comes in to the jetty; two dockhands carry them to the truck bay, and a truck comes for them.',
    tier: 1,
    steps: (w) => {
      const p = new Plan(w);
      p.do({ at: 0, lab: 'dockhand', tile: p.at(-1, 0) });
      p.do({ at: 0, lab: 'dockhand', tile: p.at(-2, 0) });
      p.do({ at: 0, lab: 'boat', vessel: 'smack', crates: 6 });
      return p.steps;
    },
  },
  {
    id: 'forklift',
    name: 'One forklift, one storage tile, one truck',
    note: 'A yard of port road behind a gate off the road in, one tile of crate storage holding 8 crates, and a forklift depot with one forklift, which loads the truck sent for them.',
    tier: 1,
    steps: (w) => {
      const p = new Plan(w);
      // The gate off the road in, facing it, and port road behind it.
      p.build('portGate', [p.at(-6, -1)], 1);
      p.build('portRoad', p.rect(-8, -4, -3, -2));
      p.do({ at: 0, cmd: { type: 'store', tiles: [p.at(-5, -3)], kind: 'crates', on: true } });
      p.build('depot', [p.at(-2, -3)], 2);
      p.do({ at: 0, cmd: { type: 'buyMachine', kind: 'forklift', tile: p.at(-2, -3) } });
      p.do({ at: 0, lab: 'crates', tile: p.at(-5, -3), n: 8 });
      p.do({ at: 0, lab: 'truck' });
      return p.steps;
    },
  },
  {
    id: 'jib',
    name: 'A jib crane, a quay, a boat',
    note: 'A bit of quay along the shore with a jib crane lifting a fishing boat’s 6 crates into the crate storage beside it, a dockhand to work it, and a forklift to load the truck that comes for them.',
    tier: 1,
    steps: (w) => {
      const p = new Plan(w);
      p.build('portGate', [p.at(-6, -1)], 1);
      p.build('portRoad', p.rect(-7, -3, -1, -2));
      p.build('quay', p.rect(0, -3, 0, -1));
      p.build('jibCrane', [p.at(0, -2)]);
      // Boats come to the quay, not the jetty, with a harbour office to coordinate it.
      p.do({ at: 0, cmd: { type: 'bulldoze', tiles: p.rect(1, 0, 3, 0) } });
      p.near('office', -3, -1);
      p.do({
        at: 0,
        cmd: { type: 'store', tiles: [p.at(-2, -2), p.at(-1, -2)], kind: 'crates', on: true },
      });
      p.build('depot', [p.at(-8, -3)], 0);
      p.do({ at: 0, cmd: { type: 'buyMachine', kind: 'forklift', tile: p.at(-8, -3) } });
      p.do({ at: 0, lab: 'dockhand', tile: p.at(-1, 0) });
      p.do({ at: 0, lab: 'boat', vessel: 'smack', crates: 6 });
      return p.steps;
    },
  },
];
