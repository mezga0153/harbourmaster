import { describe, expect, it } from 'vitest';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { depotDoorTrouble, frontOf, placementError } from '../src/sim/rules';
import { bayRoom } from '../src/sim/helpers';
import * as B from '../src/sim/balance';
import { World } from '../src/sim/world';
import { jibReach, jibLifts } from '../src/sim/systems/cranes';
import { jibRoom } from '../src/sim/systems/cargo/stores';
import { jibReady } from '../src/sim/systems/cargo/exports';
import { crateSlots, stackOf } from '../src/sim/systems/cargo/places';
import { boatWhy, craneWhy, problems } from '../src/sim/systems/snapshot';
import { cratesAt, stockUp } from './stock';

// A jib crane swings crates only to the tiles right beside it: crate
// storage reaching further than that is in its reach on those tiles alone.

/**
 * The starting jetty paved into a quay, its paths into port roads, an
 * office, a jib crane at its tip and crate storage along the two tiles
 * behind it, the nearer beside the crane, the further out of its reach;
 * and no dockhands.
 */
function port(): { world: World; tip: number; near: number; far: number } {
  const world = World.create(7, 96);
  const m = world.map;
  world.boats.length = 0;
  world.tier = 1;
  world.cash = 1_000_000;
  const r = m.yOf(m.entry);
  const jetty = [...m.build.keys()].filter((i) => m.yOf(i) === r && m.build[i] === Build.Jetty);
  world.command({ type: 'build', kind: 'quay', tiles: jetty });
  const paths = [...m.build.keys()].filter((i) => m.build[i] === Build.Footpath);
  world.command({ type: 'build', kind: 'portRoad', tiles: paths });
  const office = m.build.findIndex((b, i) => b === Build.None && !placementError(m, 'office', i));
  world.command({ type: 'build', kind: 'office', tiles: [office] });
  const tip = jetty[jetty.length - 1];
  const near = jetty[jetty.length - 2];
  const far = jetty[jetty.length - 3];
  world.command({ type: 'build', kind: 'jibCrane', tiles: [tip] });
  world.command({ type: 'store', tiles: [far, near], kind: 'crates', on: true });
  for (const p of world.people.filter((q) => q.kind === 'dockhand')) {
    world.command({ type: 'fire', id: p.id });
  }
  return { world, tip, near, far };
}

function buyForklift(world: World): void {
  const m = world.map;
  for (let i = 0; i < m.build.length; i++) {
    if (placementError(m, 'depot', i)) continue;
    const f = [0, 1, 2, 3].find((f) => {
      const front = frontOf(m, i, f);
      return !depotDoorTrouble(m, i, f) && front >= 0 && m.build[front] === Build.PortRoad;
    });
    if (f === undefined) continue;
    world.command({ type: 'build', kind: 'depot', tiles: [i], facing: f });
    world.command({ type: 'buyMachine', kind: 'forklift', tile: i });
    break;
  }
  expect(world.people.some((p) => p.kind === 'forklift')).toBe(true);
}

/** The tile each crate (or export) in storage stands on. */
function tilesOf(world: World, idx: number, out = false): number[] {
  const b = world.bays.get(idx)!;
  const slots = out ? crateSlots(world, b).exports : crateSlots(world, b).crates;
  return slots.map((s) => (s >= 0 ? b.tiles![stackOf(b, s)] : -1));
}

