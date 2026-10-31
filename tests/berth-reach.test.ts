import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { placementError } from '../src/sim/rules';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import { berthCount, freeBerths, handsReach } from '../src/sim/systems/boats/berthing';
import { landingReach } from '../src/sim/systems/workforce/dockhands';
import { boatWhy } from '../src/sim/systems/snapshot';

/** A jetty on its own further along the coast, joined to the port by nothing but grass. */
function loneJetty(world: World): number {
  const m = world.map;
  for (const off of [4, -4, 8, -8, 12, -12, 16, -16]) {
    const row = m.yOf(m.entry) + off;
    let x = 0;
    while (x < m.w - 1 && m.ocean[m.idx(x, row)] !== 1) x++;
    const tile = m.idx(x, row);
    if (placementError(m, 'jetty', tile)) continue;
    world.command({ type: 'build', kind: 'jetty', tiles: [tile] });
    return tile;
  }
  throw new Error('no room for a jetty');
}

/** Footpath from the jetty's shore end back to the port's paths, tile by tile over the land. */
function joinUp(world: World, jetty: number): void {
  const m = world.map;
  const paths = [...m.build.keys()].filter((i) => m.build[i] === Build.Footpath);
  const goal = paths[0];
  let x = m.xOf(jetty) - 1;
  let y = m.yOf(jetty);
  const tiles: number[] = [];
  while (x !== m.xOf(goal) || y !== m.yOf(goal)) {
    if (!m.isLand(m.idx(x, y)) || !placementError(m, 'footpath', m.idx(x, y)))
      tiles.push(m.idx(x, y));
    if (y !== m.yOf(goal)) y += Math.sign(m.yOf(goal) - y);
    else x += Math.sign(m.xOf(goal) - x);
  }
  world.command({ type: 'build', kind: 'footpath', tiles });
}

describe('Berths nothing can unload at', () => {
  it('never sends a boat to a jetty the dockhands cannot walk to storage from', () => {
    const world = World.create(7, 96);
    world.cash = 100_000;
    world.boats.length = 0;
    const m = world.map;
    const lone = loneJetty(world);
    const reach = landingReach(world);
    expect(reach[lone]).toBe(0);
    const bay = [...world.bays.keys()][0];
    expect(reach[bay]).toBe(1);
    const from = m.idx(m.w - 1, m.yOf(m.entry));
    const berths = freeBerths(world, from, B.BOAT_DRAFT, false);
    expect(berths.length).toBeGreaterThan(0);
    for (const b of berths) {
      expect(handsReach(world, b.berth, b.jetty)).toBe(true);
      expect(Math.abs(m.yOf(b.jetty) - m.yOf(lone))).toBeGreaterThan(1);
    }
    // Joined to the port by a footpath, it is used like any other.
    joinUp(world, lone);
    expect(landingReach(world)[lone]).toBe(1);
    const after = freeBerths(world, from, B.BOAT_DRAFT, false);
    expect(after.some((b) => b.jetty === lone)).toBe(true);
  });

  it('counts the berths a boat could be unloaded at apart, and says so when there are none', () => {
    const world = World.create(7, 96);
    world.cash = 100_000;
    world.boats.length = 0;
    const m = world.map;
    loneJetty(world);
    const all = berthCount(world, B.BOAT_DRAFT);
    const usable = berthCount(world, B.BOAT_DRAFT, false, false, true);
    expect(usable).toBeGreaterThan(0);
    expect(usable).toBeLessThan(all);
    // The starting jetty's path bulldozed, nothing joins any jetty to the truck bay.
    const paths = [...m.build.keys()].filter((i) => m.build[i] === Build.Footpath);
    world.command({ type: 'bulldoze', tiles: paths });
    expect(berthCount(world, B.BOAT_DRAFT)).toBe(all);
    expect(berthCount(world, B.BOAT_DRAFT, false, false, true)).toBe(0);
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) {
      world.step();
      for (const b of world.boats) expect(b.state).not.toBe('moored');
    }
    const anchored = world.boats.find((b) => b.state === 'anchored');
    expect(anchored).toBeDefined();
    expect(boatWhy(world, anchored!)).toMatch(/could be unloaded at/);
  });
});
