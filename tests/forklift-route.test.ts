import { describe, expect, it } from 'vitest';
import { crateTiles } from '../src/sim/systems/cargo/stores';
import { wharf } from './wharf';
import { stockUp } from './stock';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('A forklift’s way across the port', () => {
  /** The Coastal Wharf's crate storage in the yard behind its gate, two rows of two, and a forklift. */
  function yard() {
    const world: Any = wharf(4, 2);
    const m = world.map;
    const store = [...world.bays.values()].find((b: Any) => b.tiles?.length === 4 && !b.outgoing);
    const xs = store.tiles.map((t: number) => m.xOf(t));
    const ys = store.tiles.map((t: number) => m.yOf(t));
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    const y = Math.min(...ys);
    // Either side of its first row, on the road round it.
    const from = m.idx(x0 - 1, y);
    const to = m.idx(x1 + 1, y);
    const p = world.people.find((q: Any) => q.kind === 'forklift');
    return { world, m, store, from, to, p };
  }

  it('goes round storage full of crates where there is a way round, not across it', () => {
    const { world, store, from, to, p } = yard();
    // Empty, it drives straight across.
    const empty: number[] = world.pathFor(p, from, to);
    expect(empty.some((i) => store.tiles.includes(i))).toBe(true);
    {
      store.cells = [];
      stockUp(
        world,
        store,
        Array.from({ length: 64 }, () => 25),
      );
    }
    world.tick++;
    const full = crateTiles(world);
    for (const t of store.tiles) expect(full.has(t)).toBe(true);
    const way: number[] = world.pathFor(p, from, to);
    expect(way).not.toBeNull();
    expect(way.some((i) => store.tiles.includes(i))).toBe(false);
    // Only a little further.
    expect(way.length).toBeLessThanOrEqual(empty.length + 2);
  });

  it('drives in among the crates only on the tile it works at', () => {
    const { world, store, from, p } = yard();
    {
      store.cells = [];
      stockUp(
        world,
        store,
        Array.from({ length: 64 }, () => 25),
      );
    }
    world.tick++;
    const goal = store.tiles[store.tiles.length - 1];
    const way: number[] = world.pathFor(p, from, goal);
    expect(way[way.length - 1]).toBe(goal);
    expect(way.filter((i) => store.tiles.includes(i))).toEqual([goal]);
  });

  it('still crosses crates where there is no other way', () => {
    const { world, m, store, from, to, p } = yard();
    {
      store.cells = [];
      stockUp(
        world,
        store,
        Array.from({ length: 64 }, () => 25),
      );
    }
    // The road round it gone: only across the storage.
    const round = [...m.build.keys()].filter(
      (i: number) =>
        !store.tiles.includes(i) &&
        i !== from &&
        i !== to &&
        store.tiles.some(
          (t: number) => Math.abs(m.xOf(t) - m.xOf(i)) <= 2 && Math.abs(m.yOf(t) - m.yOf(i)) <= 2,
        ),
    );
    for (const i of round) m.build[i] = 0;
    world.machineCache = null;
    world.tick++;
    const way: number[] = world.pathFor(p, from, to);
    expect(way).not.toBeNull();
    expect(way.some((i) => store.tiles.includes(i))).toBe(true);
  });
});