describe('A jib crane and crate storage reaching beyond it', () => {
  it('reaches only the tiles of the storage right beside it', () => {
    const { world, tip, near, far } = port();
    const store = world.bays.get(far)!;
    expect(world.bays.get(world.storeOf[near])).toBe(store);
    const crane = world.cranes.get(tip)!;
    expect([...jibReach(world, crane, store)].map((n) => store.tiles![n])).toEqual([near]);
    // One tile in reach, and the room on it alone.
    const view = () => world.snapshot().cranes.find((c) => c.idx === tip)!;
    expect(view().stores).toBe(1);
    expect(view().storeRoom).toBe(B.CRATES_PER_STORE_TILE);
  });

  it('swings crates only onto those tiles, and waits once they are full though the storage has room', () => {
    const { world, tip, near, far } = port();
    const store = world.bays.get(far)!;
    const crane = world.cranes.get(tip)!;
    const m = world.map;
    const under = () =>
      world.boats.find(
        (b) =>
          b.state === 'moored' &&
          Math.max(Math.abs(m.xOf(b.berth) - m.xOf(tip)), Math.abs(m.yOf(b.berth) - m.yOf(tip))) <=
            1,
      );
    let lifts = 0;
    for (let t = 0; t < TICKS_PER_DAY * 6; t++) {
      world.step();
      // Each crate on the hook goes to a place on the tile beside it.
      const lift = jibLifts(world).get(crane);
      if (lift?.store && lift.place >= 0) {
        lifts++;
        expect(store.tiles![stackOf(store, lift.place)]).toBe(near);
      }
      expect(tilesOf(world, far).every((t) => t === near)).toBe(true);
      if (jibRoom(world, crane, store) === 0 && !crane.busy && under()) break;
    }
    expect(lifts).toBeGreaterThan(0);
    // Full beside it, room further off: it waits, and the boat under it too.
    expect(jibRoom(world, crane, store)).toBe(0);
    expect(cratesAt(store)).toBe(B.CRATES_PER_STORE_TILE);
    expect(bayRoom(store, false)).toBe(B.CRATES_PER_STORE_TILE);
    const boat = under()!;
    expect(boat).toBeDefined();
    const load = boat.crates;
    for (let t = 0; t < 100; t++) world.step();
    expect(boat.crates).toBe(load);
    expect(crane.busy).toBe(false);
    expect(craneWhy(world, crane)).toMatch(/full on the tiles right beside it/);
    expect(boatWhy(world, boat)).toMatch(/full on the tiles right beside the crane/);
    expect(world.snapshot().cranes.find((c) => c.idx === tip)!.storeRoom).toBe(0);
    // Not a red mark: it works once there is room.
    expect(problems(world).some((p) => p.type === 'crane' && p.idx === tip)).toBe(false);
  });

  it('has forklifts take the crates off the tiles beside it first, to make it room', () => {
    const { world, tip, near, far } = port();
    const store = world.bays.get(far)!;
    const crane = world.cranes.get(tip)!;
    // The tile beside it full, the one further off part full.
    const nearAt = store.tiles!.indexOf(near) * B.CRATES_PER_STORE_TILE;
    const farAt = store.tiles!.indexOf(far) * B.CRATES_PER_STORE_TILE;
    for (let k = 0; k < B.CRATES_PER_STORE_TILE; k++) {
      stockUp(world, store, [10], false, [nearAt + k]);
    }
    for (let k = 0; k < 8; k++) {
      stockUp(world, store, [10], false, [farAt + k]);
    }
    expect(jibRoom(world, crane, store)).toBe(0);
    buyForklift(world);
    const count = (tile: number) => tilesOf(world, far).filter((t) => t === tile).length;
    for (let t = 0; t < TICKS_PER_DAY && count(near) === B.CRATES_PER_STORE_TILE; t++) world.step();
    // Off the tile beside it, not the one further off.
    expect(count(near)).toBeLessThan(B.CRATES_PER_STORE_TILE);
    expect(count(far)).toBe(8);
    expect(jibRoom(world, crane, store)).toBeGreaterThan(0);
  });

  it('lifts on board only exports on the tiles beside it', () => {
    const { world, tip, near, far } = port();
    const store = world.bays.get(far)!;
    store.outgoing = true;
    const crane = world.cranes.get(tip)!;
    const farAt = store.tiles!.indexOf(far) * B.CRATES_PER_STORE_TILE;
    const nearAt = store.tiles!.indexOf(near) * B.CRATES_PER_STORE_TILE;
    for (let k = 0; k < 4; k++) {
      stockUp(world, store, [10], true, [farAt + k]);
    }
    expect(jibReady(world, crane, store)).toBe(0);
    for (let k = 0; k < 2; k++) {
      stockUp(world, store, [10], true, [nearAt + k]);
    }
    expect(jibReady(world, crane, store)).toBe(2);
    expect(tilesOf(world, far, true).filter((t) => t === near)).toHaveLength(2);
  });
});
