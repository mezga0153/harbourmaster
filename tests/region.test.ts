import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { LANDMARKS } from '../src/sim/town';
import { CITY_STEPS, newRegion, placeCap, regionDay } from '../src/sim/region';
import { refreshOffers, grownFor } from '../src/sim/systems/economy';
import { served } from '../src/sim/systems/region';
import { shipOut } from '../src/sim/systems/cargo/exports';
import { TIERS } from '../src/sim/tiers';

/** A Container Port whose town has its railway station. */
function stationTown(): World {
  const world = World.create(7, 96);
  world.tier = 2;
  world.cash = 100_000;
  world.town!.landmarks = LANDMARKS.length;
  return world;
}

const cities = (w: World) => w.region.places.filter((p) => p.kind === 'city');

describe('The region', () => {
  it('lies along the line from the map’s seed: a city at each end, and the works waiting for bulk', () => {
    const a = newRegion(7);
    expect(newRegion(7)).toEqual(a);
    const c = a.places.filter((p) => p.kind === 'city');
    expect(c).toHaveLength(2);
    expect(c[0].side).toBe(-c[1].side);
    expect(c[0].far).toBeLessThan(c[1].far);
    expect(a.places.map((p) => p.kind)).toEqual(
      expect.arrayContaining(['colliery', 'farms', 'mine', 'power', 'steelworks']),
    );
  });

  it('offers the nearer city’s trains once the town has its station, the other after its distribution park', () => {
    const world = World.create(7, 96);
    world.tier = 2;
    refreshOffers(world);
    expect(world.offers.some((o) => o.terms.kind === 'rail')).toBe(false);
    world.town!.landmarks = LANDMARKS.length;
    refreshOffers(world);
    const [near, far] = cities(world);
    const lines = () => world.offers.filter((o) => o.terms.kind === 'rail');
    expect(lines().map((o) => o.terms.kind === 'rail' && o.terms.place)).toEqual([near.id]);
    expect(lines()[0].terms.name).toBe(`${near.name} Railfreight`);
    served(world, near.id, 'inland', CITY_STEPS[0].goal.total);
    expect(near.steps).toBe(1);
    expect(placeCap(near)).toBe(CITY_STEPS[0].cap);
    expect(lines()).toHaveLength(1);
    // Exports it brought, put on board, towards its distribution park.
    const feeder = { vessel: 'feeder', berth: world.map.entry } as never;
    shipOut(
      world,
      feeder,
      Array.from({ length: CITY_STEPS[1].goal.total }, () => ({ fee: 150, at: 0, place: near.id })),
    );
    expect(near.steps).toBe(2);
    expect(lines().map((o) => o.terms.kind === 'rail' && o.terms.place)).toEqual([near.id, far.id]);
  });

  it('grows a city the port serves towards what its steps let it, and not one it does not', () => {
    const world = stationTown();
    const [near, far] = cities(world);
    const was = far.size;
    for (let d = 0; d < 20; d++) {
      served(world, near.id, 'inland', 8);
      regionDay(world.region);
    }
    expect(near.size).toBeGreaterThan(2000);
    expect(near.size).toBeLessThanOrEqual(placeCap(near));
    expect(far.size).toBe(was);
  });

  it('counts the region, not the town alone, towards the Bulk Terminal', () => {
    const world = stationTown();
    const bulk = TIERS[3];
    expect(bulk.region).toBeGreaterThan(world.regionSize());
    expect(world.regionSize()).toBeGreaterThan(world.townSize());
    world.debug({ type: 'debug', town: bulk.town + 50 });
    expect(grownFor(world, bulk)).toBe(false);
    for (const p of cities(world)) p.size = 6000;
    expect(world.regionSize()).toBeGreaterThanOrEqual(bulk.region!);
    expect(grownFor(world, bulk)).toBe(true);
    expect(world.snapshot().progress.region).toBe(world.regionSize());
  });

  it('is kept in saves, and laid out from the seed for older ones', () => {
    const world = stationTown();
    cities(world)[0].steps = 2;
    const save = world.toSave();
    expect(World.fromSave(save).region).toEqual(world.region);
    const { region: _, ...old } = save;
    const loaded = World.fromSave(old as never);
    expect(loaded.region.places).toHaveLength(world.region.places.length);
    expect(cities(loaded)[0].steps).toBe(0);
  });
});
