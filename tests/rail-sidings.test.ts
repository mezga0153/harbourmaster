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
import { GUIDES, checkStep } from '../src/ui/guides';
import { cellPoint, wagonCells } from '../src/sim/systems/cargo/wagons';
import { trackWagons, isLoading, loadingTrack, longestTrack } from '../src/sim/rules';
import { railGantries } from '../src/sim/systems/railGantry';
import { RAILS } from '../src/sim/orient';
import { previewBuild } from '../src/preview/build';

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
    // Loading track along it, the locomotive's room past it.
    world.command({ type: 'build', kind: 'loadingTrack', tiles: row(y, 1, 7) });
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

  it('wait for loading track that holds them, and never stand off it', () => {
    const { world, m, siding } = railPort(0);
    expect(trackWagons(m, siding)).toBe(5);
    const terms: RailTerms = {
      kind: 'rail',
      name: 'Long Rail',
      color: 0,
      trainEvery: 5,
      bring: 12,
      take: 12,
      fee: 180,
      dailyFee: 0,
      wagons: 6,
    };
    // Too long for any loading track: it cannot be signed.
    expect(offerBlocked(world, terms)).toMatch(
      /6 wagons long, and the longest loading track holds 5/,
    );
    expect(offerBlocked(world, { ...terms, wagons: 5 })).toBeNull();
    // Signed anyway (as an older line might be), its trains wait.
    addContract(world, terms, world.tick, 0);
    for (let t = 0; t < 100; t++) world.step();
    expect(portTrains(world)).toHaveLength(0);
    expect(world.snapshot().sidings[0].why).toMatch(/6 wagons long/);
    // Laid longer, it comes, every wagon on the loading track.
    const past = m.xOf(siding.tiles[8]);
    const row = m.yOf(siding.switch);
    world.command({
      type: 'build',
      kind: 'siding',
      tiles: [m.idx(past + 1, row), m.idx(past + 2, row)],
    });
    world.command({
      type: 'build',
      kind: 'loadingTrack',
      tiles: [siding.tiles[7], siding.tiles[8]],
    });
    expect(longestTrack(m)).toBe(6);
    let train: Any;
    for (let t = 0; t < TICKS_PER_DAY && train?.port.state !== 'standing'; t++) {
      world.step();
      train ??= portTrains(world)[0];
    }
    expect(train.port.state).toBe('standing');
    expect(train.cars.filter((c: string) => c === 'flat')).toHaveLength(6);
    for (let k = 0; k < wagonCells(train).length; k++) {
      const p = cellPoint(train, k);
      expect(isLoading(m, m.idx(Math.floor(p.x), Math.floor(p.y))), `cell ${k}`).toBe(true);
    }
    // The locomotive on the plain track past it.
    const front = pointAt(train.way, train.at - CAR_LENGTH / 2);
    expect(isLoading(m, m.idx(Math.floor(front.x), Math.floor(front.y)))).toBe(false);
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

describe('Loading track', () => {
  it('is laid along a siding in one stretch, comes up from its ends, and takes a rail gantry', () => {
    const world = stationTown();
    const m = world.map;
    const y = freeRow(world, 10);
    const tiles = rowOut(world, y, 10);
    expect(placementError(m, 'loadingTrack', tiles[2])).toMatch(/lay the siding first/);
    world.command({ type: 'build', kind: 'siding', tiles });
    const s = sidingAt(m, tiles[0])!;
    expect(trackWagons(m, s)).toBe(0);
    // The preview says how long a train it would take, and where its yards go.
    const r = previewBuild(m, null, 'loadingTrack', tiles.slice(3, 6), tiles[3]);
    expect(r.preview?.note).toMatch(
      /Takes trains of 2 wagons, 4 containers; the locomotive stands on the plain track past it/,
    );
    expect(r.hints.find((h) => h.kind === 'reach')?.tiles).toHaveLength(12);
    world.command({ type: 'build', kind: 'loadingTrack', tiles: tiles.slice(3, 6) });
    expect(loadingTrack(m, s)).toEqual(tiles.slice(3, 6));
    // Not a second stretch.
    expect(placementError(m, 'loadingTrack', tiles[8])).toMatch(/one stretch/);
    expect(placementError(m, 'loadingTrack', tiles[6])).toBeNull();
    // Dragged on in a line, in any order.
    world.command({
      type: 'build',
      kind: 'loadingTrack',
      tiles: [tiles[7], tiles[6], tiles[2], tiles[1]],
    });
    expect(loadingTrack(m, sidingAt(m, tiles[0])!)).toEqual(tiles.slice(1, 8));
    // Seven tiles of it, the locomotive on the plain track past it: five wagons.
    expect(trackWagons(m, sidingAt(m, tiles[0])!)).toBe(5);
    // A rail gantry on it, never a yard gantry on the track.
    expect(placementError(m, 'railGantry', tiles[8])).toMatch(/loading track/);
    expect(placementError(m, 'yardGantry', tiles[4])).toMatch(/rail gantry/);
    world.command({ type: 'build', kind: 'railGantry', tiles: [tiles[4]] });
    expect(m.build[tiles[4]]).toBe(Build.RailGantry);
    expect(railGantries(world).map((g) => g.idx)).toEqual([tiles[4]]);
    expect(loadingTrack(m, sidingAt(m, tiles[0])!)).toHaveLength(7);
    // Taken up from either end of it, leaving the siding.
    expect(bulldozeError(m, tiles[3])).toMatch(/either end/);
    world.command({ type: 'bulldoze', tiles: [tiles[7]] });
    expect(m.build[tiles[7]]).toBe(Build.Siding);
    world.command({ type: 'bulldoze', tiles: [tiles[4]] });
    expect(m.build[tiles[4]]).toBe(Build.LoadingTrack);
    expect(railGantries(world)).toHaveLength(0);
  });
});

describe('A rail gantry over loading track', () => {
  /** Ten tiles of siding with eight of loading track, and yards in and out either side of it. */
  function terminal(gantryAt: number[]) {
    const world: Any = stationTown();
    const m = world.map;
    const x = railColumn(m);
    const row = (y: number, a: number, b: number) =>
      Array.from({ length: b - a + 1 }, (_, k) => m.idx(x + a + k, y));
    let y = -1;
    for (let r = 6; r < m.limit - 6 && y < 0; r++) {
      const all = [...row(r, 1, 10), ...row(r + 1, 1, 10), ...row(r - 1, 1, 10)];
      if (all.every((i) => m.isLand(i) && m.build[i] === Build.None && m.owns(i))) y = r;
    }
    world.command({
      type: 'bulldoze',
      tiles: [...row(y, 1, 10), ...row(y + 1, 1, 10), ...row(y - 1, 1, 10)],
    });
    world.command({ type: 'build', kind: 'siding', tiles: row(y, 1, 10) });
    world.command({ type: 'build', kind: 'loadingTrack', tiles: row(y, 1, 8) });
    world.command({
      type: 'build',
      kind: 'portRoad',
      tiles: [...row(y + 1, 1, 8), ...row(y - 1, 1, 8)],
    });
    world.command({ type: 'store', tiles: row(y + 1, 1, 8), kind: 'boxes', on: true });
    world.command({ type: 'store', tiles: row(y - 1, 1, 8), kind: 'boxesOut', on: true });
    world.command({
      type: 'build',
      kind: 'railGantry',
      tiles: gantryAt.map((k) => m.idx(x + k, y)),
    });
    const yardIn = world.yards.get(row(y + 1, 1, 8)[0]);
    const yardOut = world.yards.get(row(y - 1, 1, 8)[0]);
    for (let k = 0; k < 8; k++)
      putBox(world, yardIn, { fee: 200, at: 0, ready: 0, look: k }, false);
    return { world, m, yardIn, yardOut, x, y };
  }

  function sendLine(world: Any) {
    return addContract(
      world,
      {
        kind: 'rail',
        name: 'T',
        color: 0,
        trainEvery: 9,
        bring: 4,
        take: 8,
        fee: 150,
        dailyFee: 0,
        wagons: 4,
      },
      world.tick,
      0,
    );
  }

  it('works the train on its own, both yards under it, no stacker needed', () => {
    const { world, m, yardIn, yardOut, x, y } = terminal([4]);
    expect(world.snapshot().sidings[0].why).toBeUndefined();
    const line = sendLine(world);
    let train: Any;
    let lifts = 0;
    let was: Any;
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) {
      world.step();
      train ??= world.rail.trains.find((o: Any) => o.port?.contractId === line.id);
      const lift = railGantries(world)[0].lift;
      if (lift && lift !== was) lifts++;
      was = lift;
      if (train?.port.state === 'out') break;
    }
    expect(train?.port.state).toBe('out');
    expect(world.people.some((p: Any) => p.kind === 'stacker')).toBe(false);
    // Off, then on: four out, eight in.
    expect(lifts).toBe(12);
    expect(boxesIn(yardOut, true)).toHaveLength(4);
    expect(boxesIn(yardIn)).toHaveLength(0);
    expect(train.port.leaves - train.port.stand).toBeLessThan(world.tick);
    // The railway lesson's checks pass, the last as the train left with containers.
    for (let t = 0; t < 400 && world.rail.trains.includes(train); t++) world.step();
    const snap = world.snapshot();
    for (const step of GUIDES.railway.steps) {
      expect(checkStep(step, snap)?.done, step.title).toBe(true);
    }
    expect(snap.railGantries).toHaveLength(1);
    void m;
    void x;
    void y;
  });

  it('shares the track with another, each working its own part of the train', () => {
    const { world, yardIn, yardOut } = terminal([2, 7]);
    const line = sendLine(world);
    let train: Any;
    const worked = new Set<number>();
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) {
      world.step();
      train ??= world.rail.trains.find((o: Any) => o.port?.contractId === line.id);
      for (const g of railGantries(world)) if (g.lift) worked.add(g.idx);
      // Never in each other's way.
      const [a, b] = railGantries(world).map((g) => g.at.x);
      expect(b - a).toBeGreaterThan(0.9);
      if (train?.port.state === 'out') break;
    }
    expect(worked.size).toBe(2);
    expect(boxesIn(yardOut, true)).toHaveLength(4);
    expect(boxesIn(yardIn)).toHaveLength(0);
  });

  it('comes in place of a yard gantry over a siding from an older save', () => {
    const { world, m, x, y } = terminal([]);
    // As an older save had it: plain siding, a yard gantry on the track, a line with no length.
    for (const t of loadingTrack(m, sidingAt(m, m.idx(x + 1, y))!)) m.build[t] = Build.Siding;
    m.build[m.idx(x + 4, y)] = Build.YardGantry;
    m.orient[m.idx(x + 4, y)] = RAILS;
    (sendLine(world).terms as RailTerms).wagons = undefined;
    const save = world.toSave();
    delete save.rail!.gantries;
    const loaded = World.fromSave(save);
    const s = sidingAt(loaded.map, m.idx(x + 1, y))!;
    expect(loadingTrack(loaded.map, s)).toHaveLength(8);
    expect(loaded.map.build[m.idx(x + 4, y)]).toBe(Build.RailGantry);
    expect(railGantries(loaded).map((g) => g.idx)).toEqual([m.idx(x + 4, y)]);
    const terms = loaded.contracts.find((c) => c.terms.kind === 'rail')!.terms as RailTerms;
    expect(terms.wagons).toBe(4);
  });
});
