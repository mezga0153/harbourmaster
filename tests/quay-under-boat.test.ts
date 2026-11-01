import { describe, expect, it } from 'vitest';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';

describe('A jetty made a quay', () => {
  it('goes up under a boat moored at it, which unloads and sails as before', () => {
    const w = World.create(7, 96);
    w.tier = 1;
    w.cash = 1_000_000;
    const m = w.map;
    let boat;
    for (let t = 0; t < TICKS_PER_DAY * 2 && !boat; t++) {
      w.step();
      boat = w.boats.find((b) => b.state === 'moored' && b.crates > 0);
    }
    expect(boat, 'a boat moored at the jetty').toBeDefined();
    const jetty = [...m.build.keys()].filter((i) => m.build[i] === Build.Jetty);
    w.command({
      type: 'build',
      kind: 'office',
      tiles: [m.build.findIndex((b, i) => b === Build.None && i > 0)],
    });
    w.command({ type: 'build', kind: 'quay', tiles: jetty });
    expect(jetty.every((i) => m.build[i] === Build.Quay)).toBe(true);
    const id = boat!.id;
    const unloaded = () => w.boats.find((b) => b.id === id)?.state !== 'moored';
    for (let t = 0; t < TICKS_PER_DAY && !unloaded(); t++) w.step();
    expect(unloaded()).toBe(true);
    expect(w.stats.cratesHandled).toBeGreaterThan(0);
  });
});
