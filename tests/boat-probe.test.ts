import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import { DEFAULT_PILOT, isPilot } from '../src/sim/systems/boats/pilots';

declare const process: { env: Record<string, string | undefined> };

/**
 * Measures boat traffic in the game the dev bridge last mirrored into
 * .debug/save.json: hulls touching, near misses, time held up or going
 * astern, boats squeezing past as a last resort and boats seen off. Runs it
 * on several times, each sending boats at different times, and averages.
 * Skipped unless asked for:
 *
 *   HM_PROBE=1 [HM_PILOTS=classic,lookout,navigator] [HM_DAYS=5] [HM_RUNS=6]
 *     npx vitest run tests/boat-probe.test.ts --silent=false
 */
const saves = import.meta.glob('../.debug/save.json', { eager: true, import: 'default' });
const save = Object.values(saves)[0];

type Boat = World['boats'][number];

/** Distance from a point to the segment x0,y0 to x1,y1. */
function toSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number) {
  const vx = x1 - x0;
  const vy = y1 - y0;
  const l = vx * vx + vy * vy;
  const t = l > 0 ? Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / l)) : 0;
  return Math.hypot(px - x0 - vx * t, py - y0 - vy * t);
}

/** Clear water between two hulls, taken as capsules; below zero they touch. */
function gap(a: Boat, b: Boat): number {
  const keel = (q: Boat) => {
    const v = B.VESSELS[q.vessel];
    const h = v.length / 2 - v.beam / 2;
    const hx = Math.cos(q.dir) * h;
    const hy = Math.sin(q.dir) * h;
    return [q.x - hx, q.y - hy, q.x + hx, q.y + hy] as const;
  };
  const [ax, ay, bx, by] = keel(a);
  const [cx, cy, dx, dy] = keel(b);
  const side = (x0: number, y0: number, x1: number, y1: number, px: number, py: number) =>
    (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
  const crossed =
    side(ax, ay, bx, by, cx, cy) * side(ax, ay, bx, by, dx, dy) < 0 &&
    side(cx, cy, dx, dy, ax, ay) * side(cx, cy, dx, dy, bx, by) < 0;
  const keels = crossed
    ? 0
    : Math.min(
        toSegment(ax, ay, cx, cy, dx, dy),
        toSegment(bx, by, cx, cy, dx, dy),
        toSegment(cx, cy, ax, ay, bx, by),
        toSegment(dx, dy, ax, ay, bx, by),
      );
  return keels - (B.VESSELS[a.vessel].beam + B.VESSELS[b.vessel].beam) / 2;
}

function measure(world: World, ticks: number): Record<string, number> {
  const initialDepartures = world.boats.filter((b) => b.state === 'leaving').map((b) => b.id);
  const initialRunOuts = world.boats.filter((b) => b.berthing === 'out').map((b) => b.id);
  const under = (q: Boat) => q.state !== 'moored' && q.state !== 'anchored';
  // What each boat was doing when it touched another: squeezing past,
  // lying still, handling at a berth, or free on open water.
  const tag = (q: Boat) =>
    q.squeeze ? 'squeeze' : !under(q) ? q.state : q.berthing || q.undock ? 'handling' : 'free';
  const out: Record<string, number> = {};
  const add = (k: string, n = 1) => (out[k] = (out[k] ?? 0) + n);
  const touched = new Set<string>();
  const initial = new Set<string>();
  for (let i = 0; i < world.boats.length; i++) {
    for (let j = i + 1; j < world.boats.length; j++) {
      const a = world.boats[i];
      const b = world.boats[j];
      if (gap(a, b) < 0) initial.add(`${a.id}-${b.id}`);
    }
  }
  out.initialTouchingPairs = initial.size;
  out.newTouchingPairs = 0;
  const close = new Set<string>();
  const seen = new Set<number>();
  let held = 0;
  let astern = 0;
  let moving = 0;
  for (let t = 0; t < ticks; t++) {
    world.step();
    const ids = new Set(world.boats.map((b) => b.id));
    for (const id of seen) if (!ids.has(id)) add('boatsLeft');
    seen.clear();
    for (const id of ids) seen.add(id);
    const bs = world.boats;
    for (let i = 0; i < bs.length; i++) {
      const a = bs[i];
      if (under(a)) {
        moving++;
        if ((a.held ?? 0) > 0) held++;
        if (a.astern) astern++;
        if (a.squeeze === 199) add('squeezes');
      }
      for (let j = i + 1; j < bs.length; j++) {
        const c = bs[j];
        if (!under(a) && !under(c)) continue;
        const g = gap(a, c);
        const key = `${a.id}-${c.id}`;
        if (g < 0 && !touched.has(key)) {
          touched.add(key);
          add('touchingPairs');
          if (!initial.has(key)) add('newTouchingPairs');
          add(`touching:${[tag(a), tag(c)].sort().join('+')}`);
        } else if (g >= 0 && g < 0.3 && under(a) && under(c) && !close.has(key)) {
          close.add(key);
          add('nearMissPairs');
        }
      }
    }
  }
  out.heldShare = held / Math.max(1, moving);
  out.asternShare = astern / Math.max(1, moving);
  // Aggregate throughput can improve while the same old ships stay stuck.
  // Report those present at the start separately from new arrivals.
  out.initialDepartures = initialDepartures.length;
  out.initialDeparturesRemaining = world.boats.filter((b) =>
    initialDepartures.includes(b.id),
  ).length;
  out.initialRunOuts = initialRunOuts.length;
  out.remainingRunOuts = world.boats.filter(
    (b) => initialRunOuts.includes(b.id) && b.berthing === 'out',
  ).length;
  return out;
}

describe.skipIf(!process.env.HM_PROBE)('Boat traffic probe', () => {
  it('measures', () => {
    expect(save, 'no .debug/save.json: is the game open on the dev server?').toBeDefined();
    const days = Number(process.env.HM_DAYS ?? 5);
    const runs = Number(process.env.HM_RUNS ?? 6);
    for (const id of (process.env.HM_PILOTS ?? DEFAULT_PILOT).split(',')) {
      if (!isPilot(id)) throw new Error(`Unknown pilot: ${id}`);
      const total: Record<string, number> = {};
      for (let r = 0; r < runs; r++) {
        const world = World.fromSave(save as Parameters<typeof World.fromSave>[0]);
        world.pilot = id;
        world.rng.state = (world.rng.state + r * 7919) | 0;
        for (const [k, v] of Object.entries(measure(world, days * TICKS_PER_DAY))) {
          total[k] = (total[k] ?? 0) + v / runs;
        }
      }
      console.log(
        id,
        Object.fromEntries(
          Object.entries(total)
            .sort()
            .map(([k, v]) => [k, +v.toFixed(3)]),
        ),
      );
    }
  }, 600_000);
});
