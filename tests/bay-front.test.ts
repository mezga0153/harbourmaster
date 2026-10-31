import { describe, expect, it } from 'vitest';
import { FACING } from '../src/sim/rules';
import { Build, TICKS_PER_DAY, Terrain } from '../src/sim/types';
import { World } from '../src/sim/world';
import { smallTruckHauliers } from './wharf';

describe('A truck bay with road down a side as well as in front', () => {
  it('has its trucks back in from the front and stand square in it, facing the road', () => {
    const world = World.create(7, 96);
    smallTruckHauliers(world);
    world.cash = 100_000;
    const m = world.map;
    const r = m.yOf(m.entry);
    const grass = (x: number, y: number) =>
      m.inBounds(x, y) && m.terrain[m.idx(x, y)] === Terrain.Grass && m.build[m.idx(x, y)] === 0;
    // Along the entry road, a patch of grass below it: the bay faces away
    // from the entry road onto a road behind it, and the road round to
    // that runs down the bay's side, so trucks come to its side first.
    const x = [...Array(m.w).keys()].find(
      (x) =>
        x > 4 &&
        [0, 1].every((d) => m.build[m.idx(x + d, r)] === Build.Road) &&
        [0, 1].every((d) => grass(x + d, r + 1) && grass(x + d, r + 2)),
    )!;
    expect(x).toBeDefined();
    const bay = m.idx(x, r + 1);
    const roads = [m.idx(x + 1, r + 1), m.idx(x + 1, r + 2), m.idx(x, r + 2)];
    world.command({ type: 'build', kind: 'road', tiles: roads });
    // Facing south, onto the road behind it; the road down to that is to its east.
    world.command({ type: 'build', kind: 'truckBay', tiles: [bay], facing: 1 });
    expect(m.build[bay]).toBe(Build.TruckBay);
    expect(roads.map((i) => m.build[i])).toEqual([Build.Road, Build.Road, Build.Road]);
    const b = world.bays.get(bay)!;
    const [fx, fy] = FACING[m.orient[bay] & 3];
    const out = Math.atan2(fy, fx);
    let stood = 0;
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) {
      if (b.crates.length < 6) b.crates.push(20, 20, 20, 20, 20, 20);
      world.step();
      for (const k of world.trucks) {
        if (k.bayIdx !== bay || k.state !== 'loading' || k.backing) continue;
        stood++;
        // Facing out of its front, onto the road it backed in from.
        expect(Math.abs(Math.atan2(Math.sin(k.dir - out), Math.cos(k.dir - out)))).toBeLessThan(
          0.01,
        );
      }
    }
    expect(stood).toBeGreaterThan(0);
  });
});
