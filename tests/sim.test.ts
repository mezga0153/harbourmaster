import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { GameMap } from '../src/sim/map';
import { makeOffer } from '../src/sim/contracts';
import { generateMap } from '../src/sim/mapgen';
import { findPath } from '../src/sim/path';
import {
  anchorOf,
  bestFacing,
  drivable,
  EXTENSION,
  footprint,
  forkliftOnly,
  frontOf,
  ON_QUAY,
  placementCost,
  placementError,
  terraformError,
  walkable,
  walkableAt,
} from '../src/sim/rules';
import { Build, Deco, Terrain, TICKS_PER_DAY } from '../src/sim/types';
import { TIERS } from '../src/sim/tiers';
import { Rng } from '../src/sim/rng';
import { World } from '../src/sim/world';

describe('findPath', () => {
  it('routes around walls', () => {
    // 5x5 with a wall at x=2 except y=4
    const w = 5;
    const wall = new Set([2, 7, 12, 17]);
    const path = findPath(w, 5, 0, 4, (i) => (wall.has(i) ? Infinity : 1), false);
    expect(path).not.toBeNull();
    expect(path!.some((i) => wall.has(i))).toBe(false);
    expect(path![path!.length - 1]).toBe(4);
  });

  it('returns null when unreachable', () => {
    const path = findPath(3, 1, 0, 2, (i) => (i === 1 ? Infinity : 1), true);
    expect(path).toBeNull();
  });
});

describe('generateMap', () => {
  it('is deterministic per seed', () => {
    const a = generateMap(42).map.toData();
    const b = generateMap(42).map.toData();
    const c = generateMap(43).map.toData();
    expect(a).toEqual(b);
    expect(a.terrain).not.toEqual(c.terrain);
  });

  it.each([1, 2, 3, 99, 1234, 777777])('lays out a working start site (seed %i)', (seed) => {
    const { map, spawn } = generateMap(seed);
    expect(map.build[map.entry]).toBe(Build.Road);
    expect(map.xOf(map.entry)).toBe(0);
    expect(map.build[spawn]).toBe(Build.Footpath);
    const jetties = map.build.filter((b) => b === Build.Jetty).length;
    expect(jetties).toBe(3);
    for (let i = 0; i < map.build.length; i++) {
      if (map.build[i] === Build.Jetty) expect(map.ocean[i]).toBe(1);
    }
  });
});

describe('World', () => {
  it('runs the first-boat loop and earns money', () => {
    const world = World.create(7);
    const start = world.cash;
    for (let t = 0; t < TICKS_PER_DAY * 3; t++) world.step();
    expect(world.stats.boats).toBeGreaterThan(0);
    expect(world.stats.cratesHandled).toBeGreaterThan(5);
    expect(world.stats.earned).toBeGreaterThan(0);
    // Earnings minus penalties and three days of wages and haulier fees.
    const daily = B.START_DOCKHANDS * B.WAGE_DOCKHAND + B.STARTER_HAULIER_FEE;
    expect(world.cash).toBe(start + world.stats.earned - world.stats.penalties - 3 * daily);
  });

  it.each([1, 2, 3, 99, 1234, 777777])('gets boats unloaded on any map (seed %i)', (seed) => {
    const world = World.create(seed);
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) world.step();
    expect(world.stats.cratesHandled).toBeGreaterThan(0);
  });

  it('rejects saves from older versions or with missing fields', () => {
    const save = World.create(1).toSave();
    expect(World.isValidSave(save)).toBe(true);
    expect(World.isValidSave({ ...save, version: 2 })).toBe(false);
    const broken = structuredClone(save);
    delete (broken.contracts[0] as { signingFee?: number }).signingFee;
    expect(World.isValidSave(broken)).toBe(false);
  });

  it.each([7, 99])('keeps cash a finite number over a long, busy game (seed %i)', (seed) => {
    const world = World.create(seed);
    for (const o of [...world.offers]) world.command({ type: 'signContract', id: o.id });
    for (let t = 0; t < TICKS_PER_DAY * 20; t++) world.step();
    expect(Number.isFinite(world.cash)).toBe(true);
  });

  it('continues identically after a save round-trip', () => {
    const a = World.create(11);
    for (let t = 0; t < 1500; t++) a.step();
    const b = World.fromSave(JSON.parse(JSON.stringify(a.toSave())));
    for (let t = 0; t < 1500; t++) {
      a.step();
      b.step();
    }
    expect(b.snapshot()).toEqual(a.snapshot());
  });

  it('builds, charges and refunds', () => {
    const world = World.create(5);
    const m = world.map;
    let road = -1;
    for (let i = 0; i < m.build.length && road < 0; i++) {
      if (!placementError(m, 'road', i) && m.deco[i] === Deco.None) road = i;
    }
    const before = world.cash;
    world.command({ type: 'build', kind: 'road', tiles: [road] });
    expect(m.build[road]).toBe(Build.Road);
    expect(world.cash).toBe(before - 20);
    world.command({ type: 'bulldoze', tiles: [road] });
    expect(m.build[road]).toBe(Build.None);
    expect(world.cash).toBe(before - 10);
  });
});

describe('Bulldozing', () => {
  it('clears rock to grass for a fee', () => {
    const world = World.create(5);
    const m = world.map;
    const rock = m.terrain.findIndex((t) => t === Terrain.Rock);
    expect(rock).toBeGreaterThanOrEqual(0);
    expect(placementError(m, 'road', rock)).toBe('Rock is in the way');
    const before = world.cash;
    world.command({ type: 'bulldoze', tiles: [rock] });
    expect(m.terrain[rock]).toBe(Terrain.Grass);
    expect(world.cash).toBe(before - B.ROCK_CLEAR_COST);
    expect(world.drainTileChanges()).toContainEqual(
      expect.objectContaining({ i: rock, terrain: Terrain.Grass }),
    );
    expect(placementError(m, 'road', rock)).toBeNull();
  });
});

