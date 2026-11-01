import { describe, expect, it } from 'vitest';
import { problems } from '../src/sim/systems/snapshot';
import { TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';

describe('A worker about to quit', () => {
  it('gets a red mark saying why, days before they go', () => {
    const w = World.create(575107);
    const marked = new Map<number, string>();
    const quit = new Map<number, number>();
    for (let d = 0; d < 30 && w.people.length; d++) {
      const before = w.people.map((p) => p.id);
      for (let t = 0; t < TICKS_PER_DAY; t++) {
        w.step();
        for (const m of problems(w))
          if (m.type === 'worker' && !marked.has(m.idx)) marked.set(m.idx, m.text);
      }
      for (const id of before) if (!w.people.some((p) => p.id === id)) quit.set(id, d);
    }
    expect(quit.size).toBeGreaterThan(0);
    for (const id of quit.keys()) {
      expect(marked.get(id)).toMatch(/break hut/);
    }
    // A happy new hand has none.
    const fresh = World.create(575107);
    expect(problems(fresh).filter((m) => m.type === 'worker')).toEqual([]);
  }, 60_000);
});
