import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import * as B from '../src/sim/balance';
import { baysOpen } from '../src/sim/systems/roads/bays';

// A new game has no truck bay: the dockhands heap the crates at the road's
// end and the pickups load from the road beside it, until truck bays open
// (src/sim/systems/roads/bays.ts: addKerb, baysOpen).

describe('A new port without a truck bay', () => {
  beforeEach(() => (World.startBay = false));
  afterEach(() => (World.startBay = true));

  it('heaps the crates at the road’s end, the pickups take them, and truck bays open after enough', () => {
    const w = World.create(3);
    const kerb = [...w.bays.values()].find((b) => b.kerb)!;
    expect(kerb).toBeDefined();
    expect([...w.bays.values()].filter((b) => !b.kerb)).toHaveLength(0);
    expect(baysOpen(w)).toBe(false);
    expect(w.snapshot().progress.baysWhy).toMatch(/Truck bays open/);

    // Not before they open.
    const road = w.map.idx(w.map.xOf(kerb.idx) - 3, w.map.yOf(kerb.idx) - 1);
    w.events = [];
    w.command({ type: 'build', kind: 'truckBay', tiles: [road] });
    expect(w.events.some((e) => e.kind === 'message' && /Truck bays open/.test(e.text))).toBe(true);
    expect([...w.bays.values()].filter((b) => !b.kerb)).toHaveLength(0);

    // Nor building or bulldozing over the heap, the only place crates go.
    w.command({ type: 'build', kind: 'road', tiles: [kerb.idx] });
    w.command({ type: 'bulldoze', tiles: [kerb.idx] });
    expect(w.bays.get(kerb.idx)).toBe(kerb);

    let heaped = 0;
    let opened = -1;
    for (let k = 0; k < TICKS_PER_DAY * 6; k++) {
      w.step();
      heaped = Math.max(heaped, kerb.cells.filter(Boolean).length);
      expect(kerb.cells.filter(Boolean).length).toBeLessThanOrEqual(B.PILE_CRATES);
      if (opened < 0 && baysOpen(w)) opened = w.tick;
    }
    expect(heaped).toBeGreaterThan(0);
    // Pickups were loaded from it and paid for.
    expect(w.stats.trucks).toBeGreaterThan(3);
    expect(w.cash).toBeGreaterThan(5000);
    expect(opened).toBeGreaterThan(0);
    expect(w.snapshot().progress.baysWhy).toBeUndefined();
    // Drawn as a heap on the quay, not listed as a truck bay.
    const s = w.snapshot();
    expect(s.piles.some((p) => p.idx === kerb.idx)).toBe(true);
    expect(s.bays.some((b) => b.idx === kerb.idx)).toBe(false);
  }, 60_000);
});