describe('Contracts', () => {
  it('keeps making offers once every firm in the lists has a contract', () => {
    const world = World.create(7);
    const taken = new Set<string>();
    // Sign up everyone who offers, until well past the named firms.
    for (let k = 0; k < 60; k++) {
      for (const kind of ['fishery', 'haulier'] as const) {
        const o = makeOffer(new Rng(k), k, 0, kind, taken, 2);
        expect(o).not.toBeNull();
        expect(taken.has(o!.terms.name)).toBe(false);
        taken.add(o!.terms.name);
      }
    }
    // A port whose hauliers are all signed still gets offers.
    for (const name of taken) {
      world.contracts.push({ ...world.contracts[1], terms: { ...world.contracts[1].terms, name } });
    }
    world.offers.length = 0;
    for (let d = 0; d < 10; d++) world['refreshOffers']();
    expect(world.offers.length).toBeGreaterThan(0);
  });

  it('offers bigger container ships as the port handles more containers', () => {
    const load = (handled: number) => {
      let total = 0;
      let n = 0;
      for (let k = 0; n < 40; k++) {
        const o = makeOffer(new Rng(k), k, 0, 'fishery', new Set(), 2, handled);
        if (o?.terms.kind === 'fishery' && o.terms.vessel === 'feeder') {
          expect(o.terms.cratesMax).toBeLessThanOrEqual(B.FEEDER_MAX_LOAD);
          total += o.terms.cratesMin;
          n++;
        }
      }
      return total / n;
    };
    const first = load(0);
    expect(load(1000)).toBeGreaterThan(first * 1.6);
    expect(load(5000)).toBeGreaterThan(first * 2.4);
    expect(load(50000)).toBe(load(5000));
  });

  it('signs an offer for its fee and starts sending boats', () => {
    const world = World.create(7);
    const offer = world.offers.find((o) => o.terms.kind === 'fishery')!;
    const before = world.cash;
    world.command({ type: 'signContract', id: offer.id });
    expect(world.cash).toBe(before - offer.signingFee);
    const signed = world.contracts.find((c) => c.terms.name === offer.terms.name)!;
    expect(signed).toBeDefined();
    for (let t = 0; t < TICKS_PER_DAY; t++) world.step();
    expect(world.boats.some((b) => b.contractId === signed.id) || world.stats.boats > 1).toBe(true);
  });

  it('never sends more trucks than the hauliers have', () => {
    const world = World.create(3);
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) {
      world.step();
      const fleet = world.contracts.reduce(
        (n, c) => n + (c.terms.kind === 'haulier' ? c.terms.fleet : 0),
        0,
      );
      expect(world.trucks.length).toBeLessThanOrEqual(fleet);
    }
  });

  it('charges a buyout when you end a signed contract', () => {
    const world = World.create(7);
    const offer = world.offers[0];
    world.command({ type: 'signContract', id: offer.id });
    const c = world.contracts.find((x) => x.terms.name === offer.terms.name)!;
    const before = world.cash;
    world.command({ type: 'cancelContract', id: c.id });
    expect(world.cash).toBe(before - Math.round(offer.signingFee * B.CANCEL_FEE_SHARE));
    expect(world.contracts).not.toContain(c);
  });

  it('makes an overloaded fishery unhappy, charges demurrage and lets it walk out', () => {
    const world = World.create(7);
    // Sack every dockhand so nothing is ever unloaded.
    for (const p of [...world.people]) world.command({ type: 'fire', id: p.id });
    const starter = world.contracts.find((c) => c.terms.kind === 'fishery')!;
    const before = world.cash;
    for (let t = 0; t < TICKS_PER_DAY * 30 && world.contracts.includes(starter); t++) {
      world.step();
    }
    expect(world.contracts).not.toContain(starter);
    expect(world.cash).toBeLessThan(before);
  });

  it('goes bankrupt after too many days in the red', () => {
    const world = World.create(7);
    world.cash = -10_000;
    for (let t = 0; t < TICKS_PER_DAY * (B.BANKRUPT_DAYS + 1); t++) world.step();
    expect(world.bankrupt).toBe(true);
    const tick = world.tick;
    world.step();
    expect(world.tick).toBe(tick);
  });

  it('recovers from the red before the deadline', () => {
    const world = World.create(7);
    world.cash = -1;
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) world.step();
    world.cash = 10_000;
    for (let t = 0; t < TICKS_PER_DAY; t++) world.step();
    expect(world.daysInRed).toBe(0);
    expect(world.bankrupt).toBe(false);
  });
});

describe('Staff', () => {
  it('hires from the candidate list and replaces candidates daily', () => {
    const world = World.create(7);
    expect(world.candidates).toHaveLength(B.CANDIDATES);
    const c = world.candidates[0];
    world.command({ type: 'hire', candidateId: c.id });
    expect(world.people.some((p) => p.name === c.name && p.wage === c.wage)).toBe(true);
    expect(world.candidates).not.toContainEqual(c);
    for (let t = 0; t < TICKS_PER_DAY; t++) world.step();
    expect(world.candidates).toHaveLength(B.CANDIDATES);
  });

  it('rests on the spot without a hut, losing morale', () => {
    const world = World.create(7);
    const p = world.people[0];
    p.energy = B.TIRED_ENERGY - 1;
    const morale = p.morale;
    for (let t = 0; t < 5; t++) world.step();
    expect(p.state).toBe('resting');
    expect(p.hutIdx).toBe(-1);
    expect(p.morale).toBeLessThan(morale);
  });

  it('walks to a break hut when there is one, and enjoys it', () => {
    const world = World.create(7);
    const m = world.map;
    const bay = [...world.bays.keys()][0];
    let hut = -1;
    for (let r = 1; r < 6 && hut < 0; r++) {
      for (const n of [bay - r, bay + r, bay - r * m.w, bay + r * m.w]) {
        if (hut < 0 && !placementError(m, 'breakHut', n)) hut = n;
      }
    }
    world.command({ type: 'build', kind: 'breakHut', tiles: [hut] });
    const p = world.people[0];
    p.energy = B.TIRED_ENERGY - 1;
    const morale = p.morale;
    let rested = false;
    for (let t = 0; t < 500; t++) {
      world.step();
      if (p.state === 'resting') {
        rested = true;
        expect(p.hutIdx).toBe(hut);
      } else if (rested) break;
    }
    expect(rested).toBe(true);
    expect(p.energy).toBeGreaterThan(95);
    expect(p.morale).toBeGreaterThan(morale);
  });

  it('asks for raises; refusing hurts morale, accepting raises the wage', () => {
    const world = World.create(7);
    const [a, b] = world.people;
    a.raiseAsk = a.wage + B.RAISE_STEP;
    b.raiseAsk = b.wage + B.RAISE_STEP;
    const moraleB = b.morale;
    world.command({ type: 'raise', id: a.id, accept: true });
    world.command({ type: 'raise', id: b.id, accept: false });
    expect(a.wage).toBe(B.WAGE_DOCKHAND + B.RAISE_STEP);
    expect(b.morale).toBeLessThan(moraleB);
    expect(a.raiseAsk + b.raiseAsk).toBe(0);
  });

  it('quits after staying miserable', () => {
    const world = World.create(7);
    const p = world.people[0];
    for (let d = 0; d < B.QUIT_DAYS + 1; d++) {
      p.morale = 0;
      for (let t = 0; t < TICKS_PER_DAY; t++) world.step();
    }
    expect(world.people).not.toContain(p);
  });
});

describe('Finance', () => {
  it('borrows, charges interest daily and repays', () => {
    const world = World.create(7);
    const before = world.cash;
    world.command({ type: 'loan', amount: B.LOAN_STEP });
    expect(world.loan).toBe(B.LOAN_STEP);
    expect(world.cash).toBe(before + B.LOAN_STEP);
    for (let t = 0; t < TICKS_PER_DAY; t++) world.step();
    expect(world.yesterday!.interest).toBe(-Math.round(B.LOAN_STEP * B.LOAN_DAILY_RATE));
    world.command({ type: 'loan', amount: -B.LOAN_STEP });
    expect(world.loan).toBe(0);
  });

  it('caps the loan at the bank limit', () => {
    const world = World.create(7);
    world.command({ type: 'loan', amount: B.LOAN_MAX * 2 });
    expect(world.loan).toBe(B.LOAN_MAX);
  });

  it('records every cash change in the ledger', () => {
    const world = World.create(7);
    for (let t = 0; t < TICKS_PER_DAY - 1; t++) world.step();
    const start = world.cash - Object.values(world.today).reduce((a, b) => a + b, 0);
    world.step(); // midnight: the day's ledger moves to yesterday
    const net = Object.values(world.yesterday!).reduce((a, b) => a + b, 0);
    expect(world.cash).toBe(start + net);
  });
});

