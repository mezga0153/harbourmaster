import { describe, expect, it } from 'vitest';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import { bayRoom, truckBay } from '../src/sim/helpers';
import { boatWhy, problems } from '../src/sim/systems/snapshot';
import { oldPile, wharf } from './wharf';
import { cratesAt, stockUp } from './stock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Crates off the boats so far, counting each boat's fall in crates on board. */
function unloadCounter(world: Any): () => number {
  const last = new Map<number, number>();
  let off = 0;
  return () => {
    for (const b of world.boats) {
      const before = last.get(b.id);
      if (before !== undefined && b.crates < before) off += before - b.crates;
      last.set(b.id, b.crates);
    }
    return off;
  };
}

describe('Dockhands set no crates down on the quay', () => {
  it('makes no pile over days of a busy quay port, carrying each crate straight into storage or a truck bay', () => {
    const world = wharf(4, 2, true);
    const count = unloadCounter(world);
    let carried = 0;
    for (let k = 0; k < TICKS_PER_DAY * 3; k++) {
      world.step();
      expect(world.piles.size).toBe(0);
      for (const p of world.people) {
        // Forklifts never take crates off a boat, nor wait by one.
        if (p.kind === 'forklift') expect(p.boatId).toBe(-1);
        if (p.kind !== 'dockhand' || p.outbound || p.carrying === 0) continue;
        // A crate in hand off a boat is on its way into storage or a truck bay.
        expect(world.bays.has(p.bayIdx)).toBe(true);
        carried++;
      }
      count();
    }
    expect(count()).toBeGreaterThan(30);
    expect(carried).toBeGreaterThan(0);
    // What came off is in storage or on the trucks, not on the quay.
    const stored = [...world.bays.values()].reduce((n: number, b: Any) => n + cratesAt(b), 0);
    expect(stored + world.stats.cratesHandled).toBeGreaterThan(0);
  }, 60_000);

  it('leaves a boat waiting, saying why, while every truck bay and storage is full', () => {
    const world: Any = World.create(7, 96);
    // No trucks to empty the bays.
    world.contracts = world.contracts.filter((c: Any) => c.terms.kind !== 'haulier');
    for (const b of world.bays.values()) {
      if (truckBay(b)) stockUp(world, b, [...Array(bayRoom(b, false)).fill(10)]);
    }
    for (
      let t = 0;
      t < TICKS_PER_DAY * 2 && !world.boats.some((b: Any) => b.state === 'moored');
      t++
    ) {
      world.step();
    }
    const boat = world.boats.find((b: Any) => b.state === 'moored');
    expect(boat).toBeDefined();
    const load = boat.crates;
    expect(load).toBeGreaterThan(0);
    for (let t = 0; t < 200; t++) world.step();
    expect(boat.crates).toBe(load);
    expect(world.piles.size).toBe(0);
    expect(boat.noRoom).toBe('room');
    expect(boatWhy(world, boat)).toMatch(/full/);
    const mark = problems(world).find((p) => p.type === 'boat' && p.idx === boat.id);
    expect(mark?.text).toMatch(/full/);
    // Room again: the dockhands carry the crates in, and it says so no more.
    for (const b of world.bays.values()) if (truckBay(b)) b.cells = [];
    for (let t = 0; t < 300 && boat.crates === load; t++) world.step();
    expect(boat.crates).toBeLessThan(load);
    expect(boat.noRoom).toBeUndefined();
    expect(problems(world).some((p) => p.type === 'boat')).toBe(false);
  });

  it("has an older game's crates on the quay carried away, and makes no new pile", () => {
    const made = wharf(4, 2, true);
    const m = made.map;
    const r = m.yOf(m.entry);
    // A quay tile by the berths with no storage marked out on it.
    const quay = [...Array(m.w).keys()]
      .map((x) => m.idx(x, r - 2))
      .filter((i) => m.build[i] === Build.Quay && !m.store[i]);
    oldPile(made, quay[quay.length - 2], Array(6).fill(10));
    const world: Any = World.fromSave(JSON.parse(JSON.stringify(made.toSave())));
    expect(world.piles.size).toBe(1);
    let largest = 6;
    for (let t = 0; t < TICKS_PER_DAY && world.piles.size > 0; t++) {
      world.step();
      for (const p of world.piles.values()) {
        largest = Math.max(largest, cratesAt(p) + p.incoming);
      }
    }
    expect(world.piles.size).toBe(0);
    // Taken away, never added to.
    expect(largest).toBe(6);
  });
});
