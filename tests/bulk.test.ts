import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { placementError, sidings } from '../src/sim/rules';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import { LANDMARKS } from '../src/sim/town';
import { railColumn } from '../src/sim/railway';
import { addContract } from '../src/sim/systems/economy';
import { stockpileArea } from '../src/sim/systems/bulk';
import type { FisheryTerms, RailTerms } from '../src/sim/contracts';

/**
 * A Bulk Terminal: a two-wide pier out to water deep enough for bulk
 * carriers with a grab crane at its end, a belt from its hopper along the
 * pier to a stockpile ashore, and a belt off the stockpile to a rail
 * loadout over a siding. Returns the tiles that matter.
 */
function terminal(world: World) {
  const m = world.map;
  const r = m.yOf(m.entry);
  let shore = 0;
  while (m.build[m.idx(shore + 1, r)] !== Build.Jetty) shore++;
  const row = (y: number, x0: number, x1: number) =>
    Array.from({ length: Math.abs(x1 - x0) + 1 }, (_, k) => m.idx(x0 + Math.sign(x1 - x0) * k, y));
  const start = shore - 3;
  let end = -1;
  for (let x = shore + 1; x < m.w - 3 && end < 0; x++) {
    const out = m.idx(x, r - 3);
    if (m.isLand(m.idx(x, r - 2))) continue;
    if (m.depth[m.idx(x, r - 2)] > B.MAX_QUAY_DEPTH) break;
    if (!m.isLand(out) && m.depth[out] >= B.BULKER_DRAFT + 0.5) end = x;
  }
  expect(end, 'deep water off the pier').toBeGreaterThan(0);
  for (const y of [r - 1, r - 2])
    world.command({ type: 'bulldoze', tiles: row(y, start - 6, end) });
  for (const y of [r - 1, r - 2]) {
    for (const i of row(y, start, end)) {
      world.command({ type: 'build', kind: m.isLand(i) ? 'portRoad' : 'quay', tiles: [i] });
    }
  }
  const office = m.build.findIndex((_, i) => !placementError(m, 'office', i));
  world.command({ type: 'build', kind: 'office', tiles: [office] });
  const crane = m.idx(end, r - 2);
  world.command({ type: 'build', kind: 'grabCrane', tiles: [crane] });
  // Along the pier's inner row from behind the crane, ashore, into a stockpile.
  const belt = row(r - 1, end, start);
  world.command({ type: 'bulldoze', tiles: belt.filter((i) => m.build[i] === Build.PortRoad) });
  world.command({ type: 'build', kind: 'belt', tiles: belt });
  const pile = [...row(r - 1, start - 1, start - 3), ...row(r - 2, start - 1, start - 3)];
  world.command({ type: 'build', kind: 'stockpile', tiles: pile });
  // A siding off the main line, a loadout on it, and a belt from the stockpile to it.
  const x = railColumn(m);
  const sy = r - 5;
  const siding = Array.from({ length: 9 }, (_, k) => m.idx(x + 1 + k, sy));
  world.command({ type: 'bulldoze', tiles: siding });
  world.command({ type: 'build', kind: 'siding', tiles: siding });
  const loadout = siding[4];
  world.command({ type: 'build', kind: 'loadout', tiles: [loadout] });
  const lx = m.xOf(loadout);
  const feed = [
    ...row(r - 1, start - 4, lx),
    ...Array.from({ length: 3 }, (_, k) => m.idx(lx, r - 2 - k)),
  ];
  world.command({ type: 'bulldoze', tiles: feed });
  world.command({ type: 'build', kind: 'belt', tiles: feed });
  return { crane, belt, pile, loadout, feed, siding };
}

describe('The Bulk Terminal', () => {
  it('lands a bulk carrier’s coal by grab crane, belts it to a stockpile, and on to the power station’s trains', () => {
    const world = World.create(7, 96);
    world.tier = 3;
    world.cash = 1_000_000;
    world.town!.landmarks = LANDMARKS.length;
    const t = terminal(world);
    const m = world.map;
    expect(m.build[t.crane]).toBe(Build.GrabCrane);
    expect(t.belt.every((i) => m.build[i] === Build.Belt)).toBe(true);
    expect(t.feed.every((i) => m.build[i] === Build.Belt)).toBe(true);
    expect(m.build[t.loadout]).toBe(Build.Loadout);
    expect(sidings(m)[0].tiles).toEqual(t.siding);
    const ship: FisheryTerms = {
      kind: 'fishery',
      vessel: 'bulker',
      name: 'Collier Line',
      color: 0,
      boatEvery: 9,
      cratesMin: 320,
      cratesMax: 320,
      fee: 4,
      bulk: 'coal',
    };
    addContract(world, ship, world.tick, 0);
    const power = world.region.places.find((p) => p.kind === 'power')!;
    const trains: RailTerms = {
      kind: 'rail',
      name: 'Power',
      color: 0,
      trainEvery: 0.5,
      bring: 0,
      take: 4 * B.HOPPER_WAGON,
      fee: 2,
      dailyFee: 0,
      place: power.id,
      bulk: 'coal',
    };
    addContract(world, trains, world.tick, 0);
    let moored = false;
    let piled = 0;
    let filled = 0;
    let left = 0;
    for (let k = 0; k < TICKS_PER_DAY * 4 && left === 0; k++) {
      world.step();
      const b = world.boats.find((q) => q.vessel === 'bulker');
      moored ||= b?.state === 'moored';
      piled = Math.max(
        piled,
        stockpileArea(world, t.pile[0]).reduce((n, i) => n + (world.bulk.get(i)?.t ?? 0), 0),
      );
      for (const tr of world.rail.trains) {
        if (tr.port?.hoppers)
          filled = Math.max(
            filled,
            tr.port.hoppers.reduce((n, h) => n + h, 0),
          );
        if (tr.port?.hoppers && tr.port.state === 'out') left = filled;
      }
    }
    expect(moored, 'the bulk carrier came alongside the grab crane').toBe(true);
    expect(piled, 'coal heaped on the stockpile').toBeGreaterThan(0);
    expect(left, 'a train left with its wagons full').toBeGreaterThanOrEqual(
      4 * B.HOPPER_WAGON - 1,
    );
    expect(
      world.today.bulk +
        (world.yesterday?.bulk ?? 0) +
        world.history.reduce((n, d) => n + d.ledger.bulk, 0),
    ).toBeGreaterThan(0);
  });
});