describe('Coastal Wharf tier', () => {
  /** A water tile next to the starting jetty tip, for quay tests. */
  function besideTip(world: World): { tip: number; side: number } {
    const m = world.map;
    const r = m.yOf(m.entry);
    let x = 0;
    while (m.build[m.idx(x + 1, r)] !== Build.None) x++;
    return { tip: m.idx(x, r), side: m.idx(x, r - 1) };
  }

  /** The starting jetty's tiles, from the shore outwards. */
  function starterJetty(world: World): number[] {
    const m = world.map;
    const r = m.yOf(m.entry);
    const out: number[] = [];
    for (let x = 0; x < m.w; x++) if (m.build[m.idx(x, r)] === Build.Jetty) out.push(m.idx(x, r));
    return out;
  }

  it('upgrades a jetty to a quay from its shore end only', () => {
    const world = World.create(7);
    world.boats.length = 0; // the first boat moors at once; keep the jetty free
    world.tier = 1;
    world.cash = 50_000;
    const m = world.map;
    const jetty = starterJetty(world);
    const tip = jetty[jetty.length - 1];
    expect(placementError(m, 'quay', tip)).toMatch(/shore end/);
    // A quay cannot carry on from the end of a jetty either.
    expect(placementError(m, 'quay', tip + 1)).toMatch(/not a jetty/);
    // The old timber counts towards the concrete.
    expect(placementCost(m, 'quay', jetty[0])).toBeLessThan(B.QUAY_COST_WATER + 1);
    // Dragged from the tip back to the shore, the whole jetty is paved.
    world.command({ type: 'build', kind: 'quay', tiles: [...jetty].reverse() });
    expect(jetty.every((i) => m.build[i] === Build.Quay)).toBe(true);
    expect(placementError(m, 'quay', tip + 1)).toBeNull();
  });

  it('keeps forklifts off port paths, and upgrades paths to port roads', () => {
    const world = World.create(7);
    world.tier = 1;
    world.cash = 50_000;
    const m = world.map;
    expect(drivable(Build.Footpath)).toBe(false);
    const path = m.build.findIndex((b) => b === Build.Footpath);
    world.command({ type: 'build', kind: 'portRoad', tiles: [path] });
    expect(m.build[path]).toBe(Build.PortRoad);
    expect(walkable(Build.PortRoad) && drivable(Build.PortRoad)).toBe(true);
  });

  it('marks port roads and quays forklift-only, and clears the mark', () => {
    const world = World.create(7);
    world.tier = 1;
    world.cash = 50_000;
    const m = world.map;
    const path = m.build.findIndex((b) => b === Build.Footpath);
    world.command({ type: 'forkliftOnly', tiles: [path], on: true });
    expect(forkliftOnly(m, path)).toBe(false); // a port path cannot be marked
    world.command({ type: 'build', kind: 'portRoad', tiles: [path] });
    const cash = world.cash;
    world.command({ type: 'forkliftOnly', tiles: [path], on: true });
    expect(forkliftOnly(m, path)).toBe(true);
    expect(walkableAt(m, path)).toBe(false);
    expect(world.cash).toBe(cash - B.FORKLIFT_ONLY_COST);
    world.command({ type: 'forkliftOnly', tiles: [path], on: false });
    expect(walkableAt(m, path)).toBe(true);
  });

  it('turns old forklift lanes into forklift-only port roads', () => {
    const data = World.create(7).map.toData();
    data.build[0] = Build.ForkliftLane;
    const m = GameMap.fromData(data);
    expect(m.build[0]).toBe(Build.PortRoad);
    expect(forkliftOnly(m, 0)).toBe(true);
  });

  it('locks quays, cranes and forklifts until the upgrade', () => {
    const world = World.create(7);
    const { side } = besideTip(world);
    world.command({ type: 'build', kind: 'quay', tiles: [side] });
    expect(world.map.build[side]).toBe(Build.None);
    world.command({ type: 'buyMachine', kind: 'forklift' });
    expect(world.people.some((p) => p.kind === 'forklift')).toBe(false);
  });

  it('upgrades only once the requirements are met', () => {
    const world = World.create(7);
    world.command({ type: 'upgrade' });
    expect(world.tier).toBe(0);
    world.stats.cratesHandled = TIERS[1].crates;
    world.command({
      type: 'signContract',
      id: world.offers.find((o) => o.terms.kind === 'fishery')!.id,
    });
    world.cash = TIERS[1].cost + 100;
    world.command({ type: 'upgrade' });
    expect(world.tier).toBe(1);
    expect(world.cash).toBe(100);
  });

  function buildOffice(world: World): number {
    const m = world.map;
    const spot = m.build.findIndex((_, i) => !placementError(m, 'office', i));
    world.command({ type: 'build', kind: 'office', tiles: [spot] });
    expect(m.build[spot]).toBe(Build.Office);
    return spot;
  }

  it('lets coasters moor only against a quay two tiles wide', () => {
    const world = World.create(7);
    world.tier = 1;
    world.cash = 100_000;
    const m = world.map;
    buildOffice(world);
    const r = m.yOf(m.entry);
    let x = 0;
    while (m.build[m.idx(x + 1, r)] !== Build.None) x++;
    // One row of quay alongside the jetty: one tile wide.
    const row1 = [0, 1, 2, 3].map((k) => m.idx(x - k, r - 1));
    world.command({ type: 'build', kind: 'quay', tiles: row1 });
    const wideBefore = world.capacity().deepBerths;
    // A second row behind it makes the quay two wide.
    const row2 = [0, 1, 2, 3].map((k) => m.idx(x - k, r - 2));
    world.command({ type: 'build', kind: 'quay', tiles: row2 });
    world.command({
      type: 'build',
      kind: 'quay',
      tiles: [m.idx(x + 1, r - 1), m.idx(x + 1, r - 2)],
    });
    expect(world.capacity().deepBerths).toBeGreaterThan(wideBefore);
  });

  it('sends big trucks only to large truck bays', () => {
    const world = World.create(7);
    world.tier = 1;
    world.cash = 100_000;
    const m = world.map;
    // Swap the starter haulier for a big-truck one.
    const h = world.contracts.find((c) => c.terms.kind === 'haulier')!;
    if (h.terms.kind === 'haulier') h.terms.capacity = B.BIG_TRUCK_CAPACITY;
    for (let t = 0; t < TICKS_PER_DAY; t++) world.step();
    expect(world.stats.trucks).toBe(0);
    const spot = m.build.findIndex((_, i) => !placementError(m, 'largeBay', i));
    world.command({ type: 'build', kind: 'largeBay', tiles: [spot] });
    // Give the large bay something to collect.
    world.bays.get(spot)!.crates.push(...Array(B.BIG_TRUCK_CAPACITY).fill(20));
    for (let t = 0; t < TICKS_PER_DAY; t++) world.step();
    expect(world.stats.trucks).toBeGreaterThan(0);
  });

  it('needs a harbour office before boats use a quay', () => {
    const world = World.create(7);
    world.tier = 1;
    world.cash = 50_000;
    world.command({ type: 'build', kind: 'quay', tiles: [starterJetty(world)[0]] });
    expect(world.docks().every((d) => !d.coordinated)).toBe(true);
    buildOffice(world);
    expect(world.docks().every((d) => d.coordinated)).toBe(true);
  });

  /** Build a forklift depot beside the starting footpath. */
  function buildDepot(world: World): number {
    const m = world.map;
    const spot = m.build.findIndex((_, i) => !placementError(m, 'depot', i));
    world.command({ type: 'build', kind: 'depot', tiles: [spot] });
    expect(m.build[spot]).toBe(Build.Depot);
    return spot;
  }

  it('buys forklifts at a depot, three to a depot', () => {
    const world = World.create(7);
    world.tier = 1;
    world.cash = 50_000;
    world.command({ type: 'buyMachine', kind: 'forklift' });
    expect(world.people.some((p) => p.kind === 'forklift')).toBe(false);
    const depot = buildDepot(world);
    for (let k = 0; k < B.DEPOT_SLOTS + 1; k++) {
      world.command({ type: 'buyMachine', kind: 'forklift', tile: depot });
    }
    const forklifts = world.people.filter((p) => p.kind === 'forklift');
    expect(forklifts).toHaveLength(B.DEPOT_SLOTS);
    expect(forklifts.every((f) => f.home === depot)).toBe(true);
  });

  it('sends forklifts home to refuel and to be repaired', () => {
    const world = World.create(7);
    world.tier = 1;
    world.cash = 50_000;
    const depot = buildDepot(world);
    world.command({ type: 'buyMachine', kind: 'forklift', tile: depot });
    const f = world.people.find((p) => p.kind === 'forklift')!;
    f.fuel = B.LOW_FUEL - 1;
    let refuelled = false;
    for (let t = 0; t < 200 && !refuelled; t++) {
      world.step();
      refuelled = f.fuel >= 100;
    }
    expect(refuelled).toBe(true);
    f.needsRepair = true;
    const before = world.cash;
    let repaired = false;
    for (let t = 0; t < 400 && !repaired; t++) {
      world.step();
      repaired = f.state === 'broken';
    }
    expect(repaired).toBe(true);
    expect(world.map.idx(Math.floor(f.x), Math.floor(f.y))).toBe(depot);
    expect(world.cash).toBeLessThanOrEqual(before - B.REPAIR_COST);
  });

  it('builds quays in deeper water than jetties allow', () => {
    const world = World.create(7);
    world.tier = 1;
    const m = world.map;
    const deep = m.depth.findIndex(
      (d, i) => m.ocean[i] === 1 && d > B.MAX_JETTY_DEPTH && d <= B.MAX_QUAY_DEPTH,
    );
    expect(deep).toBeGreaterThan(-1);
    expect(placementError(m, 'jetty', deep)).toBe('Too deep for a wooden jetty');
    // A quay may still need connecting to the shore, but depth is no obstacle.
    expect(placementError(m, 'quay', deep) ?? '').not.toMatch(/deep/i);
  });

  it('tells you when a forklift cannot reach the cargo', () => {
    const world = World.create(7);
    world.boats.length = 0; // the first boat moors at once; keep the jetty free
    world.tier = 1;
    world.cash = 50_000;
    const jetty = starterJetty(world);
    world.command({ type: 'build', kind: 'quay', tiles: jetty });
    const crane = jetty[jetty.length - 1];
    world.command({ type: 'build', kind: 'jibCrane', tiles: [crane] });
    // Pallets, so the dockhands leave them for the forklift.
    world.cranes.get(crane)!.stack.push(10, 10);
    world.cranes.get(crane)!.pallets = true;
    // The bay is only joined to the quay by port paths, which forklifts avoid.
    world.command({ type: 'buyMachine', kind: 'forklift', tile: buildDepot(world) });
    for (let t = 0; t < 400; t++) world.step();
    const f = world.people.find((p) => p.kind === 'forklift')!;
    expect(f.stuck).toMatch(/Can't reach/);
    expect(world.snapshot().entities.find((e) => e.id === f.id)!.alert).toBe(true);
  });

  it('leaves pallets for forklifts', () => {
    const world = World.create(7);
    world.boats.length = 0; // the first boat moors at once; keep the jetty free
    world.tier = 1;
    world.cash = 50_000;
    const m = world.map;
    const jetty = starterJetty(world);
    const tip = jetty[jetty.length - 1];
    world.command({ type: 'build', kind: 'quay', tiles: jetty });
    world.command({ type: 'build', kind: 'jibCrane', tiles: [tip] });
    const paths = [...m.build.keys()].filter((i) => m.build[i] === Build.Footpath);
    world.command({ type: 'build', kind: 'portRoad', tiles: paths });
    buildOffice(world);
    const crane = world.cranes.get(tip)!;
    crane.stack.push(10, 10, 10, 10);
    crane.pallets = true;
    for (let t = 0; t < 300; t++) world.step();
    expect(crane.stack).toHaveLength(4);
    world.command({ type: 'buyMachine', kind: 'forklift', tile: buildDepot(world) });
    for (let t = 0; t < TICKS_PER_DAY && crane.stack.length > 0; t++) world.step();
    expect(crane.stack).toHaveLength(0);
  });

  it('runs a jib crane and forklifts off a quay', () => {
    const world = World.create(7);
    world.boats.length = 0; // the first boat moors at once; keep the jetty free
    world.tier = 1;
    world.cash = 50_000;
    const jetty = starterJetty(world);
    const side = jetty[jetty.length - 1];
    world.command({ type: 'build', kind: 'quay', tiles: jetty });
    expect(world.map.build[side]).toBe(Build.Quay);
    world.command({ type: 'build', kind: 'jibCrane', tiles: [side] });
    expect(world.map.build[side]).toBe(Build.JibCrane);
    buildOffice(world);
    buildDepot(world);
    world.command({ type: 'buyMachine', kind: 'forklift' });
    expect(world.people.filter((p) => p.kind === 'forklift')).toHaveLength(1);
    let craneWorked = false;
    for (let t = 0; t < TICKS_PER_DAY * 3; t++) {
      world.step();
      if (world.cranes.get(side)?.busy) craneWorked = true;
    }
    expect(craneWorked).toBe(true);
    expect(world.stats.cratesHandled).toBeGreaterThan(5);
  });
});

describe('Buildings', () => {
  it('face the way they are placed, entrance to the road', () => {
    const world = World.create(7);
    const m = world.map;
    const spot = m.build.findIndex((_, i) => !placementError(m, 'truckBay', i));
    const f = bestFacing(m, 'truckBay', spot);
    expect(m.build[frontOf(m, spot, f)]).toBe(Build.Road);
    expect(placementError(m, 'truckBay', spot, undefined, (f + 2) % 4)).not.toBeNull();
    world.command({ type: 'build', kind: 'truckBay', tiles: [spot], facing: f });
    expect(m.build[spot]).toBe(Build.TruckBay);
    expect(m.orient[spot]).toBe(f);
  });

  it('builds a large truck bay two tiles wide and bulldozes it whole', () => {
    const world = World.create(7);
    world.tier = 1;
    world.cash = 100_000;
    const m = world.map;
    const spot = m.build.findIndex((_, i) => !placementError(m, 'largeBay', i));
    const f = bestFacing(m, 'largeBay', spot);
    const bays = world.bays.size;
    world.command({ type: 'build', kind: 'largeBay', tiles: [spot], facing: f });
    const [a, b] = footprint(m, 'largeBay', spot, f);
    expect([m.build[a], m.build[b]]).toEqual([Build.LargeBay, Build.LargeBay]);
    expect(m.orient[b] & EXTENSION).toBe(EXTENSION);
    expect(anchorOf(m, b)).toBe(a);
    expect(world.bays.size).toBe(bays + 1);
    world.command({ type: 'bulldoze', tiles: [b] });
    expect([m.build[a], m.build[b]]).toEqual([Build.None, Build.None]);
    expect(world.bays.size).toBe(bays);
  });

  it('loads two trucks at once at a warehouse, faster than at a truck bay', () => {
    const world = World.create(7);
    world.tier = 1;
    world.cash = 100_000;
    const m = world.map;
    const spot = m.build.findIndex((_, i) => !placementError(m, 'warehouse', i));
    const f = bestFacing(m, 'warehouse', spot);
    world.command({ type: 'build', kind: 'warehouse', tiles: [spot], facing: f });
    const tiles = footprint(m, 'warehouse', spot, f);
    expect(tiles.every((t) => m.build[t] === Build.Warehouse)).toBe(true);
    expect(m.build[frontOf(m, spot, f)]).toBe(Build.Road);
    const store = world.bays.get(spot)!;
    expect(store.large).toBe(true);
    // Only the warehouse has crates, and a haulier with two trucks.
    for (const b of world.bays.values()) b.crates.length = 0;
    store.crates.push(...Array(24).fill(20));
    const h = world.contracts.find((c) => c.terms.kind === 'haulier')!;
    if (h.terms.kind === 'haulier') h.terms.fleet = 2;
    let together = false;
    let loadTime = 0;
    for (let t = 0; t < TICKS_PER_DAY && store.crates.length > 0; t++) {
      world.step();
      const loading = world.trucks.filter((k) => k.bayIdx === spot && k.state === 'loading');
      if (loading.length === 2 && loading[0].goal !== loading[1].goal) together = true;
      if (loading.length > 0) loadTime++;
    }
    expect(together).toBe(true);
    expect(store.crates.length).toBe(0);
    // 24 crates, two docks at a time, quicker per crate than by hand.
    expect(loadTime).toBeLessThan((24 * B.BAY_LOAD_TICKS) / 2);
  });

  it('lets trucks into the port only through a port gate', () => {
    const world = World.create(7);
    world.tier = 1;
    world.cash = 100_000;
    const m = world.map;
    // A gate off the public road, a port road behind it and a truck bay at
    // the end facing the port road, away from the public road.
    const r = m.yOf(m.entry);
    const grass = (x: number, y: number) =>
      m.inBounds(x, y) && m.terrain[m.idx(x, y)] === Terrain.Grass;
    const x = [...Array(m.w).keys()].find(
      (x) =>
        m.build[m.idx(x, r)] === Build.Road &&
        [1, 2, 3].every((d) => grass(x, r + d) && grass(x + 1, r + d)),
    )!;
    expect(x).toBeDefined();
    const [gate, road1, road2, bay] = [
      m.idx(x, r + 1),
      m.idx(x, r + 2),
      m.idx(x, r + 3),
      m.idx(x + 1, r + 3),
    ];
    world.command({ type: 'bulldoze', tiles: [gate, road1, road2, bay, m.idx(x + 1, r + 2)] });
    world.command({ type: 'build', kind: 'portRoad', tiles: [road1, road2] });
    world.command({ type: 'build', kind: 'truckBay', tiles: [bay], facing: 2 });
    expect(m.build[bay]).toBe(Build.TruckBay);
    // Not without a gate, and not by a port road straight off the highway.
    world.command({ type: 'build', kind: 'portRoad', tiles: [gate] });
    const goods = world.bays.get(bay)!;
    goods.crates.push(20, 20, 20, 20);
    for (let t = 0; t < TICKS_PER_DAY; t++) world.step();
    expect(goods.noAccess).toBe(true);
    expect(goods.crates.length).toBe(4);
    world.command({ type: 'bulldoze', tiles: [gate] });
    expect(placementError(m, 'portGate', gate, undefined, 3)).toBeNull();
    expect(placementError(m, 'portGate', gate, undefined, 1)).not.toBeNull();
    world.command({ type: 'build', kind: 'portGate', tiles: [gate] });
    expect(m.build[gate]).toBe(Build.Gate);
    expect(m.orient[gate]).toBe(3);
    // Staff never use the gate.
    expect(drivable(Build.Gate) || walkable(Build.Gate)).toBe(false);
    for (let t = 0; t < TICKS_PER_DAY; t++) world.step();
    expect(goods.noAccess).toBe(false);
    expect(goods.crates.length).toBeLessThan(4);
  });
});

describe('Port side', () => {
  it('keeps dockhands off grass and public roads', () => {
    const world = World.create(7);
    const m = world.map;
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) {
      world.step();
      for (const p of world.people) {
        expect(walkable(m.build[m.idx(Math.floor(p.x), Math.floor(p.y))])).toBe(true);
      }
    }
  });

  it('runs only two jetties without a harbour office', () => {
    const world = World.create(7);
    world.cash = 50_000;
    const m = world.map;
    // Add standalone jetties further along the coast.
    let built = 0;
    for (const off of [4, -4, 8, -8, 12, -12]) {
      const row = m.yOf(m.entry) + off;
      let x = 0;
      while (x < m.w - 1 && m.ocean[m.idx(x, row)] !== 1) x++;
      const tile = m.idx(x, row);
      if (!placementError(m, 'jetty', tile)) {
        world.command({ type: 'build', kind: 'jetty', tiles: [tile] });
        built++;
      }
      if (built === 2) break;
    }
    expect(world.docks()).toHaveLength(3);
    expect(world.docks().filter((d) => d.coordinated)).toHaveLength(B.FREE_DOCKS);
  });
});

