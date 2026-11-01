import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { placementError } from '../src/sim/rules';
import { docks } from '../src/sim/systems/boats/berthing';
import { problems } from '../src/sim/systems/snapshot';
import { World } from '../src/sim/world';

describe('A dock no one coordinates', () => {
  it('has a red mark over it saying an office or hut is wanted', () => {
    const w = World.create(7, 96);
    w.cash = 1_000_000;
    const m = w.map;
    expect(problems(w).filter((p) => p.type === 'dock')).toEqual([]);
    // More jetties than run on their own with no harbour office or hut.
    for (let i = 0; i < m.build.length && docks(w).length <= B.FREE_DOCKS; i++) {
      if (placementError(m, 'jetty', i)) continue;
      // Away from the others, so it is a dock of its own.
      const [x, y] = [m.xOf(i), m.yOf(i)];
      const near = docks(w).some((d) =>
        d.tiles.some((t) => Math.abs(m.xOf(t) - x) + Math.abs(m.yOf(t) - y) < 4),
      );
      if (near) continue;
      w.command({ type: 'build', kind: 'jetty', tiles: [i] });
    }
    expect(docks(w).length).toBe(B.FREE_DOCKS + 1);
    const marks = problems(w).filter((p) => p.type === 'dock');
    expect(marks).toHaveLength(1);
    expect(marks[0].text).toMatch(/Boats do not use this jetty.*harbourmaster's hut/);
  });
});
