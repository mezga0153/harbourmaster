import { describe, expect, it } from 'vitest';
import { sentTo, townDay, townWants, BUSINESSES } from '../src/sim/town';
import { Build } from '../src/sim/types';
import { World } from '../src/sim/world';

describe("The town's businesses", () => {
  it('count every crate of what they take sent out by road, delivered or not, up to what they take', () => {
    const w = World.create(7, 96);
    const t = w.town!;
    const m = w.map;
    // A fish market in town.
    const spot = m.build.findIndex((b) => b === Build.Cottage);
    m.build[spot] = Build.FishMarket;
    const want = townWants(m)[Build.FishMarket]!;
    expect(want).toBe(BUSINESSES[Build.FishMarket]!.perDay);
    t.sent = { fish: want - 2, lobster: 5 };
    expect(sentTo(t, m)[Build.FishMarket]).toBe(want - 2);
    // More than it takes counts only up to that.
    t.sent = { fish: want + 10 };
    expect(sentTo(t, m)[Build.FishMarket]).toBe(want);
    t.sentFor = 0;
    townDay(t, 0, m);
    expect(t.sentFor).toBeCloseTo(want * 0.3);
    expect(t.sent).toEqual({});
  });
});
