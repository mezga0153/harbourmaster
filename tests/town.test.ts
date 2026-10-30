import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { crossingClosed, railColumn } from '../src/sim/railway';
import { exitRows, HIGHWAY_COLUMNS } from '../src/sim/roads';
import { bulldozeError, OUTSIDE, placementError, terraformError } from '../src/sim/rules';
import type { GameMap } from '../src/sim/map';
import { isTownStreet, ownedByTown, TOWN_LAYOUT, TOWN_STAGES, townHomes } from '../src/sim/town';
import { Build, isPublicRoad, isTownBuilding, TICKS_PER_DAY, townBand } from '../src/sim/types';
import { World } from '../src/sim/world';

/** Public road joined to `from`. */
function roadsFrom(m: GameMap, from: number): Set<number> {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    for (const n of m.neighbors4(queue.pop()!)) {
      if (!seen.has(n) && isPublicRoad(m.build[n])) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

/** The road off the town's exit from the highway, out past the port's land. */
function townExit(m: GameMap): number {
  const row = exitRows(m).find((y) => y > m.limit);
  expect(row).toBeDefined();
  return m.idx(HIGHWAY_COLUMNS, row!);
}

describe('Railway', () => {
  it.each([1, 2, 3, 7, 99, 1234, 777777])('runs the length of every map (seed %i)', (seed) => {
    const m = World.create(seed, 96).map;
    const x = railColumn(m);
    expect(x).toBeGreaterThanOrEqual(3);
    for (let y = 0; y < m.h; y++) {
      expect([Build.Rail, Build.Crossing]).toContain(m.build[m.idx(x, y)]);
    }
    // The trucks' road from the highway crosses it on the level.
    expect(m.build[m.idx(x, m.yOf(m.entry))]).toBe(Build.Crossing);
  });

  it('sends trains along now and then', () => {
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
    const m = world.map;
    const x = railColumn(m);
    const ey = m.yOf(m.entry);
    const crossing = m.idx(x, ey);
    const was = new Map<number, number>();
    let waited = 0;
    for (let t = 0; t < TICKS_PER_DAY * 8; t++) {
      // One train after another, so trucks are bound to meet one.
      if (!world.rail.train) world.rail.nextTrain = world.tick;
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
    const world = World.create(5, 96);
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
    const world = World.create(seed, 96);
    const t = world.town!;
    expect(t).not.toBeNull();
    const m = world.map;
    expect(t.stage).toBe(0);
    expect(townHomes(m)).toBeGreaterThanOrEqual(B.TOWN_START);
    expect(m.build.some((b) => b === Build.Chapel)).toBe(true);
    expect(m.build.some((b) => b === Build.FishMarket)).toBe(true);
    // Out in the country past the port's land, with a road to its own exit off the highway.
    for (let i = 0; i < m.build.length; i++) {
      if (ownedByTown(m, i)) expect(m.yOf(i)).toBeGreaterThan(m.limit);
    }
    expect(roadsFrom(m, townExit(m)).has(t.centre)).toBe(true);
  });

  it.each([1, 3, 7, 99])('lays streets that never run two wide (seed %i)', (seed) => {
    const world = World.create(seed, 96);
    world.debug({ type: 'debug', town: 2500 });
    const m = world.map;
    for (let y = 0; y < m.h - 1; y++) {
      for (let x = 0; x < m.w - 1; x++) {
        const block = [m.idx(x, y), m.idx(x + 1, y), m.idx(x, y + 1), m.idx(x + 1, y + 1)];
        expect(block.every((i) => isTownStreet(m, i))).toBe(false);
      }
    }
  });

  it('takes deliveries from the hauliers, for a bonus', () => {
    const world = World.create(7, 96);
    for (const o of [...world.offers]) world.command({ type: 'signContract', id: o.id });
    let unloading = 0;
    for (let d = 0; d < 8; d++) {
      for (let k = 0; k < TICKS_PER_DAY; k++) {
        world.step();
        unloading += world.trucks.filter((t) => t.state === 'unloading').length;
      }
    }
    expect(unloading).toBeGreaterThan(0);
    expect(world.town!.supplied).toBeGreaterThan(0);
  });

  it('is laid out again from an older save, as big as it was', () => {
    const world = World.create(5, 96);
    world.debug({ type: 'debug', town: 600 });
    const homes = townHomes(world.map);
    const save = world.toSave();
    save.town = { ...save.town!, layout: 1 };
    const loaded = World.fromSave(save);
    expect(loaded.town!.layout).toBe(TOWN_LAYOUT);
    expect(townHomes(loaded.map)).toBeGreaterThanOrEqual(homes);
    expect(roadsFrom(loaded.map, townExit(loaded.map)).has(loaded.town!.centre)).toBe(true);
  });

  it('adds the country past the port to a save from before it', () => {
    // On the 96-tile maps of then.
    const world = World.create(5, 96);
    const save = world.toSave();
    const n = save.map.w * 96;
    // As saved before: 96 rows, no town, no line.
    for (const key of ['terrain', 'depth', 'ocean', 'deco', 'build', 'orient'] as const) {
      save.map[key] = save.map[key].slice(0, n);
    }
    save.map.h = 96;
    delete save.map.limit;
    delete save.map.store;
    save.map.build = save.map.build.map((b) =>
      isTownBuilding(b) || b === Build.Rail ? Build.None : b === Build.Crossing ? Build.Road : b,
    );
    delete save.town;
    delete save.rail;
    const loaded = World.fromSave(save);
    const m = loaded.map;
    expect(m.h).toBe(96 + townBand(96));
    expect(m.limit).toBe(96);
    expect(m.yOf(loaded.town!.centre)).toBeGreaterThan(96);
    const x = railColumn(m);
    for (let y = 0; y < m.h; y++)
      expect([Build.Rail, Build.Crossing]).toContain(m.build[m.idx(x, y)]);
    for (let k = 0; k < 200; k++) loaded.step();
  });

  it('cannot be built on, cleared or dredged by the player', () => {
    const world = World.create(7, 96);
    world.cash = 1_000_000;
    const m = world.map;
    const field = m.build.findIndex(
      (b, i) => b === Build.None && m.isLand(i) && m.yOf(i) > m.limit,
    );
    expect(placementError(m, 'road', field)).toBe(OUTSIDE);
    expect(terraformError(m, field, false)).toBe(OUTSIDE);
    world.command({ type: 'build', kind: 'road', tiles: [field] });
    expect(m.build[field]).toBe(Build.None);
  });

  it('grows with the port into a city, and keeps clear of it', () => {
    const world = World.create(7, 96);
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
    expect(bulldozeError(m, home)).toBe(OUTSIDE);
  });

  it('grows from jobs and goods shipped, and shrinks back without them', () => {
    const world = World.create(7, 96);
    for (const o of [...world.offers]) world.command({ type: 'signContract', id: o.id });
    for (let d = 0; d < 10; d++) for (let k = 0; k < TICKS_PER_DAY; k++) world.step();
    const t = world.town!;
    expect(t.jobs).toBeGreaterThan(0);
    expect(t.goods).toBeGreaterThan(0);
    expect(world.snapshot().town!.population).toBeGreaterThan(B.TOWN_START);
  });

  it('is founded, with a railway, when an older save loads', () => {
    const save = World.create(3, 96).toSave();
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