describe('Dredging and reclaiming', () => {
  /** A run of open sea tiles along the entry row, and the land behind it. */
  function shore(world: World): { sea: number[]; land: number[] } {
    const m = world.map;
    const y = m.yOf(m.entry) + 6;
    let x = 0;
    while (m.isLand(m.idx(x + 1, y))) x++;
    const land = [3, 2, 1, 0].map((k) => m.idx(x - k, y));
    const sea = [6, 7, 8].map((k) => m.idx(x + k, y));
    return { sea, land };
  }

  it('digs the seabed deeper, a step at a time, and charges for it', () => {
    const world = World.create(7);
    world.tier = B.TERRAFORM_TIER;
    world.cash = 100_000;
    world.boats.length = 0;
    const m = world.map;
    const { sea } = shore(world);
    const before = sea.map((i) => m.depth[i]);
    world.command({ type: 'terraform', tiles: sea, raise: false });
    sea.forEach((i, k) => expect(m.depth[i]).toBeCloseTo(before[k] + B.TERRAFORM_STEP));
    expect(world.cash).toBe(100_000 - 3 * B.DREDGE_COST);
    const tiles = world.drainTileChanges();
    expect(tiles.find((t) => t.i === sea[0])?.depth).toBeCloseTo(before[0] + B.TERRAFORM_STEP);
  });

  it('digs a channel inland from the shore in one drag, open to the sea', () => {
    const world = World.create(7);
    world.tier = B.TERRAFORM_TIER;
    world.cash = 100_000;
    world.boats.length = 0;
    const m = world.map;
    const { land } = shore(world);
    world.command({ type: 'bulldoze', tiles: land.filter((i) => m.terrain[i] === Terrain.Rock) });
    // Dragged from inland out to the shore: it still works.
    world.command({ type: 'terraform', tiles: land, raise: false });
    for (const i of land) {
      expect(m.terrain[i]).toBe(Terrain.Water);
      expect(m.ocean[i]).toBe(1);
      expect(m.depth[i]).toBe(B.TERRAFORM_STEP);
    }
    // Inland, away from any water, there is nothing to dig from.
    const inland = m.idx(m.xOf(land[0]) - 3, m.yOf(land[0]) - 3);
    expect(terraformError(m, inland, false)).not.toBeNull();
  });

  it('fills the sea in until it is land, and a cut-off pool is no longer sea', () => {
    const world = World.create(7);
    world.tier = B.TERRAFORM_TIER;
    world.cash = 1_000_000;
    world.boats.length = 0;
    const m = world.map;
    const { land } = shore(world);
    world.command({ type: 'bulldoze', tiles: land.filter((i) => m.terrain[i] === Terrain.Rock) });
    world.command({ type: 'terraform', tiles: land, raise: false });
    // Fill the channel's mouth: the rest of it is a pool cut off from the sea.
    const mouth = land[3];
    world.command({ type: 'terraform', tiles: [mouth], raise: true });
    expect(m.isLand(mouth)).toBe(true);
    expect(m.depth[mouth]).toBe(0);
    expect(m.ocean[land[0]]).toBe(0);
    expect(m.isLand(land[0])).toBe(false);
    // Deep water takes several goes.
    const { sea } = shore(world);
    const deep = sea[2];
    const steps = Math.ceil((m.depth[deep] - 0.5) / B.TERRAFORM_STEP);
    for (let k = 0; k < steps; k++)
      world.command({ type: 'terraform', tiles: [deep], raise: true });
    expect(m.isLand(deep)).toBe(true);
  });

  it('leaves built tiles and boats alone, and waits for the Coastal Wharf', () => {
    const world = World.create(7);
    world.cash = 100_000;
    const m = world.map;
    const { sea } = shore(world);
    const depth = m.depth[sea[0]];
    world.command({ type: 'terraform', tiles: [sea[0]], raise: false });
    expect(m.depth[sea[0]]).toBe(depth);
    world.tier = B.TERRAFORM_TIER;
    const jetty = m.build.findIndex((b) => b === Build.Jetty);
    expect(terraformError(m, jetty, false)).not.toBeNull();
    const boat = world.boats[0];
    const under = m.idx(Math.floor(boat.x), Math.floor(boat.y));
    const was = m.depth[under];
    world.command({ type: 'terraform', tiles: [under], raise: true });
    expect(m.depth[under]).toBe(was);
  });
});

