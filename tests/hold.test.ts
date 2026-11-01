import { describe, expect, it } from 'vitest';
import {
  clear,
  count,
  filled,
  largeShape,
  put,
  sized,
  stackShape,
  take,
  waits,
  type Cells,
} from '../src/sim/systems/cargo/hold';

// Crates where they stand (src/sim/systems/cargo/hold.ts): a cell for each
// place a crate can be, the crate in it or null.

describe('a hold', () => {
  it('keeps a crate in one cell and a cell to one crate', () => {
    const cells: Cells = sized([], stackShape(2).cap);
    expect(cells.length).toBe(32);
    put(cells, 3, { fee: 10 });
    put(cells, 5, { fee: 20, out: true });
    expect(() => put(cells, 3, { fee: 30 })).toThrow();
    expect(count(cells)).toBe(2);
    expect(count(cells, false)).toBe(1);
    expect(filled(cells, true)).toEqual([5]);
    expect(take(cells, 3).fee).toBe(10);
    expect(() => take(cells, 3)).toThrow();
    expect(filled(cells)).toEqual([5]);
  });

  it('stacks crate storage two to a layer, four high, a row of eight', () => {
    const sh = stackShape(1);
    expect(sh.cap).toBe(16);
    expect([sh.below(0), sh.below(2), sh.below(8), sh.below(14)]).toEqual([-1, 0, -1, 12]);
    expect([sh.above(6), sh.above(7), sh.above(13)]).toEqual([-1, -1, 15]);
    expect(sh.height(15)).toBe(3);
    expect(stackShape(3).stack(40)).toBe(2);
    const cells = sized([], sh.cap);
    put(cells, 0, { fee: 1 });
    expect(clear(cells, sh, 0)).toBe(true);
    put(cells, 2, { fee: 1 });
    expect(clear(cells, sh, 0)).toBe(false);
  });

  it('stacks a large bay a layer of sixteen at a time', () => {
    const sh = largeShape();
    expect(sh.cap).toBe(28);
    expect([sh.below(3), sh.below(20), sh.above(11), sh.above(12)]).toEqual([-1, 4, 27, -1]);
  });

  it('knows when a crate still waits', () => {
    expect(waits({ fee: 1 }, 100)).toBe(false);
    expect(waits({ fee: 1, clears: 150 }, 100)).toBe(true);
    expect(waits({ fee: 1, clears: 150 }, 150)).toBe(false);
  });
});
