import { describe, expect, it } from 'vitest';
import { placementError } from '../src/sim/rules';
import { Build, Terrain } from '../src/sim/types';
import { World } from '../src/sim/world';

/** A clear tile of grass on the port's land, with clear grass round it. */
function openGround(w: World): number {
  const m = w.map;
  for (let y = 4; y < m.limit - 4; y++) {
    for (let x = 30; x < m.w - 4; x++) {
      const i = m.idx(x, y);
      const ok = [i, ...m.neighbors4(i)].every(
        (n) => m.build[n] === Build.None && m.terrain[n] === Terrain.Grass && m.deco[n] === 0,
      );
      if (ok && !placementError(m, 'footpath', i)) return i;
    }
  }
  throw new Error('no open ground');
}

describe('Depots and harbour offices', () => {
  it('lets a depot go up facing nothing machines drive on, and says why it is no use', () => {
    const w = World.create(7, 96);
    w.tier = 1;
    w.cash = 1e6;
    const i = openGround(w);
    w.command({ type: 'build', kind: 'depot', tiles: [i] });
    expect(w.map.build[i]).toBe(Build.Depot);
    const mark = w.snapshot().problems.find((p) => p.type === 'depot' && p.idx === i);
    expect(mark?.text).toMatch(/garage door faces no port road or quay/);
    expect(
      w.drainEvents().some((e) => e.kind === 'message' && /depot is no use yet/.test(e.text)),
    ).toBe(true);
    // A port road up to its door, and it is fine.
    const front = w.map.neighbors4(i).find((n) => {
      const [dx, dy] = [w.map.xOf(n) - w.map.xOf(i), w.map.yOf(n) - w.map.yOf(i)];
      const f = w.map.orient[i] & 3;
      return (
        [dx, dy].join() ===
        [
          [1, 0],
          [0, 1],
          [-1, 0],
          [0, -1],
        ][f].join()
      );
    })!;
    w.command({ type: 'build', kind: 'portRoad', tiles: [front] });
    expect(w.map.build[front]).toBe(Build.PortRoad);
    expect(w.snapshot().problems.some((p) => p.type === 'depot' && p.idx === i)).toBe(false);
  });

  it('lets a harbour office or hut go up over a port path or road', () => {
    const w = World.create(7, 96);
    w.tier = 1;
    w.cash = 1e6;
    const i = openGround(w);
    const [a, b] = w.map.neighbors4(i);
    w.command({ type: 'build', kind: 'footpath', tiles: [i, a] });
    w.command({ type: 'build', kind: 'office', tiles: [i] });
    expect(w.map.build[i]).toBe(Build.Office);
    // A port road two long, the hut on one end facing along it.
    const c = w.map.neighbors4(b).find((n) => n !== i && w.map.build[n] === Build.None)!;
    w.command({ type: 'build', kind: 'portRoad', tiles: [b, c] });
    expect(w.map.build[b]).toBe(Build.PortRoad);
    w.command({ type: 'build', kind: 'harbourHut', tiles: [b] });
    expect(w.map.build[b]).toBe(Build.HarbourHut);
    // Not over anything else.
    expect(placementError(w.map, 'office', i)).toMatch(/already built/);
  });
});
