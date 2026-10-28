import type {
  BayView,
  Capacity,
  Command,
  ContractView,
  EntityView,
  Ledger,
  LedgerCategory,
  SimEvent,
  Snapshot,
  StaffView,
  Stats,
  TileChange,
} from '../protocol';
import * as B from './balance';
import {
  fisheryDailyCrates,
  makeOffer,
  STARTER_FISHERY,
  STARTER_HAULIER,
  type Contract,
  type FisheryTerms,
  type HaulierTerms,
  type Offer,
  type Terms,
} from './contracts';
import { GameMap, type MapData } from './map';
import { generateMap } from './mapgen';
import { randomName } from './names';
import { makeCandidate, paceFactor, thought, traitDef, type Candidate, type Trait } from './staff';
import { findPath, type CostFn } from './path';
import { Rng } from './rng';
import {
  anchorOf,
  bestFacing,
  BUILDABLES,
  bulldozeError,
  bulldozeTiles,
  bulldozeValue,
  footprint,
  partOrient,
  FORKLIFT_ONLY,
  forkliftOnly,
  forkliftOnlyError,
  drivable,
  machinePlacementError,
  placementCost,
  placementError,
  ROTATABLE,
  walkableAt,
} from './rules';
import { MACHINES } from './machines';
import { BUILD_TIER, MACHINE_TIER, TIERS } from './tiers';
import {
  Build,
  Deco,
  isBay,
  isDock,
  Terrain,
  TICKS_PER_DAY,
  type BuildKind,
  type MachineKind,
} from './types';

export const SAVE_VERSION = 11;
export const SPEEDS = [0, 1, 2, 4, 8];

interface Agent {
  id: number;
  x: number;
  y: number;
  dir: number;
  /** Tiles still to walk through, next first. */
  path: number[];
  goal: number;
}

type DockhandState =
  | 'idle'
  | 'wander'
  | 'toPickup'
  | 'picking'
  | 'toDrop'
  | 'dropping'
  | 'toBreak'
  | 'resting'
  | 'broken'
  | 'toDepot'
  | 'refuelling';

const WORKING: ReadonlySet<DockhandState> = new Set(['toPickup', 'picking', 'toDrop', 'dropping']);

/** A worker that moves crates: a dockhand on foot or a forklift. */
interface Dockhand extends Agent {
  kind: 'dockhand' | MachineKind;
  name: string;
  /** Crates per trip. */
  capacity: number;
  /** Forklifts: breaks down at the next idle moment. */
  needsRepair: boolean;
  /** Forklifts: the depot it lives at, or -1. */
  home: number;
  /** Forklifts: 0 to 100. */
  fuel: number;
  /** Forklifts: why it is driving to the depot. */
  depotTask: 'refuel' | 'repair' | 'park' | null;
  /** Machines: why there is no work it can get to, if that is the trouble. */
  stuck?: string | null;
  /** Ticks spent stuck behind another worker. */
  blocked: number;
  /** Allowed to push into a full tile once, to break a deadlock. */
  squeeze: boolean;
  skill: number;
  trait: Trait | null;
  wage: number;
  energy: number;
  morale: number;
  /** Break hut tile while heading to or resting in one, else -1. */
  hutIdx: number;
  lowMoraleDays: number;
  /** Wage asked for in a pending raise request, or 0. Answer by the next day. */
  raiseAsk: number;
  state: DockhandState;
  timer: number;
  carrying: number;
  /** What each carried crate pays when it leaves on a truck. */
  cargoFees: number[];
  /** Crates reserved at the source and the bay for the current trip. */
  planned: number;
  boatId: number;
  /** Crane landing stack being collected from, or -1. */
  craneIdx: number;
  /** Where the load goes: a truck bay, or for containers a yard. */
  bayIdx: number;
}

interface Crane {
  idx: number;
  /** Jib cranes lift crates; harbour cranes lift containers off feeders. */
  kind: 'jib' | 'harbour';
  /** Fees of the crates on the landing stack. */
  stack: number[];
  /** The stack holds a coaster's pallets, which only forklifts can move. */
  pallets?: boolean;
  reserved: number;
  timer: number;
  angle: number;
  busy: boolean;
}

interface Boat extends Agent {
  /** Sails in to the anchorage, waits there if needed, then moors at a jetty. */
  state: 'approaching' | 'anchored' | 'arriving' | 'moored' | 'leaving';
  /** Feeders carry containers (counted in `crates`) and need a harbour crane. */
  vessel: 'smack' | 'coaster' | 'feeder';
  /** Water depth needed, in metres. */
  draft: number;
  contractId: number;
  company: string;
  fee: number;
  anchorTicks: number;
  mooredTicks: number;
  /** Unloading time the fishery considers fair for this load. */
  grace: number;
  crates: number;
  /** Crates promised to dockhands who are on their way. */
  reserved: number;
  berth: number;
  jetty: number;
  timer: number;
  variant: number;
  /** Tiles a tick through the water; boats speed up and slow down gradually. */
  speed?: number;
  /** Ticks spent held up by other boats or the shore. */
  held?: number;
  /** Going astern to make way for another boat. */
  astern?: boolean;
  /** Closest it has got to its goal, and ticks since it last got closer. */
  best?: number;
  stall?: number;
  /**
   * The dock whose fairway this boat holds while it comes alongside or pulls
   * out: one boat at a time per dock, so they do not meet in the narrows.
   */
  fairway?: number;
  /** Where a leaving boat cast off, to tell when it is clear of the dock. */
  castOff?: number;
  /** The dock it cast off from. */
  castDock?: number;
  /** Casting off: 1 easing sideways off the dock, 2 backing out. */
  undock?: number;
  /** Ticks left squeezing past other boats after being wedged in. */
  squeeze?: number;
}

interface Truck extends Agent {
  state: 'toBay' | 'loading' | 'leaving';
  contractId: number;
  company: string;
  capacity: number;
  bayIdx: number;
  cargo: number;
  /** Total fees of the cargo on board, paid when the truck leaves. */
  value: number;
  /** Carries containers instead of crates. */
  boxes: boolean;
  idle: number;
  timer: number;
  variant: number;
}

interface Bay {
  idx: number;
  /** Takes the big trucks: large bays and warehouses. */
  large: boolean;
  /** A warehouse: lots of room, and two loading docks that load fast. */
  warehouse?: boolean;
  /** Fees of containers waiting here (container yards only). */
  boxes: number[];
  boxIncoming: number;
  /** Fee of each crate waiting here. */
  crates: number[];
  /** Crates being carried here right now. */
  incoming: number;
  nextTruckTick: number;
  noAccess: boolean;
  /** A container yard: no trucks, only a buffer for containers. */
  yard?: boolean;
}

export interface SaveData {
  version: number;
  seed: number;
  tick: number;
  cash: number;
  speed: number;
  nextId: number;
  rng: number;
  stats: Stats;
  contracts: Contract[];
  offers: Offer[];
  candidates: Candidate[];
  cranes: Crane[];
  congestion: number;
  jam: { moving: number; waiting: number };
  tier: number;
  loan: number;
  today: Ledger;
  yesterday: Ledger | null;
  daysInRed: number;
  bankrupt: boolean;
  map: MapData;
  people: Dockhand[];
  boats: Boat[];
  trucks: Truck[];
  bays: Bay[];
  yards?: Bay[];
}

function emptyLedger(): Ledger {
  return {
    cargo: 0,
    construction: 0,
    hiring: 0,
    wages: 0,
    hauliers: 0,
    contracts: 0,
    penalties: 0,
    maintenance: 0,
    interest: 0,
  };
}

export function breachPenalty(c: { signingFee: number }): number {
  return Math.max(B.BREACH_MIN, c.signingFee * B.BREACH_MULTIPLIER);
}

/** Direction of travel as a lane: 0 east, 1 south, 2 west, 3 north. */
function laneOf(dir: number): number {
  return ((Math.round(dir / (Math.PI / 2)) % 4) + 4) % 4;
}

function isMachine(p: { kind: string }): boolean {
  return p.kind !== 'dockhand';
}

/** Room left at a bay for crates, or at a container yard for containers. */
function bayRoom(b: Bay, boxes: boolean): number {
  if (b.yard) return boxes ? B.YARD_BOXES - b.boxes.length - b.boxIncoming : 0;
  if (boxes) return 0;
  return bayCap(b) - b.crates.length - b.incoming;
}

function bayIncoming(b: Bay, boxes: boolean, delta: number): void {
  if (boxes) b.boxIncoming = Math.max(0, b.boxIncoming + delta);
  else b.incoming = Math.max(0, b.incoming + delta);
}

function bayCap(b: Bay): number {
  return b.warehouse ? B.WAREHOUSE_CAPACITY : b.large ? B.LARGE_BAY_CAPACITY : B.BAY_CAPACITY;
}

