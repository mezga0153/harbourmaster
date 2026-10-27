import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { generateMap } from '../src/sim/mapgen';
import { findPath } from '../src/sim/path';
import { placementError } from '../src/sim/rules';
import { Build, Deco, Terrain, TICKS_PER_DAY } from '../src/sim/types';
import { TIERS } from '../src/sim/tiers';
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

  it('builds quays in deeper water than jetties allow', () => {
    const world = World.create(7);
    world.tier = 1;
    const m = world.map;
    const deep = m.depth.findIndex(
      (d, i) =>
        m.ocean[i] === 1 &&
        d > B.MAX_JETTY_DEPTH &&
        d <= B.MAX_QUAY_DEPTH &&
        m.neighbors4(i).some((n) => m.isLand(n)),
    );
    expect(deep).toBeGreaterThan(-1);
    expect(placementError(m, 'jetty', deep)).toBe('Too deep for a wooden jetty');
    expect(placementError(m, 'quay', deep)).toBeNull();
  });

  it('runs a jib crane and forklifts off a quay', () => {
    const world = World.create(7);
    world.tier = 1;
    world.cash = 50_000;
    const { side } = besideTip(world);
    world.command({ type: 'build', kind: 'quay', tiles: [side] });
    expect(world.map.build[side]).toBe(Build.Quay);
    world.command({ type: 'build', kind: 'jibCrane', tiles: [side] });
    expect(world.map.build[side]).toBe(Build.JibCrane);
    world.command({ type: 'buyMachine', kind: 'forklift' });
    expect(world.people.filter((p) => p.kind === 'forklift')).toHaveLength(1);
    let craneWorked = false;
    for (let t = 0; t < TICKS_PER_DAY * 3; t++) {
      world.step();
      if (world.cranes.get(side)?.busy) craneWorked = true;
    }
    expect(craneWorked).toBe(true);
    expect(world.stats.cratesHandled).toBeGreaterThan(10);
  });
});
