import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { makeOffer } from '../src/sim/contracts';
import { Rng } from '../src/sim/rng';
import { Build } from '../src/sim/types';
import { World } from '../src/sim/world';
import { roadside } from '../src/sim/systems/roads/bays';
import { takeCrateTruckJob } from '../src/sim/systems/truckLoading';
import { withCargo } from '../src/sim/cargo';
import { stockUp } from './stock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('Pickups', () => {
  it('are what a new game’s hauliers send, and what hauliers offer at the Fishing Jetty', () => {
    const world: Any = World.create(7, 96);
    const hauliers = world.contracts.filter((c: Any) => c.terms.kind === 'haulier');
    expect(hauliers.length).toBeGreaterThan(0);
    for (const h of hauliers) {
      expect(h.terms.pickup).toBe(true);
      expect(h.terms.capacity).toBe(B.PICKUP_CAPACITY);
    }
    const rng = new Rng(3);
    for (let k = 0; k < 20; k++) {
      const o = makeOffer(rng, k, 0, 'haulier', new Set(), 0);
      if (!o || o.terms.kind !== 'haulier') continue;
      expect(o.terms.pickup).toBe(true);
      expect(o.terms.capacity).toBe(B.PICKUP_CAPACITY);
    }
  });

  it('pull up on the road beside a truck bay, never backing in, and are loaded by hand only', () => {
    const world: Any = World.create(7, 96);
    world.tier = 0;
    const bay = [...world.bays.values()][0];
    const m = world.map;
    stockUp(world, bay, [...Array(6).fill(withCargo(20, 'fish'))]);
    let pickup: Any;
    let loaded = 0;
    for (let t = 0; t < 1500; t++) {
      world.step();
      for (const tr of world.trucks) {
        if (!tr.pickup || tr.state !== 'loading') continue;
        pickup = tr;
        // On the road beside the bay, not in it.
        const at = m.idx(Math.floor(tr.x), Math.floor(tr.y));
        expect(at).not.toBe(bay.idx);
        expect(roadside(world, bay)).toContain(at);
        expect(m.build[at]).not.toBe(Build.TruckBay);
        expect(tr.backing).toBeUndefined();
        loaded = Math.max(loaded, tr.cargo);
      }
    }
    expect(pickup).toBeDefined();
    expect(loaded).toBeGreaterThan(0);
    // No forklift takes a job loading one.
    const forklift: Any = { ...world.people[0], kind: 'forklift', capacity: B.FORKLIFT_CAPACITY };
    pickup.state = 'loading';
    pickup.cargo = 0;
    const src = { tile: bay.idx, avail: 4, truck: pickup, load: true, rank: 1 };
    expect(takeCrateTruckJob(world, forklift, src)).toBe(false);
  });

  it('give way to small trucks from the Coastal Wharf on, which hauliers offer then', () => {
    const world: Any = World.create(7, 96);
    world.tier = 1;
    for (let t = 0; t < 30; t++) world.step();
    for (const c of world.contracts) {
      if (c.terms.kind !== 'haulier') continue;
      expect(c.terms.pickup).toBeFalsy();
      expect(c.terms.capacity).toBe(B.TRUCK_CAPACITY);
    }
    const rng = new Rng(5);
    const sizes = new Set<number>();
    for (let k = 0; k < 40; k++) {
      const o = makeOffer(rng, k, 0, 'haulier', new Set(), 1);
      if (!o || o.terms.kind !== 'haulier') continue;
      expect(o.terms.pickup).toBeFalsy();
      sizes.add(o.terms.capacity);
    }
    expect([...sizes].sort()).toEqual([B.TRUCK_CAPACITY, B.BIG_TRUCK_CAPACITY].sort());
  });

  it('keep an old save’s hauliers’ trucks as they were', () => {
    const world: Any = World.create(7, 96);
    for (const c of world.contracts) {
      if (c.terms.kind !== 'haulier') continue;
      c.terms.pickup = undefined;
      c.terms.capacity = B.TRUCK_CAPACITY;
    }
    const again: Any = World.fromSave(JSON.parse(JSON.stringify(world.toSave())));
    for (const c of again.contracts) {
      if (c.terms.kind === 'haulier') expect(c.terms.pickup).toBeFalsy();
    }
  });
});