/** Ticks to put one crate or container on a truck here. */
function loadTicks(b: Bay): number {
  if (b.yard) return B.YARD_LOAD_TICKS;
  if (b.warehouse) return B.WAREHOUSE_LOAD_TICKS;
  return b.large ? B.LARGE_BAY_LOAD_TICKS : B.BAY_LOAD_TICKS;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** An angle brought into -π..π. */
function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function cancelFee(c: Contract): number {
  return Math.round(c.signingFee * B.CANCEL_FEE_SHARE);
}

const ACTIVITY: Record<DockhandState, string> = {
  idle: 'Waiting for work',
  wander: 'Stretching their legs',
  toPickup: 'Heading to the boat',
  picking: 'Lifting a crate',
  toDrop: 'Carrying a crate to the truck bay',
  dropping: 'Stacking a crate',
  toBreak: 'Off for a break',
  resting: 'On a break',
  broken: 'Being repaired',
  toDepot: 'Driving to the depot',
  refuelling: 'Refuelling',
};

/** Reach stackers handle containers, and take them to a yard. */
const STACKER_ACTIVITY: Partial<Record<DockhandState, string>> = {
  toPickup: 'Heading to the crane',
  picking: 'Lifting a container',
  toDrop: 'Taking a container to the yard',
  dropping: 'Stacking a container',
};

function activity(p: Dockhand): string {
  if (p.state === 'idle' && p.stuck) return p.stuck;
  return (p.kind === 'stacker' && STACKER_ACTIVITY[p.state]) || ACTIVITY[p.state];
}

/** Authoritative game state. Runs inside the sim worker and in tests. */
export class World {
  tick = 0;
  cash = B.START_CASH;
  speed = 1;
  nextId = 1;
  contracts: Contract[] = [];
  offers: Offer[] = [];
  candidates: Candidate[] = [];
  cranes = new Map<number, Crane>();
  /** Share of yesterday's worker travel time lost waiting for each other. */
  congestion = 0;
  /** Today's worker ticks spent moving and waiting, for `congestion`. */
  jam = { moving: 0, waiting: 0 };
  /** Index into TIERS. */
  tier = 0;
  loan = 0;
  today: Ledger = emptyLedger();
  yesterday: Ledger | null = null;
  /** Consecutive days that ended with negative cash. */
  daysInRed = 0;
  bankrupt = false;
  stats: Stats = {
    cratesHandled: 0,
    containers: 0,
    boats: 0,
    trucks: 0,
    earned: 0,
    penalties: 0,
  };
  people: Dockhand[] = [];
  boats: Boat[] = [];
  trucks: Truck[] = [];
  bays = new Map<number, Bay>();
  /** Container yards, by their main tile. */
  yards = new Map<number, Bay>();

  private anchorageTile = -1;
  /** Ticks today with a full truck bay, for the advisor. Not saved. */
  private bayFullTicks = 0;
  /** Cached planning estimate; cleared when the port changes. Not saved. */
  private capacityCache: Capacity | null = null;
  /** Dock groups and the coordinated tiles; cleared when the map changes. Not saved. */
  private dockCache: ReturnType<World['docks']> | null = null;
  private coordinated = new Set<number>();
  /** Dock tile → its dock's key (the dock's lowest tile), with docks(). */
  private dockKey = new Map<number, number>();
  private warnedOffice = false;
  private warnedBigTrucks = false;
  private warnedBoxTrucks = false;
  private warnedStuck = false;
  /** Shortest road from the highway to a truck bay; set by capacity(). */
  private roadLen = Infinity;
  private events: SimEvent[] = [];
  /** Workers per tile and lane (tile * 4 + lane), rebuilt every tick. Not saved. */
  private occupancy: Uint8Array;
  private dirty = new Set<number>();

  private constructor(
    readonly seed: number,
    readonly map: GameMap,
    readonly rng: Rng,
  ) {
    this.occupancy = new Uint8Array(map.w * map.h * 4);
  }

  static create(seed: number): World {
    const { map, spawn } = generateMap(seed);
    const world = new World(seed, map, new Rng(seed));
    for (let i = 0; i < map.build.length; i++) {
      if (isBay(map.build[i]) && anchorOf(map, i) === i) world.addBay(i);
    }
    for (let k = 0; k < B.START_DOCKHANDS; k++) {
      world.spawnDockhand(spawn, {
        id: 0,
        name: randomName(world.rng),
        skill: 2,
        trait: null,
        wage: B.WAGE_DOCKHAND,
      });
    }
    world.refreshCandidates();
    const starter = world.addContract(STARTER_FISHERY, 0, B.STARTER_SIGNING_FEE);
    // The first boat is already coming in when the game starts.
    world.spawnBoat(starter.id, STARTER_FISHERY, true);
    starter.nextBoatTick = Math.round(TICKS_PER_DAY * STARTER_FISHERY.boatEvery);
    world.addContract(STARTER_HAULIER, 0, 0);
    world.addOffer('fishery');
    world.addOffer('fishery');
    world.addOffer('haulier');
    world.events = [];
    world.message('Welcome to your new port! Boats will bring crates to the jetty.', 'info');
    return world;
  }

  /** A save is only usable if it has every field this version writes. */
  static isValidSave(s: unknown): s is SaveData {
    const d = s as SaveData;
    return (
      !!d &&
      d.version === SAVE_VERSION &&
      Number.isFinite(d.cash) &&
      Array.isArray(d.contracts) &&
      d.boats.every((b) => Number.isFinite(b.grace) && Number.isFinite(b.fee)) &&
      d.trucks.every((t) => Number.isFinite(t.value) && Number.isFinite(t.capacity)) &&
      Array.isArray(d.candidates) &&
      Number.isFinite(d.loan) &&
      Number.isFinite(d.tier) &&
      Number.isFinite(d.congestion) &&
      Array.isArray(d.cranes) &&
      d.people.every((p) => Number.isFinite(p.fuel) && Number.isFinite(p.home)) &&
      d.boats.every((b) => Number.isFinite(b.draft)) &&
      !!d.today &&
      d.people.every(
        (p) =>
          Array.isArray(p.cargoFees) &&
          Number.isFinite(p.energy) &&
          Number.isFinite(p.wage) &&
          Number.isFinite(p.raiseAsk),
      ) &&
      d.bays.every((b) => Array.isArray(b.crates)) &&
      d.contracts.every((c) => Number.isFinite(c.signingFee))
    );
  }

  static fromSave(s: SaveData): World {
    const world = new World(s.seed, GameMap.fromData(s.map), new Rng(s.rng));
    world.tick = s.tick;
    world.cash = s.cash;
    world.speed = s.speed;
    world.nextId = s.nextId;
    world.stats = { ...s.stats, containers: s.stats.containers ?? 0 };
    world.contracts = s.contracts.map((c) => ({ ...c, terms: { ...c.terms } }));
    world.offers = s.offers.map((o) => ({ ...o, terms: { ...o.terms } }));
    world.candidates = s.candidates.map((c) => ({ ...c }));
    world.loan = s.loan;
    world.tier = s.tier;
    world.congestion = s.congestion;
    world.jam = { ...s.jam };
    for (const c of s.cranes) {
      world.cranes.set(c.idx, { ...c, kind: c.kind ?? 'jib', stack: [...c.stack] });
    }
    world.today = { ...s.today };
    world.yesterday = s.yesterday ? { ...s.yesterday } : null;
    world.daysInRed = s.daysInRed;
    world.bankrupt = s.bankrupt;
    world.people = s.people.map((p) => ({ ...p, path: [...p.path], cargoFees: [...p.cargoFees] }));
    world.boats = s.boats.map((b) => ({ ...b, path: [...b.path] }));
    world.trucks = s.trucks.map((t) => ({ ...t, path: [...t.path] }));
    for (const bay of s.bays) {
      world.bays.set(bay.idx, {
        ...bay,
        crates: [...bay.crates],
        boxes: [...(bay.boxes ?? [])],
        boxIncoming: bay.boxIncoming ?? 0,
        large: bay.large ?? false,
      });
    }
    for (const y of s.yards ?? []) world.yards.set(y.idx, { ...y, boxes: [...y.boxes] });
    return world;
  }

  toSave(): SaveData {
    return structuredClone({
      version: SAVE_VERSION,
      seed: this.seed,
      tick: this.tick,
      cash: this.cash,
      speed: this.speed,
      nextId: this.nextId,
      rng: this.rng.state,
      stats: this.stats,
      contracts: this.contracts,
      offers: this.offers,
      candidates: this.candidates,
      cranes: [...this.cranes.values()],
      congestion: this.congestion,
      jam: this.jam,
      tier: this.tier,
      loan: this.loan,
      today: this.today,
      yesterday: this.yesterday,
      daysInRed: this.daysInRed,
      bankrupt: this.bankrupt,
      map: this.map.toData(),
      people: this.people,
      boats: this.boats,
      trucks: this.trucks,
      bays: [...this.bays.values()],
      yards: [...this.yards.values()],
    });
  }

  // ── Commands ──────────────────────────────────────────────

  command(cmd: Command): void {
    if (this.bankrupt) return;
    this.capacityCache = null;
    this.dockCache = null;
    switch (cmd.type) {
      case 'build':
        return this.build(cmd.kind, cmd.tiles, cmd.facing);
      case 'bulldoze':
        return this.bulldoze(cmd.tiles);
      case 'forkliftOnly':
        return this.markForkliftOnly(cmd.tiles, cmd.on);
      case 'hire':
        return this.hire(cmd.candidateId);
      case 'fire':
        return this.fire(cmd.id);
      case 'loan':
        return this.takeLoan(cmd.amount);
      case 'upgrade':
        return this.upgrade();
      case 'buyMachine':
        return this.buyMachine(cmd.kind, cmd.tile);
      case 'raise':
        return this.answerRaise(cmd.id, cmd.accept);
      case 'signContract':
        return this.signContract(cmd.id);
      case 'cancelContract':
        return this.cancelContract(cmd.id);
      case 'setSpeed':
        if (SPEEDS.includes(cmd.speed)) this.speed = cmd.speed;
        return;
      case 'newGame':
      case 'save':
      case 'debug':
        return; // handled by the worker
    }
  }

  private build(kind: BuildKind, tiles: number[], facing?: number): void {
    const def = BUILDABLES[kind];
    if (BUILD_TIER[kind] > this.tier) {
      return this.message(`${def.label} unlocks at the ${TIERS[BUILD_TIER[kind]].name}.`, 'bad');
    }
    let spent = 0;
    let firstError: string | null = null;
    // Docks grow out from the shore, so a line dragged from the sea inwards
    // only fits once the tiles nearer the shore are built: keep going round
    // until nothing more can be placed.
    let left = tiles.filter((i) => i >= 0 && i < this.map.build.length);
    let broke = false;
    while (left.length > 0 && !broke) {
      firstError = null;
      const skipped: number[] = [];
      for (const i of left) {
        const f = facing ?? bestFacing(this.map, kind, i);
        const err = placementError(this.map, kind, i, undefined, f) ?? this.boatInTheWay(kind, i);
        if (err) {
          firstError ??= err;
          skipped.push(i);
          continue;
        }
        const cost = placementCost(this.map, kind, i);
        if (cost > this.cash) {
          firstError = 'Not enough money';
          broke = true;
          break;
        }
        this.book('construction', -cost);
        spent += cost;
        footprint(this.map, kind, i, f).forEach((t, k) => {
          this.map.build[t] = def.code;
          this.map.orient[t] = ROTATABLE.has(kind) ? partOrient(f, k) : 0;
          this.map.deco[t] = Deco.None;
          this.dirty.add(t);
        });
        if (kind === 'truckBay' || kind === 'largeBay' || kind === 'warehouse') this.addBay(i);
        if (kind === 'containerYard') this.addYard(i);
        if (kind === 'jibCrane') this.addCrane(i, 'jib');
        if (kind === 'harbourCrane') this.addCrane(i, 'harbour');
      }
      if (skipped.length === left.length) break;
      left = skipped;
    }
    if (spent > 0) this.moneyAt(-spent, tiles[tiles.length - 1]);
    if (spent > 0 && (kind === 'jetty' || kind === 'quay')) {
      this.dockCache = null;
      const idle = this.docks().some((g) => !g.coordinated);
      if (idle && !this.warnedOffice) {
        this.warnedOffice = true;
        this.message(
          kind === 'quay'
            ? 'Quays need a harbour office to coordinate them. Boats will not use this one until you build one.'
            : `Only ${B.FREE_DOCKS} jetties can run without a harbour office. Build one so boats use this jetty.`,
          'bad',
        );
      }
    } else if (spent > 0 && kind === 'office') {
      this.warnedOffice = false;
      this.message('The harbour office is open and coordinating berths.', 'good');
    } else if (firstError) this.message(firstError, 'bad');
  }

  private boatInTheWay(kind: BuildKind, i: number): string | null {
    if (kind === 'quay' && this.map.build[i] === Build.Jetty) {
      const moored = this.boats.some((b) => b.jetty === i || b.berth === i);
      return moored ? 'A boat is moored here' : null;
    }
    if (kind !== 'jetty') return null;
    const blocked = this.boats.some((b) => b.berth === i || this.tileOf(b) === i);
    return blocked ? 'A boat is in the way' : null;
  }

  private markForkliftOnly(tiles: number[], on: boolean): void {
    if (this.tier < B.FORKLIFT_ONLY_TIER) {
      return this.message(
        `Forklift-only roads unlock at the ${TIERS[B.FORKLIFT_ONLY_TIER].name}.`,
        'bad',
      );
    }
    let spent = 0;
    let firstError: string | null = null;
    for (const i of tiles) {
      if (i < 0 || i >= this.map.build.length) continue;
      const err = forkliftOnlyError(this.map, i);
      if (err) {
        firstError ??= err;
        continue;
      }
      if (forkliftOnly(this.map, i) === on) continue;
      if (this.cash < B.FORKLIFT_ONLY_COST) {
        firstError = 'Not enough money';
        break;
      }
      this.book('construction', -B.FORKLIFT_ONLY_COST);
      spent += B.FORKLIFT_ONLY_COST;
      this.map.orient[i] ^= FORKLIFT_ONLY;
      this.dirty.add(i);
    }
    if (spent > 0) this.moneyAt(-spent, tiles[tiles.length - 1]);
    else if (firstError) this.message(firstError, 'bad');
  }

  private bulldoze(tiles: number[]): void {
    let net = 0;
    let lastError: string | null = null;
    for (const t of tiles) {
      if (t < 0 || t >= this.map.build.length) continue;
      // A click anywhere on a building takes all of it down.
      const i = anchorOf(this.map, t);
      let err = bulldozeError(this.map, i);
      if (!err && isDock(this.map.build[i]) && this.boats.some((b) => b.jetty === i)) {
        err = 'A boat is moored here';
      }
      if (err) {
        lastError = err;
        continue;
      }
      const value = bulldozeValue(this.map, i);
      if (value < 0 && this.cash < -value) {
        lastError = 'Not enough money';
        break;
      }
      this.book('construction', value);
      net += value;
      if (this.map.build[i] === Build.JibCrane || this.map.build[i] === Build.HarbourCrane) {
        // Taking down a crane leaves the quay it stood on.
        this.cranes.delete(i);
        this.map.build[i] = Build.Quay;
      } else if (this.map.build[i] !== Build.None) {
        if (isBay(this.map.build[i])) this.removeBay(i);
        if (this.map.build[i] === Build.Yard) this.removeYard(i);
        for (const b of bulldozeTiles(this.map, i)) {
          this.map.build[b] = Build.None;
          this.map.orient[b] = 0;
          this.dirty.add(b);
        }
      } else if (this.map.deco[i] !== Deco.None) {
        this.map.deco[i] = Deco.None;
      } else {
        this.map.terrain[i] = Terrain.Grass;
      }
      this.dirty.add(i);
    }
    if (net !== 0) this.moneyAt(net, tiles[tiles.length - 1]);
    else if (lastError && tiles.length === 1) this.message(lastError, 'bad');
  }

  /** Testing shortcuts. The worker only forwards these on the dev server. */
  debug(cmd: Extract<Command, { type: 'debug' }>): void {
    if (cmd.cash) {
      this.cash += cmd.cash;
      this.message(`Debug: +$${cmd.cash.toLocaleString('en-US')}`, 'good');
    }
    if (cmd.tier !== undefined) this.tier = cmd.tier;
    if (cmd.containers) {
      const taken = new Set([...this.contracts, ...this.offers].map((c) => c.terms.name));
      let line = false;
      let haul = false;
      for (let k = 0; k < 60 && !(line && haul); k++) {
        const kind = line ? 'haulier' : 'fishery';
        const o = makeOffer(this.rng, this.nextId++, this.tick, kind, taken, 2);
        if (!o) continue;
        if (!line && o.terms.kind === 'fishery' && o.terms.vessel === 'feeder') {
          this.addContract(o.terms, this.tick + 30, o.signingFee);
          line = true;
        } else if (line && o.terms.kind === 'haulier' && o.terms.cargo === 'container') {
          this.addContract(o.terms, 0, o.signingFee);
          haul = true;
        }
      }
    }
    if (cmd.coaster) {
      const taken = new Set([...this.contracts, ...this.offers].map((c) => c.terms.name));
      for (let k = 0; k < 20; k++) {
        const o = makeOffer(this.rng, this.nextId++, this.tick, 'fishery', taken, 1);
        if (o && o.terms.kind === 'fishery' && o.terms.vessel === 'coaster') {
          this.addContract(o.terms, this.tick + 30, o.signingFee);
          return;
        }
      }
    }
  }

  /** Every change to cash goes through here, so the ledger adds up. */
  private book(category: LedgerCategory, amount: number): void {
    this.cash += amount;
    this.today[category] += amount;
  }

  private interestDue(): number {
    return Math.round(this.loan * B.LOAN_DAILY_RATE);
  }

  /** Positive amounts borrow, negative amounts repay. */
  private takeLoan(amount: number): void {
    if (amount > 0) {
      const room = B.LOAN_MAX - this.loan;
      const borrow = Math.min(amount, room);
      if (borrow <= 0) return this.message('The bank will not lend you any more.', 'bad');
      this.loan += borrow;
      this.cash += borrow;
      this.message(`Borrowed $${borrow.toLocaleString('en-US')} from the bank.`, 'info');
    } else {
      const repay = Math.min(-amount, this.loan);
      if (repay <= 0) return;
      if (this.cash < repay) return this.message('Not enough cash to repay that much.', 'bad');
      this.loan -= repay;
      this.cash -= repay;
      this.message(`Repaid $${repay.toLocaleString('en-US')} of the loan.`, 'good');
    }
  }

  private tierProgress(): { crates: number; contracts: number } {
    return { crates: this.stats.cratesHandled, contracts: this.fisheries().length };
  }

  canUpgrade(): boolean {
    const next = TIERS[this.tier + 1];
    if (!next || next.comingSoon) return false;
    const p = this.tierProgress();
    return p.crates >= next.crates && p.contracts >= next.contracts && this.cash >= next.cost;
  }

  private upgrade(): void {
    const next = TIERS[this.tier + 1];
    if (!next || next.comingSoon) return this.message('No further upgrades yet.', 'info');
    if (!this.canUpgrade())
      return this.message('The port does not meet the requirements yet.', 'bad');
    this.book('construction', -next.cost);
    this.tier++;
    this.capacityCache = null;
    this.message(
      `The port is now a ${next.name}! New buildings and machines are unlocked.`,
      'good',
    );
    this.addOffer('fishery');
  }

  private hire(candidateId: number): void {
    const c = this.candidates.find((x) => x.id === candidateId);
    if (!c) return this.message('That candidate has taken another job.', 'bad');
    if (this.cash < B.HIRE_FEE) return this.message('Not enough money to hire', 'bad');
    this.book('hiring', -B.HIRE_FEE);
    this.candidates = this.candidates.filter((x) => x !== c);
    const p = this.spawnDockhand(this.muster(), c);
    this.message(`${p.name} has been hired and reports at the truck bay.`, 'good');
  }

  /** Replace one candidate each day and top the list up. */
  private refreshCandidates(): void {
    if (this.candidates.length >= B.CANDIDATES) this.candidates.shift();
    while (this.candidates.length < B.CANDIDATES) {
      this.candidates.push(makeCandidate(this.rng, this.nextId++));
    }
  }

  private fire(id: number): void {
    const p = this.people.find((q) => q.id === id);
    if (!p) return;
    if (isMachine(p)) {
      const refund = Math.round(MACHINES[p.kind as MachineKind].price * B.SELL_SHARE);
      this.cancelJob(p);
      this.people = this.people.filter((q) => q !== p);
      this.book('construction', refund);
      this.message(`Sold ${p.name} for $${refund}.`, 'info');
      return;
    }
    if (p.carrying) this.message(`${p.name} dropped their crate on the way out.`, 'bad');
    this.cancelJob(p);
    this.people = this.people.filter((q) => q !== p);
    this.message(`${p.name} has left the port.`, 'info');
  }

  // ── Contracts ─────────────────────────────────────────────

  private addContract(terms: Terms, firstBoatTick: number, signingFee: number): Contract {
    const c: Contract = {
      id: this.nextId++,
      // A copy: the starter terms are shared by every new game.
      terms: { ...terms },
      signingFee,
      satisfaction: B.START_SATISFACTION,
      nextBoatTick: firstBoatTick,
      warned: false,
    };
    this.contracts.push(c);
    return c;
  }

  private addOffer(kind: Terms['kind']): void {
    const taken = new Set([...this.contracts, ...this.offers].map((c) => c.terms.name));
    const offer = makeOffer(this.rng, this.nextId++, this.tick, kind, taken, this.tier);
    if (offer) this.offers.push(offer);
  }

  private refreshOffers(): void {
    const expired = this.offers.filter((o) => o.expires <= this.tick);
    this.offers = this.offers.filter((o) => o.expires > this.tick);
    if (expired.length > 0 && this.offers.length === 0) {
      this.message('Some contract offers have expired.', 'info');
    }
    if (this.offers.length < B.MAX_OFFERS && this.rng.next() < 0.7) {
      // Keep at least one offer of each kind on the board.
      const has = (k: Terms['kind']) => this.offers.some((o) => o.terms.kind === k);
      const kind = !has('haulier')
        ? 'haulier'
        : !has('fishery')
          ? 'fishery'
          : this.rng.next() < 0.6
            ? 'fishery'
            : 'haulier';
      const before = this.offers.length;
      this.addOffer(kind);
      if (this.offers.length > before) {
        this.message(`New contract offer from ${this.offers.at(-1)!.terms.name}.`, 'info');
      }
    }
  }

  private signContract(offerId: number): void {
    const offer = this.offers.find((o) => o.id === offerId);
    if (!offer) return this.message('That offer is no longer available.', 'bad');
    if (this.cash < offer.signingFee) return this.message('Not enough money to sign', 'bad');
    this.book('contracts', -offer.signingFee);
    this.offers = this.offers.filter((o) => o !== offer);
    // A new fishery sends its first boat soon after signing.
    this.addContract(offer.terms, this.tick + this.rng.int(60, 240), offer.signingFee);
    this.message(`Signed with ${offer.terms.name}.`, 'good');
  }

  private cancelContract(id: number): void {
    const c = this.contracts.find((x) => x.id === id);
    if (!c) return;
    const fee = cancelFee(c);
    this.book('contracts', -fee);
    this.stats.penalties += fee;
    this.contracts = this.contracts.filter((x) => x !== c);
    this.message(
      fee > 0
        ? `Contract with ${c.terms.name} ended. Buyout: $${fee}.`
        : `Contract with ${c.terms.name} ended.`,
      'info',
    );
    if (!this.contracts.some((x) => x.terms.kind === 'haulier')) {
      this.message('No haulier is under contract. No trucks will come for crates!', 'bad');
    }
  }

  private fisheries(): (Contract & { terms: FisheryTerms })[] {
    return this.contracts.filter((c) => c.terms.kind === 'fishery') as (Contract & {
      terms: FisheryTerms;
    })[];
  }

  private hauliers(): (Contract & { terms: HaulierTerms })[] {
    return this.contracts.filter((c) => c.terms.kind === 'haulier') as (Contract & {
      terms: HaulierTerms;
    })[];
  }

  /**
   * Settle a fishery boat's visit as it leaves. Waiting costs demurrage and
   * goodwill; a fishery with no goodwill left walks out and claims a penalty.
   */
  private penalty(amount: number, at: number): void {
    if (amount <= 0) return;
    this.book('penalties', -amount);
    this.stats.penalties += amount;
    this.moneyAt(-amount, at);
  }

  private judgeVisit(b: Boat, gaveUp: boolean): void {
    const slowTicks = Math.max(0, b.mooredTicks - b.grace);
    const demurrage = Math.round(
      ((b.anchorTicks + slowTicks) / TICKS_PER_DAY) * B.DEMURRAGE_PER_DAY,
    );
    if (demurrage > 0) {
      this.penalty(demurrage, this.tileOf(b));
      if (demurrage >= 30) {
        this.message(`${b.company} charged $${demurrage} demurrage for waiting.`, 'bad');
      }
    }
    if (gaveUp && b.crates > 0) {
      const claim = Math.round(b.crates * b.fee * B.LOST_CARGO_SHARE);
      this.penalty(claim, this.tileOf(b));
      this.message(
        `A ${b.company} boat gave up and left with ${b.crates} ${b.vessel === 'feeder' ? 'containers' : 'crates'}. They claim $${claim}.`,
        'bad',
      );
    }

    const c = this.contracts.find((x) => x.id === b.contractId);
    if (!c) return;
    const anchored = b.anchorTicks / B.ANCHOR_PENALTY_TICKS;
    const slow = slowTicks / B.MOORED_PENALTY_TICKS;
    const delta = B.SATISFACTION_PER_BOAT - anchored - slow - (gaveUp ? B.GAVE_UP_PENALTY : 0);
    c.satisfaction = Math.max(0, Math.min(100, c.satisfaction + delta));
    if (c.satisfaction === 0) {
      this.contracts = this.contracts.filter((x) => x !== c);
      const breach = breachPenalty(c);
      this.penalty(breach, this.tileOf(b));
      this.message(
        `${c.terms.name} has walked out and claims $${breach} for breach of contract.`,
        'bad',
      );
    } else if (c.satisfaction < 25 && !c.warned) {
      c.warned = true;
      this.message(`${c.terms.name} is unhappy. Their boats are waiting too long.`, 'bad');
    } else if (c.satisfaction >= 40) {
      c.warned = false;
    }
  }

  private adviseOnBays(): void {
    const fullForLong = this.bayFullTicks > TICKS_PER_DAY / 3;
    this.bayFullTicks = 0;
    if (!fullForLong) return;
    const trucks = this.hauliers().reduce((n, c) => n + c.terms.fleet, 0);
    this.message(
      trucks < this.bays.size
        ? 'Crates are piling up in the truck bays. Sign another haulier for more trucks.'
        : 'Truck bays keep filling up. Each bay loads one truck at a time, so build another truck bay.',
      'info',
    );
  }

  /**
   * Rough crates-per-day estimates for planning, from walking and driving
   * distances. Shown in the Contracts panel.
   */
  capacity(): Capacity {
    if (this.capacityCache) return this.capacityCache;
    const m = this.map;
    const demand = this.fisheries()
      .filter((c) => c.terms.vessel !== 'feeder')
      .reduce((n, c) => n + fisheryDailyCrates(c.terms), 0);

    // One trip: dock to the nearest bay and back, plus handling.
    const jetties: number[] = [];
    for (let i = 0; i < m.build.length; i++) if (this.dockInUse(i)) jetties.push(i);
    const bays = [...this.bays.keys()];
    let walk = 0;
    for (const j of jetties) {
      const d = Math.min(...bays.map((b) => this.dist(j, b)));
      walk += Number.isFinite(d) ? d : 0;
    }
    const avgWalk = jetties.length && bays.length ? walk / jetties.length : 0;
    let hasHut = false;
    for (let i = 0; i < m.build.length && !hasHut; i++) hasHut = m.build[i] === Build.BreakHut;
    // Share of the day spent working rather than resting.
    const uptime = hasHut ? 0.88 : 0.72;
    let unloading = 0;
    let forklifting = 0;
    if (bays.length && jetties.length) {
      for (const p of this.people) {
        if (p.kind === 'stacker') continue;
        if (p.kind === 'forklift') {
          // Forklifts carry several crates, need no breaks but do break down.
          // They cannot drive onto wooden jetties, so they need a quay.
          if (!jetties.some((j) => m.build[j] !== Build.Jetty)) continue;
          const ticks =
            (2 * avgWalk * 1.2) / B.FORKLIFT_SPEED + (B.PICK_TICKS + B.DROP_TICKS) * 1.5;
          forklifting += ((TICKS_PER_DAY * 0.9) / ticks) * p.capacity;
          continue;
        }
        const handling = (B.PICK_TICKS + B.DROP_TICKS) * traitDef(p.trait).handling;
        const pace = paceFactor(p.skill, p.morale, 100);
        const tripTicks = (2 * avgWalk * 1.2) / (B.WALK_SPEED * pace) + handling;
        unloading += (TICKS_PER_DAY * uptime) / tripTicks;
      }
    }

    // One truck trip: highway to bay and back, plus loading. A bay loads one
    // truck at a time, so trucks beyond the number of bays add nothing.
    this.roadLen = bays.length
      ? Math.min(
          ...bays.map(
            (b) => findPath(m.w, m.h, m.entry, b, this.truckCost(b), false)?.length ?? Infinity,
          ),
        )
      : Infinity;
    // Time lost in queues on narrow walkways comes straight off the top.
    unloading = (unloading + forklifting) * (1 - this.congestion);
    const palletDemand = this.fisheries()
      .filter((c) => c.terms.vessel === 'coaster')
      .reduce((n, c) => n + fisheryDailyCrates(c.terms), 0);
    this.capacityCache = {
      congestion: this.congestion,
      demand: Math.round(demand),
      unloading: Math.round(unloading),
      trucking: this.truckingWith(null),
      deepBerths: this.berthCount(B.COASTER_DRAFT, true),
      pallets: {
        demand: Math.round(palletDemand),
        unloading: Math.round(forklifting * (1 - this.congestion)),
      },
      boxes: this.containerCapacity(),
    };
    return this.capacityCache;
  }

  /** Rough containers-per-day estimates, like the crate ones above. */
  private containerCapacity(): Capacity['boxes'] {
    const demand = this.fisheries()
      .filter((c) => c.terms.vessel === 'feeder')
      .reduce((n, c) => n + fisheryDailyCrates(c.terms), 0);
    const cranes = [...this.cranes.values()].filter((c) => c.kind === 'harbour');
    // A crane only works while a feeder is alongside; allow for gaps.
    const lifting = cranes.length * (TICKS_PER_DAY / B.HARBOUR_CRANE_TICKS) * 0.6;
    const yards = [...this.yards.keys()];
    let walk = 0;
    for (const c of cranes) {
      walk += yards.length ? Math.min(...yards.map((y) => this.dist(c.idx, y))) : 0;
    }
    const avg = cranes.length && yards.length ? walk / cranes.length : 0;
    const stackers = this.people.filter((p) => p.kind === 'stacker').length;
    const trip = (2 * avg * 1.2) / B.STACKER_SPEED + (B.PICK_TICKS + B.DROP_TICKS) * 2.5;
    const moving = avg > 0 ? stackers * ((TICKS_PER_DAY * 0.85) / trip) : 0;
    let trucking = 0;
    // Trucks load at the yards, one at a time each, so only as many trucks
    // as yards count, the biggest first.
    const roads = yards.map(
      (y) => findPath(this.map.w, this.map.h, this.map.entry, y, this.truckCost(y), false)?.length,
    );
    const road = Math.min(...roads.map((n) => n ?? Infinity));
    if (Number.isFinite(road)) {
      const perTruck = this.hauliers()
        .filter((h) => h.terms.cargo === 'container')
        .flatMap((h) => {
          const ticks = (2 * road) / B.TRUCK_SPEED + h.terms.capacity * B.YARD_LOAD_TICKS + 30;
          return Array<number>(h.terms.fleet).fill((h.terms.capacity * TICKS_PER_DAY) / ticks);
        })
        .sort((a, b) => b - a);
      trucking = perTruck.slice(0, yards.length).reduce((n, r) => n + r, 0);
    }
    return {
      demand: Math.round(demand),
      lifting: Math.round(lifting),
      moving: Math.round(moving),
      trucking: Math.round(trucking),
      berths: this.berthCount(B.FEEDER_DRAFT, true, true),
    };
  }

  /**
   * Crates per day the hauliers can take away, optionally with one more
   * haulier signed. Uses the road length found by capacity().
   */
  private truckingWith(extra: HaulierTerms | null): number {
    if (!Number.isFinite(this.roadLen)) return 0;
    const terms = this.hauliers()
      .map((c) => c.terms)
      .filter((t) => !t.cargo);
    if (extra && !extra.cargo) terms.push(extra);
    // Each dock loads one truck at a time, so trucks beyond the docks add
    // nothing, and big trucks only fit large bays and warehouses. Trucks take
    // the quickest docks first, the big ones before the rest.
    const trucks = terms
      .flatMap((t) => Array.from({ length: t.fleet }, () => t.capacity))
      .sort((a, b) => b - a);
    const docks = [...this.bays.values()]
      .flatMap((b) => this.loadingDocks(b).map(() => ({ large: b.large, load: loadTicks(b) })))
      .sort((a, b) => a.load - b.load);
    let total = 0;
    for (const cap of trucks) {
      const k = docks.findIndex((d) => d.large || cap <= B.TRUCK_CAPACITY);
      if (k < 0) continue;
      const [dock] = docks.splice(k, 1);
      const ticks = (2 * this.roadLen) / B.TRUCK_SPEED + cap * dock.load + 30;
      total += (cap * TICKS_PER_DAY) / ticks;
    }
    return Math.round(total);
  }

  private dailyFees(): number {
    return this.hauliers().reduce((sum, c) => sum + c.terms.dailyFee, 0);
  }

  // ── Tick ──────────────────────────────────────────────────

  step(): void {
    if (this.bankrupt) return;
    if (!Number.isFinite(this.cash)) {
      // Never let a bad value spread through the economy; fail loudly instead.
      throw new Error(`Cash became ${this.cash} at tick ${this.tick}`);
    }
    this.tick++;
    if (this.tick % TICKS_PER_DAY === 0) this.newDay();
    this.spawnBoats();
    for (const b of [...this.boats]) this.updateBoat(b);
    for (const c of this.cranes.values()) this.updateCrane(c);
    this.countOccupancy();
    for (const p of this.people) this.updateDockhand(p);
    if (this.tick % 10 === 0) this.spawnTrucks();
    for (const t of [...this.trucks]) this.updateTruck(t);
  }

  private wageBill(): number {
    return this.people.reduce((n, p) => n + p.wage, 0);
  }

  private answerRaise(id: number, accept: boolean): void {
    const p = this.people.find((q) => q.id === id);
    if (!p || p.raiseAsk === 0) return;
    if (accept) {
      p.wage = p.raiseAsk;
      this.changeMorale(p, B.RAISE_ACCEPT_MORALE);
      this.message(`${p.name} is delighted with the raise.`, 'good');
    } else {
      this.changeMorale(p, B.RAISE_REFUSE_MORALE);
      this.message(`${p.name} is not happy about being turned down.`, 'bad');
    }
    p.raiseAsk = 0;
  }

  /** Unanswered requests count as a no; then some staff ask for more. */
  private raiseRequests(): void {
    for (const p of this.people) {
      if (p.raiseAsk > 0) this.answerRaise(p.id, false);
      else if (p.morale < B.RAISE_MORALE_BELOW && this.rng.next() < B.RAISE_CHANCE) {
        p.raiseAsk = p.wage + B.RAISE_STEP;
        this.message(
          `${p.name} asks for a raise to $${p.raiseAsk}/day. Answer in the Staff panel by tomorrow.`,
          'info',
        );
      }
    }
  }

  /** Staff whose morale stays rock bottom hand in their notice. */
  private checkMorale(): void {
    for (const p of [...this.people]) {
      p.lowMoraleDays = p.morale < B.QUIT_MORALE ? p.lowMoraleDays + 1 : 0;
      if (p.lowMoraleDays === 1) {
        this.message(`${p.name} is miserable and thinking about quitting.`, 'bad');
      } else if (p.lowMoraleDays >= B.QUIT_DAYS) {
        this.cancelJob(p);
        this.people = this.people.filter((q) => q !== p);
        this.message(`${p.name} has quit. Morale was too low.`, 'bad');
      }
    }
  }

  private newDay(): void {
    this.checkMorale();
    this.raiseRequests();
    this.refreshCandidates();
    const travel = this.jam.moving + this.jam.waiting;
    this.congestion = travel > 0 ? this.jam.waiting / travel : 0;
    this.jam = { moving: 0, waiting: 0 };
    this.capacityCache = null;
    this.book('wages', -this.wageBill());
    this.book('hauliers', -this.dailyFees());
    for (const c of this.cranes.values()) {
      this.book(
        'maintenance',
        -(c.kind === 'harbour' ? B.HARBOUR_CRANE_RUNNING_COST : B.CRANE_RUNNING_COST),
      );
    }
    for (const p of this.people) {
      if (isMachine(p) && this.rng.next() < B.FORKLIFT_BREAKDOWN) p.needsRepair = true;
    }
    this.book('interest', -this.interestDue());
    this.yesterday = this.today;
    this.today = emptyLedger();
    this.refreshOffers();
    this.adviseOnBays();
    this.capacityCache = null;

    if (this.cash >= 0) {
      if (this.daysInRed > 0) this.message('The port is back in the black.', 'good');
      this.daysInRed = 0;
      return;
    }
    this.daysInRed++;
    const left = B.BANKRUPT_DAYS - this.daysInRed;
    if (left <= 0) {
      this.bankrupt = true;
      this.speed = 0;
      this.message('The bank has closed the port. You are bankrupt.', 'bad');
    } else if (this.daysInRed === 1) {
      this.message(
        `The port is in the red! Get back above $0 within ${left} days or the bank will close it.`,
        'bad',
      );
    } else if (left <= 3) {
      this.message(`${left} day${left === 1 ? '' : 's'} until the bank closes the port.`, 'bad');
    }
  }

  // ── Boats ─────────────────────────────────────────────────

  private spawnBoats(): void {
    for (const c of this.fisheries()) {
      if (this.tick < c.nextBoatTick) continue;
      const days = c.terms.boatEvery * this.rng.range(0.7, 1.3);
      c.nextBoatTick = this.tick + Math.round(TICKS_PER_DAY * days);
      if (this.boats.length < B.MAX_BOATS) {
        this.spawnBoat(c.id, c.terms);
      } else {
        // The harbour is jammed; the fishery notices.
        c.satisfaction = Math.max(0, c.satisfaction - B.NO_ROOM_PENALTY);
      }
    }
  }

  /** A boat sails in from the open sea, or (`close`) from just off the anchorage. */
  private spawnBoat(contractId: number, terms: FisheryTerms, close = false): void {
    const edge = this.seaEdgeTiles();
    if (edge.length === 0) return;
    const start = this.rng.pick(edge);
    const boat: Boat = {
      id: this.nextId++,
      contractId,
      company: terms.name,
      vessel: terms.vessel,
      draft:
        terms.vessel === 'feeder'
          ? B.FEEDER_DRAFT
          : terms.vessel === 'coaster'
            ? B.COASTER_DRAFT
            : B.BOAT_DRAFT,
      fee: terms.fee,
      anchorTicks: 0,
      mooredTicks: 0,
      grace: 0,
      x: this.map.xOf(start) + 0.5,
      y: this.map.yOf(start) + 0.5,
      dir: Math.PI,
      path: [],
      goal: start,
      state: 'approaching',
      crates: this.rng.int(terms.cratesMin, terms.cratesMax),
      reserved: 0,
      berth: -1,
      jetty: -1,
      timer: 0,
      variant: terms.color,
    };
    boat.grace = B.MOORED_GRACE_TICKS + boat.crates * B.MOORED_TICKS_PER_CRATE;
    this.boats.push(boat);
    this.stats.boats++;
    // The first boat of the game is already coming in, a few tiles off the
    // jetty, and heads straight for a berth.
    if (close) {
      const m = this.map;
      const row = m.yOf(m.entry);
      let x = 0;
      while (x < m.w - 1 && this.boatCost(m.idx(x, row)) !== 1) x++;
      boat.x = Math.min(x + 6, m.w - 2) + 0.5;
      boat.y = row + 0.5;
      boat.dir = Math.PI;
      boat.speed = B.VESSELS[boat.vessel].speed * 0.6;
      if (this.tryBerth(boat)) return;
    }
    // Head for a spot at the anchorage; the berth is decided on arrival.
    const spot = this.anchorSpot(boat);
    const from = this.tileOf(boat);
    const path = findPath(this.map.w, this.map.h, from, spot, this.boatCostFor(boat.draft), true);
    if (path) {
      boat.path = path;
      boat.goal = spot;
      boat.state = 'approaching';
      // Already under way, heading for the first waypoint.
      const next = boat.path[0] ?? spot;
      boat.dir = Math.atan2(this.map.yOf(next) + 0.5 - boat.y, this.map.xOf(next) + 0.5 - boat.x);
      boat.speed = B.VESSELS[boat.vessel].speed;
    } else {
      boat.state = 'anchored';
    }
  }

  /**
   * Open water offshore and off to one side of the harbour mouth, where boats
   * wait for a berth without blocking the way in and out. Derived from the
   * map, so it is not saved.
   */
  private anchorage(): number {
    if (this.anchorageTile >= 0) return this.anchorageTile;
    const m = this.map;
    const row = m.yOf(m.entry);
    let x = 0;
    while (x < m.w - 1 && this.boatCost(m.idx(x, row)) !== 1) x++;
    x = Math.min(x + 9, m.w - 8);
    // North or south of the fairway, whichever side has more open sea.
    const open = (cy: number) => {
      let n = 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const tx = x + dx;
          const ty = cy + dy;
          if (m.inBounds(tx, ty) && this.boatCostFor(B.FEEDER_DRAFT)(m.idx(tx, ty)) === 1) n++;
        }
      }
      return n;
    };
    const north = Math.max(4, row - 10);
    const south = Math.min(m.h - 5, row + 10);
    this.anchorageTile = m.idx(x, open(north) >= open(south) ? north : south);
    return this.anchorageTile;
  }

  /** A free spot at the anchorage, clear of other waiting boats. */
  private anchorSpot(boat: Boat): number {
    const m = this.map;
    const centre = this.anchorage();
    const cx = m.xOf(centre);
    const cy = m.yOf(centre);
    const row = m.yOf(m.entry);
    // Room to swing at anchor: big ships need more of it.
    const taken = this.boats
      .filter((b) => b !== boat && (b.state === 'approaching' || b.state === 'anchored'))
      .map((b) => ({
        at: b.goal,
        room: (B.VESSELS[b.vessel].length + B.VESSELS[boat.vessel].length) / 2 + 1.5,
      }));
    for (let r = 0; r < 14; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx * 2;
          const y = cy + dy;
          if (!m.inBounds(x, y)) continue;
          // Stay out of the fairway in front of the harbour.
          if (Math.abs(y - row) < 6) continue;
          const i = m.idx(x, y);
          if (this.boatCostFor(boat.draft)(i) !== 1) continue;
          const clear = taken.every((t) => Math.hypot(m.xOf(t.at) - x, m.yOf(t.at) - y) > t.room);
          if (clear) return i;
        }
      }
    }
    return centre;
  }

  /** Anchored boats get berths in the order they arrived. */
  private nextInQueue(): Boat | undefined {
    let first: Boat | undefined;
    for (const b of this.boats) {
      if (b.state === 'anchored' && (!first || b.anchorTicks > first.anchorTicks)) first = b;
    }
    return first;
  }

  private seaEdgeTiles(): number[] {
    const out: number[] = [];
    const x = this.map.w - 1;
    for (let y = 1; y < this.map.h - 1; y++) {
      const i = this.map.idx(x, y);
      if (this.boatCost(i) === 1) out.push(i);
    }
    return out;
  }

  private boatCosts = new Map<number, CostFn>();

  /** Open sea at least `draft` metres deep. */
  private boatCostFor(draft: number): CostFn {
    let fn = this.boatCosts.get(draft);
    if (!fn) {
      fn = (i) =>
        this.map.ocean[i] && this.map.build[i] === Build.None && this.map.depth[i] >= draft
          ? 1
          : Infinity;
      this.boatCosts.set(draft, fn);
    }
    return fn;
  }

  private boatCost: CostFn = (i) => this.boatCostFor(B.BOAT_DRAFT)(i);

  /**
   * Tiles a moored boat covers: its berth plus one tile either way along the
   * jetty, since boats are about two tiles long. Null if it would hit land.
   */
  private footprint(berth: number, jetty: number, half = 1): number[] | null {
    const m = this.map;
    const x = m.xOf(berth);
    const y = m.yOf(berth);
    const alongX = m.yOf(jetty) !== y;
    const ends: number[][] = [];
    for (let k = 1; k <= half; k++) {
      ends.push(
        ...(alongX
          ? [
              [x - k, y],
              [x + k, y],
            ]
          : [
              [x, y - k],
              [x, y + k],
            ]),
      );
    }
    const out = [berth];
    for (const [ex, ey] of ends) {
      if (!m.inBounds(ex, ey)) return null;
      const i = m.idx(ex, ey);
      if (m.isLand(i) || m.build[i] !== Build.None) return null;
      out.push(i);
    }
    return out;
  }

  /**
   * Two moored boats clash if they share water, unless they lie end to end
   * in one lane: hulls are a little shorter than their berths, so the end
   * tiles can be shared.
   */
  private berthsClash(a: number[], b: number[]): boolean {
    const m = this.map;
    const reach = (a.length - 1) / 2 + (b.length - 1) / 2;
    const ax = m.xOf(a[0]);
    const ay = m.yOf(a[0]);
    const bx = m.xOf(b[0]);
    const by = m.yOf(b[0]);
    const rowA = m.yOf(a[1]) === m.yOf(a[2]);
    const rowB = m.yOf(b[1]) === m.yOf(b[2]);
    if (rowA && rowB && ay === by) return Math.abs(ax - bx) < reach;
    if (!rowA && !rowB && ax === bx) return Math.abs(ay - by) < reach;
    return a.some((t) => b.includes(t));
  }

  /** Berth tiles either side of the middle: feeders are long ships. */
  private boatHalf(feeder: boolean): number {
    return feeder ? B.FEEDER_HALF_BERTH : 1;
  }

  /** How many boats of this draft could moor at once, ignoring current traffic. */
  /**
   * Docks (connected jetty or quay structures) and whether the harbour
   * office coordinates each. Without an office only the first FREE_DOCKS
   * jetties, nearest the truck bay, are used; quays always need one.
   */
  docks(): { tiles: number[]; quay: boolean; coordinated: boolean }[] {
    if (this.dockCache) return this.dockCache;
    const m = this.map;
    const seen = new Uint8Array(m.build.length);
    const groups: { tiles: number[]; quay: boolean; coordinated: boolean; d: number }[] = [];
    const home = this.muster();
    for (let i = 0; i < m.build.length; i++) {
      if (seen[i] || !isDock(m.build[i])) continue;
      const tiles: number[] = [];
      const stack = [i];
      seen[i] = 1;
      while (stack.length > 0) {
        const t = stack.pop()!;
        tiles.push(t);
        for (const n of m.neighbors4(t)) {
          if (!seen[n] && isDock(m.build[n])) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
      const quay = tiles.some((t) => m.build[t] !== Build.Jetty);
      const d = Math.min(...tiles.map((t) => this.dist(t, home)));
      groups.push({ tiles, quay, coordinated: false, d });
    }
    groups.sort((a, b) => a.d - b.d || a.tiles[0] - b.tiles[0]);
    let offices = 0;
    for (const b of m.build) if (b === Build.Office) offices++;
    if (offices > 0) {
      groups.slice(0, offices * B.DOCKS_PER_OFFICE).forEach((g) => (g.coordinated = true));
    } else {
      groups
        .filter((g) => !g.quay)
        .slice(0, B.FREE_DOCKS)
        .forEach((g) => (g.coordinated = true));
    }
    this.dockCache = groups;
    this.coordinated = new Set(groups.filter((g) => g.coordinated).flatMap((g) => g.tiles));
    this.dockKey = new Map(
      groups.flatMap((g) => {
        const key = Math.min(...g.tiles);
        return g.tiles.map((t) => [t, key] as [number, number]);
      }),
    );
    return groups;
  }

  /** Dock tiles boats may use; see docks(). */
  private dockInUse(i: number): boolean {
    this.docks();
    return this.coordinated.has(i);
  }

  /**
   * Big ships moor only against a quay at least two tiles wide: the dock tile
   * beside the berth and the one behind it, away from the water.
   */
  private wideQuay(j: number, berth: number): boolean {
    const m = this.map;
    const behind = m.idx(2 * m.xOf(j) - m.xOf(berth), 2 * m.yOf(j) - m.yOf(berth));
    const quay = (i: number) => isDock(m.build[i]) && m.build[i] !== Build.Jetty;
    return (
      quay(j) &&
      m.inBounds(2 * m.xOf(j) - m.xOf(berth), 2 * m.yOf(j) - m.yOf(berth)) &&
      quay(behind)
    );
  }

  private harbourCraneReaches(berth: number): boolean {
    const m = this.map;
    for (const c of this.cranes.values()) {
      if (c.kind !== 'harbour') continue;
      const d = Math.max(
        Math.abs(m.xOf(c.idx) - m.xOf(berth)),
        Math.abs(m.yOf(c.idx) - m.yOf(berth)),
      );
      if (d <= 1) return true;
    }
    return false;
  }

  berthCount(draft: number, wide = false, needCrane = false): number {
    const m = this.map;
    const water = this.boatCostFor(draft);
    const chosen: number[][] = [];
    for (let j = 0; j < m.build.length; j++) {
      if (!this.dockInUse(j)) continue;
      for (const n of m.neighbors4(j)) {
        if (water(n) !== 1) continue;
        if (wide && !this.wideQuay(j, n)) continue;
        if (needCrane !== this.harbourCraneReaches(n)) continue;
        const fp = this.footprint(n, j, this.boatHalf(needCrane));
        if (fp && !chosen.some((c) => this.berthsClash(fp, c))) chosen.push(fp);
      }
    }
    return chosen.length;
  }

  /** Water tiles beside a jetty where a boat can moor, nearest first. */
  private freeBerths(
    from: number,
    draft: number,
    wide: boolean,
    needCrane = false,
  ): { berth: number; jetty: number }[] {
    const water = this.boatCostFor(draft);
    const m = this.map;
    const taken = this.boats
      .filter((b) => b.berth >= 0)
      .map(
        (b) => this.footprint(b.berth, b.jetty, this.boatHalf(b.vessel === 'feeder')) ?? [b.berth],
      );
    const out: { berth: number; jetty: number; d: number }[] = [];
    for (let j = 0; j < m.build.length; j++) {
      if (!this.dockInUse(j)) continue;
      for (const n of m.neighbors4(j)) {
        if (water(n) !== 1) continue;
        if (wide && !this.wideQuay(j, n)) continue;
        // Berths under a harbour crane are kept for container ships.
        if (needCrane !== this.harbourCraneReaches(n)) continue;
        const fp = this.footprint(n, j, this.boatHalf(needCrane));
        if (!fp || taken.some((t) => this.berthsClash(fp, t))) continue;
        // Not while another boat is still pulling out of it.
        const bx = m.xOf(n) + 0.5;
        const by = m.yOf(n) + 0.5;
        const busy = this.boats.some(
          (b) => b.state === 'leaving' && Math.hypot(b.x - bx, b.y - by) < 2.5,
        );
        if (busy) continue;
        // The harbour master sends boats to the best-equipped free berth:
        // under a crane first, then a quay forklifts can reach.
        const nx = m.xOf(n);
        const ny = m.yOf(n);
        const craned = [...this.cranes.values()].some(
          (c) =>
            c.kind === 'jib' &&
            Math.max(Math.abs(m.xOf(c.idx) - nx), Math.abs(m.yOf(c.idx) - ny)) <= 1,
        );
        const bonus = craned ? 200 : m.build[j] === Build.Jetty ? 0 : 100;
        const d = Math.abs(nx - m.xOf(from)) + Math.abs(ny - m.yOf(from)) - bonus;
        out.push({ berth: n, jetty: j, d });
      }
    }
    return out.sort((a, b) => a.d - b.d || a.berth - b.berth);
  }

  private tryBerth(boat: Boat): boolean {
    const from = this.tileOf(boat);
    const feeder = boat.vessel === 'feeder';
    for (const c of this.freeBerths(from, boat.draft, boat.vessel !== 'smack', feeder).slice(
      0,
      6,
    )) {
      // One boat at a time comes alongside or pulls out on each side of a
      // dock; the rest wait at the anchorage, out of the way.
      if (!this.fairwayFree(boat, c.jetty, c.berth)) continue;
      const path = findPath(this.map.w, this.map.h, from, c.berth, this.seaWay(boat), true);
      if (!path) continue;
      boat.berth = c.berth;
      boat.jetty = c.jetty;
      this.takeFairway(boat);
      boat.best = Infinity;
      boat.path = path;
      boat.goal = c.berth;
      boat.state = 'arriving';
      return true;
    }
    boat.state = 'anchored';
    return false;
  }

  private updateBoat(b: Boat): void {
    if (b.state === 'anchored' || b.state === 'moored') {
      if (b.anchorTicks + b.mooredTicks > B.BOAT_GIVE_UP_TICKS && b.crates > 0) {
        // The claim message in judgeVisit explains what happened.
        return this.depart(b, true);
      }
    }
    switch (b.state) {
      case 'approaching':
        if (this.sail(b, null) !== 'moving') {
          b.state = 'anchored';
          b.speed = 0;
          const queue = this.boats.filter((q) => q.state === 'anchored').length;
          if (!this.tryBerth(b) && queue === 1) {
            this.message('Boats are queueing at the anchorage. Every berth is taken.', 'info');
          }
        }
        return;
      case 'anchored':
        b.anchorTicks++;
        if (this.tick % 10 === 0 && this.nextInQueue() === b) this.tryBerth(b);
        return;
      case 'arriving': {
        // Come alongside: lie along the berth, parallel to the dock edge.
        const alongX = this.map.yOf(b.jetty) !== this.map.yOf(b.berth);
        const r = this.sail(b, alongX ? 0 : Math.PI / 2);
        if (r === 'blocked') {
          this.freeFairway(b);
          b.berth = b.jetty = -1;
          b.state = 'anchored';
          b.speed = 0;
        } else if (r === 'arrived') {
          this.freeFairway(b);
          b.state = 'moored';
          b.speed = 0;
          const what =
            b.vessel === 'feeder' ? 'feeder ship' : b.vessel === 'coaster' ? 'coaster' : 'boat';
          const cargo =
            b.vessel === 'feeder'
              ? 'containers'
              : b.vessel === 'coaster'
                ? 'crates on pallets'
                : 'crates';
          this.message(`A ${b.company} ${what} has moored with ${b.crates} ${cargo}.`, 'info');
          if (b.vessel === 'coaster' && !this.people.some((p) => p.kind === 'forklift')) {
            this.message('Pallets can only be unloaded by forklifts. Buy one at a depot.', 'bad');
          }
        }
        return;
      }
      case 'moored':
        // Unloaded and waiting for the fairway does not count against us.
        if (b.crates > 0 || b.reserved > 0) b.mooredTicks++;
        if (b.crates === 0 && b.reserved === 0 && ++b.timer > 30) {
          if (this.takeFairway(b)) this.depart(b, false);
        }
        return;
      case 'leaving':
        // Clear of the dock: the next boat may use its fairway.
        if (b.fairway !== undefined && b.castOff !== undefined) {
          const m = this.map;
          if (Math.hypot(b.x - m.xOf(b.castOff) - 0.5, b.y - m.yOf(b.castOff) - 0.5) > 3) {
            this.freeFairway(b);
          }
        }
        if (this.sail(b, null) !== 'moving') {
          this.freeFairway(b);
          this.boats = this.boats.filter((q) => q !== b);
        }
        return;
    }
  }

  // ── Seamanship ────────────────────────────────────────────

  /**
   * Steer a boat along its path the way a boat moves: it turns at a limited
   * rate, speeds up and slows down gradually, eases off for bends and to
   * stop, and gives way to other boats. With `moor` set it comes alongside
   * at the end, crabbing sideways the last bit, lying along that heading
   * (either way round).
   */
  private sail(b: Boat, moor: number | null): 'moving' | 'arrived' | 'blocked' {
    const v = B.VESSELS[b.vessel];
    const w = this.map.w;
    const cost = this.boatCostFor(b.draft);
    const cx = (i: number) => (i % w) + 0.5;
    const cy = (i: number) => Math.floor(i / w) + 0.5;
    const accel = v.speed / 30;
    let speed = b.speed ?? 0;
    if (b.path.length === 0) b.path = [b.goal];
    // Waypoints already passed drop off; the last one is the goal itself.
    while (b.path.length > 1 && Math.hypot(cx(b.path[0]) - b.x, cy(b.path[0]) - b.y) < 0.9) {
      b.path.shift();
    }
    const goal = b.path[b.path.length - 1];
    const gx = cx(goal);
    const gy = cy(goal);
    let remaining = Math.hypot(cx(b.path[0]) - b.x, cy(b.path[0]) - b.y);
    for (let k = 1; k < b.path.length; k++) {
      remaining += Math.hypot(cx(b.path[k]) - cx(b.path[k - 1]), cy(b.path[k]) - cy(b.path[k - 1]));
    }

    // Final approach to a berth: line up with it and crab in sideways.
    if (moor !== null && remaining < 1.6) {
      const flip = Math.abs(wrapAngle(moor - b.dir)) > Math.PI / 2 ? Math.PI : 0;
      const err = wrapAngle(moor + flip - b.dir);
      b.dir += clamp(err, -v.turn * 0.6, v.turn * 0.6);
      speed = Math.min(speed, 0.03 + remaining * 0.1);
      const step = Math.min(remaining, Math.max(speed, 0.008));
      if (remaining > 1e-6) {
        b.x += ((gx - b.x) / remaining) * step;
        b.y += ((gy - b.y) / remaining) * step;
      }
      b.speed = speed;
      if (remaining - step < 0.02 && Math.abs(err) < 0.04) {
        b.x = gx;
        b.y = gy;
        b.dir = wrapAngle(moor + flip);
        b.path = [];
        return 'arrived';
      }
      return 'moving';
    }
    // Out to sea, a leaving boat just sails off the map.
    const gone = b.state === 'leaving' && remaining < 1;
    if (gone || (moor === null && remaining < 0.25 && speed < v.speed * 0.4)) {
      b.path = [];
      b.speed = 0;
      return 'arrived';
    }

    // Aim at the furthest of the next few waypoints with open water to it;
    // the ones before it are as good as passed.
    // Clear water means clear of other boats lying still, too.
    const avoid = this.seaWay(b);
    const clear: CostFn = (i) => (avoid(i) === 1 ? 1 : Infinity);
    let ahead = 0;
    for (let k = 1; k < Math.min(b.path.length, 4); k++) {
      if (!this.openWater(b.x, b.y, cx(b.path[k]), cy(b.path[k]), clear)) break;
      ahead = k;
    }
    b.path.splice(0, ahead);
    const target = b.path[0];
    const want = Math.atan2(cy(target) - b.y, cx(target) - b.x);
    if (b.undock && this.castingOff(b, want)) return 'moving';
    const way = this.giveWay(b);
    const err = wrapAngle(want - b.dir);
    // A boat needs way on to turn: it never spins on the spot, it slows and
    // swings round in an arc.
    const turn = v.turn * (0.3 + (0.7 * speed) / v.speed);
    b.dir = wrapAngle(b.dir + clamp(err, -turn, turn));
    // Ease off for sharp bends, to stop at the goal, and for other boats.
    let desired = v.speed * Math.max(0.06, Math.cos(Math.min(Math.abs(err), Math.PI / 2)) ** 2);
    desired = Math.min(desired, Math.sqrt(2 * accel * remaining) + 0.004);
    desired *= way.speed;
    speed += clamp(desired - speed, -accel * 2, accel);
    speed = Math.max(0, speed);

    // A boat with right of way is waiting on this one: go astern to clear
    // its way, as long as nothing is behind.
    if (way.makeWay) {
      this.goAstern(b);
      return 'moving';
    }
    b.astern = false;

    // Never run aground: keep the middle of the hull, and a little ahead of
    // it, in open water. The path already keeps clear of the shore.
    const nx = b.x + Math.cos(b.dir) * speed;
    const ny = b.y + Math.sin(b.dir) * speed;
    const bowX = nx + Math.cos(b.dir) * 0.3;
    const bowY = ny + Math.sin(b.dir) * 0.3;
    if (this.navigable(nx, ny, cost) && this.navigable(bowX, bowY, cost)) {
      b.x = nx;
      b.y = ny;
    } else {
      // Too close to the shore or a jetty to turn: work along the path at a
      // crawl instead, as a skipper would with a bit of throttle and rudder.
      const px = cx(target) - b.x;
      const py = cy(target) - b.y;
      const d = Math.hypot(px, py);
      const step = Math.min(d, v.speed * 0.2);
      speed = 0;
      if (d > 1e-6 && way.speed > 0.05) {
        b.x += (px / d) * step;
        b.y += (py / d) * step;
        speed = step;
      }
    }
    b.speed = speed;

    b.held = speed < v.speed * 0.1 ? (b.held ?? 0) + 1 : 0;
    // Wedged in for most of a day: squeeze past for a while, as a last
    // resort so the harbour never locks up for good.
    if (b.squeeze) b.squeeze--;
    else if (b.held > B.BOAT_WEDGED_AFTER || (b.stall ?? 0) > B.BOAT_WEDGED_AFTER * 2) {
      b.squeeze = 200;
      b.held = 0;
      b.stall = 0;
    }
    // Getting no closer, held up or going round in circles: find another way,
    // round every other boat this time.
    const straight = Math.hypot(gx - b.x, gy - b.y);
    if (straight < (b.best ?? Infinity) - 0.05) {
      b.best = straight;
      b.stall = 0;
    } else b.stall = (b.stall ?? 0) + 1;
    if (b.stall > B.BOAT_REROUTE_AFTER && b.stall % B.BOAT_REROUTE_AFTER === 0) {
      const from = this.tileOf(b);
      const path =
        findPath(this.map.w, this.map.h, from, goal, this.seaWay(b, true), true) ??
        findPath(this.map.w, this.map.h, from, goal, this.seaWay(b), true);
      if (path) b.path = path.length > 0 ? path : [goal];
      else if (b.stall > B.BOAT_REROUTE_AFTER * 8) return 'blocked';
    }
    return 'moving';
  }

  /**
   * Leaving a berth like a boat: ease sideways off the dock first, then, if
   * the way out lies astern, back out, swinging the bow round, until there
   * is room to turn under way. Returns true while still casting off.
   */
  private castingOff(b: Boat, want: number): boolean {
    const m = this.map;
    const v = B.VESSELS[b.vessel];
    const cost = this.boatCostFor(b.draft);
    if (b.castOff === undefined || b.castDock === undefined) {
      b.undock = undefined;
      return false;
    }
    const bx = m.xOf(b.castOff) + 0.5;
    const by = m.yOf(b.castOff) + 0.5;
    // Unit step away from the dock.
    const ax = m.xOf(b.castOff) - m.xOf(b.castDock);
    const ay = m.yOf(b.castOff) - m.yOf(b.castDock);
    if (b.undock === 1) {
      const off = (b.x - bx) * ax + (b.y - by) * ay;
      const step = v.speed * 0.2;
      if (off < 0.3 && this.navigable(b.x + ax * step, b.y + ay * step, cost)) {
        b.x += ax * step;
        b.y += ay * step;
        b.speed = 0;
        return true;
      }
      b.undock = 2;
    }
    const err = wrapAngle(want - b.dir);
    const backed = Math.hypot(b.x - bx, b.y - by);
    if (Math.abs(err) > 1.75 && backed < 2.5) {
      const back = v.speed * 0.5;
      const sx = b.x - Math.cos(b.dir) * back;
      const sy = b.y - Math.sin(b.dir) * back;
      const stern = { ...this.hullOf(b), hx: -Math.cos(b.dir), hy: -Math.sin(b.dir) };
      const clear =
        this.navigable(sx - Math.cos(b.dir) * 0.3, sy - Math.sin(b.dir) * 0.3, cost) &&
        this.boats.every(
          (o) => o === b || this.inWay(stern, this.hullOf(o), stern.half + 0.3) === null,
        );
      if (clear) {
        b.x = sx;
        b.y = sy;
        // Going astern the stern swings one way and the bow the other.
        b.dir = wrapAngle(b.dir + clamp(err, -v.turn * 0.4, v.turn * 0.4));
        b.speed = 0;
        b.astern = true;
        return true;
      }
    }
    b.undock = undefined;
    b.astern = false;
    return false;
  }

  /** Back off slowly to clear the way for another boat, if nothing is astern. */
  private goAstern(b: Boat): void {
    const v = B.VESSELS[b.vessel];
    const cost = this.boatCostFor(b.draft);
    const back = v.speed * 0.3;
    const sx = b.x - Math.cos(b.dir) * back;
    const sy = b.y - Math.sin(b.dir) * back;
    const sternX = sx - Math.cos(b.dir) * 0.3;
    const sternY = sy - Math.sin(b.dir) * 0.3;
    const astern = { ...this.hullOf(b), hx: -Math.cos(b.dir), hy: -Math.sin(b.dir) };
    const clearAstern = this.boats.every(
      (o) => o === b || this.inWay(astern, this.hullOf(o), astern.half + 0.3) === null,
    );
    const moved =
      clearAstern && this.navigable(sx, sy, cost) && this.navigable(sternX, sternY, cost);
    if (moved) {
      b.x = sx;
      b.y = sy;
    }
    b.speed = 0;
    b.astern = true;
    b.held = (b.held ?? 0) + 1;
  }

  /** Open water here; past the map edge is open sea, where boats come and go. */
  private navigable(x: number, y: number, cost: CostFn): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    return !this.map.inBounds(tx, ty) || Number.isFinite(cost(this.map.idx(tx, ty)));
  }

  /** Open water all along a straight line, so the boat can cut the corner. */
  private openWater(x0: number, y0: number, x1: number, y1: number, cost: CostFn): boolean {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.25);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      if (!this.navigable(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, cost)) return false;
    }
    return true;
  }

  /** Where a boat's hull lies: centre, unit heading and half extents. */
  private hullOf(b: Boat): {
    x: number;
    y: number;
    hx: number;
    hy: number;
    half: number;
    beam: number;
  } {
    const v = B.VESSELS[b.vessel];
    return {
      x: b.x,
      y: b.y,
      hx: Math.cos(b.dir),
      hy: Math.sin(b.dir),
      half: v.length / 2,
      beam: v.beam / 2,
    };
  }

  /**
   * Right of way: boats leaving go first, then boats coming in to a berth,
   * then those heading for the anchorage; between equals, the one that
   * came first. Boats lying still never move for anyone.
   */
  private outranks(a: Boat, b: Boat): boolean {
    const rank = (q: Boat) =>
      q.state === 'leaving' ? 3 : q.state === 'arriving' ? 2 : q.state === 'approaching' ? 1 : 0;
    return rank(a) !== rank(b) ? rank(a) > rank(b) : a.id < b.id;
  }

  /** The hull pointing the way the boat is going, astern included. */
  private wakeOf(b: Boat): ReturnType<World['hullOf']> {
    const h = this.hullOf(b);
    return b.astern ? { ...h, hx: -h.hx, hy: -h.hy } : h;
  }

  /**
   * Rules of the road. A boat stops for anything lying still in its way (and
   * finds a way round it, see sail) and gives way to boats that outrank it.
   * With right of way it carries on, stopping short only of a collision,
   * while the other one gets out of the way, going astern if need be
   * (`makeWay`). There is always one boat with right of way, so they do not
   * sail through each other; one that is wedged in all the same squeezes
   * past in the end rather than lock up the harbour.
   */
  private giveWay(b: Boat): { speed: number; makeWay: boolean } {
    const me = this.hullOf(b);
    const v = B.VESSELS[b.vessel];
    const look = me.half + 0.6 + ((b.speed ?? 0) / v.speed) * 1.2;
    let speed = 1;
    let makeWay = false;
    // Wedged in for most of a day: a last resort so the harbour never locks
    // up for good. It squeezes past.
    const wedged = (b.squeeze ?? 0) > 0;
    for (const o of this.boats) {
      if (o === b) continue;
      const other = this.hullOf(o);
      const still = o.state === 'moored' || o.state === 'anchored';
      if (wedged) continue;
      const ahead = this.inWay(me, other, look);
      if (ahead !== null) {
        const gap = ahead - me.half;
        // Stop for anything lying still or with right of way; otherwise only
        // short of touching, while the other one gets out of the way.
        const yields = still || this.outranks(o, b);
        const room = yields ? 0.3 : 0.08;
        const ease = yields ? look - me.half - room : 0.5;
        speed = Math.min(speed, clamp((gap - room) / Math.max(0.1, ease), 0, 1));
      }
      // Something with right of way is held up, and this boat is in its way;
      // or a boat backing out of someone's way needs this one to back too.
      if (!still && (this.outranks(o, b) || o.astern) && (o.held ?? 0) > 20) {
        if (this.inWay(this.wakeOf(o), me, other.half + 0.8) !== null) makeWay = true;
      }
    }
    return { speed, makeWay };
  }

  /**
   * How far ahead `other` lies in the path of `me`, within `look` tiles of
   * my centre, or null when it is not in the way.
   */
  private inWay(
    me: ReturnType<World['hullOf']>,
    other: ReturnType<World['hullOf']>,
    look: number,
  ): number | null {
    const rx = other.x - me.x;
    const ry = other.y - me.y;
    const fwd = rx * me.hx + ry * me.hy;
    const side = -rx * me.hy + ry * me.hx;
    // The other hull's reach along my heading and across it.
    const along = Math.abs(other.hx * me.hx + other.hy * me.hy);
    const across = Math.abs(-other.hx * me.hy + other.hy * me.hx);
    const reachFwd = along * other.half + across * other.beam;
    const reachSide = across * other.half + along * other.beam;
    const near = fwd - reachFwd;
    if (fwd <= 0 || near > look) return null;
    if (Math.abs(side) > me.beam + reachSide + 0.12) return null;
    return Math.max(0, near);
  }

  /** Open water, with a wide berth given to boats lying still. */
  private seaWay(b: Boat, strict = false): CostFn {
    const base = this.boatCostFor(b.draft);
    // Strict: every other hull is off limits, moving ones included.
    const still = this.boats
      .filter((o) => o !== b && (strict || o.state === 'moored' || o.state === 'anchored'))
      .map((o) => this.hullOf(o));
    const goal = b.goal;
    return (i) => {
      const c = base(i);
      if (!Number.isFinite(c)) return c;
      const x = (i % this.map.w) + 0.5;
      const y = Math.floor(i / this.map.w) + 0.5;
      for (const h of still) {
        const rx = x - h.x;
        const ry = y - h.y;
        const fwd = Math.abs(rx * h.hx + ry * h.hy);
        const side = Math.abs(-rx * h.hy + ry * h.hx);
        if (fwd < h.half + 0.6 && side < h.beam + 0.8) return i === goal ? c + 25 : Infinity;
      }
      return c;
    };
  }

  /**
   * The stretch of water a berth opens onto: one side of one dock. Boats on
   * different sides, or at different docks, do not get in each other's way.
   */
  private fairwayOf(jetty: number, berth: number): number | undefined {
    this.docks();
    const key = this.dockKey.get(jetty);
    if (key === undefined) return undefined;
    const m = this.map;
    const side =
      m.xOf(berth) > m.xOf(jetty)
        ? 0
        : m.xOf(berth) < m.xOf(jetty)
          ? 1
          : m.yOf(berth) > m.yOf(jetty)
            ? 2
            : 3;
    return key * 4 + side;
  }

  private fairwayFree(b: Boat, jetty: number, berth: number): boolean {
    const key = this.fairwayOf(jetty, berth);
    return key === undefined || !this.boats.some((o) => o !== b && o.fairway === key);
  }

  /** Take the fairway to this boat's berth if no other boat holds it. */
  private takeFairway(b: Boat): boolean {
    if (!this.fairwayFree(b, b.jetty, b.berth)) return false;
    b.fairway = this.fairwayOf(b.jetty, b.berth);
    return true;
  }

  private freeFairway(b: Boat): void {
    b.fairway = undefined;
    b.castOff = undefined;
    b.castDock = undefined;
  }

  private depart(b: Boat, gaveUp: boolean): void {
    this.judgeVisit(b, gaveUp);
    if (b.state === 'moored') {
      b.castOff = b.berth;
      b.castDock = b.jetty;
      b.undock = 1;
    } else this.freeFairway(b);
    b.state = 'leaving';
    b.berth = b.jetty = -1;
    const edge = this.seaEdgeTiles();
    const from = this.tileOf(b);
    const exit = edge.reduce(
      (best, i) =>
        Math.abs(this.map.yOf(i) - this.map.yOf(from)) <
        Math.abs(this.map.yOf(best) - this.map.yOf(from))
          ? i
          : best,
      edge[0],
    );
    b.goal = exit;
    b.path = findPath(this.map.w, this.map.h, from, exit, this.seaWay(b), true) ?? [];
    b.best = Infinity;
  }

  // ── Dockhands and forklifts ───────────────────────────────

  private spawnDockhand(at: number, c: Candidate): Dockhand {
    const p: Dockhand = {
      id: this.nextId++,
      kind: 'dockhand',
      name: c.name,
      skill: c.skill,
      trait: c.trait,
      wage: c.wage,
      energy: 100,
      morale: B.START_MORALE,
      hutIdx: -1,
      lowMoraleDays: 0,
      raiseAsk: 0,
      capacity: 1,
      needsRepair: false,
      home: -1,
      fuel: 100,
      depotTask: null,
      blocked: 0,
      squeeze: false,
      x: this.map.xOf(at) + 0.5,
      y: this.map.yOf(at) + 0.5,
      dir: 0,
      path: [],
      goal: at,
      state: 'idle',
      timer: 0,
      carrying: 0,
      cargoFees: [],
      planned: 0,
      boatId: -1,
      craneIdx: -1,
      bayIdx: -1,
    };
    this.people.push(p);
    return p;
  }

  private depotRoom(depot: number): number {
    return B.DEPOT_SLOTS - this.people.filter((q) => q.home === depot).length;
  }

  /** Buy a forklift at a depot: the one at `tile`, or any with room. */
  private buyMachine(kind: MachineKind, tile?: number): void {
    if (this.tier < MACHINE_TIER[kind]) {
      return this.message(
        `${MACHINES[kind].label}s unlock at the ${TIERS[MACHINE_TIER[kind]].name}.`,
        'bad',
      );
    }
    let depot = tile ?? -1;
    if (tile === undefined) {
      for (let i = 0; i < this.map.build.length && depot < 0; i++) {
        if (this.map.build[i] === Build.Depot && this.depotRoom(i) > 0) depot = i;
      }
      if (depot < 0)
        return this.message('Build a forklift depot first. Forklifts live there.', 'bad');
    } else {
      const err =
        tile >= 0 && tile < this.map.build.length
          ? machinePlacementError(this.map, tile)
          : 'Off the map';
      if (err) return this.message(err, 'bad');
    }
    if (this.depotRoom(depot) <= 0) {
      return this.message(`That depot is full. Each houses ${B.DEPOT_SLOTS} forklifts.`, 'bad');
    }
    const spec = MACHINES[kind];
    if (this.cash < spec.price) return this.message('Not enough money', 'bad');
    this.book('construction', -spec.price);
    const p = this.spawnDockhand(depot, {
      id: 0,
      name: `${spec.label} ${this.people.filter((q) => q.kind === kind).length + 1}`,
      skill: 3,
      trait: null,
      wage: spec.wage,
    });
    p.kind = kind;
    p.capacity = spec.capacity;
    p.home = depot;
    this.moneyAt(-spec.price, depot);
    this.message(`A new ${spec.label.toLowerCase()} is ready at the depot.`, 'good');
  }

  /** Send a forklift home for fuel, repairs or to park. False if it cannot get there. */
  private goToDepot(p: Dockhand, task: 'refuel' | 'repair' | 'park'): boolean {
    if (p.home < 0 || this.map.build[p.home] !== Build.Depot) p.home = this.findDepot(p);
    if (p.home < 0 || !this.headTo(p, p.home)) return false;
    p.depotTask = task;
    p.state = 'toDepot';
    return true;
  }

  /** A depot with room this forklift can reach, for one whose home is gone. */
  private findDepot(p: Dockhand): number {
    for (let i = 0; i < this.map.build.length; i++) {
      if (this.map.build[i] !== Build.Depot || this.depotRoom(i) <= 0) continue;
      if (this.pathFor(p, this.tileOf(p), i)) return i;
    }
    return -1;
  }

  private updateForkliftAtRest(p: Dockhand): boolean {
    if (p.needsRepair) {
      p.needsRepair = false;
      p.path = [];
      if (this.goToDepot(p, 'repair')) {
        this.message(`${p.name} is limping back to the depot for repairs.`, 'info');
        return true;
      }
      // No depot to reach: a mechanic comes out, at double the price.
      this.startRepair(p, B.REPAIR_COST * 2);
      this.message(`${p.name} has broken down with no depot to reach. Mechanic called out.`, 'bad');
      return true;
    }
    if (p.fuel < B.LOW_FUEL && this.goToDepot(p, 'refuel')) return true;
    return false;
  }

  private startRepair(p: Dockhand, cost: number): void {
    p.state = 'broken';
    p.timer = B.REPAIR_TICKS;
    this.book('maintenance', -cost);
    this.moneyAt(-cost, this.tileOf(p));
  }

  /** Dockhands stay on the port: paths, jetties, quays and port buildings. */
  private walkCost: CostFn = (i) => (walkableAt(this.map, i) ? 1 : Infinity);

  /** Forklifts need a hard surface; wooden jetties cannot take the weight. */
  private driveCost: CostFn = (i) => (drivable(this.map.build[i]) ? 1 : Infinity);

  private costFor(p: Dockhand): CostFn {
    return isMachine(p) ? this.driveCost : this.walkCost;
  }

  private walkSpeed = () => B.WALK_SPEED;

  /** Where new staff report for work and lost staff are taken back to. */
  private muster(): number {
    const bay = [...this.bays.keys()].find((b) => isBay(this.map.build[b]));
    if (bay !== undefined) return bay;
    for (let i = 0; i < this.map.build.length; i++) if (walkableAt(this.map, i)) return i;
    return this.map.entry;
  }

  /**
   * Someone standing where they no longer may (the path under them was
   * bulldozed, or an old save had them on the grass) is taken back to the
   * truck bay, or a forklift to its depot.
   */
  private rescue(p: Dockhand): boolean {
    if (Number.isFinite(this.costFor(p)(this.tileOf(p)))) return false;
    const at = isMachine(p) && p.home >= 0 ? p.home : this.muster();
    p.x = this.map.xOf(at) + 0.5;
    p.y = this.map.yOf(at) + 0.5;
    p.path = [];
    return true;
  }

  private walk(p: Dockhand) {
    const before = this.tileOf(p);
    const laneBefore = laneOf(p.dir);
    const enter = (i: number) => p.squeeze || this.laneFree(i, laneOf(this.headingTo(p, i)));
    let r: ReturnType<World['move']>;
    if (isMachine(p)) {
      // An empty tank still crawls home on the reserve.
      const top = p.kind === 'stacker' ? B.STACKER_SPEED : B.FORKLIFT_SPEED;
      const speed = p.fuel > 0 ? top : top * 0.3;
      r = this.move(p, this.driveCost, true, () => speed, enter);
    } else {
      const pace = paceFactor(p.skill, p.morale, p.energy);
      r = this.move(p, this.walkCost, true, () => this.walkSpeed() * pace, enter);
    }
    const after = this.tileOf(p);
    const laneAfter = laneOf(p.dir);
    if (isMachine(p) && (r === 'moving' || r === 'arrived')) {
      p.fuel = Math.max(0, p.fuel - B.FUEL_PER_TICK);
    }
    if (after !== before || laneAfter !== laneBefore) {
      const old = before * 4 + laneBefore;
      this.occupancy[old] = Math.max(0, this.occupancy[old] - 1);
      this.occupancy[after * 4 + laneAfter]++;
    }
    if (after !== before) {
      p.squeeze = false;
      // Only real progress clears the wait; shuffling within a tile does not.
      p.blocked = 0;
    }
    // Congestion is measured on working trips only, not strolls or breaks.
    const working = WORKING.has(p.state);
    if (r === 'waiting') {
      p.blocked++;
      if (working) this.jam.waiting++;
      this.resolveJam(p);
    } else if (r === 'moving') {
      if (working) this.jam.moving++;
    } else {
      p.blocked = 0;
    }
    return r;
  }

  // ── Crowding ──────────────────────────────────────────────
  //
  // Each tile has a lane per direction of travel. Workers keep to the right,
  // so people going opposite ways pass each other, but nobody overtakes
  // someone heading the same way: queues form behind whoever is in front.

  /** How many workers fit in one lane of a tile. */
  private laneCap(i: number): number {
    const b = this.map.build[i];
    return isBay(b) || b === Build.BreakHut || b === Build.Depot ? B.GATHER_CAP : 1;
  }

  private laneFree(i: number, lane: number): boolean {
    return this.occupancy[i * 4 + lane] < this.laneCap(i);
  }

  /** Any lane of the tile in use at all. */
  private tileBusy(i: number): boolean {
    const o = this.occupancy;
    return o[i * 4] + o[i * 4 + 1] + o[i * 4 + 2] + o[i * 4 + 3] >= this.laneCap(i);
  }

  private headingTo(a: Agent, i: number): number {
    return Math.atan2(this.map.yOf(i) + 0.5 - a.y, this.map.xOf(i) + 0.5 - a.x);
  }

  /** Resting workers sit out of the way, so they do not count. */
  private takesSpace(p: Dockhand): boolean {
    // Resting and idle people stand aside on their tile, so others can pass.
    return p.state !== 'resting' && !(p.state === 'idle' && p.path.length === 0);
  }

  private countOccupancy(): void {
    this.occupancy.fill(0);
    for (const p of this.people) {
      if (this.takesSpace(p)) this.occupancy[this.tileOf(p) * 4 + laneOf(p.dir)]++;
    }
  }

  /**
   * Someone ahead is going the same way and has stopped (lifting a crate, or
   * queueing themselves). Wait, then try stepping aside, then a route around
   * the crowd, and finally squeeze past so nobody is stuck for good.
   */
  private resolveJam(p: Dockhand): void {
    if (p.blocked === B.SIDESTEP_AFTER) this.sidestep(p);
    else if (p.blocked === B.REROUTE_AFTER) this.reroute(p);
    else if (p.blocked >= B.SQUEEZE_AFTER) p.squeeze = true;
  }

  private sidestep(p: Dockhand): void {
    const cost = this.costFor(p);
    const m = this.map;
    const here = this.tileOf(p);
    const ahead = p.path[0];
    // Only step sideways: never onto the tile ahead or back the way we came.
    const dx = Math.sign(m.xOf(ahead) - m.xOf(here));
    const dy = Math.sign(m.yOf(ahead) - m.yOf(here));
    const behind = m.inBounds(m.xOf(here) - dx, m.yOf(here) - dy)
      ? m.idx(m.xOf(here) - dx, m.yOf(here) - dy)
      : -1;
    let best = -1;
    let bestD = Infinity;
    for (const n of m.neighbors4(here)) {
      if (n === ahead || n === behind || !Number.isFinite(cost(n))) continue;
      if (!this.laneFree(n, laneOf(this.headingTo(p, n)))) continue;
      const d = this.dist(n, p.goal);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    if (best < 0) return;
    const onward = this.pathFor(p, best, p.goal);
    if (!onward) return;
    p.path = [best, ...onward];
  }

  private reroute(p: Dockhand): void {
    const base = this.costFor(p);
    const crowded: CostFn = (i) => base(i) + (this.tileBusy(i) ? 6 : 0);
    const path = findPath(this.map.w, this.map.h, this.tileOf(p), p.goal, crowded, true);
    if (path) p.path = path;
  }

  private handlingTicks(p: Dockhand, base: number): number {
    if (p.kind === 'stacker') return Math.round(base * 2.5);
    if (p.kind === 'forklift') return Math.round(base * 1.5);
    return Math.max(1, Math.round(base * traitDef(p.trait).handling));
  }

  private changeMorale(p: Dockhand, delta: number): void {
    if (isMachine(p)) return;
    const scaled = delta < 0 ? delta * traitDef(p.trait).moraleLoss : delta;
    p.morale = Math.max(0, Math.min(100, p.morale + scaled));
  }

  /** Energy use; returns true if the dockhand should head off for a break now. */
  private tire(p: Dockhand): boolean {
    if (isMachine(p)) return false;
    if (p.state === 'resting' || p.state === 'toBreak') return false;
    const drain = WORKING.has(p.state) ? B.WORK_DRAIN * traitDef(p.trait).drain : B.IDLE_DRAIN;
    const before = p.energy;
    p.energy = Math.max(0, p.energy - drain);
    if (before > 0 && p.energy === 0) this.changeMorale(p, B.MORALE_EXHAUSTED);
    // Only stop between jobs, never with a crate in hand.
    return p.energy < B.TIRED_ENERGY && (p.state === 'idle' || p.state === 'wander');
  }

  private hutOccupancy(hut: number): number {
    return this.people.filter((q) => q.hutIdx === hut).length;
  }

  private goOnBreak(p: Dockhand): void {
    p.path = [];
    const here = this.tileOf(p);
    const huts: number[] = [];
    for (let i = 0; i < this.map.build.length; i++) {
      if (this.map.build[i] === Build.BreakHut && this.hutOccupancy(i) < B.HUT_SLOTS) huts.push(i);
    }
    huts.sort((a, b) => this.dist(here, a) - this.dist(here, b));
    for (const hut of huts) {
      if (this.headTo(p, hut)) {
        p.hutIdx = hut;
        p.state = 'toBreak';
        return;
      }
    }
    // Nowhere to go: sit down on the spot. Slow, and bad for morale.
    p.hutIdx = -1;
    p.state = 'resting';
    this.changeMorale(p, B.MORALE_FLOOR_BREAK);
  }

  /** Spread people resting at a hut along its front. */
  private seatAtHut(p: Dockhand): void {
    const seat = this.people.filter((q) => q.hutIdx === p.hutIdx && q !== p).length;
    p.x = this.map.xOf(p.hutIdx) + 0.25 + (seat % B.HUT_SLOTS) * 0.25;
    p.y = this.map.yOf(p.hutIdx) + 0.82;
    p.dir = Math.PI / 2;
  }

  private pathFor(p: Dockhand, from: number, goal: number): number[] | null {
    return findPath(this.map.w, this.map.h, from, goal, this.costFor(p), true);
  }

  private updateDockhand(p: Dockhand): void {
    if ((p.state === 'idle' || p.state === 'wander') && this.rescue(p)) return;
    if (this.tire(p)) return this.goOnBreak(p);
    switch (p.state) {
      case 'broken':
        if (--p.timer <= 0) {
          p.state = 'idle';
          this.message(`${p.name} is repaired and back at work.`, 'info');
        }
        return;
      case 'toBreak': {
        if (this.map.build[p.hutIdx] !== Build.BreakHut) return this.goOnBreak(p);
        const r = this.walk(p);
        if (r === 'blocked') return this.goOnBreak(p);
        if (r === 'arrived') {
          this.seatAtHut(p);
          p.state = 'resting';
        }
        return;
      }
      case 'resting': {
        const inHut = p.hutIdx >= 0 && this.map.build[p.hutIdx] === Build.BreakHut;
        p.energy = Math.min(100, p.energy + (inHut ? B.HUT_REST : B.FLOOR_REST));
        if (p.energy >= 100) {
          if (inHut) this.changeMorale(p, B.MORALE_HUT_BREAK);
          p.hutIdx = -1;
          p.state = 'idle';
        }
        return;
      }
      case 'toDepot': {
        const r = this.walk(p);
        if (r === 'blocked' || this.map.build[p.home] !== Build.Depot) {
          p.state = 'idle';
          return;
        }
        if (r !== 'arrived') return;
        const task = p.depotTask;
        p.depotTask = null;
        if (task === 'repair') this.startRepair(p, B.REPAIR_COST);
        else if (task === 'refuel') p.state = 'refuelling';
        else p.state = 'idle';
        return;
      }
      case 'refuelling': {
        const add = Math.min(B.REFUEL_PER_TICK, 100 - p.fuel);
        p.fuel += add;
        this.book('maintenance', -(add / 100) * B.FUEL_COST);
        if (p.fuel >= 100) p.state = 'idle';
        return;
      }
      case 'idle':
      case 'wander': {
        if (isMachine(p) && this.updateForkliftAtRest(p)) return;
        if ((this.tick + p.id) % 5 === 0 && this.assignJob(p)) {
          p.stuck = null;
          return;
        }
        if (isMachine(p) && (this.tick + p.id) % 100 === 0) this.diagnose(p);
        // Idle forklifts go home to park instead of blocking the quay.
        if (isMachine(p) && p.state === 'idle') {
          p.timer++;
          if (p.timer > B.PARK_AFTER && this.tileOf(p) !== p.home) {
            p.timer = 0;
            this.goToDepot(p, 'park');
          }
          return;
        }
        if (p.state === 'wander') {
          const r = this.walk(p);
          if (r === 'arrived' || r === 'blocked') p.state = 'idle';
        } else if (p.kind === 'dockhand' && this.rng.next() < 0.008) {
          this.wander(p);
        }
        return;
      }
      case 'toPickup': {
        if (!this.sourceValid(p)) return this.cancelJob(p);
        const r = this.walk(p);
        if (r === 'blocked') return this.cancelJob(p);
        if (r === 'arrived') {
          p.state = 'picking';
          p.timer = this.handlingTicks(p, B.PICK_TICKS);
        }
        return;
      }
      case 'picking': {
        if (--p.timer > 0) return;
        const fees = this.takeFromSource(p);
        if (fees.length === 0) return this.cancelJob(p);
        // Fewer than planned: hand back the spare room in the bay.
        const bay = this.dest(p.bayIdx);
        if (bay) bayIncoming(bay, p.kind === 'stacker', -(p.planned - fees.length));
        p.planned = fees.length;
        p.carrying = fees.length;
        p.cargoFees = fees;
        if (!bay || !this.headTo(p, p.bayIdx)) this.retargetCrate(p);
        else p.state = 'toDrop';
        return;
      }
      case 'toDrop': {
        if (!this.dest(p.bayIdx)) return this.retargetCrate(p);
        const r = this.walk(p);
        if (r === 'blocked') return this.retargetCrate(p);
        if (r === 'arrived') {
          p.state = 'dropping';
          p.timer = this.handlingTicks(p, B.DROP_TICKS);
        }
        return;
      }
      case 'dropping': {
        if (--p.timer > 0) return;
        const bay = this.dest(p.bayIdx);
        if (!bay) return this.retargetCrate(p);
        const boxy = p.kind === 'stacker';
        (boxy ? bay.boxes : bay.crates).push(...p.cargoFees);
        bayIncoming(bay, boxy, -p.planned);
        if (boxy) this.stats.containers += p.carrying;
        else this.stats.cratesHandled += p.carrying;
        p.carrying = 0;
        p.cargoFees = [];
        p.planned = 0;
        p.bayIdx = -1;
        p.state = 'idle';
        return;
      }
    }
  }

  private headTo(p: Dockhand, goal: number): boolean {
    const path = this.pathFor(p, this.tileOf(p), goal);
    if (!path) return false;
    p.path = path;
    p.goal = goal;
    return true;
  }

  /**
   * An idle machine works out whether it is cut off: from every truck bay,
   * or from cargo that is waiting. Forklifts only drive on port roads,
   * forklift lanes and quays, which is easy to miss.
   */
  private diagnose(p: Dockhand): void {
    const here = this.tileOf(p);
    const boxy = p.kind === 'stacker';
    const what = boxy ? 'Reach stackers' : 'Forklifts';
    const reach = (goal: number) => !!this.pathFor(p, here, goal);
    const sources: number[] = [];
    for (const c of this.cranes.values()) {
      if ((c.kind === 'harbour') === boxy && c.stack.length > 0) sources.push(c.idx);
    }
    if (!boxy) {
      for (const b of this.boats) {
        // Fishing boats at a jetty are the dockhands' job; pallets are not.
        if (b.state === 'moored' && b.vessel === 'coaster' && b.crates > 0) {
          sources.push(...this.pickupSpots(b));
        }
      }
    }
    let stuck: string | null = null;
    if (![...this.bays.keys()].some(reach)) {
      stuck = `Can't reach a truck bay. ${what} only drive on port roads, forklift lanes and quays`;
    } else if (sources.length > 0 && !sources.some(reach)) {
      stuck = boxy
        ? "Can't reach the harbour crane. Connect it with quay or port roads"
        : "Can't reach the cargo. Forklifts can't drive on wooden jetties or port paths: use quays and port roads";
    }
    p.stuck = stuck;
    if (stuck && !this.warnedStuck) {
      this.warnedStuck = true;
      this.message(`${p.name}: ${stuck}.`, 'bad');
    }
  }

  private wander(p: Dockhand): void {
    const x = Math.floor(p.x) + this.rng.int(-3, 3);
    const y = Math.floor(p.y) + this.rng.int(-3, 3);
    if (!this.map.inBounds(x, y)) return;
    const i = this.map.idx(x, y);
    if (!Number.isFinite(this.walkCost(i))) return;
    const path = this.pathFor(p, this.tileOf(p), i);
    if (path && path.length <= 8) {
      p.path = path;
      p.goal = i;
      p.state = 'wander';
    }
  }

  /** Crane landing stacks first (they free the crane), then moored boats. */
  private assignJob(p: Dockhand): boolean {
    const here = this.tileOf(p);
    const cost = this.costFor(p);
    const sources: { tile: number; avail: number; boat?: Boat; crane?: Crane }[] = [];
    // Reach stackers handle containers, everyone else crates.
    const boxy = p.kind === 'stacker';
    // Pallets off a coaster need the forks of a forklift.
    const forks = p.kind === 'forklift';
    for (const crane of this.cranes.values()) {
      if ((crane.kind === 'harbour') !== boxy) continue;
      if (crane.pallets && crane.stack.length > 0 && !forks) continue;
      const avail = crane.stack.length - crane.reserved;
      if (avail > 0) sources.push({ tile: crane.idx, avail, crane });
    }
    const craneCount = sources.length;
    for (const boat of this.boats) {
      const avail = boat.crates - boat.reserved;
      // Containers only come off a ship by crane.
      if (boxy || boat.vessel === 'feeder') continue;
      if (boat.vessel === 'coaster' && !forks) continue;
      if (boat.state !== 'moored' || avail <= 0) continue;
      // Workers can load from any dock tile alongside the boat.
      for (const tile of this.pickupSpots(boat)) sources.push({ tile, avail, boat });
    }
    const byDist = (a: { tile: number }, b: { tile: number }) =>
      this.dist(here, a.tile) - this.dist(here, b.tile);
    const ordered = [
      ...sources.slice(0, craneCount).sort(byDist),
      ...sources.slice(craneCount).sort(byDist),
    ];

    for (const src of ordered) {
      if (!Number.isFinite(cost(src.tile))) continue;
      // The foreman sends no more than two to the same spot; the rest wait.
      if (this.workersAt(src.tile) >= B.WORKERS_PER_SPOT) continue;
      // Containers go to a container yard, crates to a truck bay.
      const bay = boxy ? this.yardWithRoom(p, src.tile) : this.bayWithRoom(p, src.tile);
      if (!bay) continue;
      if (!this.headTo(p, src.tile)) continue;
      const planned = Math.min(p.capacity, src.avail, bayRoom(bay, boxy));
      if (src.crane) src.crane.reserved += planned;
      if (src.boat) src.boat.reserved += planned;
      bayIncoming(bay, boxy, planned);
      p.planned = planned;
      p.boatId = src.boat ? src.boat.id : -1;
      p.craneIdx = src.crane ? src.crane.idx : -1;
      p.bayIdx = bay.idx;
      p.state = 'toPickup';
      return true;
    }
    return false;
  }

  /** Dock tiles beside a moored boat's hull. */
  private pickupSpots(b: Boat): number[] {
    const fp = this.footprint(b.berth, b.jetty, this.boatHalf(b.vessel === 'feeder')) ?? [b.berth];
    const spots = new Set<number>([b.jetty]);
    for (const t of fp) {
      for (const n of this.map.neighbors4(t)) if (isDock(this.map.build[n])) spots.add(n);
    }
    return [...spots];
  }

  private workersAt(tile: number): number {
    let n = 0;
    for (const q of this.people) {
      if (q.goal === tile && (q.state === 'toPickup' || q.state === 'picking')) n++;
    }
    return n;
  }

  private sourceValid(p: Dockhand): boolean {
    if (p.craneIdx >= 0) return this.cranes.has(p.craneIdx);
    const boat = this.boats.find((b) => b.id === p.boatId);
    return !!boat && boat.state === 'moored';
  }

  /** Lift up to the planned number of crates; returns their fees. */
  private takeFromSource(p: Dockhand): number[] {
    if (p.craneIdx >= 0) {
      const crane = this.cranes.get(p.craneIdx);
      p.craneIdx = -1;
      if (!crane) return [];
      crane.reserved = Math.max(0, crane.reserved - p.planned);
      return crane.stack.splice(0, Math.min(p.planned, crane.stack.length));
    }
    const boat = this.boats.find((b) => b.id === p.boatId);
    p.boatId = -1;
    if (!boat) return [];
    boat.reserved = Math.max(0, boat.reserved - p.planned);
    const n = Math.min(p.planned, boat.crates);
    boat.crates -= n;
    return Array.from({ length: n }, () => boat.fee);
  }

  /** Nearest truck bay with room that this worker can reach from `from`. */
  private bayWithRoom(p: Dockhand, from: number): Bay | null {
    const boxy = p.kind === 'stacker';
    const bays = [...this.bays.values()]
      .filter((b) => bayRoom(b, boxy) > 0)
      .sort((a, b) => this.dist(from, a.idx) - this.dist(from, b.idx));
    for (const bay of bays) {
      if (this.pathFor(p, from, bay.idx)) return bay;
    }
    return null;
  }

  /** Nearest container yard with room this stacker can reach from `from`. */
  private yardWithRoom(p: Dockhand, from: number): Bay | null {
    const yards = [...this.yards.values()]
      .filter((y) => bayRoom(y, true) > 0)
      .sort((a, b) => this.dist(from, a.idx) - this.dist(from, b.idx));
    for (const yard of yards) {
      if (this.pathFor(p, from, yard.idx)) return yard;
    }
    return null;
  }

  /** The truck bay or container yard a load is going to. */
  private dest(idx: number): Bay | undefined {
    return this.bays.get(idx) ?? this.yards.get(idx);
  }

  /** The worker holds crates but their bay is gone or unreachable. */
  private retargetCrate(p: Dockhand): void {
    const boxy = p.kind === 'stacker';
    const old = this.dest(p.bayIdx);
    if (old) bayIncoming(old, boxy, -p.planned);
    const here = this.tileOf(p);
    const bay = boxy ? this.yardWithRoom(p, here) : this.bayWithRoom(p, here);
    if (bay && this.headTo(p, bay.idx)) {
      bayIncoming(bay, boxy, p.planned);
      p.bayIdx = bay.idx;
      p.state = 'toDrop';
      return;
    }
    this.message(`${p.name} had nowhere to take their load and put it down.`, 'bad');
    p.carrying = 0;
    p.cargoFees = [];
    p.planned = 0;
    p.bayIdx = -1;
    p.path = [];
    p.state = 'idle';
  }

  private cancelJob(p: Dockhand): void {
    if (!p.carrying) {
      const boat = this.boats.find((b) => b.id === p.boatId);
      if (boat) boat.reserved = Math.max(0, boat.reserved - p.planned);
      const crane = this.cranes.get(p.craneIdx);
      if (crane) crane.reserved = Math.max(0, crane.reserved - p.planned);
    }
    const bay = this.dest(p.bayIdx);
    if (bay) bayIncoming(bay, p.kind === 'stacker', -p.planned);
    p.boatId = -1;
    p.craneIdx = -1;
    p.bayIdx = -1;
    p.hutIdx = -1;
    p.carrying = 0;
    p.cargoFees = [];
    p.planned = 0;
    p.path = [];
    p.state = 'idle';
  }

  // ── Jib cranes ────────────────────────────────────────────

  private addCrane(i: number, kind: Crane['kind']): void {
    this.cranes.set(i, { idx: i, kind, stack: [], reserved: 0, timer: 0, angle: 0, busy: false });
  }

  /** Swing crates from a boat moored beside the crane onto its landing stack. */
  private updateCrane(c: Crane): void {
    c.busy = false;
    const harbour = c.kind === 'harbour';
    if (c.stack.length >= (harbour ? B.HARBOUR_CRANE_STACK : B.CRANE_STACK)) return;
    const m = this.map;
    const boat = this.boats.find(
      (b) =>
        b.state === 'moored' &&
        (b.vessel === 'feeder') === harbour &&
        // One kind on the landing stack at a time: crates or pallets.
        (c.stack.length === 0 || (b.vessel === 'coaster') === !!c.pallets) &&
        b.crates - b.reserved > 0 &&
        Math.max(
          Math.abs(m.xOf(b.berth) - m.xOf(c.idx)),
          Math.abs(m.yOf(b.berth) - m.yOf(c.idx)),
        ) <= 1,
    );
    if (!boat) return;
    c.busy = true;
    c.angle = Math.atan2(boat.y - (m.yOf(c.idx) + 0.5), boat.x - (m.xOf(c.idx) + 0.5));
    if (++c.timer < (harbour ? B.HARBOUR_CRANE_TICKS : B.CRANE_TICKS)) return;
    c.timer = 0;
    boat.crates--;
    c.pallets = boat.vessel === 'coaster';
    c.stack.push(boat.fee);
  }

  // ── Trucks and bays ───────────────────────────────────────

  private addBay(i: number): void {
    const warehouse = this.map.build[i] === Build.Warehouse;
    this.bays.set(i, {
      idx: i,
      large: warehouse || this.map.build[i] === Build.LargeBay,
      warehouse,
      boxes: [],
      boxIncoming: 0,
      crates: [],
      incoming: 0,
      nextTruckTick: 0,
      noAccess: false,
    });
  }

  private addYard(i: number): void {
    this.yards.set(i, {
      idx: i,
      large: false,
      yard: true,
      boxes: [],
      boxIncoming: 0,
      crates: [],
      incoming: 0,
      nextTruckTick: 0,
      noAccess: false,
    });
  }

  /** Where trucks stand to load: one spot, or a warehouse's two docks. */
  private loadingDocks(bay: Bay): number[] {
    if (!bay.warehouse) return [bay.idx];
    const tiles = footprint(this.map, 'warehouse', bay.idx, this.map.orient[bay.idx]);
    return tiles.slice(0, B.WAREHOUSE_DOCKS);
  }

  /** A dock at this bay no truck is using or heading for, or -1. */
  private freeDock(bay: Bay): number {
    const taken = new Set(
      this.trucks.filter((t) => t.bayIdx === bay.idx && t.state !== 'leaving').map((t) => t.goal),
    );
    return this.loadingDocks(bay).find((d) => !taken.has(d)) ?? -1;
  }

  private removeYard(i: number): void {
    const yard = this.yards.get(i);
    if (yard && yard.boxes.length > 0) {
      this.message(`${yard.boxes.length} containers were lost with the container yard.`, 'bad');
    }
    this.yards.delete(i);
  }

  private removeBay(i: number): void {
    const bay = this.bays.get(i);
    if (bay && bay.crates.length + bay.boxes.length > 0) {
      this.message(
        `${bay.crates.length} crates and ${bay.boxes.length} containers were lost with the truck bay.`,
        'bad',
      );
    }
    this.bays.delete(i);
  }

  /**
   * Trucks drive on public roads, and on port roads once they are through a
   * port gate: never straight from one to the other. A truck bay or container
   * yard is only enterable as the destination, or the one being left, from
   * any side of it that touches a road.
   */
  private truckCost(target: number, home = -1): CostFn {
    const m = this.map;
    const way = (i: number): 'road' | 'port' | 'gate' | null => {
      const b = m.build[i];
      if (b === Build.Road) return 'road';
      if (b === Build.PortRoad) return forkliftOnly(m, i) ? null : 'port';
      if (b === Build.Gate) return 'gate';
      const a = anchorOf(m, i);
      return a === target || a === home ? 'gate' : null;
    };
    return (i, from) => {
      const here = way(i);
      if (!here) return Infinity;
      const there = from === undefined || from < 0 ? null : way(from);
      const jump = (here === 'road' && there === 'port') || (here === 'port' && there === 'road');
      return jump ? Infinity : 1;
    };
  }

  private spawnTrucks(): void {
    const m = this.map;
    const hauliers = this.hauliers();
    const out = new Map<number, number>();
    for (const t of this.trucks) out.set(t.contractId, (out.get(t.contractId) ?? 0) + 1);
    // Fullest bays get trucks first. Container trucks collect from the yards,
    // and from large bays still holding containers from older saves.
    const load = (b: Bay) =>
      b.crates.length / bayCap(b) + b.boxes.length / (b.yard ? B.YARD_BOXES : B.TRUCK_CAPACITY);
    const bays = [...this.bays.values(), ...this.yards.values()]
      .filter(
        (b) =>
          b.crates.length + b.boxes.length > 0 &&
          this.tick >= b.nextTruckTick &&
          this.freeDock(b) >= 0,
      )
      .sort((a, b) => load(b) - load(a) || a.idx - b.idx);

    for (const bay of this.bays.values()) {
      if (bay.crates.length >= bayCap(bay)) this.bayFullTicks += 10;
    }
    for (const bay of bays) {
      // Container trucks collect containers; big trucks only fit a large bay.
      const free = (h: (typeof hauliers)[number]) => (out.get(h.id) ?? 0) < h.terms.fleet;
      const haulier =
        (bay.boxes.length > 0
          ? hauliers.find((h) => free(h) && h.terms.cargo === 'container')
          : undefined) ??
        (bay.crates.length > 0
          ? hauliers.find(
              (h) =>
                free(h) && !h.terms.cargo && (bay.large || h.terms.capacity <= B.TRUCK_CAPACITY),
            )
          : undefined);
      if (!haulier) {
        const stuck = hauliers.some(
          (h) => h.terms.capacity > B.TRUCK_CAPACITY && (out.get(h.id) ?? 0) < h.terms.fleet,
        );
        if (stuck && !this.warnedBigTrucks && ![...this.bays.values()].some((b) => b.large)) {
          this.warnedBigTrucks = true;
          this.message('Big trucks need a large truck bay. Build one so they can collect.', 'bad');
        }
        const boxTrucks = hauliers.some((h) => h.terms.cargo === 'container');
        if (bay.yard && !boxTrucks && !this.warnedBoxTrucks) {
          this.warnedBoxTrucks = true;
          this.message('Containers are piling up in the yard. Sign a container haulier.', 'bad');
        }
        continue;
      }
      const dock = this.freeDock(bay);
      const path = findPath(m.w, m.h, m.entry, dock, this.truckCost(bay.idx), false);
      if (!path) {
        if (!bay.noAccess) {
          this.message(
            `Trucks cannot reach a ${bay.yard ? 'container yard' : 'truck bay'}: it needs a public road to the highway, or port roads from a port gate.`,
            'bad',
          );
        }
        bay.noAccess = true;
        bay.nextTruckTick = this.tick + 100;
        continue;
      }
      bay.noAccess = false;
      out.set(haulier.id, (out.get(haulier.id) ?? 0) + 1);
      const truck: Truck = {
        id: this.nextId++,
        contractId: haulier.id,
        company: haulier.terms.name,
        capacity: haulier.terms.capacity,
        x: m.xOf(m.entry) + 0.5,
        y: m.yOf(m.entry) + 0.5,
        dir: 0,
        path,
        goal: dock,
        state: 'toBay',
        bayIdx: bay.idx,
        cargo: 0,
        value: 0,
        boxes: haulier.terms.cargo === 'container',
        idle: 0,
        timer: 0,
        variant: haulier.terms.color,
      };
      this.trucks.push(truck);
    }
  }

  private updateTruck(t: Truck): void {
    const bay = this.dest(t.bayIdx);
    switch (t.state) {
      case 'toBay': {
        if (!bay) return this.truckLeave(t);
        const r = this.move(t, this.truckCost(t.bayIdx), false, () => B.TRUCK_SPEED);
        if (r === 'blocked') return this.removeTruck(t);
        if (r === 'arrived') t.state = 'loading';
        return;
      }
      case 'loading': {
        if (!bay) return this.truckLeave(t);
        const every = loadTicks(bay);
        if (++t.timer % every !== 0) return;
        const stock = t.boxes ? bay.boxes : bay.crates;
        if (stock.length > 0 && t.cargo < t.capacity) {
          t.value += stock.shift()!;
          t.cargo++;
          t.idle = 0;
        } else {
          t.idle += every;
        }
        const full = t.cargo >= t.capacity;
        const bored = t.cargo > 0 ? t.idle >= B.TRUCK_PATIENCE : t.idle >= B.TRUCK_GIVE_UP;
        if (full || bored) this.truckLeave(t);
        return;
      }
      case 'leaving':
        const cost = this.truckCost(this.map.entry, t.bayIdx);
        if (this.move(t, cost, false, () => B.TRUCK_SPEED) !== 'moving') {
          this.removeTruck(t);
        }
        return;
    }
  }

  private truckLeave(t: Truck): void {
    const bay = this.dest(t.bayIdx);
    if (bay) bay.nextTruckTick = this.tick + 30;
    if (t.cargo > 0) {
      const income = t.value;
      this.book('cargo', income);
      this.stats.earned += income;
      this.stats.trucks++;
      this.moneyAt(income, this.tileOf(t));
    }
    t.state = 'leaving';
    t.goal = this.map.entry;
    const path = findPath(
      this.map.w,
      this.map.h,
      this.tileOf(t),
      this.map.entry,
      this.truckCost(this.map.entry, t.bayIdx),
      false,
    );
    if (path) t.path = path;
    else this.removeTruck(t);
  }

  private removeTruck(t: Truck): void {
    this.trucks = this.trucks.filter((q) => q !== t);
  }

  // ── Movement ──────────────────────────────────────────────

  /** Advance an agent along its path, repathing if the next tile became blocked. */
  private move(
    a: Agent,
    cost: CostFn,
    diagonal: boolean,
    speedAt: (i: number) => number,
    canEnter?: (i: number) => boolean,
  ): 'moving' | 'arrived' | 'blocked' | 'waiting' {
    const w = this.map.w;
    let budget = speedAt(this.tileOf(a));
    let repaths = 0;
    while (budget > 1e-6 && a.path.length > 0) {
      const next = a.path[0];
      // Hold back at the edge of a tile someone else is standing on.
      if (canEnter && next !== this.tileOf(a) && !canEnter(next)) return 'waiting';
      if (!Number.isFinite(cost(next, this.tileOf(a)))) {
        const p =
          repaths++ < 1 ? findPath(w, this.map.h, this.tileOf(a), a.goal, cost, diagonal) : null;
        if (!p) {
          a.path = [];
          return 'blocked';
        }
        a.path = p;
        continue;
      }
      const tx = (next % w) + 0.5;
      const ty = Math.floor(next / w) + 0.5;
      const dx = tx - a.x;
      const dy = ty - a.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) a.dir = Math.atan2(dy, dx);
      if (d <= budget) {
        a.x = tx;
        a.y = ty;
        a.path.shift();
        budget -= d;
      } else {
        a.x += (dx / d) * budget;
        a.y += (dy / d) * budget;
        budget = 0;
      }
    }
    return a.path.length === 0 ? 'arrived' : 'moving';
  }

  private tileOf(a: Agent): number {
    return this.map.idx(Math.floor(a.x), Math.floor(a.y));
  }

  private dist(a: number, b: number): number {
    const m = this.map;
    return Math.abs(m.xOf(a) - m.xOf(b)) + Math.abs(m.yOf(a) - m.yOf(b));
  }

  // ── Output ────────────────────────────────────────────────

  private message(text: string, tone: 'info' | 'good' | 'bad'): void {
    this.events.push({ kind: 'message', text, tone });
  }

  private moneyAt(amount: number, i: number): void {
    this.events.push({ kind: 'money', amount, x: this.map.xOf(i) + 0.5, y: this.map.yOf(i) + 0.5 });
  }

  private depotViews(): { idx: number; forklifts: number }[] {
    const out: { idx: number; forklifts: number }[] = [];
    for (let i = 0; i < this.map.build.length; i++) {
      if (this.map.build[i] === Build.Depot) {
        out.push({ idx: i, forklifts: B.DEPOT_SLOTS - this.depotRoom(i) });
      }
    }
    return out;
  }

  drainEvents(): SimEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  drainTileChanges(): TileChange[] {
    const out = [...this.dirty].map((i) => ({
      i,
      terrain: this.map.terrain[i],
      build: this.map.build[i],
      orient: this.map.orient[i],
      deco: this.map.deco[i],
    }));
    this.dirty.clear();
    return out;
  }

  snapshot(): Snapshot {
    const entities: EntityView[] = [];
    const staff: StaffView[] = [];
    for (const p of this.people) {
      entities.push({
        id: p.id,
        kind: p.kind,
        x: p.x,
        y: p.y,
        dir: p.dir,
        load: p.carrying,
        moving: p.path.length > 0,
        name: p.name,
        activity: p.blocked > 3 ? 'Waiting for someone to get out of the way' : activity(p),
        variant: 0,
        capacity: p.capacity,
        alert: p.state === 'broken' || (p.state === 'idle' && !!p.stuck),
      });
      staff.push({
        id: p.id,
        kind: p.kind,
        broken: p.state === 'broken',
        fuel: Math.round(p.fuel),
        home: p.home,
        name: p.name,
        skill: p.skill,
        trait: p.trait,
        wage: p.wage,
        energy: Math.round(p.energy),
        morale: Math.round(p.morale),
        activity: activity(p),
        thought: thought({
          blocked: p.blocked > 3,
          energy: p.energy,
          morale: p.morale,
          resting: p.state === 'resting',
          hasHut: p.hutIdx >= 0,
          carrying: p.carrying > 0,
          idle: p.state === 'idle' || p.state === 'wander',
        }),
        raiseAsk: p.raiseAsk,
      });
    }
    for (const b of this.boats) {
      entities.push({
        id: b.id,
        kind: 'boat',
        x: b.x,
        y: b.y,
        dir: b.dir,
        load: b.crates,
        moving: b.path.length > 0,
        name: b.company,
        activity:
          b.state === 'approaching'
            ? 'Sailing in from sea'
            : b.state === 'anchored'
              ? 'Waiting at anchor for a berth'
              : b.state === 'arriving'
                ? 'Sailing to the jetty'
                : b.state === 'moored'
                  ? `Unloading, ${b.crates} ${b.vessel === 'feeder' ? 'containers' : 'crates'} left`
                  : 'Heading back out to sea',
        variant: b.variant,
        capacity: b.vessel === 'coaster' ? B.COASTER_MAX_LOAD : B.BOAT_MAX_LOAD,
        alert: b.state === 'anchored',
        vessel: b.vessel,
        boxes: b.vessel === 'feeder',
      });
    }
    for (const t of this.trucks) {
      entities.push({
        id: t.id,
        kind: 'truck',
        x: t.x,
        y: t.y,
        dir: t.dir,
        load: t.cargo,
        moving: t.path.length > 0,
        name: t.company,
        activity:
          t.state === 'toBay'
            ? 'Driving to the truck bay'
            : t.state === 'loading'
              ? `Loading, ${t.cargo}/${t.capacity} ${t.boxes ? 'containers' : 'crates'}`
              : 'Delivering to town',
        variant: t.variant,
        capacity: t.capacity,
        alert: false,
        boxes: t.boxes,
      });
    }
    const bays: BayView[] = [...this.bays.values()].map((b) => ({
      idx: b.idx,
      stock: b.crates.length,
      boxes: b.boxes.length,
      capacity: bayCap(b),
      large: b.large,
      warehouse: !!b.warehouse,
      noAccess: b.noAccess,
    }));
    const contracts: ContractView[] = this.contracts.map((c) => ({
      id: c.id,
      terms: c.terms,
      satisfaction: c.satisfaction,
      cancelFee: cancelFee(c),
      breach: breachPenalty(c),
      active:
        c.terms.kind === 'fishery'
          ? this.boats.filter((b) => b.contractId === c.id).length
          : this.trucks.filter((t) => t.contractId === c.id).length,
      waiting: this.boats.filter((b) => b.contractId === c.id && b.state === 'anchored').length,
      nextIn: c.terms.kind === 'fishery' ? Math.max(0, c.nextBoatTick - this.tick) : -1,
    }));
    const cap = this.capacity();
    return {
      tick: this.tick,
      cash: this.cash,
      speed: this.speed,
      seed: this.seed,
      staff: this.people.length,
      wages: this.wageBill(),
      people: staff,
      candidates: this.candidates.map((c) => ({ ...c })),
      contractFees: this.dailyFees(),
      loan: this.loan,
      interest: this.interestDue(),
      today: { ...this.today },
      yesterday: this.yesterday ? { ...this.yesterday } : null,
      daysInRed: this.daysInRed,
      bankrupt: this.bankrupt,
      stats: { ...this.stats },
      entities,
      bays,
      yards: [...this.yards.values()].map((y) => ({
        idx: y.idx,
        boxes: y.boxes.length,
        noAccess: y.noAccess,
      })),
      contracts,
      capacity: this.capacity(),
      docks: {
        total: this.docks().length,
        coordinated: this.docks().filter((g) => g.coordinated).length,
        offices: this.map.build.filter((b) => b === Build.Office).length,
      },
      depots: this.depotViews(),
      progress: { tier: this.tier, ...this.tierProgress(), canUpgrade: this.canUpgrade() },
      cranes: [...this.cranes.values()].map((c) => ({
        idx: c.idx,
        kind: c.kind,
        stack: c.stack.length,
        angle: c.angle,
        busy: c.busy,
      })),
      offers: this.offers.map((o) => ({
        id: o.id,
        terms: o.terms,
        signingFee: o.signingFee,
        expiresIn: o.expires - this.tick,
        breach: breachPenalty(o),
        truckingAfter: o.terms.kind === 'haulier' ? this.truckingWith(o.terms) : cap.trucking,
      })),
    };
  }
}
