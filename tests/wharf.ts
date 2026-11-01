// A Coastal Wharf port built the way a player would, for the tests that
// run one for days and count what goes through it; and crates an older
// game left lying on the quay.

import { expect } from 'vitest';
import * as B from '../src/sim/balance';
import { placementError } from '../src/sim/rules';
import { Build, Terrain } from '../src/sim/types';
import { World } from '../src/sim/world';
import type { Bay } from '../src/sim/state';
import { addContract } from '../src/sim/systems/economy';
import { spawnDockhand } from '../src/sim/systems/workforce/dockhands';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * A Coastal Wharf with a two-wide quay out to deep water for the coasters,
 * forklifts, and crate storage by the public road: `inTiles` tiles of it
 * for cargo coming in (two or four), `outTiles` (one or two) for cargo
 * going out. A customs office; the cannery, Valley Timber Co. and a line of goods are
 * signed, and a haulier's trucks take the crates away. With `atQuay`, the
 * storage for cargo coming in is on the back row of the quay by the
 * coasters' berths instead, for the dockhands to carry it into.
 */
export function wharf(inTiles: number, outTiles: number, atQuay = false): Any {
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
  const quay = tiles(r - 1, start, end).filter((i) => m.build[i] === Build.Quay);
  const into = atQuay
    ? quay.slice(-1 - inTiles, -1)
    : [...tiles(r - 6, start - 7, start - 6), ...tiles(r - 5, start - 7, start - 6)].slice(
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
  // A customs office, which its timber, goods and canned fish need.
  const customs = m.build.findIndex(
    (b: number, i: number) => b === Build.None && !placementError(m, 'customs', i),
  );
  world.command({ type: 'build', kind: 'customs', tiles: [customs] });
  expect(m.build[customs]).toBe(Build.Customs);
  // Hands enough for the coasters.
  const home = world.people.find((p: Any) => p.kind === 'dockhand');
  for (let k = 0; k < 4; k++) {
    spawnDockhand(world, m.idx(Math.floor(home.x), Math.floor(home.y)), {
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
  const add = addContract.bind(null, world);
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

/**
 * Crates lying on quay tile `t` as an older game left them, before
 * dockhands stopped setting any down there: `out` for exports.
 */
export function oldPile(world: World, t: number, fees: number[], out = false): Bay {
  const pile: Bay = {
    idx: t,
    large: false,
    pile: true,
    pallets: false,
    out,
    reserved: 0,
    boxes: [],
    boxIncoming: 0,
    cells: fees.map((fee) => ({ fee, at: 0 })),
    incoming: 0,
    nextTruckTick: 0,
    noAccess: false,
  };
  world.piles.set(t, pile);
  return pile;
}

/**
 * The port road taken up along the north and west of the Coastal Wharf's
 * storage for cargo coming in, beside its first tile, so the stack there
 * has ground to drive on at its south end only: its north row is reached
 * only through the south one once that is empty. Returns that tile.
 */
export function shutIn(world: Any): number {
  const m = world.map;
  const store = [...(world.bays.values() as Iterable<Bay>)].find((b) => b.tiles && !b.outgoing)!;
  const x0 = Math.min(...store.tiles!.map((t) => m.xOf(t)));
  const y0 = Math.min(...store.tiles!.map((t) => m.yOf(t)));
  const road = [m.idx(x0 - 1, y0), m.idx(x0 - 1, y0 + 1), m.idx(x0, y0 - 1), m.idx(x0 + 1, y0 - 1)];
  world.command({ type: 'bulldoze', tiles: road });
  for (const t of road) expect(m.build[t]).toBe(Build.None);
  return m.idx(x0, y0);
}

/**
 * Hauliers sending small trucks, which back into a truck bay, in place of
 * the pickups a new game's send, which pull up on the road beside it.
 */
export function smallTruckHauliers(world: Any): void {
  for (const c of world.contracts) {
    if (c.terms.kind !== 'haulier' || !c.terms.pickup) continue;
    c.terms.pickup = undefined;
    c.terms.capacity = B.TRUCK_CAPACITY;
  }
}
