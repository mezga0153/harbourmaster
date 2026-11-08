import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { growTown, LANDMARKS } from '../src/sim/town';
import {
  CAR_LENGTH,
  crossingClosed,
  moving,
  pointAt,
  railColumn,
  railFromSave,
  STATION_DWELL,
} from '../src/sim/railway';
import {
  bulldozeError,
  placementError,
  portCrossing,
  sidingAt,
  sidings,
  storeError,
} from '../src/sim/rules';
import {
  portTrains,
  sendPortTrain,
  sidingCars,
  stationRow,
  trackHeld,
  trainOver,
} from '../src/sim/systems/trains';
import { addContract, offerBlocked } from '../src/sim/systems/economy';
import { boxesIn, putBox } from '../src/sim/systems/cargo/stores';
import type { RailTerms } from '../src/sim/contracts';
import { gantryOverSiding } from '../src/sim/systems/cargo/wagons';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

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

describe('Container trains', () => {
  /**
   * A siding nine tiles long with a port road along it a row off, and past
   * that a container yard for cargo coming in and one for cargo going out,
   * a depot and a reach stacker; containers cleared by customs in the yard.
   */
  function railPort(boxes = 6) {
    const world: Any = stationTown();
    const m = world.map;
    const x = railColumn(m);
    const row = (y: number, a: number, b: number) =>
      Array.from({ length: b - a + 1 }, (_, k) => m.idx(x + a + k, y));
    let y = -1;
    for (let r = 6; r < m.limit - 6 && y < 0; r++) {
      const all = [...row(r, 1, 9), ...row(r + 1, 1, 10), ...row(r + 2, 1, 10)];
      if (all.every((i) => m.isLand(i) && m.build[i] === Build.None && m.owns(i))) y = r;
    }
    expect(y).toBeGreaterThan(0);
    world.command({
      type: 'bulldoze',
      tiles: [...row(y, 1, 9), ...row(y + 1, 1, 10), ...row(y + 2, 1, 10)],
    });
    world.command({ type: 'build', kind: 'siding', tiles: row(y, 1, 9) });
    world.command({
      type: 'build',
      kind: 'portRoad',
      tiles: [...row(y + 1, 1, 10), ...row(y + 2, 2, 8)],
    });
    const inTiles = row(y + 2, 2, 4);
    const outTiles = row(y + 2, 6, 8);
    world.command({ type: 'store', tiles: inTiles, kind: 'boxes', on: true });
    world.command({ type: 'store', tiles: outTiles, kind: 'boxesOut', on: true });
    const depot = m.idx(x + 10, y + 2);
    // Its door onto the road along the siding.
    world.command({ type: 'build', kind: 'depot', tiles: [depot], facing: 3 });
    // Two, a depot each.
    const depot2 = m.idx(x + 9, y + 2);
    world.command({ type: 'build', kind: 'depot', tiles: [depot2], facing: 3 });
    world.command({ type: 'buyMachine', kind: 'stacker', tile: depot });
    world.command({ type: 'buyMachine', kind: 'stacker', tile: depot2 });
    const yardIn = world.yards.get(inTiles[0]);
    const yardOut = world.yards.get(outTiles[0]);
    expect(sidings(m)).toHaveLength(1);
    expect(yardIn && yardOut).toBeTruthy();
    expect(world.people.filter((p: Any) => p.kind === 'stacker')).toHaveLength(2);
    for (let k = 0; k < boxes; k++)
      putBox(world, yardIn, { fee: 200, at: 0, ready: 0, look: k }, false);
    return { world, m, yardIn, yardOut, siding: sidings(m)[0] };
  }

  it('have their containers unloaded into the yard going out and are loaded from the one coming in, then pay as they leave', () => {
    const { world, yardIn, yardOut } = railPort(6);
    const terms: RailTerms = {
      kind: 'rail',
      name: 'Test Rail',
      color: 0,
      trainEvery: 5,
      bring: 4,
      take: 6,
      fee: 180,
      dailyFee: 0,
    };
    const line = addContract(world, terms, world.tick, 0);
    const before = world.cash;
    let train: Any;
    let worked = false;
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) {
      world.step();
      train ??= world.rail.trains.find((o: Any) => o.port?.contractId === line.id);
      if (train?.port.state === 'out') worked = true;
      if (worked && !world.rail.trains.includes(train)) break;
    }
    expect(train, 'a train came').toBeDefined();
    expect(worked, 'it was worked and left').toBe(true);
    // What it brought waits to go out on a feeder; what it took is gone.
    expect(boxesIn(yardOut, true)).toHaveLength(4);
    expect(boxesIn(yardIn)).toHaveLength(0);
    expect(world.cash - before).toBeGreaterThanOrEqual(6 * 200 * 0.9);
  });

  it('wait for a free siding with a yard beside it', () => {
    const world = stationTown();
    const terms: RailTerms = {
      kind: 'rail',
      name: 'X',
      color: 0,
      trainEvery: 1,
      bring: 2,
      take: 2,
      fee: 100,
      dailyFee: 0,
    };
    expect(offerBlocked(world, terms)).toMatch(/siding/);
    addContract(world, terms, world.tick, 0);
    for (let t = 0; t < 100; t++) world.step();
    expect(portTrains(world)).toHaveLength(0);
  });
});