describe('Buoys', () => {
  it('lead boats in past the green buoys and out past the red ones, in order', () => {
    const world = World.create(7);
    world.tier = 1;
    world.cash = 100_000;
    const m = world.map;
    const row = m.yOf(m.entry);
    let shore = 0;
    while (m.isLand(m.idx(shore + 1, row))) shore++;
    // Way in to the north of the jetty, way out to the south.
    const ins = [24, 16, 8].map((dx, k) => m.idx(shore + dx, row - 6 + k));
    const outs = [8, 16, 24].map((dx, k) => m.idx(shore + dx, row + 6 + k));
    world.command({ type: 'build', kind: 'buoyIn', tiles: ins });
    world.command({ type: 'build', kind: 'buoyOut', tiles: outs });
    expect(ins.every((i) => m.build[i] === Build.BuoyIn)).toBe(true);
    expect(outs.every((i) => m.build[i] === Build.BuoyOut)).toBe(true);
    // Buoys leave the water open, and stand a tile apart.
    expect(placementError(m, 'buoyIn', ins[0] + 1)).not.toBeNull();
    world.boats.length = 0;
    world['addContract'](
      {
        kind: 'fishery',
        vessel: 'smack',
        name: 'Buoy Test',
        color: 0,
        boatEvery: 0.5,
        cratesMin: 4,
        cratesMax: 4,
        fee: 20,
      },
      world.tick + 5,
      0,
    );
    const near = new Map<number, number[]>();
    const passed = (id: number, i: number) => {
      const seen = near.get(id) ?? [];
      if (!seen.includes(i)) seen.push(i);
      near.set(id, seen);
    };
    for (let t = 0; t < TICKS_PER_DAY * 3; t++) {
      world.step();
      for (const b of world.boats) {
        for (const i of b.state === 'leaving' ? outs : ins) {
          if (Math.hypot(b.x - m.xOf(i) - 0.5, b.y - m.yOf(i) - 0.5) < 1.5) passed(b.id, i);
        }
      }
    }
    const routes = [...near.values()];
    const way = (r: number[], buoys: number[]) => r.filter((i) => buoys.includes(i));
    // Every boat met the buoys in order: green furthest out first, red
    // nearest the docks first. Some passed all of them.
    for (const r of routes) {
      for (const buoys of [ins, outs]) {
        const seen = way(r, buoys).map((i) => buoys.indexOf(i));
        expect(seen).toEqual([...seen].sort((p, q) => p - q));
      }
    }
    expect(routes.some((r) => way(r, ins).length === 3)).toBe(true);
    expect(routes.some((r) => way(r, outs).length === 3)).toBe(true);
  });
});

