import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../src/sim/types';
import { Build } from '../src/sim/types';
import { World } from '../src/sim/world';
import {
  buried,
  buriedCount,
  collectable,
  reachable,
  takesExports,
  takesImports,
} from '../src/sim/systems/cargo/stores';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * A port with one container yard, three tiles in a row along the shore
 * road, a port road along its stacks' side, a depot on it and a reach
 * stacker, and nothing else for the stacker to do.
 */
function yardPort() {
  const world: Any = World.create(7, 96);
  world.tier = 2;
  world.cash = 1_000_000;
  const m = world.map;
  const r = m.yOf(m.entry);
  let shore = 0;
  while (m.build[m.idx(shore + 1, r)] !== Build.Jetty) shore++;
  const x0 = shore - 8;
  const row = (y: number, a: number, b: number) =>
    Array.from({ length: b - a + 1 }, (_, k) => m.idx(a + k, y));
  const yard = row(r - 2, x0, x0 + 2);
  const side = row(r - 1, x0 - 2, x0 + 3);
  const depot = m.idx(x0 - 3, r - 1);
  world.command({ type: 'bulldoze', tiles: [...yard, ...side, depot] });
  world.command({ type: 'build', kind: 'portRoad', tiles: [...yard, ...side] });
  world.command({ type: 'store', tiles: yard, kind: 'boxes', on: true });
  // Its door onto the port road beside it, whichever way that is.
  for (let facing = 0; facing < 4 && m.build[depot] !== Build.Depot; facing++) {
    world.command({ type: 'build', kind: 'depot', tiles: [depot], facing });
  }
  world.command({ type: 'buyMachine', kind: 'stacker', tile: depot });
  const y = world.yards.get(yard[0]);
  expect(y, 'the yard').toBeDefined();
  expect(m.build[depot]).toBe(Build.Depot);
  expect(world.people.filter((p: Any) => p.kind === 'stacker').length).toBe(1);
  return { world, m, yard: y, tiles: yard };
}

/** Put containers in the yard at the given slots, cleared or clearing later. */
function fill(world: Any, yard: Any, at: { slot: number; clear: boolean }[]) {
  yard.boxes = at.map((_, k) => 100 + k);
  yard.boxReady = at.map((a) => (a.clear ? 0 : world.tick + 2000));
  yard.boxSlots = at.map((a) => a.slot);
  yard.boxLooks = at.map((_, k) => k);
}

describe('A reach stacker with time on its hands', () => {
  it('finds the stacks with a cleared container under one in customs, soonest freed first', () => {
    const { world, yard } = yardPort();
    // Tile 0, stack 0: cleared on the ground, two in customs on it. Tile 1,
    // stack 1: cleared with one on it. Tile 2: in customs only.
    fill(world, yard, [
      { slot: 0, clear: true },
      { slot: 2, clear: false },
      { slot: 4, clear: false },
      { slot: 7, clear: true },
      { slot: 9, clear: false },
      { slot: 12, clear: false },
    ]);
    expect(buriedCount(world, yard)).toBe(2);
    expect(buried(world, yard)).toEqual([
      { at: 4, tile: 1 },
      { at: 2, tile: 0 },
    ]);
  });

  it('restacks the yard so the trucks can get at the cleared containers, losing none', () => {
    const { world, yard } = yardPort();
    fill(world, yard, [
      { slot: 0, clear: true },
      { slot: 2, clear: false },
      { slot: 7, clear: true },
      { slot: 9, clear: false },
    ]);
    const before = [...yard.boxReady].sort();
    expect(reachable(world, yard)).toBe(0);
    let restacking = 0;
    for (let k = 0; k < TICKS_PER_DAY && buriedCount(world, yard) > 0; k++) {
      world.step();
      if (world.people.some((p: Any) => p.restack)) restacking++;
    }
    expect(restacking).toBeGreaterThan(0);
    expect(buriedCount(world, yard)).toBe(0);
    expect(reachable(world, yard)).toBe(2);
    // Every container is still there, clearing when it did.
    for (let k = 0; k < 60; k++) world.step();
    const stacker = world.people.find((p: Any) => p.kind === 'stacker');
    expect(stacker.carrying).toBe(0);
    expect(yard.boxes.length).toBe(4);
    expect([...yard.boxReady].sort()).toEqual(before);
    // And it does not go on to bury them again.
    expect(buriedCount(world, yard)).toBe(0);
    expect(stacker.state).not.toBe('toPickup');
  });

  it('leaves a yard alone when there is nowhere to set a container down without burying another', () => {
    const { world, yard } = yardPort();
    // Full but for one place, on top of the cleared one itself.
    const at: { slot: number; clear: boolean }[] = [];
    for (let k = 0; k < 18; k++) if (k !== 4) at.push({ slot: k, clear: k === 0 });
    fill(world, yard, at);
    expect(buriedCount(world, yard)).toBe(1);
    for (let k = 0; k < 200; k++) world.step();
    expect(world.people.some((p: Any) => p.restack)).toBe(false);
    expect(yard.boxes.length).toBe(17);
  });
});

describe('Storage stopped from taking cargo', () => {
  it('takes no more coming in or going out, but its own still leaves', () => {
    const world: Any = World.create(7, 96);
    const store: Any = { idx: 1, tiles: [1], crates: [5], boxes: [], incoming: 0, boxIncoming: 0 };
    const out: Any = { ...store, idx: 2, tiles: [2], outgoing: true, exports: [7] };
    expect(takesImports(world, store)).toBe(true);
    expect(takesExports(world, out)).toBe(true);
    store.shut = true;
    out.shut = true;
    expect(takesImports(world, store)).toBe(false);
    expect(takesExports(world, out)).toBe(false);
    // Truck bays have no such switch.
    expect(takesImports(world, { ...store, tiles: undefined })).toBe(true);
    // What is in it is still there for the trucks.
    expect(collectable(world, store)).toBe(1);
  });
});
