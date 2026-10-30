import { describe, expect, it } from 'vitest';
import { cargoOf, withCargo } from '../src/sim/cargo';
import { TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('Cargo', () => {
  it('rides along on a crate’s fee, leaving the money as it was to the cent', () => {
    for (const c of ['fish', 'ice', 'lobster', 'goods'] as const) {
      const fee = withCargo(35, c);
      expect(cargoOf(fee)).toBe(c);
      expect(Math.round(fee * 100) / 100).toBe(35);
      // Twelve of them on a truck still come to what twelve should.
      expect(Math.round(fee * 12 * 100) / 100).toBe(420);
    }
    // Older saves: what it holds is not on it.
    expect(cargoOf(20)).toBe('fish');
    expect(cargoOf(20, 'goods')).toBe('goods');
  });

  it('goes with each crate from the boat through the port onto the trucks', () => {
    const world: Any = World.create(7, 96);
    world.boats.length = 0;
    for (const c of world.contracts) {
      if (c.terms.kind === 'fishery') {
        c.terms.catch = 'lobster';
        c.nextBoatTick = world.tick + 10;
      }
    }
    const seen = new Set<string>();
    for (let k = 0; k < TICKS_PER_DAY * 2; k++) {
      world.step();
      if (k % 20) continue;
      const s = world.snapshot();
      for (const e of s.entities) for (const c of e.cargo ?? []) seen.add(`${e.kind}:${c}`);
      for (const b of s.bays) for (const c of b.cargo ?? []) seen.add(`bay:${c}`);
    }
    for (const where of ['boat', 'dockhand', 'bay', 'truck']) {
      expect(seen.has(`${where}:lobster`)).toBe(true);
      expect(seen.has(`${where}:fish`)).toBe(false);
    }
  });
});
