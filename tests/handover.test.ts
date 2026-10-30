import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import * as B from '../src/sim/balance';
import { placementError } from '../src/sim/rules';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import type { EntityView } from '../src/protocol';
import { Entities } from '../src/render/entities';
import { headingOf } from '../src/render/models';
import { Structures } from '../src/render/structures';

/**
 * A container terminal north of the starting jetty, as in sim.test.ts: a
 * pier out to deep water with a harbour crane at its end, a 2×2 container
 * yard beside a port gate, and a depot with a reach stacker.
 */
function terminal(world: World): number {
  const m = world.map;
  const r = m.yOf(m.entry);
  let shore = 0;
  while (m.build[m.idx(shore + 1, r)] !== Build.Jetty) shore++;
  const start = shore - 4;
  const tiles = (row: number, x0: number, x1: number) =>
    Array.from({ length: x1 - x0 + 1 }, (_, k) => m.idx(x0 + k, row));
  for (const row of [r - 1, r - 2]) {
    world.command({ type: 'bulldoze', tiles: tiles(row, start, shore + 12) });
  }
  let end = -1;
  for (let x = shore + 1; x < m.w - 3; x++) {
    const out = m.idx(x, r - 3);
    if (m.isLand(m.idx(x, r - 2))) continue;
    if (m.depth[m.idx(x, r - 2)] > B.MAX_QUAY_DEPTH) break;
    if (!m.isLand(out) && m.depth[out] >= B.FEEDER_DRAFT + 0.5) {
      end = x;
      break;
    }
  }
  for (const row of [r - 1, r - 2]) {
    for (const i of tiles(row, start, end)) {
      const kind = m.isLand(i) ? 'portRoad' : 'quay';
      world.command({ type: 'build', kind, tiles: [i] });
    }
  }
  const crane = m.idx(end, r - 2);
  world.command({ type: 'build', kind: 'harbourCrane', tiles: [crane] });
  const corner = m.idx(start - 2, r - 2);
  const area = [corner, corner + 1, corner + m.w, corner + m.w + 1];
  world.command({ type: 'bulldoze', tiles: area });
  world.command({ type: 'build', kind: 'portRoad', tiles: area });
  world.command({ type: 'store', tiles: area, kind: 'boxes', on: true });
  world.command({ type: 'bulldoze', tiles: [corner - 1, corner + m.w - 1] });
  world.command({ type: 'build', kind: 'portGate', tiles: [corner + m.w - 1], facing: 1 });
  world.command({ type: 'build', kind: 'portRoad', tiles: [corner - 1] });
  // And a port road round the far side of the yard to the spur, for the
  // machines: they never drive across the stacks.
  const round = [corner - 1 - m.w, corner - m.w, corner + 1 - m.w];
  world.command({ type: 'bulldoze', tiles: round });
  world.command({ type: 'build', kind: 'portRoad', tiles: round });
  // Room for the trucks to turn round in at the spur: two wide each way.
  const turn = [corner - 2, corner - 2 - m.w];
  world.command({ type: 'bulldoze', tiles: turn });
  world.command({ type: 'build', kind: 'portRoad', tiles: turn });
  const depot = m.idx(start, r - 3);
  world.command({ type: 'bulldoze', tiles: [depot] });
  world.command({ type: 'build', kind: 'depot', tiles: [depot], facing: 1 });
  const office = m.build.findIndex((_, i) => !placementError(m, 'office', i));
  world.command({ type: 'build', kind: 'office', tiles: [office] });
  world.command({ type: 'buyMachine', kind: 'stacker', tile: depot });
  return crane;
}

