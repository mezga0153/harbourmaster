import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { GameMap } from '../src/sim/map';
import { makeOffer, townTrade } from '../src/sim/contracts';
import { withCargo } from '../src/sim/cargo';
import { growTown, LANDMARKS, landmarkDue, townCap } from '../src/sim/town';
import { generateMap } from '../src/sim/mapgen';
import { isExit } from '../src/sim/roads';
import { findDrivePath, findPath } from '../src/sim/path';
import {
  anchorOf,
  bestFacing,
  drivable,
  EXTENSION,
  depotDoorTrouble,
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
import { bayRoom } from '../src/sim/helpers';
import { World } from '../src/sim/world';
import { tip } from '../src/sim/systems/output';
import {
  berthTrouble,
  boatWhy,
  craneWhy,
  parkedWords,
  problems,
  truckWhy,
} from '../src/sim/systems/snapshot';
import { addContract, capacity, newDay, refreshOffers } from '../src/sim/systems/economy';
import {
  cranePlaces,
  craneReaches,
  craneTakenIn,
  craneTop,
  serveTractor,
  underGantry,
} from '../src/sim/systems/cranes';
import { cornerRing, seaWay, seaWayFor } from '../src/sim/systems/boats/traffic';
import { docks, freeBerths, letsGoFirst, route } from '../src/sim/systems/boats/berthing';
import { berthsClash, gateSide } from '../src/sim/systems/boats/berthing';
import { clips as clipsOf } from '../src/sim/systems/boats/seamanship';
import { outranks as outranksOf } from '../src/sim/systems/boats/traffic';
import {
  craneSpot,
  gantries,
  gantryDone,
  gantryElsewhere,
  gantryFor,
  gantryWork,
  liftDone,
  quayHeading,
  settleGantry,
  takenIn,
  yardLooks,
} from '../src/sim/systems/yardGantry';
import { pathFor, roomToTurn, tileBehind } from '../src/sim/systems/workforce/crowding';
import { assignJob, craneStackTiles, spawnDockhand } from '../src/sim/systems/workforce/dockhands';
import { outgoingFull, shipOut, stillLoading, stranded } from '../src/sim/systems/cargo/exports';
import {
  byCrane,
  clearTop,
  nextYardSlot,
  reachable,
  takesExports,
  takesImports,
  workable,
  yardSlots,
} from '../src/sim/systems/cargo/stores';
import {
  crossesRails,
  dockFor,
  freeParking,
  gantryLane,
  gantryRailWays,
  goDeeper,
  intoSpace,
  routeFrom,
  storeSpots,
  throughCost,
  truckCostFor,
} from '../src/sim/systems/roads/bays';
import {
  ahead,
  gapAhead,
  junctions,
  lengthOf,
  mayEnter,
  pace as paceOf,
  toCrossing,
  truckLeave,
} from '../src/sim/systems/roads/traffic';
import { cutOff, updateTruck } from '../src/sim/systems/roads/trucks';
import { oldPile } from './wharf';

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
  world.command({ type: 'build', kind: 'road', tiles: [...loop, ...lot] });
  // Marked out on the road between the two: parking comes with the Coastal Wharf.
  const tier = world.tier;
  world.tier = Math.max(1, tier);
  world.command({ type: 'build', kind: 'parking', tiles: lot });
  world.tier = tier;
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
    // The road to the jetty leaves the highway at its first exit.
    expect(map.build[map.entry]).toBe(Build.Highway);
    expect(isExit(map, map.entry)).toBe(true);
    expect(map.build[map.entry + 1]).toBe(Build.Road);
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
    const world = World.create(7, 96);
    const start = world.cash;
    for (let t = 0; t < TICKS_PER_DAY * 3; t++) world.step();
    expect(world.stats.boats).toBeGreaterThan(0);
    expect(world.stats.cratesHandled).toBeGreaterThan(5);
    expect(world.stats.earned).toBeGreaterThan(0);
    // Earnings minus penalties and three days of wages and haulier fees.
    const daily = B.START_DOCKHANDS * B.WAGE_DOCKHAND + B.STARTER_HAULIER_FEE;
    expect(world.cash).toBeCloseTo(
      start + world.stats.earned - world.stats.penalties - 3 * daily,
      6,
    );
  });

  it.each([1, 2, 3, 99, 1234, 777777])('gets boats unloaded on any map (seed %i)', (seed) => {
    const world = World.create(seed, 96);
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) world.step();
    expect(world.stats.cratesHandled).toBeGreaterThan(0);
  });

  it('rejects saves from older versions or with missing fields', () => {
    const save = World.create(1, 96).toSave();
    expect(World.isValidSave(save)).toBe(true);
    expect(World.isValidSave({ ...save, version: 2 })).toBe(false);
    const broken = structuredClone(save);
    delete (broken.contracts[0] as { signingFee?: number }).signingFee;
    expect(World.isValidSave(broken)).toBe(false);
  });

  it.each([7, 99])(
    'keeps cash a finite number over a long, busy game (seed %i)',
    (seed) => {
      const world = World.create(seed, 96);
      for (const o of [...world.offers]) world.command({ type: 'signContract', id: o.id });
      for (let t = 0; t < TICKS_PER_DAY * 20; t++) world.step();
      expect(Number.isFinite(world.cash)).toBe(true);
    },
    20_000,
  );

  it('continues identically after a save round-trip', () => {
    const a = World.create(11, 96);
    for (let t = 0; t < 1500; t++) a.step();
    const b = World.fromSave(JSON.parse(JSON.stringify(a.toSave())));
    for (let t = 0; t < 1500; t++) {
      a.step();
      b.step();
    }
    expect(b.snapshot()).toEqual(a.snapshot());
  });

  it('has the advisor explain each thing once a game, even across a save', () => {
    const world = World.create(7, 96);
    const tips = (w: World) => w.drainEvents().flatMap((e) => (e.kind === 'tip' ? [e.id] : []));
    expect(tips(world)).toEqual(['welcome']);
    world.tier = 2;
    world.cash = 1_000_000;
    tip(world, 'cranes');
    tip(world, 'cranes');
    expect(tips(world)).toEqual(['cranes']);
    const loaded = World.fromSave(world.toSave());
    tip(loaded, 'cranes');
    tip(loaded, 'customs');
    expect(tips(loaded)).toEqual(['customs']);
  });

  it('builds, charges and refunds', () => {
    const world = World.create(5, 96);
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
    const world = World.create(5, 96);
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
    const world = World.create(7, 96);
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
    for (let d = 0; d < 10; d++) refreshOffers(world);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    const world = World.create(3, 96);
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
    const world = World.create(7, 96);
    const offer = world.offers[0];
    world.command({ type: 'signContract', id: offer.id });
    const c = world.contracts.find((x) => x.terms.name === offer.terms.name)!;
    const before = world.cash;
    world.command({ type: 'cancelContract', id: c.id });
    expect(world.cash).toBe(before - Math.round(offer.signingFee * B.CANCEL_FEE_SHARE));
    expect(world.contracts).not.toContain(c);
  });

  it('makes an overloaded fishery unhappy, charges demurrage and lets it walk out', () => {
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
    world.cash = -10_000;
    for (let t = 0; t < TICKS_PER_DAY * (B.BANKRUPT_DAYS + 1); t++) world.step();
    expect(world.bankrupt).toBe(true);
    const tick = world.tick;
    world.step();
    expect(world.tick).toBe(tick);
  });

  it('recovers from the red before the deadline', () => {
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
    expect(world.candidates).toHaveLength(B.CANDIDATES);
    const c = world.candidates[0];
    world.command({ type: 'hire', candidateId: c.id });
    expect(world.people.some((p) => p.name === c.name && p.wage === c.wage)).toBe(true);
    expect(world.candidates).not.toContainEqual(c);
    for (let t = 0; t < TICKS_PER_DAY; t++) world.step();
    expect(world.candidates).toHaveLength(B.CANDIDATES);
  });

  it('rests on the spot without a hut, losing morale', () => {
    const world = World.create(7, 96);
    const p = world.people[0];
    p.energy = B.TIRED_ENERGY - 1;
    const morale = p.morale;
    for (let t = 0; t < 5; t++) world.step();
    expect(p.state).toBe('resting');
    expect(p.hutIdx).toBe(-1);
    expect(p.morale).toBeLessThan(morale);
  });

  it('walks to a break hut when there is one, and enjoys it', () => {
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
    world.command({ type: 'loan', amount: B.LOAN_MAX * 2 });
    expect(world.loan).toBe(B.LOAN_MAX);
  });

  it('records every cash change in the ledger', () => {
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    const data = World.create(7, 96).map.toData();
    data.build[0] = Build.ForkliftLane;
    const m = GameMap.fromData(data);
    expect(m.build[0]).toBe(Build.PortRoad);
    expect(forkliftOnly(m, 0)).toBe(true);
  });

  it('locks quays, cranes and forklifts until the upgrade', () => {
    const world = World.create(7, 96);
    const { side } = besideTip(world);
    world.command({ type: 'build', kind: 'quay', tiles: [side] });
    expect(world.map.build[side]).toBe(Build.None);
    world.command({ type: 'buyMachine', kind: 'forklift' });
    expect(world.people.some((p) => p.kind === 'forklift')).toBe(false);
  });

  it('upgrades only once the town has grown enough, for the fee', () => {
    const world = World.create(7, 96);
    world.cash = TIERS[1].cost + 100;
    world.command({ type: 'upgrade' });
    expect(world.tier).toBe(0);
    // Big enough a town, but not the cash for the fee.
    let people = TIERS[1].town;
    world['townSize'] = () => people;
    world.cash = TIERS[1].cost - 1;
    world.command({ type: 'upgrade' });
    expect(world.tier).toBe(0);
    world.cash = TIERS[1].cost + 100;
    expect(world.snapshot().progress).toMatchObject({ town: people, canUpgrade: true });
    world.command({ type: 'upgrade' });
    expect(world.tier).toBe(1);
    expect(world.cash).toBe(100);
    // The next step needs a bigger town still.
    world.cash = TIERS[2].cost;
    world.command({ type: 'upgrade' });
    expect(world.tier).toBe(1);
    people = TIERS[2].town;
    world.command({ type: 'upgrade' });
    expect(world.tier).toBe(2);
  });

  function buildOffice(world: World): number {
    const m = world.map;
    // On open ground, not over the port's paths.
    const spot = m.build.findIndex((b, i) => b === Build.None && !placementError(m, 'office', i));
    world.command({ type: 'build', kind: 'office', tiles: [spot] });
    expect(m.build[spot]).toBe(Build.Office);
    return spot;
  }

  it('lets coasters moor only against a quay two tiles wide', () => {
    const world = World.create(7, 96);
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
    const wideBefore = capacity(world).deepBerths;
    // A second row behind it makes the quay two wide.
    const row2 = [0, 1, 2, 3].map((k) => m.idx(x - k, r - 2));
    world.command({ type: 'build', kind: 'quay', tiles: row2 });
    world.command({
      type: 'build',
      kind: 'quay',
      tiles: [m.idx(x + 1, r - 1), m.idx(x + 1, r - 2)],
    });
    expect(capacity(world).deepBerths).toBeGreaterThan(wideBefore);
  });

  it('sends big trucks only to large truck bays', () => {
    const world = World.create(7, 96);
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
    // Give the large bay something to collect: a big truck comes for it.
    world.bays.get(spot)!.crates.push(...Array(B.BIG_TRUCK_CAPACITY).fill(20));
    let came = false;
    for (let t = 0; t < TICKS_PER_DAY && !came; t++) {
      world.step();
      came = world.trucks.some((k) => k.bayIdx === spot && k.state === 'loading');
    }
    expect(came).toBe(true);
  });

  it('needs a harbour office before boats use a quay', () => {
    const world = World.create(7, 96);
    world.tier = 1;
    world.cash = 50_000;
    world.command({ type: 'build', kind: 'quay', tiles: [starterJetty(world)[0]] });
    expect(docks(world).every((d) => !d.coordinated)).toBe(true);
    buildOffice(world);
    expect(docks(world).every((d) => d.coordinated)).toBe(true);
  });

  /** Build a forklift depot beside the starting footpath. */
  function buildDepot(world: World): number {
    const m = world.map;
    // Its door onto a port road or quay.
    const spot = m.build.findIndex(
      (_, i) =>
        !placementError(m, 'depot', i) && [0, 1, 2, 3].some((f) => !depotDoorTrouble(m, i, f)),
    );
    world.command({ type: 'build', kind: 'depot', tiles: [spot] });
    expect(m.build[spot]).toBe(Build.Depot);
    return spot;
  }

  it('buys forklifts at a depot, three to a depot', () => {
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
    world.boats.length = 0; // the first boat moors at once; keep the jetty free
    world.tier = 1;
    world.cash = 50_000;
    const jetty = starterJetty(world);
    world.command({ type: 'build', kind: 'quay', tiles: jetty });
    const crane = jetty[jetty.length - 1];
    world.command({ type: 'build', kind: 'jibCrane', tiles: [crane] });
    // Pallets an older game left at the crane's feet, so the dockhands
    // leave them for the forklift.
    world.cranes.get(crane)!.stack.push(10, 10);
    world.cranes.get(crane)!.pallets = true;
    // The bay is only joined to the quay by port paths, which forklifts avoid.
    world.command({ type: 'buyMachine', kind: 'forklift', tile: buildDepot(world) });
    for (let t = 0; t < 400; t++) world.step();
    const f = world.people.find((p) => p.kind === 'forklift')!;
    expect(f.stuck).toMatch(/Can't reach/);
    expect(world.snapshot().entities.find((e) => e.id === f.id)!.alert).toBe(true);
  });

  it('leaves pallets an older game left at a jib crane for forklifts', () => {
    const world = World.create(7, 96);
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
    // From before jib cranes stopped setting crates down at their feet.
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

  it('never lets forklifts unload a boat: dockhands carry the crates off it themselves', () => {
    const world = World.create(7, 96);
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
    // A dockhand lifts them off and carries each straight to the truck bay,
    // setting none down on the quay for the forklift.
    world.command({ type: 'hire', candidateId: world.candidates[0].id });
    for (let t = 0; t < TICKS_PER_DAY && world.stats.cratesHandled < 4; t++) {
      world.step();
      expect(world.piles.size).toBe(0);
    }
    expect(world.stats.cratesHandled).toBeGreaterThanOrEqual(4);
  });

  it('swings crates straight into crate storage near a jib crane, and forklifts take them on', () => {
    const world = World.create(7, 96);
    const jetty = quayPort(world);
    const tip = jetty[jetty.length - 1];
    world.command({ type: 'build', kind: 'jibCrane', tiles: [tip] });
    // Two tiles, though it reaches only the one beside it.
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
    // At most the start of another load left, as boats keep landing more:
    // a day, and the trips the forklift may be part way through then.
    const left = () => world.bays.get(store)!.crates.length;
    for (
      let t = 0;
      t < TICKS_PER_DAY || (t < TICKS_PER_DAY * 1.5 && left() > B.FORKLIFT_CAPACITY);
      t++
    ) {
      world.step();
    }
    expect(left()).toBeLessThanOrEqual(B.FORKLIFT_CAPACITY);
    expect(world.stats.cratesHandled).toBeGreaterThan(handled);
    expect(world.stats.trucks).toBeGreaterThan(trucked);
  });

  it('has a forklift take full pallets off crate storage, leaving the one a jib crane is filling', () => {
    const world = World.create(7, 96);
    const jetty = quayPort(world);
    const tip = jetty[jetty.length - 1];
    world.command({ type: 'build', kind: 'jibCrane', tiles: [tip] });
    const store = jetty[jetty.length - 3];
    world.command({
      type: 'store',
      tiles: [store, jetty[jetty.length - 2]],
      kind: 'crates',
      on: true,
    });
    fireDockhands(world);
    for (let t = 0; t < TICKS_PER_DAY * 3; t++) world.step();
    world.command({ type: 'buyMachine', kind: 'forklift', tile: buildDepot(world) });
    const per = B.FORKLIFT_CAPACITY;
    const bay = () => world.bays.get(store)!;
    const held = () => bay().crates.length + (bay().exports?.length ?? 0);
    const forklifts = world.people.filter((p) => p.kind === 'forklift');
    let lifts = 0;
    let kept = 0;
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) {
      const before = held();
      // The slots of the crates on the pallet being filled, if one is.
      const slots = [...(bay().crateSlots ?? []), ...(bay().outSlots ?? [])];
      const on = (k: number) => slots.filter((s) => Math.floor(s / per) === k);
      const filling = [...new Set(slots.map((s) => Math.floor(s / per)))]
        .map(on)
        .find((c) => c.length < per);
      // A whole pallet with none on top of it, the lower of a row's two
      // pallets under the upper.
      const whole = [...new Set(slots.map((s) => Math.floor(s / per)))].some(
        (k) => on(k).length === per && (k % 2 === 1 || on(k + 1).length === 0),
      );
      const was = forklifts.map((p) => p.carrying);
      const from = forklifts.map((p) => p.state === 'picking' && p.stockIdx === store);
      const planned = forklifts.map((p) => p.planned);
      world.step();
      forklifts.forEach((p, k) => {
        if (!from[k] || p.carrying <= was[k]) return;
        lifts++;
        if (before < per || planned[k] < per || !whole) return;
        // A full pallet, not the few on the one being filled.
        expect(p.carrying).toBe(per);
        if (!filling) return;
        // Which stays where it is.
        const now = [...(bay().crateSlots ?? []), ...(bay().outSlots ?? [])];
        for (const s of filling) expect(now).toContain(s);
        kept++;
      });
    }
    expect(lifts).toBeGreaterThan(3);
    expect(kept).toBeGreaterThan(0);
  });

  it('has boats wait for a berth under a jib crane when nobody can unload them by hand', () => {
    const world = World.create(7, 96);
    const jetty = quayPort(world);
    const tip = jetty[jetty.length - 1];
    world.command({ type: 'build', kind: 'jibCrane', tiles: [tip] });
    // Storage beside it to swing the crates into, and a forklift to take
    // them on from there, as no truck gets beside a crane.
    world.command({ type: 'store', tiles: [jetty[jetty.length - 2]], kind: 'crates', on: true });
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
    const world = World.create(7, 96);
    const jetty = quayPort(world);
    const side = jetty[jetty.length - 1];
    expect(world.map.build[side]).toBe(Build.Quay);
    world.command({ type: 'build', kind: 'jibCrane', tiles: [side] });
    expect(world.map.build[side]).toBe(Build.JibCrane);
    expect(walkableAt(world.map, jetty[jetty.length - 2])).toBe(false);
    // Storage beside it to swing the crates into.
    world.command({ type: 'store', tiles: [jetty[jetty.length - 2]], kind: 'crates', on: true });
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

  it('has a jib crane with no crate storage beside it unload nothing, with a red mark saying why', () => {
    const world = World.create(7, 96);
    const jetty = quayPort(world);
    const tip = jetty[jetty.length - 1];
    const beside = jetty[jetty.length - 2];
    world.drainEvents();
    world.command({ type: 'build', kind: 'jibCrane', tiles: [tip] });
    // Said as it goes up.
    const said = world
      .drainEvents()
      .filter((e) => e.kind === 'message' && /jib crane unloads nothing/.test(e.text));
    expect(said).toHaveLength(1);
    const crane = world.cranes.get(tip)!;
    const mark = () => problems(world).find((p) => p.type === 'crane' && p.idx === tip);
    expect(mark()?.text).toMatch(/No crate storage in reach.*next to it/);
    expect(world.snapshot().cranes.find((c) => c.idx === tip)!.trouble).toMatch(/No crate storage/);
    expect(craneWhy(world, crane)).toMatch(/No crate storage in reach/);
    // The harbour master sends no boat to a berth under it, with others free.
    const m = world.map;
    const under = (b: { berth: number }) =>
      Math.max(Math.abs(m.xOf(b.berth) - m.xOf(tip)), Math.abs(m.yOf(b.berth) - m.yOf(tip))) <= 1;
    // The only other berth on this short quay is too near the shore: it
    // waits at anchor, saying why.
    let waited = 0;
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) {
      world.step();
      for (const b of world.boats) {
        if (b.state === 'moored' || b.state === 'arriving') expect(under(b)).toBe(false);
        if (b.state === 'anchored') {
          expect(boatWhy(world, b)).toMatch(/jib crane with no room in crate storage/);
          waited++;
        }
      }
      expect(crane.busy).toBe(false);
      expect(crane.stack).toHaveLength(0);
    }
    expect(waited).toBeGreaterThan(0);
    // Storage marked out beside it clears the mark, and it unloads into that.
    world.command({ type: 'store', tiles: [beside], kind: 'crates', on: true });
    expect(mark()).toBeUndefined();
    expect(world.snapshot().cranes.find((c) => c.idx === tip)!.trouble).toBeUndefined();
    fireDockhands(world);
    let stowed = 0;
    for (let t = 0; t < TICKS_PER_DAY * 3 && stowed === 0; t++) {
      world.step();
      expect(crane.stack).toHaveLength(0);
      stowed = world.bays.get(beside)?.crates.length ?? 0;
    }
    expect(stowed).toBeGreaterThan(0);
  });

  it('reaches storage only right beside a jib crane, in the ground kept for machines', () => {
    const world = World.create(7, 96);
    const jetty = quayPort(world);
    const tip = jetty[jetty.length - 1];
    world.command({ type: 'build', kind: 'jibCrane', tiles: [tip] });
    // Two tiles off: out of its reach.
    world.command({ type: 'store', tiles: [jetty[jetty.length - 3]], kind: 'crates', on: true });
    expect(world.bays.get(jetty[jetty.length - 3])).toBeDefined();
    expect(problems(world).some((p) => p.type === 'crane' && p.idx === tip)).toBe(true);
    world.command({ type: 'store', tiles: [jetty[jetty.length - 2]], kind: 'crates', on: true });
    expect(problems(world).some((p) => p.type === 'crane' && p.idx === tip)).toBe(false);
  });

  it('has a jib crane wait while the storage beside it is full, and the boat under it wait too', () => {
    const world = World.create(7, 96);
    const jetty = quayPort(world);
    const tip = jetty[jetty.length - 1];
    const beside = jetty[jetty.length - 2];
    world.command({ type: 'build', kind: 'jibCrane', tiles: [tip] });
    world.command({ type: 'store', tiles: [beside], kind: 'crates', on: true });
    fireDockhands(world);
    const crane = world.cranes.get(tip)!;
    const m = world.map;
    const under = () =>
      world.boats.find(
        (b) =>
          b.state === 'moored' &&
          Math.max(Math.abs(m.xOf(b.berth) - m.xOf(tip)), Math.abs(m.yOf(b.berth) - m.yOf(tip))) <=
            1,
      );
    for (let t = 0; t < TICKS_PER_DAY * 3 && !under(); t++) world.step();
    const boat = under()!;
    expect(boat).toBeDefined();
    // Filled to the top: no room for another crate.
    const store = world.bays.get(beside)!;
    while (bayRoom(store, false) > 0) store.crates.push(10);
    const load = boat.crates;
    for (let t = 0; t < 100; t++) {
      world.step();
      expect(crane.stack).toHaveLength(0);
    }
    expect(boat.crates).toBe(load);
    expect(craneWhy(world, crane)).toMatch(/Crate storage in reach is full/);
    // Not a red mark: it works once there is room.
    expect(problems(world).some((p) => p.type === 'crane' && p.idx === tip)).toBe(false);
    store.crates.length = 0;
    for (let t = 0; t < 100 && boat.crates === load; t++) world.step();
    expect(boat.crates).toBeLessThan(load);
  });

  it('still has forklifts take away the crates an older game left at a jib crane, landing no more there', () => {
    const world = World.create(7, 96);
    const jetty = quayPort(world);
    const tip = jetty[jetty.length - 1];
    world.command({ type: 'build', kind: 'jibCrane', tiles: [tip] });
    world.command({ type: 'store', tiles: [jetty[jetty.length - 2]], kind: 'crates', on: true });
    // A save from before jib cranes stopped setting crates down at their feet.
    world.cranes.get(tip)!.stack.push(10, 10, 10, 10);
    const loaded = World.fromSave(JSON.parse(JSON.stringify(world.toSave())));
    const crane = loaded.cranes.get(tip)!;
    expect(crane.stack).toHaveLength(4);
    expect(craneWhy(loaded, crane)).toMatch(/collect the crates at its feet/);
    loaded.command({ type: 'buyMachine', kind: 'forklift', tile: buildDepot(loaded) });
    let most = crane.stack.length;
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) {
      loaded.step();
      // It only ever goes down.
      expect(crane.stack.length).toBeLessThanOrEqual(most);
      most = crane.stack.length;
    }
    expect(crane.stack).toHaveLength(0);
  });
});