describe('Level crossings in the port', () => {
  it('lay a port road across a siding, or a siding across a port road, and keep both', () => {
    const world = stationTown();
    const m = world.map;
    const y = freeRow(world, 7);
    const tiles = rowOut(world, y, 7);
    // A port road already across the row.
    world.command({
      type: 'build',
      kind: 'portRoad',
      tiles: [tiles[3], tiles[3] - m.w, tiles[3] + m.w],
    });
    world.command({ type: 'build', kind: 'siding', tiles });
    expect(m.build[tiles[3]]).toBe(Build.PortRoad);
    expect(portCrossing(m, tiles[3])).toBe(true);
    expect(sidingAt(m, tiles[0])!.tiles).toEqual(tiles);
    // And a road laid across the track afterwards.
    world.command({ type: 'build', kind: 'portRoad', tiles: [tiles[5]] });
    expect(portCrossing(m, tiles[5])).toBe(true);
    // No storage or parking on the track.
    expect(storeError(m, tiles[3], 'boxes', true)).toMatch(/siding/);
    // Bulldozed, the road goes and the track stays.
    world.command({ type: 'bulldoze', tiles: [tiles[5]] });
    expect(m.build[tiles[5]]).toBe(Build.Siding);
    expect(sidingAt(m, tiles[0])!.tiles).toEqual(tiles);
  });

  it('are kept clear while a train stands across one, and hold a train coming for whoever is on one', () => {
    const world = stationTown();
    const m = world.map;
    const y = freeRow(world, 9);
    const tiles = rowOut(world, y, 9);
    world.command({ type: 'build', kind: 'siding', tiles });
    // A crossing near the switch, where a long train stands across it.
    const at = tiles[1];
    world.command({ type: 'build', kind: 'portRoad', tiles: [at] });
    const train = sendPortTrain(world, sidings(m)[0], 'flat', 200)!;
    let held = false;
    for (let t = 0; t < TICKS_PER_DAY && train.port!.state !== 'standing'; t++) {
      world.step();
      held ||= trackHeld(world, at);
    }
    expect(held).toBe(true);
    expect(train.port!.state).toBe('standing');
    expect(trainOver(world, at)).toBe(true);
    expect(world.walkCost(at, at - m.w)).toBe(Infinity);
    expect(world.driveCost(at, at - m.w)).toBe(Infinity);
    // Not the yard's ground, which the machines' reach is worked out on.
    expect(world.yardCost(at, at - m.w)).toBe(1);
  });
});

