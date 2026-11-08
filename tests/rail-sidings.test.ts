import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { LANDMARKS } from '../src/sim/town';
import {
  CAR_LENGTH,
  crossingClosed,
  moving,
  pointAt,
  railColumn,
  railFromSave,
} from '../src/sim/railway';
import { bulldozeError, placementError, sidingAt, sidings } from '../src/sim/rules';
import { portTrains, sendPortTrain, sidingCars } from '../src/sim/systems/trains';

/** A Container Port whose town has its railway station, rich enough to build. */
function stationTown(): World {
  const world = World.create(7, 96);
  world.tier = 2;
  world.cash = 100_000;
  world.town!.landmarks = LANDMARKS.length;
  return world;
}

/** The tiles of a row from beside the main line out, `n` long, on side `side`. */
function rowOut(world: World, y: number, n: number, side: 1 | -1 = 1): number[] {
  const x = railColumn(world.map);
  return Array.from({ length: n }, (_, k) => world.map.idx(x + side * (k + 1), y));
}

/** A row where a siding of `n` tiles east of the line fits on owned open land. */
function freeRow(world: World, n: number): number {
  const m = world.map;
  for (let y = 4; y < m.limit - 4; y++) {
    const tiles = rowOut(world, y, n);
    const pending = new Set<number>();
    if (tiles.every((i) => (placementError(m, 'siding', i, pending) ? false : !!pending.add(i))))
      return y;
  }
  throw new Error('no room for a siding');
}

describe('Rail sidings', () => {
  it('wait for the town’s railway station', () => {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 100_000;
    const y = freeRow(world, 4);
    world.command({ type: 'build', kind: 'siding', tiles: rowOut(world, y, 4) });
    expect(world.map.build.includes(Build.Siding)).toBe(false);
    expect(world.snapshot().progress.sidingsWhy).toMatch(/railway station/);
    world.town!.landmarks = LANDMARKS.length;
    expect(world.snapshot().progress.sidingsWhy).toBeUndefined();
    world.command({ type: 'build', kind: 'siding', tiles: rowOut(world, y, 4) });
    expect(sidings(world.map)).toHaveLength(1);
  });

  it('run straight out from the main line, switches apart, and come up from the buffer stop', () => {
    const world = stationTown();
    const m = world.map;
    const y = freeRow(world, 6);
    const tiles = rowOut(world, y, 6);
    // Not off on its own, away from the line.
    expect(placementError(m, 'siding', tiles[2])).toMatch(/straight out/);
    // Dragged from the far end in, it still goes down.
    world.command({ type: 'build', kind: 'siding', tiles: [...tiles].reverse() });
    const s = sidingAt(m, tiles[3])!;
    expect(s.tiles).toEqual(tiles);
    expect(s.switch).toBe(m.idx(railColumn(m), y));
    // No turning off the row.
    expect(placementError(m, 'siding', m.idx(m.xOf(tiles[5]), y + 1))).not.toBeNull();
    // Another switch too near.
    expect(placementError(m, 'siding', rowOut(world, y + 2, 1)[0])).toMatch(/Switches/);
    expect(placementError(m, 'siding', rowOut(world, y + 1, 1, -1)[0])).not.toBeNull();
    // Taken up from the end back.
    expect(bulldozeError(m, tiles[2])).toMatch(/buffer stop/);
    expect(bulldozeError(m, tiles[5])).toBeNull();
    world.command({ type: 'bulldoze', tiles });
    expect(m.build.includes(Build.Siding)).toBe(false);
  });

  it('take a port train in, stand it clear of the main line, and send it on, one train moving at a time', () => {
    const world = stationTown();
    const m = world.map;
    const y = freeRow(world, 9);
    world.command({ type: 'build', kind: 'siding', tiles: rowOut(world, y, 9) });
    const s = sidings(m)[0];
    const train = sendPortTrain(world, s, 'flat', 120)!;
    expect(train.cars.length).toBe(sidingCars(s));
    // One at a siding at a time.
    expect(sendPortTrain(world, s)).toBeNull();
    const rail = railColumn(m) + 0.5;
    const seen = new Set<string>();
    let stood = false;
    for (let t = 0; t < TICKS_PER_DAY * 2 && world.rail.trains.includes(train); t++) {
      world.step();
      expect(world.rail.trains.filter(moving).length).toBeLessThanOrEqual(1);
      const state = train.port!.state;
      seen.add(state);
      if (state === 'standing' && !stood) {
        stood = true;
        // Every car beside the line, off the main line's track.
        for (let k = 0; k < train.cars.length; k++) {
          const rear = pointAt(train.way, train.at - (k + 1) * CAR_LENGTH);
          expect(rear.x - rail).toBeGreaterThan(0.45);
          expect(Math.abs(rear.y - (y + 0.5))).toBeLessThan(0.6);
        }
        // It holds no line: a train may pass along it while it stands.
        world.rail.nextTrain = world.tick;
        world.step();
        expect(world.rail.trains.some((o) => !o.port)).toBe(true);
        // Nor can the siding be taken up under it.
        world.command({ type: 'bulldoze', tiles: [s.tiles.at(-1)!] });
        expect(m.build[s.tiles.at(-1)!]).toBe(Build.Siding);
      }
    }
    expect([...seen]).toEqual(expect.arrayContaining(['in', 'standing', 'out', 'away']));
    expect(world.rail.trains.includes(train)).toBe(false);
  });

  it('bring the barriers down for a port train crossing the road on its way', () => {
    const world = stationTown();
    const m = world.map;
    const ey = m.yOf(m.entry);
    const y = freeRow(world, 6);
    world.command({ type: 'build', kind: 'siding', tiles: rowOut(world, y, 6) });
    // In from the far side of the road's crossing.
    const dir = y > ey ? 1 : -1;
    const train = sendPortTrain(world, sidings(m)[0], 'flat', 60, dir)!;
    let closed = false;
    for (let t = 0; t < 400 && train.port!.state !== 'standing'; t++) {
      world.step();
      closed ||= crossingClosed(world.rail.trains, railColumn(m), ey);
    }
    expect(closed).toBe(true);
  });

  it('carry on from an older save’s railway of one train', () => {
    const rail = railFromSave({ train: { head: 3, dir: 1 }, nextTrain: 50 } as never);
    expect(rail).toEqual({ trains: [], nextTrain: 50, nextId: 1 });
    const world = stationTown();
    const save = world.toSave();
    const loaded = World.fromSave({ ...save, rail: { train: null, nextTrain: 9 } as never });
    expect(loaded.rail.trains).toEqual([]);
    for (let t = 0; t < 20; t++) loaded.step();
    expect(portTrains(loaded)).toEqual([]);
  });
});