describe('Buildings', () => {
  it('face the way they are placed, entrance to the road', () => {
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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

  it('marks out crate storage on port roads, where a forklift loads trucks from inside the port', () => {
    const world = World.create(7, 96);
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
    // A forklift on the port road loads them: trucks have no crew of their own.
    world.cash = 100_000;
    const lift = spawnDockhand(world, inside[1], {
      id: 0,
      name: 'Forklift 1',
      skill: 3,
      trait: null,
      wage: 0,
    });
    lift.kind = 'forklift';
    lift.capacity = B.FORKLIFT_CAPACITY;
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
    // 24 crates, a pallet a trip.
    expect(loadTime).toBeLessThan(24 * B.BAY_LOAD_TICKS);
  });

  it('keeps what an area holds as it grows, joins up or shrinks', () => {
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    expect([takesImports(world, into), takesExports(world, into)]).toEqual([true, false]);
    expect([takesImports(world, out), takesExports(world, out)]).toEqual([false, true]);
  });

  it('clears storage and machines-only marks with Unmark, but not the ground round a crane', () => {
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    expect(byCrane(world, area)).toBe(true);
    // Marked for cargo coming in, it takes no exports even when empty.
    expect([takesImports(world, area), takesExports(world, area)]).toEqual([true, false]);
    // Marked for cargo going out, no imports.
    world.command({ type: 'store', tiles: [at], kind: 'crates', on: false });
    world.command({ type: 'store', tiles: [at], kind: 'cratesOut', on: true });
    const out = world.bays.get(at)!;
    expect([takesImports(world, out), takesExports(world, out)]).toEqual([false, true]);
  });

  it('warns, once a day, when shippers find no outgoing storage with room', () => {
    const world = World.create(7, 96);
    const said = () =>
      world.drainEvents().filter((e) => e.kind === 'message' && /going out/.test(e.text)).length;
    world.drainEvents();
    outgoingFull(world, true);
    outgoingFull(world, true);
    expect(said()).toBe(1);
    world.tick += TICKS_PER_DAY;
    outgoingFull(world, true);
    expect(said()).toBe(1);
  });

  it('turns warehouses and container yards from older saves into storage areas', () => {
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
    parkingLot(world);
    const [lot] = parkingLots(world.map);
    expect(lot.wide).toBe(false);
    expect(freeParking(world, null, true, true)).toBeNull();
    expect(freeParking(world, null, true, false)).not.toBeNull();
  });

  it('has trucks drive through angled parking one way, in off one road, out onto the other, never round a hairpin', () => {
    const world = World.create(7, 96);
    world.tier = 1;
    world.cash = 100_000;
    const m = world.map;
    const tiles = parkingLot(world);
    const [lot] = parkingLots(m);
    expect(lot.why).toBeNull();
    const flow = lot.flow!;
    const space = lot.spaces[0];
    const inEnd = space.ends[flow.in];
    const outEnd = space.ends[1 - flow.in];
    // Coming the way the lot runs, or the other way along the road: either
    // way in off the in side, never from beyond it round a hairpin.
    const row = m.yOf(inEnd);
    const x0 = m.xOf(inEnd);
    for (const dx of [-1, 6]) {
      const into = intoSpace(world, m.idx(x0 + dx, row), space, -1);
      expect(into).not.toBeNull();
      expect(into!.via).toBe(inEnd);
      const path: number[] = into!.path;
      const before = path[path.indexOf(inEnd) - 1] ?? m.idx(x0 + dx, row);
      expect(before).not.toBe(m.idx(x0 + flow.along[0], row + flow.along[1]));
    }
    // Parked, it leaves onto the road on the far side, going on the way it runs.
    const t = {
      id: world.nextId++,
      x: m.xOf(space.tiles[0]) + 0.5,
      y: m.yOf(space.tiles[0]) + 0.5,
      dir: 0,
      lot: space.tiles,
      parkFrom: inEnd,
      path: [],
    };
    const way: number[] = routeFrom(world, t as never, m.entry, truckCostFor(world, m.entry))!;
    expect(way).not.toBeNull();
    const k = way.indexOf(outEnd);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(way[k + 1]).not.toBe(
      m.idx(m.xOf(outEnd) - flow.along[0], m.yOf(outEnd) - flow.along[1]),
    );
    // However its way is found, as when held up on the way: into its space
    // only off the in side, out of it only onto the other.
    const going = { ...t, state: 'toPark', x: m.xOf(inEnd) + 0.5, y: m.yOf(inEnd) + 0.5 };
    const own = truckCostFor(world, -1, -1, going as never);
    expect(own(space.tiles[0], outEnd)).toBe(Infinity);
    expect(Number.isFinite(own(space.tiles[0], inEnd))).toBe(true);
    // Turned round with the one-way tool, in off the other side.
    world.command({ type: 'oneWay', tiles: [tiles[0]], on: true });
    const [again] = parkingLots(m);
    expect(again.flow!.in).toBe(1 - flow.in);
    expect(intoSpace(world, m.idx(x0 - 1, row), again.spaces[0], -1)?.via).toBe(outEnd);
    // Again, and its spaces lean the other way: in turning left, across the traffic.
    const lean = (f: typeof flow) => [f.along[0] + f.across[0], f.along[1] + f.across[1]];
    world.command({ type: 'oneWay', tiles: [tiles[0]], on: true });
    const [mirrored] = parkingLots(m);
    const [ax, ay] = lean(again.flow!);
    const [bx, by] = lean(mirrored.flow!);
    expect(ax * bx + ay * by).toBe(0);
    // Twice more, and it is back as it was.
    world.command({ type: 'oneWay', tiles: [tiles[0]], on: true });
    world.command({ type: 'oneWay', tiles: [tiles[0]], on: true });
    expect(parkingLots(m)[0].flow).toEqual(flow);
  });

  it('says why parking laid out wrong is no use', () => {
    const world = World.create(7, 96);
    world.tier = 1;
    world.cash = 100_000;
    const m = world.map;
    const why = () => world.snapshot().parking.map((l) => l.why);
    // Only on a road.
    const at = besideRoad(world);
    world.command({ type: 'build', kind: 'parking', tiles: [at] });
    expect(m.build[at]).toBe(Build.None);
    // A road along one side only.
    const mark = (tiles: number[]) => {
      world.command({ type: 'build', kind: 'road', tiles });
      world.command({ type: 'build', kind: 'parking', tiles });
    };
    mark([at, at + 1]);
    expect(why()[0]).toMatch(/both its long sides/);
    // Not a straight strip.
    mark([at + m.w]);
    expect(why()[0]).toMatch(/straight strip/);
    world.command({ type: 'bulldoze', tiles: [at, at + 1, at + m.w] });
    // A public road one side, a port road the other.
    mark([at]);
    world.command({ type: 'build', kind: 'portRoad', tiles: [at + m.w] });
    expect(why()[0]).toMatch(/without a gate/);
    // Unmarked, it is the road it was marked out on.
    world.command({ type: 'unmark', tiles: [at] });
    expect(m.build[at]).toBe(Build.Road);
  });

  it('lets trucks into the port only through a port gate', () => {
    const world = World.create(7, 96);
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
    // A truck comes in to be loaded.
    let came = false;
    for (let t = 0; t < TICKS_PER_DAY; t++) {
      world.step();
      came ||= world.trucks.some((k) => k.bayIdx === bay && k.state === 'loading');
    }
    expect(goods.noAccess).toBe(false);
    expect(came).toBe(true);
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
    const world = World.create(7, 96);
    world.trucks.length = 0;
    // On its way east, as it faces.
    const east = [world.map.idx(20, 20)];
    const a = truck(world, 10.5, 20.5, 0, east);
    // Up to speed, gathering it as it goes.
    const pace = () => {
      for (let k = 0; k < B.VEHICLE_ACCEL_TICKS; k++) paceOf(world, a)();
      return paceOf(world, a)();
    };
    expect(pace()).toBeCloseTo(B.TRUCK_SPEED, 6);
    // Close ahead, going the same way: it holds back.
    const b = truck(world, 11, 20.5, 0, east);
    expect(pace()).toBe(0);
    // Coming the other way it is in the other lane.
    b.dir = Math.PI;
    b.path = [world.map.idx(1, 20)];
    expect(pace()).toBeCloseTo(B.TRUCK_SPEED, 6);
    // Further ahead, it closes up to the gap and no closer, braking as it does.
    b.dir = 0;
    b.path = east;
    b.x = 10.5 + B.truckLength(6, false) + B.TRUCK_GAP + 0.3;
    const closing = pace();
    expect(closing).toBeGreaterThan(0);
    expect(closing).toBeLessThan(0.3);
  });

  it('gives way at a junction to a truck coming in from its right', () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    const m = world.map;
    // A crossroads of public roads.
    const j = m.idx(10, 10);
    for (const d of [-2, -1, 0, 1, 2]) {
      m.build[m.idx(10 + d, 10)] = Build.Road;
      m.build[m.idx(10, 10 + d)] = Build.Road;
    }
    world['junctionCache'] = null;
    expect(junctions(world)[j]).toBe(1);
    const cx = m.xOf(j) + 0.5;
    const cy = m.yOf(j) + 0.5;
    // One coming up from the south heading north, one from the east heading west.
    const north = truck(world, cx, cy + 1, -Math.PI / 2, [j]);
    const west = truck(world, cx + 1, cy, Math.PI, [j]);
    expect(mayEnter(world, north)(j)).toBe(false);
    expect(mayEnter(world, west)(j)).toBe(true);
    // Both standing at the line, they take turns rather than wait for each other.
    north.held = west.held = 5;
    const turns = new Set<boolean>();
    for (let k = 0; k < 2; k++) {
      world.tick = k * B.TRUCK_TAKE_TURNS;
      turns.add(mayEnter(world, north)(j));
      expect(mayEnter(world, west)(j)).toBe(true);
    }
    expect([...turns].sort()).toEqual([false, true]);
    // While one is driving across, the other waits for it.
    west.held = 0;
    west.x = cx;
    west.y = cy;
    north.held = 0;
    expect(mayEnter(world, north)(j)).toBe(false);
    // One coming through the other way passes it.
    west.dir = Math.PI / 2;
    expect(mayEnter(world, north)(j)).toBe(true);
    // Wedged for good, it goes anyway.
    west.dir = Math.PI;
    north.held = B.TRUCK_SQUEEZE_AFTER + 1;
    expect(mayEnter(world, north)(j)).toBe(true);
  });

  it('has one of two trucks caught across each other wait for the other', () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    // One turning north out of the eastbound lane, across one going west.
    const a = truck(world, 10.5, 20.4, -Math.PI / 2, [1]);
    const b = truck(world, 10.8, 20.5, Math.PI, [1]);
    const moves = [paceOf(world, a)(), paceOf(world, b)()].filter((v) => v > 0);
    expect(moves).toHaveLength(1);
  });

  it('has a ring of trucks each waiting on the next let one drive on through until it is clear', () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    const m = world.map;
    // Round a block, each nose up against the side of the next: east,
    // north, west, south and back to the first.
    const ring = [
      truck(world, 10.5, 20.5, 0, [m.idx(30, 20)]),
      truck(world, 11.5, 20.5, -Math.PI / 2, [m.idx(11, 1)]),
      truck(world, 11.5, 19.5, Math.PI, [m.idx(1, 19)]),
      truck(world, 10.5, 19.5, Math.PI / 2, [m.idx(10, 40)]),
    ];
    const start = ring.map((t) => [t.x, t.y]);
    for (let k = 0; k < B.TRUCK_RING_AFTER + 60; k++) {
      for (const t of ring) {
        const v = paceOf(world, t)();
        t.x += Math.cos(t.dir) * v;
        t.y += Math.sin(t.dir) * v;
      }
    }
    const gone = ring.map((t, k) => Math.hypot(t.x - start[k][0], t.y - start[k][1]));
    // The lowest numbered goes, all the way past the one it was waiting on,
    // well before any of them would squeeze on regardless.
    expect(gone[0]).toBeGreaterThan(B.truckLength(6, false) + 1);
  });

  it('lets the one to go in a ring go once any of them has waited long, not only itself', () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    const m = world.map;
    const ring = [
      truck(world, 10.5, 20.5, 0, [m.idx(30, 20)]),
      truck(world, 11.5, 20.5, -Math.PI / 2, [m.idx(11, 1)]),
      truck(world, 11.5, 19.5, Math.PI, [m.idx(1, 19)]),
      truck(world, 10.5, 19.5, Math.PI / 2, [m.idx(10, 40)]),
    ] as (ReturnType<typeof truck> & { passing?: { ids: number[]; x: number; y: number } })[];
    for (let k = 0; k < B.TRUCK_RING_AFTER; k++) ring.forEach((t) => paceOf(world, t)());
    for (let k = 0; k < 5; k++) ring.slice(1).forEach((t) => paceOf(world, t)());
    // The lowest numbered, the one to go, has only just stopped again.
    ring[0].held = 1;
    paceOf(world, ring[0])();
    expect(ring[0].passing).toBeDefined();
  });

  it('does not wait for a truck straight on past where it turns off', () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    const m = world.map;
    // Heading west, to turn north at (19, 20).
    const t = truck(world, 20.5, 20.5, Math.PI, [m.idx(19, 20), m.idx(19, 19), m.idx(19, 18)]);
    // One coming down the road beside, a tile further on west.
    const o = truck(world, 18.5, 20.2, Math.PI / 2, [m.idx(18, 30)]);
    expect(ahead(world, t, o)).toBe(-1);
    // But one standing where it turns is in its way.
    o.x = 19.5;
    expect(ahead(world, t, o)).toBeGreaterThan(0);
  });

  it('undoes a ring of trucks however many there are in it, as round a loop of roads', () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    const m = world.map;
    // Sixteen nose to tail round a block four on a side, clockwise.
    const ring: (ReturnType<typeof truck> & {
      blocker?: number;
      passing?: { ids: number[]; x: number; y: number };
    })[] = [];
    for (let k = 0; k < 16; k++) {
      const side = Math.floor(k / 4);
      const s = k % 4;
      const [x, y] = [
        [30 + s, 30],
        [34, 30 + s],
        [34 - s, 34],
        [30, 34 - s],
      ][side];
      const dir = [0, Math.PI / 2, Math.PI, -Math.PI / 2][side];
      const far = m.idx(x + Math.round(Math.cos(dir)) * 20, y + Math.round(Math.sin(dir)) * 20);
      ring.push(truck(world, x + 0.5, y + 0.5, dir, [far]));
    }
    const pace = () => ring.forEach((t) => paceOf(world, t)());
    for (let k = 0; k <= B.TRUCK_RING_AFTER; k++) pace();
    // Each held up by the next, all the way round; one of them goes on
    // through all the rest.
    expect(ring.map((t) => t.blocker)).toEqual(ring.map((_, k) => ring[(k + 1) % 16].id));
    pace();
    const going = ring.filter((t) => t.passing);
    expect(going).toHaveLength(1);
    expect(going[0].passing!.ids).toHaveLength(15);
  });

  it('stops short of a crossing it could not get all the way over, rather than in it', () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    const m = world.map;
    const east = [9, 10, 11, 12, 13].map((x) => m.idx(x, 20));
    const t = truck(world, 8.6, 20.5, 0, east);
    // A queue ahead, just past where another's way crosses at (10, 20).
    truck(world, 11.6, 20.5, 0, [m.idx(20, 20)]).held = 50;
    const room = gapAhead(world, t) - B.TRUCK_GAP;
    expect(toCrossing(world, t, room)).toBe(Infinity);
    truck(
      world,
      10.5,
      22.5,
      -Math.PI / 2,
      [21, 20, 19].map((y) => m.idx(10, y)),
    );
    world.tick++;
    // Its front at the near edge of the crossing, not across it.
    const half = B.truckLength(6, false) / 2;
    expect(toCrossing(world, t, room)).toBeCloseTo(10 - half - 8.6, 6);
    // With room to get all the way over, it goes on.
    expect(toCrossing(world, t, 4)).toBe(Infinity);
  });

  it('sends a truck to a loading spot one already on its way in drives past first', () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    const m = world.map;
    // Four spots down a lane, the deepest taken by a truck on its way in.
    const docks = [10, 11, 12, 13].map((y) => m.idx(20, y));
    const lane = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, k) => m.idx(20, from + k));
    const coming = truck(world, 20.5, 4.5, Math.PI / 2, lane(5, 13));
    coming.state = 'toBay' as never;
    coming.bayIdx = 0;
    world['loadingDocks'] = () => docks;
    world['freeDockSet'] = () => new Set(docks.slice(0, 3));
    world['drivePath'] = () => [m.entry];
    const bay = { idx: 0 } as never;
    // From well behind it: the deepest still free.
    const behind = dockFor(world, bay, (d: number) => lane(0, m.yOf(d)));
    expect(behind?.dock).toBe(docks[2]);
    // From ahead of it, it would stop where that one has yet to get past.
    const ahead = dockFor(world, bay, (d: number) => lane(8, m.yOf(d)));
    expect(ahead).toBeNull();
  });

  it('routes a truck to its spot round the spots others are going to, and moves one on deeper as one frees', () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    const m = world.map;
    const docks = [10, 11, 12, 13].map((y) => m.idx(20, y));
    const lane = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, k) => m.idx(20, from + k));
    const coming = truck(world, 20.5, 4.5, Math.PI / 2, lane(5, 11));
    coming.state = 'toBay' as never;
    coming.bayIdx = 0;
    world['loadingDocks'] = () => docks;
    world['freeDockSet'] = () => new Set([docks[3]]);
    world['drivePath'] = () => [m.entry];
    const bay = { idx: 0, tiles: [] } as never;
    // Asked for a way that keeps off where that one will stand.
    let kept: ReadonlySet<number> = new Set();
    dockFor(world, bay, (d: number, avoid: ReadonlySet<number>) => {
      kept = avoid;
      return lane(0, m.yOf(d));
    });
    expect([...kept]).toEqual([docks[1]]);
    // The spot past it free, the one coming in goes on to it.
    world['routeFrom'] = (_t: never, d: number) => lane(5, m.yOf(d));
    goDeeper(world, coming, bay);
    expect(coming.goal).toBe(docks[3]);
    expect(coming.state).toBe('toBay');
  });

  it('sends a truck waiting to load at a bay none can use away, saying why', () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    const m = world.map;
    const bay = [...world.bays.values()][0];
    bay.crates.push(10, 10, 10);
    const park = m.idx(30, 30);
    m.build[park] = Build.Parking;
    const t = truck(world, 30.5, 30.5, 0);
    Object.assign(t, { state: 'parked', bayIdx: bay.idx, park });
    world.tick = 10 - (t.id % 10);
    updateTruck(world, t);
    expect(t.state).toBe('parked');
    expect(parkedWords(world, t)).toBe('Parked, waiting for a loading spot');
    // Cut off from it, as by a dead end trucks cannot turn round in.
    cutOff(world, bay, true);
    expect(truckWhy(world, t)).toMatch(/not drive away again/);
    world.tick += 10;
    updateTruck(world, t);
    // Off out of the port, or gone already where it cannot drive.
    expect(world.trucks.includes(t) && (t.state as string) === 'parked').toBe(false);
  });

  it("drives on past where a truck bound for another bay's spot will stand", () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    const m = world.map;
    // The way to a spot further on runs along another yard's loading lane,
    // where a truck is on its way in to (20, 12).
    const lane = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, k) => m.idx(20, from + k));
    const coming = truck(world, 20.5, 4.5, Math.PI / 2, lane(5, 12));
    coming.state = 'toBay' as never;
    coming.bayIdx = 1;
    const dock = m.idx(20, 16);
    world['loadingDocks'] = () => [dock];
    world['freeDockSet'] = () => new Set([dock]);
    world['drivePath'] = () => [m.entry];
    const to = dockFor(world, { idx: 0 } as never, () => lane(0, 16));
    expect(to?.dock).toBe(dock);
  });

  it('gets past a truck loading in its lane on a wide road, by the other lane', () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    const m = world.map;
    // A road two wide running south, a truck loading at the kerb in its
    // right-hand lane, and one coming down it behind.
    for (let y = 8; y < 24; y++) for (const x of [10, 11]) m.build[m.idx(x, y)] = Build.Road;
    world['junctionCache'] = null;
    world['turnCache'] = null;
    const loader = truck(world, 10.5, 15.5, Math.PI);
    loader.state = 'loading' as never;
    const goal = m.idx(10, 22);
    const way = [15, 16, 17, 18, 19, 20, 21, 22].map((y) => m.idx(10, y));
    const t = truck(world, 10.5, 14.1, Math.PI / 2, way);
    t.goal = goal;
    t.state = 'toPark' as never;
    const cost = truckCostFor(world, goal);
    let v = 0;
    for (let k = 0; k <= B.REROUTE_AFTER; k++) v = paceOf(world, t, cost)();
    // It pulls up behind it, then finds a way round it.
    expect(v).toBeLessThan(0.05);
    expect(t.path).not.toContain(m.idx(10, 15));
    expect(t.path.at(-1)).toBe(goal);
    // And sets off, the loading truck no longer on its way.
    t.held = 0;
    for (let k = 0; k < B.VEHICLE_ACCEL_TICKS; k++) v = paceOf(world, t, cost)();
    expect(v).toBeGreaterThan(0.1);
  });

  it('never waits for a vehicle going the other way, even one facing round from where it stood', () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    const m = world.map;
    const t = truck(world, 10.5, 20.5, 0, [m.idx(20, 20)]);
    // Close ahead, facing our way but setting off back towards us.
    const o = truck(world, 11.6, 20.5, 0, [m.idx(1, 20)]);
    expect(ahead(world, t, o)).toBe(-1);
    // At a junction, turning left across one coming the other way, it goes.
    for (const d of [-2, -1, 0, 1, 2]) {
      m.build[m.idx(30 + d, 30)] = Build.Road;
      m.build[m.idx(30, 30 + d)] = Build.Road;
    }
    world['junctionCache'] = null;
    const j = m.idx(30, 30);
    const left = truck(world, 29.5, 30.5, 0, [j, m.idx(30, 29)]);
    truck(world, 31.5, 30.5, Math.PI, [j, m.idx(29, 30)]);
    expect(mayEnter(world, left)(j)).toBe(true);
  });

  it('drives on the right-hand side of the road', () => {
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
    const m = world.map;
    for (let t = 0; t < TICKS_PER_DAY * 2; t++) {
      world.step();
      for (const p of world.people) {
        expect(walkable(m.build[m.idx(Math.floor(p.x), Math.floor(p.y))])).toBe(true);
      }
    }
  });

  it('runs only two jetties without a harbour office', () => {
    const world = World.create(7, 96);
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
    expect(docks(world)).toHaveLength(3);
    expect(docks(world).filter((d) => d.coordinated)).toHaveLength(B.FREE_DOCKS);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    addContract(
      world,
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
    const side = gateSide.bind(null, world);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    // The machines drive out of the depot's door onto the pier, and on from
    // there round the far side of the yard.
    const link = m.idx(start, r - 3);
    const depot = link + 1;
    world.command({ type: 'bulldoze', tiles: [link, depot] });
    world.command({ type: 'build', kind: 'portRoad', tiles: [link] });
    world.command({ type: 'forkliftOnly', tiles: [link], on: true });
    world.command({ type: 'build', kind: 'depot', tiles: [depot], facing: 1 });
    const office = m.build.findIndex((_, i) => !placementError(m, 'office', i));
    world.command({ type: 'build', kind: 'office', tiles: [office] });
    world.command({ type: 'buyMachine', kind: 'stacker', tile: depot });
    if (m.build[crane] !== Build.HarbourCrane || !world.yards.has(yard)) return null;
    if (!world.people.some((p) => p.kind === 'stacker')) return null;
    return { crane, yard };
  }

  /**
   * Another depot beside the terminal's, `k` along, for another reach
   * stacker: each takes two of a depot's three places.
   */
  function besideDepot(world: World, k = 1): number {
    const at = world.map.build.findIndex((b) => b === Build.Depot) + k;
    world.command({ type: 'bulldoze', tiles: [at] });
    world.command({ type: 'build', kind: 'depot', tiles: [at], facing: 1 });
    expect(world.map.build[at]).toBe(Build.Depot);
    return at;
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
      if (crane && berthTrouble(world, crane) === null) return s;
      world.command({ type: 'bulldoze', tiles: [s.at] });
    }
    throw new Error('No spot on the pier where a feeder lies centred on a gantry crane');
  }

  /**
   * A tug berth beside the docks, as far from the feeder berth at the crane
   * as there is room for, and a tug lying in it.
   */
  /**
   * A yard gantry for terminal tractors on the terminal's yard: along its
   * far side from the gate, where its lane runs from the port road to the
   * depot, open at both ends. Tractors never turn about in a gantry's lane,
   * so they drive in at one end and out at the other.
   */
  function tractorGantry(world: World, yard: { tiles?: number[] }): number {
    const m = world.map;
    const top = yard.tiles!.filter((t) => !yard.tiles!.includes(t - m.w)).map((t) => t - m.w);
    world.command({ type: 'build', kind: 'yardGantry', tiles: [top[0]] });
    expect(m.build[top[0]]).toBe(Build.YardGantry);
    return top[0];
  }

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
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    if (tug) withTug(world, t.crane);
    addContract(
      world,
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
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world);
    expect(t).not.toBeNull();
    withTug(world, t!.crane);
    expect(capacity(world).boxes.berths).toBeGreaterThan(0);
    const add = addContract.bind(null, world);
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
    world.command({ type: 'buyMachine', kind: 'stacker', tile: besideDepot(world) });
    // A feeder takes a while to come alongside.
    for (let k = 0; k < TICKS_PER_DAY * 4; k++) world.step();
    expect(world.stats.containers).toBeGreaterThan(0);
    // Dockhands never touch containers.
    expect(world.people.filter((p) => p.kind === 'dockhand').every((p) => p.carrying <= 1)).toBe(
      true,
    );
    // Less from the crates meanwhile, which go on their trucks by hand.
    expect(world.stats.earned - earned).toBeGreaterThan(150 * 2);
  });

  it('lets a yard stop taking containers, so the trucks empty it, and take them again', () => {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    withTug(world, t.crane);
    const add = addContract.bind(null, world);
    add(
      {
        kind: 'fishery',
        vessel: 'feeder',
        name: 'Test Feeders',
        color: 0,
        boatEvery: 1,
        cratesMin: 12,
        cratesMax: 12,
        fee: 150,
      },
      world.tick + 10,
      0,
    );
    const yard = world.yards.get(t.yard)!;
    // Some in it, then shut it.
    for (let k = 0; k < TICKS_PER_DAY * 4 && yard.boxes.length < 4; k++) world.step();
    expect(yard.boxes.length).toBeGreaterThan(0);
    world.command({ type: 'shutStore', idx: yard.idx, shut: true });
    expect(world.snapshot().yards.find((y) => y.idx === yard.idx)!.shut).toBe(true);
    // Those already on their way still come; nothing more is sent.
    const most = yard.boxes.length + yard.boxIncoming;
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
    let waiting = false;
    for (let k = 0; k < TICKS_PER_DAY * 6; k++) {
      world.step();
      expect(yard.boxes.length).toBeLessThanOrEqual(most);
      if (
        k % 20 === 0 &&
        craneWhy(world, world.cranes.get(t.crane)!).startsWith(
          'Every container yard with room has stopped',
        )
      ) {
        waiting = true;
      }
    }
    // The trucks take what is in it; the crane says why it stacks them up.
    expect(yard.boxes.length).toBeLessThan(most);
    expect(waiting).toBe(true);
    // It stays shut through a save, and when the area is made bigger.
    const again = World.fromSave(world.toSave());
    expect(again.yards.get(yard.idx)!.shut).toBe(true);
    const m = world.map;
    world.command({ type: 'store', tiles: [yard.idx - m.w], kind: 'boxes', on: true });
    expect(m.store[yard.idx - m.w]).toBe(m.store[yard.idx]);
    const grown = world.yards.get(world['storeOf'][yard.idx])!;
    expect(grown.shut).toBe(true);
    // Open again, it takes them in once more.
    world.command({ type: 'shutStore', idx: grown.idx, shut: false });
    const before = world.stats.containers;
    for (let k = 0; k < TICKS_PER_DAY * 2; k++) world.step();
    expect(world.stats.containers).toBeGreaterThan(before);
  }, 60_000);

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
      const loading: number[] = storeSpots(world, yard);
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
    addContract(
      world,
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
        world.people
          .filter((p) => p.kind === 'stacker' && p.truckId !== undefined)
          .map((p) => p.truckId!),
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

  it('keeps reach stackers and trucks from driving through each other', () => {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world);
    expect(t).not.toBeNull();
    withTug(world, t!.crane);
    const add = addContract.bind(null, world);
    add(
      {
        kind: 'fishery',
        vessel: 'feeder',
        name: 'Test Feeders',
        color: 0,
        boatEvery: 1,
        cratesMin: 12,
        cratesMax: 12,
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
        fleet: 3,
        capacity: B.CONTAINER_TRUCK_CAPACITY,
        dailyFee: 0,
        cargo: 'container',
      },
      0,
      0,
    );
    for (let k = 1; k <= 2; k++) {
      world.command({ type: 'buyMachine', kind: 'stacker', tile: besideDepot(world, k) });
    }
    // Each on the right-hand side of the road, as it is shown.
    const lane = (o: { x: number; y: number; dir: number }, d: number) => [
      o.x - Math.sin(o.dir) * d,
      o.y + Math.cos(o.dir) * d,
    ];
    let through = 0;
    for (let k = 0; k < TICKS_PER_DAY * 5; k++) {
      world.step();
      const vs = [
        // Not those still inside a depot, where its machines park on top of each other.
        ...world.people
          .filter(
            (p) =>
              p.kind === 'stacker' &&
              p.path.length > 0 &&
              !p.squeeze &&
              world.map.build[world.map.idx(Math.floor(p.x), Math.floor(p.y))] !== Build.Depot,
          )
          .map((p) => ({ o: p, at: lane(p, B.MACHINE_LANE), len: B.MACHINE_LENGTH.stacker })),
        ...world.trucks
          // Not out on the highway, where trucks pass through each other.
          .filter(
            (q) =>
              q.path.length > 0 &&
              q.state !== 'parked' &&
              !q.round &&
              world.map.build[world.map.idx(Math.floor(q.x), Math.floor(q.y))] !== Build.Highway,
          )
          .map((q) => ({ o: q, at: lane(q, B.TRUCK_LANE), len: lengthOf(world, q) })),
      ];
      for (const a of vs) {
        for (const b of vs) {
          if (a === b || Math.cos(a.o.dir - b.o.dir) < 0.7) continue;
          const [dx, dy] = [b.at[0] - a.at[0], b.at[1] - a.at[1]];
          const along = Math.abs(dx * Math.cos(a.o.dir) + dy * Math.sin(a.o.dir));
          const across = Math.abs(dy * Math.cos(a.o.dir) - dx * Math.sin(a.o.dir));
          if (across < 0.25 && along < (a.len + b.len) / 2 - 0.3) through++;
        }
      }
    }
    expect(world.stats.containers).toBeGreaterThan(0);
    expect(through).toBe(0);
  });

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
    addContract(
      world,
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

  it('never has a truck or port machine drive across a yard gantry’s rails, only along its lane', () => {
    const world = feederPort(true);
    const m = world.map;
    const yard = [...world.yards.values()][0];
    const spot: number = storeSpots(world, yard)[0];
    world.command({ type: 'build', kind: 'yardGantry', tiles: [spot] });
    const rails: Map<number, [number, number]> = gantryRailWays(world);
    expect(rails.get(spot)).toBeDefined();
    const [ax, ay] = rails.get(spot)!;
    const at = (dx: number, dy: number) => m.idx(m.xOf(spot) + dx, m.yOf(spot) + dy);
    // A port road off the side of the lane, away from the yard, to drive across from.
    const side = [at(-ay, ax), at(ay, -ax)].find((t) => !world.yards.has(t) && !m.store[t])!;
    m.build[side] = Build.PortRoad;
    world['railCache'] = null;
    world['laneCache'] = null;
    const truck = truckCostFor(world, -1);
    const drive = world['driveCost'];
    // Onto the lane from the side, or off it that way: no; along it: yes.
    for (const cost of [truck, drive]) {
      expect(cost(spot, side)).toBe(Infinity);
      expect(cost(side, spot)).toBe(Infinity);
    }
    // Along it, from the lane tile either end, the way the rails run.
    const ends = [at(ax, ay), at(-ax, -ay)].filter((t) => rails.has(t));
    expect(ends.length).toBeGreaterThan(0);
    for (const end of ends) {
      expect(crossesRails(world, end, spot)).toBe(false);
      expect(crossesRails(world, spot, end)).toBe(false);
    }
    expect(crossesRails(world, side, spot)).toBe(true);
    // A stacker cutting a corner onto it is across them too.
    const corner = at(ax - ay, ay + ax);
    if (m.inBounds(m.xOf(corner), m.yOf(corner))) expect(drive(spot, corner)).toBe(Infinity);
  });

  it('has a yard gantry work one yard, say when it works none, and keep other trucks out from under it', () => {
    const world = feederPort(true);
    const yard = [...world.yards.values()][0];
    const spot: number = storeSpots(world, yard)[0];
    world.command({ type: 'build', kind: 'yardGantry', tiles: [spot] });
    const byYard = (): Map<number, number> => gantries(world).byYard;
    expect(byYard().get(yard.idx)).toBe(spot);
    // Trucks bound for the yard, or leaving it, drive under it as they
    // always did; others pay to, and go round where they can.
    const flat = () => 1;
    expect(throughCost(world, flat, yard.idx, -1)(spot)).toBe(1);
    expect(throughCost(world, flat, -1, yard.idx)(spot)).toBe(1);
    expect(throughCost(world, flat, -1, -1)(spot)).toBe(1 + B.GANTRY_LANE_DETOUR);
    // The yard beside it unmarked: it works none, and its red mark says so.
    world.command({ type: 'unmark', tiles: [...yard.tiles!] });
    expect([...byYard().values()]).not.toContain(spot);
    const mark = world.snapshot().problems.find((p) => p.type === 'yardGantry' && p.idx === spot);
    expect(mark?.text).toMatch(/none beside this one/);
  });

  it('lets trucks drive in under a yard gantry to load', () => {
    const world = feederPort(true);
    const m = world.map;
    const yard = [...world.yards.values()][0];
    const spot: number = storeSpots(world, yard)[0];
    expect(placementError(m, 'yardGantry', spot)).toBeNull();
    world.command({ type: 'build', kind: 'yardGantry', tiles: [spot] });
    expect(m.build[spot]).toBe(Build.YardGantry);
    // The trucks load under the gantry, where it reaches out of the yard.
    expect(storeSpots(world, yard)).toEqual([spot]);
    addContract(
      world,
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
      expect(world.people.some((p) => p.kind === 'stacker' && p.truckId !== undefined)).toBe(false);
      if (k % 10 === 0 && world.snapshot().yards.some((y) => y.working)) working++;
    }
    expect(loaded).toBeGreaterThan(0);
    // And shows it at work, for its trolley to run.
    expect(working).toBeGreaterThan(0);
  });

  it('has a yard gantry see one lift through before it starts on the next', () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    const yard = { idx: 5, yard: true, boxes: [], crates: [] } as never;
    world.yards.set(5, yard);
    world['yardGantry'] = () => true;
    const truckId = world.nextId++;
    const t = { id: truckId, boxes: true, bayIdx: 5, state: 'delivering', cargo: 1, timer: 0 };
    world.trucks.push(t as never);
    world['gantryTruck'] = () => t as never;
    // A truck it has started lifting an export off.
    expect(gantryElsewhere(world, t as never, yard)).toBe(false);
    // A tractor pulls up to set a container down: it waits for that lift.
    const tractorId = world.nextId++;
    const tractor = {
      id: tractorId,
      kind: 'tractor',
      state: 'dropping',
      bayIdx: 5,
      cargoFees: [100],
      planned: 1,
      timer: B.YARD_GANTRY_TICKS,
    } as never;
    world.people.push(tractor);
    expect(gantryFor(world, tractor)).toBe(false);
    expect(gantryWork(world, yard).workTruck).toBe(truckId);
    const first = gantryWork(world, yard).workStart;
    expect(first).toBe(world.tick);
    // Done, and with the next not yet begun, it is at no lift: the view
    // shows it standing where it set the last one down, not starting one.
    gantryDone(world, yard, truckId);
    expect(gantryWork(world, yard)).toEqual({});
    // Then it is the tractor's turn, and the truck waits for that.
    world.tick += 3;
    expect(gantryFor(world, tractor)).toBe(true);
    expect(gantryElsewhere(world, t as never, yard)).toBe(true);
    expect(gantryWork(world, yard).workTruck).toBe(tractorId);
    // A lift of its own, begun when it was, and the view is told so.
    expect(gantryWork(world, yard).workStart).toBe(first! + 3);
    const view = yardLooks(world, yard, new Map());
    expect(view.workStart).toBe(first! + 3);
  });

  it('lets a truck go as soon as a yard gantry has its container up, and sets it down after', () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    const yard = { idx: 5, tiles: [5], yard: true, outgoing: true, boxes: [], crates: [] } as never;
    world.yards.set(5, yard);
    world['yardGantry'] = () => true;
    const t = {
      id: world.nextId++,
      boxes: true,
      exports: true,
      bayIdx: 5,
      state: 'delivering',
      cargo: 1,
      value: 210,
      timer: 0,
      path: [],
      x: 0.5,
      y: 0.5,
      dir: 0,
    };
    world.trucks.push(t as never);
    world['gantryTruck'] = () => t as never;
    world['headOut'] = (() => {
      t.state = 'leaving';
    }) as never;
    const y = yard as { gantryLift?: { start: number }; gantryHeld?: unknown; exports?: number[] };
    updateTruck(world, t as never);
    const taken: number = takenIn(world, yard);
    const start = y.gantryLift!.start;
    let left = -1;
    let set = -1;
    for (let k = 0; k < 200 && set < 0; k++) {
      world.tick++;
      if (t.state === 'delivering') updateTruck(world, t as never);
      if (t.state === 'leaving' && left < 0) left = world.tick - start;
      // Meanwhile it takes on no other.
      if (y.gantryHeld) expect(gantryElsewhere(world, { ...t, id: 999 } as never, yard)).toBe(true);
      if (y.gantryHeld && liftDone(world, yard)) settleGantry(world, yard);
      if (left >= 0 && !y.gantryHeld && set < 0) set = world.tick - start;
    }
    // Off as soon as the spreader had it, well before it was set down.
    expect(left).toBe(taken);
    expect(set).toBeGreaterThan(left);
    expect(y.exports).toEqual([210]);
  });

  it('lets a tractor go as soon as a gantry crane has its export up', () => {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    const { at } = placeGantry(world, gantryPier(world, t.crane));
    const crane = world.cranes.get(at)!;
    const depot = world.map.build.findIndex((b) => b === Build.Depot);
    world.command({ type: 'buyMachine', kind: 'tractor', tile: depot });
    const p = world.people.find((q) => q.kind === 'tractor')!;
    // Waiting under it with an export to set down on its stack.
    Object.assign(p, {
      state: 'dropping',
      toCrane: at,
      craneIdx: -1,
      carrying: 1,
      cargoFees: [210],
      cargoLooks: [9],
      planned: 1,
      outbound: true,
      timer: 1000,
    });
    crane.outReserved = 1;
    let free = -1;
    for (let k = 1; k <= 40; k++) {
      serveTractor(world, crane);
      if (p.state === 'idle' && free < 0) free = k;
      if (free > 0 && !crane.serving) break;
    }
    expect(free).toBe(craneTakenIn(world, crane));
    expect(p.carrying).toBe(0);
    expect(crane.outStack).toEqual([210]);
    expect(crane.outReserved).toBe(0);
  });

  it("has a yard gantry stack a ship's containers up first, and the next ship's beside them", () => {
    const world = feederPort(true);
    const yard = [...world.yards.values()][0];
    const spot: number = storeSpots(world, yard)[0];
    world.command({ type: 'build', kind: 'yardGantry', tiles: [spot] });
    yard.boxes = [];
    yard.boxReady = [];
    yard.boxSlots = [];
    // Each waits on its ship to finish unloading, as customsFor has it.
    const put = (ship: number) => {
      const k: number = nextYardSlot(world, yard, -ship);
      yard.boxes.push(0);
      yard.boxReady!.push(-ship);
      yard.boxSlots!.push(k);
      return { k, tier: Math.floor((k % B.BOXES_PER_STORE_TILE) / 2) };
    };
    const first = [put(101), put(101), put(101)];
    // Up the one stack, before any more go on the ground.
    expect(first.map((p) => p.tier)).toEqual([0, 1, 2]);
    expect(first.map((p) => p.k - p.tier * 2)).toEqual([first[0].k, first[0].k, first[0].k]);
    // A later ship's start a stack of their own, never on the first's.
    const next = [put(102), put(102)];
    expect(next.map((p) => p.tier)).toEqual([0, 1]);
    expect(next[0].k).not.toBe(first[0].k);
  });

  it('has terminal tractors bring containers to a yard with a gantry, with no reach stackers', () => {
    const world = feederPort(true);
    const m = world.map;
    const yard = [...world.yards.values()][0];
    const spot = tractorGantry(world, yard);
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
        expect(gantryLane(world, yard)?.has(world['tileOf'](t))).toBe(true);
        if (world.snapshot().yards.some((y) => y.working === 'unload')) shown++;
      }
    }
    expect(carried).toBeGreaterThan(0);
    expect(lifting).toBeGreaterThan(0);
    expect(shown).toBeGreaterThan(0);
    expect(world.stats.containers).toBeGreaterThan(0);
  });

  it('has a gantry crane lift containers onto tractors waiting under it, clear of its stack', () => {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const m = world.map;
    const { at, f } = placeGantry(world, gantryPier(world, t.crane));
    const yard = world.yards.get(t.yard)!;
    const spot = tractorGantry(world, yard);
    expect(m.build[spot]).toBe(Build.YardGantry);
    for (let k = world.people.length - 1; k >= 0; k--) {
      if (world.people[k].kind === 'stacker') world.people.splice(k, 1);
    }
    const depot = m.build.findIndex((b) => b === Build.Depot);
    world.command({ type: 'buyMachine', kind: 'tractor', tile: depot });
    addContract(
      world,
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
    const lane = new Set(gantryRails(m, at, f).filter((_, k) => k % 2 === 1));
    for (let k = 0; k < TICKS_PER_DAY * 3; k++) {
      world.step();
      const v = world.snapshot().cranes.find((c) => c.idx === at)!;
      // Off the ship straight onto one waiting under it.
      if (v.working === 'unload' && v.workTruck !== undefined) direct++;
      if (v.working === 'give') {
        given++;
        // The tractor waits along the row behind the stack, never in the stack.
        const p = world.people.find((q) => q.id === v.workTruck)!;
        expect(lane.has(world['tileOf'](p))).toBe(true);
        expect(craneStackTiles(world).has(world['tileOf'](p))).toBe(false);
      }
    }
    expect(given + direct).toBeGreaterThan(0);
    expect(direct).toBeGreaterThan(0);
    expect(world.stats.containers).toBeGreaterThan(0);
  }, 30_000);

  it('never has a tractor or reach stacker drive across a gantry crane’s rails, only along them', () => {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    const m = world.map;
    const { at, f } = placeGantry(world, gantryPier(world, t.crane));
    const rails = gantryRails(m, at, f);
    const crane = world.cranes.get(at)!;
    const a = quayHeading(world, crane);
    const [ax, ay] = [Math.round(Math.cos(a)), Math.round(Math.sin(a))];
    const drive = (from: number, to: number) => world['driveCost'](to, from) as number;
    // Behind the stack, the row tractors line up in: along it, yes.
    const row = rails.filter((r, k) => k % 2 === 1 && r >= 0);
    const along = row.find((r) => row.includes(r + ax + ay * m.w))!;
    expect(drive(along, along + ax + ay * m.w)).toBeLessThan(Infinity);
    // Onto it, or off it, from the side: never, whatever is there.
    for (const r of row) {
      for (const side of [r + ay - ax * m.w, r - ay + ax * m.w]) {
        if (rails.includes(side)) continue;
        expect(drive(side, r)).toBe(Infinity);
        expect(drive(r, side)).toBe(Infinity);
      }
    }
    // Under it, a tractor may turn about; anywhere along it.
    expect(row.every((r) => roomToTurn(world, r))).toBe(true);
  });

  it('never has a tractor turn about on a road, only at a depot or under a crane or gantry', () => {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    const m = world.map;
    const { at, f } = placeGantry(world, gantryPier(world, t.crane));
    const yard = world.yards.get(t.yard)!;
    tractorGantry(world, yard);
    const depot = m.build.findIndex((b) => b === Build.Depot);
    const turn = (i: number) => roomToTurn(world, i) as boolean;
    expect(turn(depot)).toBe(true);
    // Under the gantry crane, along its rails behind the stack; never in a yard gantry's lane.
    expect(
      gantryRails(m, at, f)
        .filter((_, k) => k % 2 === 1)
        .some(turn),
    ).toBe(true);
    expect([...gantryLane(world, yard)!.keys()].some(turn)).toBe(false);
    // Nowhere on the roads, however wide or wherever they meet.
    const lane = new Set<number>(world['lineUpCache']!.keys());
    const roads = m.build
      .map((b, i) => (b === Build.PortRoad && !lane.has(i) ? i : -1))
      .filter((i) => i >= 0);
    expect(roads.length).toBeGreaterThan(10);
    expect(roads.some(turn)).toBe(false);
    // Part way round a corner it cannot turn back the way it came, whichever way it faces.
    world.command({ type: 'buyMachine', kind: 'tractor', tile: depot });
    const p = world.people.find((q) => q.kind === 'tractor')!;
    const road = roads.find((i) => m.neighbors4(i).filter((n) => roads.includes(n)).length >= 2)!;
    const from = m.neighbors4(road).find((n) => roads.includes(n))!;
    p.x = m.xOf(road) + 0.5;
    p.y = m.yOf(road) + 0.5;
    p.came = from;
    p.dir = Math.atan2(m.yOf(road) - m.yOf(from), m.xOf(road) - m.xOf(from)) + Math.PI / 2;
    expect(tileBehind(world, p)).toBe(from);
    const back = pathFor(world, p, road, from) as number[] | null;
    expect(back === null || back[0] !== from).toBe(true);
  });

  it('has tractors line up along a gantry crane’s rails, beside its stack, for it to lift onto', () => {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    const m = world.map;
    const { at, f } = placeGantry(world, gantryPier(world, t.crane));
    const yard = world.yards.get(t.yard)!;
    tractorGantry(world, yard);
    for (let k = world.people.length - 1; k >= 0; k--) {
      if (world.people[k].kind === 'stacker') world.people.splice(k, 1);
    }
    const depot = m.build.findIndex((b) => b === Build.Depot);
    // Three to a depot: a second for six of them.
    const second = m.build.findIndex((_, i) => !placementError(m, 'depot', i));
    world.command({ type: 'build', kind: 'depot', tiles: [second] });
    for (const d of [depot, depot, depot, second, second, second]) {
      world.command({ type: 'buyMachine', kind: 'tractor', tile: d });
    }
    expect(world.people.filter((p) => p.kind === 'tractor').length).toBe(6);
    addContract(
      world,
      {
        kind: 'fishery',
        vessel: 'feeder',
        name: 'Test Feeders',
        color: 0,
        boatEvery: 1,
        cratesMin: 24,
        cratesMax: 24,
        fee: 150,
      },
      world.tick + 10,
      0,
    );
    const crane = world.cranes.get(at)!;
    // The row behind the stack, the length of its rails.
    const lane = new Set(gantryRails(m, at, f).filter((_, k) => k % 2 === 1));
    const pick = footprint(m, 'gantryCrane', at, f)[2];
    const quay = quayHeading(world, crane);
    let offBay = 0;
    for (let k = 0; k < TICKS_PER_DAY * 3; k++) {
      world.step();
      const waiting = world.people.filter(
        (p) => p.kind === 'tractor' && underGantry(world, p) === crane,
      );
      for (const p of waiting) {
        const tile = world['tileOf'](p);
        // In the row behind the stack, lined up along the quay, each on its own tile.
        expect(lane.has(tile)).toBe(true);
        expect(craneStackTiles(world).has(tile)).toBe(false);
        expect(Math.abs(Math.cos(p.dir - quay))).toBeGreaterThan(0.9);
      }
      const tiles = new Set(waiting.map((p) => world['tileOf'](p)));
      expect(tiles.size).toBe(waiting.length);
      // And the crane lifts onto one standing along from its legs.
      const v = world.snapshot().cranes.find((c) => c.idx === at)!;
      const to = world.people.find((q) => q.id === v.workTruck);
      if (to && (v.working === 'give' || v.working === 'unload') && world['tileOf'](to) !== pick) {
        offBay++;
      }
    }
    expect(offBay).toBeGreaterThan(0);
    expect(world.stats.containers).toBeGreaterThan(0);
    // Two coming in one after the other: the first as far along as it can
    // go, the second short of it, each on a tile of its own in the row.
    const [a, b] = world.people.filter((p) => p.kind === 'tractor');
    const entry = [...lane]
      .sort(
        (x, y) =>
          Math.abs(m.xOf(x) - m.xOf(pick)) +
          Math.abs(m.yOf(x) - m.yOf(pick)) -
          (Math.abs(m.xOf(y) - m.xOf(pick)) + Math.abs(m.yOf(y) - m.yOf(pick))),
      )
      .at(-1)!;
    for (const p of [a, b]) {
      p.state = 'idle';
      p.x = m.xOf(entry) + 0.5;
      p.y = m.yOf(entry) + 0.5;
    }
    world.people = world.people.filter((p) => p.kind !== 'tractor' || p === a || p === b);
    const ahead: number = craneSpot(world, a, crane);
    a.state = 'toPickup';
    a.goal = ahead;
    const behind: number = craneSpot(world, b, crane);
    expect(lane.has(ahead) && lane.has(behind)).toBe(true);
    expect(behind).not.toBe(ahead);
    const d = (i: number) => Math.abs(m.xOf(i) - m.xOf(entry)) + Math.abs(m.yOf(i) - m.yOf(entry));
    expect(d(behind)).toBeLessThan(d(ahead));
  }, 30_000);

  it('calls tractors ahead to a gantry crane a ship is coming in to, and sets containers straight onto those pulling in', () => {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    const m = world.map;
    const { at } = placeGantry(world, gantryPier(world, t.crane));
    const yard = world.yards.get(t.yard)!;
    tractorGantry(world, yard);
    for (let k = world.people.length - 1; k >= 0; k--) {
      if (world.people[k].kind === 'stacker') world.people.splice(k, 1);
    }
    const depot = m.build.findIndex((b) => b === Build.Depot);
    for (let k = 0; k < 4; k++) world.command({ type: 'buyMachine', kind: 'tractor', tile: depot });
    // Only the feeders: the starter's smacks have nowhere here the
    // dockhands could unload them, and would only get in the way.
    for (const c of world.contracts) {
      if (c.terms.kind === 'fishery' && c.terms.vessel !== 'feeder') {
        world.command({ type: 'cancelContract', id: c.id });
      }
    }
    world.boats.length = 0;
    addContract(
      world,
      {
        kind: 'fishery',
        vessel: 'feeder',
        name: 'Test Feeders',
        color: 0,
        boatEvery: 1,
        cratesMin: 16,
        cratesMax: 16,
        fee: 150,
      },
      world.tick + 10,
      0,
    );
    const crane = world.cranes.get(at)!;
    let stacked = 0;
    const push = crane.stack.push.bind(crane.stack);
    crane.stack.push = (...v: number[]) => {
      stacked += v.length;
      return push(...v);
    };
    let calledAhead = false;
    let lifted = 0;
    const left = new Map<number, number>();
    for (let k = 0; k < TICKS_PER_DAY * 3; k++) {
      world.step();
      const ship = world.boats.find((b) => b.vessel === 'feeder' && craneReaches(world, crane, b));
      const coming = world.people.some(
        (p) => p.kind === 'tractor' && p.state === 'toPickup' && p.craneIdx === at,
      );
      if (ship?.state === 'arriving' && coming) calledAhead = true;
      for (const b of world.boats) {
        const was = left.get(b.id);
        if (b.vessel === 'feeder' && was !== undefined && b.crates < was) lifted += was - b.crates;
        left.set(b.id, b.crates);
      }
    }
    // Sent before the ship is alongside, to be there as the first comes off.
    expect(calledAhead).toBe(true);
    expect(lifted).toBeGreaterThan(10);
    // A good share straight off the ship onto a tractor, not onto the
    // crane's stack: it lifts quicker than one tractor follows another.
    expect(lifted - stacked).toBeGreaterThanOrEqual(lifted / 3);
  });

  it('keeps machines off a gantry crane’s stack row, and has tractors pull in under it lined up', () => {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    const m = world.map;
    const { at, f } = placeGantry(world, gantryPier(world, t.crane));
    const yard = world.yards.get(t.yard)!;
    tractorGantry(world, yard);
    const depot = m.build.findIndex((b) => b === Build.Depot);
    world.command({ type: 'buyMachine', kind: 'tractor', tile: depot });
    addContract(
      world,
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
    // The shipside row the length of its rails, where it sets them down.
    const row = gantryRails(m, at, f).filter((_, k) => k % 2 === 0);
    let stacked = 0;
    let across = 0;
    const crane = world.cranes.get(at)!;
    const quay = quayHeading(world, crane);
    let under = 0;
    for (let k = 0; k < TICKS_PER_DAY * 3; k++) {
      world.step();
      for (const p of world.people) {
        if (p.kind !== 'tractor' && p.kind !== 'stacker') continue;
        if (craneStackTiles(world).has(world['tileOf'](p))) across++;
        // Under the crane to be lifted onto or off, along the quay.
        if (p.kind === 'tractor' && p.state === 'picking' && underGantry(world, p) === crane) {
          under++;
          expect(Math.abs(Math.cos(p.dir - quay))).toBeGreaterThan(0.9);
        }
      }
      stacked += row.filter((i) => craneStackTiles(world).has(i)).length;
    }
    expect(stacked).toBeGreaterThan(0);
    // Not across the containers it has set down, with room to go round: at
    // most one caught as a container comes down beside it.
    expect(across).toBeLessThanOrEqual(2);
    expect(under).toBeGreaterThan(0);
    expect(world.stats.containers).toBeGreaterThan(0);
  });

  it('takes containers off a gantry crane’s stack only from the top', () => {
    const world = World.create(7, 96);
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
    const places = cranePlaces(world, c).stack;
    expect(places).toEqual([0, across, 1, across + 1, 2]);
    // The highest with none on it comes off first; one under another waits.
    expect(craneTop(world, c, false)).toBe(3);
    c.stack.splice(3, 1);
    c.stackFrom!.splice(3, 1);
    places.splice(3, 1);
    expect(craneTop(world, c, false)).toBe(1);
    expect(craneTop(world, c, false)).not.toBe(0);
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
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    expect(terminal(world)).not.toBeNull();
    addContract(
      world,
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
    const clips = clipsOf.bind(null, world);
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
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    expect(terminal(world)).not.toBeNull();
    const m = world.map;
    const from = m.idx(m.w - 1, m.yOf(m.entry) - 10);
    const berths = freeBerths(world, from, B.FEEDER_DRAFT, true, true);
    expect(berths.length).toBeGreaterThan(1);
    // Say the furthest of them were under a gantry: it goes there.
    const far = berths[berths.length - 1].berth;
    world['gantryReaches'] = (n: number) => n === far;
    expect(freeBerths(world, from, B.FEEDER_DRAFT, true, true)[0].berth).toBe(far);
  });

  it('lifts containers with a gantry crane into the bay between its legs, for the stackers', () => {
    const world = World.create(7, 96);
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
    expect(capacity(world).boxes.berths).toBeGreaterThan(0);
    addContract(
      world,
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
  }, 20_000);

  it('keeps a ship’s length of quay clear for a gantry crane’s rails, and a tile round them for machines', () => {
    const world = World.create(7, 96);
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
    const world = World.create(7, 96);
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
    addContract(
      world,
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
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    addContract(
      world,
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
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    addContract(
      world,
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
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const yard = world.yards.get(t.yard)!;
    // The ground first, a stack at a time across the yard where the
    // machines can get at it, every one cleared.
    const ground = workable(world, yard)!.size * 2;
    for (let k = 0; k < ground; k++) {
      yard.boxes.push(100);
      (yard.boxReady ??= []).push(0);
    }
    yardSlots(world, yard);
    // One still in customs has nowhere but on top of one of them.
    yard.boxes.push(100);
    yard.boxReady!.push(world.tick + 10 * TICKS_PER_DAY);
    const slots = yardSlots(world, yard).boxes;
    expect(slots[ground]).toBe(slots[0] + 2);
    // The one under it is buried: the trucks can reach all but that.
    expect(reachable(world, yard)).toBe(ground - 1);
    expect(clearTop(world, yard)).not.toBe(0);
    // Once the one on top clears too, it can go, before the one under it.
    yard.boxReady![ground] = 0;
    expect(reachable(world, yard)).toBe(ground + 1);
    expect(clearTop(world, yard)).toBe(ground);
  });

  it('stacks a container where it buries none that will clear before it', () => {
    const world = World.create(7, 96);
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
    yardSlots(world, yard);
    // One clearing in a week goes on one of those, not on the first.
    yard.boxes.push(100);
    yard.boxReady!.push(later);
    const slots = yardSlots(world, yard).boxes;
    expect(slots[ground]).not.toBe(slots[0] + 2);
  });

  it('holds containers in a yard for a day of customs from when their ship is unloaded', () => {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const add = addContract.bind(null, world);
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
    const world = World.create(7, 96);
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
    const add = addContract.bind(null, world);
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
    for (let k = 0; k < TICKS_PER_DAY * 8 && !(world.stats.exported ?? 0); k++) {
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
    const world = World.create(7, 96);
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
    // Hands enough for the boats, the trucks and the exports alike.
    const home = world.people.find((p) => p.kind === 'dockhand')!;
    for (let k = 0; k < 2; k++) {
      spawnDockhand(world, world.map.idx(Math.floor(home.x), Math.floor(home.y)), {
        id: 0,
        name: `Extra ${k}`,
        skill: 3,
        trait: null,
        wage: 0,
      });
    }
    const lot = parkingLot(world);
    expect(m.build[lot[0]]).toBe(Build.Parking);
    const add = addContract.bind(null, world);
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
    for (let k = 0; k < TICKS_PER_DAY * 6 && !(world.stats.exported && loadingTicks > 0); k++) {
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
    const world = World.create(7, 96);
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
    // Crates an older game set down for a coaster that has sailed without them.
    const quay = m.build.findIndex((b, i) => b === Build.Quay && !m.store[i]);
    const pile = oldPile(world, quay, Array(6).fill(20), true);
    expect(stranded(world, pile)).toBe(true);
    const out = world.bays.get(store[0])!;
    for (let k = 0; k < TICKS_PER_DAY && (out.exports?.length ?? 0) < 6; k++) world.step();
    expect(world.piles.get(quay)?.crates.length ?? 0).toBe(0);
    expect(out.exports?.length).toBe(6);
  });

  it('sails once nothing in the port is left for it, and says what it waits on', () => {
    const world = World.create(7, 96);
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
    expect(stillLoading(world, a)).toBe(true);
    expect(a.loadQuota).toBe(4);
    expect(stillLoading(world, b)).toBe(false);
    expect(b.loadQuota).toBe(0);
    // Its words say it is ready, not taking exports on.
    const words = (id: number) =>
      world.snapshot().entities.find((e) => e.kind === 'boat' && e.id === id)!.activity;
    expect(words(1000)).toMatch(/^Taking exports on board, 0 of 4/);
    expect(words(1001)).toMatch(/^Ready to sail/);
  });

  it('sends a ship off with the exports it has on the order, and shows how its visit is going', () => {
    const world = World.create(7, 96);
    const template = world.boats[0];
    world.boats.length = 0;
    const t = world.tick;
    const a = {
      ...template,
      id: 1000,
      vessel: 'coaster' as const,
      state: 'moored' as const,
      crates: 0,
      reserved: 0,
      out: 1,
      loadQuota: undefined,
      timer: 0,
      anchorTicks: 0,
      mooredTicks: 200,
      grace: 150,
      came: t - 300,
      mooredAt: t - 200,
      unloadedAt: t - 50,
    };
    world.boats.push(a);
    world['exportsFor'] = () => 4;
    const visit = () =>
      world.snapshot().entities.find((e) => e.kind === 'boat' && e.id === 1000)!.visit!;
    const v = visit();
    expect(v.inPort).toBe(300);
    expect(v.unloading).toBe(150);
    expect(v.unloaded).toBe(true);
    expect(v.loading).toBe(50);
    expect(v.loaded).toBe(false);
    // Past the time allowed alongside, the line stands to like it less.
    expect(v.moodChange).toBeCloseTo(B.SATISFACTION_PER_BOAT - 50 / B.MOORED_PENALTY_TICKS, 1);
    expect(v.mood).toBeGreaterThan(0);
    expect(stillLoading(world, a)).toBe(true);
    expect(visit().canSail).toBe(true);
    // Sent off: it takes on nothing more, and gets ready to sail.
    world.command({ type: 'sailNow', id: 1000 });
    expect(a.loadQuota).toBe(1);
    expect(stillLoading(world, a)).toBe(false);
  });

  it('rounds the end of a jetty wide, not shaving its corner', () => {
    const world = World.create(7, 96);
    world.boats.length = 0;
    const m = world.map;
    // The starter jetty, out along the row the road comes in on.
    const r = m.yOf(m.entry);
    const jetty = [...m.build.keys()].filter((i) => m.yOf(i) === r && m.build[i] === Build.Jetty);
    const tip = jetty[jetty.length - 1];
    const tx = m.xOf(tip);
    const ring = cornerRing(world);
    // Off its end, not along its sides.
    expect(ring[m.idx(tx + 1, r)]).toBe(B.CORNER_NEAR_COST);
    expect(ring[m.idx(tx - 2, r - 1)]).toBe(0);
    // From one side of it round to the other.
    const from = m.idx(tx, r - 3);
    const to = m.idx(tx, r + 3);
    const path = findPath(m.w, m.h, from, to, seaWayFor(world, B.BOAT_DRAFT, to, null), true)!;
    expect(path).not.toBeNull();
    const nearest = Math.min(...path.map((i) => Math.hypot(m.xOf(i) - tx, m.yOf(i) - r)));
    expect(nearest).toBeGreaterThanOrEqual(B.CORNER_CLOSE);
  });

  it('has a ship ready to sail wait its turn only behind one free to go', () => {
    const world = World.create(7, 96);
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
    expect(letsGoFirst(world, younger)).toBe(true);
    // The older one is waiting for the fairway itself: the younger goes on.
    older.holdUp = 'fairway';
    expect(letsGoFirst(world, younger)).toBe(false);
  });

  it('keeps shippers away until there is parking outside the port', () => {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    expect(terminal(world)).not.toBeNull();
    addContract(
      world,
      { kind: 'shipper', name: 'Test Exports', color: 0, perDay: 10, capacity: 6, fee: 20 },
      world.tick + 10,
      0,
    );
    for (let k = 0; k < 200; k++) world.step();
    expect(world.trucks.some((t) => t.exports)).toBe(false);
  });

  it('gives a container to the free stacker nearest the crane', () => {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    const depot = world.map.build.findIndex((b) => b === Build.Depot);
    world.command({ type: 'buyMachine', kind: 'stacker', tile: besideDepot(world) });
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
    expect(assignJob(world, far)).toBe(false);
    expect(assignJob(world, near)).toBe(true);
    expect(near.state).toBe('toPickup');
    expect(far.state).not.toBe('toPickup');
  });

  it('has a coaster leaving run out along the dock without touching it', () => {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    expect(terminal(world)).not.toBeNull();
    addContract(
      world,
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
    const clips = clipsOf.bind(null, world);
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
    const world = World.create(7, 96);
    const m = world.map;
    const row = m.yOf(m.entry);
    // The tip of the starting jetty.
    let tip = 0;
    while (m.build[m.idx(tip + 1, row)] !== Build.None || m.isLand(m.idx(tip + 1, row))) tip++;
    const boat = { ...world.boats[0], state: 'approaching' as const };
    const from = m.idx(tip + 3, row - 8);
    const to = m.idx(tip + 3, row + 8);
    const path = route(world, boat, from, to, seaWay(world, boat))!;
    expect(path).not.toBeNull();
    const closest = Math.min(...path.map((i) => Math.hypot(m.xOf(i) - tip, m.yOf(i) - row)));
    expect(closest).toBeGreaterThan(B.DOCK_FRONT_RANGE - 1);
  });

  it('keeps clear water off the bow and stern of boats moored end to end', () => {
    const world = World.create(7, 96);
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
    const clash = berthsClash.bind(null, world);
    // Two smacks a ship's length apart would lie bow to stern with no water
    // between them; a tile further on they have room.
    expect(clash(at(0, 'smack'), at(2, 'smack'))).toBe(true);
    expect(clash(at(0, 'smack'), at(3, 'smack'))).toBe(false);
    // Coasters, a good deal longer, used to overlap two tiles apart.
    expect(clash(at(0, 'coaster'), at(2, 'coaster'))).toBe(true);
    expect(clash(at(0, 'coaster'), at(3, 'coaster'))).toBe(false);
  });

  it('gives way to a boat pulling out, then to boats leaving, then to the bigger ship', () => {
    const world = World.create(7, 96);
    const template = world.boats[0];
    const boat = (
      id: number,
      vessel: 'smack' | 'feeder',
      state: 'leaving' | 'arriving',
      undock?: number,
    ) => ({ ...template, id, vessel, state, undock });
    const outranks = outranksOf.bind(null, world);
    // Going the same way, the bigger ship first, whichever came first.
    expect(outranks(boat(2, 'feeder', 'arriving'), boat(1, 'smack', 'arriving'))).toBe(true);
    // Leaving still beats coming in.
    expect(outranks(boat(1, 'smack', 'leaving'), boat(2, 'feeder', 'arriving'))).toBe(true);
    // Pulling out of its berth beats everyone.
    expect(outranks(boat(3, 'smack', 'leaving', 1), boat(1, 'feeder', 'leaving'))).toBe(true);
  });

  /** A busy container port, with coasters and smacks coming and going all day. */
  function busyPort(): World {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    expect(terminal(world)).not.toBeNull();
    for (const [vessel, every] of [
      ['coaster', 0.4],
      ['smack', 0.15],
    ] as const) {
      addContract(
        world,
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
    const clips = clipsOf.bind(null, world);
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
    // Long enough for a few to pull out, however the queue at anchor goes:
    // ten days, and on till three have, up to twenty.
    for (let k = 0; k < TICKS_PER_DAY * 20 && (k < TICKS_PER_DAY * 10 || claimed.size < 3); k++) {
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
  }, 40_000);

  it('stores containers only in yards, where the trucks collect them', () => {
    const world = World.create(7, 96);
    world.tier = 2;
    world.cash = 1_000_000;
    const t = terminal(world)!;
    expect(t).not.toBeNull();
    withTug(world, t.crane);
    const add = addContract.bind(null, world);
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
    const world = World.create(7, 96);
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
    const spots: number[] = storeSpots(world, yard);
    expect(spots.length).toBeGreaterThan(0);
    expect(spots.every((i) => m.build[i] === Build.PortRoad || m.build[i] === Build.Quay)).toBe(
      true,
    );
    // Without the port road inside, nowhere to load, road or no road.
    world.command({ type: 'bulldoze', tiles: spots });
    expect(storeSpots(world, yard)).toEqual([]);
    world.command({ type: 'build', kind: 'portRoad', tiles: spots });
    expect(storeSpots(world, yard)).toEqual(spots);
    // Marked for machines only, the yard is the port's machines' alone.
    world.command({ type: 'forkliftOnly', tiles: yard.tiles!, on: true });
    expect(storeSpots(world, world.yards.get(t.yard)!)).toEqual([]);
    world.command({ type: 'forkliftOnly', tiles: yard.tiles!, on: false });
    yard.boxes.push(100, 100);
    addContract(
      world,
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
    const world = World.create(7, 96);
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
    expect(byCrane(world, world.bays.get(store)!)).toBe(true);
    expect(storeSpots(world, world.bays.get(store)!)).toEqual([]);
  });

  it('collects containers left in a large bay by an older save', () => {
    const world = World.create(7, 96);
    const bay = [...world.bays.values()][0];
    bay.large = true;
    bay.boxes.push(100, 100);
    addContract(
      world,
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

describe('The Coastal Wharf’s landmarks', () => {
  const at = (code: number) => LANDMARKS.findIndex((l) => l.code === code);

  /** A game whose town has its seafood restaurant, and room to grow. */
  function wharfTown(tier: number): World {
    const world = World.create(7, 96);
    world.tier = tier;
    world.cash = 100_000;
    opened(world, at(Build.Restaurant) + 1);
    return world;
  }

  /** A customs office, which lines customs clears need before they may be signed. */
  function customsOffice(world: World): void {
    const m = world.map;
    const spot = m.build.findIndex((b, i) => b === Build.None && !placementError(m, 'customs', i));
    world.command({ type: 'build', kind: 'customs', tiles: [spot] });
    expect(m.build[spot]).toBe(Build.Customs);
  }

  /** The town with its first `n` landmarks open and standing. */
  function opened(world: World, n: number): void {
    const t = world.town!;
    t.landmarks = n;
    for (const l of LANDMARKS.slice(0, n)) {
      if (!world.map.build.includes(l.code)) growTown(t, world.map, () => {});
    }
  }

  /** As a truck leaving the port with `n` crates of `cargo`. */
  function truckOut(world: World, cargo: 'fish' | 'timber' | 'goods', n: number): void {
    truckLeave(world, {
      id: 999_999,
      contractId: -1,
      company: 'Test',
      capacity: n,
      x: 0,
      y: 0,
      dir: 0,
      path: [],
      goal: 0,
      state: 'leaving',
      bayIdx: -1,
      cargo: n,
      value: 20 * n,
      fees: Array(n).fill(withCargo(20, cargo)),
      boxes: false,
      idle: 0,
      timer: 0,
      variant: 0,
    } as never);
  }

  it('come after the restaurant, each lifting the cap, the last letting the town grow past 800', () => {
    const codes = LANDMARKS.slice(at(Build.Restaurant)).map((l) => l.code);
    expect(codes).toEqual([
      Build.Restaurant,
      Build.Cannery,
      Build.BuildersYard,
      Build.School,
      Build.TownHall,
    ]);
    const caps = LANDMARKS.map((l) => l.cap);
    for (let k = 1; k < caps.length; k++) expect(caps[k]).toBeGreaterThan(caps[k - 1]);
    expect(caps[at(Build.Restaurant)]).toBe(400);
    expect(caps[at(Build.School)]).toBeLessThan(TIERS[2].town);
    expect(caps.at(-1)).toBe(Infinity);
  });

  it('count nothing towards the cannery till the port is a Coastal Wharf, and say so', () => {
    const world = wharfTown(0);
    truckOut(world, 'fish', 40);
    expect(world.town!.goal).toBe(0);
    const next = world.snapshot().town!.next!;
    expect(next.name).toBe('Cannery');
    expect(next.waiting).toBe('Coastal Wharf');
    expect(next.hint).toMatch(/Coastal Wharf/);
    // Nor does a day of it count.
    world.town!.goal = 40;
    expect(landmarkDue(world.town!, true, world.tier)).toBeNull();
    // The port panel says the town hall is what the Container Port waits on.
    world.tier = 1;
    expect(world.snapshot().progress.waitsOn).toBe('Town hall');
  });

  it('open the cannery on fish kept up for days, then its offer of canned fish', () => {
    const world = wharfTown(1);
    const t = world.town!;
    // No coasters yet: the panel says what is missing.
    expect(world.snapshot().town!.next!.hint).toMatch(/coasters/i);
    const goal = LANDMARKS[at(Build.Cannery)].goal;
    for (let d = 0; d < goal.days!; d++) {
      truckOut(world, 'fish', goal.perDay!);
      // Timber does not count towards fish.
      truckOut(world, 'timber', 5);
      expect(t.landmarks).toBe(at(Build.Cannery));
      newDay(world);
    }
    expect(t.landmarks).toBe(at(Build.Cannery) + 1);
    expect(townCap(t)).toBe(LANDMARKS[at(Build.Cannery)].cap);
    expect(world.map.build.some((b) => b === Build.Cannery)).toBe(true);
    const offer = world.offers.find((o) => townTrade(o.terms) === 'canned');
    expect(offer).toBeDefined();
    // Still there when it runs out, till one is signed.
    world.offers = world.offers.filter((o) => o !== offer);
    refreshOffers(world);
    const again = world.offers.find((o) => townTrade(o.terms) === 'canned')!;
    expect(again).toBeDefined();
    // Its export papers need a customs office first.
    world.command({ type: 'signContract', id: again.id });
    expect(world.contracts.some((c) => townTrade(c.terms) === 'canned')).toBe(false);
    customsOffice(world);
    world.command({ type: 'signContract', id: again.id });
    expect(world.contracts.some((c) => townTrade(c.terms) === 'canned')).toBe(true);
    refreshOffers(world);
    expect(world.offers.some((o) => townTrade(o.terms) === 'canned')).toBe(false);
  });

  it('open the builders’ yard on canned fish put on board, then timber coasters and flats', () => {
    const world = wharfTown(1);
    const t = world.town!;
    opened(world, at(Build.BuildersYard));
    const boat = { out: 0, berth: world.map.entry } as never;
    const need = LANDMARKS[at(Build.BuildersYard)].goal.total!;
    shipOut(world, boat, Array(need - 1).fill(withCargo(15, 'canned')));
    // Fish on board does not count.
    shipOut(world, boat, [withCargo(15, 'fish')]);
    expect(t.landmarks).toBe(at(Build.BuildersYard));
    shipOut(world, boat, [withCargo(15, 'canned')]);
    expect(t.landmarks).toBe(at(Build.BuildersYard) + 1);
    const timber = world.offers.find((o) => townTrade(o.terms) === 'timber')!;
    expect(timber.terms.name).toBe('Valley Timber Co.');
    expect(timber.terms.kind === 'fishery' && timber.terms.vessel).toBe('coaster');
    // A big enough town builds flats in the middle now.
    world.debug({ type: 'debug', town: 600 });
    expect(world.map.build.some((b) => b === Build.Flats)).toBe(true);
  });

  it('builds no flats in a town of 600 without its builders’ yard', () => {
    const world = wharfTown(1);
    world.debug({ type: 'debug', town: 600 });
    expect(world.map.build.some((b) => b === Build.Flats)).toBe(false);
  });

  it('open the school on timber trucked out, then the department store and coasters of goods', () => {
    const world = wharfTown(1);
    const t = world.town!;
    opened(world, at(Build.School));
    truckOut(world, 'timber', LANDMARKS[at(Build.School)].goal.total!);
    expect(t.landmarks).toBe(at(Build.School) + 1);
    expect(world.map.build.some((b) => b === Build.School)).toBe(true);
    expect(world.map.build.some((b) => b === Build.Store)).toBe(true);
    const goods = world.offers.find((o) => townTrade(o.terms) === 'goods')!;
    expect(goods.terms.kind === 'fishery' && goods.terms.catch).toBe('goods');
    // Until it is signed the panel says to.
    expect(world.snapshot().town!.next!.hint).toMatch(new RegExp(goods.terms.name));
  });

  it('land the crates a town line’s coasters bring as what they carry', () => {
    const world = wharfTown(1);
    opened(world, at(Build.School) + 1);
    refreshOffers(world);
    const goods = world.offers.find((o) => townTrade(o.terms) === 'goods')!;
    customsOffice(world);
    world.command({ type: 'signContract', id: goods.id });
    const c = world.contracts.find((k) => townTrade(k.terms) === 'goods')!;
    c.nextBoatTick = world.tick;
    let fee: number | undefined;
    for (let k = 0; k < TICKS_PER_DAY && fee === undefined; k++) {
      world.step();
      const boat = world.boats.find((b) => b.contractId === c.id);
      fee = boat?.fee;
    }
    expect(fee).toBeDefined();
    expect(Math.round((fee! % 1) * 1e6)).toBe(4); // goods
  });

  it('are counted from an older save by how big its town is', () => {
    const world = World.create(5, 96);
    world.debug({ type: 'debug', town: 650 });
    const save = world.toSave();
    // A town that had its restaurant and grew on unchecked, as towns did.
    const loaded = World.fromSave({ ...save, town: { ...save.town!, landmarks: 3 } });
    expect(loaded.town!.landmarks).toBe(at(Build.School));
    // From before landmarks at all, the same.
    const { landmarks: _, ...old } = save.town!;
    expect(World.fromSave({ ...save, town: old as never }).town!.landmarks).toBe(at(Build.School));
    // A town short of 300 keeps the steps it had.
    const small = World.create(5, 96);
    const s2 = small.toSave();
    expect(World.fromSave({ ...s2, town: { ...s2.town!, landmarks: 2 } }).town!.landmarks).toBe(2);
  });
});
