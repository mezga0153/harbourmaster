import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { cargoOf } from '../src/sim/cargo';
import { TICKS_PER_DAY } from '../src/sim/types';
import { shipOut as shipOutOf } from '../src/sim/systems/cargo/exports';
import { wharf } from './wharf';
import { cratesAt } from './stock';
import { holds } from '../src/sim/systems/cargo/customs';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** The cannery's truck standing at the outgoing storage to be unloaded, after running on till one is. */
function delivering(world: Any): Any {
  for (let k = 0; k < TICKS_PER_DAY; k++) {
    world.step();
    const t = world.trucks.find((q: Any) => q.exports && q.state === 'delivering');
    if (t) return t;
  }
  throw new Error('no shipper truck came in to unload');
}

/** The port's crew down to `kinds` only. */
function crew(world: Any, ...kinds: string[]): void {
  world.people = world.people.filter((p: Any) => kinds.includes(p.kind));
}

/**
 * Run on while the truck stands there, noting each time crates come off
 * it: how many, and whether a worker took them up as they did.
 */
function watch(world: Any, t: Any, ticks: number) {
  const out = world.bays.get(t.bayIdx);
  const offs: { n: number; inHands: boolean; by?: string }[] = [];
  const papers: number[] = [];
  let cargo = t.cargo;
  let stored = cratesAt(out, true);
  let held = 0;
  // Till the last crate off it is set down.
  const busy = () => t.state === 'delivering' || world.people.some((q: Any) => q.truckId === t.id);
  for (let k = 0; k < ticks && busy(); k++) {
    world.step();
    if (t.cargo < cargo) {
      const p = world.people.find((q: Any) => q.truckId === t.id && q.carrying > 0);
      offs.push({ n: cargo - t.cargo, inHands: p?.carrying === cargo - t.cargo, by: p?.kind });
      cargo = t.cargo;
    }
    const now = cratesAt(out, true);
    // Each set down starts its papers there and then.
    if (now > stored) {
      const h = holds(world, out, true);
      for (let j = held; j < h.length; j++) papers.push(h[j] - world.tick);
      held = h.length;
      stored = now;
    }
  }
  return { offs, papers };
}

describe("A shipper's truck at outgoing crate storage", () => {
  it('stays loaded with no dockhand or forklift to unload it, and says why', () => {
    const world = wharf(4, 2);
    crew(world);
    const t = delivering(world);
    const n = t.cargo;
    for (let k = 0; k < TICKS_PER_DAY / 4; k++) world.step();
    expect(t.state).toBe('delivering');
    expect(t.cargo).toBe(n);
    expect(cratesAt(world.bays.get(t.bayIdx), true)).toBe(0);
    const view = world.snapshot().entities.find((e: Any) => e.id === t.id);
    expect(view.activity).toBe('Waiting for a dockhand or forklift to unload it');
    expect(view.why).toMatch(/Dockhands or forklifts unload/);
  });

  it('is unloaded crate by crate by dockhands, into the storage beside it, its papers starting', () => {
    const world = wharf(4, 2);
    crew(world, 'dockhand');
    const t = delivering(world);
    const n = t.cargo;
    const { offs, papers } = watch(world, t, TICKS_PER_DAY / 2);
    expect(t.state).not.toBe('delivering');
    expect(t.cargo).toBe(0);
    expect(offs.reduce((a, o) => a + o.n, 0)).toBe(n);
    for (const o of offs) expect(o).toEqual({ n: 1, inHands: true, by: 'dockhand' });
    // The cannery's papers are done the same time after each is set down.
    expect(papers.length).toBe(n);
    for (const d of papers) expect(d).toBe(B.EXPORT_PAPERS_TICKS);
    const view = world.snapshot();
    expect(view.entities.find((e: Any) => e.id === t.id)?.why).toBeUndefined();
  });

  it('is unloaded a pallet at a time by forklifts', () => {
    const world = wharf(4, 2);
    crew(world, 'forklift');
    const t = delivering(world);
    const n = t.cargo;
    const { offs } = watch(world, t, TICKS_PER_DAY / 2);
    expect(t.cargo).toBe(0);
    expect(offs.reduce((a, o) => a + o.n, 0)).toBe(n);
    for (const o of offs) {
      expect(o.inHands).toBe(true);
      expect(o.by).toBe('forklift');
      expect(o.n).toBeLessThanOrEqual(B.FORKLIFT_CAPACITY);
    }
    expect(offs.filter((o) => o.n === B.FORKLIFT_CAPACITY).length).toBeGreaterThanOrEqual(
      Math.floor(n / B.FORKLIFT_CAPACITY) - 1,
    );
  });

  it('has its crates go out on coasters afterwards', () => {
    const world = wharf(4, 2);
    let canned = 0;
    const shipOut = shipOutOf.bind(null, world);
    world.shipOut = (b: Any, load: Any[], slot?: number) => {
      canned += load.filter((c) => cargoOf(c.fee ?? c, 'goods') === 'canned').length;
      return shipOut(b, load, slot);
    };
    for (let k = 0; k < TICKS_PER_DAY * 4; k++) world.step();
    expect(canned).toBeGreaterThan(0);
    // None was ever unloaded with no one to take it.
    expect(
      world.trucks.filter((q: Any) => q.exports && q.state === 'delivering').length,
    ).toBeLessThan(3);
  });
});
