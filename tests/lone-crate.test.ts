import { describe, expect, it } from 'vitest';
import type { Bay } from '../src/sim/state';
import { loadSlot } from '../src/sim/systems/cargo/places';

describe('Crate storage', () => {
  it('takes one crate beside one left on its own, as a jib crane leaves them', () => {
    // A tile of storage with a lone crate at the foot of each row: once
    // forklifts bringing one crate each waited there for good.
    const cells = Array.from({ length: 16 }, () => null as Bay['cells'][number]);
    cells[0] = { fee: 20, at: 0 };
    cells[8] = { fee: 20, at: 0 };
    const bay = { idx: 0, tiles: [0], cells, large: true, warehouse: true } as unknown as Bay;
    const used = new Set([0, 8]);
    expect(loadSlot(bay, 1, used)).toBe(1);
    // Never on the right of an empty pair, nor a full load beside a lone one.
    expect(loadSlot(bay, 1, new Set([0, 1, 8, 9]))).toBe(2);
    expect(loadSlot(bay, 2, used)).toBe(-1);
  });
});
