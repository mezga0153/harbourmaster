import * as B from '../src/sim/balance';
import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../src/sim/types';
import { wharf } from './wharf';

/** Runs the port up to `days`, until the advisor says to store on the quay. */
function told(world: ReturnType<typeof wharf>, days: number): boolean {
  for (let k = 0; k < TICKS_PER_DAY * days && !world.tipsSeen.has('quayStorage'); k++) {
    world.step();
  }
  return world.tipsSeen.has('quayStorage');
}

describe('The advisor says to mark storage out on the quay', () => {
  it('once boats queue while the dockhands carry their crates across the port', () => {
    const world = wharf(4, 2);
    expect(told(world, 5)).toBe(true);
    expect(world.carryWalk).toBeGreaterThan(B.LONG_CARRY_TILES);
  }, 120_000);

  it('never, with the storage on the quay by the berths, though boats still wait at anchor', () => {
    const world = wharf(4, 2, true);
    let anchored = 0;
    for (let k = 0; k < TICKS_PER_DAY * 5; k++) {
      world.step();
      for (const b of world.boats) {
        if (b.state === 'anchored') anchored = Math.max(anchored, b.anchorTicks);
      }
    }
    expect(world.tipsSeen.has('quayStorage')).toBe(false);
    expect(world.carryWalk).toBeLessThan(5);
    expect(anchored).toBeGreaterThan(B.ANCHOR_PENALTY_TICKS);
  }, 120_000);
});