describe('The town’s railway station', () => {
  it('has the passenger trains stop at it, and the freight run straight through', () => {
    const world = stationTown();
    const m = world.map;
    for (let k = 0; k < 40 && !m.build.includes(Build.Station); k++) {
      growTown(world.town!, m, () => {});
    }
    const row = stationRow(world, railColumn(m));
    expect(row).toBeDefined();
    let stopped = 0;
    let freightStopped = 0;
    for (let t = 0; t < TICKS_PER_DAY * 6; t++) {
      if (world.rail.trains.length === 0) world.rail.nextTrain = world.tick;
      world.step();
      for (const tr of world.rail.trains) {
        if (tr.port || tr.speed > 0) continue;
        if (!tr.cars.includes('coach')) freightStopped++;
        else {
          stopped++;
          // Its middle by the platform.
          const mid = pointAt(tr.way, tr.at - (tr.cars.length * CAR_LENGTH) / 2);
          expect(Math.abs(mid.y - (row! + 0.5))).toBeLessThan(0.2);
        }
      }
    }
    expect(stopped).toBeGreaterThan(STATION_DWELL / 2);
    expect(freightStopped).toBe(0);
  });
});

describe('A yard gantry over a siding', () => {
  it('stands on the track beside the yard and works the train in it, no stacker needed', () => {
    const world: Any = stationTown();
    const m = world.map;
    const x = railColumn(m);
    const row = (y: number, a: number, b: number) =>
      Array.from({ length: b - a + 1 }, (_, k) => m.idx(x + a + k, y));
    let y = -1;
    for (let r = 6; r < m.limit - 6 && y < 0; r++) {
      const all = [...row(r, 1, 9), ...row(r + 1, 1, 9), ...row(r - 1, 1, 9)];
      if (all.every((i) => m.isLand(i) && m.build[i] === Build.None && m.owns(i))) y = r;
    }
    world.command({
      type: 'bulldoze',
      tiles: [...row(y, 1, 9), ...row(y + 1, 1, 9), ...row(y - 1, 1, 9)],
    });
    world.command({ type: 'build', kind: 'siding', tiles: row(y, 1, 9) });
    // A yard each side of the track, right beside it, along the wagons:
    // going out by the first wagon, coming in by the next.
    world.command({
      type: 'build',
      kind: 'portRoad',
      tiles: [...row(y + 1, 3, 6), ...row(y - 1, 7, 9)],
    });
    world.command({ type: 'store', tiles: row(y + 1, 3, 6), kind: 'boxes', on: true });
    world.command({ type: 'store', tiles: row(y - 1, 7, 9), kind: 'boxesOut', on: true });
    const yardIn = world.yards.get(row(y + 1, 3, 6)[0]);
    const yardOut = world.yards.get(row(y - 1, 7, 9)[0]);
    const s = sidings(m)[0];
    // A gantry over the track by each, its rails along it.
    const gantries = [m.idx(x + 3, y), m.idx(x + 9, y)];
    world.command({ type: 'build', kind: 'yardGantry', tiles: gantries });
    expect(gantries.map((g) => m.build[g])).toEqual([Build.YardGantry, Build.YardGantry]);
    expect(sidingAt(m, m.idx(x + 1, y))!.tiles).toHaveLength(9);
    expect(gantryOverSiding(world, yardIn, s)).toBe(true);
    expect(gantryOverSiding(world, yardOut, s)).toBe(true);
    const second = [gantries[1]];
    for (let k = 0; k < 6; k++)
      putBox(world, yardIn, { fee: 200, at: 0, ready: 0, look: k }, false);
    const line = addContract(
      world,
      {
        kind: 'rail',
        name: 'T',
        color: 0,
        trainEvery: 9,
        bring: 2,
        take: 3,
        fee: 150,
        dailyFee: 0,
      },
      world.tick,
      0,
    );
    let train: Any;
    let lifted = false;
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) {
      world.step();
      train ??= world.rail.trains.find((o: Any) => o.port?.contractId === line.id);
      lifted ||= (yardIn.gantryOn ?? 0) < 0 || (yardOut.gantryOn ?? 0) < 0;
      if (train?.port.state === 'out') break;
    }
    expect(train?.port.state).toBe('out');
    expect(world.people.some((p: Any) => p.kind === 'stacker')).toBe(false);
    expect(lifted).toBe(true);
    expect(boxesIn(yardOut, true)).toHaveLength(2);
    // The second wagon's two, in its reach; the third it wanted is not.
    expect(boxesIn(yardIn)).toHaveLength(4);
    // Taken up, the track stays.
    world.command({ type: 'bulldoze', tiles: second });
    expect(m.build[second[0]]).toBe(Build.Siding);
  });
});
