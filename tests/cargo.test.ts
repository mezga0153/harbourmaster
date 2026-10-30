import { describe, expect, it } from 'vitest';
import { cargoOf, withCargo } from '../src/sim/cargo';
import { makeOffer } from '../src/sim/contracts';
import { Rng } from '../src/sim/rng';
import { Build, TICKS_PER_DAY, Terrain } from '../src/sim/types';
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

  it('comes as lobster from lobstermen, a small catch at a fine price, among the fishery offers', () => {
    const rng = new Rng(5);
    let lobster = 0;
    let fish = 0;
    for (let k = 0; k < 200; k++) {
      const offer = makeOffer(rng, k, 0, 'fishery', new Set(), 0);
      if (offer?.terms.kind !== 'fishery') continue;
      if (offer.terms.catch === 'lobster') {
        lobster++;
        expect(offer.terms.vessel).toBe('smack');
        expect(offer.terms.fee).toBeGreaterThanOrEqual(40);
        expect(offer.terms.cratesMax).toBeLessThanOrEqual(8);
      } else fish++;
    }
    expect(lobster).toBeGreaterThan(20);
    expect(fish).toBeGreaterThan(lobster);
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

  it('comes as ice by truck into a truck bay, for the dockhands to put on board the fishing boats', () => {
    const world: Any = World.create(7, 96);
    world.cash = 50_000;
    const m = world.map;
    // Parking by the road for the ice trucks to do their paperwork in.
    const r = m.yOf(m.entry);
    const free = (x: number, y: number) =>
      m.inBounds(x, y) && m.terrain[m.idx(x, y)] === Terrain.Grass && m.build[m.idx(x, y)] === 0;
    const x = [...Array(m.w).keys()].find(
      (x) =>
        [-1, 0, 1, 2].every((d) => m.build[m.idx(x + d, r)] === Build.Road) &&
        [-1, 0, 1, 2].every((d) => free(x + d, r + 1) && free(x + d, r + 2)),
    )!;
    const lot = [m.idx(x, r + 1), m.idx(x + 1, r + 1)];
    const loop = [r + 1, r + 2].flatMap((y) => [-1, 0, 1, 2].map((d) => m.idx(x + d, y)));
    world.command({ type: 'build', kind: 'road', tiles: loop.filter((t) => !lot.includes(t)) });
    world.command({ type: 'build', kind: 'road', tiles: lot });
    world.command({ type: 'build', kind: 'parking', tiles: lot });
    world['addContract'](
      { kind: 'shipper', name: 'Test Ice', color: 0, perDay: 8, capacity: 6, fee: 8, goods: 'ice' },
      world.tick + 10,
      0,
    );
    const iced = new Set<number>();
    let inBay = false;
    for (let k = 0; k < TICKS_PER_DAY * 8 && iced.size < 2; k++) {
      world.step();
      for (const b of world.bays.values()) {
        if ((b.exports ?? []).some((f: number) => cargoOf(f, 'goods') === 'ice')) inBay = true;
      }
      for (const b of world.boats) {
        if (b.vessel === 'smack' && (b.outFees ?? []).some((f: number) => cargoOf(f) === 'ice')) {
          iced.add(b.id);
        }
      }
    }
    expect(inBay).toBe(true);
    // Fishing boats sail with ice on board, paid for as it goes on.
    expect(iced.size).toBeGreaterThanOrEqual(2);
    expect(world.stats.exported).toBeGreaterThan(0);
  });
});
