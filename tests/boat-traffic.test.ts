import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import { playDay } from './bot';
import { addContract } from '../src/sim/systems/economy';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Clear water between two hulls, each its keel line with half its beam all round; below zero they overlap. */
function gap(a: Any, b: Any): number {
  const seg = (p: Any) => {
    const v = (B.VESSELS as Any)[p.vessel];
    const h = v.length / 2 - v.beam / 2;
    return [
      p.x - Math.cos(p.dir) * h,
      p.y - Math.sin(p.dir) * h,
      p.x + Math.cos(p.dir) * h,
      p.y + Math.sin(p.dir) * h,
    ];
  };
  const to = (px: number, py: number, x0: number, y0: number, x1: number, y1: number) => {
    const vx = x1 - x0;
    const vy = y1 - y0;
    const l = vx * vx + vy * vy;
    const t = l > 0 ? Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / l)) : 0;
    return Math.hypot(px - x0 - vx * t, py - y0 - vy * t);
  };
  const [a0x, a0y, a1x, a1y] = seg(a);
  const [b0x, b0y, b1x, b1y] = seg(b);
  const side = (x0: number, y0: number, x1: number, y1: number, px: number, py: number) =>
    (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
  const crossed =
    side(a0x, a0y, a1x, a1y, b0x, b0y) * side(a0x, a0y, a1x, a1y, b1x, b1y) < 0 &&
    side(b0x, b0y, b1x, b1y, a0x, a0y) * side(b0x, b0y, b1x, b1y, a1x, a1y) < 0;
  const keels = crossed
    ? 0
    : Math.min(
        to(a0x, a0y, b0x, b0y, b1x, b1y),
        to(a1x, a1y, b0x, b0y, b1x, b1y),
        to(b0x, b0y, a0x, a0y, a1x, a1y),
        to(b1x, b1y, a0x, a0y, a1x, a1y),
      );
  const av = (B.VESSELS as Any)[a.vessel];
  const bv = (B.VESSELS as Any)[b.vessel];
  return keels - (av.beam + bv.beam) / 2;
}

/** The player's coast, with smacks coming in more often than its berths can take. */
function busySmacks(): Any {
  const world: Any = World.create(844241);
  for (let k = 0; k < 3; k++) {
    addContract(
      world,
      {
        kind: 'fishery',
        vessel: 'smack',
        name: `Extra ${k}`,
        color: 0,
        boatEvery: 0.5,
        cratesMin: 4,
        cratesMax: 6,
        fee: 20,
      },
      world.tick + 10 + k * 50,
      0,
    );
  }
  return world;
}

describe('Small boats in a busy harbour', () => {
  // Ports built up by the playthrough bot for a week, where boats come and
  // go round the jetties it has put up, then left to run.
  it.each([1, 2])(
    'never sail into each other, coming alongside, casting off or out on the water (seed %i)',
    (seed) => {
      const world: Any = World.create(seed);
      for (let d = 0; d < 8; d++) {
        for (let t = 0; t < TICKS_PER_DAY; t++) world.step();
        playDay(world);
      }
      const served = world.stats.boats;
      let touching = 0;
      let worst = 0;
      for (let t = 0; t < TICKS_PER_DAY * 4; t++) {
        world.step();
        const bs = world.boats;
        for (let i = 0; i < bs.length; i++) {
          for (let j = i + 1; j < bs.length; j++) {
            const a = bs[i];
            const b = bs[j];
            if (Math.hypot(a.x - b.x, a.y - b.y) > 4) continue;
            if (a.state === 'moored' && b.state === 'moored') continue;
            const g = gap(a, b);
            if (g < 0) touching++;
            worst = Math.min(worst, g);
          }
        }
      }
      expect(world.stats.boats - served).toBeGreaterThan(3);
      expect(touching).toBe(0);
      expect(worst).toBeGreaterThanOrEqual(0);
    },
    60_000,
  );

  it('stay in sight as they sail out, until well out on the water', () => {
    const world = busySmacks();
    const last = new Map<number, Any>();
    let left = 0;
    for (let t = 0; t < TICKS_PER_DAY * 3; t++) {
      world.step();
      const now = new Set(world.boats.map((b: Any) => b.id));
      for (const [id, b] of last) {
        if (now.has(id) || b.state !== 'leaving') continue;
        left++;
        // Gone only once as far out as boats come into sight on their way in.
        expect(b.sailed).toBeGreaterThanOrEqual(B.SAIL_IN_TILES - 1);
      }
      last.clear();
      for (const b of world.boats) last.set(b.id, { state: b.state, sailed: b.sailed });
    }
    expect(left).toBeGreaterThan(1);
  }, 60_000);
});
