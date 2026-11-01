import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import { cratesAt, stockUp } from './stock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('Crate trucks', () => {
  it('are loaded only by dockhands, one at a time at a truck bay, losing no crates', () => {
    const world: Any = World.create(7, 96);
    world.boats.length = 0;
    const bay = [...world.bays.values()][0];
    stockUp(world, bay, [...Array(B.BAY_CAPACITY).fill(20)]);
    // Crates on trucks, those gone on to town as last seen.
    const onTrucks = new Map<number, number>();
    const total = () =>
      cratesAt(bay) +
      [...onTrucks.values()].reduce((n, c) => n + c, 0) +
      world.people.reduce((n: number, p: Any) => n + p.carrying, 0) +
      world.stats.cratesHandled;
    let helped = 0;
    let left = 0;
    let wasLoading = new Set<number>();
    for (const t of world.trucks) if (!t.boxes) onTrucks.set(t.id, t.cargo);
    const start = total();
    for (let k = 0; k < TICKS_PER_DAY && cratesAt(bay) > 0; k++) {
      world.step();
      for (const t of world.trucks) if (!t.boxes) onTrucks.set(t.id, t.cargo);
      // One at a time at the bay.
      const at = world.people.filter(
        (p: Any) =>
          (p.state === 'dropping' && p.bayIdx === bay.idx) ||
          (p.truckId !== undefined && p.stockIdx === bay.idx && p.state === 'picking'),
      );
      expect(at.length).toBeLessThanOrEqual(1);
      const jobs = world.people.filter(
        (p: Any) => p.truckId !== undefined && p.kind === 'dockhand',
      );
      if (jobs.some((p: Any) => p.state === 'dropping')) helped++;
      // A truck goes full, or once there is nothing left for it here.
      for (const t of world.trucks) {
        if (wasLoading.has(t.id) && t.state !== 'loading') {
          expect(t.cargo === t.capacity || cratesAt(bay) === 0).toBe(true);
          left++;
        }
      }
      wasLoading = new Set(
        world.trucks.filter((t: Any) => t.state === 'loading').map((t: Any) => t.id),
      );
      // And one at a time loads its trucks.
      expect(jobs.filter((p: Any) => p.stockIdx === bay.idx).length).toBeLessThanOrEqual(1);
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
    expect(left).toBeGreaterThan(0);
    // Every crate is still in the bay, on a truck or in someone's hands.
    expect(cratesAt(bay)).toBe(0);
    expect(total()).toBe(start);
  });

  it('have dockhands with nothing to do stand about apart, not on top of each other', () => {
    const world: Any = World.create(7, 96);
    world.boats.length = 0;
    for (const c of world.contracts) c.nextBoatTick = Infinity;
    const crew = world.people.filter((p: Any) => p.kind === 'dockhand');
    expect(crew.length).toBeGreaterThan(1);
    let apart = 0;
    for (let k = 0; k < 600; k++) {
      world.step();
      const idle = crew.filter((p: Any) => p.state === 'idle');
      if (idle.length < 2) continue;
      const near = idle.some((p: Any) =>
        idle.some((q: Any) => q !== p && Math.hypot(q.x - p.x, q.y - p.y) < 1),
      );
      if (!near) apart++;
    }
    // Most of the time, once they have walked off.
    expect(apart).toBeGreaterThan(400);
  });
});
