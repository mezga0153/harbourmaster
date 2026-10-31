import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import { assignJob } from '../src/sim/systems/workforce/dockhands';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('Boats in turn', () => {
  it('has the dockhands unload the boat moored longest first, however near another lies', () => {
    const world = World.create(7, 96) as Any;
    const template = world.boats[0];
    world.boats.length = 0;
    const m = world.map;
    const p = world.people.find((q: Any) => q.kind === 'dockhand');
    const here = world.tileOf(p);
    // Two jetty tiles, one by the dockhand and one further off.
    const jetty = [...m.build.keys()]
      .filter((i: number) => m.build[i] === Build.Jetty)
      .sort((a: number, b: number) => world.dist(here, a) - world.dist(here, b));
    const near = jetty[0];
    const far = jetty[jetty.length - 1];
    expect(world.dist(here, far)).toBeGreaterThan(world.dist(here, near));
    const boat = (id: number, mooredTicks: number) => ({
      ...template,
      id,
      vessel: 'smack' as const,
      state: 'moored' as const,
      crates: 4,
      reserved: 0,
      mooredTicks,
    });
    const young = boat(1000, 10);
    const old = boat(1001, 300);
    world.boats.push(young, old);
    world.pickupSpots = (b: Any) => [b === old ? far : near];
    expect(assignJob(world, p)).toBe(true);
    expect(p.boatId).toBe(old.id);
    // Once all its crates are spoken for, the next goes to the other.
    const q = world.people.find((r: Any) => r.kind === 'dockhand' && r !== p);
    old.reserved = old.crates;
    expect(assignJob(world, q)).toBe(true);
    expect(q.boatId).toBe(young.id);
  });

  it('come into sight not far out, rather than sail all the way in from the edge of the map', () => {
    const world = World.create(7) as Any;
    const hours = TICKS_PER_DAY / 24;
    const came = new Map<number, number>();
    const took: number[] = [];
    for (let t = 0; t < TICKS_PER_DAY * 4; t++) {
      world.step();
      for (const b of world.boats) {
        if (b.vessel === 'tug') continue;
        if (!came.has(b.id)) came.set(b.id, world.tick);
        else if (b.state !== 'approaching' && came.get(b.id)! >= 0) {
          took.push(world.tick - came.get(b.id)!);
          came.set(b.id, -1);
        }
      }
    }
    expect(took.length).toBeGreaterThan(2);
    const smack = B.VESSELS.smack.speed;
    // About as long as the way in sight takes, and nothing like the day
    // and a half the open sea took.
    for (const t of took.slice(1)) expect(t).toBeLessThan((B.SAIL_IN_TILES * 1.5) / smack);
    expect(Math.max(...took.slice(1))).toBeLessThan(20 * hours);
  });
});
