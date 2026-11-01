import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { withCargo } from '../src/sim/cargo';
import { World } from '../src/sim/world';
import {
  bedCap,
  bedSlots,
  farSide,
  keepSlots,
  onBed,
  slotsFor,
  topFirst,
  offBed,
} from '../src/sim/systems/cargo/beds';
import { smallTruckHauliers } from './wharf';
import { cratesAt, stockUp } from './stock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** A small truck standing at the port's truck bay, empty, and a dockhand and a forklift to load it. */
function atBay(): { world: Any; t: Any; hand: Any; lift: Any } {
  const world: Any = World.create(7, 96);
  smallTruckHauliers(world);
  const bay = [...world.bays.values()][0];
  const m = world.map;
  const t: Any = {
    id: 999,
    x: m.xOf(bay.idx) + 0.5,
    y: m.yOf(bay.idx) + 0.5,
    dir: 0,
    path: [],
    state: 'loading',
    contractId: -1,
    company: 'Test',
    capacity: B.TRUCK_CAPACITY,
    bayIdx: bay.idx,
    cargo: 0,
    value: 0,
    load: [],
    boxes: false,
    idle: 0,
    timer: 0,
  };
  world.trucks.push(t);
  const hand = world.people.find((p: Any) => p.kind === 'dockhand');
  const lift: Any = { ...hand, id: 5000, kind: 'forklift', capacity: B.FORKLIFT_CAPACITY };
  world.people.push(lift);
  return { world, t, hand, lift };
}

/** Put `n` crates on a truck as `p` would. */
function load(world: Any, t: Any, p: Any, n: number): number[] {
  const slots = keepSlots(world, t, p, n);
  p.truckId = t.id;
  p.truckLoad = true;
  const k = slots.length;
  onBed(world, t, Array(k).fill(withCargo(20, 'fish')), p);
  p.truckId = undefined;
  p.truckLoad = undefined;
  return slots;
}

const layer = (t: Any, s: number) => Math.floor(s / t.capacity);
const side = (s: number) => s % 2;

describe('A truck’s bed', () => {
  it('is filled by hand only on its bottom layer, the far side first', () => {
    const { world, t, hand } = atBay();
    const far = farSide(world, t);
    const put: number[] = [];
    for (let k = 0; k < 10; k++) put.push(...load(world, t, hand, 1));
    // One layer only, by hand.
    expect(put).toHaveLength(t.capacity);
    expect(put.every((s) => layer(t, s) === 0)).toBe(true);
    // The far side all before the near side.
    const half = t.capacity / 2;
    expect(put.slice(0, half).every((s) => side(s) === far)).toBe(true);
    expect(put.slice(half).every((s) => side(s) !== far)).toBe(true);
    expect(slotsFor(world, t, hand, 1)).toEqual([]);
  });

  it('takes a forklift’s second layer only on a whole one, on one side, the far side first', () => {
    const { world, t, hand, lift } = atBay();
    const far = farSide(world, t);
    // Forklifts in the port: two layers, else one.
    expect(bedCap(world, t)).toBe(2 * t.capacity);
    // A pallet goes down two along one side, two high: the far side first.
    const first = load(world, t, lift, 4);
    expect(first).toHaveLength(4);
    expect(first.every((s) => side(s) === far)).toBe(true);
    expect(first.map((s) => layer(t, s)).sort()).toEqual([0, 0, 1, 1]);
    // A dockhand puts one on the near side's bottom: nothing on top of it
    // till the crate beside it under where a pallet would go is there too.
    const h = load(world, t, hand, 1);
    expect(layer(t, h[0])).toBe(0);
    const next = slotsFor(world, t, lift, 4);
    for (const s of next) {
      if (layer(t, s) === 0) continue;
      // Every crate on the second layer has one under it.
      const under = s - t.capacity;
      expect(bedSlots(world, t).includes(under) || next.includes(under)).toBe(true);
    }
    // Filled up by forklift: never more than two layers, every top crate on one.
    for (let k = 0; k < 10; k++) load(world, t, lift, 4);
    const bed = bedSlots(world, t);
    expect(bed).toHaveLength(2 * t.capacity);
    for (const s of bed) if (layer(t, s) === 1) expect(bed).toContain(s - t.capacity);
  });

  it('is taken off from the top in town, the rest staying where they are', () => {
    const { world, t, lift } = atBay();
    load(world, t, lift, 4);
    load(world, t, lift, 4);
    const before = [...bedSlots(world, t)];
    const order = topFirst(world, t);
    // The top layer first.
    expect(layer(t, order[0])).toBe(1);
    expect(layer(t, order[1])).toBe(1);
    // Two off the top: those under them stay put.
    offBed(world, t, order.slice(0, 2));
    const after = bedSlots(world, t);
    const kept = before.filter((s) => !order.slice(0, 2).includes(s));
    expect(after).toEqual(kept);
  });

  it('is one layer on a pickup, never a forklift’s', () => {
    const { world, t, hand, lift } = atBay();
    t.pickup = true;
    expect(bedCap(world, t)).toBe(t.capacity);
    expect(slotsFor(world, t, lift, 4)).toEqual([]);
    for (let k = 0; k < 10; k++) load(world, t, hand, 1);
    expect(bedSlots(world, t).every((s) => layer(t, s) === 0)).toBe(true);
  });

  it('is loaded two layers high by forklifts in a Coastal Wharf game, every crate kept where it went', () => {
    const world: Any = World.create(7, 96);
    world.tier = 1;
    world.cash = 1_000_000;
    smallTruckHauliers(world);
    // Forklifts only, so the trucks wait for a second layer.
    const lift = world.people.find((p: Any) => p.kind === 'dockhand');
    lift.kind = 'forklift';
    lift.capacity = B.FORKLIFT_CAPACITY;
    for (const p of world.people.filter((q: Any) => q !== lift))
      world.command({ type: 'fire', id: p.id });
    const bay = [...world.bays.values()][0];
    const seen = new Map<number, number[]>();
    let high = 0;
    for (let k = 0; k < 3000; k++) {
      if (cratesAt(bay) < 8) stockUp(world, bay, [withCargo(20, 'fish')]);
      world.step();
      for (const t of world.trucks) {
        if (t.boxes || !t.load || t.state !== 'loading') continue;
        const bed = [...bedSlots(world, t)];
        const was = seen.get(t.id) ?? [];
        // Each crate stays in its place as others go on.
        expect(bed.slice(0, was.length)).toEqual(was);
        seen.set(t.id, bed);
        for (const s of bed) {
          if (s < t.capacity) continue;
          high++;
          expect(bed).toContain(s - t.capacity);
        }
      }
    }
    expect(high).toBeGreaterThan(0);
  }, 60_000);
});
