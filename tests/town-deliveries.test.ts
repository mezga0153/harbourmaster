import { describe, expect, it } from 'vitest';
import { cargoOf, withCargo, type Cargo } from '../src/sim/cargo';
import { frontOf } from '../src/sim/rules';
import { BUSINESSES, townWants } from '../src/sim/town';
import { Build, isPublicRoad, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import { cratesFor, cratesOff } from '../src/sim/systems/truckLoading';
import { deliverInTown } from '../src/sim/systems/roads/traffic';
import { updateTruck } from '../src/sim/systems/roads/trucks';
import { stockUp } from './stock';
import { feesOn } from '../src/sim/systems/cargo/beds';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** A town with these businesses in it, put up in place of homes facing its streets. */
function townWith(codes: number[]): Any {
  const world: Any = World.create(7, 96);
  const m = world.map;
  const homes: number[] = [];
  for (let i = 0; i < m.build.length; i++) {
    if (m.build[i] !== Build.Cottage && m.build[i] !== Build.House) continue;
    const front = frontOf(m, i, m.orient[i] & 3);
    if (front >= 0 && isPublicRoad(m.build[front])) homes.push(i);
  }
  expect(homes.length).toBeGreaterThanOrEqual(codes.length);
  codes.forEach((code, k) => (m.build[homes[k]] = code));
  world.town.wants = townWants(m);
  return world;
}

/** A crate truck at the port's truck bay, loaded with crates of these kinds. */
function truckWith(world: Any, kinds: Cargo[]): Any {
  const bay = [...world.bays.values()][0];
  expect(bay).toBeDefined();
  const m = world.map;
  const fees = kinds.map((c) => withCargo(30, c));
  return {
    id: 999,
    x: m.xOf(bay.idx) + 0.5,
    y: m.yOf(bay.idx) + 0.5,
    dir: 0,
    path: [],
    state: 'loading',
    contractId: -1,
    company: 'Test',
    capacity: 12,
    bayIdx: bay.idx,
    cargo: fees.length,
    value: fees.reduce((a, f) => a + f, 0),
    load: fees.map((fee) => ({ fee, at: 0 })),
    boxes: false,
    idle: 0,
    timer: 0,
  };
}

/** The business a truck of these crates is sent to in town, or null. */
function sentTo(world: Any, kinds: Cargo[]): number | null {
  const t = truckWith(world, kinds);
  if (!deliverInTown(world, t)) return null;
  return world.map.build[t.drop];
}

describe('Deliveries in town', () => {
  it('take each kind of crate only to a business that uses it', () => {
    const world = townWith([Build.FishMarket, Build.Restaurant, Build.BuildersYard]);
    const fish = Array<Cargo>(6).fill('fish');
    expect(sentTo(world, fish)).toBe(Build.FishMarket);
    expect(sentTo(world, ['lobster', 'lobster'])).toBe(Build.Restaurant);
    expect(sentTo(world, ['timber', 'timber', 'timber'])).toBe(Build.BuildersYard);
    // Nobody in town takes goods without a department store: out by road.
    expect(sentTo(world, ['goods', 'goods'])).toBeNull();
  });

  it('keep what each business takes apart, so one kind never uses up another’s', () => {
    const world = townWith([Build.FishMarket, Build.Restaurant, Build.BuildersYard]);
    const yard = BUSINESSES[Build.BuildersYard]!.perDay;
    // The builders' yard takes so much timber a day, and no more.
    const t = truckWith(world, Array<Cargo>(12).fill('timber'));
    expect(deliverInTown(world, t)).toBe(true);
    expect(t.dropCount).toBe(Math.min(12, yard));
    expect(world.town.wants[Build.BuildersYard]).toBe(yard - t.dropCount);
    expect(world.town.wants[Build.FishMarket]).toBe(BUSINESSES[Build.FishMarket]!.perDay);
    world.town.wants[Build.BuildersYard] = 0;
    expect(sentTo(world, ['timber'])).toBeNull();
    // The market still takes its fish.
    expect(sentTo(world, ['fish'])).toBe(Build.FishMarket);
  });

  it('send fish to the cannery too, and timber nowhere without a builders’ yard', () => {
    const world = townWith([Build.Cannery, Build.Restaurant]);
    expect(sentTo(world, ['fish', 'fish'])).toBe(Build.Cannery);
    expect(sentTo(world, ['timber'])).toBeNull();
    expect(sentTo(world, ['lobster'])).toBe(Build.Restaurant);
  });

  it('drop off only the crates the business takes, the rest going on by road', () => {
    const world = townWith([Build.FishMarket]);
    // A mixed load: the market has no use for the lobster.
    const t = truckWith(world, ['fish', 'lobster', 'fish', 'lobster']);
    expect(deliverInTown(world, t)).toBe(true);
    expect(t.dropCount).toBe(2);
    t.state = 'unloading';
    t.timer = 1e6;
    world.trucks.push(t);
    updateTruck(world, t);
    expect(t.cargo).toBe(2);
    expect(feesOn(world, t).map((f: number) => cargoOf(f))).toEqual(['lobster', 'lobster']);
    expect(Math.round(t.value)).toBe(Math.round(2 * withCargo(30, 'lobster')));
  });
});

describe('Crate trucks', () => {
  it('load any crates ready for them, of whatever kinds, till they are full', () => {
    const world: Any = townWith([Build.FishMarket, Build.Restaurant]);
    const bay = [...world.bays.values()][0];
    bay.cells = [];
    stockUp(world, bay, [
      withCargo(30, 'fish'),
      withCargo(40, 'lobster'),
      withCargo(30, 'fish'),
      withCargo(40, 'lobster'),
      withCargo(50, 'timber'),
    ]);
    const t = truckWith(world, []);
    t.cargo = 0;
    expect(cratesFor(world, t, bay)).toBe(5);
    const off = cratesOff(world, t, bay, 4, 4);
    expect(off).toHaveLength(4);
    expect(new Set(off.map((c) => cargoOf(c.fee))).size).toBeGreaterThan(1);
    expect(cratesFor(world, t, bay)).toBe(1);
  });

  it('stop at each business in town that takes some of a mixed load, nearest next', () => {
    const world = townWith([Build.FishMarket, Build.Restaurant, Build.BuildersYard]);
    const wants = { ...world.town.wants };
    const t = truckWith(world, ['fish', 'fish', 'fish', 'lobster', 'timber', 'goods']);
    world.trucks.push(t);
    expect(deliverInTown(world, t)).toBe(true);
    // What each takes is kept for it as it sets off.
    expect(world.town.wants[Build.FishMarket]).toBe(wants[Build.FishMarket] - 3);
    expect(world.town.wants[Build.Restaurant]).toBe(wants[Build.Restaurant] - 1);
    expect(world.town.wants[Build.BuildersYard]).toBe(wants[Build.BuildersYard] - 1);
    const visited: number[] = [];
    for (let k = 0; k < 20_000 && t.state !== 'leaving' && world.trucks.includes(t); k++) {
      if (t.state === 'unloading' && t.drop !== undefined && !visited.includes(t.drop)) {
        visited.push(t.drop);
      }
      updateTruck(world, t);
    }
    expect(visited.map((i) => world.map.build[i]).sort()).toEqual(
      [Build.FishMarket, Build.Restaurant, Build.BuildersYard].sort(),
    );
    // Dropped what each took; the goods went on out by road.
    expect(feesOn(world, t).map((f: number) => cargoOf(f))).toEqual(['goods']);
    expect(t.cargo).toBe(1);
    expect(world.town.wants[Build.FishMarket]).toBe(wants[Build.FishMarket] - 3);
  });

  it('say where they deliver what', () => {
    const world = townWith([Build.FishMarket, Build.BuildersYard]);
    const t = truckWith(world, ['fish', 'fish', 'fish', 'timber']);
    world.trucks.push(t);
    expect(deliverInTown(world, t)).toBe(true);
    const words = world.snapshot().entities.find((e: Any) => e.id === t.id)?.activity ?? '';
    expect(words).toMatch(
      /^Delivering (3 crates of fish at the fish market .*, then timber at the builders' yard|1 crates of timber at the builders' yard .*, then fish at the fish market)$/,
    );
  });

  it('take fish to the market and lobster to the restaurant, nothing else', () => {
    const world: Any = townWith([Build.FishMarket, Build.Restaurant]);
    for (const o of [...world.offers]) world.command({ type: 'signContract', id: o.id });
    // Lobster comes in among the fish, now and then, as off a lobster boat.
    const bay = [...world.bays.values()][0];
    const seen = new Set<string>();
    for (let k = 0; k < TICKS_PER_DAY * 8; k++) {
      if (k % 300 === 0) stockUp(world, bay, [...Array(3).fill(withCargo(45, 'lobster'))]);
      world.step();
      for (const t of world.trucks) {
        if (t.state !== 'toTown' || t.boxes) continue;
        // As many crates aboard as it drops there are of what it takes.
        const def = BUSINESSES[world.map.build[t.drop]]!;
        const ours = feesOn(world, t)
          .map((f: number) => cargoOf(f))
          .filter((c: Cargo) => def.takes.includes(c));
        expect(ours.length).toBeGreaterThanOrEqual(t.dropCount);
        for (const c of new Set(ours)) seen.add(`${c}>${def.label}`);
      }
    }
    expect(seen.has('fish>fish market')).toBe(true);
    expect(seen.has('lobster>seafood restaurant')).toBe(true);
    for (const s of seen) expect(['fish>fish market', 'lobster>seafood restaurant']).toContain(s);
  }, 60_000);
});
