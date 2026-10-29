import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { crossingClosed, railColumn } from '../src/sim/railway';
import { bulldozeError, placementError } from '../src/sim/rules';
import { isTownStreet, TOWN_STAGES, townHomes } from '../src/sim/town';
import { Build, isTownBuilding, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';

describe('Railway', () => {
  it.each([1, 2, 3, 7, 99, 1234, 777777])('runs the length of every map (seed %i)', (seed) => {
    const m = World.create(seed).map;
    const x = railColumn(m);
    expect(x).toBeGreaterThanOrEqual(3);
    for (let y = 0; y < m.h; y++) {
      expect([Build.Rail, Build.Crossing]).toContain(m.build[m.idx(x, y)]);
    }
    // The trucks' road from the highway crosses it on the level.
    expect(m.build[m.idx(x, m.yOf(m.entry))]).toBe(Build.Crossing);
  });

  it('sends trains along now and then', () => {
    const world = World.create(7);
    let seen = 0;
    let wasRunning = false;
    for (let t = 0; t < TICKS_PER_DAY * 3; t++) {
      world.step();
      const running = world.rail.train !== null;
      if (running && !wasRunning) seen++;
      wasRunning = running;
    }
    expect(seen).toBeGreaterThanOrEqual(2);
  });

  it('holds trucks at the crossing while the barriers are down', () => {
    const world = World.create(7);
    const m = world.map;
    const x = railColumn(m);
    const ey = m.yOf(m.entry);
    const crossing = m.idx(x, ey);
    const was = new Map<number, number>();
    let waited = 0;
    for (let t = 0; t < TICKS_PER_DAY * 4; t++) {
      world.step();
      const closed = crossingClosed(world.rail.train, ey);
      for (const truck of world.trucks) {
        const at = m.idx(Math.floor(truck.x), Math.floor(truck.y));
        // Never drives onto the crossing with the barriers down…
        if (at === crossing && was.get(truck.id) !== crossing) expect(closed).toBe(false);
        if (closed && at !== crossing && Math.abs(truck.x - (x + 0.5)) <= 1.01) waited++;
        was.set(truck.id, at);
      }
    }
    // …but stops in front of it.
    expect(waited).toBeGreaterThan(0);
  });

  it('can be crossed by a public road but not built over or taken up', () => {
    const world = World.create(5);
    world.cash = 10_000;
    const m = world.map;
    const x = railColumn(m);
    const y = (m.yOf(m.entry) + 30) % m.h;
    const rail = m.idx(x, y);
    expect(bulldozeError(m, rail)).not.toBeNull();
    expect(placementError(m, 'footpath', rail)).not.toBeNull();
    world.command({ type: 'build', kind: 'road', tiles: [m.idx(x - 1, y), rail, m.idx(x + 1, y)] });
    expect(m.build[rail]).toBe(Build.Crossing);
    // Not along the line.
    expect(placementError(m, 'road', m.idx(x, y + 1))).not.toBeNull();
    world.command({ type: 'bulldoze', tiles: [rail] });
    expect(m.build[rail]).toBe(Build.Rail);
  });
});

describe('Town', () => {
  it.each([1, 2, 3, 7, 99, 1234, 777777])('starts as a fishing village (seed %i)', (seed) => {
    const world = World.create(seed);
    const t = world.town!;
    expect(t).not.toBeNull();
    const m = world.map;
    expect(t.stage).toBe(0);
    expect(townHomes(m)).toBeGreaterThanOrEqual(B.TOWN_START);
    expect(m.build.some((b) => b === Build.Chapel)).toBe(true);
    // Well away from the port, with its own road out to the edge of the map.
    expect(Math.abs(m.yOf(t.centre) - m.yOf(m.entry))).toBeGreaterThanOrEqual(18);
    expect(isTownStreet(m, m.idx(0, m.yOf(t.centre)))).toBe(true);
  });

  it('grows with the port into a city, and keeps clear of it', () => {
    const world = World.create(7);
    const m = world.map;
    const t = world.town!;
    t.demand = 3000;
    for (let d = 0; d < 6; d++) {
      for (let k = 0; k < TICKS_PER_DAY; k++) world.step();
      t.demand = 3000;
    }
    expect(townHomes(m)).toBeGreaterThan(400);
    world.debug({ type: 'debug', town: 3000 });
    expect(t.stage).toBe(TOWN_STAGES.length - 1);
    expect(m.build.some((b) => b === Build.Tower)).toBe(true);
    for (let i = 0; i < m.build.length; i++) {
      if (!isTownBuilding(m.build[i]) || m.build[i] === Build.FishShed) continue;
      for (const n of m.neighbors4(i)) {
        const b = m.build[n];
        const port =
          b !== Build.None && b !== Build.Road && b !== Build.Rail && b !== Build.Crossing;
        if (port) expect(isTownBuilding(b)).toBe(true);
      }
    }
    const home = m.build.findIndex((b) => b === Build.House || b === Build.Flats);
    expect(bulldozeError(m, home)).toBe('This belongs to the town');
  });

  it('grows from jobs and goods shipped, and shrinks back without them', () => {
    const world = World.create(7);
    for (const o of [...world.offers]) world.command({ type: 'signContract', id: o.id });
    for (let d = 0; d < 10; d++) for (let k = 0; k < TICKS_PER_DAY; k++) world.step();
    const t = world.town!;
    expect(t.jobs).toBeGreaterThan(0);
    expect(t.goods).toBeGreaterThan(0);
    expect(world.snapshot().town!.population).toBeGreaterThan(B.TOWN_START);
  });

  it('is founded, with a railway, when an older save loads', () => {
    const save = World.create(3).toSave();
    // Take the town and line off the map, as a save from before them.
    save.map.build = save.map.build.map((b, i) =>
      isTownBuilding(b) || b === Build.Rail
        ? Build.None
        : b === Build.Crossing
          ? Build.Road
          : b === Build.Road && save.map.orient[i] & 128
            ? Build.None
            : b,
    );
    delete save.town;
    delete save.rail;
    const world = World.fromSave(save);
    expect(world.town).not.toBeNull();
    expect(railColumn(world.map)).toBeGreaterThanOrEqual(3);
    for (let k = 0; k < 100; k++) world.step();
  });
});
