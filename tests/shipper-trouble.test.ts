import { describe, expect, it } from 'vitest';
import { Build } from '../src/sim/types';
import { shipperTrouble } from '../src/sim/systems/cargo/shipperTrouble';
import { lots } from '../src/sim/systems/roads/bays';
import { wharf } from './wharf';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** A Coastal Wharf with the cannery signed: gate, parking outside, outgoing storage and coasters. */
function port(): { world: Any; cannery: Any; out: Any } {
  const world = wharf(2, 1);
  const cannery = world.contracts.find((c: Any) => c.terms.name === 'Test Cannery');
  const out = [...world.bays.values()].find((b: Any) => b.tiles && b.outgoing);
  return { world, cannery, out };
}

const marksFor = (world: Any) =>
  world.snapshot().problems.filter((p: Any) => p.text.startsWith('Test Cannery'));

describe("Shippers' trouble", () => {
  it('says nothing when everything is built', () => {
    const { world, cannery } = port();
    expect(shipperTrouble(world, cannery)).toBeNull();
    expect(marksFor(world)).toHaveLength(0);
    const offerless = world.snapshot().contracts.find((c: Any) => c.id === cannery.id);
    expect(offerless.trouble).toBeUndefined();
  });

  it('asks for parking outside the port, with a mark where the trucks come in', () => {
    const { world, cannery } = port();
    const outside = lots(world).filter((l) => l.outside);
    expect(outside.length).toBeGreaterThan(0);
    for (const l of outside) world.command({ type: 'bulldoze', tiles: l.tiles });
    const trouble = shipperTrouble(world, cannery)!;
    expect(trouble.kind).toBe('parking');
    expect(trouble.bad).toBe(true);
    expect(trouble.text).toMatch(/mark out truck parking on a public road/);
    const [mark, ...more] = marksFor(world);
    expect(more).toHaveLength(0);
    expect(mark.type).toBe('contract');
    expect(mark.idx).toBe(cannery.id);
    const m = world.map;
    expect(mark.x).toBe(m.xOf(m.entry) + 0.5);
    expect(mark.y).toBe(m.yOf(m.entry) + 0.5);
    expect(mark.text).toMatch(/^Test Cannery: its trucks wait in parking outside the port/);
    const view = world.snapshot().contracts.find((c: Any) => c.id === cannery.id);
    expect(view.trouble.bad).toBe(true);
  });

  it('asks for outgoing crate storage', () => {
    const { world, cannery, out } = port();
    world.command({ type: 'store', tiles: out.tiles, kind: 'cratesOut', on: false });
    expect([...world.bays.values()].some((b: Any) => b.outgoing)).toBe(false);
    const trouble = shipperTrouble(world, cannery)!;
    expect(trouble.kind).toBe('storage');
    expect(trouble.text).toMatch(/crate storage for cargo going out/);
    const [mark] = marksFor(world);
    expect(mark.type).toBe('contract');
    expect(mark.x).toBe(world.map.xOf(world.map.entry) + 0.5);
  });

  it('marks outgoing storage behind no port gate', () => {
    const { world, cannery, out } = port();
    const m = world.map;
    const gates = [...m.build].flatMap((b: number, i: number) => (b === Build.Gate ? [i] : []));
    expect(gates.length).toBeGreaterThan(0);
    world.command({ type: 'bulldoze', tiles: gates });
    const trouble = shipperTrouble(world, cannery)!;
    expect(trouble.kind).toBe('reach');
    expect(trouble.text).toMatch(/port gate/);
    expect(trouble.stores).toEqual([out.idx]);
    const [mark, ...more] = marksFor(world);
    expect(more).toHaveLength(0);
    expect(mark.type).toBe('bay');
    expect(mark.idx).toBe(out.idx);
  });

  it('marks outgoing storage on machines-only ground', () => {
    const { world, cannery, out } = port();
    const m = world.map;
    const round = new Set<number>();
    for (const t of out.tiles) {
      for (const n of m.neighbors4(t)) if (!out.tiles.includes(n)) round.add(n);
    }
    world.command({ type: 'forkliftOnly', tiles: [...round], on: true });
    expect(world.loadingDocks(out)).toHaveLength(0);
    const trouble = shipperTrouble(world, cannery)!;
    expect(trouble.kind).toBe('reach');
    expect(trouble.text).toMatch(/machines-only/);
    const [mark] = marksFor(world);
    expect(mark.type).toBe('bay');
    expect(mark.idx).toBe(out.idx);
  });

  it('warns, without a mark, when no coasters call', () => {
    const { world, cannery } = port();
    world.contracts = world.contracts.filter(
      (c: Any) => !(c.terms.kind === 'fishery' && c.terms.vessel === 'coaster'),
    );
    const trouble = shipperTrouble(world, cannery)!;
    expect(trouble.kind).toBe('ships');
    expect(trouble.bad).toBe(false);
    expect(marksFor(world)).toHaveLength(0);
  });

  it('shares one mark among shippers held up in the same place', () => {
    const { world, cannery } = port();
    world.contracts.push({ ...cannery, id: 999, terms: { ...cannery.terms, name: 'Other Co' } });
    for (const l of lots(world).filter((l) => l.outside)) {
      world.command({ type: 'bulldoze', tiles: l.tiles });
    }
    const marks = world.snapshot().problems.filter((p: Any) => p.type === 'contract');
    expect(marks).toHaveLength(1);
    expect(marks[0].text).toMatch(/^Test Cannery and Other Co: their trucks wait/);
  });

  it('checks an offer the same way', () => {
    const { world, cannery } = port();
    world.offers = [{ id: 5, terms: cannery.terms, signingFee: 0, expires: world.tick + 1000 }];
    const offer = world.snapshot().offers[0];
    expect(offer.checks.map((k: Any) => k.ok)).toEqual([true, true, true, true]);
    for (const l of lots(world).filter((l) => l.outside)) {
      world.command({ type: 'bulldoze', tiles: l.tiles });
    }
    const after = world.snapshot().offers[0];
    expect(after.checks[0].ok).toBe(false);
  });
});