/** The terminal with a tug, a feeder a day and container trucks calling. */
function feederPort(): World {
  const world = World.create(7, 96);
  world.tier = 2;
  world.cash = 1_000_000;
  const crane = terminal(world);
  const m = world.map;
  let berth = -1;
  const far = (i: number) => Math.abs(m.xOf(i) - m.xOf(crane)) + Math.abs(m.yOf(i) - m.yOf(crane));
  for (let i = 0; i < m.build.length; i++) {
    if (placementError(m, 'tugBerth', i)) continue;
    if (berth < 0 || far(i) > far(berth)) berth = i;
  }
  world.command({ type: 'build', kind: 'tugBerth', tiles: [berth] });
  world.command({ type: 'buyTug', tile: berth });
  world['addContract'](
    {
      kind: 'fishery',
      vessel: 'feeder',
      name: 'Test Feeders',
      color: 0,
      boatEvery: 1,
      cratesMin: 6,
      cratesMax: 6,
      fee: 150,
    },
    world.tick + 10,
    0,
  );
  world['addContract'](
    {
      kind: 'haulier',
      name: 'Test Box Haul',
      color: 0,
      fleet: 2,
      capacity: B.CONTAINER_TRUCK_CAPACITY,
      dailyFee: 0,
      cargo: 'container',
    },
    0,
    0,
  );
  return world;
}

/** The same with a yard gantry, and a terminal tractor in place of the stacker. */
function tractorPort(): World {
  const world = feederPort();
  const yard = [...world.yards.values()][0];
  const spot: number = world['storeSpots'](yard)[0];
  world.command({ type: 'build', kind: 'yardGantry', tiles: [spot] });
  for (let k = world.people.length - 1; k >= 0; k--) {
    if (world.people[k].kind === 'stacker') world.people.splice(k, 1);
  }
  const depot = world.map.build.findIndex((b) => b === Build.Depot);
  world.command({ type: 'buyMachine', kind: 'tractor', tile: depot });
  return world;
}

interface Seen {
  /** How far from where it lay, or went, a container showed as it changed hands. */
  takes: number[];
  sets: number[];
  /** How far off square to its slot there, as the sine of the angle. */
  skew: number[];
  /** Still showing where it was taken from, or not yet where it was set down. */
  missed: number;
  /** Set down on a truck. */
  onTrucks: number;
  /**
   * Lifted off a tractor by a yard gantry: how far its spreader was from
   * the container, how far off square, and how often it showed on both
   * or on neither.
   */
  lifts: number[];
  liftSkew: number[];
  doubled: number;
  dropped: number;
  /** Snapshots with a crane lifting a container onto a tractor. */
  craneLifts: number;
  /** How far the yard gantry's carriage ran along its rails each frame. */
  runs: number[];
}

/**
 * Run the game on with the view worked as the renderer does, a few frames
 * between snapshots, and watch each container a reach stacker or tractor
 * takes or sets down: where it shows on the machine as it changes hands,
 * against where it lay or went.
 */