describe('Boat traffic', () => {
  it('never locks up in a knot of boats all backing out of each other’s way', () => {
    const world = World.create(7);
    const m = world.map;
    const template = world.boats[0];
    world.boats.length = 0;
    // A knot that froze for good in a real game: boats heading out and in
    // met, every one ended up backing off for another and none could.
    const knot = [
      ['feeder', 'approaching', 86.0, 55.7, -2.68, 51, 38],
      ['coaster', 'leaving', 88.7, 54.1, -0.23, 95, 52],
      ['smack', 'leaving', 90.1, 52.2, -0.13, 95, 51],
      ['smack', 'leaving', 90.1, 52.4, 0.02, 95, 52],
      ['feeder', 'leaving', 86.3, 55.8, -0.03, 95, 55],
      ['smack', 'approaching', 83.6, 55.5, -2.63, 46, 34],
      ['smack', 'approaching', 81.9, 55.1, -2.32, 64, 36],
      ['smack', 'approaching', 88.0, 54.4, -2.59, 60, 37],
      ['smack', 'approaching', 87.5, 54.9, -2.51, 66, 39],
      ['feeder', 'approaching', 82.2, 54.7, -2.11, 72, 38],
    ] as const;
    const draft = { smack: template.draft, coaster: B.COASTER_DRAFT, feeder: B.FEEDER_DRAFT };
    knot.forEach(([vessel, state, x, y, dir, gx, gy], k) => {
      expect(m.depth[m.idx(Math.floor(x), Math.floor(y))]).toBeGreaterThan(draft[vessel]);
      world.boats.push({
        ...template,
        id: 1000 + k,
        vessel,
        draft: draft[vessel],
        state,
        x,
        y,
        dir,
        speed: 0,
        path: [],
        goal: m.idx(gx, gy),
        berth: -1,
        jetty: -1,
        astern: true,
        held: 5000,
      });
    });
    const start = new Map(world.boats.map((b) => [b.id, [b.x, b.y]]));
    for (let t = 0; t < 600; t++) world.step();
    // Every one of them has got away: off the map, or well clear of the knot.
    for (const b of world.boats.filter((q) => start.has(q.id))) {
      const [x, y] = start.get(b.id)!;
      expect(Math.hypot(b.x - x, b.y - y)).toBeGreaterThan(3);
    }
  });
});

