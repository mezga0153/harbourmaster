import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('Crate trucks', () => {
  it('are loaded by dockhands with nothing else to do, besides their own crew, losing no crates', () => {
    const world: Any = World.create(7, 96);
    world.boats.length = 0;
    const bay = [...world.bays.values()][0];
    bay.crates.push(...Array(B.BAY_CAPACITY).fill(20));
    const total = () =>
      bay.crates.length +
      world.trucks.reduce((n: number, t: Any) => n + (t.boxes ? 0 : t.cargo), 0) +
      world.people.reduce((n: number, p: Any) => n + p.carrying, 0) +
      world.stats.cratesHandled;
    const start = total();
    let helped = 0;
    for (let k = 0; k < TICKS_PER_DAY && bay.crates.length > 0; k++) {
      world.step();
      const jobs = world.people.filter(
        (p: Any) => p.truckId !== undefined && p.kind === 'dockhand',
      );
      if (jobs.some((p: Any) => p.state === 'dropping')) helped++;
      // What they are on their way for is promised to them, and the truck
      // waits for no more than they bring it.
      const going = jobs.filter((p: Any) => p.state === 'toPickup' || p.state === 'picking');
      expect(bay.reserved ?? 0).toBe(going.reduce((n: number, p: Any) => n + p.planned, 0));
      for (const t of world.trucks.filter((q: Any) => q.state === 'loading')) {
        const theirs = jobs.filter((p: Any) => p.truckId === t.id);
        expect(t.coming ?? 0).toBe(theirs.reduce((n: number, p: Any) => n + p.planned, 0));
        expect(t.cargo + (t.coming ?? 0)).toBeLessThanOrEqual(t.capacity);
      }
    }
    expect(helped).toBeGreaterThan(0);
    // Every crate is still in the bay, on a truck or in someone's hands.
    expect(bay.crates.length).toBe(0);
    expect(total()).toBe(start);
  });
});
