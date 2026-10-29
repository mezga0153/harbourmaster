import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { GameMap } from '../src/sim/map';
import { makeOffer } from '../src/sim/contracts';
import { generateMap } from '../src/sim/mapgen';
import { findDrivePath, findPath } from '../src/sim/path';
import {
  anchorOf,
  bestFacing,
  drivable,
  EXTENSION,
  footprint,
  forkliftOnly,
  frontOf,
  gantryGround,
  gantryRails,
  machinesOnly,
  needsWideSpace,
  parkingLots,
  placementCost,
  placementError,
  storeError,
  terraformError,
  walkable,
  walkableAt,
} from '../src/sim/rules';
import { Build, Deco, Store, Terrain, TICKS_PER_DAY } from '../src/sim/types';
import { TIERS } from '../src/sim/tiers';
import { Rng } from '../src/sim/rng';
import { World } from '../src/sim/world';

/**
 * A strip of truck parking two spaces long between the public road and a
 * new road looped round behind it, so trucks drive in off one and out onto
 * the other; returns its tiles.
 */
function parkingLot(world: World): number[] {
  const m = world.map;
  const r = m.yOf(m.entry);
  const free = (x: number, y: number) =>
    m.inBounds(x, y) && m.terrain[m.idx(x, y)] === Terrain.Grass && m.build[m.idx(x, y)] === 0;
  const x = [...Array(m.w).keys()].find(
    (x) =>
      [-1, 0, 1, 2].every((d) => m.build[m.idx(x + d, r)] === Build.Road) &&
      [-1, 0, 1, 2].every((d) => free(x + d, r + 1) && free(x + d, r + 2)),
  )!;
  const lot = [m.idx(x, r + 1), m.idx(x + 1, r + 1)];
  const loop = [
    m.idx(x - 1, r + 1),
    m.idx(x - 1, r + 2),
    m.idx(x, r + 2),
    m.idx(x + 1, r + 2),
    m.idx(x + 2, r + 2),
    m.idx(x + 2, r + 1),
  ];
  world.command({ type: 'build', kind: 'road', tiles: loop });
  world.command({ type: 'build', kind: 'parking', tiles: lot });
  return lot;
}

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

  it('has the advisor explain each thing once a game, even across a save', () => {
    const world = World.create(7);
    const tips = (w: World) => w.drainEvents().flatMap((e) => (e.kind === 'tip' ? [e.id] : []));
    expect(tips(world)).toEqual(['welcome']);
    world.tier = 2;
    world.cash = 1_000_000;
    world['tip']('cranes');
    world['tip']('cranes');
    expect(tips(world)).toEqual(['cranes']);
    const loaded = World.fromSave(world.toSave());
    loaded['tip']('cranes');
    loaded['tip']('customs');
    expect(tips(loaded)).toEqual(['customs']);
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

  it('sends a truck again only once it is back from its round', () => {
    const world = World.create(7);
    world.boats.length = 0;
    const h = world.contracts.find((c) => c.terms.kind === 'haulier')!;
    if (h.terms.kind === 'haulier') h.terms.fleet = 1;
    const bay = [...world.bays.values()][0];
    bay.crates.push(...Array(B.BAY_CAPACITY).fill(20));
    const ours = () => world.trucks.filter((t) => t.contractId === h.id && !t.away);
    let left = -1;
    for (let k = 0; k < TICKS_PER_DAY && left < 0; k++) {
      world.step();
      if (h.returns?.length) left = world.tick;
    }
    expect(left).toBeGreaterThan(0);
    // Crates still waiting, but its one truck is away.
    for (let k = 0; k < B.TRUCK_ROUND_TRIP - 15; k++) {
      world.step();
      expect(ours()).toHaveLength(0);
    }
    expect(bay.crates.length).toBeGreaterThan(0);
    expect(world.snapshot().contracts.find((c) => c.id === h.id)!.away).toBe(1);
    for (let k = 0; k < 30; k++) world.step();
    expect(ours().length).toBe(1);
  });

  it('never sends more trucks than the hauliers have', () => {
    const world = World.create(3);
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) {
      world.step();
      const fleet = world.contracts.reduce(
        (n, c) => n + (c.terms.kind === 'haulier' ? c.terms.fleet : 0),
        0,
      );
      // Trucks gone on to deliver in town are off the hauliers' books for the port.
      const serving = world.trucks.filter((t) => t.drop === undefined);
      expect(serving.length).toBeLessThanOrEqual(fleet);
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

  /** The starting jetty paved into a quay, its paths into port roads, and an office. */
  function quayPort(world: World): number[] {
    const m = world.map;
    world.boats.length = 0; // the first boat moors at once; keep the jetty free
    world.tier = 1;
    world.cash = 100_000;
    const jetty = starterJetty(world);
    world.command({ type: 'build', kind: 'quay', tiles: jetty });
    const paths = [...m.build.keys()].filter((i) => m.build[i] === Build.Footpath);
    world.command({ type: 'build', kind: 'portRoad', tiles: paths });
    buildOffice(world);
    return jetty;
  }

  function fireDockhands(world: World): void {
    for (const p of world.people.filter((q) => q.kind === 'dockhand')) {
      world.command({ type: 'fire', id: p.id });
    }
  }

  it('never lets forklifts unload a boat: dockhands land the crates on the quay for them', () => {
    const world = World.create(7);
    quayPort(world);
    world.command({ type: 'buyMachine', kind: 'forklift', tile: buildDepot(world) });
    fireDockhands(world);
    for (let t = 0; t < TICKS_PER_DAY * 2 && !world.boats.some((b) => b.state === 'moored'); t++) {
      world.step();
    }
    const boat = world.boats.find((b) => b.state === 'moored')!;
    expect(boat).toBeDefined();
    const load = boat.crates;
    expect(load).toBeGreaterThan(0);
    for (let t = 0; t < 200; t++) world.step();
    expect(boat.crates).toBe(load);
    expect(world.stats.cratesHandled).toBe(0);
    // A dockhand lifts them off onto the quay, and the forklift takes them on.
    world.command({ type: 'hire', candidateId: world.candidates[0].id });
    let landed = false;
    let forked = false;
    for (let t = 0; t < TICKS_PER_DAY && world.stats.cratesHandled < 4; t++) {
      world.step();
      landed ||= world.piles.size > 0;
      forked ||= world.people.some((p) => p.kind === 'forklift' && p.carrying > 0);
    }
    expect(landed).toBe(true);
    expect(forked).toBe(true);
    expect(world.stats.cratesHandled).toBeGreaterThanOrEqual(4);
  });

  it('swings crates straight into crate storage near a jib crane, and forklifts take them on', () => {
    const world = World.create(7);
    const jetty = quayPort(world);
    const tip = jetty[jetty.length - 1];
    world.command({ type: 'build', kind: 'jibCrane', tiles: [tip] });
    // Two tiles: room for a couple of boats' worth.
    const store = jetty[jetty.length - 3];
    world.command({
      type: 'store',
      tiles: [store, jetty[jetty.length - 2]],
      kind: 'crates',
      on: true,
    });
    expect(world.map.store[store]).toBe(Store.Crates);
    fireDockhands(world);
    let stowed = 0;
    // The next boat sets out after a day and takes a while to sail in.
    for (let t = 0; t < TICKS_PER_DAY * 3; t++) {
      world.step();
      expect(world.cranes.get(tip)!.stack).toHaveLength(0);
      stowed = Math.max(stowed, world.bays.get(store)?.crates.length ?? 0);
    }
    expect(stowed).toBeGreaterThan(0);
    // No truck gets out there: a forklift takes the crates on to a truck bay.
    world.command({ type: 'buyMachine', kind: 'forklift', tile: buildDepot(world) });
    const handled = world.stats.cratesHandled;
    const trucked = world.stats.trucks;
    for (let t = 0; t < TICKS_PER_DAY; t++) world.step();
    // At most the start of another load left, as boats keep landing more.
    expect(world.bays.get(store)!.crates.length).toBeLessThanOrEqual(B.FORKLIFT_CAPACITY);
    expect(world.stats.cratesHandled).toBeGreaterThan(handled);
    expect(world.stats.trucks).toBeGreaterThan(trucked);
  });

  it('has boats wait for a berth under a jib crane when nobody can unload them by hand', () => {
    const world = World.create(7);
    const jetty = quayPort(world);
    const tip = jetty[jetty.length - 1];
    world.command({ type: 'build', kind: 'jibCrane', tiles: [tip] });
    // A forklift to take on what the crane lands.
    world.command({ type: 'buyMachine', kind: 'forklift', tile: buildDepot(world) });
    fireDockhands(world);
    const m = world.map;
    let moored = 0;
    for (let t = 0; t < TICKS_PER_DAY * 4; t++) {
      world.step();
      for (const b of world.boats) {
        if (b.state !== 'moored' && b.state !== 'arriving') continue;
        const reach = Math.max(
          Math.abs(m.xOf(b.berth) - m.xOf(tip)),
          Math.abs(m.yOf(b.berth) - m.yOf(tip)),
        );
        expect(reach).toBeLessThanOrEqual(1);
        if (b.state === 'moored') moored++;
      }
    }
    expect(moored).toBeGreaterThan(0);
    expect(world.stats.cratesHandled).toBeGreaterThan(0);
  });

  it('runs a jib crane and forklifts off a quay, the dockhands kept clear of the crane', () => {
    const world = World.create(7);
    const jetty = quayPort(world);
    const side = jetty[jetty.length - 1];
    expect(world.map.build[side]).toBe(Build.Quay);
    world.command({ type: 'build', kind: 'jibCrane', tiles: [side] });
    expect(world.map.build[side]).toBe(Build.JibCrane);
    expect(walkableAt(world.map, jetty[jetty.length - 2])).toBe(false);
    buildDepot(world);
    world.command({ type: 'buyMachine', kind: 'forklift' });
    expect(world.people.filter((p) => p.kind === 'forklift')).toHaveLength(1);
    let craneWorked = false;
    const m = world.map;
    for (let t = 0; t < TICKS_PER_DAY * 3; t++) {
      world.step();
      if (world.cranes.get(side)?.busy) craneWorked = true;
      for (const p of world.people) {
        if (p.kind !== 'dockhand') continue;
        const x = Math.floor(p.x);
        const y = Math.floor(p.y);
        expect(Math.max(Math.abs(x - m.xOf(side)), Math.abs(y - m.yOf(side)))).toBeGreaterThan(1);
      }
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

  /** A 2×2 patch of grass beside the public road, `side` rows off it; its top-left tile. */
  function besideRoad(world: World, side = 1): number {
    const m = world.map;
    const r = m.yOf(m.entry);
    const grass = (x: number, y: number) =>
      m.inBounds(x, y) && m.terrain[m.idx(x, y)] === Terrain.Grass && m.build[m.idx(x, y)] === 0;
    const x = [...Array(m.w).keys()].find(
      (x) =>
        m.build[m.idx(x, r)] === Build.Road &&
        m.build[m.idx(x + 1, r)] === Build.Road &&
        [0, 1].every((d) => grass(x, r + side + d) && grass(x + 1, r + side + d)),
    )!;
    return m.idx(x, r + side);
  }

  it('marks out crate storage on port roads, and loads trucks fast from inside the port', () => {
    const world = World.create(7);
    world.boats.length = 0; // no catch landing in the truck bay meanwhile
    world.tier = 1;
    world.cash = 100_000;
    const m = world.map;
    const r = m.yOf(m.entry);
    const grass = (x: number, y: number) =>
      m.inBounds(x, y) && m.terrain[m.idx(x, y)] === Terrain.Grass && m.build[m.idx(x, y)] === 0;
    const x = [...Array(m.w).keys()].find(
      (x) =>
        [0, 1, 2].every((d) => m.build[m.idx(x + d, r)] === Build.Road) &&
        [0, 1, 2].every((d) => [1, 2, 3].every((e) => grass(x + d, r + e))),
    )!;
    const at = m.idx(x + 1, r + 1);
    const tiles = [at, at + 1, at + m.w, at + m.w + 1];
    // Only on port roads and quays.
    world.command({ type: 'store', tiles, kind: 'crates', on: true });
    expect(tiles.every((t) => m.store[t] === 0)).toBe(true);
    world.command({ type: 'build', kind: 'portRoad', tiles: [at, at + 1] });
    world.command({ type: 'build', kind: 'portRoad', tiles: [at + m.w, at + m.w + 1] });
    const cash = world.cash;
    world.command({ type: 'store', tiles, kind: 'crates', on: true });
    expect(world.cash).toBe(cash - 4 * B.CRATE_STORE_COST);
    expect(tiles.every((t) => m.store[t] === Store.Crates)).toBe(true);
    const store = world.bays.get(at)!;
    expect(store.tiles).toEqual(tiles);
    expect(store.large).toBe(true);
    // Only the store has crates, and a haulier with two trucks.
    for (const b of world.bays.values()) b.crates.length = 0;
    store.crates.push(...Array(24).fill(20));
    const h = world.contracts.find((c) => c.terms.kind === 'haulier')!;
    if (h.terms.kind === 'haulier') h.terms.fleet = 2;
    // The public road runs right beside it, but storage is inside the port:
    // trucks never load from outside.
    for (let t = 0; t < 200; t++) world.step();
    expect(store.noAccess).toBe(true);
    expect(store.crates).toHaveLength(24);
    // A port gate off the road and a port road round it, inside.
    world.command({ type: 'build', kind: 'portGate', tiles: [m.idx(x, r + 1)], facing: 3 });
    expect(m.build[m.idx(x, r + 1)]).toBe(Build.Gate);
    const inside = [m.idx(x, r + 2), m.idx(x, r + 3), m.idx(x + 1, r + 3), m.idx(x + 2, r + 3)];
    world.command({ type: 'build', kind: 'portRoad', tiles: inside });
    // With room at the end for the trucks to turn round in: two wide each way.
    const turn = [m.idx(x + 3, r + 3), m.idx(x + 2, r + 4), m.idx(x + 3, r + 4)];
    world.command({ type: 'bulldoze', tiles: turn });
    world.command({ type: 'build', kind: 'portRoad', tiles: turn });
    expect(turn.every((i) => m.build[i] === Build.PortRoad)).toBe(true);
    let together = false;
    let loadTime = 0;
    for (let t = 0; t < TICKS_PER_DAY && store.crates.length > 0; t++) {
      world.step();
      const loading = world.trucks.filter((k) => k.bayIdx === at && k.state === 'loading');
      // Both on the port road inside.
      for (const k of loading) {
        expect([...inside, ...turn]).toContain(m.idx(Math.floor(k.x), Math.floor(k.y)));
      }
      if (loading.length === 2 && loading[0].goal !== loading[1].goal) together = true;
      if (loading.length > 0) loadTime++;
    }
    expect(together).toBe(true);
    expect(store.crates.length).toBe(0);
    // 24 crates, two trucks at a time, quicker per crate than by hand.
    expect(loadTime).toBeLessThan((24 * B.BAY_LOAD_TICKS) / 2);
  });

  it('keeps what an area holds as it grows, joins up or shrinks', () => {
    const world = World.create(7);
    world.tier = 1;
    world.cash = 100_000;
    const m = world.map;
    const at = besideRoad(world, 2);
    const row = [at, at + 1, at + 2];
    world.command({ type: 'bulldoze', tiles: row });
    world.command({ type: 'build', kind: 'portRoad', tiles: row });
    world.command({ type: 'store', tiles: [at], kind: 'crates', on: true });
    world.command({ type: 'store', tiles: [at + 2], kind: 'crates', on: true });
    expect(world.bays.has(at) && world.bays.has(at + 2)).toBe(true);
    world.bays.get(at)!.crates.push(...Array(10).fill(20));
    world.bays.get(at + 2)!.crates.push(...Array(5).fill(30));
    // The tile between joins them into one area.
    world.command({ type: 'store', tiles: [at + 1], kind: 'crates', on: true });
    expect(world.bays.has(at + 2)).toBe(false);
    const area = world.bays.get(at)!;
    expect(area.tiles).toEqual(row);
    expect(area.crates).toHaveLength(15);
    // Goods are stacked from the first tile on: clearing the middle splits
    // it again and loses nothing.
    world.command({ type: 'store', tiles: [at + 1], kind: 'crates', on: false });
    expect(world.bays.get(at)!.crates).toHaveLength(15);
    expect(world.bays.get(at + 2)!.crates).toHaveLength(0);
    // Bulldozing the road under a full tile takes its crates with it.
    world.bays.get(at)!.crates.push(...Array(B.CRATES_PER_STORE_TILE - 15).fill(20));
    world.bays.get(at + 2)!.crates.push(40);
    world.command({ type: 'bulldoze', tiles: [at] });
    expect(world.bays.has(at)).toBe(false);
    expect(m.store[at]).toBe(0);
    expect(world.bays.get(at + 2)!.crates).toEqual([40]);
  });

  it('keeps storage for cargo coming in apart from storage for cargo going out', () => {
    const world = World.create(7);
    world.tier = 1;
    world.cash = 100_000;
    const m = world.map;
    const at = besideRoad(world, 2);
    const row = [at, at + 1, at + 2, at + 3];
    world.command({ type: 'bulldoze', tiles: row });
    world.command({ type: 'build', kind: 'portRoad', tiles: row });
    world.command({ type: 'store', tiles: [at, at + 1], kind: 'crates', on: true });
    world.command({ type: 'store', tiles: [at + 2, at + 3], kind: 'cratesOut', on: true });
    // Touching, but two areas, one each way.
    const into = world.bays.get(at)!;
    const out = world.bays.get(at + 2)!;
    expect(m.store[at + 2]).toBe(Store.CratesOut);
    expect(out.outgoing).toBe(true);
    expect([world['takesImports'](into), world['takesExports'](into)]).toEqual([true, false]);
    expect([world['takesImports'](out), world['takesExports'](out)]).toEqual([false, true]);
  });

  it('clears storage and machines-only marks with Unmark, but not the ground round a crane', () => {
    const world = World.create(7);
    world.boats.length = 0;
    world.tier = 2;
    world.cash = 100_000;
    const m = world.map;
    const r = m.yOf(m.entry);
    const jetty = [...Array(m.w).keys()]
      .map((x) => m.idx(x, r))
      .filter((i) => m.build[i] === Build.Jetty);
    world.command({ type: 'build', kind: 'quay', tiles: jetty });
    world.command({ type: 'build', kind: 'jibCrane', tiles: [jetty[jetty.length - 1]] });
    const store = jetty[0];
    const marked = jetty[1];
    const crane = jetty[jetty.length - 2];
    world.command({ type: 'store', tiles: [store], kind: 'crates', on: true });
    world.command({ type: 'forkliftOnly', tiles: [marked], on: true });
    expect(m.store[store]).toBe(Store.Crates);
    expect(forkliftOnly(m, marked)).toBe(true);
    const cash = world.cash;
    world.command({ type: 'unmark', tiles: [store, marked, crane] });
    expect(m.store[store]).toBe(Store.None);
    expect(forkliftOnly(m, marked)).toBe(false);
    expect(world.bays.has(store)).toBe(false);
    // Storage gives back what bulldozing it would; the quay stays.
    expect(world.cash).toBeGreaterThan(cash);
    expect(m.build[store]).toBe(Build.Quay);
    // Beside the crane it is still for port machines only.
    expect(machinesOnly(m, crane)).toBe(true);
  });

  it('keeps storage by a crane to the way it is marked out, in or out', () => {
    const world = World.create(7);
    world.boats.length = 0;
    world.tier = 1;
    world.cash = 100_000;
    const m = world.map;
    const r = m.yOf(m.entry);
    const jetty = [...Array(m.w).keys()]
      .map((x) => m.idx(x, r))
      .filter((i) => m.build[i] === Build.Jetty);
    world.command({ type: 'build', kind: 'quay', tiles: jetty });
    world.command({ type: 'build', kind: 'jibCrane', tiles: [jetty[jetty.length - 1]] });
    const at = jetty[jetty.length - 2];
    world.command({ type: 'store', tiles: [at], kind: 'crates', on: true });
    const area = world.bays.get(at)!;
    expect(world['byCrane'](area)).toBe(true);
    // Marked for cargo coming in, it takes no exports even when empty.
    expect([world['takesImports'](area), world['takesExports'](area)]).toEqual([true, false]);
    // Marked for cargo going out, no imports.
    world.command({ type: 'store', tiles: [at], kind: 'crates', on: false });
    world.command({ type: 'store', tiles: [at], kind: 'cratesOut', on: true });
    const out = world.bays.get(at)!;
    expect([world['takesImports'](out), world['takesExports'](out)]).toEqual([false, true]);
  });

  it('warns, once a day, when shippers find no outgoing storage with room', () => {
    const world = World.create(7);
    const said = () =>
      world.drainEvents().filter((e) => e.kind === 'message' && /going out/.test(e.text)).length;
    world.drainEvents();
    world['outgoingFull'](true);
    world['outgoingFull'](true);
    expect(said()).toBe(1);
    world.tick += TICKS_PER_DAY;
    world['outgoingFull'](true);
    expect(said()).toBe(1);
  });

  it('turns warehouses and container yards from older saves into storage areas', () => {
    const world = World.create(7);
    const m = world.map;
    const at = besideRoad(world);
    const tiles = [at, at + 1, at + m.w, at + m.w + 1];
    const save = world.toSave();
    for (const [k, t] of tiles.entries()) {
      save.map.build[t] = Build.Warehouse;
      save.map.orient[t] = k === 0 ? 3 : 3 | EXTENSION | (k << 4);
    }
    delete save.map.store;
    save.bays.push({
      idx: at,
      large: true,
      warehouse: true,
      boxes: [],
      boxIncoming: 0,
      crates: Array(7).fill(20),
      incoming: 0,
      nextTruckTick: 0,
      noAccess: false,
    });
    const loaded = World.fromSave(save);
    const lm = loaded.map;
    expect(tiles.every((t) => lm.build[t] === Build.PortRoad && lm.store[t] === Store.Crates)).toBe(
      true,
    );
    const area = loaded.bays.get(at)!;
    expect(area.tiles).toEqual(tiles);
    expect(area.crates).toHaveLength(7);
  });

  it('lets trucks queue in parking for a loading spot, outside or inside the port', () => {
    const world = World.create(7);
    world.boats.length = 0;
    const m = world.map;
    const lot = parkingLot(world);
    expect(m.build[lot[0]]).toBe(Build.Parking);
    const [info] = parkingLots(m);
    expect(info.why).toBeNull();
    expect(info.outside).toBe(true);
    expect(info.spaces).toHaveLength(2);
    // One bay, more trucks than it can load at once: the rest park and wait.
    const h = world.contracts.find((c) => c.terms.kind === 'haulier')!;
    if (h.terms.kind === 'haulier') h.terms.fleet = 3;
    const bay = [...world.bays.values()][0];
    bay.crates.push(...Array(B.BAY_CAPACITY).fill(20));
    let parked = 0;
    // Each parked truck leaves forwards, onto the road on the far side.
    let backwards = 0;
    let forwards = 0;
    const from = new Map<number, number>();
    for (let k = 0; k < TICKS_PER_DAY && bay.crates.length > 0; k++) {
      world.step();
      parked = Math.max(parked, world.trucks.filter((t) => t.state === 'parked').length);
      for (const t of world.trucks) {
        if (t.state === 'parked' && t.parkFrom !== undefined) from.set(t.id, t.parkFrom);
        const came = from.get(t.id);
        if (came === undefined || t.state === 'parked') continue;
        const out = t.path.find((i) => !lot.includes(i));
        if (out !== undefined) out === came ? backwards++ : forwards++;
        from.delete(t.id);
      }
    }
    expect(parked).toBeGreaterThan(0);
    expect(forwards).toBeGreaterThan(0);
    expect(backwards).toBe(0);
    expect(bay.crates.length).toBeLessThan(B.BAY_CAPACITY);
  });

  it('keeps the big trucks to parking two tiles wide', () => {
    expect(needsWideSpace(B.BIG_TRUCK_CAPACITY, false)).toBe(true);
    expect(needsWideSpace(B.TRUCK_CAPACITY, false)).toBe(false);
    expect(needsWideSpace(2, true)).toBe(true);
    const world = World.create(7);
    parkingLot(world);
    const [lot] = parkingLots(world.map);
    expect(lot.wide).toBe(false);
    expect(world['freeParking'](null, true, true)).toBeNull();
    expect(world['freeParking'](null, true, false)).not.toBeNull();
  });

  it('says why parking laid out wrong is no use', () => {
    const world = World.create(7);
    world.tier = 1;
    world.cash = 100_000;
    const m = world.map;
    const why = () => world.snapshot().parking.map((l) => l.why);
    // A road along one side only.
    const at = besideRoad(world);
    world.command({ type: 'build', kind: 'parking', tiles: [at, at + 1] });
    expect(why()[0]).toMatch(/both its long sides/);
    // Not a straight strip.
    world.command({ type: 'build', kind: 'parking', tiles: [at + m.w] });
    expect(why()[0]).toMatch(/straight strip/);
    world.command({ type: 'bulldoze', tiles: [at, at + 1, at + m.w] });
    // A public road one side, a port road the other.
    world.command({ type: 'build', kind: 'parking', tiles: [at] });
    world.command({ type: 'build', kind: 'portRoad', tiles: [at + m.w] });
    expect(why()[0]).toMatch(/without a gate/);
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

describe('Rules of the road', () => {
  /** A truck at x, y heading `dir`, on its way along `path`. */
  function truck(world: World, x: number, y: number, dir: number, path: number[] = []) {
    const t = {
      id: world.nextId++,
      contractId: -1,
      company: 'Test',
      capacity: 6,
      x,
      y,
      dir,
      path,
      goal: path.at(-1) ?? 0,
      state: 'leaving' as const,
      bayIdx: -1,
      cargo: 0,
      value: 0,
      boxes: false,
      idle: 0,
      timer: 0,
      variant: 0,
      held: 0,
    };
    world.trucks.push(t);
    return t;
  }

  it('never turns a truck about on a road one tile wide, only where there is room', () => {
    // A dead end one wide, and the same with a block two wide at its end.
    const w = 8;
    const h = 4;
    const road = new Set([8, 9, 10, 11, 12]);
    const cost = (i: number) => (road.has(i) ? 1 : Infinity);
    const nowhere = () => false;
    // Heading east along it, it cannot come back west.
    expect(findDrivePath(w, h, 9, 8, 8, cost, nowhere)).toBeNull();
    // Starting either way, it can.
    expect(findDrivePath(w, h, 9, -1, 8, cost, nowhere)).toEqual([8]);
    // With room to turn at the end it goes on, comes round and back.
    const back = findDrivePath(w, h, 9, 8, 8, cost, (i) => i === 12);
    expect(back).toEqual([10, 11, 12, 11, 10, 9, 8]);
  });

  it('keeps its distance behind a truck going its way, but passes one coming the other way', () => {
    const world = World.create(7);
    world.trucks.length = 0;
    // On its way east, as it faces.
    const east = [world.map.idx(20, 20)];
    const a = truck(world, 10.5, 20.5, 0, east);
    // Up to speed, gathering it as it goes.
    const pace = () => {
      for (let k = 0; k < B.VEHICLE_ACCEL_TICKS; k++) world['pace'](a)();
      return world['pace'](a)();
    };
    expect(pace()).toBeCloseTo(B.TRUCK_SPEED, 6);
    // Close ahead, going the same way: it holds back.
    const b = truck(world, 11, 20.5, 0, east);
    expect(pace()).toBe(0);
    // Coming the other way it is in the other lane.
    b.dir = Math.PI;
    expect(pace()).toBeCloseTo(B.TRUCK_SPEED, 6);
    // Further ahead, it closes up to the gap and no closer, braking as it does.
    b.dir = 0;
    b.x = 10.5 + B.truckLength(6, false) + B.TRUCK_GAP + 0.3;
    const closing = pace();
    expect(closing).toBeGreaterThan(0);
    expect(closing).toBeLessThan(0.3);
  });

  it('gives way at a junction to a truck coming in from its right', () => {
    const world = World.create(7);
    world.trucks.length = 0;
    const m = world.map;
    // A crossroads of public roads.
    const j = m.idx(10, 10);
    for (const d of [-2, -1, 0, 1, 2]) {
      m.build[m.idx(10 + d, 10)] = Build.Road;
      m.build[m.idx(10, 10 + d)] = Build.Road;
    }
    world['junctionCache'] = null;
    expect(world['junctions']()[j]).toBe(1);
    const cx = m.xOf(j) + 0.5;
    const cy = m.yOf(j) + 0.5;
    // One coming up from the south heading north, one from the east heading west.
    const north = truck(world, cx, cy + 1, -Math.PI / 2, [j]);
    const west = truck(world, cx + 1, cy, Math.PI, [j]);
    expect(world['mayEnter'](north)(j)).toBe(false);
    expect(world['mayEnter'](west)(j)).toBe(true);
    // Both standing at the line, they take turns rather than wait for each other.
    north.held = west.held = 5;
    const turns = new Set<boolean>();
    for (let k = 0; k < 2; k++) {
      world.tick = k * B.TRUCK_TAKE_TURNS;
      turns.add(world['mayEnter'](north)(j));
      expect(world['mayEnter'](west)(j)).toBe(true);
    }
    expect([...turns].sort()).toEqual([false, true]);
    // While one is driving across, the other waits for it.
    west.held = 0;
    west.x = cx;
    west.y = cy;
    north.held = 0;
    expect(world['mayEnter'](north)(j)).toBe(false);
    // One coming through the other way passes it.
    west.dir = Math.PI / 2;
    expect(world['mayEnter'](north)(j)).toBe(true);
    // Wedged for good, it goes anyway.
    west.dir = Math.PI;
    north.held = B.TRUCK_SQUEEZE_AFTER + 1;
    expect(world['mayEnter'](north)(j)).toBe(true);
  });

  it('has one of two trucks caught across each other wait for the other', () => {
    const world = World.create(7);
    world.trucks.length = 0;
    // One turning north out of the eastbound lane, across one going west.
    const a = truck(world, 10.5, 20.4, -Math.PI / 2, [1]);
    const b = truck(world, 10.8, 20.5, Math.PI, [1]);
    const moves = [world['pace'](a)(), world['pace'](b)()].filter((v) => v > 0);
    expect(moves).toHaveLength(1);
  });

  it('drives on the right-hand side of the road', () => {
    const world = World.create(7);
    world.trucks.length = 0;
    truck(world, 10.5, 20.5, 0, [1]);
    const view = world.snapshot().entities.find((e) => e.kind === 'truck')!;
    // Heading east, the right is south.
    expect(view.x).toBeCloseTo(10.5);
    expect(view.y).toBeCloseTo(20.5 + B.TRUCK_LANE);
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

describe('Rules of the road', () => {
  it('has boats meeting head on both turn to starboard and pass port to port', () => {
    const world = World.create(7);
    const m = world.map;
    const template = world.boats[0];
    world.boats.length = 0;
    const y = m.yOf(m.entry) + 8.5;
    const x = m.w - 30;
    const boat = (id: number, from: number, to: number, state: 'leaving' | 'approaching') => ({
      ...template,
      id,
      state,
      x: from + 0.5,
      y,
      dir: to > from ? 0 : Math.PI,
      speed: B.VESSELS.smack.speed,
      path: [m.idx(to, Math.floor(y))],
      goal: m.idx(to, Math.floor(y)),
      berth: -1,
      jetty: -1,
    });
    world.boats.push(
      boat(1000, x - 8, m.w - 1, 'leaving'),
      boat(1001, x + 8, x - 14, 'approaching'),
    );
    const [a, c] = world.boats;
    let closest = Infinity;
    let side = 0;
    for (let t = 0; t < 200 && world.boats.length === 2; t++) {
      world.step();
      const d = Math.hypot(a.x - c.x, a.y - c.y);
      if (d < closest) {
        closest = d;
        // Which side of the eastbound boat the other is on: port is north.
        side = Math.sign(c.y - a.y);
      }
    }
    expect(closest).toBeGreaterThan(B.VESSELS.smack.beam);
    expect(side).toBe(-1);
  });

  /**
   * Two boats on a collision course at right angles, both meeting the
   * crossing at (75.5, 40.5): `east` comes from the west, `north` from the
   * south. Returns how close they came, the slowest `north` went once at
   * speed, and where `north` was when `east` crossed its track.
   */
  function crossing(east: 'smack' | 'feeder', north: 'smack' | 'feeder') {
    const world = World.create(7);
    const m = world.map;
    const template = world.boats[0];
    world.boats.length = 0;
    const draft = { smack: template.draft, feeder: B.FEEDER_DRAFT };
    const boat = (id: number, vessel: 'smack' | 'feeder', x: number, y: number, to: number) => {
      expect(m.depth[m.idx(Math.floor(x), Math.floor(y))]).toBeGreaterThan(draft[vessel]);
      return {
        ...template,
        id,
        vessel,
        draft: draft[vessel],
        state: 'leaving' as const,
        x,
        y,
        dir: id === 1000 ? 0 : -Math.PI / 2,
        speed: B.VESSELS[vessel].speed,
        path: [to],
        goal: to,
        berth: -1,
        jetty: -1,
      };
    };
    // Each the same time away from the crossing.
    const ticks = 8 / B.VESSELS.smack.speed;
    const ex = 75.5 - B.VESSELS[east].speed * ticks;
    const ny = 40.5 + B.VESSELS[north].speed * ticks;
    world.boats.push(
      boat(1000, east, ex, 40.5, m.idx(95, 40)),
      boat(1001, north, 75.5, ny, m.idx(75, 10)),
    );
    const [e, n] = world.boats;
    let closest = Infinity;
    let slowest = Infinity;
    let northAt = NaN;
    for (let t = 0; t < 250 && world.boats.length === 2; t++) {
      const was = e.x;
      world.step();
      closest = Math.min(closest, Math.hypot(e.x - n.x, e.y - n.y));
      slowest = Math.min(slowest, (n.speed ?? 0) / B.VESSELS[north].speed);
      if (was < 75.5 && e.x >= 75.5) northAt = n.y;
    }
    return { closest, slowest, northAt };
  }

  it('has the boat with the other on its starboard side give way, passing astern', () => {
    // The northbound smack is on the eastbound one's starboard side.
    const r = crossing('smack', 'smack');
    // Clear of each other's hulls, crossing at right angles.
    expect(r.closest).toBeGreaterThan(B.VESSELS.smack.length / 2 + B.VESSELS.smack.beam);
    // The other holds its course and speed, and is across first.
    expect(r.slowest).toBeGreaterThan(0.9);
    expect(r.northAt).toBeLessThan(40.5 - B.VESSELS.smack.length);
  });

  it('has a smaller boat give way to a bigger ship, wherever it lies', () => {
    // The feeder has the smack on its starboard side, but the smack is
    // smaller: it gives way all the same.
    const r = crossing('feeder', 'smack');
    expect(r.closest).toBeGreaterThan(B.VESSELS.feeder.length / 2 + B.VESSELS.smack.beam);
    // The smack has slowed to let the feeder across ahead of it.
    expect(r.slowest).toBeLessThan(0.75);
    expect(r.northAt).toBeGreaterThan(40.5 + B.VESSELS.smack.length / 2);
  });
});

describe('Buoys', () => {
  it('lead boats in and out between pairs of buoys, in order, well clear of them', () => {
    const world = World.create(7);
    world.tier = 1;
    world.cash = 100_000;
    const m = world.map;
    const row = m.yOf(m.entry);
    let shore = 0;
    while (m.isLand(m.idx(shore + 1, row))) shore++;
    // Two pairs marking the way in to the north, two the way out to the south.
    const pairs = (dy: number[], dxs: number[]) =>
      dxs.map((dx) => dy.map((y) => m.idx(shore + dx, row + y)));
    const ins = pairs([-13, -4], [26, 16]);
    const outs = pairs([4, 13], [12, 22]);
    world.command({ type: 'build', kind: 'buoyIn', tiles: ins.flat() });
    world.command({ type: 'build', kind: 'buoyOut', tiles: outs.flat() });
    expect(ins.flat().every((i) => m.build[i] === Build.BuoyIn)).toBe(true);
    expect(outs.flat().every((i) => m.build[i] === Build.BuoyOut)).toBe(true);
    // Buoys leave the water open, and stand a tile apart.
    expect(placementError(m, 'buoyIn', ins[0][0] + 1)).not.toBeNull();
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
    const at = (i: number) => [m.xOf(i) + 0.5, m.yOf(i) + 0.5];
    // Did the move from p to q cross the line between buoys a and b?
    const cross = (p: number[], q: number[], [a, b]: number[]) => {
      const [ax, ay] = at(a);
      const [bx, by] = at(b);
      const side = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) =>
        Math.sign((x1 - x0) * (y - y0) - (y1 - y0) * (x - x0));
      return (
        side(p[0], p[1], ax, ay, bx, by) !== side(q[0], q[1], ax, ay, bx, by) &&
        side(ax, ay, p[0], p[1], q[0], q[1]) !== side(bx, by, p[0], p[1], q[0], q[1])
      );
    };
    const crossed = new Map<number, { in: number[]; out: number[] }>();
    const side = world['gateSide'].bind(world);
    // Where each boat came in from: out beyond the outermost green pair.
    const beyond: boolean[] = [];
    const last = new Map<number, number[]>();
    let closest = Infinity;
    const buoys = [...ins.flat(), ...outs.flat()].map(at);
    const half = B.VESSELS.smack.length / 2;
    // Long enough for a few boats to work out of a tight berth and away.
    for (let t = 0; t < TICKS_PER_DAY * 4; t++) {
      world.step();
      for (const b of world.boats) {
        const here = [b.x, b.y];
        const was = last.get(b.id);
        if (!was) beyond.push(side(ins[0][0], ins[0][1], b.x, b.y) > 0);
        last.set(b.id, here);
        const seen = crossed.get(b.id) ?? { in: [], out: [] };
        crossed.set(b.id, seen);
        if (was) {
          ins.forEach((g, k) => cross(was, here, g) && seen.in.push(k));
          outs.forEach((g, k) => cross(was, here, g) && seen.out.push(k));
        }
        // From each buoy to the nearest point of the hull's centreline.
        for (const [x, y] of buoys) {
          const t = (x - b.x) * Math.cos(b.dir) + (y - b.y) * Math.sin(b.dir);
          const along = Math.max(-half, Math.min(half, t));
          const d = Math.hypot(
            b.x + Math.cos(b.dir) * along - x,
            b.y + Math.sin(b.dir) * along - y,
          );
          closest = Math.min(closest, d);
        }
      }
    }
    const routes = [...crossed.values()];
    // In through each pair furthest out first, out through each nearest the docks first.
    for (const r of routes) {
      expect(r.in).toEqual([...r.in].sort((p, q) => p - q));
      expect(r.out).toEqual([...r.out].sort((p, q) => p - q));
    }
    expect(routes.filter((r) => r.in.join() === '0,1').length).toBeGreaterThan(2);
    expect(routes.filter((r) => r.out.join() === '0,1').length).toBeGreaterThan(2);
    expect(beyond.filter((b) => !b)).toEqual([]);
    // Never close enough to touch a buoy.
    expect(closest).toBeGreaterThan(B.VESSELS.smack.beam / 2 + 0.3);
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
    // A 2×2 container yard marked out on port road, beside the public road
    // where the trucks load and the port road the stackers come in by.
    const corner = m.idx(start - 2, r - 2);
    const area = [corner, corner + 1, corner + m.w, corner + m.w + 1];
    world.command({ type: 'bulldoze', tiles: area });
    world.command({ type: 'build', kind: 'portRoad', tiles: area });
    world.command({ type: 'store', tiles: area, kind: 'boxes', on: true });
    const yard = corner;
    // Trucks load from inside the port: a gate off the public road beside
    // the yard and a port road spur behind it, along the yard.
    world.command({ type: 'bulldoze', tiles: [corner - 1, corner + m.w - 1] });
    world.command({ type: 'build', kind: 'portGate', tiles: [corner + m.w - 1], facing: 1 });
    world.command({ type: 'build', kind: 'portRoad', tiles: [corner - 1] });
    // And a port road round the far side of the yard to the spur, for the
    // machines: they never drive across the stacks.
    const round = [corner - 1 - m.w, corner - m.w, corner + 1 - m.w];
    world.command({ type: 'bulldoze', tiles: round });
    world.command({ type: 'build', kind: 'portRoad', tiles: round });
    // Room for the trucks to turn round in at the spur: two wide each way.
    const turn = [corner - 2, corner - 2 - m.w];
    world.command({ type: 'bulldoze', tiles: turn });
    world.command({ type: 'build', kind: 'portRoad', tiles: turn });
    const depot = m.idx(start, r - 3);
    world.command({ type: 'bulldoze', tiles: [depot] });
    world.command({ type: 'build', kind: 'depot', tiles: [depot], facing: 1 });
    const office = m.build.findIndex((_, i) => !placementError(m, 'office', i));
    world.command({ type: 'build', kind: 'office', tiles: [office] });
    world.command({ type: 'buyMachine', kind: 'stacker', tile: depot });
    if (m.build[crane] !== Build.HarbourCrane || !world.yards.has(yard)) return null;
    if (!world.people.some((p) => p.kind === 'stacker')) return null;
    return { crane, yard };
  }

  /**
   * Run the terminal's pier on out into deeper water, its harbour crane
   * cleared away, for gantry cranes' rails along its side: where one can go.
   */
  function gantryPier(world: World, crane: number): { at: number; f: number }[] {
    const m = world.map;
    const end = m.xOf(crane);
    const row = m.yOf(crane);
    world.command({ type: 'bulldoze', tiles: [crane] });
    for (const y of [row, row + 1]) {
      for (let x = end + 1; x <= end + 6; x++) {
        world.command({ type: 'build', kind: 'quay', tiles: [m.idx(x, y)] });
      }
    }
    const spots: { at: number; f: number }[] = [];
    for (let x = end - 4; x <= end + 6; x++) {
      for (let f = 0; f < 4; f++) {
        const at = m.idx(x, row);
        if (placementError(m, 'gantryCrane', at, undefined, f) === null) spots.push({ at, f });
      }
    }
    return spots;
  }

  /** Build a gantry crane at the first spot where a feeder can lie centred on it. */
  function placeGantry(
    world: World,
    spots: { at: number; f: number }[],
  ): { at: number; f: number } {
    for (const s of spots) {
      world.command({ type: 'build', kind: 'gantryCrane', tiles: [s.at], facing: s.f });
      const crane = world.cranes.get(s.at);
      if (crane && world['berthTrouble'](crane) === null) return s;
      world.command({ type: 'bulldoze', tiles: [s.at] });
    }
    throw new Error('No spot on the pier where a feeder lies centred on a gantry crane');
  }

  /**
   * A tug berth beside the docks, as far from the feeder berth at the crane
   * as there is room for, and a tug lying in it.
   */
  function withTug(world: World, crane: number): void {
    const m = world.map;
    const far = (i: number) =>
      Math.abs(m.xOf(i) - m.xOf(crane)) + Math.abs(m.yOf(i) - m.yOf(crane));
    let berth = -1;
    for (let i = 0; i < m.build.length; i++) {
      if (placementError(m, 'tugBerth', i)) continue;
      if (berth < 0 || far(i) > far(berth)) berth = i;
    }
    world.command({ type: 'build', kind: 'tugBerth', tiles: [berth] });
    world.command({ type: 'buyTug', tile: berth });
    expect(world.tugs.length).toBe(1);
  }

  /** A port with a feeder line sending a ship a day, and a tug or not. */
  function feederPort(tug: boolean): World {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    if (tug) withTug(world, t.crane);
    world['addContract'](
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
    return world;
  }

  it('has a tug work a feeder in alongside, quicker than it comes in on its own', () => {
    // From when it is sent in to its berth until it is moored there.
    const berthing = (tug: boolean) => {
      const world = feederPort(tug);
      let sent = -1;
      let worked = false;
      for (let k = 0; k < TICKS_PER_DAY * 4; k++) {
        world.step();
        const ship = world.boats.find((b) => b.vessel === 'feeder');
        if (!ship) continue;
        if (ship.state === 'arriving' && sent < 0) sent = world.tick;
        if (world.tugs.some((t) => t.ship === ship.id && t.state === 'assist')) worked = true;
        if (ship.state === 'moored' && sent >= 0) return { ticks: world.tick - sent, worked };
      }
      return { ticks: Infinity, worked };
    };
    const alone = berthing(false);
    const tugged = berthing(true);
    expect(tugged.worked).toBe(true);
    expect(tugged.ticks).toBeLessThan(alone.ticks * 0.85);
  });

  it('lifts containers off a feeder, stacks them in a yard and trucks them out', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world);
    expect(t).not.toBeNull();
    withTug(world, t!.crane);
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
    // With no yard gantry, the stackers load the trucks too: a second one.
    const depot = world.map.build.findIndex((c) => c === Build.Depot);
    world.command({ type: 'buyMachine', kind: 'stacker', tile: depot });
    // A feeder takes a while to come alongside.
    for (let k = 0; k < TICKS_PER_DAY * 4; k++) world.step();
    expect(world.stats.containers).toBeGreaterThan(0);
    // Dockhands never touch containers.
    expect(world.people.filter((p) => p.kind === 'dockhand').every((p) => p.carrying <= 1)).toBe(
      true,
    );
    expect(world.stats.earned - earned).toBeGreaterThan(150 * 3);
  });

  /**
   * A container port with feeders and container trucks calling, and a yard
   * gantry beside the yard or not. Counts containers that went onto trucks
   * while a stacker was working that truck, and those that went on without.
   */
  function truckLoading(gantry: boolean) {
    const world = feederPort(true);
    const m = world.map;
    const yard = [...world.yards.values()][0];
    if (gantry) {
      // Not on the port road the trucks load from, inside the gate.
      const loading: number[] = world['storeSpots'](yard);
      const spot = m.build.findIndex(
        (_, i) => !placementError(m, 'yardGantry', i) && !loading.includes(i),
      );
      expect(spot).toBeGreaterThanOrEqual(0);
      world.command({ type: 'build', kind: 'yardGantry', tiles: [spot] });
      expect(m.build[spot]).toBe(Build.YardGantry);
      // The gantry closes the road round the yard: room beside its lane for
      // the trucks to turn round and drive back out.
      const turn = [yard.idx - 2 * m.w - 1, yard.idx - 2 * m.w];
      world.command({ type: 'bulldoze', tiles: turn });
      world.command({ type: 'build', kind: 'portRoad', tiles: turn });
    }
    world['addContract'](
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
    let byStacker = 0;
    let byItself = 0;
    let stackerJobs = 0;
    const was = new Map<number, number>();
    for (let k = 0; k < TICKS_PER_DAY * 5; k++) {
      // Who is at a truck going into the tick: a stacker setting a
      // container down finishes the job in it.
      const working = new Set(
        world.people.filter((p) => p.truckId !== undefined).map((p) => p.truckId!),
      );
      stackerJobs += working.size;
      world.step();
      for (const t of world.trucks) {
        const gained = t.cargo - (was.get(t.id) ?? t.cargo);
        if (t.boxes && t.bayIdx === yard.idx && gained > 0) {
          if (working.has(t.id)) byStacker += gained;
          else byItself += gained;
        }
        was.set(t.id, t.cargo);
      }
    }
    return { byStacker, byItself, stackerJobs };
  }

  it('has reach stackers load the trucks at a container yard, unless a yard gantry does', () => {
    const stackers = truckLoading(false);
    expect(stackers.byStacker).toBeGreaterThan(0);
    expect(stackers.byItself).toBe(0);
    const gantry = truckLoading(true);
    expect(gantry.byItself).toBeGreaterThan(0);
    expect(gantry.stackerJobs).toBe(0);
  });

  it('keeps a container looking the same from the ship to the yard and the truck', () => {
    const world = feederPort(true);
    world['addContract'](
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
    // Every container is seen first on a feeder's deck, and wherever it goes
    // after that it looks as it did there.
    const deck = new Set<number>();
    const after = new Set<number>();
    const yards = new Set<number>();
    const carried = { stacker: 0, truck: 0 };
    for (let k = 0; k < TICKS_PER_DAY * 5; k++) {
      world.step();
      // A truck is not loaded for long: look at every one, every tick.
      for (const t of world.trucks) {
        if (!t.boxes || t.cargo === 0) continue;
        carried.truck++;
        for (const l of t.looks ?? []) after.add(l);
      }
      if (k % 5) continue;
      const s = world.snapshot();
      for (const c of s.cranes) for (const l of c.looks ?? []) after.add(l);
      for (const y of s.yards) {
        for (const l of y.looks) {
          after.add(l);
          yards.add(l);
        }
      }
      for (const e of s.entities) {
        if (!e.looks?.length) continue;
        for (const l of e.looks) (e.kind === 'boat' ? deck : after).add(l);
        if (e.kind === 'stacker') carried.stacker++;
      }
    }
    expect(carried.stacker).toBeGreaterThan(0);
    expect(carried.truck).toBeGreaterThan(0);
    expect([...after].filter((l) => !deck.has(l))).toEqual([]);
    // And they are not all alike.
    expect(yards.size).toBeGreaterThan(2);
  });

  it('lets trucks drive in under a yard gantry to load', () => {
    const world = feederPort(true);
    const m = world.map;
    const yard = [...world.yards.values()][0];
    const spot: number = world['storeSpots'](yard)[0];
    expect(placementError(m, 'yardGantry', spot)).toBeNull();
    world.command({ type: 'build', kind: 'yardGantry', tiles: [spot] });
    expect(m.build[spot]).toBe(Build.YardGantry);
    // The trucks load under the gantry, where it reaches out of the yard.
    expect(world['storeSpots'](yard)).toEqual([spot]);
    world['addContract'](
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
    let loaded = 0;
    let working = 0;
    for (let k = 0; k < TICKS_PER_DAY * 5; k++) {
      const before = world.trucks.reduce((n, t) => n + (t.boxes ? t.cargo : 0), 0);
      world.step();
      loaded += Math.max(0, world.trucks.reduce((n, t) => n + (t.boxes ? t.cargo : 0), 0) - before);
      // The gantry does it: no stacker works a truck here.
      expect(world.people.some((p) => p.truckId !== undefined)).toBe(false);
      if (k % 10 === 0 && world.snapshot().yards.some((y) => y.working)) working++;
    }
    expect(loaded).toBeGreaterThan(0);
    // And shows it at work, for its trolley to run.
    expect(working).toBeGreaterThan(0);
  });

  it('has terminal tractors bring containers to a yard with a gantry, with no reach stackers', () => {
    const world = feederPort(true);
    const m = world.map;
    const yard = [...world.yards.values()][0];
    const spot: number = world['storeSpots'](yard)[0];
    world.command({ type: 'build', kind: 'yardGantry', tiles: [spot] });
    expect(m.build[spot]).toBe(Build.YardGantry);
    // The stackers go, and a tractor takes their place.
    for (let k = world.people.length - 1; k >= 0; k--) {
      if (world.people[k].kind === 'stacker') world.people.splice(k, 1);
    }
    const depot = m.build.findIndex((b) => b === Build.Depot);
    world.command({ type: 'buyMachine', kind: 'tractor', tile: depot });
    expect(world.people.filter((p) => p.kind === 'tractor').length).toBe(1);
    let carried = 0;
    let lifting = 0;
    let shown = 0;
    for (let k = 0; k < TICKS_PER_DAY * 3; k++) {
      world.step();
      const t = world.people.find((p) => p.kind === 'tractor')!;
      if (t.carrying > 0) carried++;
      // At the yard, the gantry lifts the container off, in the lane its
      // rails run along.
      if (t.state === 'dropping' && t.bayIdx === yard.idx) {
        lifting++;
        expect(world['gantryLane'](yard)?.has(world['tileOf'](t))).toBe(true);
        if (world.snapshot().yards.some((y) => y.working === 'unload')) shown++;
      }
    }
    expect(carried).toBeGreaterThan(0);
    expect(lifting).toBeGreaterThan(0);
    expect(shown).toBeGreaterThan(0);
    expect(world.stats.containers).toBeGreaterThan(0);
  });

  it('has a gantry crane lift containers onto tractors waiting under it, clear of its stack', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const m = world.map;
    const { at, f } = placeGantry(world, gantryPier(world, t.crane));
    const yard = world.yards.get(t.yard)!;
    const spot: number = world['storeSpots'](yard)[0];
    world.command({ type: 'build', kind: 'yardGantry', tiles: [spot] });
    expect(m.build[spot]).toBe(Build.YardGantry);
    for (let k = world.people.length - 1; k >= 0; k--) {
      if (world.people[k].kind === 'stacker') world.people.splice(k, 1);
    }
    const depot = m.build.findIndex((b) => b === Build.Depot);
    world.command({ type: 'buyMachine', kind: 'tractor', tile: depot });
    world['addContract'](
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
    let given = 0;
    let direct = 0;
    const pick = footprint(m, 'gantryCrane', at, f)[2];
    for (let k = 0; k < TICKS_PER_DAY * 3; k++) {
      world.step();
      const v = world.snapshot().cranes.find((c) => c.idx === at)!;
      // Off the ship straight onto one waiting under it.
      if (v.working === 'unload' && v.workTruck !== undefined) direct++;
      if (v.working === 'give') {
        given++;
        // The tractor waits in the bay between the legs, not in the stack.
        const p = world.people.find((q) => q.id === v.workTruck)!;
        expect(world['tileOf'](p)).toBe(pick);
      }
    }
    expect(given + direct).toBeGreaterThan(0);
    expect(direct).toBeGreaterThan(0);
    expect(world.stats.containers).toBeGreaterThan(0);
  });

  it('takes containers off a gantry crane’s stack only from the top', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const { at } = placeGantry(world, gantryPier(world, t.crane));
    const c = world.cranes.get(at)!;
    // One stack filled first, two high, then the next begun.
    for (let k = 0; k < 5; k++) {
      c.stack.push(100 + k);
      (c.stackFrom ??= []).push(-1);
    }
    const across = B.GANTRY_RAILS * 2;
    const places = world['cranePlaces'](c).stack;
    expect(places).toEqual([0, across, 1, across + 1, 2]);
    // The highest with none on it comes off first; one under another waits.
    expect(world['craneTop'](c, false)).toBe(3);
    c.stack.splice(3, 1);
    c.stackFrom!.splice(3, 1);
    places.splice(3, 1);
    expect(world['craneTop'](c, false)).toBe(1);
    expect(world['craneTop'](c, false)).not.toBe(0);
  });

  it('keeps terminal tractors away from a yard with no gantry', () => {
    const world = feederPort(true);
    for (let k = world.people.length - 1; k >= 0; k--) {
      if (world.people[k].kind === 'stacker') world.people.splice(k, 1);
    }
    const depot = world.map.build.findIndex((b) => b === Build.Depot);
    world.command({ type: 'buyMachine', kind: 'tractor', tile: depot });
    for (let k = 0; k < TICKS_PER_DAY; k++) world.step();
    expect(world.stats.containers).toBe(0);
    expect(world.people.find((p) => p.kind === 'tractor')!.stuck).toMatch(/yard gantry/);
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

  it('marks out a container yard on a quay, and leaves the quay when cleared', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    expect(terminal(world)).not.toBeNull();
    const m = world.map;
    const r = m.yOf(m.entry);
    let x = 0;
    while (!(m.build[m.idx(x, r - 1)] === Build.Quay && !m.isLand(m.idx(x, r - 1)))) x++;
    const tiles = [
      m.idx(x + 1, r - 2),
      m.idx(x + 2, r - 2),
      m.idx(x + 1, r - 1),
      m.idx(x + 2, r - 1),
    ];
    expect(tiles.every((t) => m.build[t] === Build.Quay)).toBe(true);
    world.command({ type: 'store', tiles, kind: 'boxes', on: true });
    expect(tiles.every((t) => m.store[t] === Store.Boxes)).toBe(true);
    const yard = world.yards.get(tiles[0])!;
    expect(yard.tiles).toHaveLength(4);
    // Crates have no place in a container yard, nor a crane on one.
    expect(placementError(m, 'jibCrane', tiles[2])).not.toBeNull();
    world.command({ type: 'store', tiles, kind: 'boxes', on: false });
    expect(tiles.every((t) => m.build[t] === Build.Quay && m.store[t] === 0)).toBe(true);
    expect(world.yards.has(tiles[0])).toBe(false);
  });

  it('sends a container ship to a berth under a gantry crane before a harbour crane', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    expect(terminal(world)).not.toBeNull();
    const m = world.map;
    const from = m.idx(m.w - 1, m.yOf(m.entry) - 10);
    const berths = world['freeBerths'](from, B.FEEDER_DRAFT, true, true);
    expect(berths.length).toBeGreaterThan(1);
    // Say the furthest of them were under a gantry: it goes there.
    const far = berths[berths.length - 1].berth;
    world['gantryReaches'] = (n: number) => n === far;
    expect(world['freeBerths'](from, B.FEEDER_DRAFT, true, true)[0].berth).toBe(far);
  });

  it('lifts containers with a gantry crane into the bay between its legs, for the stackers', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const m = world.map;
    const spots = gantryPier(world, t.crane);
    expect(spots.length).toBeGreaterThan(0);
    const { at, f } = placeGantry(world, spots);
    const tiles = footprint(m, 'gantryCrane', at, f);
    expect(tiles.every((i) => m.build[i] === Build.Gantry)).toBe(true);
    expect(world.cranes.get(at)!.kind).toBe('gantry');
    expect(world.capacity().boxes.berths).toBeGreaterThan(0);
    world['addContract'](
      {
        kind: 'fishery',
        vessel: 'feeder',
        name: 'Test Feeders',
        color: 0,
        boatEvery: 1,
        cratesMin: 30,
        cratesMax: 30,
        fee: 150,
      },
      world.tick + 10,
      0,
    );
    let stacked = 0;
    // The tier each container came off, ship by ship: a tier at a time, top down.
    const tiers = new Map<number, number[]>();
    for (let k = 0; k < TICKS_PER_DAY * 4; k++) {
      world.step();
      stacked = Math.max(stacked, world.cranes.get(at)!.stack.length);
      const v = world.snapshot().cranes.find((c) => c.idx === at)!;
      if (v.working === 'unload') {
        const list = tiers.get(v.workBoat!) ?? [];
        const tier = Math.floor(v.workSlot! / (B.FEEDER_BAYS * B.FEEDER_ROWS));
        if (list.at(-1) !== tier) list.push(tier);
        tiers.set(v.workBoat!, list);
      }
      // No trucks under or round the crane: they load at the yard.
      for (const k of world.trucks) {
        const at = m.idx(Math.floor(k.x), Math.floor(k.y));
        expect(tiles.includes(at)).toBe(false);
      }
    }
    expect(stacked).toBeGreaterThan(1);
    expect(world.stats.containers).toBeGreaterThan(0);
    expect([...tiers.values()].some((list) => list.length > 1)).toBe(true);
    for (const list of tiers.values()) expect(list).toEqual([...list].sort((a, b) => b - a));
    // Taken down, it leaves the quay it stood on.
    world.command({ type: 'bulldoze', tiles: [tiles[3]] });
    expect(tiles.every((i) => m.build[i] === Build.Quay)).toBe(true);
    expect(world.cranes.has(at)).toBe(false);
  });

  it('keeps a ship’s length of quay clear for a gantry crane’s rails, and a tile round them for machines', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const m = world.map;
    const spots = gantryPier(world, t.crane);
    // Not where its rails would run off the quay.
    expect(spots.length).toBeGreaterThan(0);
    const { at, f } = placeGantry(world, spots);
    const rails = gantryRails(m, at, f);
    expect(rails).toHaveLength(2 * B.GANTRY_RAILS);
    const free = rails.filter((i) => m.build[i] === Build.Quay);
    expect(free.length).toBeGreaterThan(0);
    for (const i of free) {
      expect(placementError(m, 'jibCrane', i)).toMatch(/rails/);
      expect(storeError(m, i, 'boxes', true)).toMatch(/rails/);
    }
    const ground = gantryGround(m, at, f).filter((i) => m.build[i] === Build.Quay);
    expect(ground.every((i) => machinesOnly(m, i))).toBe(true);
    // Taken down, the quay is everyone's again.
    world.command({ type: 'bulldoze', tiles: [at] });
    expect(ground.some((i) => machinesOnly(m, i))).toBe(false);
    expect(placementError(m, 'jibCrane', free[0]) ?? '').not.toMatch(/rails/);
  });

  it('has two gantry cranes over one ship share its bays out and work it together', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const m = world.map;
    // Two side by side along the edge of the pier, each 2 wide.
    const spots = gantryPier(world, t.crane);
    let pair: [number, number, number] | null = null;
    for (const { at, f } of spots) {
      const tiles = footprint(m, 'gantryCrane', at, f);
      const next = at + 2 * (tiles[1] - tiles[0]);
      if (!pair && spots.some((q) => q.at === next && q.f === f)) pair = [at, next, f];
    }
    expect(pair).not.toBeNull();
    const [first, second, f] = pair!;
    for (const at of [first, second]) {
      world.command({ type: 'build', kind: 'gantryCrane', tiles: [at], facing: f });
      expect(world.cranes.get(at)?.kind).toBe('gantry');
    }
    world['addContract'](
      {
        kind: 'fishery',
        vessel: 'feeder',
        name: 'Test Feeders',
        color: 0,
        boatEvery: 1,
        cratesMin: 36,
        cratesMax: 36,
        fee: 150,
      },
      world.tick + 10,
      0,
    );
    const bay = (slot: number) =>
      Math.floor((slot % (B.FEEDER_BAYS * B.FEEDER_ROWS)) / B.FEEDER_ROWS);
    // Bays each works while both are at the same ship.
    const bays = new Map<number, number[]>([
      [first, []],
      [second, []],
    ]);
    for (let k = 0; k < TICKS_PER_DAY * 3; k++) {
      world.step();
      const views = world.snapshot().cranes.filter((c) => c.working === 'unload');
      if (views.length < 2 || views[0].workBoat !== views[1].workBoat) continue;
      for (const c of views) bays.get(c.idx)!.push(bay(c.workSlot!));
    }
    // Each in its own half of the ship, never in the other's.
    const [a, b] = [...bays.values()];
    expect(a.length).toBeGreaterThan(0);
    const halves = (list: number[]) => new Set(list.map((n) => n < B.FEEDER_BAYS / 2));
    expect(halves(a).size).toBe(1);
    expect(halves(b).size).toBe(1);
    expect([...halves(a)][0]).not.toBe([...halves(b)][0]);
  });

  it('lets trucks take containers only once customs have cleared them', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    world['addContract'](
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
    const yard = world.yards.get(t.yard)!;
    yard.boxes.push(100, 100);
    yard.boxReady = [world.tick + B.CUSTOMS_TICKS, world.tick + B.CUSTOMS_TICKS + 50];
    for (let k = 0; k < B.CUSTOMS_TICKS - 10; k++) world.step();
    expect(yard.boxes).toHaveLength(2);
    expect(world.snapshot().yards.find((y) => y.idx === t.yard)!.cleared).toBe(0);
    for (let k = 0; k < 400; k++) world.step();
    expect(yard.boxes).toHaveLength(0);
  });

  it('sends a two-container truck to a yard only once two are cleared for it', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    world['addContract'](
      {
        kind: 'haulier',
        name: 'Test Box Haul',
        color: 0,
        fleet: 2,
        capacity: 2,
        dailyFee: 0,
        cargo: 'container',
      },
      0,
      0,
    );
    const yard = world.yards.get(t.yard)!;
    const sent = () => world.trucks.filter((k) => k.boxes && k.bayIdx === t.yard).length;
    // One just cleared: no truck comes for it yet.
    yard.boxes.push(100);
    yard.boxReady = [world.tick];
    for (let k = 0; k < B.PART_LOAD_WAIT / 2; k++) world.step();
    expect(sent()).toBe(0);
    expect(yard.boxes).toHaveLength(1);
    // A second: one comes, and takes both.
    yard.boxes.push(100);
    yard.boxReady!.push(world.tick);
    let most = 0;
    for (let k = 0; k < 400; k++) {
      world.step();
      most = Math.max(most, sent());
    }
    expect(most).toBe(1);
    expect(yard.boxes).toHaveLength(0);
    // A last one on its own is fetched in the end, rather than left for good.
    yard.boxes.push(100);
    yard.boxReady!.push(world.tick);
    for (let k = 0; k < B.PART_LOAD_WAIT + 400; k++) world.step();
    expect(yard.boxes).toHaveLength(0);
  });

  it('lets trucks take a cleared container only once nothing is stacked on it', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const yard = world.yards.get(t.yard)!;
    // The ground first, a stack at a time across the yard where the
    // machines can get at it, every one cleared.
    const ground = world['workable'](yard)!.size * 2;
    for (let k = 0; k < ground; k++) {
      yard.boxes.push(100);
      (yard.boxReady ??= []).push(0);
    }
    world['yardSlots'](yard);
    // One still in customs has nowhere but on top of one of them.
    yard.boxes.push(100);
    yard.boxReady!.push(world.tick + 10 * TICKS_PER_DAY);
    const slots = world['yardSlots'](yard).boxes;
    expect(slots[ground]).toBe(slots[0] + 2);
    // The one under it is buried: the trucks can reach all but that.
    expect(world['reachable'](yard)).toBe(ground - 1);
    expect(world['clearTop'](yard)).not.toBe(0);
    // Once the one on top clears too, it can go, before the one under it.
    yard.boxReady![ground] = 0;
    expect(world['reachable'](yard)).toBe(ground + 1);
    expect(world['clearTop'](yard)).toBe(ground);
  });

  it('stacks a container where it buries none that will clear before it', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const yard = world.yards.get(t.yard)!;
    const ground = (yard.tiles!.length * B.BOXES_PER_STORE_TILE) / 3;
    // The ground full: the first stack clears tomorrow, the rest in a week.
    const soon = world.tick + TICKS_PER_DAY;
    const later = world.tick + 7 * TICKS_PER_DAY;
    for (let k = 0; k < ground; k++) {
      yard.boxes.push(100);
      (yard.boxReady ??= []).push(k === 0 ? soon : later);
    }
    world['yardSlots'](yard);
    // One clearing in a week goes on one of those, not on the first.
    yard.boxes.push(100);
    yard.boxReady!.push(later);
    const slots = world['yardSlots'](yard).boxes;
    expect(slots[ground]).not.toBe(slots[0] + 2);
  });

  it('holds containers in a yard for a day of customs from when their ship is unloaded', () => {
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
        capacity: 1,
        dailyFee: 0,
        cargo: 'container',
      },
      0,
      0,
    );
    const yard = world.yards.get(t.yard)!;
    let stacked = -1;
    let taken = -1;
    for (let k = 0; k < TICKS_PER_DAY * 6 && taken < 0; k++) {
      const before = yard.boxes.length;
      world.step();
      if (stacked < 0 && yard.boxes.length > before) stacked = world.tick;
      if (yard.boxes.length < before) taken = world.tick;
    }
    expect(stacked).toBeGreaterThan(0);
    expect(taken).toBeGreaterThan(0);
    expect(taken - stacked).toBeGreaterThanOrEqual(B.CUSTOMS_TICKS);
    // The clock only started once the whole ship was unloaded.
    const unloaded = Math.min(...world.unloadedAt.values());
    expect(unloaded).toBeGreaterThan(stacked);
    expect(taken - unloaded).toBeGreaterThanOrEqual(B.CUSTOMS_TICKS);
  });

  it('ships out exports: paperwork parked outside, into the yard, onto a feeder', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const m = world.map;
    // Parking off the public road, outside the port, south of it.
    const lot = parkingLot(world);
    expect(m.build[lot[0]]).toBe(Build.Parking);
    // A yard for containers going out beside the one for those coming in,
    // sharing the port road inside the gate that trucks load from.
    const corner = t.yard - 3;
    const out = [corner, corner + 1, corner + m.w, corner + m.w + 1];
    world.command({ type: 'bulldoze', tiles: out });
    world.command({ type: 'build', kind: 'portRoad', tiles: out });
    world.command({ type: 'store', tiles: out, kind: 'boxesOut', on: true });
    expect(world.yards.get(corner)?.outgoing).toBe(true);
    const add = world['addContract'].bind(world);
    add(
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
    const shipper = add(
      {
        kind: 'shipper',
        name: 'Test Exports',
        color: 0,
        cargo: 'container',
        perDay: 6,
        // One container a truck: two need a parking space two tiles wide.
        capacity: 1,
        fee: 100,
      },
      world.tick + 10,
      0,
    );
    const parkedAt = new Map<number, number>();
    let early = 0;
    for (let k = 0; k < TICKS_PER_DAY * 6 && !(world.stats.exported ?? 0); k++) {
      world.step();
      for (const truck of world.trucks) {
        if (truck.contractId !== shipper.id) continue;
        if (truck.state === 'parked' && !parkedAt.has(truck.id)) parkedAt.set(truck.id, world.tick);
        const since = parkedAt.get(truck.id);
        if (
          truck.state === 'toBay' &&
          since !== undefined &&
          world.tick - since < B.PAPERWORK_TICKS
        ) {
          early++;
        }
      }
    }
    expect(parkedAt.size).toBeGreaterThan(0);
    expect(early).toBe(0);
    expect(world.stats.exported ?? 0).toBeGreaterThan(0);
  });

  it('has dockhands carry exported crates on board a coaster', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const m = world.map;
    // Storage for crates going out where the container yard was, by the public road.
    const store = world.yards.get(t.yard)!.tiles!;
    world.command({ type: 'store', tiles: store, kind: 'boxes', on: false });
    world.command({ type: 'store', tiles: store, kind: 'cratesOut', on: true });
    expect(world.bays.has(store[0])).toBe(true);
    const lot = parkingLot(world);
    expect(m.build[lot[0]]).toBe(Build.Parking);
    const add = world['addContract'].bind(world);
    add(
      {
        kind: 'fishery',
        vessel: 'coaster',
        name: 'Test Coasters',
        color: 0,
        boatEvery: 1,
        cratesMin: 4,
        cratesMax: 4,
        fee: 20,
      },
      world.tick + TICKS_PER_DAY,
      0,
    );
    add(
      { kind: 'shipper', name: 'Test Exports', color: 0, perDay: 12, capacity: 6, fee: 20 },
      world.tick + 10,
      0,
    );
    // Loading counts against the coaster's time alongside, with time allowed for it.
    let loadingTicks = 0;
    let allowed = 0;
    for (let k = 0; k < TICKS_PER_DAY * 6 && !(world.stats.exported ?? 0); k++) {
      const coaster = world.boats.find((b) => b.vessel === 'coaster' && b.state === 'moored');
      const before = coaster?.mooredTicks ?? 0;
      const grace = coaster?.grace ?? 0;
      world.step();
      if (coaster && coaster.crates === 0 && coaster.loadQuota !== undefined) {
        loadingTicks += coaster.mooredTicks - before;
        allowed = Math.max(allowed, coaster.grace - grace);
      }
    }
    expect(world.stats.exported ?? 0).toBeGreaterThan(0);
    expect(loadingTicks).toBeGreaterThan(0);
    expect(allowed).toBeGreaterThan(0);
  });

  it('has forklifts take exports left on the quay back into storage once their ship has gone', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const m = world.map;
    const store = world.yards.get(t.yard)!.tiles!;
    world.command({ type: 'store', tiles: store, kind: 'boxes', on: false });
    world.command({ type: 'store', tiles: store, kind: 'cratesOut', on: true });
    const depot = m.build.findIndex((b) => b === Build.Depot);
    world.command({ type: 'buyMachine', kind: 'forklift', tile: depot });
    // Crates set down for a coaster that has sailed without them.
    const quay = m.build.findIndex((b, i) => b === Build.Quay && !m.store[i]);
    const pile = world['pileAt'](quay, false, true)!;
    pile.crates.push(...Array(6).fill(20));
    world.piles.set(quay, pile);
    expect(world['stranded'](pile)).toBe(true);
    const out = world.bays.get(store[0])!;
    for (let k = 0; k < TICKS_PER_DAY && (out.exports?.length ?? 0) < 6; k++) world.step();
    expect(world.piles.get(quay)?.crates.length ?? 0).toBe(0);
    expect(out.exports?.length).toBe(6);
  });

  it('sails once nothing in the port is left for it, and says what it waits on', () => {
    const world = World.create(7);
    const template = world.boats[0];
    world.boats.length = 0;
    const coaster = (id: number) => ({
      ...template,
      id,
      vessel: 'coaster' as const,
      state: 'moored' as const,
      crates: 0,
      reserved: 0,
      out: 0,
      loadQuota: undefined,
      timer: 0,
    });
    const a = coaster(1000);
    const b = coaster(1001);
    world.boats.push(a, b);
    // Four crates waiting to go out: the first ship ready claims them all.
    world['exportsFor'] = () => 4;
    expect(world['stillLoading'](a)).toBe(true);
    expect(a.loadQuota).toBe(4);
    expect(world['stillLoading'](b)).toBe(false);
    expect(b.loadQuota).toBe(0);
    // Its words say it is ready, not taking exports on.
    const words = (id: number) =>
      world.snapshot().entities.find((e) => e.kind === 'boat' && e.id === id)!.activity;
    expect(words(1000)).toMatch(/^Taking exports on board, 0 of 4/);
    expect(words(1001)).toMatch(/^Ready to sail/);
  });

  it('has a ship ready to sail wait its turn only behind one free to go', () => {
    const world = World.create(7);
    const template = world.boats[0];
    world.boats.length = 0;
    const ship = (id: number, timer: number, x: number) => ({
      ...template,
      id,
      vessel: 'coaster' as const,
      state: 'moored' as const,
      crates: 0,
      reserved: 0,
      timer,
      x,
      y: template.y,
    });
    const older = ship(1000, 500, 40.5);
    const younger = ship(1001, 100, 42.5);
    world.boats.push(older, younger);
    expect(world['letsGoFirst'](younger)).toBe(true);
    // The older one is waiting for the fairway itself: the younger goes on.
    older.holdUp = 'fairway';
    expect(world['letsGoFirst'](younger)).toBe(false);
  });

  it('keeps shippers away until there is parking outside the port', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    expect(terminal(world)).not.toBeNull();
    world['addContract'](
      { kind: 'shipper', name: 'Test Exports', color: 0, perDay: 10, capacity: 6, fee: 20 },
      world.tick + 10,
      0,
    );
    for (let k = 0; k < 200; k++) world.step();
    expect(world.trucks.some((t) => t.exports)).toBe(false);
  });

  it('gives a container to the free stacker nearest the crane', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const depot = world.map.build.findIndex((b) => b === Build.Depot);
    world.command({ type: 'buyMachine', kind: 'stacker', tile: depot });
    const [far, near] = world.people.filter((p) => p.kind === 'stacker');
    // One has just dropped a load beside the crane, the other waits at home.
    const m = world.map;
    const by = m.neighbors4(t.crane).find((n) => drivable(m.build[n]))!;
    near.x = m.xOf(by) + 0.5;
    near.y = m.yOf(by) + 0.5;
    far.x = m.xOf(depot) + 0.5;
    far.y = m.yOf(depot) + 0.5;
    world.cranes.get(t.crane)!.stack.push(150);
    // The one at home, asked first, leaves it to the one at the crane.
    expect(world['assignJob'](far)).toBe(false);
    expect(world['assignJob'](near)).toBe(true);
    expect(near.state).toBe('toPickup');
    expect(far.state).not.toBe('toPickup');
  });

  it('has a coaster leaving run out along the dock without touching it', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    expect(terminal(world)).not.toBeNull();
    world['addContract'](
      {
        kind: 'fishery',
        vessel: 'coaster',
        name: 'Test Coasters',
        color: 0,
        boatEvery: 0.5,
        cratesMin: 4,
        cratesMax: 4,
        fee: 20,
      },
      world.tick + 10,
      0,
    );
    // A forklift to take the pallets off.
    const depot = world.map.build.findIndex((b) => b === Build.Depot);
    world.command({ type: 'buyMachine', kind: 'forklift', tile: depot });
    const m = world.map;
    const clips = world['clips'].bind(world);
    let leaving = 0;
    let touching = 0;
    for (let k = 0; k < TICKS_PER_DAY * 3; k++) {
      world.step();
      for (const b of world.boats) {
        if (b.vessel !== 'coaster' || b.state !== 'leaving' || b.castOff === undefined) continue;
        const near = Math.hypot(b.x - m.xOf(b.castOff) - 0.5, b.y - m.yOf(b.castOff) - 0.5);
        if (near > 4) continue;
        leaving++;
        if (clips(b, b.x, b.y, b.dir, []) > 0) touching++;
      }
    }
    expect(leaving).toBeGreaterThan(0);
    expect(touching).toBe(0);
  });

  it('routes boats past the docks well out, not through the water off them', () => {
    const world = World.create(7);
    const m = world.map;
    const row = m.yOf(m.entry);
    // The tip of the starting jetty.
    let tip = 0;
    while (m.build[m.idx(tip + 1, row)] !== Build.None || m.isLand(m.idx(tip + 1, row))) tip++;
    const boat = { ...world.boats[0], state: 'approaching' as const };
    const from = m.idx(tip + 3, row - 8);
    const to = m.idx(tip + 3, row + 8);
    const path = world['route'](boat, from, to, world['seaWay'](boat))!;
    expect(path).not.toBeNull();
    const closest = Math.min(...path.map((i) => Math.hypot(m.xOf(i) - tip, m.yOf(i) - row)));
    expect(closest).toBeGreaterThan(B.DOCK_FRONT_RANGE - 1);
  });

  it('keeps clear water off the bow and stern of boats moored end to end', () => {
    const world = World.create(7);
    const m = world.map;
    const r = m.yOf(m.entry);
    const xs: number[] = [];
    for (let x = 0; x < m.w; x++) if (m.build[m.idx(x, r)] === Build.Jetty) xs.push(x);
    // Berths along the north side of the starting jetty, all in one lane.
    const at = (k: number, vessel: 'smack' | 'coaster') => ({
      berth: m.idx(xs[1] + k, r - 1),
      jetty: m.idx(xs[1] + k, r),
      vessel,
    });
    const clash = world['berthsClash'].bind(world);
    // Two smacks a ship's length apart would lie bow to stern with no water
    // between them; a tile further on they have room.
    expect(clash(at(0, 'smack'), at(2, 'smack'))).toBe(true);
    expect(clash(at(0, 'smack'), at(3, 'smack'))).toBe(false);
    // Coasters, a good deal longer, used to overlap two tiles apart.
    expect(clash(at(0, 'coaster'), at(2, 'coaster'))).toBe(true);
    expect(clash(at(0, 'coaster'), at(3, 'coaster'))).toBe(false);
  });

  it('gives way to a boat pulling out, then to boats leaving, then to the bigger ship', () => {
    const world = World.create(7);
    const template = world.boats[0];
    const boat = (
      id: number,
      vessel: 'smack' | 'feeder',
      state: 'leaving' | 'arriving',
      undock?: number,
    ) => ({ ...template, id, vessel, state, undock });
    const outranks = world['outranks'].bind(world);
    // Going the same way, the bigger ship first, whichever came first.
    expect(outranks(boat(2, 'feeder', 'arriving'), boat(1, 'smack', 'arriving'))).toBe(true);
    // Leaving still beats coming in.
    expect(outranks(boat(1, 'smack', 'leaving'), boat(2, 'feeder', 'arriving'))).toBe(true);
    // Pulling out of its berth beats everyone.
    expect(outranks(boat(3, 'smack', 'leaving', 1), boat(1, 'feeder', 'leaving'))).toBe(true);
  });

  /** A busy container port, with coasters and smacks coming and going all day. */
  function busyPort(): World {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    expect(terminal(world)).not.toBeNull();
    for (const [vessel, every] of [
      ['coaster', 0.4],
      ['smack', 0.15],
    ] as const) {
      world['addContract'](
        {
          kind: 'fishery',
          vessel,
          name: `Test ${vessel}`,
          color: 0,
          boatEvery: every,
          cratesMin: 4,
          cratesMax: 4,
          fee: 20,
        },
        world.tick + 10,
        0,
      );
    }
    const depot = world.map.build.findIndex((b) => b === Build.Depot);
    for (let k = 0; k < 3; k++)
      world.command({ type: 'buyMachine', kind: 'forklift', tile: depot });
    return world;
  }

  it('keeps small boats off the corners of the docks coming alongside and casting off', () => {
    const world = busyPort();
    const clips = world['clips'].bind(world);
    let over = 0;
    let moored = 0;
    for (let k = 0; k < TICKS_PER_DAY * 4; k++) {
      world.step();
      for (const b of world.boats) {
        if (b.state === 'moored') moored++;
        // Long ships are tested on their own; squeezing past, or in when
        // wedged for good, is a last resort.
        const wedged = (b.held ?? 0) > B.BOAT_WEDGED_AFTER;
        if (b.vessel === 'feeder' || b.squeeze || wedged || b.state === 'moored') continue;
        if (clips(b, b.x, b.y, b.dir, []) > 0) over++;
      }
    }
    expect(moored).toBeGreaterThan(0);
    expect(over).toBe(0);
  });

  it('keeps other boats out of the water a ship pulling out needs', () => {
    const world = busyPort();
    const m = world.map;
    const claimed = new Set<number>();
    // Boats already in the water when it was claimed, which may sail out of it.
    const inside = new Map<number, Set<number>>();
    let intrusions = 0;
    for (let k = 0; k < TICKS_PER_DAY * 6; k++) {
      world.step();
      for (const b of world.boats) {
        if (!b.room) {
          inside.delete(b.id);
          continue;
        }
        claimed.add(b.id);
        // Well inside, not just drifting over the edge.
        const within = (o: (typeof world.boats)[number]) =>
          b.room!.spots.some(([x, y, r]) => Math.hypot(o.x - x, o.y - y) < r - 0.3);
        const others = world.boats.filter(
          (o) =>
            o !== b &&
            o.state !== 'moored' &&
            o.state !== 'anchored' &&
            // Wedged in and squeezing past as a last resort.
            !o.squeeze &&
            // Coming in to a berth inside it.
            !(
              o.state === 'arriving' &&
              b.room!.spots.some(
                ([x, y, r]) =>
                  Math.hypot(m.xOf(o.berth) + 0.5 - x, m.yOf(o.berth) + 0.5 - y) < r + 1,
              )
            ),
        );
        const was = inside.get(b.id) ?? new Set(others.filter(within).map((o) => o.id));
        inside.set(b.id, was);
        for (const o of others) if (within(o) && !was.has(o.id)) intrusions++;
      }
    }
    expect(claimed.size).toBeGreaterThan(2);
    expect(intrusions).toBe(0);
  });

  it('stores containers only in yards, where the trucks collect them', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    withTug(world, t.crane);
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
    // Feeders keep landing more, so count what the trucks take away, once
    // customs have had their day after the ship was unloaded.
    let collected = 0;
    for (let k = 0; k < TICKS_PER_DAY * 4; k++) {
      const before = yard.boxes.length;
      world.step();
      collected += Math.max(0, before - yard.boxes.length);
    }
    expect(collected).toBeGreaterThan(0);
  });

  it('loads container trucks at a yard only from inside the port, off machines-only ground', () => {
    const world = World.create(7);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const m = world.map;
    const yard = world.yards.get(t.yard)!;
    // A public road runs along the yard, but trucks load only on the port
    // road behind the gate.
    expect(yard.tiles!.some((i) => m.neighbors4(i).some((n) => m.build[n] === Build.Road))).toBe(
      true,
    );
    const spots: number[] = world['storeSpots'](yard);
    expect(spots.length).toBeGreaterThan(0);
    expect(spots.every((i) => m.build[i] === Build.PortRoad || m.build[i] === Build.Quay)).toBe(
      true,
    );
    // Without the port road inside, nowhere to load, road or no road.
    world.command({ type: 'bulldoze', tiles: spots });
    expect(world['storeSpots'](yard)).toEqual([]);
    world.command({ type: 'build', kind: 'portRoad', tiles: spots });
    expect(world['storeSpots'](yard)).toEqual(spots);
    // Marked for machines only, the yard is the port's machines' alone.
    world.command({ type: 'forkliftOnly', tiles: yard.tiles!, on: true });
    expect(world['storeSpots'](world.yards.get(t.yard)!)).toEqual([]);
    world.command({ type: 'forkliftOnly', tiles: yard.tiles!, on: false });
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
    for (let k = 0; k < TICKS_PER_DAY && yard.boxes.length > 0; k++) world.step();
    expect(yard.noAccess).toBe(false);
    expect(yard.boxes.length).toBe(0);
  });

  it('keeps trucks from loading storage by a crane', () => {
    const world = World.create(7);
    world.boats.length = 0;
    world.tier = 1;
    world.cash = 100_000;
    const m = world.map;
    const r = m.yOf(m.entry);
    const jetty = [...Array(m.w).keys()]
      .map((x) => m.idx(x, r))
      .filter((i) => m.build[i] === Build.Jetty);
    world.command({ type: 'build', kind: 'quay', tiles: jetty });
    const store = jetty[jetty.length - 2];
    world.command({ type: 'store', tiles: [store], kind: 'crates', on: true });
    expect(world.bays.get(store)).toBeDefined();
    world.command({ type: 'build', kind: 'jibCrane', tiles: [jetty[jetty.length - 1]] });
    // Next to a crane it is machines-only ground: the trucks keep off.
    expect(world['byCrane'](world.bays.get(store)!)).toBe(true);
    expect(world['storeSpots'](world.bays.get(store)!)).toEqual([]);
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