describe('Crowding', () => {
  /** The starting jetty's tiles, from the shore outwards. */
  function jetty(world: World): number[] {
    const m = world.map;
    const r = m.yOf(m.entry);
    const out: number[] = [];
    for (let x = 0; x < m.w; x++) if (m.build[m.idx(x, r)] === Build.Jetty) out.push(m.idx(x, r));
    return out;
  }

  function place(world: World, p: World['people'][number], at: number, dir: number): void {
    p.x = world.map.xOf(at) + 0.5;
    p.y = world.map.yOf(at) + 0.5;
    p.dir = dir;
  }

  it('lets workers going opposite ways pass on a narrow jetty', () => {
    const world = World.create(7);
    const [a, b] = world.people;
    const [j0, j1, j2] = jetty(world);
    place(world, a, j0, 0);
    place(world, b, j2, Math.PI);
    Object.assign(a, { state: 'wander', path: [j1, j2], goal: j2 });
    Object.assign(b, { state: 'wander', path: [j1, j0], goal: j0 });
    let worst = 0;
    let passed = false;
    for (let t = 0; t < 40 && !passed; t++) {
      world.step();
      worst = Math.max(worst, a.blocked, b.blocked);
      passed = Math.floor(a.x) === world.map.xOf(j2) && Math.floor(b.x) === world.map.xOf(j0);
    }
    expect(passed).toBe(true);
    // They kept to their own side; nobody had to squeeze through.
    expect(worst).toBeLessThan(B.SIDESTEP_AFTER);
  });

  it('makes workers going the same way queue behind someone working', () => {
    const world = World.create(7);
    const [a, b] = world.people;
    const [j0, j1, j2] = jetty(world);
    place(world, a, j1, 0);
    Object.assign(a, { state: 'picking', timer: 200, path: [], goal: j1 });
    place(world, b, j0, 0);
    Object.assign(b, { state: 'wander', path: [j1, j2], goal: j2 });
    let waited = 0;
    for (let t = 0; t < 40; t++) {
      world.step();
      waited = Math.max(waited, b.blocked);
      // Never overtakes: stays short of the worker lifting the crate.
      expect(b.x).toBeLessThan(world.map.xOf(j1));
    }
    expect(waited).toBeGreaterThan(3);
  });
});

