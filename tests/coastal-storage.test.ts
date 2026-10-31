import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { cargoOf } from '../src/sim/cargo';
import { placementError } from '../src/sim/rules';
import { Build, Terrain, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';

declare const process: { env: Record<string, string | undefined> };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * A Coastal Wharf with a two-wide quay out to deep water for the coasters,
 * forklifts, and crate storage by the public road: `inTiles` tiles of it
 * for cargo coming in (two or four), `outTiles` (one or two) for cargo
 * going out. The cannery, Valley Timber Co. and a line of goods are
 * signed, and a haulier's trucks take the crates away.
 */
function wharf(inTiles: number, outTiles: number): Any {
  const world: Any = World.create(7, 96);
  world.tier = 2;
  world.cash = 1_000_000;
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
    if (!m.isLand(out) && m.depth[out] >= B.COASTER_DRAFT + 0.5) {
      end = x + 3;
      break;
    }
  }
  expect(end).toBeGreaterThan(0);
  for (const row of [r - 1, r - 2]) {
    for (const i of tiles(row, start, end)) {
      world.command({ type: 'build', kind: m.isLand(i) ? 'portRoad' : 'quay', tiles: [i] });
    }
  }
  // Behind a gate off the public road, a yard of port road for the trucks
  // and machines, with crate storage marked out in it: `inTiles` for cargo
  // coming in, two rows of two at most, and `outTiles` for cargo going out,
  // a row of one or two, with road all round each.
  const corner = m.idx(start - 2, r - 2);
  const area = [corner, corner + 1, corner + m.w, corner + m.w + 1];
  world.command({ type: 'bulldoze', tiles: area });
  world.command({ type: 'build', kind: 'portRoad', tiles: area });
  world.command({ type: 'bulldoze', tiles: [corner - 1, corner + m.w - 1] });
  world.command({ type: 'build', kind: 'portGate', tiles: [corner + m.w - 1], facing: 1 });
  world.command({ type: 'build', kind: 'portRoad', tiles: [corner - 1] });
  const round = [corner - 1 - m.w, corner - m.w, corner + 1 - m.w];
  world.command({ type: 'bulldoze', tiles: round });
  world.command({ type: 'build', kind: 'portRoad', tiles: round });
  const plaza: number[] = [];
  for (let y = r - 7; y <= r - 3; y++) plaza.push(...tiles(y, start - 8, start - 3));
  world.command({ type: 'bulldoze', tiles: plaza });
  world.command({ type: 'build', kind: 'portRoad', tiles: plaza });
  const into = [...tiles(r - 6, start - 7, start - 6), ...tiles(r - 5, start - 7, start - 6)].slice(
    0,
    inTiles,
  );
  world.command({ type: 'store', tiles: into, kind: 'crates', on: true });
  const out = tiles(r - 7, start - 4, start - 4 + outTiles - 1);
  world.command({ type: 'store', tiles: out, kind: 'cratesOut', on: true });
  expect(world.bays.get(into[0])?.tiles).toHaveLength(inTiles);
  expect(world.bays.get(out[0])?.tiles).toHaveLength(outTiles);
  const turn = [corner - 2, corner - 2 - m.w];
  world.command({ type: 'bulldoze', tiles: turn });
  world.command({ type: 'build', kind: 'portRoad', tiles: turn });
  const link = m.idx(start, r - 3);
  const depot = link + 1;
  world.command({ type: 'bulldoze', tiles: [link, depot] });
  world.command({ type: 'build', kind: 'portRoad', tiles: [link] });
  world.command({ type: 'forkliftOnly', tiles: [link], on: true });
  world.command({ type: 'build', kind: 'depot', tiles: [depot], facing: 1 });
  const office = m.build.findIndex((_: number, i: number) => !placementError(m, 'office', i));
  world.command({ type: 'build', kind: 'office', tiles: [office] });
  // Two depots of forklifts.
  world.command({ type: 'bulldoze', tiles: [depot + 1] });
  world.command({ type: 'build', kind: 'depot', tiles: [depot + 1], facing: 1 });
  for (let k = 0; k < 6; k++) {
    world.command({ type: 'buyMachine', kind: 'forklift', tile: depot + Math.floor(k / 3) });
  }
  // Shippers' trucks park outside the port: a space marked out on a loop of
  // road beside the public road.
  const free = (x: number, y: number) =>
    m.inBounds(x, y) &&
    m.terrain[m.idx(x, y)] === Terrain.Grass &&
    m.build[m.idx(x, y)] === 0 &&
    m.owns(m.idx(x, y));
  const x = [...Array(m.w).keys()].find(
    (x) =>
      [-1, 0, 1, 2].every((d) => m.build[m.idx(x + d, r)] === Build.Road) &&
      [-1, 0, 1, 2].every((d) => free(x + d, r + 1) && free(x + d, r + 2)),
  )!;
  const lot = [m.idx(x, r + 1), m.idx(x + 1, r + 1)];
  const loop = [-1, 0, 1, 2].map((d) => m.idx(x + d, r + 2));
  loop.push(m.idx(x - 1, r + 1), m.idx(x + 2, r + 1));
  world.command({ type: 'build', kind: 'road', tiles: [...loop, ...lot] });
  world.command({ type: 'build', kind: 'parking', tiles: lot });
  // Hands enough for the coasters.
  const home = world.people.find((p: Any) => p.kind === 'dockhand');
  for (let k = 0; k < 4; k++) {
    world.spawnDockhand(m.idx(Math.floor(home.x), Math.floor(home.y)), {
      id: 0,
      name: `Extra ${k}`,
      skill: 3,
      trait: null,
      wage: 0,
    });
  }
  world.tier = 1;
  // Only the town's trade, and the haulier to take it away.
  for (const c of world.contracts) c.nextBoatTick = Infinity;
  world.boats.length = 0;
  const add = world.addContract.bind(world);
  for (const [cargo, min, max] of [
    ['timber', 16, 21],
    ['goods', 17, 22],
  ] as const) {
    add(
      {
        kind: 'fishery',
        vessel: 'coaster',
        name: `Test ${cargo}`,
        color: 0,
        boatEvery: 1.2,
        cratesMin: min,
        cratesMax: max,
        fee: 25,
        catch: cargo,
      },
      world.tick + (cargo === 'timber' ? 30 : 330),
      0,
    );
  }
  add(
    {
      kind: 'shipper',
      name: 'Test Cannery',
      color: 0,
      perDay: 10,
      capacity: B.TRUCK_CAPACITY,
      fee: 16,
      goods: 'canned',
    },
    world.tick + 10,
    0,
  );
  add(
    {
      kind: 'haulier',
      name: 'Test Haul',
      color: 0,
      fleet: 6,
      capacity: B.TRUCK_CAPACITY,
      dailyFee: 0,
    },
    0,
    0,
  );
  return world;
}