function watch(world: World, kind: 'stacker' | 'tractor', days: number, speed: number): Seen {
  const m = world.map;
  const structures = new Structures(m, true);
  const entities = new Entities(m);
  structures.truckSlot = (id, k, out) => entities.slotPosition(id, k, out);
  structures.slotShown = (id, k) => entities.slotShown(id, k);
  entities.containerAt = (at, out) => structures.containerAt(at, out);
  structures.setSpeed(speed);
  const seen: Seen = {
    takes: [],
    sets: [],
    skew: [],
    missed: 0,
    onTrucks: 0,
    lifts: [],
    liftSkew: [],
    doubled: 0,
    dropped: 0,
    craneLifts: 0,
    runs: [],
  };
  const slotOf = (at: NonNullable<EntityView['handAt']>, out: Vector3): number | null =>
    entities['handSlot'](at, out);
  // Where the container it is about to take lies, and its own as last shown.
  const source = new Map<number, { at: Vector3; heading: number }>();
  const last = new Map<number, { at: Vector3; heading: number; view: EntityView }>();
  const shown = new Map<number, boolean>();
  const wasUnder = new Map<number, boolean>();
  const shownAt = new Map<number, { at: Vector3; heading: number }>();
  const yard = [...world.yards.values()][0];
  const gantry = [...structures['yardGantries'].values()][0];
  let now = 0;
  for (let k = 0; k < (TICKS_PER_DAY * days) / speed; k++) {
    for (let j = 0; j < speed; j++) world.step();
    const s = world.snapshot();
    entities.push(s.entities, now, s.tick);
    structures.setYards(s.yards);
    structures.setCranes(s.cranes);
    for (const cv of s.cranes)
      if (cv.workTruck !== undefined && cv.working !== 'take') seen.craneLifts++;
    for (let frame = 0; frame < 4; frame++) {
      entities.update(now, now / 1000);
      const x = gantry?.carriage.position.x ?? 0;
      structures.update(0.025, now / 1000);
      if (gantry) seen.runs.push(Math.abs(gantry.carriage.position.x - x));
      for (const v of s.entities) {
        if (v.kind !== kind) continue;
        const crate = entities['entries'].get(v.id)!.model.crates[0];
        const at = crate.getWorldPosition(new Vector3());
        const heading = headingOf(crate);
        const was = last.get(v.id);
        const where = was?.view.handAt;
        if (frame === 0 && was && v.load > was.view.load) {
          const from = source.get(v.id);
          if (from) {
            seen.takes.push(at.distanceTo(from.at));
            seen.skew.push(Math.abs(Math.sin(heading - from.heading)));
          }
          if (where?.crane !== undefined || (where?.yard !== undefined && !where.along)) {
            if (structures.containerAt(where, new Vector3()) !== null) seen.missed++;
          }
        } else if (frame === 0 && was && v.load < was.view.load && where?.along === undefined) {
          const to = new Vector3();
          const look = was.view.looks?.[0];
          const h = !where
            ? null
            : where.truck !== undefined
              ? slotOf(where, to)
              : structures.containerAt({ ...where, look }, to);
          if (h === null) seen.missed++;
          else {
            seen.sets.push(was.at.distanceTo(to));
            seen.skew.push(Math.abs(Math.sin(was.heading - h)));
          }
          if (where?.truck !== undefined) {
            seen.onTrucks++;
            if (!entities.slotShown(where.truck, where.slot ?? 0)) seen.missed++;
          }
        }
        if (frame === 3) {
          const h = new Vector3();
          const pick = v.handStage === 'pick' && v.handAt && !v.handAt.along;
          const heading = pick ? slotOf(v.handAt!, h) : null;
          if (heading !== null) source.set(v.id, { at: h, heading });
          else source.delete(v.id);
        }
        if (frame === 0 || v.load === was?.view.load) last.set(v.id, { at, heading, view: v });
        if (kind !== 'tractor') continue;
        // Under the yard gantry: off the trailer onto its spreader in the
        // same frame, square, with the spreader on it.
        const p = world.people.find((q) => q.id === v.id)!;
        // Lifted off, it goes on its way at once: under it, or just now.
        const now =
          (p.state === 'dropping' && p.bayIdx === yard.idx) ||
          (p.state === 'picking' && p.stockIdx === yard.idx);
        const under = now || !!wasUnder.get(v.id);
        if (frame === 3) wasUnder.set(v.id, now);
        const onTrailer = crate.visible;
        const onSpreader = gantry.load.visible;
        if (under && onTrailer && onSpreader) seen.doubled++;
        if (under && shown.get(v.id) && !onTrailer) {
          if (!onSpreader) seen.dropped++;
          // Against where it last showed on the trailer: the tractor may
          // already be pulling away.
          const was = shownAt.get(v.id) ?? { at, heading };
          seen.lifts.push(was.at.distanceTo(gantry.load.getWorldPosition(new Vector3())));
          seen.liftSkew.push(Math.abs(Math.sin(was.heading - headingOf(gantry.load))));
        }
        shown.set(v.id, onTrailer);
        if (onTrailer) shownAt.set(v.id, { at: at.clone(), heading });
      }
      now += 25;
    }
  }
  return seen;
}

const most = (n: number[]) => Math.max(0, ...n);