describe('Container Port tier', () => {
  /**
   * Lay out a container terminal north of the starting jetty: a two-wide
   * pier (rows r-1 and r-2) out to deep water with a harbour crane at the
   * end, a large truck bay on the road, a depot and a harbour office.
   */
  function terminal(world: World): { crane: number; yard: number } | null {
    const m = world.map;
    const r = m.yOf(m.entry);
    let shore = 0;
    while (m.build[m.idx(shore + 1, r)] !== Build.Jetty) shore++;
    const start = shore - 4;
    const tiles = (row: number, x0: number, x1: number) =>
      Array.from({ length: x1 - x0 + 1 }, (_, k) => m.idx(x0 + k, row));
    for (const row of [r - 1, r - 2]) {
      world.command({ type: 'bulldoze', tiles: tiles(row, start, shore + 12) });
    }
    // Run the pier out until the water beyond it is deep enough for feeders.
    let end = -1;
    for (let x = shore + 1; x < m.w - 3; x++) {
      const out = m.idx(x, r - 3);
      if (m.isLand(m.idx(x, r - 2))) continue;
      if (m.depth[m.idx(x, r - 2)] > B.MAX_QUAY_DEPTH) break;
      if (!m.isLand(out) && m.depth[out] >= B.FEEDER_DRAFT + 0.5) {
        end = x;
        break;
      }
    }
    if (end < 0) return null;
    for (const row of [r - 1, r - 2]) {
      for (const i of tiles(row, start, end)) {
        const kind = m.isLand(i) ? 'portRoad' : 'quay';
        world.command({ type: 'build', kind, tiles: [i] });
      }
    }
    const crane = m.idx(end, r - 2);
    world.command({ type: 'build', kind: 'harbourCrane', tiles: [crane] });
    // A 2×2 container yard with its gate on the public road and its side on
    // the port road, where the stackers come in.
    const yard = m.idx(start - 2, r - 1);
    world.command({ type: 'bulldoze', tiles: [yard, yard + 1, yard - m.w, yard - m.w + 1] });
    world.command({ type: 'build', kind: 'containerYard', tiles: [yard], facing: 1 });
    const depot = m.idx(start, r - 3);
    world.command({ type: 'bulldoze', tiles: [depot] });
    world.command({ type: 'build', kind: 'depot', tiles: [depot], facing: 1 });
    const office = m.build.findIndex((_, i) => !placementError(m, 'office', i));
    world.command({ type: 'build', kind: 'office', tiles: [office] });
    world.command({ type: 'buyMachine', kind: 'stacker', tile: depot });
    if (m.build[crane] !== Build.HarbourCrane || m.build[yard] !== Build.Yard) return null;
    if (!world.people.some((p) => p.kind === 'stacker')) return null;
    return { crane, yard };
  }

  it('lifts containers off a feeder, stacks them in a yard and trucks them out', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world);
    expect(t).not.toBeNull();
    expect(world.capacity().boxes.berths).toBeGreaterThan(0);
    const add = world['addContract'].bind(world);
    add(
      {
        kind: 'fishery',
        vessel: 'feeder',
        name: 'Test Feeders',
        color: 0,
        boatEvery: 1,
        cratesMin: 6,
        cratesMax: 6,
        fee: 150,
      },
      world.tick + 10,
      0,
    );
    add(
      {
        kind: 'haulier',
        name: 'Test Box Haul',
        color: 0,
        fleet: 2,
        capacity: B.CONTAINER_TRUCK_CAPACITY,
        dailyFee: 0,
        cargo: 'container',
      },
      0,
      0,
    );
    const earned = world.stats.earned;
    for (let k = 0; k < TICKS_PER_DAY * 3; k++) world.step();
    expect(world.stats.containers).toBeGreaterThan(0);
    // Dockhands never touch containers.
    expect(world.people.filter((p) => p.kind === 'dockhand').every((p) => p.carrying <= 1)).toBe(
      true,
    );
    expect(world.stats.earned - earned).toBeGreaterThan(150 * 3);
  });

  it('brings a container ship in and out without its hull touching the docks', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    expect(terminal(world)).not.toBeNull();
    world['addContract'](
      {
        kind: 'fishery',
        vessel: 'feeder',
        name: 'Test Feeders',
        color: 0,
        boatEvery: 1,
        cratesMin: 4,
        cratesMax: 4,
        fee: 150,
      },
      world.tick + 10,
      0,
    );
    const clips = world['clips'].bind(world);
    let touching = 0;
    let moored = 0;
    const phases: string[] = [];
    let heading = 0;
    let turned = 0;
    const served = world.stats.boats;
    for (let k = 0; k < TICKS_PER_DAY * 4; k++) {
      world.step();
      for (const b of world.boats) {
        if (b.vessel !== 'feeder') continue;
        if (b.berthing && phases.at(-1) !== b.berthing) phases.push(b.berthing);
        if (b.state === 'moored') {
          moored++;
          heading = b.dir;
        }
        // Leaving, it holds its heading until it is out in open water.
        if (b.berthing === 'out') turned = Math.max(turned, Math.abs(b.dir - heading));
        else if (clips(b, b.x, b.y, b.dir, []) > 0) touching++;
      }
    }
    // It lined up out along the dock before running in to the berth, and ran
    // out along it again before turning for the sea.
    expect(phases.slice(0, 4)).toEqual(['lead', 'align', 'line', 'out']);
    expect(turned).toBe(0);
    expect(moored).toBeGreaterThan(0);
    expect(world.stats.boats).toBeGreaterThan(served);
    expect(touching).toBe(0);
  });

  it('lays out a container yard on a quay, and leaves the quay when cleared', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    expect(terminal(world)).not.toBeNull();
    const m = world.map;
    const r = m.yOf(m.entry);
    // Two quay tiles wide along the pier: a yard fits across it, its gate
    // facing on along the pier.
    let x = 0;
    while (!(m.build[m.idx(x, r - 1)] === Build.Quay && !m.isLand(m.idx(x, r - 1)))) x++;
    const spot = m.idx(x + 1, r - 1);
    const tiles = footprint(m, 'containerYard', spot, 0);
    expect(tiles.every((t) => m.build[t] === Build.Quay)).toBe(true);
    expect(placementError(m, 'containerYard', spot, undefined, 0)).toBeNull();
    world.command({ type: 'build', kind: 'containerYard', tiles: [spot], facing: 0 });
    expect(tiles.every((t) => m.build[t] === Build.Yard && (m.orient[t] & ON_QUAY) !== 0)).toBe(
      true,
    );
    expect(world.yards.has(spot)).toBe(true);
    world.command({ type: 'bulldoze', tiles: [tiles[3]] });
    expect(tiles.every((t) => m.build[t] === Build.Quay && m.orient[t] === 0)).toBe(true);
    expect(world.yards.has(spot)).toBe(false);
  });

  it('stores containers only in yards, where the trucks collect them', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const add = world['addContract'].bind(world);
    add(
      {
        kind: 'fishery',
        vessel: 'feeder',
        name: 'Test Feeders',
        color: 0,
        boatEvery: 5,
        cratesMin: 14,
        cratesMax: 14,
        fee: 150,
      },
      world.tick + 10,
      0,
    );
    // No container trucks yet: the containers wait in the yard. A big ship
    // takes its time coming alongside.
    for (let k = 0; k < TICKS_PER_DAY * 3; k++) world.step();
    const yard = world.yards.get(t.yard)!;
    expect(yard.boxes.length).toBeGreaterThan(0);
    expect([...world.bays.values()].every((b) => b.boxes.length === 0)).toBe(true);
    add(
      {
        kind: 'haulier',
        name: 'Test Box Haul',
        color: 0,
        fleet: 2,
        capacity: 1,
        dailyFee: 0,
        cargo: 'container',
      },
      0,
      0,
    );
    // Feeders keep landing more, so count what the trucks take away.
    let collected = 0;
    for (let k = 0; k < TICKS_PER_DAY * 2; k++) {
      const before = yard.boxes.length;
      world.step();
      collected += Math.max(0, before - yard.boxes.length);
    }
    expect(collected).toBeGreaterThan(0);
  });

  it('sends container trucks into a yard from any side on a public road', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const m = world.map;
    // Take away the road in front of the yard's main gate tile, with a detour
    // round it, so trucks can only come in through the other gate tile.
    const gate = m.idx(m.xOf(t.yard), m.yOf(t.yard) + 1);
    const detour = [gate - 1, gate - 1 + m.w, gate + m.w, gate + 1 + m.w, gate + 1];
    world.command({ type: 'bulldoze', tiles: detour.filter((i) => m.build[i] !== Build.Road) });
    world.command({ type: 'build', kind: 'road', tiles: detour });
    world.command({ type: 'bulldoze', tiles: [gate] });
    expect(m.build[gate]).toBe(Build.None);
    expect(detour.every((i) => m.build[i] === Build.Road)).toBe(true);
    const yard = world.yards.get(t.yard)!;
    yard.boxes.push(100, 100);
    world['addContract'](
      {
        kind: 'haulier',
        name: 'Test Box Haul',
        color: 0,
        fleet: 1,
        capacity: 2,
        dailyFee: 0,
        cargo: 'container',
      },
      0,
      0,
    );
    for (let k = 0; k < TICKS_PER_DAY; k++) world.step();
    expect(yard.noAccess).toBe(false);
    expect(yard.boxes.length).toBe(0);
  });

  it('collects containers left in a large bay by an older save', () => {
    const world = World.create(7);
    const bay = [...world.bays.values()][0];
    bay.large = true;
    bay.boxes.push(100, 100);
    world['addContract'](
      {
        kind: 'haulier',
        name: 'Test Box Haul',
        color: 0,
        fleet: 1,
        capacity: 2,
        dailyFee: 0,
        cargo: 'container',
      },
      0,
      0,
    );
    for (let k = 0; k < TICKS_PER_DAY; k++) world.step();
    expect(bay.boxes.length).toBe(0);
  });
});