/** Run a port on `days`, counting what goes through it and where it sticks. */
function run(world: Any, days: number) {
  const tally = {
    timber: 0,
    goods: 0,
    canned: 0,
    full: 0,
    leftOnBoard: 0,
    brought: 0,
    anchored: 0,
  };
  const brought = new Set<number>();
  const leave = world.truckLeave.bind(world);
  world.truckLeave = (t: Any) => {
    if (t.state !== 'leaving' && t.state !== 'away') {
      for (const f of t.fees ?? []) {
        const c = cargoOf(f);
        if (c === 'timber' || c === 'goods') tally[c]++;
      }
    }
    return leave(t);
  };
  const shipOut = world.shipOut.bind(world);
  world.shipOut = (b: Any, fees: number[]) => {
    tally.canned += fees.filter((f) => cargoOf(f, 'goods') === 'canned').length;
    return shipOut(b, fees);
  };
  const stores = () => [...world.bays.values()].filter((b: Any) => b.tiles && !b.outgoing);
  const seen = new Map<number, number>();
  for (let k = 0; k < TICKS_PER_DAY * days; k++) {
    world.step();
    if (stores().some((b: Any) => world.dropRoom(b, false) <= 0)) tally.full++;
    for (const b of world.boats) {
      if (b.vessel !== 'coaster') continue;
      if (!brought.has(b.id)) {
        brought.add(b.id);
        tally.brought += b.crates;
      }
      if (b.state === 'anchored') tally.anchored++;
      if (b.state === 'leaving' && !seen.has(b.id)) {
        seen.set(b.id, b.crates);
        tally.leftOnBoard += b.crates;
      }
    }
  }
  return tally;
}

describe('Storage at a busy Coastal Wharf', () => {
  it('fills small storage with timber and goods in customs, and more storage clears it', () => {
    const days = 8;
    const small = run(wharf(2, 2), days);
    const big = run(wharf(4, 2), days);
    if (process.env.BALANCE) console.log({ small, big });
    // Two tiles of storage for cargo coming in hold less than a day of the
    // coasters' timber and goods, which wait there a day for customs: it is
    // full much of the time, and the coasters wait at anchor meanwhile.
    expect(small.full).toBeGreaterThan(TICKS_PER_DAY * 2);
    // Four hold it, and are hardly ever full.
    expect(big.full).toBeLessThan(TICKS_PER_DAY / 2);
    // Enough gets through for the Coastal Wharf's landmarks: the builders'
    // yard's 25 crates of canned fish on board, the school's 25 of timber
    // and most of the town hall's 60 of goods trucked out in these days.
    expect(big.canned).toBeGreaterThanOrEqual(25);
    expect(big.timber).toBeGreaterThanOrEqual(25);
    expect(big.goods).toBeGreaterThanOrEqual(30);
  }, 120_000);
});