describe('Handing containers over', () => {
  it('has a reach stacker take each container where it lies and set it down where it shows', () => {
    const seen = watch(feederPort(), 'stacker', 6, 1);
    // Off the crane's stack, into the yard, and onto the trucks.
    expect(seen.takes.length).toBeGreaterThan(10);
    expect(seen.sets.length).toBeGreaterThan(10);
    expect(seen.onTrucks).toBeGreaterThan(0);
    expect(most(seen.takes)).toBeLessThan(0.01);
    expect(most(seen.sets)).toBeLessThan(0.01);
    expect(most(seen.skew)).toBeLessThan(0.01);
    expect(seen.missed).toBe(0);
  }, 30_000);

  it('has a yard gantry lift a container off a tractor along its lane, never on both or neither', () => {
    for (const speed of [1, 4]) {
      const seen = watch(tractorPort(), 'tractor', 4, speed);
      expect(seen.lifts.length).toBeGreaterThan(3);
      expect(seen.dropped).toBe(0);
      expect(seen.doubled).toBe(0);
      if (speed === 1) {
        expect(most(seen.lifts)).toBeLessThan(0.05);
        expect(most(seen.liftSkew)).toBeLessThan(0.01);
      }
      // It runs along its rails at its own pace, never dashing: a frame is
      // a quarter of a tick, and smoothstep runs half as fast again at its
      // quickest, and a lift's run is rounded to whole ticks.
      const quickest = 0.25 * speed * B.YARD_GANTRY_SPEED * 1.5 * 1.5;
      expect(seen.runs.some((d) => d > 0)).toBe(true);
      expect(most(seen.runs)).toBeLessThan(quickest);
      // At the crane it waits beside it, for the crane to lift one onto it.
      expect(seen.craneLifts).toBeGreaterThan(3);
    }
  }, 30_000);
});

describe('A yard gantry as drawn', () => {
  /** The drawn gantry of a port with one, its yard's view, and a way to run frames. */
  function drawn() {
    const world = tractorPort();
    const m = world.map;
    const structures = new Structures(m, true);
    const entities = new Entities(m);
    structures.truckSlot = (id, k, out) => entities.slotPosition(id, k, out);
    structures.slotShown = (id, k) => entities.slotShown(id, k);
    structures.setSpeed(1);
    const s = world.snapshot();
    structures.setYards(s.yards);
    const gantry = [...structures['yardGantries'].values()][0];
    const view = s.yards[0];
    const frames = (n: number) => {
      const steps: number[] = [];
      for (let k = 0; k < n; k++) {
        const x = gantry.carriage.position.x;
        structures.update(0.025, k / 40);
        steps.push(Math.abs(gantry.carriage.position.x - x));
      }
      return steps;
    };
    return { structures, gantry, view, frames };
  }

  it('holds at the end of a lift until the game starts the next, never wrapping round into it', () => {
    const { structures, gantry, view, frames } = drawn();
    const lift = {
      ...view,
      working: 'unload' as const,
      workLook: 3,
      workAt: 0,
      workPhase: 0.9,
      workLegs: [0, 0.5, 0, 0.5],
      workTicks: 15,
      workStart: 100,
    };
    structures.setYards([lift]);
    let low = 1;
    for (let k = 0; k < 40; k++) {
      frames(1);
      low = Math.min(low, gantry.phase);
      expect(gantry.phase).toBeLessThanOrEqual(1);
    }
    expect(gantry.phase).toBe(1);
    expect(low).toBeGreaterThan(0.85);
  });

  it('runs along its rails for a new lift from where it stands, even for a container that looks the same', () => {
    const { structures, gantry, view, frames } = drawn();
    gantry.carriage.position.x = 2;
    // A lift with a long run along the rails to its container, then the lane.
    const lift = (start: number, phase: number) => ({
      ...view,
      working: 'load' as const,
      workLook: 7,
      workAt: -2,
      workPhase: phase,
      workLegs: [0.6, 0.2, 0, 0.2],
      workTicks: 60,
      workStart: start,
    });
    structures.setYards([lift(100, 0)]);
    const first = frames(4);
    // Done, and the next begun just as it was, the same look: it starts again from where it is.
    structures.setYards([lift(100, 1)]);
    frames(4);
    const was = gantry.carriage.position.x;
    structures.setYards([lift(200, 0.02)]);
    expect(gantry.startX).toBeCloseTo(was, 5);
    const next = frames(4);
    expect(Math.max(...first, ...next)).toBeLessThan(0.3);
  });
});
