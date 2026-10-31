import { describe, expect, it } from 'vitest';
import { makeCannedOffer, makeTownLineOffer, needsCustomsOffice } from '../src/sim/contracts';
import { Rng } from '../src/sim/rng';
import { placementError } from '../src/sim/rules';
import { Build } from '../src/sim/types';
import { World } from '../src/sim/world';
import { BUILD_TIER } from '../src/sim/tiers';
import { landmarkHint } from '../src/sim/systems/townBusiness';
import { LANDMARKS } from '../src/sim/town';
import { signLine } from './bot';
import { wharf } from './wharf';

/** A Coastal Wharf with money, and on its board Valley Timber Co.'s offer. */
function withTimberOffer(): { world: World; id: number } {
  const world = World.create(7, 96);
  world.tier = 1;
  world.cash = 50_000;
  const taken = new Set(world.contracts.map((c) => c.terms.name));
  const offer = makeTownLineOffer(new Rng(3), 9001, world.tick, taken, 'timber')!;
  world.offers.push(offer);
  return { world, id: offer.id };
}

function buildCustoms(world: World): number {
  const m = world.map;
  const spot = m.build.findIndex((b, i) => b === Build.None && !placementError(m, 'customs', i));
  expect(spot).toBeGreaterThanOrEqual(0);
  world.command({ type: 'build', kind: 'customs', tiles: [spot] });
  expect(m.build[spot]).toBe(Build.Customs);
  return spot;
}

const signed = (world: World, name: string) => world.contracts.some((c) => c.terms.name === name);

describe('Customs office', () => {
  it('is needed by lines of timber, goods, containers and canned fish, not fish or ice', () => {
    const rng = new Rng(1);
    expect(needsCustomsOffice(makeTownLineOffer(rng, 1, 0, new Set(), 'timber')!.terms)).toBe(true);
    expect(needsCustomsOffice(makeTownLineOffer(rng, 2, 0, new Set(), 'goods')!.terms)).toBe(true);
    expect(needsCustomsOffice(makeCannedOffer(rng, 3, 0, new Set())!.terms)).toBe(true);
    const world = World.create(7, 96);
    expect(world.contracts.some((c) => needsCustomsOffice(c.terms))).toBe(false);
    expect(BUILD_TIER.customs).toBe(1);
  });

  it('must stand before a line customs clears can be signed, and the board says why', () => {
    const { world, id } = withTimberOffer();
    const name = world.offers.find((o) => o.id === id)!.terms.name;
    const cash = world.cash;
    const view = () => world.snapshot().offers.find((o) => o.id === id);
    expect(view()?.blocked).toMatch(/customs office/);
    world.command({ type: 'signContract', id });
    expect(signed(world, name)).toBe(false);
    expect(world.cash).toBe(cash);
    // The fishery's offers are not held up.
    const other = world.snapshot().offers.find((o) => o.id !== id);
    if (other) expect(other.blocked).toBeUndefined();

    buildCustoms(world);
    expect(view()?.blocked).toBeUndefined();
    world.command({ type: 'signContract', id });
    expect(signed(world, name)).toBe(true);
  });

  it('goes up on open ground or a port path in owned land, its door facing a path', () => {
    const world = World.create(7, 96);
    world.tier = 1;
    world.cash = 50_000;
    const m = world.map;
    const spot = buildCustoms(world);
    expect(m.owns(spot)).toBe(true);
    // Not out on the water, nor where the port does not own the land.
    const water = m.build.findIndex((_, i) => m.ocean[i] === 1);
    expect(placementError(m, 'customs', water)).toBeTruthy();
    const unowned = m.build.findIndex((b, i) => b === Build.None && !m.owns(i) && m.isLand(i));
    expect(placementError(m, 'customs', unowned)).toBeTruthy();
  });

  it('is what the Next step card asks for when the timber line waits on one', () => {
    const { world, id } = withTimberOffer();
    world.town!.landmarks = LANDMARKS.findIndex((l) => l.code === Build.School);
    const l = LANDMARKS[world.town!.landmarks];
    expect(landmarkHint(world, l)).toMatch(/customs office/);
    buildCustoms(world);
    expect(landmarkHint(world, l)).toMatch(/^Sign/);
    world.command({ type: 'signContract', id });
    expect(landmarkHint(world, l) ?? '').not.toMatch(/customs office/);
  });

  it('is tipped by the advisor when such an offer is on the board and the port has none', () => {
    const { world } = withTimberOffer();
    world.tipsSeen.delete('customsOffice');
    world.events.length = 0;
    // Offers are looked over at the end of the day.
    for (let t = 0; t < 600; t++) world.step();
    expect(world.tipsSeen.has('customsOffice')).toBe(true);
  });

  it('lets a save with such lines signed and no office go on, with a warning on them', () => {
    // The Coastal Wharf's test port signs its lines straight in, as a save
    // from before customs offices would have them: without its office.
    const world: World = wharf(2, 1);
    const office = world.map.build.indexOf(Build.Customs);
    world.command({ type: 'bulldoze', tiles: [office] });
    expect(world.map.build.includes(Build.Customs)).toBe(false);
    const back = World.fromSave(JSON.parse(JSON.stringify(world.toSave())));
    const lines = back.contracts.filter((c) => needsCustomsOffice(c.terms));
    expect(lines.length).toBe(3);
    const cards = back.snapshot().contracts.filter((c) => needsCustomsOffice(c.terms));
    for (const c of cards) {
      // A shipper may have troubles of its own; the coasters say customs.
      if (c.terms.kind === 'fishery') {
        expect(c.trouble?.text).toMatch(/no customs office/);
        expect(c.trouble?.bad).toBe(false);
      }
    }
    // And their cargo still comes in, clears customs and is trucked out.
    const before = back.stats.cratesHandled;
    for (let t = 0; t < 600 * 3; t++) back.step();
    expect(back.contracts.filter((c) => needsCustomsOffice(c.terms)).length).toBe(3);
    expect(back.stats.cratesHandled).toBeGreaterThan(before + 20);
  });

  it('is built by the bot before it signs a line that needs one', () => {
    const { world, id } = withTimberOffer();
    const offer = world.offers.find((o) => o.id === id)!;
    expect(signLine(world, offer)).toBe(true);
    expect(world.map.build.includes(Build.Customs)).toBe(true);
    expect(signed(world, offer.terms.name)).toBe(true);
  });
});
