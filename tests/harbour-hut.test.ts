import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { placementError } from '../src/sim/rules';
import { Build } from '../src/sim/types';
import { World } from '../src/sim/world';
import { docks } from '../src/sim/systems/boats/berthing';

/** Standalone jetties further along the coast, as many as asked for where there is room. */
function jetties(world: World, n: number): void {
  const m = world.map;
  let built = 0;
  for (const off of [4, -4, 8, -8, 12, -12, 16, -16, 20, -20]) {
    const row = m.yOf(m.entry) + off;
    let x = 0;
    while (x < m.w - 1 && m.ocean[m.idx(x, row)] !== 1) x++;
    const tile = m.idx(x, row);
    if (!placementError(m, 'jetty', tile)) {
      world.command({ type: 'build', kind: 'jetty', tiles: [tile] });
      built++;
    }
    if (built === n) break;
  }
  expect(built).toBe(n);
}

function build(world: World, kind: 'harbourHut' | 'office'): number {
  const m = world.map;
  const spot = m.build.findIndex((_, i) => !placementError(m, kind, i));
  world.command({ type: 'build', kind, tiles: [spot] });
  expect(m.build[spot]).toBe(kind === 'office' ? Build.Office : Build.HarbourHut);
  return spot;
}

describe("Harbourmaster's hut", () => {
  it('looks after a few more jetties at the fishing jetty, cheaply', () => {
    const world = World.create(7, 96);
    world.cash = 50_000;
    jetties(world, 4);
    const used = () => docks(world).filter((d) => d.coordinated).length;
    expect(docks(world)).toHaveLength(5);
    expect(used()).toBe(B.FREE_DOCKS);
    const cash = world.cash;
    build(world, 'harbourHut');
    expect(cash - world.cash).toBeLessThan(500);
    expect(used()).toBe(Math.min(5, B.FREE_DOCKS + B.JETTIES_PER_HUT));
  });

  it('never looks after a quay, which needs a harbour office', () => {
    const world = World.create(7, 96);
    world.tier = 1;
    world.cash = 50_000;
    const m = world.map;
    const r = m.yOf(m.entry);
    const jetty = m.build.findIndex((b, i) => b === Build.Jetty && m.yOf(i) === r);
    world.command({ type: 'build', kind: 'quay', tiles: [jetty] });
    build(world, 'harbourHut');
    expect(docks(world).every((d) => !d.coordinated)).toBe(true);
    build(world, 'office');
    expect(docks(world).every((d) => d.coordinated)).toBe(true);
  });

  it('shows in the snapshot beside the offices', () => {
    const world = World.create(7, 96);
    world.cash = 50_000;
    build(world, 'harbourHut');
    expect(world.snapshot().docks.huts).toBe(1);
  });
});
