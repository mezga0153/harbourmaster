import { describe, expect, it } from 'vitest';
import { cargoOf, withCargo } from '../src/sim/cargo';
import { makeOffer } from '../src/sim/contracts';
import { Rng } from '../src/sim/rng';
import { placementError } from '../src/sim/rules';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import { addContract } from '../src/sim/systems/economy';
import { wantsLoad } from '../src/sim/systems/cargo/exports';

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

  it('comes as ice by truck straight into a truck bay, no parking, for the dockhands to put on board the fishing boats', () => {
    const world: Any = World.create(7, 96);
    world.cash = 50_000;
    // No parking anywhere: an ice works' trucks need none.
    expect(world.map.build.some((b: number) => b === Build.Parking)).toBe(false);
    // A second truck bay, on the road beside the first and a path from it to
    // the port's: the catch and the ice keep to bays of their own.
    const m = world.map;
    const first = [...world.bays.keys()][0] as number;
    const [bx, by] = [m.xOf(first), m.yOf(first)];
    const spot = m.idx(bx - 1, by - 1);
    expect(placementError(m, 'truckBay', spot)).toBeNull();
    world.command({ type: 'build', kind: 'truckBay', tiles: [spot] });
    world.command({
      type: 'build',
      kind: 'footpath',
      tiles: [m.idx(bx, by - 1), m.idx(bx + 1, by - 1)],
    });
    expect(m.build[spot]).toBe(Build.TruckBay);
    // Ice comes off the truck by hand, never by itself.
    let byHand = 0;
    const wait = new Map<number, number>();
    let waited = 0;
    addContract(
      world,
      { kind: 'shipper', name: 'Test Ice', color: 0, perDay: 8, capacity: 6, fee: 8, goods: 'ice' },
      world.tick + 10,
      0,
    );
    const iced = new Set<number>();
    let inBay = false;
    for (let k = 0; k < TICKS_PER_DAY * 8 && iced.size < 2; k++) {
      world.step();
      if (world.people.some((p: Any) => p.truckId !== undefined && p.truckLoad === false)) byHand++;
      // How long an unloaded boat waits for ice there is in the port to take.
      const ice = [...world.bays.values()].reduce(
        (n: number, b: Any) => n + (b.exports?.length ?? 0),
        0,
      );
      for (const b of world.boats) {
        if (b.state === 'moored' && b.crates === 0 && ice > 0 && wantsLoad(world, b)) {
          wait.set(b.id, (wait.get(b.id) ?? 0) + 1);
          waited = Math.max(waited, wait.get(b.id)!);
        }
      }
      for (const b of world.bays.values()) {
        if ((b.exports ?? []).some((f: number) => cargoOf(f, 'goods') === 'ice')) {
          inBay = true;
          // Never in a bay with the catch.
          expect(b.crates.length).toBe(0);
        }
      }
      for (const b of world.boats) {
        if (b.vessel === 'smack' && (b.outFees ?? []).some((f: number) => cargoOf(f) === 'ice')) {
          iced.add(b.id);
        }
      }
    }
    expect(inBay).toBe(true);
    expect(byHand).toBeGreaterThan(0);
    // A boat unloaded and waiting for ice there is gets it well within a day.
    expect(waited).toBeLessThan(TICKS_PER_DAY * 0.6);
    // Fishing boats sail with ice on board, paid for as it goes on.
    expect(iced.size).toBeGreaterThanOrEqual(2);
    expect(world.stats.exported).toBeGreaterThan(0);
    const said = world
      .drainEvents()
      .flatMap((e: { kind: string; text?: string }) => (e.kind === 'message' ? [e.text] : []));
    expect(said.filter((t: string) => /parking|paperwork/i.test(t))).toEqual([]);
  });
});
