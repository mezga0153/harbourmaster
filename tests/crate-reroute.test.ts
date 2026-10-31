import { describe, expect, it } from 'vitest';
import { Build } from '../src/sim/types';
import { bayCap } from '../src/sim/helpers';
import type { Bay } from '../src/sim/state';
import { truckable } from '../src/sim/systems/cargo/stores';
import { noPlace } from '../src/sim/systems/cargo/customs';
import { wharf } from './wharf';

// A forklift that finds the truck bay it is taking crates to full takes
// them on to somewhere the trucks can fetch them from, not to the nearest
// storage with room if no truck can get to that.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * The Coastal Wharf (its storage in the yard behind the gate, which the
 * trucks reach) with a jib crane at the end of the quay's outer row and two
 * tiles of crate storage beside it, the nearer in the crane's reach, the
 * quay round the further kept for machines: storage the trucks cannot reach.
 */
function port(): { world: Any; bay: Bay; yard: Bay; byCrane: Bay; far: number } {
  const world: Any = wharf(2, 1);
  const m = world.map;
  const r = m.yOf(m.entry);
  const row = [...m.build.keys()].filter(
    (i: number) => m.yOf(i) === r - 2 && m.build[i] === Build.Quay,
  );
  world.command({ type: 'build', kind: 'jibCrane', tiles: [row[row.length - 1]] });
  const far = row[row.length - 3];
  world.command({ type: 'store', tiles: [far, row[row.length - 2]], kind: 'crates', on: true });
  // The quay round the tile out of the crane's reach kept for machines.
  world.command({ type: 'forkliftOnly', tiles: [far - 1, far + m.w, far + m.w - 1], on: true });
  for (let k = 0; k < 20; k++) world.step();
  const bays = [...(world.bays.values() as Iterable<Bay>)];
  const bay = bays.find((b) => !b.tiles)!;
  const yard = bays.find((b) => b.tiles && !b.outgoing && b.idx !== world.storeOf[far])!;
  const byCrane = world.bays.get(world.storeOf[far])!;
  expect(byCrane.tiles).toHaveLength(2);
  expect(truckable(world, bay)).toBe(true);
  expect(truckable(world, yard)).toBe(true);
  expect(truckable(world, byCrane)).toBe(false);
  return { world, bay, yard, byCrane, far };
}

/** A forklift standing on `at` holding two crates of the catch it took out of storage, bound for `bay`. */
function carrying(world: Any, at: number, bay: Bay, cleared = true): Any {
  const m = world.map;
  const p = world.people.find((q: Any) => q.kind === 'forklift');
  p.x = m.xOf(at) + 0.5;
  p.y = m.yOf(at) + 0.5;
  p.carrying = 2;
  p.planned = 2;
  p.cargoFees = [10, 10];
  p.cleared = cleared || undefined;
  p.bayIdx = bay.idx;
  p.state = 'toDrop';
  bay.incoming += 2;
  return p;
}

describe('A forklift finding its truck bay full', () => {
  it('takes its crates on to storage the trucks reach, not nearer storage they cannot', () => {
    const { world, bay, yard, byCrane, far } = port();
    const m = world.map;
    const p = carrying(world, far + m.w, bay);
    // The bay full, the storage by the crane far nearer than the yard.
    bay.incoming = bayCap(bay);
    expect(world.distTo(world.tileOf(p), byCrane)).toBeLessThan(
      world.distTo(world.tileOf(p), yard),
    );
    noPlace(world, p, bay);
    expect(p.bayIdx).toBe(yard.idx);
    expect(p.waitingWhy).toBeUndefined();
    expect(yard.incoming).toBe(2);
    expect(byCrane.incoming).toBe(0);
  });

  it('waits with crates out of storage rather than take them where no truck can fetch them', () => {
    const { world, bay, yard, byCrane, far } = port();
    const m = world.map;
    const p = carrying(world, far + m.w, bay);
    bay.incoming = bayCap(bay);
    yard.incoming = bayCap(yard);
    noPlace(world, p, bay);
    expect(p.bayIdx).toBe(bay.idx);
    expect(p.waitingWhy).toMatch(/Waiting to set its 2 crates down/);
    expect(byCrane.incoming).toBe(0);
  });

  it('with crates not yet through storage, sets them down in what storage there is if the trucks reach none', () => {
    const { world, bay, yard, byCrane, far } = port();
    const m = world.map;
    const p = carrying(world, far + m.w, bay, false);
    bay.incoming = bayCap(bay);
    yard.incoming = bayCap(yard);
    noPlace(world, p, bay);
    expect(p.bayIdx).toBe(byCrane.idx);
    expect(p.waitingWhy).toBeUndefined();
  });
});
