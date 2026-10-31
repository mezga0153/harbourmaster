import { cargoName, cargoOf, withCargo, type Cargo } from './cargo';
import type {
  Agent,
  Bay,
  Boat,
  Crane,
  Dockhand,
  DockhandState,
  GantryHeld,
  GantryWork,
  JibJob,
  SaveData,
  Truck,
  Tug,
} from './state';
import type {
  BayView,
  Capacity,
  CargoSample,
  Command,
  EntityView,
  FinanceDay,
  HandAt,
  Ledger,
  SimEvent,
  Stats,
} from '../protocol';
import * as B from './balance';
import {
  isIce,
  makeOffer,
  paysPerContainer,
  STARTER_FISHERY,
  STARTER_HAULIER,
  type Contract,
  type Offer,
  type ShipperTerms,
} from './contracts';
import { ownBuilt } from './land';
import { GameMap } from './map';
import { extendMap, generateMap } from './mapgen';
import { randomName, townName } from './names';
import { crossingClosed, layRailway, newRail, stepRail, type RailState } from './railway';
import {
  laneLine,
  waysMeet,
  wayFrom,
  exitRows,
  greenAt,
  hasHighway,
  hasLights,
  highwayIns,
  highwayOuts,
  isExit,
  isHighway,
  linked,
  nearestEnd,
  oneWay,
} from './roads';
import {
  BUSINESSES,
  clearTown,
  foundTown,
  HIGHWAY_X,
  TOWN_LAYOUT,
  growTown,
  population,
  townHomes,
  townStageUp,
  townWants,
  type Business,
  landmarkDue,
  landmarkGoal,
  landmarksByPopulation,
  LANDMARKS,
  type Town,
} from './town';
import { paceFactor, traitDef, type Candidate } from './staff';
import { findDrivePath, findPath, type CostFn } from './path';
import { Rng } from './rng';
import {
  FACING,
  anchorOf,
  frontOf,
  footprint,
  gantryRails,
  ON_QUAY,
  drivable,
  machinePlacementError,
  nearCrane,
  needsWideSpace,
  parkingLots,
  type ParkingLot,
  type ParkingSpace,
  loadingSpots,
  truckCost,
  laneRuns,
  truckReach,
  walkableAt,
  junctionAt,
  liftMarks,
  gantryYard,
} from './rules';
import { MACHINES, parkPoses, type ParkPose } from './machines';
import { MACHINE_TIER, TIERS } from './tiers';
import {
  Build,
  isBay,
  isTownBuilding,
  isCrane,
  isDock,
  isPublicRoad,
  Store,
  storesBoxes,
  TICKS_PER_DAY,
  type MachineKind,
} from './types';
import {
  BACK_PULL,
  BACK_TURN,
  CARGO_EVERY,
  CARGO_SAMPLES,
  YARD_STACKS,
  YARD_TIERS,
  aligned,
  bayCap,
  bayIncoming,
  bayRoom,
  boxLookOf,
  clamp,
  craneStacks,
  craneTicks,
  emptyLedger,
  heldIn,
  isBoxy,
  isMachine,
  isTruck,
  laneOf,
  liftTicks,
  loadTicks,
  needsCustoms,
  needsPapers,
  outCap,
  truckBay,
  wrapAngle,
  yardPlace,
} from './helpers';
import type { Crossing, Source, Vehicle } from './helpers';
import { message, moneyAt, nag, tip, tipUnless } from './systems/output';
import { cargoStats } from './systems/snapshot';
import { buildSnapshot } from './systems/snapshot';
import {
  drainEvents as eventsOut,
  drainPlotChanges as plotsOut,
  drainTileChanges as tilesOut,
  FIRST_STEPS,
} from './systems/output';
import type { Snapshot } from '../protocol/views';
import type { TileChange } from '../protocol/messages';
import {
  addContract,
  addOffer,
  answerRaise,
  book,
  cancelContract,
  fire,
  hire,
  newDay,
  refreshCandidates,
  sailNow,
  shippers,
  signContract,
  takeLoan,
  upgrade,
} from './systems/economy';
import {
  build,
  buildRoundabout,
  bulldoze,
  buyPlot,
  layHighwayIn,
  markForkliftOnly,
  markOneWay,
  markStore,
  openExit,
  rebuildStores,
  setGateWay,
  terraformTiles,
  toggleLights,
  unmark,
} from './systems/building';
import { buildTown, openLandmark } from './systems/townBusiness';
import { buyTug, updateTugs } from './systems/tugs';
import { hauliers } from './systems/economy';
import {
  craneKinds,
  cranePlaces,
  craneReaches,
  craneTop,
  customsFor,
  deckSlot,
  dueAt,
  exportRoom,
  jibStores,
  nextCranePlace,
  outSlots,
  shipFor,
  takingAt,
  underGantry,
  updateCrane,
} from './systems/cranes';
import {
  boatCostFor,
  boatHalf,
  mooredTiles,
  near,
  pickTile,
  spawnBoat,
  spawnBoats,
  updateBoat,
} from './systems/boats/berthing';
import { docks } from './systems/boats/berthing';
import { craneFront } from './systems/boats/berthing';

export const SAVE_VERSION = 11;
export const SPEEDS = [0, 1, 2, 4, 8];

export type { SaveData, Tug } from './state';

const WORKING: ReadonlySet<DockhandState> = new Set(['toPickup', 'picking', 'toDrop', 'dropping']);

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
  /** The last days gone by, for the finance charts, oldest first. */
  history: FinanceDay[] = [];
  /** The cargo counts every so often, for the statistics charts, oldest first. */
  cargoLog: CargoSample[] = [];
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
  tugs: Tug[] = [];
  /** Ticks each tug has been held up, see steerTug. Not saved. */
  tugHeld = new WeakMap<Tug, number>();
  trucks: Truck[] = [];
  bays = new Map<number, Bay>();
  /** Container yards, by their main tile. Crate storage areas are with the bays. */
  yards = new Map<number, Bay>();
  /** Cargo landed on the quay beside boats, by tile. */
  piles = new Map<number, Bay>();
  /** The storage area each tile is part of, by its main tile, or -1. Not saved. */
  storeOf: Int32Array;
  /** Where trucks stand to load at each storage area; cleared when the port changes. */
  spotCache = new Map<number, number[]>();
  /** Each tile of a yard gantry's lane with the way trucks drive along it; see laneWays. */
  laneCache: Map<number, [number, number]> | null = null;
  /** Each tile of a yard gantry's lane with the way its rails run; see gantryRailWays. */
  railCache: Map<number, [number, number]> | null = null;
  /** The yard each tile of a yard gantry's lane is beside, by its first tile; with railCache. */
  railYard = new Map<number, number>();
  /** Every tile of the lanes under the yard gantries; see yardLaneTiles. */
  yardLaneCache: Set<number> | null = null;
  /** How far the roads run across from each tile, for keeping right; see laneRuns. */
  runsCache: Uint8Array | null = null;
  /** Each yard's gantry lane, by the yard; see gantryLane. */
  laneOfCache = new Map<number, Map<number, number> | null>();
  /** Which yard each yard gantry works; see gantries. */
  gantryCache: { byYard: Map<number, number>; idle: Map<number, string> } | null = null;
  /** How far by road trucks have to each tile they can reach; see truckReach. */
  reachCache: Int32Array | null = null;
  /** Junctions trucks give way at; see junctions. */
  junctionCache: Uint8Array | null = null;
  /** Where quay gantry cranes have containers set down, this tick; see craneStackTiles. */
  craneStackCache: { tick: number; at: Set<number> } | null = null;
  /** Which way tractors stand where cranes lift onto them; see lineUpAt. */
  lineUpCache: Map<number, [number, number]> | null = null;
  /** Trucks and port machines by id, this tick; see ring. */
  vehicleCache: { tick: number; by: Map<number, Vehicle> } | null = null;
  /** Where trucks and machines are about to drive, this tick; see crossings. */
  crossingCache: { tick: number; at: Map<number, Crossing[]> } | null = null;
  /** Where trucks can turn about; see turnable. */
  turnCache: Uint8Array | null = null;
  /** Where port machines can drive from their depots; see machineGround. */
  machineCache: Set<number> | null = null;
  /** The parking lots, and whether each works; see parkingLots. */
  lotsCache: ParkingLot[] | null = null;
  /** The town up the coast, which grows with the port. */
  town: Town | null = null;
  /** The step up the player has been told the town is big enough for. */
  tierReadyTold = 0;
  rail: RailState;
  /**
   * The town and the trains draw their own random numbers, so they never
   * change what happens at the port.
   */
  readonly scenery: Rng;

  anchorageTile = -1;
  /** Ticks today with a full truck bay, for the advisor. Not saved. */
  bayFullTicks = 0;
  /** Cached planning estimate; cleared when the port changes. Not saved. */
  capacityCache: Capacity | null = null;
  /** Dock groups and the coordinated tiles; cleared when the map changes. Not saved. */
  dockCache: ReturnType<typeof docks> | null = null;
  gateCache: Set<number>[] | null = null;
  /** Boats held up this tick only by a ship pulling out. Not saved. */
  roomWait = new WeakSet<Boat>();
  /**
   * Where each boat under way will be over the next LOOKOUT_TICKS, at the
   * pace it is keeping (see plot), drawn once a tick. Not saved.
   */
  plots = new Map<Boat, Float64Array>();
  plotsAt = -1;
  /**
   * The share of its speed a boat keeping clear holds to, and the boat it
   * is keeping clear of. Not saved.
   */
  keepingClear = new WeakMap<Boat, { pace: number; of: number }>();
  /** Ticks each boat under way has lain still, for plotCourses. Not saved. */
  stillFor = new WeakMap<Boat, number>();
  /** Boats coming alongside, lining up, casting off or pulling out. Not saved. */
  handling = new WeakSet<Boat>();
  /** What each jib crane at work is lifting this tick, for the view. Not saved. */
  jibJobs = new WeakMap<Crane, JibJob>();
  buoyCache: Uint8Array | null = null;
  frontCache: Int32Array | null = null;
  /** What routes pay to pass close to a jetty, quay or the shore; see shoreRing. */
  ringCache: Float32Array | null = null;
  coordinated = new Set<number>();
  /** Dock tile → its dock's key (the dock's lowest tile), with docks(). */
  dockKey = new Map<number, number>();
  /** Advisor tips already given, so each comes once a game. */
  tipsSeen = new Set<string>();
  /** Boats that have left the port so far, for the advisor; see departTips. */
  departed = 0;
  /** When each container ship lately finished unloading, by id, for customs. */
  unloadedAt = new Map<number, number>();
  warnedOffice = false;
  /** When each repeating warning may next be given, and the gap after that. Not saved. */
  nags = new Map<string, { next: number; gap: number }>();
  /** Demurrage charged since midnight, told once a day at most. */
  demurrageToday = { amount: 0, ships: 0 };
  /** Lines signed this session whose first boat has not come in, to say when it does. Not saved. */
  firstBoat = new Set<string>();
  warnedBigTrucks = false;
  warnedBoxTrucks = false;
  warnedStuck = false;
  /** Shortest road from the highway to a truck bay; set by capacity(). */
  roadLen = Infinity;
  events: SimEvent[] = [];
  /** Workers per tile and lane (tile * 4 + lane), rebuilt every tick. Not saved. */
  occupancy: Uint8Array;
  dirty = new Set<number>();
  /** A plot was bought since the main thread was last told. */
  plotsChanged = false;

  private constructor(
    readonly seed: number,
    readonly map: GameMap,
    readonly rng: Rng,
  ) {
    this.occupancy = new Uint8Array(map.w * map.h * 4);
    this.storeOf = new Int32Array(map.w * map.h).fill(-1);
    this.scenery = new Rng(seed ^ 0x7a3c1);
    this.rail = newRail(this.scenery);
  }

  /** Lay the railway and found the town, on a new map or one from an older save. */
  settle(): void {
    layRailway(this.map);
    this.town = foundTown(this.map, townName(this.scenery), () => {});
  }

  /**
   * New games own all the port's land, as before land was bought, rather
   * than the few plots round the jetty: for tests whose ports spread
   * anywhere. See ownAll in create.
   */
  static ownAllLand = false;

  /**
   * A new game; `size`, the port's land, for a map as big as they were
   * before; `ownAll` owns every plot of it from the start.
   */
  static create(seed: number, size?: number, ownAll = World.ownAllLand): World {
    const { map, spawn } = generateMap(seed, size);
    if (ownAll) map.plots.fill(1);
    const world = new World(seed, map, new Rng(seed));
    world.settle();
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
    refreshCandidates(world);
    const starter = addContract(world, STARTER_FISHERY, 0, B.STARTER_SIGNING_FEE);
    // The first boat is already coming in when the game starts.
    spawnBoat(world, starter.id, STARTER_FISHERY, true);
    starter.nextBoatTick = Math.round(TICKS_PER_DAY * STARTER_FISHERY.boatEvery);
    addContract(world, STARTER_HAULIER, 0, 0);
    addOffer(world, 'fishery');
    addOffer(world, 'fishery');
    addOffer(world, 'haulier');
    world.events = [];
    message(world, 'Welcome to your new port! Boats will bring crates to the jetty.', 'info');
    tip(world, 'welcome');
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
    // Saves from before the country past the port's land get it added on.
    const map = extendMap(GameMap.fromData(s.map), s.seed);
    const world = new World(s.seed, map, new Rng(s.rng));
    world.tick = s.tick;
    world.cash = s.cash;
    world.speed = s.speed;
    world.nextId = s.nextId;
    world.stats = { ...s.stats, containers: s.stats.containers ?? 0 };
    world.contracts = s.contracts.map((c) => ({ ...c, terms: { ...c.terms } }));
    world.offers = s.offers.map((o) => ({ ...o, terms: { ...o.terms } }));
    // Containers came to pay half as much again: older saves' deals too, once.
    if (!s.containerFees2) {
      for (const d of [...world.contracts, ...world.offers]) {
        if (paysPerContainer(d.terms) && 'fee' in d.terms) {
          d.terms.fee = Math.round(d.terms.fee * 1.5);
        }
      }
    }
    world.candidates = s.candidates.map((c) => ({ ...c }));
    world.loan = s.loan;
    world.tier = s.tier;
    world.congestion = s.congestion;
    world.jam = { ...s.jam };
    for (const c of s.cranes) {
      world.cranes.set(c.idx, { ...c, kind: c.kind ?? 'jib', stack: [...c.stack] });
    }
    // Older saves booked all cargo income as one: the rest start at nothing.
    world.today = { ...emptyLedger(), ...s.today };
    world.yesterday = s.yesterday ? { ...emptyLedger(), ...s.yesterday } : null;
    world.history = (s.history ?? []).map((d) => ({
      ...d,
      ledger: { ...emptyLedger(), ...d.ledger },
    }));
    world.cargoLog = s.cargoLog ?? [];
    world.daysInRed = s.daysInRed;
    world.bankrupt = s.bankrupt;
    world.people = s.people.map((p) => ({
      ...p,
      stockIdx: p.stockIdx ?? -1,
      toBoat: p.toBoat ?? -1,
      toCrane: p.toCrane ?? -1,
      path: [...p.path],
      cargoFees: [...p.cargoFees],
    }));
    world.boats = s.boats.map((b) => ({ ...b, path: [...b.path] }));
    world.tugs = (s.tugs ?? []).map((t) => ({ ...t, path: [...t.path] }));
    world.trucks = s.trucks.map((t) => ({ ...t, path: [...t.path] }));
    // Older saves had warehouses and container yards as buildings: now they
    // are storage marked out on the port road or quay they stood on.
    const m = world.map;
    for (let i = 0; i < m.build.length; i++) {
      const b = m.build[i];
      if (b !== Build.Yard && b !== Build.Warehouse) continue;
      m.store[i] = b === Build.Yard ? Store.Boxes : Store.Crates;
      m.build[i] = m.orient[i] & ON_QUAY ? Build.Quay : Build.PortRoad;
      m.orient[i] = 0;
    }
    // Saves from before land was bought own every plot they built on, free.
    if (!s.map.plots) ownBuilt(m, generateMap(s.seed, m.w).map);
    for (const bay of s.bays) {
      world.bays.set(bay.idx, {
        ...bay,
        crates: [...bay.crates],
        customs: bay.customs && [...bay.customs],
        papers: bay.papers && [...bay.papers],
        places: bay.places && [...bay.places],
        boxes: [...(bay.boxes ?? [])],
        boxIncoming: bay.boxIncoming ?? 0,
        large: bay.large ?? false,
        tiles: bay.tiles ? [...bay.tiles] : bay.warehouse ? [bay.idx] : undefined,
      });
    }
    for (const pile of s.piles ?? [])
      world.piles.set(pile.idx, { ...pile, crates: [...pile.crates] });
    for (const y of s.yards ?? []) {
      world.yards.set(y.idx, {
        ...y,
        yard: true,
        boxes: [...y.boxes],
        tiles: y.tiles ? [...y.tiles] : [y.idx],
      });
    }
    if (s.scenery !== undefined) world.scenery.state = s.scenery;
    world.tipsSeen = new Set(s.tips ?? []);
    world.departed = s.departed ?? 0;
    // A game from before the advisor taught these is well past them.
    if (s.departed === undefined) for (const id of FIRST_STEPS) world.tipsSeen.add(id);
    world.unloadedAt = new Map(s.unloaded ?? []);
    if (s.rail) world.rail = structuredClone(s.rail);
    // The line runs on through any country added to the map since.
    layRailway(world.map);
    // The highway runs down the map itself since it was laid on it.
    layHighwayIn(world);
    if (s.town === undefined) world.settle();
    else if (s.town) world.relay({ ...s.town });
    // The town's trucks drive to it off the highway now, not round past the map.
    if (world.town) world.town.gate = -1;
    // Parked trucks stand the way their lot's spaces lean, as it now runs one way.
    for (const t of world.trucks) if (t.state === 'parked' && t.lot) world.parkUp(t);
    rebuildStores(world);
    world.rehomeOverfull();
    return world;
  }

  /**
   * A reach stacker takes two of a depot's places since they came to park
   * side by side in it: machines of a depot fuller than that from an older
   * save move to another with room, if there is one, the newest first.
   */
  rehomeOverfull(): void {
    const machines = this.people.filter((q) => isMachine(q)).sort((a, b) => b.id - a.id);
    for (const p of machines) {
      if (p.home < 0 || this.depotRoom(p.home) >= 0) continue;
      const room = MACHINES[p.kind as MachineKind].room;
      for (let i = 0; i < this.map.build.length; i++) {
        if (this.map.build[i] === Build.Depot && this.depotRoom(i) >= room) {
          p.home = i;
          break;
        }
      }
    }
  }

  /** The landmarks an older town has open already, by what stands in it and how big it is. */
  landmarksOf(old: Town): number {
    const pop = population(old, this.map);
    if (pop >= 300) return landmarksByPopulation(pop);
    let n = 0;
    while (n < LANDMARKS.length && this.map.build.includes(LANDMARKS[n].code)) n++;
    return n;
  }

  /** Bring a town from an older save up to date, laying it out again under the current rules. */
  relay(old: Town): void {
    const t: Town = {
      ...old,
      supplied: old.supplied ?? 0,
      local: old.local ?? 0,
      // Older saves kept one count for all crates, and one for containers.
      wants: old.wants && !('crates' in old.wants) ? old.wants : townWants(this.map),
      layout: old.layout ?? 1,
      gate: old.gate ?? -1,
      // A town from before its landmarks: as many done as it has, or a town
      // already past 300 people has its restaurant, and so on, a step for
      // each cap it is past (towns with the restaurant grew on unchecked).
      landmarks:
        old.landmarks === undefined
          ? this.landmarksOf(old)
          : old.landmarks >= 3
            ? Math.max(old.landmarks, landmarksByPopulation(population(old, this.map)))
            : old.landmarks,
      streak: old.streak ?? 0,
      goal: old.goal ?? 0,
    };
    this.town = t;
    if (t.layout >= TOWN_LAYOUT) return;
    const homes = townHomes(this.map);
    clearTown(this.map, () => {});
    const fresh = foundTown(this.map, t.name, () => {});
    if (!fresh) {
      this.town = null;
      return;
    }
    // Same people and trade, new streets: built straight back up to size.
    this.town = {
      ...t,
      centre: fresh.centre,
      gate: fresh.gate,
      layout: TOWN_LAYOUT,
      wants: fresh.wants,
    };
    for (let k = 0; k < 3000 && townHomes(this.map) < homes; k++) {
      if (!growTown(this.town, this.map, () => {})) break;
    }
    this.town.wants = townWants(this.map);
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
      containerFees2: true,
      candidates: this.candidates,
      cranes: [...this.cranes.values()],
      congestion: this.congestion,
      jam: this.jam,
      tier: this.tier,
      loan: this.loan,
      today: this.today,
      yesterday: this.yesterday,
      history: this.history,
      cargoLog: this.cargoLog,
      daysInRed: this.daysInRed,
      bankrupt: this.bankrupt,
      map: this.map.toData(),
      people: this.people,
      boats: this.boats,
      tugs: this.tugs,
      trucks: this.trucks,
      bays: [...this.bays.values()],
      yards: [...this.yards.values()],
      piles: [...this.piles.values()],
      town: this.town,
      rail: this.rail,
      scenery: this.scenery.state,
      tips: [...this.tipsSeen],
      departed: this.departed,
      unloaded: [...this.unloadedAt],
    });
  }

  // ── Commands ──────────────────────────────────────────────

  command(cmd: Command): void {
    if (this.bankrupt) return;
    this.capacityCache = null;
    this.dockCache = null;
    this.gateCache = null;
    this.buoyCache = null;
    this.anchorageTile = -1;
    this.frontCache = null;
    this.ringCache = null;
    this.spotCache.clear();
    this.laneCache = null;
    this.railCache = null;
    this.laneOfCache.clear();
    this.yardLaneCache = null;
    this.gantryCache = null;
    this.reachCache = null;
    this.lotsCache = null;
    this.junctionCache = null;
    this.turnCache = null;
    this.runsCache = null;
    this.machineCache = null;
    this.craneStackCache = null;
    this.lineUpCache = null;
    switch (cmd.type) {
      case 'build':
        return build(this, cmd.kind, cmd.tiles, cmd.facing);
      case 'bulldoze':
        return bulldoze(this, cmd.tiles);
      case 'forkliftOnly':
        return markForkliftOnly(this, cmd.tiles, cmd.on);
      case 'exit':
        return openExit(this, cmd.row);
      case 'oneWay':
        return markOneWay(this, cmd.tiles, cmd.on);
      case 'lights':
        return toggleLights(this, cmd.tile);
      case 'gateWay':
        return setGateWay(this, cmd.tile, cmd.way);
      case 'roundabout':
        return buildRoundabout(this, cmd.tile);
      case 'unmark':
        return unmark(this, cmd.tiles);
      case 'store':
        return markStore(this, cmd.tiles, cmd.kind, cmd.on);
      case 'shutStore':
        return this.shutStore(cmd.idx, cmd.shut);
      case 'sailNow':
        return sailNow(this, cmd.id);
      case 'terraform':
        return terraformTiles(this, cmd.tiles, cmd.raise);
      case 'buyPlot':
        return buyPlot(this, cmd.plot);
      case 'hire':
        return hire(this, cmd.candidateId);
      case 'fire':
        return fire(this, cmd.id);
      case 'loan':
        return takeLoan(this, cmd.amount);
      case 'upgrade':
        return upgrade(this);
      case 'buyMachine':
        return this.buyMachine(cmd.kind, cmd.tile);
      case 'buyTug':
        return buyTug(this, cmd.tile);
      case 'raise':
        return answerRaise(this, cmd.id, cmd.accept);
      case 'signContract':
        return signContract(this, cmd.id);
      case 'cancelContract':
        return cancelContract(this, cmd.id);
      case 'setSpeed':
        if (SPEEDS.includes(cmd.speed)) this.speed = cmd.speed;
        if (this.speed > 1) this.tipsSeen.add('speed');
        return;
      case 'learnt':
        this.tipsSeen.add(cmd.tip);
        return;
      case 'newGame':
      case 'save':
      case 'debug':
        return; // handled by the worker
    }
  }

  // ── Roads: the highway's exits, one-way roads, lights, gates ────

  /** Testing shortcuts. The worker only forwards these on the dev server. */
  debug(cmd: Extract<Command, { type: 'debug' }>): void {
    if (cmd.cash) {
      this.cash += cmd.cash;
      message(this, `Debug: +$${cmd.cash.toLocaleString('en-US')}`, 'good');
    }
    if (cmd.tier !== undefined) this.tier = cmd.tier;
    if (cmd.town !== undefined && this.town) {
      // Build the town up to size at once.
      const t = this.town;
      t.demand = cmd.town;
      for (let k = 0; k < 3000 && townHomes(this.map) < t.demand; k++) {
        if (!growTown(t, this.map, (i) => this.dirty.add(i))) break;
        townStageUp(t, this.map);
      }
      t.wants = townWants(this.map);
    }
    if (cmd.train) this.rail.nextTrain = this.tick;
    if (cmd.containers) {
      const taken = new Set([...this.contracts, ...this.offers].map((c) => c.terms.name));
      let line = false;
      let haul = false;
      for (let k = 0; k < 60 && !(line && haul); k++) {
        const kind = line ? 'haulier' : 'fishery';
        const o = makeOffer(this.rng, this.nextId++, this.tick, kind, taken, 2);
        if (!o) continue;
        if (!line && o.terms.kind === 'fishery' && o.terms.vessel === 'feeder') {
          addContract(this, o.terms, this.tick + 30, o.signingFee);
          line = true;
        } else if (line && o.terms.kind === 'haulier' && o.terms.cargo === 'container') {
          addContract(this, o.terms, 0, o.signingFee);
          haul = true;
        }
      }
    }
    if (cmd.coaster) {
      const taken = new Set([...this.contracts, ...this.offers].map((c) => c.terms.name));
      for (let k = 0; k < 20; k++) {
        const o = makeOffer(this.rng, this.nextId++, this.tick, 'fishery', taken, 1);
        if (o && o.terms.kind === 'fishery' && o.terms.vessel === 'coaster') {
          addContract(this, o.terms, this.tick + 30, o.signingFee);
          return;
        }
      }
    }
  }

  // ── Contracts ─────────────────────────────────────────────

  // ── Tick ──────────────────────────────────────────────────

  step(): void {
    if (this.bankrupt) return;
    if (!Number.isFinite(this.cash)) {
      // Never let a bad value spread through the economy; fail loudly instead.
      throw new Error(`Cash became ${this.cash} at tick ${this.tick}`);
    }
    this.tick++;
    this.noteTiles();
    if (this.tick % TICKS_PER_DAY === 0) newDay(this);
    // The cargo counts, ten times a day for a week, for the statistics charts.
    if (this.tick % CARGO_EVERY === 0) {
      this.cargoLog.push({ tick: this.tick, cargo: cargoStats(this) });
      if (this.cargoLog.length > CARGO_SAMPLES) this.cargoLog.shift();
    }
    spawnBoats(this);
    for (const b of [...this.boats]) updateBoat(this, b);
    updateTugs(this);
    for (const c of this.cranes.values()) updateCrane(this, c);
    this.countOccupancy();
    for (const p of this.people) this.updateDockhand(p);
    if (this.tick % 10 === 0) this.spawnTrucks();
    if (this.tick % 10 === 5) this.spawnShipments();
    for (const t of [...this.trucks]) this.updateTruck(t);
    for (const y of this.yards.values()) if (y.gantryHeld && this.liftDone(y)) this.settleGantry(y);
    stepRail(this.rail, this.scenery, this.tick, this.map.h, this.town?.stage ?? 0);
    if (this.town && this.tick % B.TOWN_BUILD_TICKS === 0) buildTown(this, this.town);
  }

  // ── The town ──────────────────────────────────────────────

  // ── Boats ─────────────────────────────────────────────────

  boatCosts = new Map<number, CostFn>();

  boatCost: CostFn = (i) => boatCostFor(this, B.BOAT_DRAFT)(i);

  // ── Seamanship ────────────────────────────────────────────

  // ── Trucks at container yards ─────────────────────────

  /** A yard gantry stands beside this container yard, to load its trucks. */
  yardGantry(yard: Bay): boolean {
    return this.gantryOf(yard) >= 0;
  }

  /**
   * The yard gantry that works this container yard, by its tile, or -1:
   * one that spans it (see gantryYard), the first where two stand by it;
   * never one beside it that spans another yard.
   */
  gantryOf(yard: Bay): number {
    return this.gantries().byYard.get(yard.idx) ?? -1;
  }

  /**
   * Every yard gantry and the yard it works, by the yard's first tile;
   * and those that work none: beside no yard, or a second by one. Cleared
   * when the map changes.
   */
  gantries(): { byYard: Map<number, number>; idle: Map<number, string> } {
    if (this.gantryCache) return this.gantryCache;
    const m = this.map;
    const byYard = new Map<number, number>();
    const idle = new Map<number, string>();
    for (let g = 0; g < m.build.length; g++) {
      if (m.build[g] !== Build.YardGantry) continue;
      const own = gantryYard(m, g);
      const yard = own ? this.yards.get(this.storeOf[own.into]) : undefined;
      if (!yard) {
        idle.set(
          g,
          'A yard gantry spans the container yard beside it, and there is none beside this one: mark one out beside it, or take it down',
        );
      } else if (byYard.has(yard.idx)) {
        idle.set(
          g,
          'Another yard gantry works the yard beside this one already: a yard is worked by one gantry',
        );
      } else byYard.set(yard.idx, g);
    }
    return (this.gantryCache = { byYard, idle });
  }

  /**
   * Someone is there to load or unload a container truck at this storage:
   * a yard gantry, or a reach stacker free and not already wanted by another
   * truck there waiting for one. Always so for crate storage and bays.
   */
  handlerFree(bay: Bay, except?: Truck): boolean {
    if (!bay.yard || this.yardGantry(bay)) return true;
    const free = this.people.filter(
      (p) =>
        p.kind === 'stacker' &&
        (p.state === 'idle' ||
          p.state === 'wander' ||
          (p.state === 'toDepot' && p.depotTask === 'park')),
    ).length;
    const wanting = this.trucks.filter((q) => {
      if (q === except || !q.boxes || (q.coming ?? 0) > 0 || (q.taking ?? 0) > 0) return false;
      if (q.state !== 'toBay' && q.state !== 'loading' && q.state !== 'delivering') return false;
      const yard = this.yards.get(q.bayIdx);
      return !!yard && !this.yardGantry(yard);
    }).length;
    return free > wanting;
  }

  /**
   * The truck a yard's gantry is loading or unloading: one at a time, the
   * first with a container to move.
   */
  gantryTruck(y: Bay): Truck | undefined {
    let ready: boolean | undefined;
    let best: Truck | undefined;
    let bestD = Infinity;
    for (const t of this.trucks) {
      if (t.bayIdx !== y.idx || !t.boxes) continue;
      const wants =
        (t.state === 'delivering' && t.cargo > 0) ||
        (t.state === 'loading' &&
          t.cargo < t.capacity &&
          (ready ??= this.readyList(y).some((r) => this.isClear(r))));
      if (!wants) continue;
      // The nearest along its rails to where it stands, so it runs to and
      // fro no more than it must.
      const d = this.fromGantry(y, t.goal);
      if (d < bestD) {
        best = t;
        bestD = d;
      }
    }
    return best;
  }

  /** How far along its rails a yard's gantry is from lane tile `i`. */
  fromGantry(y: Bay, i: number): number {
    return Math.abs((this.gantryLane(y)?.get(i) ?? 0) - (y.gantryAt ?? 0));
  }

  /**
   * What a yard's gantry is doing, for the view: a truck it is loading or
   * unloading, and where that truck stands along its rails.
   */
  gantryWork(y: Bay): GantryWork {
    if (!this.yardGantry(y)) return {};
    // The one it is part way through a lift for. Between lifts it is at
    // none: it stands where it set the last one down, rather than show a
    // lift for the next one waiting that has not begun.
    const on = this.gantryHolder(y);
    // Setting down one lifted off a truck or tractor that has gone on.
    const h = y.gantryHeld;
    if (!on && h && y.gantryLift) {
      return {
        working: 'unload',
        workLook: h.looks[0],
        workAt: h.at,
        workTruck: h.by,
        workSlot: h.slot,
        workYard: y.gantryTo,
        released: true,
        ...this.liftView(y, h.by),
      };
    }
    if (!on || !y.gantryLift) return {};
    const p = isTruck(on) ? undefined : on;
    if (p) {
      const workAt = this.gantryLane(y)?.get(p.goal) ?? 0;
      const lift = { workAt, workTruck: p.id, workSlot: 0, ...this.liftView(y, p.id) };
      if (p.state === 'dropping') {
        // Where the sim stacks it, by when customs clear it.
        const workYard = y.gantryTo ?? this.stackedAt(p, y, customsFor(this, p.cargoFrom?.[0]));
        return {
          working: 'unload',
          workLook: this.carriedLooks(p)[0],
          workYard,
          ...lift,
        };
      }
      const top = Math.max(0, this.yardTop(y, true));
      return { working: 'load', workLook: this.exportLooks(y)[top], ...lift };
    }
    const t = on as Truck;
    const workAt = this.gantryLane(y)?.get(t.goal) ?? 0;
    const view = this.liftView(y, t.id);
    if (t.state === 'delivering') {
      const look = boxLookOf(t.id, t.cargo - 1);
      return {
        working: 'unload',
        workLook: look,
        workAt,
        workTruck: t.id,
        workSlot: t.cargo - 1,
        workYard: y.gantryTo,
        ...view,
      };
    }
    const look = t.lifting ?? this.boxLooks(y)[this.clearTop(y)];
    return {
      working: 'load',
      workLook: look,
      workAt,
      workTruck: t.id,
      workSlot: t.cargo,
      ...view,
    };
  }

  /** How far through its lift for `id` a yard's gantry is, and the lift's legs, for the view. */
  liftView(
    y: Bay,
    id: number,
  ): { workPhase: number; workLegs?: number[]; workTicks?: number; workStart?: number } {
    const l = y.gantryOn === id || y.gantryHeld?.by === id ? y.gantryLift : undefined;
    if (!l) return { workPhase: 0 };
    const total = liftTicks(l);
    return {
      workPhase: clamp((this.tick - l.start) / total, 0, 1),
      workLegs: l.legs.map((k) => k / total),
      workTicks: total,
      workStart: l.start,
    };
  }

  /** Where yard slot `slot` lies along its yard's gantry rails, as gantryLane counts. */
  slotAlong(y: Bay, slot: number | undefined): number {
    const lane = this.gantryLane(y);
    if (!lane || slot === undefined || slot < 0) return 0;
    const tile = (y.tiles ?? [y.idx])[Math.floor(slot / B.BOXES_PER_STORE_TILE)];
    if (tile === undefined) return 0;
    const m = this.map;
    let g = -1;
    let ax = 0;
    let ay = 0;
    for (const [i, k] of lane) {
      if (k === 0) g = i;
    }
    for (const [i, k] of lane) {
      if (k !== 1 && k !== -1) continue;
      ax = (m.xOf(i) - m.xOf(g)) * k;
      ay = (m.yOf(i) - m.yOf(g)) * k;
      break;
    }
    return (m.xOf(tile) - m.xOf(g)) * ax + (m.yOf(tile) - m.yOf(g)) * ay;
  }

  /**
   * A yard's gantry starts a lift: along its rails from where it stands to
   * `from`, where it takes the container up, then along to `to`, where it
   * sets it down. Returns how many ticks it takes: the longer the way along
   * the rails, the longer.
   */
  startLift(y: Bay, from: number, to: number): number {
    const at = y.gantryAt ?? from;
    // Taking it up and setting it down take as long as a lift always did.
    const up = Math.floor(B.YARD_GANTRY_TICKS / 2);
    const down = B.YARD_GANTRY_TICKS - up;
    const run = (d: number) => Math.round(Math.abs(d) / B.YARD_GANTRY_SPEED);
    y.gantryLift = { start: this.tick, legs: [run(from - at), up, run(to - from), down], to };
    return liftTicks(y.gantryLift);
  }

  /** Whether the lift a yard's gantry is part way through is done. */
  liftDone(y: Bay): boolean {
    const l = y.gantryLift;
    return !l || this.tick - l.start >= liftTicks(l);
  }

  /** Ticks from the start of a yard gantry's lift until its spreader has the container up. */
  takenIn(y: Bay): number {
    const l = y.gantryLift;
    // Not before the view has it taken: half way through taking it up.
    return l ? l.legs[0] + Math.ceil(l.legs[1] / 2) : 0;
  }

  /** Whether a yard gantry's spreader has taken up the container it is lifting. */
  liftTaken(y: Bay): boolean {
    const l = y.gantryLift;
    return !l || this.tick - l.start >= this.takenIn(y);
  }

  /**
   * A yard gantry has lifted a container off the truck or tractor it was
   * working: that one is free to go, and the gantry carries the container
   * on and sets it down at the end of the lift, taking on no other till then.
   */
  offToGantry(y: Bay, held: GantryHeld): void {
    y.gantryHeld = held;
    y.gantryOn = undefined;
  }

  /** A yard gantry sets down the container it lifted off a truck or tractor gone on its way. */
  settleGantry(y: Bay): void {
    const h = y.gantryHeld;
    if (!h) return;
    const to = y.gantryTo;
    if (h.exports) {
      if (to !== undefined && h.fees.length === 1) this.yardSlots(y).exports.push(to);
      this.exportLooks(y).push(...h.looks);
      (y.exports ??= []).push(...h.fees);
      y.exportIncoming = Math.max(0, (y.exportIncoming ?? 0) - h.planned);
    } else {
      // Customs clear it a while after it is stacked, as any other.
      const ready = h.fees.map((_, k) => customsFor(this, h.from?.[k]));
      if (to !== undefined && h.fees.length === 1) this.yardSlots(y).boxes.push(to);
      this.readyList(y).push(...ready);
      this.boxLooks(y).push(...h.looks);
      y.boxes.push(...h.fees);
      bayIncoming(y, true, -h.planned);
      this.stats.containers += h.fees.length;
      tip(this, 'customs');
    }
    y.gantryHeld = y.gantryTo = undefined;
    // It stands where it set the container down, for the next.
    if (y.gantryLift) y.gantryAt = y.gantryLift.to;
    y.gantryLift = undefined;
  }

  /**
   * Containers a yard gantry is part way through lifting, by the truck or
   * tractor it is working: off it once the spreader has it, on it once set
   * down. The sim moves each at the end of the lift; the view shows it
   * where the gantry has it.
   */
  gantryLifts(): Map<number, GantryWork & { yard: number }> {
    const lifts = new Map<number, GantryWork & { yard: number }>();
    for (const y of this.yards.values()) {
      const w = this.gantryWork(y);
      // Only those still on, or still being lifted onto, the truck or tractor.
      if (w.workTruck !== undefined && !w.released) lifts.set(w.workTruck, { ...w, yard: y.idx });
    }
    return lifts;
  }

  /**
   * A reach stacker or terminal tractor taking a container off where it is
   * or setting one down, for the view to work it there in step.
   */
  handView(p: Dockhand): Pick<EntityView, 'handStage' | 'handPhase' | 'handTicks' | 'handAt'> {
    if (p.state !== 'picking' && p.state !== 'dropping') return {};
    const pick = p.state === 'picking';
    const crates = p.kind === 'forklift' || p.kind === 'dockhand';
    const at = crates ? this.crateAt(p, pick) : this.handAt(p, pick);
    if (crates && !at) return {};
    const ticks = this.handlingTicks(p, pick ? B.PICK_TICKS : B.DROP_TICKS);
    return {
      handStage: pick ? 'pick' : 'drop',
      handPhase: clamp(1 - p.timer / ticks, 0, 1),
      handTicks: ticks,
      handAt: at,
    };
  }

  /**
   * The places crate storage's pallets are in, four to a tile, kept beside
   * its crates: each stays where it was set down as forklifts take full
   * ones from under the one being filled, and a new one goes in the lowest
   * free place. With `n` more than it holds, as many more as `n` would fill,
   * where they would go.
   */
  palletPlaces(b: Bay, n = 0): number[] {
    const per = B.FORKLIFT_CAPACITY;
    const room = (b.tiles?.length ?? 1) * (B.CRATES_PER_STORE_TILE / per);
    const places = (b.places ??= []);
    const pallets = Math.ceil(heldIn(b) / per);
    if (places.length > pallets) places.length = pallets;
    const used = new Set<number>();
    places.forEach((k, j) => {
      if (k < 0 || k >= room || used.has(k)) places[j] = -1;
      else used.add(k);
    });
    const free = () => {
      let k = 0;
      while (used.has(k)) k++;
      used.add(k);
      return k;
    };
    places.forEach((k, j) => k < 0 && (places[j] = free()));
    while (places.length < pallets) places.push(free());
    if (n <= pallets * per) return places;
    const more = [...places];
    while (more.length < Math.ceil(n / per)) more.push(free());
    return more;
  }

  /** Where crate `k` of crate storage is, counting `n` there: its pallet's place, four to each. */
  crateSlot(b: Bay, k: number, n = k + 1): number {
    const per = B.FORKLIFT_CAPACITY;
    return (this.palletPlaces(b, n)[Math.floor(k / per)] ?? 0) * per + (k % per);
  }

  /**
   * Which of crate storage's pallets a forklift takes, of its exports when
   * `out`: the one it pulled up to, else the last full one no other is
   * lifting, so it leaves alone the one being filled, by a jib crane say;
   * with none full, or when it is taking less than a pallet's worth, the
   * last. -1 if there are none.
   */
  pickPallet(b: Bay, out: boolean, p?: Dockhand): number {
    const per = B.FORKLIFT_CAPACITY;
    const places = this.palletPlaces(b);
    const last = places.length - 1;
    const at = p?.state === 'picking' && p.takeAt !== undefined ? places.indexOf(p.takeAt) : -1;
    if (at >= 0) return at;
    if (p && (p.state === 'toPickup' || p.state === 'picking') && p.planned < per) return last;
    const [from, to] = out ? [b.crates.length, heldIn(b)] : [0, b.crates.length];
    const taken = new Set(
      this.people
        .filter((q) => q !== p && q.kind === 'forklift' && q.state === 'picking')
        .filter((q) => q.stockIdx === b.idx)
        .map((q) => q.takeAt),
    );
    // Never a pallet with crates on it still waiting on customs or papers.
    const wait = this.heldMask(b);
    const cleared = (j: number) => !wait.slice(j * per, (j + 1) * per).includes(true);
    for (let j = last; j >= 0; j--) {
      if (j * per >= from && (j + 1) * per <= to && !taken.has(places[j]) && cleared(j)) return j;
    }
    return last;
  }

  /**
   * The tile of crate storage the pallet a forklift takes is on (`pick`),
   * or the place the next goes: four pallets to a tile.
   */
  palletTile(b: Bay, pick: boolean, coming = !pick, out = false, p?: Dockhand): number {
    const tiles = b.tiles ?? [b.idx];
    const per = B.CRATES_PER_STORE_TILE / B.FORKLIFT_CAPACITY;
    const next = heldIn(b) + (coming ? b.incoming : 0);
    const place = pick
      ? (this.palletPlaces(b)[this.pickPallet(b, out, p)] ?? 0)
      : Math.floor(this.crateSlot(b, next) / B.FORKLIFT_CAPACITY);
    return tiles[Math.min(tiles.length - 1, Math.floor(place / per))];
  }

  /**
   * How many crates a forklift may take off crate storage: those on the
   * pallet it drives up to, so it lifts just what is seen on it; no limit
   * anywhere else.
   */
  onPallet(p: Dockhand, b: Bay): number {
    if (p.kind !== 'forklift' || !b.tiles || b.yard) return Infinity;
    const j = this.pickPallet(b, !!p.outbound, p);
    return Math.min(B.FORKLIFT_CAPACITY, heldIn(b) - j * B.FORKLIFT_CAPACITY);
  }

  /**
   * Where in crate storage's crates, or its exports, `n` taken off it come
   * from: a forklift's whole pallet from wherever it is, its place left
   * free; else the last.
   */
  takenFrom(p: Dockhand, b: Bay, n: number): number {
    const per = B.FORKLIFT_CAPACITY;
    const list = p.outbound ? (b.exports ?? []) : b.crates;
    const skip = p.outbound ? b.crates.length : 0;
    const j =
      p.kind === 'forklift' && b.tiles && !b.yard ? this.pickPallet(b, !!p.outbound, p) : -1;
    p.takeAt = undefined;
    const places = this.palletPlaces(b);
    const at = j * per - skip;
    if (j < 0 || j === places.length - 1 || n !== per || at < 0 || at + n > list.length) return 0;
    places.splice(j, 1);
    return at;
  }

  /**
   * A forklift at crate storage not at the tile of the pallet it takes, or
   * the place its own goes as it sets it down, heads on there; true if so.
   */
  toPallet(p: Dockhand, b: Bay | undefined, pick: boolean): boolean {
    if (p.kind !== 'forklift' || !b?.tiles || b.yard) return false;
    const tile = this.palletTile(b, pick, false, !!p.outbound, p);
    return tile !== this.tileOf(p) && this.headTo(p, tile);
  }

  /**
   * The crate a forklift or dockhand takes, or the place it sets one down:
   * the last there, or the next place after it, as each shows its crates
   * in order; in crate storage a forklift's whole pallet (see storage).
   */
  crateAt(p: Dockhand, pick: boolean): HandAt | undefined {
    const last = (n: number) => (pick ? n - 1 : n);
    const store = (b: Bay): HandAt | undefined => {
      const held = heldIn(b);
      if (last(held) < 0) return undefined;
      if (p.kind !== 'forklift') return { store: b.idx, slot: this.crateSlot(b, last(held)) };
      const place = pick
        ? this.palletPlaces(b)[this.pickPallet(b, !!p.outbound, p)]
        : Math.floor(this.crateSlot(b, held) / B.FORKLIFT_CAPACITY);
      return { store: b.idx, place };
    };
    const onBoat = (b: Boat): HandAt => ({ truck: b.id, slot: last(b.crates + (b.out ?? 0)) });
    // Ice off the back of an ice works' truck, onto the bay's stack.
    const iceTruck =
      p.truckId !== undefined && !p.truckLoad && this.trucks.find((q) => q.id === p.truckId);
    if (iceTruck) {
      const bay = this.bays.get(p.bayIdx);
      if (pick) return { truck: iceTruck.id, slot: iceTruck.cargo - 1 };
      return bay ? { bay: bay.idx, slot: heldIn(bay) } : undefined;
    }
    if (pick) {
      const crane = this.cranes.get(p.craneIdx);
      if (crane?.kind === 'jib') return { crane: crane.idx, slot: crane.stack.length - 1 };
      const boat = this.boats.find((b) => b.id === p.boatId);
      if (boat) return onBoat(boat);
      const pile = this.piles.get(p.stockIdx);
      if (pile) return { pile: pile.idx, slot: pile.crates.length - 1 };
      const bay = this.bays.get(p.stockIdx);
      if (!bay) return undefined;
      // Off a truck bay's stack, as onto a truck there; its ice, on top, for a boat.
      if (bay.tiles) return store(bay);
      return { bay: bay.idx, slot: last(p.outbound ? heldIn(bay) : bay.crates.length) };
    }
    // Onto a truck it is loading.
    const truck = p.truckId !== undefined && this.trucks.find((q) => q.id === p.truckId);
    if (truck) return { truck: truck.id, slot: truck.cargo };
    const boat =
      p.toBoat !== undefined && p.toBoat >= 0 && this.boats.find((b) => b.id === p.toBoat);
    if (boat) return onBoat(boat);
    const pile = this.piles.get(p.bayIdx);
    if (pile) return { pile: pile.idx, slot: pile.crates.length };
    const bay = this.bays.get(p.bayIdx);
    if (!bay) return undefined;
    const onto = this.straightOnto(p, bay);
    if (onto) return { truck: onto.id, slot: onto.cargo };
    return bay.tiles ? store(bay) : { bay: bay.idx, slot: bay.crates.length };
  }

  /** Where a stacker or tractor is taking a container from, or setting one down. */
  handAt(p: Dockhand, pick: boolean): HandAt | undefined {
    const first = (y: Bay) => (y.tiles ?? [y.idx])[0];
    // Under a yard gantry, a tractor stands along the lane for it to lift.
    const lane = (y: Bay): HandAt => {
      const along = p.kind === 'tractor' ? this.laneHeading(y) : undefined;
      return along === undefined ? { yard: first(y) } : { yard: first(y), along };
    };
    if (p.truckId !== undefined) {
      const t = this.trucks.find((q) => q.id === p.truckId);
      const yard = this.yards.get(p.bayIdx);
      if (!t || !yard) return undefined;
      // Off the stack onto the truck, or off the truck onto the stack.
      if (pick !== !!p.truckLoad) return { truck: t.id, slot: pick ? t.cargo - 1 : t.cargo };
      if (!pick) return { yard: first(yard), place: this.stackedAt(p, yard) };
      const at = this.clearTop(yard, this.reachFrom(yard, p.goal));
      if (at < 0) return undefined;
      const place = this.yardSlots(yard).boxes[at];
      return { yard: first(yard), look: this.boxLooks(yard)[at], place };
    }
    if (pick) {
      const crane = this.cranes.get(p.craneIdx);
      if (crane)
        return (
          this.craneHand(p, crane) ?? {
            crane: crane.idx,
            look: this.stackLooks(crane)[Math.max(0, takingAt(this, p, crane))],
          }
        );
      const yard = this.yards.get(p.stockIdx);
      if (!yard || !p.outbound) return undefined;
      const reach = p.kind === 'stacker' ? this.reachFrom(yard, p.goal) : undefined;
      const at = Math.max(0, this.yardTop(yard, true, undefined, reach));
      const place = this.yardSlots(yard).exports[at];
      return { ...lane(yard), look: this.exportLooks(yard)[at], place };
    }
    if (p.toCrane !== undefined && p.toCrane >= 0) {
      const crane = this.cranes.get(p.toCrane);
      const place = crane && crane.kind !== 'jib' ? nextCranePlace(this, crane, true) : undefined;
      return (crane && this.craneHand(p, crane)) ?? { crane: p.toCrane, place };
    }
    if (p.toBoat !== undefined && p.toBoat >= 0) return undefined;
    const yard = this.yards.get(p.bayIdx);
    if (!yard) return undefined;
    // Where it will be stacked, by when customs clear it.
    const ready = p.outbound
      ? undefined
      : (p.cargoReady?.[0] ?? customsFor(this, p.cargoFrom?.[0]));
    return { ...lane(yard), place: this.stackedAt(p, yard, ready) };
  }

  /**
   * The place in a yard a container a machine sets down goes: a stacker's
   * on a stack it reaches from where it stands, if there is room on one.
   */
  stackedAt(p: Dockhand, yard: Bay, ready?: number): number {
    const { boxes, exports } = this.yardSlots(yard);
    const reach = p.kind === 'stacker' ? this.reachFrom(yard, p.goal) : undefined;
    const at = reach ? this.freeYardSlot(yard, boxes, exports, ready, reach) : -1;
    return at >= 0 ? at : this.freeYardSlot(yard, boxes, exports, ready);
  }

  /**
   * Where a stacker standing at `at` sets a container clearing at `ready`
   * down in a yard without burying one cleared sooner: on a stack it
   * reaches from there, or -1.
   */
  cleanSlot(yard: Bay, at: number, ready: number): number {
    const { boxes, exports } = this.yardSlots(yard);
    return this.freeYardSlot(yard, boxes, exports, ready, this.reachFrom(yard, at), true);
  }

  /**
   * A tractor under a gantry crane stands where it is, in the bay between
   * the legs, lined up along the quay for the crane to lift onto or off it.
   */
  craneHand(p: Dockhand, c: Crane): HandAt | undefined {
    if (p.kind !== 'tractor' || c.kind === 'jib') return undefined;
    return { crane: c.idx, along: this.quayHeading(c) };
  }

  /**
   * Where a machine stands to work a place on a gantry crane's stack: on
   * the landward row of its rails, behind the stack the place is in.
   */
  besideStack(c: Crane, place: number): number {
    const m = this.map;
    const along = (place % craneStacks(c)) % B.GANTRY_RAILS;
    const back = gantryRails(m, c.idx, m.orient[c.idx] & 3)[along * 2 + 1];
    return back >= 0 && Number.isFinite(this.driveCost(back)) ? back : pickTile(this, c);
  }

  /** Which way the quay edge a container crane stands on runs, as a heading. */
  quayHeading(c: Crane): number {
    const m = this.map;
    if (c.kind === 'gantry') {
      const [a, r] = footprint(m, 'gantryCrane', c.idx, m.orient[c.idx] & 3);
      return Math.atan2(m.yOf(r) - m.yOf(a), m.xOf(r) - m.xOf(a));
    }
    const sea = m.neighbors4(c.idx).find((n) => m.ocean[n] === 1 && m.build[n] === Build.None);
    if (sea === undefined) return 0;
    return Math.atan2(m.xOf(sea) - m.xOf(c.idx), -(m.yOf(sea) - m.yOf(c.idx)));
  }

  /**
   * Where a terminal tractor waits for a crane to lift a container onto it
   * or off it: in the bay between a gantry crane's legs; beside a harbour
   * crane on the quay, along it, clear of the crane and its stack, on a
   * side no other tractor has if it can.
   */
  craneSpot(p: Dockhand, c: Crane, drop = false): number {
    // A stacker at a gantry crane goes along it to the stack it works: the
    // export on top it takes, or the next place for one it brings.
    if (p.kind === 'stacker' && c.kind === 'gantry') {
      const place = drop
        ? nextCranePlace(this, c, true)
        : cranePlaces(this, c).stack[craneTop(this, c, false)];
      return place === undefined || place < 0 ? pickTile(this, c) : this.besideStack(c, place);
    }
    // A tractor at a gantry crane lines up along its rails behind the
    // stack, beside the containers. Never turning about on the way, it
    // drives on along the row and out the far end: it goes as far along
    // as it can before another standing there, or going there, so those
    // after it stop short of it rather than wait to get past.
    if (p.kind === 'tractor' && c.kind === 'gantry') {
      const lane = this.craneLane(c);
      const stack = this.craneStackTiles();
      const here = this.tileOf(p);
      const free = (t: number) => !this.spotTaken(t, p) && !stack.has(t);
      let deepest = -1;
      for (const t of [...lane].sort((a, b) => this.dist(here, a) - this.dist(here, b))) {
        if (!free(t)) break;
        deepest = t;
      }
      return deepest >= 0 ? deepest : (lane.find(free) ?? lane[0] ?? pickTile(this, c));
    }
    if (p.kind !== 'tractor' || c.kind !== 'harbour') return pickTile(this, c);
    const m = this.map;
    const a = this.quayHeading(c);
    const [dx, dy] = [Math.round(Math.cos(a)), Math.round(Math.sin(a))];
    const sides: number[] = [];
    for (const sign of [1, -1]) {
      const x = m.xOf(c.idx) + dx * sign;
      const y = m.yOf(c.idx) + dy * sign;
      if (!m.inBounds(x, y)) continue;
      const t = m.idx(x, y);
      if (Number.isFinite(this.driveCost(t)) && !isCrane(m.build[t])) sides.push(t);
    }
    // The side no other tractor has, if one is free.
    return sides.find((t) => !this.spotTaken(t, p)) ?? sides[0] ?? pickTile(this, c);
  }

  /**
   * The row a gantry crane's rails run along behind its stack, on the
   * landward side of the containers it sets down: where tractors line up
   * along the quay for it to lift onto or off, the length of its rails. The
   * machines' ground only, nearest the bay between its legs first.
   */
  craneLane(c: Crane): number[] {
    const m = this.map;
    const pick = pickTile(this, c);
    const ground = this.machineGround();
    return gantryRails(m, c.idx, m.orient[c.idx] & 3)
      .filter((t, k) => k % 2 === 1 && t >= 0 && ground.has(t))
      .sort((a, b) => this.dist(pick, a) - this.dist(pick, b));
  }

  /** Which way the lane under a yard's gantry runs, as a heading; see gantryLane. */
  laneHeading(y: Bay): number | undefined {
    const m = this.map;
    const area = new Set(y.tiles ?? [y.idx]);
    const g = m.build.findIndex(
      (b, i) => b === Build.YardGantry && m.neighbors4(i).some((n) => area.has(n)),
    );
    if (g < 0) return undefined;
    const into = m.neighbors4(g).find((n) => area.has(n))!;
    return Math.atan2(m.xOf(g) - m.xOf(into), m.yOf(into) - m.yOf(g));
  }

  /**
   * A terminal tractor a yard's gantry is lifting a container off, or
   * exports onto. They come before the trucks: the ships are waiting.
   */
  gantryTractor(y: Bay): Dockhand | undefined {
    let best: Dockhand | undefined;
    for (const p of this.people) {
      const at =
        p.kind === 'tractor' &&
        ((p.state === 'dropping' && p.bayIdx === y.idx) ||
          (p.state === 'picking' && p.stockIdx === y.idx));
      if (at && (!best || this.fromGantry(y, p.goal) < this.fromGantry(y, best.goal))) best = p;
    }
    return best;
  }

  /**
   * A truck's or tractor's load as it looks while a yard gantry lifts: one
   * fewer once taken off, one more once set down.
   */
  liftedLoad(
    load: number,
    looks: number[] | undefined,
    lift: GantryWork | undefined,
  ): { load: number; looks?: number[] } {
    const p = lift?.workPhase ?? 0;
    const { taken, set } = liftMarks(lift?.workLegs);
    if (lift?.working === 'unload' && p >= taken) {
      return { load: load - 1, looks: looks?.slice(0, load - 1) };
    }
    if (lift?.working === 'load' && p >= set && lift.workLook !== undefined) {
      return { load: load + 1, looks: looks && [...looks, lift.workLook] };
    }
    return { load, looks };
  }

  /**
   * A yard's containers as they look, and its gantry at work: less the one
   * it has taken up to load, plus one it has set down off a truck.
   */
  yardLooks(
    y: Bay,
    lifts: Map<number, GantryWork & { yard: number }>,
  ): GantryWork & { looks: number[]; slots: number[]; lifted: number; workYard?: number } {
    const looks = [...this.boxLooks(y), ...this.exportLooks(y)];
    const { boxes, exports } = this.yardSlots(y);
    const slots = [...boxes, ...exports];
    const w = [...lifts.values()].find((l) => l.yard === y.idx) ?? this.gantryWork(y);
    const p = w.workPhase ?? 0;
    const { taken, set } = liftMarks(w.workLegs);
    let lifted = 0;
    // Where in the yard the container it moves is, or goes.
    const workYard =
      w.working === 'load'
        ? slots[looks.indexOf(w.workLook ?? -1)]
        : w.working === 'unload'
          ? (w.workYard ?? this.nextYardSlot(y))
          : undefined;
    if (w.working === 'load' && p >= taken) {
      const k = looks.indexOf(w.workLook ?? -1);
      if (k >= 0) {
        looks.splice(k, 1);
        slots.splice(k, 1);
      }
      lifted = -1;
    } else if (w.working === 'unload' && p >= set && w.workLook !== undefined) {
      looks.push(w.workLook);
      slots.push(workYard ?? this.nextYardSlot(y));
      lifted = 1;
    }
    const { working, workLook, workAt, workTruck, workSlot, workPhase, workLegs, workTicks } = w;
    return {
      looks,
      slots,
      lifted,
      working,
      workLook,
      workAt,
      workTruck,
      workSlot,
      workPhase,
      workYard,
      workLegs,
      workTicks,
      workStart: w.workStart,
    };
  }

  /**
   * At a yard with a gantry, waiting while it works another truck or a
   * tractor; else it has the gantry lift for it. Between lifts, a tractor
   * goes first, then the trucks in turn.
   */
  gantryElsewhere(t: Truck, bay: Bay): boolean {
    if (!t.boxes || !bay.yard || !this.yardGantry(bay)) return false;
    const on = this.gantryHolder(bay);
    if (on) return on !== t;
    // Still setting down one it lifted off another.
    if (bay.gantryHeld) return true;
    if (this.gantryTractor(bay) !== undefined || this.gantryTruck(bay) !== t) return true;
    bay.gantryOn = t.id;
    // Loading, the container it takes up, whatever customs clear meanwhile;
    // unloading, where it goes.
    t.lifting = t.state === 'loading' ? this.boxLooks(bay)[this.clearTop(bay)] : undefined;
    if (t.state === 'delivering') this.keepGantryTo(bay, this.nextYardSlot(bay));
    // Along its rails to the container, and with it to where it goes.
    const lane = this.gantryLane(bay)?.get(t.goal) ?? 0;
    if (t.state === 'loading') {
      const k = this.clearTop(bay);
      this.startLift(bay, this.slotAlong(bay, this.yardSlots(bay).boxes[k]), lane);
    } else this.startLift(bay, lane, this.slotAlong(bay, bay.gantryTo));
    return false;
  }

  /**
   * The truck or tractor a yard's gantry is part way through a lift for,
   * still there; it lifts for one at a time and sees each lift through,
   * so a container it has taken up is set down where it was going.
   */
  gantryHolder(y: Bay): Vehicle | undefined {
    const id = y.gantryOn;
    if (id === undefined) return undefined;
    const t = this.trucks.find((q) => q.id === id);
    const p = t ? undefined : this.people.find((q) => q.id === id);
    const there = t
      ? t.bayIdx === y.idx && (t.state === 'loading' || t.state === 'delivering')
      : !!p &&
        p.kind === 'tractor' &&
        ((p.state === 'picking' && p.stockIdx === y.idx) ||
          (p.state === 'dropping' && p.bayIdx === y.idx));
    if (!there) {
      y.gantryOn = y.gantryTo = undefined;
      if (y.gantryLift) y.gantryAt = y.gantryLift.to;
      y.gantryLift = undefined;
    }
    return there ? (t ?? p) : undefined;
  }

  /**
   * Whether a tractor picking up or setting down at a yard has its gantry
   * lifting for it, taking it on if it is free; true anywhere else.
   */
  gantryFor(p: Dockhand): boolean {
    if (p.kind !== 'tractor') return true;
    const y = this.yards.get(p.state === 'picking' ? p.stockIdx : p.bayIdx);
    if (!y || !this.yardGantry(y)) return true;
    const on = this.gantryHolder(y);
    if (on) return on === p;
    // Still setting down one it lifted off another.
    if (y.gantryHeld) return false;
    y.gantryOn = p.id;
    const lane = this.gantryLane(y)?.get(p.goal) ?? 0;
    // Setting one down, where it goes, by when customs clear it; taking
    // exports up, the one on top. It takes as long as its way along the rails.
    // Lifted off, the tractor need wait only until the spreader has it.
    if (p.state === 'dropping') {
      this.keepGantryTo(y, this.stackedAt(p, y, customsFor(this, p.cargoFrom?.[0])));
      this.startLift(y, lane, this.slotAlong(y, y.gantryTo));
      p.timer = Math.max(1, this.takenIn(y));
    } else {
      const top = this.yardTop(y, true);
      p.timer = this.startLift(y, this.slotAlong(y, this.yardSlots(y).exports[top]), lane);
    }
    return true;
  }

  /** Keep a place in a yard for the container its gantry sets down. */
  keepGantryTo(y: Bay, at: number): void {
    y.gantryTo = at >= 0 ? at : undefined;
  }

  /**
   * A lift done: the gantry is free for the next. Returns the place it kept
   * in the yard for the container it set down, if it did.
   */
  gantryDone(bay: Bay | undefined, id: number): number | undefined {
    if (bay?.gantryOn !== id) return undefined;
    const to = bay.gantryTo;
    bay.gantryOn = bay.gantryTo = undefined;
    // It stands where it set the container down, for the next.
    if (bay.gantryLift) bay.gantryAt = bay.gantryLift.to;
    bay.gantryLift = undefined;
    return to;
  }

  /** Ticks a truck takes to load or unload one at a bay or yard: a yard gantry lifts at its own pace. */
  truckTicks(t: Truck, bay: Bay): number {
    return t.boxes && bay.yard && this.yardGantry(bay) ? B.YARD_GANTRY_TICKS : loadTicks(bay);
  }

  /** A container truck at a yard with no gantry, which reach stackers load or unload. */
  byStacker(t: Truck, bay: Bay): boolean {
    return t.boxes && !!bay.yard && !this.yardGantry(bay);
  }

  /**
   * A crate truck at a truck bay or crate storage, which only dockhands and
   * forklifts load: it has no crew of its own.
   */
  byHand(t: Truck, bay: Bay): boolean {
    return !t.boxes && !bay.yard && !bay.pile;
  }

  /**
   * A crate truck loading at the truck bay a dockhand or forklift brings
   * crates to, with room for them all: they go straight onto it.
   */
  straightOnto(p: Dockhand, bay: Bay): Truck | undefined {
    if (isBoxy(p) || p.outbound || p.truckId !== undefined || bay.tiles || p.carrying <= 0) {
      return undefined;
    }
    // Only onto a truck that may take that kind of crate.
    return this.trucks.find(
      (t) =>
        t.state === 'loading' &&
        t.bayIdx === bay.idx &&
        p.cargoFees.every(this.fitsTruck(t)) &&
        this.byHand(t, bay) &&
        t.cargo + (t.coming ?? 0) + p.carrying <= t.capacity,
    );
  }

  /**
   * Whether someone else is at work at this truck bay, setting crates down
   * on its stack or loading the truck in it: only one at a time works one.
   */
  bayTaken(p: Dockhand, bay: Bay): boolean {
    if (bay.tiles || bay.yard || bay.pile) return false;
    return this.people.some(
      (q) =>
        q !== p &&
        ((q.state === 'dropping' && q.bayIdx === bay.idx) ||
          (q.truckId !== undefined && q.stockIdx === bay.idx && q.state === 'picking')),
    );
  }

  /**
   * Crate trucks waiting to be loaded, for dockhands and forklifts; and ice
   * works' trucks waiting in a truck bay to be unloaded, their ice set on its
   * stack for the fishing boats.
   */
  crateTruckSources(sources: Source[]): void {
    for (const t of this.trucks) {
      if (t.state === 'delivering' && this.iceTruck(t)) {
        const bay = this.dest(t.bayIdx);
        const avail = t.cargo - (t.taking ?? 0);
        if (bay && truckBay(bay) && avail > 0) {
          sources.push({ tile: bay.idx, avail, truck: t, load: false, rank: 1 });
        }
        continue;
      }
      if (t.state !== 'loading') continue;
      const bay = this.dest(t.bayIdx);
      if (!bay || !this.byHand(t, bay)) continue;
      // Loaded from the stack till it is full or the stack is gone; crates
      // brought meanwhile go straight on while there is room on it.
      const avail = Math.min(t.capacity - t.cargo - (t.coming ?? 0), this.cratesFor(t, bay));
      if (avail <= 0) continue;
      // Once the boats are seen to, nearest first, as crates in storage are.
      sources.push({ tile: this.crateTruckSpot(bay, t), avail, truck: t, load: true, rank: 1 });
    }
  }

  /** Whether a business in town still takes crates of this kind today. */
  wantedToday(c: Cargo): boolean {
    const wants = this.town?.wants ?? {};
    for (const [code, n] of Object.entries(wants)) {
      if ((n ?? 0) >= 1 && BUSINESSES[Number(code)]?.takes.includes(c)) return true;
    }
    return false;
  }

  /**
   * Which crates a crate truck may take on: only those of its kind, so
   * whatever it brings the town is all for one business; but any, once
   * the town takes no more of its kind or theirs today, as then they all go
   * out by road.
   */
  fitsTruck(t: Truck): (fee: number) => boolean {
    const kind = t.kind;
    if (!kind) return () => true;
    const mine = this.wantedToday(kind);
    const wanted = new Map<Cargo, boolean>();
    return (fee) => {
      const c = cargoOf(fee);
      if (c === kind) return true;
      if (mine) return false;
      if (!wanted.has(c)) wanted.set(c, this.wantedToday(c));
      return !wanted.get(c);
    };
  }

  /**
   * Crates at a bay a crate truck could still have, of the kind it takes,
   * that no dockhand or forklift is already going for.
   */
  cratesFor(t: Truck, bay: Bay): number {
    // Crates still in customs wait: no truck may have them yet.
    const free = this.readyIn(bay, false) - (bay.reserved ?? 0);
    if (!t.kind || free <= 0) return free;
    const fits = this.fitsTruck(t);
    const wait = this.waitMask(bay, false);
    let n = 0;
    bay.crates.forEach((f, i) => {
      if (!wait[i] && fits(f)) n++;
    });
    return Math.min(free, n);
  }

  /**
   * Up to `n` crates off a bay for a crate truck: those from `at` on, as
   * long as it may take them all; else the first it may take. The first it
   * ever takes sets its kind.
   */
  cratesOff(t: Truck, bay: Bay, at: number, n: number): number[] {
    if (n <= 0 || bay.crates.length === 0) return [];
    // Never one still in customs.
    const wait = this.waitMask(bay, false);
    if (at >= bay.crates.length || wait[at]) at = wait.indexOf(false);
    if (at < 0) return [];
    t.kind ??= cargoOf(bay.crates[at]);
    return this.takeReady(bay, false, at, n, this.fitsTruck(t));
  }

  /**
   * Where a dockhand or forklift loading a crate truck takes the crates
   * from: the truck bay it stands in, or the tile of the crate storage
   * beside where it stands, nearest it.
   */
  crateTruckSpot(bay: Bay, t: Truck): number {
    if (!bay.tiles) return bay.idx;
    const at = this.tileOf(t);
    const m = this.map;
    return [...bay.tiles].sort(
      (a, b) =>
        Math.hypot(m.xOf(a) - m.xOf(at), m.yOf(a) - m.yOf(at)) -
        Math.hypot(m.xOf(b) - m.xOf(at), m.yOf(b) - m.yOf(at)),
    )[0];
  }

  /** Send a dockhand or forklift to load a crate truck: as many as it carries a trip. */
  takeCrateTruckJob(p: Dockhand, src: Source): boolean {
    const t = src.truck!;
    const bay = this.dest(t.bayIdx);
    // One at a time loads a truck bay's trucks, however many stand about
    // there waiting to set crates down.
    if (!bay) return false;
    if (bay.tiles && this.workersAt(src.tile) >= B.WORKERS_PER_SPOT) return false;
    if (
      !bay.tiles &&
      this.people.some((q) => q !== p && q.truckId !== undefined && q.stockIdx === bay.idx)
    ) {
      return false;
    }
    if (isMachine(p) && this.nearerMachine(p, src.tile)) return false;
    // Off an ice works' truck onto the bay's stack: as many as it carries.
    const unload = !src.load;
    const room = unload
      ? t.cargo - (t.taking ?? 0)
      : Math.min(t.capacity - t.cargo - (t.coming ?? 0), this.cratesFor(t, bay));
    const n = Math.min(p.capacity, src.avail, room);
    if (n <= 0) return false;
    if (!this.headTo(p, src.tile)) return false;
    if (unload) t.taking = (t.taking ?? 0) + n;
    else {
      bay.reserved = (bay.reserved ?? 0) + n;
      t.coming = (t.coming ?? 0) + n;
    }
    p.truckId = t.id;
    p.truckLoad = !unload;
    p.bayIdx = bay.idx;
    p.stockIdx = bay.idx;
    p.planned = n;
    p.boatId = -1;
    p.craneIdx = -1;
    p.state = 'toPickup';
    return true;
  }

  /**
   * A dockhand or forklift loading a crate truck: to the crates, picks them
   * up, and sets them on the truck beside it. True while it is at it.
   */
  crateTruckJob(p: Dockhand): boolean {
    const t = this.trucks.find((q) => q.id === p.truckId);
    const bay = this.dest(p.bayIdx);
    const unload = !p.truckLoad;
    const live =
      !!t && !!bay && t.bayIdx === bay.idx && t.state === (unload ? 'delivering' : 'loading');
    if (unload) return this.iceTruckJob(p, t, bay, live);
    switch (p.state) {
      case 'toPickup': {
        if (!live) {
          this.cancelJob(p);
          return true;
        }
        const r = this.walk(p);
        if (r === 'blocked') this.cancelJob(p);
        else if (r === 'arrived' && !this.bayTaken(p, bay)) {
          p.state = 'picking';
          p.timer = this.handlingTicks(p, B.PICK_TICKS);
        }
        return true;
      }
      case 'picking': {
        if (--p.timer > 0) return true;
        if (!live) {
          this.cancelJob(p);
          return true;
        }
        bay.reserved = Math.max(0, (bay.reserved ?? 0) - p.planned);
        const n = Math.min(p.planned, bay.crates.length, this.onPallet(p, bay));
        const fees = this.cratesOff(t, bay, bay.tiles ? this.takenFrom(p, bay, n) : 0, n);
        // Fewer than it went for: the truck waits for none of the rest.
        t.coming = Math.max(0, (t.coming ?? 0) - (p.planned - fees.length));
        if (fees.length === 0) {
          this.endTruckJob(p);
          return true;
        }
        p.planned = fees.length;
        p.carrying = fees.length;
        p.cargoFees = fees;
        // The truck is right beside it.
        p.state = 'dropping';
        p.timer = this.handlingTicks(p, B.DROP_TICKS);
        return true;
      }
      case 'dropping': {
        if (--p.timer > 0) return true;
        this.landCrates(p, t, bay, live);
        this.endTruckJob(p);
        return true;
      }
    }
    return false;
  }

  /**
   * A dockhand or forklift unloading an ice works' truck: to the truck in
   * the bay, takes the ice off its back, and sets it on the bay's stack for
   * the fishing boats. True while it is at it.
   */
  iceTruckJob(p: Dockhand, t: Truck | undefined, bay: Bay | undefined, live: boolean): boolean {
    switch (p.state) {
      case 'toPickup': {
        if (!live) {
          this.releaseTruckJob(p);
          return true;
        }
        const r = this.walk(p);
        if (r === 'blocked') this.releaseTruckJob(p);
        else if (r === 'arrived' && !this.bayTaken(p, bay!)) {
          p.state = 'picking';
          p.timer = this.handlingTicks(p, B.PICK_TICKS);
        }
        return true;
      }
      case 'picking': {
        if (--p.timer > 0) return true;
        if (!live) {
          this.releaseTruckJob(p);
          return true;
        }
        const n = Math.min(p.planned, t!.cargo);
        t!.taking = Math.max(0, (t!.taking ?? 0) - p.planned);
        t!.cargo -= n;
        if (n === 0) {
          this.endTruckJob(p);
          return true;
        }
        p.planned = n;
        p.carrying = n;
        p.cargoFees = Array(n).fill(t!.value);
        // The bay's stack is right beside the truck.
        p.state = 'dropping';
        p.timer = this.handlingTicks(p, B.DROP_TICKS);
        return true;
      }
      case 'dropping': {
        if (--p.timer > 0) return true;
        this.landIce(p, bay);
        this.endTruckJob(p);
        return true;
      }
    }
    return false;
  }

  /** Ice a dockhand or forklift has off an ice works' truck: onto the bay's stack, for the boats. */
  landIce(p: Dockhand, bay: Bay | undefined): void {
    if (p.carrying <= 0 || !bay) return;
    for (const fee of p.cargoFees) {
      this.exportLooks(bay).push(boxLookOf(p.id, 0));
      (bay.exports ??= []).push(fee);
    }
    bay.exportIncoming = Math.max(0, (bay.exportIncoming ?? 0) - p.carrying);
    tip(this, 'exports');
  }

  /** Crates a dockhand or forklift has for a truck: on it if it is still loading, else back where they came from. */
  landCrates(p: Dockhand, t: Truck | undefined, bay: Bay | undefined, live: boolean): void {
    if (p.carrying <= 0) return;
    if (t) t.coming = Math.max(0, (t.coming ?? 0) - p.carrying);
    if (live && t) {
      t.cargo += p.carrying;
      t.value += p.cargoFees.reduce((n, f) => n + f, 0);
      (t.fees ??= []).push(...p.cargoFees);
      t.idle = 0;
    } else if (bay) bay.crates.push(...p.cargoFees);
  }

  /** Trucks waiting at yards with no gantry, for reach stackers to load or unload. */
  truckSources(sources: Source[]): void {
    for (const t of this.trucks) {
      const load = t.state === 'loading';
      if (!load && t.state !== 'delivering') continue;
      const yard = this.yards.get(t.bayIdx);
      if (!yard || !this.byStacker(t, yard)) continue;
      const avail = load
        ? Math.min(
            t.capacity - t.cargo - (t.coming ?? 0),
            this.reachable(yard) - (yard.truckReserved ?? 0),
          )
        : t.cargo - (t.taking ?? 0);
      if (avail <= 0) continue;
      // A truck was only sent in because a stacker was free for it: it comes first.
      for (const tile of this.besideTruck(yard, t, load)) {
        sources.push({ tile, avail, truck: t, load, rank: -1 });
      }
    }
  }

  /**
   * Where a stacker may stand to work a truck at a yard: beside the edge
   * of the stacks, by a stack with a cleared container on top to load it
   * with, or room for one off it; nearest the truck first.
   */
  besideTruck(yard: Bay, t: Truck, load: boolean): number[] {
    const m = this.map;
    const near = (i: number) => Math.hypot(m.xOf(i) + 0.5 - t.x, m.yOf(i) + 0.5 - t.y);
    const spots = new Set<number>();
    (yard.tiles ?? [yard.idx]).forEach((tile, n) => {
      const reach = new Set([n]);
      const fits = load
        ? this.clearTop(yard, reach) >= 0
        : this.nextYardSlot(yard, undefined, reach) >= 0;
      if (!fits) return;
      for (const s of this.stackSides(yard, tile)) spots.add(s);
    });
    return [...spots].sort((a, b) => near(a) - near(b)).slice(0, 4);
  }

  /** Send a stacker to load a truck at a yard, or unload one: one container a trip. */
  takeTruckJob(p: Dockhand, src: Source): boolean {
    const t = src.truck!;
    const yard = this.yards.get(t.bayIdx);
    // One stacker at a time works a truck; a nearer free one takes it.
    if (!yard || this.workersAt(src.tile) > 0 || this.nearerMachine(p, src.tile)) return false;
    if (!this.headTo(p, src.tile)) return false;
    if (src.load) {
      yard.truckReserved = (yard.truckReserved ?? 0) + 1;
      t.coming = (t.coming ?? 0) + 1;
    } else t.taking = (t.taking ?? 0) + 1;
    p.truckId = t.id;
    p.truckLoad = !!src.load;
    p.bayIdx = yard.idx;
    p.planned = 1;
    p.boatId = -1;
    p.craneIdx = -1;
    p.stockIdx = -1;
    p.state = 'toPickup';
    return true;
  }

  /**
   * A stacker moving a container between a yard and the truck beside it:
   * off the stack onto the truck, or off a shipper's truck onto the stack.
   * True while it is at it.
   */
  truckJob(p: Dockhand): boolean {
    const t = this.trucks.find((q) => q.id === p.truckId);
    const yard = this.yards.get(p.bayIdx);
    const live =
      !!t &&
      !!yard &&
      t.bayIdx === yard.idx &&
      t.state === (p.truckLoad ? 'loading' : 'delivering');
    switch (p.state) {
      case 'toPickup': {
        if (!live) {
          this.cancelJob(p);
          return true;
        }
        const r = this.walk(p);
        if (r === 'blocked') this.cancelJob(p);
        else if (r === 'arrived') {
          p.state = 'picking';
          p.timer = this.handlingTicks(p, B.PICK_TICKS);
        }
        return true;
      }
      case 'picking': {
        if (--p.timer > 0) return true;
        if (!live) {
          this.cancelJob(p);
          return true;
        }
        let fee: number | undefined;
        if (p.truckLoad) {
          yard.truckReserved = Math.max(0, (yard.truckReserved ?? 0) - 1);
          // Only what customs have cleared, whichever that is.
          const ready = this.readyList(yard);
          const at = this.clearTop(yard, this.reachFrom(yard, p.goal));
          if (at >= 0) {
            this.yardSlots(yard).boxes.splice(at, 1);
            ready.splice(at, 1);
            p.cargoLooks = this.boxLooks(yard).splice(at, 1);
            fee = yard.boxes.splice(at, 1)[0];
          } else t.coming = Math.max(0, (t.coming ?? 0) - 1);
        } else {
          t.taking = Math.max(0, (t.taking ?? 0) - 1);
          if (t.cargo > 0) {
            t.cargo--;
            fee = t.value;
            p.cargoLooks = [boxLookOf(t.id, t.cargo)];
          }
        }
        if (fee === undefined) {
          this.endTruckJob(p);
          return true;
        }
        p.carrying = 1;
        p.cargoFees = [fee];
        // The truck is right there: straight on, or straight down.
        p.state = 'dropping';
        p.timer = this.handlingTicks(p, B.DROP_TICKS);
        return true;
      }
      case 'dropping': {
        if (--p.timer > 0) return true;
        this.landTruckLoad(p, t, yard, live);
        this.endTruckJob(p);
        return true;
      }
    }
    return false;
  }

  /**
   * Set down what a stacker took from a yard or a truck: on the truck if it
   * is still there to load, else back on the stack; exports onto the stack.
   */
  landTruckLoad(p: Dockhand, t: Truck | undefined, yard: Bay | undefined, live: boolean): void {
    const fee = p.cargoFees[0];
    if (fee === undefined) return;
    if (p.truckLoad) {
      if (t) t.coming = Math.max(0, (t.coming ?? 0) - 1);
      if (live && t) {
        t.cargo++;
        t.value += fee;
        (t.looks ??= []).push(...this.carriedLooks(p));
        t.idle = 0;
      } else if (yard) {
        this.readyList(yard).push(0);
        this.boxLooks(yard).push(...this.carriedLooks(p));
        yard.boxes.push(fee);
      }
    } else if (yard) {
      // On a stack it reaches from where it stands, if it can.
      const slots = this.yardSlots(yard);
      const at = this.stackedAt(p, yard);
      if (at >= 0) slots.exports.push(at);
      this.exportLooks(yard).push(...this.carriedLooks(p));
      (yard.exports ??= []).push(fee);
      yard.exportIncoming = Math.max(0, (yard.exportIncoming ?? 0) - 1);
    }
  }

  /** Give back what a truck job promised, setting down anything in hand. */
  releaseTruckJob(p: Dockhand): void {
    if (p.truckId === undefined) return;
    const t = this.trucks.find((q) => q.id === p.truckId);
    if (!isBoxy(p) && !p.truckLoad) {
      // Ice off a truck: on the stack anyway, or the promise given back.
      if (p.carrying > 0) this.landIce(p, this.dest(p.bayIdx));
      else if (t) t.taking = Math.max(0, (t.taking ?? 0) - p.planned);
      return this.endTruckJob(p);
    }
    if (!isBoxy(p)) {
      // Crates for a truck: back where they came from, or the promise given back.
      const bay = this.dest(p.bayIdx);
      if (p.carrying > 0) this.landCrates(p, t, bay, false);
      else {
        if (bay) bay.reserved = Math.max(0, (bay.reserved ?? 0) - p.planned);
        if (t) t.coming = Math.max(0, (t.coming ?? 0) - p.planned);
      }
      return this.endTruckJob(p);
    }
    const yard = this.yards.get(p.bayIdx);
    if (p.carrying > 0) this.landTruckLoad(p, t, yard, false);
    else if (p.truckLoad) {
      if (yard) yard.truckReserved = Math.max(0, (yard.truckReserved ?? 0) - 1);
      if (t) t.coming = Math.max(0, (t.coming ?? 0) - 1);
    } else if (t) t.taking = Math.max(0, (t.taking ?? 0) - 1);
    this.endTruckJob(p);
  }

  endTruckJob(p: Dockhand): void {
    p.truckId = undefined;
    p.truckLoad = undefined;
    p.carrying = 0;
    p.cargoFees = [];
    p.planned = 0;
    p.bayIdx = -1;
    p.stockIdx = -1;
    p.state = 'idle';
  }

  // ── Tugs ──────────────────────────────────────────────

  // ── Dockhands and forklifts ───────────────────────────────

  spawnDockhand(at: number, c: Candidate): Dockhand {
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
      stockIdx: -1,
      bayIdx: -1,
      toBoat: -1,
      toCrane: -1,
    };
    this.people.push(p);
    return p;
  }

  /** Places left in a depot; a reach stacker takes two (see MACHINES). */
  depotRoom(depot: number): number {
    let used = 0;
    for (const q of this.people)
      if (q.home === depot && isMachine(q)) used += MACHINES[q.kind as MachineKind].room;
    return B.DEPOT_SLOTS - used;
  }

  /** Buy a forklift at a depot: the one at `tile`, or any with room. */
  buyMachine(kind: MachineKind, tile?: number): void {
    if (this.tier < MACHINE_TIER[kind]) {
      return message(
        this,
        `${MACHINES[kind].label}s unlock at the ${TIERS[MACHINE_TIER[kind]].name}.`,
        'bad',
      );
    }
    let depot = tile ?? -1;
    if (tile === undefined) {
      for (let i = 0; i < this.map.build.length && depot < 0; i++) {
        if (this.map.build[i] === Build.Depot && this.depotRoom(i) >= MACHINES[kind].room) {
          depot = i;
        }
      }
      if (depot < 0)
        return message(this, 'Build a forklift depot first. Forklifts live there.', 'bad');
    } else {
      const err =
        tile >= 0 && tile < this.map.build.length
          ? machinePlacementError(this.map, tile)
          : 'Off the map';
      if (err) return message(this, err, 'bad');
    }
    if (this.depotRoom(depot) < MACHINES[kind].room) {
      return message(
        this,
        `That depot is full. Each houses ${B.DEPOT_SLOTS} forklifts or tractors, a reach stacker taking two places.`,
        'bad',
      );
    }
    const spec = MACHINES[kind];
    if (this.cash < spec.price) return message(this, 'Not enough money', 'bad');
    book(this, 'construction', -spec.price);
    const p = this.spawnDockhand(depot, {
      id: 0,
      name: `${spec.label} ${this.people.filter((q) => q.kind === kind).length + 1}`,
      skill: 3,
      trait: null,
      wage: spec.wage,
    });
    p.kind = kind;
    p.capacity = spec.capacity;
    tip(this, kind === 'forklift' ? 'forklifts' : kind === 'tractor' ? 'tractors' : 'stackers');
    p.home = depot;
    moneyAt(this, -spec.price, depot);
    message(this, `A new ${spec.label.toLowerCase()} is ready at the depot.`, 'good');
  }

  /**
   * Where each machine standing in its depot is parked, side by side in
   * the garage, out of each other's way (see parkPoses): by id, for the
   * view. The game has them in the middle of the tile.
   */
  parkedPoses(): Map<number, ParkPose> {
    const out = new Map<number, ParkPose>();
    const homes = new Map<number, Dockhand[]>();
    for (const q of this.people) {
      if (!isMachine(q) || q.home < 0 || this.map.build[q.home] !== Build.Depot) continue;
      homes.set(q.home, [...(homes.get(q.home) ?? []), q]);
    }
    for (const [depot, fleet] of homes) {
      fleet.sort((a, b) => a.id - b.id);
      const m = this.map;
      const poses = parkPoses(
        fleet.map((q) => q.kind as MachineKind),
        m.xOf(depot),
        m.yOf(depot),
        m.orient[depot] & 3,
      );
      fleet.forEach((q, k) => {
        if (q.path.length === 0 && this.tileOf(q) === depot) out.set(q.id, poses[k]);
      });
    }
    return out;
  }

  /** Send a forklift home for fuel, repairs or to park. False if it cannot get there. */
  goToDepot(p: Dockhand, task: 'refuel' | 'repair' | 'park'): boolean {
    if (p.home < 0 || this.map.build[p.home] !== Build.Depot) p.home = this.findDepot(p);
    if (p.home < 0 || !this.headTo(p, p.home)) return false;
    p.depotTask = task;
    p.state = 'toDepot';
    return true;
  }

  /** A depot with room this forklift can reach, for one whose home is gone. */
  findDepot(p: Dockhand): number {
    for (let i = 0; i < this.map.build.length; i++) {
      if (
        this.map.build[i] !== Build.Depot ||
        this.depotRoom(i) < MACHINES[p.kind as MachineKind].room
      ) {
        continue;
      }
      if (this.pathFor(p, this.tileOf(p), i)) return i;
    }
    return -1;
  }

  updateForkliftAtRest(p: Dockhand): boolean {
    if (p.needsRepair) {
      p.needsRepair = false;
      p.path = [];
      // Routine: the machine says so when picked, and shows a warning sign.
      if (this.goToDepot(p, 'repair')) return true;
      // No depot to reach: a mechanic comes out, at double the price.
      this.startRepair(p, B.REPAIR_COST * 2);
      nag(
        this,
        'callout',
        `${p.name} has broken down with no depot to reach. Mechanic called out at double the price.`,
        'bad',
      );
      return true;
    }
    if (p.fuel < B.LOW_FUEL && this.goToDepot(p, 'refuel')) return true;
    return false;
  }

  startRepair(p: Dockhand, cost: number): void {
    p.state = 'broken';
    p.timer = B.REPAIR_TICKS;
    book(this, 'maintenance', -cost);
    moneyAt(this, -cost, this.tileOf(p));
  }

  /** Dockhands stay on the port: paths, jetties, quays and port buildings. */
  walkCost: CostFn = (i, from) =>
    walkableAt(this.map, i) && this.throughDoor(i, from) ? 1 : Infinity;

  /** Into and out of a depot only through its door, from the tile it faces, not through its walls. */
  throughDoor(i: number, from: number | undefined): boolean {
    if (from === undefined || from < 0 || from === i) return true;
    const m = this.map;
    if (m.build[i] === Build.Depot && frontOf(m, i, m.orient[i] & 3) !== from) return false;
    return m.build[from] !== Build.Depot || frontOf(m, from, m.orient[from] & 3) === i;
  }

  /** Forklifts need a hard surface; wooden jetties cannot take the weight. */
  /** Where port machines may be at all: port roads and quays, off the stacks in a container yard. */
  groundCost: CostFn = (i) =>
    drivable(this.map.build[i]) && !storesBoxes(this.map.store[i]) ? 1 : Infinity;

  /**
   * Port machines drive on port roads and quays, never across the stacks in
   * a container yard; and across containers a gantry crane has set down
   * along the quay only where there is no other way at all, as on a pier
   * too narrow for anything else.
   */
  driveCost: CostFn = (i, from) => {
    // Never across a yard gantry's rails, as trucks never do.
    if (from !== undefined && from >= 0 && this.crossesRails(from, i)) return Infinity;
    if (!this.throughDoor(i, from)) return Infinity;
    return this.groundCost(i) + (this.craneStackTiles().has(i) ? B.CRANE_STACK_DETOUR : 0);
  };

  /**
   * The quay with containers on it that a gantry crane has set down: on the
   * shipside row the length of its rails, which the machines work from the
   * row behind. Where none stand yet they drive freely.
   * Once a tick.
   */
  craneStackTiles(): Set<number> {
    if (this.craneStackCache?.tick !== this.tick) {
      const m = this.map;
      const at = new Set<number>();
      for (const c of this.cranes.values()) {
        if (c.kind !== 'gantry') continue;
        const rails = gantryRails(m, c.idx, m.orient[c.idx] & 3);
        const { stack, out } = cranePlaces(this, c);
        for (const k of [...stack, ...out]) {
          const t = k < 0 ? -1 : rails[((k % craneStacks(c)) % B.GANTRY_RAILS) * 2];
          if (t >= 0) at.add(t);
        }
      }
      this.craneStackCache = { tick: this.tick, at };
    }
    return this.craneStackCache.at;
  }

  costFor(p: Dockhand): CostFn {
    return isMachine(p) ? this.driveCost : this.walkCost;
  }

  walkSpeed = () => B.WALK_SPEED;

  /** Where new staff report for work and lost staff are taken back to. */
  muster(): number {
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
  rescue(p: Dockhand): boolean {
    // A machine a crane has just set a container down beside is not lost.
    const cost = isMachine(p) ? this.groundCost : this.costFor(p);
    if (Number.isFinite(cost(this.tileOf(p)))) return false;
    const at = isMachine(p) && p.home >= 0 ? p.home : this.muster();
    p.x = this.map.xOf(at) + 0.5;
    p.y = this.map.yOf(at) + 0.5;
    p.path = [];
    return true;
  }

  walk(p: Dockhand) {
    const before = this.tileOf(p);
    const laneBefore = laneOf(p.dir);
    const boxy = isBoxy(p);
    // A crane has set containers down on its way since it set off: it looks
    // again for a way round them, once for each such tile.
    const next = p.path[0];
    if (boxy && next !== undefined && next !== p.goal && next !== p.replanned) {
      if (this.craneStackTiles().has(next)) {
        p.replanned = next;
        const path = this.pathFor(p, before, p.goal);
        if (path) p.path = path;
      }
    }
    // Where another machine works, it waits its turn short of it; a reach
    // stacker or tractor otherwise keeps its distance in traffic (see
    // roomAhead), anyone else to their side of the tile.
    const junction = boxy ? this.mayEnter(p) : undefined;
    const enter = (i: number) =>
      !(boxy && i === p.goal && this.workingAt(i, p)) &&
      (junction
        ? p.squeeze || junction(i)
        : p.squeeze || this.laneFree(i, laneOf(this.headingTo(p, i))));
    let r: ReturnType<World['move']>;
    if (isMachine(p)) {
      // An empty tank still crawls home on the reserve.
      const top =
        p.kind === 'stacker'
          ? B.STACKER_SPEED
          : p.kind === 'tractor'
            ? B.TRACTOR_SPEED
            : B.FORKLIFT_SPEED;
      const speed = p.fuel > 0 ? top : top * 0.3;
      // A tractor finds a new way round as it drives, never turning about short.
      const repath =
        p.kind === 'tractor' ? () => this.pathFor(p, this.tileOf(p), p.goal) : undefined;
      const room = () =>
        boxy && !p.squeeze
          ? Math.min(this.roomAhead(p) - B.TRUCK_GAP, this.toStopLine(p))
          : Infinity;
      const [x0, y0] = [p.x, p.y];
      r = this.move(p, this.driveCost, true, () => this.drive(p, speed, room()), enter, repath);
      // Held up behind something, it is waiting as at a tile it may not enter.
      if (r === 'moving' && p.x === x0 && p.y === y0) r = 'waiting';
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
      p.came = before;
    }
    // Congestion is measured on working trips only, not strolls or breaks.
    const working = WORKING.has(p.state);
    if (r === 'waiting') {
      p.blocked++;
      if (working) this.jam.waiting++;
      if (boxy) this.resolveHold(p);
      else this.resolveJam(p);
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
  laneCap(i: number): number {
    const b = this.map.build[i];
    return isBay(b) || this.map.store[i] || b === Build.BreakHut || b === Build.Depot
      ? B.GATHER_CAP
      : 1;
  }

  laneFree(i: number, lane: number): boolean {
    return this.occupancy[i * 4 + lane] < this.laneCap(i);
  }

  /** Any lane of the tile in use at all. */
  tileBusy(i: number): boolean {
    const o = this.occupancy;
    return o[i * 4] + o[i * 4 + 1] + o[i * 4 + 2] + o[i * 4 + 3] >= this.laneCap(i);
  }

  /**
   * A reach stacker or tractor held up in traffic: after a while it looks
   * for a way round whatever is standing in its way, and if it is still
   * held up long after, it squeezes on past, so nothing is stuck for good.
   */
  resolveHold(p: Dockhand): void {
    if (p.blocked === B.REROUTE_AFTER * 2) {
      const base = this.driveCost;
      const standing = this.standingTiles();
      const cost: CostFn = (i) => base(i) + (standing.has(i) ? 8 : 0);
      const m = this.map;
      const path =
        p.kind === 'tractor'
          ? findDrivePath(m.w, m.h, this.tileOf(p), this.tileBehind(p), p.goal, cost, (i) =>
              this.roomToTurn(i),
            )
          : findPath(m.w, m.h, this.tileOf(p), p.goal, cost, true);
      if (path) p.path = path;
    } else if (p.blocked >= B.TRUCK_SQUEEZE_AFTER) p.squeeze = true;
  }

  /** Tiles where a truck or port machine is standing a while: loading, unloading or at work. */
  standingTiles(): Set<number> {
    const out = new Set<number>();
    for (const o of this.trucks) if (this.docked(o)) out.add(this.tileOf(o));
    for (const q of this.people) {
      if (isBoxy(q) && (q.state === 'picking' || q.state === 'dropping')) out.add(this.tileOf(q));
    }
    return out;
  }

  /** A machine standing idle in someone's way drives off home to park now, rather than in a while. */
  makeWay(o: Vehicle): void {
    if (!isTruck(o) && o.state === 'idle' && o.path.length === 0) o.timer = B.PARK_AFTER;
  }

  /** The port machines that drive in traffic, wherever they are other than parked at their depot. */
  machinesOnRoad(): Dockhand[] {
    return this.people.filter(
      (q) =>
        isBoxy(q) &&
        // Standing in a depot, idle, broken down or in for repair: the
        // others drive in over it.
        !(
          (q.state === 'idle' || q.path.length === 0) &&
          this.map.build[this.tileOf(q)] === Build.Depot
        ),
    );
  }

  /**
   * Room to the back of whatever is nearest ahead of a reach stacker or
   * tractor, in its lane going its way or across it: a truck, or another
   * machine. Infinity if nothing is.
   */
  roomAhead(p: Dockhand): number {
    this.passRing(p);
    p.blocker = undefined;
    let best = Infinity;
    const others: Vehicle[] = [
      ...this.trucks.filter((o) => this.onRoad(o) || this.docked(o)),
      ...this.machinesOnRoad(),
    ];
    for (const o of others) {
      if (o === p || p.passing?.ids.includes(o.id) || this.clearAcross(p, o)) continue;
      const along = this.onWay(p, o);
      if (along < 0 || (o.path.length > 0 && o.id > p.id && this.onWay(o, p) >= 0)) continue;
      this.makeWay(o);
      const gap = along - (this.vehicleLength(p) + this.vehicleLength(o)) / 2;
      if (gap < best) {
        best = gap;
        p.blocker = o.id;
      }
    }
    return best;
  }

  /**
   * Another reach stacker or terminal tractor at tile `i` to pick a load up
   * there or set one down, or pulling up onto it to: the place is its, and
   * `p` waits its turn short of it.
   */
  workingAt(i: number, p: Dockhand): Dockhand | undefined {
    return this.people.find(
      (q) =>
        q !== p &&
        isBoxy(q) &&
        this.tileOf(q) === i &&
        (q.state === 'picking' ||
          q.state === 'dropping' ||
          ((q.state === 'toPickup' || q.state === 'toDrop') && q.goal === i)),
    );
  }

  /** Whether another reach stacker or terminal tractor works at tile `i`, or is on its way to. */
  spotTaken(i: number, p: Dockhand): boolean {
    return this.people.some(
      (q) =>
        q !== p &&
        isBoxy(q) &&
        (((q.state === 'picking' || q.state === 'dropping') && this.tileOf(q) === i) ||
          ((q.state === 'toPickup' || q.state === 'toDrop') && q.goal === i)),
    );
  }

  headingTo(a: Agent, i: number): number {
    return Math.atan2(this.map.yOf(i) + 0.5 - a.y, this.map.xOf(i) + 0.5 - a.x);
  }

  /** Resting workers sit out of the way, so they do not count. */
  takesSpace(p: Dockhand): boolean {
    // Resting and idle people stand aside on their tile, so others can pass.
    return p.state !== 'resting' && !(p.state === 'idle' && p.path.length === 0);
  }

  countOccupancy(): void {
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
  resolveJam(p: Dockhand): void {
    if (p.blocked === B.SIDESTEP_AFTER) this.sidestep(p);
    else if (p.blocked === B.REROUTE_AFTER) this.reroute(p);
    else if (p.blocked >= B.SQUEEZE_AFTER) p.squeeze = true;
  }

  sidestep(p: Dockhand): void {
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

  reroute(p: Dockhand): void {
    const base = this.costFor(p);
    const crowded: CostFn = (i) => base(i) + (this.tileBusy(i) ? 6 : 0);
    const path = findPath(this.map.w, this.map.h, this.tileOf(p), p.goal, crowded, true);
    if (path) p.path = path;
  }

  handlingTicks(p: Dockhand, base: number): number {
    if (p.kind === 'tractor') {
      // At a yard its gantry lifts it; under a gantry crane it waits for the
      // crane to (see serveTractor); a harbour crane sets it straight on.
      const yard = this.yards.get(p.state === 'picking' ? p.stockIdx : p.bayIdx);
      if (yard) return B.YARD_GANTRY_TICKS * Math.max(1, p.planned);
      if (underGantry(this, p)) return B.TRACTOR_WAIT_TICKS;
      return base;
    }
    if (p.kind === 'stacker') return Math.round(base * 2.5);
    if (p.kind === 'forklift') return Math.round(base * 1.5);
    return Math.max(1, Math.round(base * traitDef(p.trait).handling));
  }

  /** How far through picking a load up or setting one down a worker is, 0 to 1. */
  handlingPhase(p: Dockhand): number | undefined {
    if (p.state !== 'picking' && p.state !== 'dropping') return undefined;
    const total = this.handlingTicks(p, p.state === 'picking' ? B.PICK_TICKS : B.DROP_TICKS);
    return clamp(1 - p.timer / total, 0, 1);
  }

  changeMorale(p: Dockhand, delta: number): void {
    if (isMachine(p)) return;
    const scaled = delta < 0 ? delta * traitDef(p.trait).moraleLoss : delta;
    p.morale = Math.max(0, Math.min(100, p.morale + scaled));
  }

  /** Energy use; returns true if the dockhand should head off for a break now. */
  tire(p: Dockhand): boolean {
    if (isMachine(p)) return false;
    if (p.state === 'resting' || p.state === 'toBreak') return false;
    const drain = WORKING.has(p.state) ? B.WORK_DRAIN * traitDef(p.trait).drain : B.IDLE_DRAIN;
    const before = p.energy;
    p.energy = Math.max(0, p.energy - drain);
    if (before > 0 && p.energy === 0) this.changeMorale(p, B.MORALE_EXHAUSTED);
    // Only stop between jobs, never with a crate in hand.
    return p.energy < B.TIRED_ENERGY && (p.state === 'idle' || p.state === 'wander');
  }

  hutOccupancy(hut: number): number {
    return this.people.filter((q) => q.hutIdx === hut).length;
  }

  goOnBreak(p: Dockhand): void {
    p.path = [];
    if (!this.tipsSeen.has('hut')) tipUnless(this, 'hut', this.map.build.includes(Build.BreakHut));
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
  seatAtHut(p: Dockhand): void {
    const seat = this.people.filter((q) => q.hutIdx === p.hutIdx && q !== p).length;
    // Along the bench in front, as the hut stands turned on its tile:
    // drawn facing +y, turned to face its way (see turn in structures.ts).
    const lx = -0.25 + (seat % B.HUT_SLOTS) * 0.25;
    const ly = 0.32;
    const [fx, fy] = FACING[this.map.orient[p.hutIdx] & 3];
    p.x = this.map.xOf(p.hutIdx) + 0.5 + lx * fy + ly * fx;
    p.y = this.map.yOf(p.hutIdx) + 0.5 - lx * fx + ly * fy;
    p.dir = Math.atan2(fy, fx);
  }

  pathFor(p: Dockhand, from: number, goal: number): number[] | null {
    const m = this.map;
    if (p.kind !== 'tractor') return findPath(m.w, m.h, from, goal, this.costFor(p), true);
    // A tractor and its trailer drive like a truck: square round corners,
    // and turning about only where there is room to come round.
    const back = from === this.tileOf(p) ? this.tileBehind(p) : -1;
    const turn = (i: number) => this.roomToTurn(i);
    const cost = this.costFor(p);
    // Where a crane lifts onto it, it pulls in along the way the crane
    // works for its last tile, so it stands lined up rather than across.
    const along = from === goal ? null : this.lineUpAt(goal);
    if (along) {
      let best: number[] | null = null;
      for (const sign of [1, -1]) {
        const x = m.xOf(goal) - along[0] * sign;
        const y = m.yOf(goal) - along[1] * sign;
        if (!m.inBounds(x, y)) continue;
        const before = m.idx(x, y);
        if (!Number.isFinite(cost(before))) continue;
        const keepOff: CostFn = (i, f) => (i === goal ? Infinity : cost(i, f));
        const way =
          before === from ? [] : findDrivePath(m.w, m.h, from, back, before, keepOff, turn);
        if (way && (!best || way.length + 1 < best.length)) best = [...way, goal];
      }
      if (best) return best;
    }
    return findDrivePath(m.w, m.h, from, back, goal, cost, turn);
  }

  /**
   * Which way a tractor stands to be lifted onto or off at `goal`, as a
   * step on the grid: along the quay under a gantry crane or beside a
   * harbour crane, along the lane under a yard gantry; null elsewhere.
   */
  lineUpAt(goal: number): [number, number] | null {
    if (!this.lineUpCache) {
      const m = this.map;
      const out = new Map<number, [number, number]>();
      const put = (tiles: Iterable<number>, a: number | undefined) => {
        if (a === undefined) return;
        const step: [number, number] = [Math.round(Math.cos(a)), Math.round(Math.sin(a))];
        if (Math.abs(step[0]) + Math.abs(step[1]) !== 1) return;
        for (const t of tiles) if (!out.has(t)) out.set(t, step);
      };
      for (const c of this.cranes.values()) {
        if (c.kind === 'gantry') put(this.craneLane(c), this.quayHeading(c));
        else if (c.kind === 'harbour') {
          const x = m.xOf(c.idx);
          const y = m.yOf(c.idx);
          const round: number[] = [];
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (m.inBounds(x + dx, y + dy)) round.push(m.idx(x + dx, y + dy));
            }
          }
          put(round, this.quayHeading(c));
        }
      }
      for (const y of this.yards.values()) {
        const lane = this.gantryLane(y);
        if (lane) put(lane.keys(), this.laneHeading(y));
      }
      this.lineUpCache = out;
    }
    return this.lineUpCache.get(goal) ?? null;
  }

  /**
   * The tile behind a machine: the one it drove in from, so that one part
   * way round a corner cannot turn back that way; else the way it mostly
   * faces, as one parked at an angle.
   */
  tileBehind(p: Dockhand): number {
    const m = this.map;
    const here = this.tileOf(p);
    if (p.came !== undefined && m.neighbors4(here).includes(p.came)) return p.came;
    const c = Math.cos(p.dir);
    const s = Math.sin(p.dir);
    const dx = Math.abs(c) >= Math.abs(s) ? Math.sign(c) : 0;
    const dy = Math.abs(c) >= Math.abs(s) ? 0 : Math.sign(s);
    if (Math.abs(dx) + Math.abs(dy) !== 1) return -1;
    const x = m.xOf(this.tileOf(p)) - dx;
    const y = m.yOf(this.tileOf(p)) - dy;
    return m.inBounds(x, y) ? m.idx(x, y) : -1;
  }

  /**
   * Where a tractor may turn about: never on a road, a tractor and its
   * trailer being too long to come round on one, nor in the lane under a
   * yard gantry, but at a depot, and under a crane, where it pulls in to be
   * lifted onto or off and has room to manoeuvre: anywhere along a gantry
   * crane's rails, which it may only drive along. Anywhere else it goes on
   * round the roads.
   */
  roomToTurn(i: number): boolean {
    const m = this.map;
    if (m.build[i] === Build.Depot || isCrane(m.build[i])) return true;
    if (this.yardLaneTiles().has(i)) return false;
    return this.lineUpAt(i) !== null || this.gantryRailWays().has(i);
  }

  /** Every tile of the lanes under the yard gantries. Cleared when the port changes. */
  yardLaneTiles(): Set<number> {
    if (this.yardLaneCache) return this.yardLaneCache;
    const out = new Set<number>();
    for (const y of this.yards.values())
      for (const t of this.gantryLane(y)?.keys() ?? []) out.add(t);
    return (this.yardLaneCache = out);
  }

  /**
   * Whether a tractor can work a yard gantry's lane: never turning about
   * in it, it drives in at one end and out at the other, so the lane must
   * lead on onto the machines' ground at both.
   */
  laneThrough(y: Bay): boolean {
    const lane = this.gantryLane(y);
    const a = this.laneHeading(y);
    if (!lane || lane.size === 0 || a === undefined) return false;
    const m = this.map;
    const dx = Math.round(Math.cos(a));
    const dy = Math.round(Math.sin(a));
    const along = (t: number) => m.xOf(t) * dx + m.yOf(t) * dy;
    const tiles = [...lane.keys()].sort((p, q) => along(p) - along(q));
    const ground = this.machineGround();
    const beyond = (t: number, s: number) => {
      const x = m.xOf(t) + dx * s;
      const yy = m.yOf(t) + dy * s;
      return m.inBounds(x, yy) && ground.has(m.idx(x, yy));
    };
    return beyond(tiles[0], -1) && beyond(tiles[tiles.length - 1], 1);
  }

  updateDockhand(p: Dockhand): void {
    if ((p.state === 'idle' || p.state === 'wander') && this.rescue(p)) return;
    if (this.tire(p)) return this.goOnBreak(p);
    if (p.truckId !== undefined && (isBoxy(p) ? this.truckJob(p) : this.crateTruckJob(p))) return;
    if (p.restack && this.restackJob(p)) return;
    switch (p.state) {
      case 'broken':
        if (--p.timer <= 0) {
          p.state = 'idle';
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
        // Only driving home to park: work comes first.
        if (p.depotTask === 'park' && (this.tick + p.id) % 5 === 0 && this.assignJob(p)) {
          p.depotTask = null;
          return;
        }
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
        book(this, 'maintenance', -(add / 100) * B.FUEL_COST);
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
        } else if (p.kind === 'dockhand') {
          const roll = this.rng.next();
          // Standing about, not on top of the others.
          if ((this.tick + p.id) % 10 === 0 && this.crowded(p)) this.spreadOut(p);
          else if (roll < B.WANDER_CHANCE) this.wander(p);
        }
        return;
      }
      case 'toPickup': {
        if (!this.sourceValid(p)) return this.cancelJob(p);
        const r = this.walk(p);
        if (r === 'blocked') return this.cancelJob(p);
        if (r === 'arrived') {
          if (this.toPallet(p, this.bays.get(p.stockIdx), true)) return;
          p.state = 'picking';
          p.timer = this.handlingTicks(p, B.PICK_TICKS);
          // Which container off a crane's stack it takes, from the top as
          // it pulls up, whatever is set down beside it meanwhile.
          const crane = this.cranes.get(p.craneIdx);
          const top = crane && crane.kind !== 'jib' ? craneTop(this, crane, false, p) : -1;
          p.takeAt = top >= 0 ? cranePlaces(this, crane!).stack[top] : undefined;
          // A forklift's pallet in crate storage, whatever is set down meanwhile.
          const store = this.bays.get(p.stockIdx);
          if (p.kind === 'forklift' && store?.tiles) {
            p.takeAt = this.palletPlaces(store)[this.pickPallet(store, !!p.outbound, p)];
          }
        }
        return;
      }
      case 'picking': {
        // Waiting at a crane that has been taken down, it gives up.
        if (p.craneIdx >= 0 && !this.cranes.has(p.craneIdx)) return this.cancelJob(p);
        // At a yard, its gantry lifts for one at a time.
        if (!this.gantryFor(p)) return;
        if (--p.timer > 0) return;
        this.gantryDone(this.yards.get(p.stockIdx), p.id);
        const fees = this.takeFromSource(p);
        if (fees.length === 0) return this.cancelJob(p);
        // Fewer than planned: hand back the spare room in the bay.
        const bay = this.dest(p.bayIdx);
        if (bay && !(p.outbound && bay.tiles)) {
          bayIncoming(bay, isBoxy(p), -(p.planned - fees.length));
        }
        this.releaseTarget(p, p.planned - fees.length);
        p.planned = fees.length;
        p.carrying = fees.length;
        p.cargoFees = fees;
        if (p.toBoat !== undefined && p.toBoat >= 0) {
          const ship = this.boats.find((b) => b.id === p.toBoat);
          const spot = ship ? this.loadSpot(p, ship, this.tileOf(p)) : -1;
          if (spot < 0 || !this.headTo(p, spot)) this.retargetCrate(p);
          else p.state = 'toDrop';
          return;
        }
        if (p.toCrane !== undefined && p.toCrane >= 0) {
          const crane = this.cranes.get(p.toCrane);
          if (!crane || !this.headTo(p, this.craneSpot(p, crane, true))) this.retargetCrate(p);
          else p.state = 'toDrop';
          return;
        }
        const goal = bay ? this.dropAt(p, bay, this.tileOf(p)) : -1;
        if (goal < 0 || !this.headTo(p, goal)) this.retargetCrate(p);
        else p.state = 'toDrop';
        return;
      }
      case 'toDrop': {
        if (!this.dropValid(p)) return this.retargetCrate(p);
        const r = this.walk(p);
        if (r === 'blocked') return this.retargetCrate(p);
        if (r === 'arrived') {
          // The place its pallet goes in crate storage may have moved on
          // while it came: it goes on to it.
          if (this.toPallet(p, this.bays.get(p.bayIdx), false)) return;
          // One at a time at a truck bay: it waits its turn.
          const bay = this.bays.get(p.bayIdx);
          if (bay && this.bayTaken(p, bay)) return;
          p.state = 'dropping';
          p.timer = this.handlingTicks(p, B.DROP_TICKS);
        }
        return;
      }
      case 'dropping': {
        if (p.toCrane !== undefined && p.toCrane >= 0 && !this.cranes.has(p.toCrane)) {
          return this.retargetCrate(p);
        }
        if (!this.gantryFor(p)) return;
        if (--p.timer > 0) return;
        // Under a yard gantry, off the trailer onto its spreader: the tractor
        // goes on its way, and the gantry sets it down.
        const gy = this.yards.get(p.bayIdx);
        if (p.kind === 'tractor' && gy && gy.gantryOn === p.id && gy.gantryLift) {
          this.offToGantry(gy, {
            by: p.id,
            at: this.gantryLane(gy)?.get(p.goal) ?? 0,
            slot: 0,
            fees: p.cargoFees,
            looks: this.carriedLooks(p),
            from: p.cargoFrom,
            exports: !!p.outbound,
            planned: p.planned,
          });
          p.carrying = 0;
          p.cargoFees = [];
          p.cargoLooks = undefined;
          p.cargoFrom = undefined;
          p.planned = 0;
          p.bayIdx = -1;
          p.outbound = false;
          p.state = 'idle';
          return;
        }
        const gantryTo = this.gantryDone(gy, p.id);
        if (this.dropOutbound(p)) return;
        const bay = this.dest(p.bayIdx);
        if (!bay) return this.retargetCrate(p);
        const boxy = isBoxy(p);
        // Customs clear a container a while after it is stacked in the yard.
        // Their times go on first, while the list still matches the yard.
        if (boxy) {
          const from = p.cargoFrom ?? [];
          // A stacker sets it on a stack it reaches from where it stands; a
          // gantry where it kept for it.
          const clears = (k: number) => p.cargoReady?.[k] ?? customsFor(this, from[k]);
          if (p.kind === 'stacker' && bay.yard) {
            const slots = this.yardSlots(bay);
            p.cargoFees.forEach((_, k) => {
              slots.boxes.push(this.stackedAt(p, bay, clears(k)));
            });
          } else if (gantryTo !== undefined && p.cargoFees.length === 1) {
            this.yardSlots(bay).boxes.push(gantryTo);
          }
          this.readyList(bay).push(...p.cargoFees.map((_, k) => clears(k)));
          p.cargoFrom = undefined;
          p.cargoReady = undefined;
          this.boxLooks(bay).push(...this.carriedLooks(p));
          p.cargoLooks = undefined;
        }
        // A truck waiting at the bay: straight onto it.
        const onto = this.straightOnto(p, bay);
        // Brought for a truck that has gone meanwhile, they go on the stack
        // however full it is.
        if (onto) {
          onto.kind ??= cargoOf(p.cargoFees[0] ?? 0);
          onto.cargo += p.carrying;
          onto.value += p.cargoFees.reduce((n, f) => n + f, 0);
          (onto.fees ??= []).push(...p.cargoFees);
          onto.idle = 0;
        } else (boxy ? bay.boxes : bay.crates).push(...p.cargoFees);
        // Timber and goods wait in crate storage for customs.
        if (!onto && !boxy && !p.cleared) this.startHolds(bay, p.cargoFees, false);
        p.cleared = undefined;
        if (boxy) tip(this, 'customs');
        if (bay.pile) tip(this, 'landed');
        bayIncoming(bay, boxy, -p.planned);
        // Landed on the quay, a crate has not been handled yet.
        if (boxy) this.stats.containers += p.carrying;
        else if (!bay.pile) this.stats.cratesHandled += p.carrying;
        p.carrying = 0;
        p.cargoFees = [];
        p.planned = 0;
        p.bayIdx = -1;
        p.outbound = false;
        p.state = 'idle';
        return;
      }
    }
  }

  headTo(p: Dockhand, goal: number): boolean {
    const path = this.pathFor(p, this.tileOf(p), goal);
    if (!path) return false;
    p.path = path;
    p.goal = goal;
    return true;
  }

  /**
   * An idle machine works out whether it is cut off: from every truck bay,
   * or from cargo that is waiting. Forklifts only drive on port roads and
   * quays, which is easy to miss.
   */
  diagnose(p: Dockhand): void {
    const here = this.tileOf(p);
    const boxy = isBoxy(p);
    const what = p.kind === 'tractor' ? 'Terminal tractors' : boxy ? 'Reach stackers' : 'Forklifts';
    const reach = (goal: number) => !!this.pathFor(p, here, goal);
    const sources: number[] = [];
    for (const c of this.cranes.values()) {
      if ((c.kind !== 'jib') === boxy && c.stack.length > 0) sources.push(pickTile(this, c));
    }
    // Forklifts take what the dockhands land on the quay.
    if (!boxy)
      for (const pile of this.piles.values()) if (pile.crates.length) sources.push(pile.idx);
    let stuck: string | null = null;
    const dests = [...(boxy ? this.yards : this.bays).values()].filter((d) =>
      this.servesYard(p, d),
    );
    const gantried = [...this.yards.values()].some((y) => this.yardGantry(y));
    if (p.kind === 'tractor' && dests.length === 0 && gantried) {
      stuck =
        "Can't work the yard gantries: tractors cannot turn about in a gantry's lane, so it needs a way on at both ends";
    } else if (p.kind === 'tractor' && dests.length === 0) {
      stuck = 'No container yard with a yard gantry to lift containers off and on';
    } else if (!dests.some((d) => this.dropAt(p, d, here) >= 0)) {
      stuck = boxy
        ? `Can't reach a container yard. ${what} only drive on port roads and quays`
        : `Can't reach a truck bay or crate storage. ${what} only drive on port roads and quays`;
    } else if (sources.length > 0 && !sources.some(reach)) {
      stuck = boxy
        ? "Can't reach the harbour crane. Connect it with quay or port roads"
        : "Can't reach the cargo. Forklifts can't drive on wooden jetties or port paths: use quays and port roads";
    }
    p.stuck = stuck;
    if (stuck && !this.warnedStuck) {
      this.warnedStuck = true;
      message(this, `${p.name}: ${stuck}.`, 'bad');
    }
  }

  /** Whether another dockhand stands within a step of this one, or it stands in a truck bay. */
  crowded(p: Dockhand): boolean {
    const here = this.tileOf(p);
    const bay = this.map.build[here] === Build.TruckBay;
    if (bay) return true;
    return this.people.some(
      (q) =>
        q !== p &&
        q.kind === 'dockhand' &&
        (Math.hypot(q.x - p.x, q.y - p.y) < B.IDLE_ROOM || (bay && this.tileOf(q) === here)),
    );
  }

  /**
   * A dockhand with nothing to do walks a few steps off from the others,
   * and out of truck bays, to stand about on their own.
   */
  spreadOut(p: Dockhand): void {
    const m = this.map;
    const [px, py] = [Math.floor(p.x), Math.floor(p.y)];
    const others = this.people.filter((q) => q !== p && q.kind === 'dockhand');
    // Where the others are, or are going.
    const spots = others.map((q) => {
      const g = q.path.length > 0 ? q.goal : this.tileOf(q);
      return [m.xOf(g) + 0.5, m.yOf(g) + 0.5];
    });
    const room = (x: number, y: number) =>
      Math.min(B.IDLE_ROOM * 2, ...spots.map(([ox, oy]) => Math.hypot(ox - x, oy - y)));
    let best = -1;
    // Off a truck bay anyway, out of the way of the trucks.
    let most = m.build[this.tileOf(p)] === Build.TruckBay ? -Infinity : room(p.x, p.y);
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const [x, y] = [px + dx, py + dy];
        if (!m.inBounds(x, y)) continue;
        const i = m.idx(x, y);
        // On a footpath, out of the way of the trucks and machines, and of
        // the spots on the quays and jetties where the work is.
        if (m.build[i] !== Build.Footpath) continue;
        if (!Number.isFinite(this.walkCost(i))) continue;
        // Nearer is better, as much room being equal.
        const r = room(x + 0.5, y + 0.5) - Math.hypot(dx, dy) * 0.05;
        if (r > most) [best, most] = [i, r];
      }
    }
    if (best < 0) return;
    const path = this.pathFor(p, this.tileOf(p), best);
    if (path && path.length <= 8) {
      p.path = path;
      p.goal = best;
      p.state = 'wander';
    }
  }

  wander(p: Dockhand): void {
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

  /**
   * Crane landing stacks first (they free the crane), then moored boats, then
   * cargo landed on the quay. Only dockhands unload boats: forklifts take on
   * what the dockhands and jib cranes have landed.
   */
  assignJob(p: Dockhand): boolean {
    const here = this.tileOf(p);
    const cost = this.costFor(p);
    // Reach stackers handle containers, everyone else crates.
    const boxy = isBoxy(p);
    // Pallets off a coaster need the forks of a forklift.
    const forks = p.kind === 'forklift';
    const hands = p.kind === 'dockhand';
    const sources: Source[] = [];
    for (const crane of this.cranes.values()) {
      if ((crane.kind !== 'jib') !== boxy) continue;
      if (crane.pallets && crane.stack.length > 0 && !forks) continue;
      // A tractor goes to a container crane working a ship too, or about to,
      // for the containers still to come off it for that crane: called
      // ahead, to be there as each is lifted (see dueAt).
      const ship = p.kind === 'tractor' ? (shipFor(this, crane)?.left ?? 0) : 0;
      const avail = crane.stack.length + ship - crane.reserved;
      if (avail > 0) sources.push({ tile: this.craneSpot(p, crane), avail, crane, rank: 0 });
    }
    if (hands) {
      for (const boat of this.boats) {
        const avail = boat.crates - boat.reserved;
        // Containers only come off a ship by crane.
        if (boat.vessel === 'feeder' || boat.state !== 'moored' || avail <= 0) continue;
        // Workers can unload from any dock tile alongside the boat.
        for (const tile of this.pickupSpots(boat)) sources.push({ tile, avail, boat, rank: 1 });
      }
    }
    // What is landed on the quay waits for the forklifts, if there are any.
    if (forks || (hands && !this.forklifts())) {
      for (const pile of this.piles.values()) {
        const avail = pile.crates.length - (pile.reserved ?? 0);
        if (avail <= 0 || (pile.pallets && !forks) || pile.out) continue;
        sources.push({ tile: pile.idx, avail, pile, rank: forks ? 0 : 2 });
      }
    }
    // Crates in storage the trucks cannot get to, by a crane say, are taken
    // on by forklift to storage or a truck bay they can.
    if (forks) {
      for (const store of this.bays.values()) {
        const avail = this.readyIn(store, false) - (store.reserved ?? 0);
        // A full load at a time: there is no boat waiting on it.
        if (!store.tiles || avail < p.capacity || this.truckable(store)) continue;
        // At the pallet it would take.
        sources.push({ tile: this.palletTile(store, true), avail, pile: store, rank: 1 });
      }
    }
    this.exportSources(p, here, sources);
    // Only stackers can lift a container onto a truck or off one.
    if (p.kind === 'stacker') this.truckSources(sources);
    if (p.kind === 'dockhand' || p.kind === 'forklift') this.crateTruckSources(sources);
    // The boat moored longest is unloaded first, however near another lies:
    // others only once its crates are all spoken for, or its spots taken.
    // A crate truck is loaded by whoever is nearest it, boats or no: one
    // standing at its bay sees it full before going back to the boats.
    // Exports count as long as the ship waiting for them has been alongside,
    // so a ship unloaded and waiting for its exports is not passed over.
    const loading = Math.max(
      -1,
      ...this.boats.filter((b) => this.wantsLoad(b)).map((b) => b.mooredTicks),
    );
    const moored = (s: Source) => s.boat?.mooredTicks ?? (s.out ? loading : -1);
    const near = (s: Source) => !!s.truck && !s.truck.boxes && this.dist(here, s.tile) <= 2;
    const ordered = sources.sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(near(b)) - Number(near(a)) ||
        moored(b) - moored(a) ||
        this.dist(here, a.tile) - this.dist(here, b.tile),
    );

    for (const src of ordered) {
      if (src.out) {
        if (this.takeExportJob(p, src, cost)) return true;
        continue;
      }
      if (src.truck) {
        if (isBoxy(p) ? this.takeTruckJob(p, src) : this.takeCrateTruckJob(p, src)) return true;
        continue;
      }
      if (!Number.isFinite(cost(src.tile))) continue;
      // Tractors are called to a container crane a ship is coming off in
      // time for each container; the foreman sends no more than two others
      // to the same spot, and the rest wait.
      if (p.kind === 'tractor' && src.crane && src.crane.kind !== 'jib') {
        if (!dueAt(this, p, src.crane, src.tile)) continue;
      } else if (this.workersAt(src.tile) >= B.WORKERS_PER_SPOT) continue;
      // A machine leaves the job to a free one nearer the pick-up.
      if (isMachine(p) && this.nearerMachine(p, src.tile)) continue;
      // Containers go to a container yard, crates to a truck bay or storage,
      // or off a boat onto the quay.
      // Timber and goods go through crate storage, for customs.
      const held =
        !boxy &&
        (src.boat
          ? needsCustoms(src.boat.fee)
          : src.crane
            ? src.crane.stack.some(needsCustoms)
            : !src.pile?.tiles && !!src.pile?.crates.some(needsCustoms));
      const bay = boxy
        ? this.yardWithRoom(p, src.tile)
        : src.boat
          ? this.landing(p, src.tile, src.boat.vessel === 'coaster', held)
          : this.bayWithRoom(p, src.tile, !!src.pile?.tiles, held);
      if (!bay) {
        if (held) this.noCustomsStore();
        continue;
      }
      if (!this.headTo(p, src.tile)) continue;
      const planned = Math.min(p.capacity, src.avail, this.dropRoom(bay, boxy));
      if (src.crane) src.crane.reserved += planned;
      if (src.boat) src.boat.reserved += planned;
      if (src.pile) src.pile.reserved = (src.pile.reserved ?? 0) + planned;
      if (bay.pile) {
        if (bay.crates.length + bay.incoming === 0) bay.pallets = src.boat?.vessel === 'coaster';
        this.piles.set(bay.idx, bay);
      }
      bayIncoming(bay, boxy, planned);
      p.planned = planned;
      p.boatId = src.boat ? src.boat.id : -1;
      p.craneIdx = src.crane ? src.crane.idx : -1;
      p.stockIdx = src.pile ? src.pile.idx : -1;
      p.bayIdx = bay.idx;
      p.state = 'toPickup';
      return true;
    }
    // With nothing else to do, a stacker tidies the yards.
    return p.kind === 'stacker' && this.takeRestackJob(p, here);
  }

  /**
   * Send a stacker with time on its hands to restack a yard where a
   * container still in customs lies on one customs have cleared, which no
   * truck can get at until it is moved: it takes the one on top off and
   * sets it down where it buries nothing, in that yard or another with
   * room. Nearest first, and the stacks soonest cleared first.
   */
  takeRestackJob(p: Dockhand, here: number): boolean {
    const yards = [...this.yards.values()].sort(
      (a, b) => this.distTo(here, a) - this.distTo(here, b),
    );
    for (const yard of yards) {
      if (!yard.tiles || this.buriedCount(yard) === 0) continue;
      const ready = this.readyList(yard);
      const slots = this.yardSlots(yard);
      for (const { at, tile } of this.buried(yard)) {
        const spot = this.stackSides(yard, yard.tiles[tile])
          .filter((s) => this.workersAt(s) === 0 && !this.spotTaken(s, p))
          .sort((x, y) => this.dist(here, x) - this.dist(here, y))
          .find((s) => this.pathFor(p, here, s));
        if (spot === undefined) continue;
        // Somewhere to set it down that buries nothing: here, or a yard with room.
        const rest = slots.boxes.filter((_, i) => i !== at);
        const clears = ready[at];
        const dest =
          this.freeYardSlot(yard, rest, slots.exports, clears, undefined, true) >= 0
            ? yard
            : yards.find(
                (b) =>
                  b !== yard &&
                  !!b.tiles &&
                  bayRoom(b, true) > 0 &&
                  this.takesImports(b) &&
                  this.servesYard(p, b) &&
                  this.freeYardSlot(b, ...this.slotLists(b), clears, undefined, true) >= 0 &&
                  this.dropAt(p, b, spot) >= 0,
              );
        if (!dest || !this.headTo(p, spot)) continue;
        bayIncoming(dest, true, 1);
        p.restack = { yard: yard.idx, tile };
        p.bayIdx = dest.idx;
        p.planned = 1;
        p.boatId = -1;
        p.craneIdx = -1;
        p.stockIdx = -1;
        p.outbound = false;
        p.state = 'toPickup';
        return true;
      }
    }
    return false;
  }

  slotLists(b: Bay): [number[], number[]] {
    const { boxes, exports } = this.yardSlots(b);
    return [boxes, exports];
  }

  /**
   * A stacker restacking a yard: up to the stack, and the container off the
   * top of it, keeping when customs clear it; then it sets it down as any
   * other, where it buries nothing. True while it is at it.
   */
  restackJob(p: Dockhand): boolean {
    const job = p.restack!;
    const yard = this.yards.get(job.yard);
    switch (p.state) {
      case 'toPickup': {
        if (!yard?.tiles) {
          this.cancelJob(p);
          return true;
        }
        const r = this.walk(p);
        if (r === 'blocked') this.cancelJob(p);
        else if (r === 'arrived') {
          p.state = 'picking';
          p.timer = this.handlingTicks(p, B.PICK_TICKS);
        }
        return true;
      }
      case 'picking': {
        if (--p.timer > 0) return true;
        const reach = yard ? this.reachFrom(yard, p.goal) : new Set<number>();
        const take = yard ? this.buried(yard).find((c) => reach.has(c.tile)) : undefined;
        if (!yard || !take) {
          this.cancelJob(p);
          return true;
        }
        const ready = this.readyList(yard);
        this.yardSlots(yard).boxes.splice(take.at, 1);
        p.cargoReady = ready.splice(take.at, 1);
        p.cargoLooks = this.boxLooks(yard).splice(take.at, 1);
        p.cargoFees = yard.boxes.splice(take.at, 1);
        p.cargoFrom = undefined;
        p.carrying = 1;
        p.restack = undefined;
        const dest = this.dest(p.bayIdx);
        // Straight down where it stands if that buries nothing; else over to
        // where it does, or where it can.
        if (dest === yard && this.cleanSlot(yard, p.goal, p.cargoReady[0]) >= 0) {
          p.state = 'dropping';
          p.timer = this.handlingTicks(p, B.DROP_TICKS);
          return true;
        }
        const goal = dest ? this.dropAt(p, dest, p.goal) : -1;
        if (dest && goal >= 0 && this.headTo(p, goal)) {
          p.state = 'toDrop';
          return true;
        }
        if (dest) bayIncoming(dest, true, -1);
        bayIncoming(yard, true, 1);
        p.bayIdx = yard.idx;
        p.state = 'dropping';
        p.timer = this.handlingTicks(p, B.DROP_TICKS);
        return true;
      }
    }
    return false;
  }

  forklifts(): boolean {
    return this.people.some((q) => q.kind === 'forklift');
  }

  /**
   * Where a dockhand takes what they lift off a boat from dock tile `t`:
   * into crate storage marked out right there, else down on the quay for
   * the forklifts when there are any (pallets always wait for them), else
   * carried on to a truck bay or storage.
   */
  landing(p: Dockhand, t: number, pallets: boolean, held = false): Bay | null {
    const store = this.bays.get(this.storeOf[t]);
    if (store && bayRoom(store, false) > 0 && this.takesImports(store)) return store;
    if (pallets || this.forklifts()) {
      const pile = this.pileAt(t, pallets);
      if (pile || pallets) return pile;
    }
    return this.bayWithRoom(p, t, false, held);
  }

  /**
   * Timber or goods with no crate storage for cargo coming in with room to
   * wait for customs in: say so, as the coasters cannot be unloaded.
   */
  noCustomsStore(): void {
    const room = [...this.bays.values()].some(
      (b) => b.tiles && this.takesImports(b) && bayRoom(b, false) > 0,
    );
    if (room) return;
    nag(
      this,
      'customsStore',
      'Timber and goods wait in crate storage for customs, and none has room: the coasters cannot be unloaded. Mark out more crate storage for cargo coming in.',
      'bad',
    );
  }

  /**
   * The cargo landed on quay tile `t`, or a new heap there (not yet put
   * down), if it has room for this kind; null where forklifts could not
   * get to it: on a wooden jetty or under a crane.
   */
  pileAt(t: number, pallets: boolean, out = false): Bay | null {
    if (this.map.build[t] !== Build.Quay || this.map.store[t]) return null;
    const pile = this.piles.get(t) ?? {
      idx: t,
      large: false,
      pile: true,
      pallets,
      out,
      reserved: 0,
      boxes: [],
      boxIncoming: 0,
      crates: [],
      incoming: 0,
      nextTruckTick: 0,
      noAccess: false,
    };
    const empty = pile.crates.length + pile.incoming === 0;
    if (!empty && (!!pile.pallets !== pallets || !!pile.out !== out)) return null;
    if (empty) pile.out = out;
    return bayRoom(pile, false) > 0 ? pile : null;
  }

  // ── Exports ───────────────────────────────────────────────

  /**
   * Exports waiting to go on a ship being loaded: dockhands carry crates on
   * board from storage or the quay, forklifts bring them from storage to the
   * quay beside the ship, stackers take containers to the crane that lifts
   * them on board.
   */
  exportSources(p: Dockhand, here: number, sources: Source[]): void {
    // Exports left on the quay with nothing to put them on board: forklifts
    // take them to a ship being loaded, or back into storage.
    if (p.kind === 'forklift') {
      for (const pile of this.piles.values()) {
        const avail = pile.crates.length - (pile.reserved ?? 0);
        if (avail > 0 && this.stranded(pile)) {
          sources.push({ tile: pile.idx, avail, pile, out: true, rank: 2 });
        }
      }
    }
    const boxy = isBoxy(p);
    // Ice in the truck bays, for dockhands to carry on board the fishing boats.
    if (
      p.kind === 'dockhand' &&
      this.boats.some((b) => b.vessel === 'smack' && this.wantsLoad(b))
    ) {
      for (const bay of this.bays.values()) {
        const avail = (bay.exports?.length ?? 0) - (bay.outReserved ?? 0);
        const tile = avail > 0 && truckBay(bay) ? this.dropAt(p, bay, here) : -1;
        if (tile >= 0) sources.push({ tile, avail, pile: bay, out: true, rank: 1 });
      }
    }
    if (!this.boats.some((b) => this.wantsLoad(b) && (b.vessel === 'feeder') === boxy)) return;
    const stores = boxy ? this.yards.values() : this.bays.values();
    for (const store of stores) {
      // Canned fish waits for its export papers.
      const avail = this.readyIn(store, true) - (store.outReserved ?? 0);
      if (!store.tiles || avail <= 0 || !this.servesYard(p, store)) continue;
      const tile =
        p.kind === 'stacker' && store.yard
          ? this.stackSide(p, store, here, 'pick', true)
          : p.kind === 'forklift' && !store.yard
            ? this.palletTile(store, true, false, true)
            : this.dropAt(p, store, here);
      if (tile >= 0) sources.push({ tile, avail, pile: store, out: true, rank: 1 });
    }
    if (p.kind !== 'dockhand') return;
    for (const pile of this.piles.values()) {
      const avail = pile.crates.length - (pile.reserved ?? 0);
      if (pile.out && avail > 0) sources.push({ tile: pile.idx, avail, pile, out: true, rank: 1 });
    }
  }

  /** Take on carrying exports from `src` towards a ship, if there is one to take them. */
  takeExportJob(p: Dockhand, src: Source, cost: CostFn): boolean {
    if (!Number.isFinite(cost(src.tile))) return false;
    if (this.workersAt(src.tile) >= B.WORKERS_PER_SPOT) return false;
    const heap0 = src.pile!;
    const target =
      this.exportTarget(p, src.tile, heap0) ??
      (heap0.pile && this.stranded(heap0) ? this.exportHome(p, src.tile) : null);
    if (!target || !this.headTo(p, src.tile)) return false;
    const heap = src.pile!;
    const planned = Math.min(p.capacity, src.avail, target.room);
    if (heap.pile) heap.reserved = (heap.reserved ?? 0) + planned;
    else heap.outReserved = (heap.outReserved ?? 0) + planned;
    p.toBoat = -1;
    p.toCrane = -1;
    p.bayIdx = -1;
    if (target.boat) {
      target.boat.outIncoming = (target.boat.outIncoming ?? 0) + planned;
      p.toBoat = target.boat.id;
    } else if (target.crane) {
      target.crane.outReserved = (target.crane.outReserved ?? 0) + planned;
      p.toCrane = target.crane.idx;
    } else if (target.pile) {
      if (!this.piles.has(target.pile.idx)) this.piles.set(target.pile.idx, target.pile);
      bayIncoming(target.pile, false, planned);
      p.bayIdx = target.pile.idx;
    } else if (target.store) {
      target.store.exportIncoming = (target.store.exportIncoming ?? 0) + planned;
      p.bayIdx = target.store.idx;
    }
    p.outbound = true;
    p.planned = planned;
    p.boatId = -1;
    p.craneIdx = -1;
    p.stockIdx = heap.idx;
    p.state = 'toPickup';
    return true;
  }

  /**
   * Where a worker takes exports picked up at `from`: a stacker to a crane
   * over a feeder being loaded; a dockhand on board a coaster being loaded;
   * a forklift down on the quay beside one, for the dockhands or a jib
   * crane to put on board.
   */
  exportTarget(
    p: Dockhand,
    from: number,
    source?: Bay,
  ): { boat?: Boat; crane?: Crane; pile?: Bay; store?: Bay; room: number } | null {
    if (isBoxy(p)) {
      for (const c of this.cranes.values()) {
        if (c.kind === 'jib') continue;
        // No more than a ship it reaches still takes, less those already
        // set down for it or on their way, so none are left behind.
        const want = Math.max(
          0,
          ...this.boats
            .filter((b) => this.wantsLoad(b) && craneReaches(this, c, b))
            .map((b) => (b.loadQuota ?? outCap(b)) - (b.out ?? 0) - this.exportsComing(b)),
        );
        const room = Math.min(exportRoom(this, c), want);
        if (room <= 0) continue;
        if (this.pathFor(p, from, this.craneSpot(p, c, true))) return { crane: c, room };
      }
      return null;
    }
    // Ice from a truck bay goes on board a fishing boat.
    if (source && truckBay(source)) {
      for (const b of this.boats) {
        if (b.vessel !== 'smack' || !this.wantsLoad(b) || p.kind !== 'dockhand') continue;
        const room = (b.loadQuota ?? outCap(b)) - (b.out ?? 0) - (b.outIncoming ?? 0);
        if (room > 0 && this.loadSpot(p, b, from) >= 0) return { boat: b, room };
      }
      return null;
    }
    for (const b of this.boats) {
      if (b.vessel !== 'coaster' || !this.wantsLoad(b)) continue;
      let room = outCap(b) - (b.out ?? 0) - (b.outIncoming ?? 0);
      if (p.kind === 'dockhand') {
        if (this.loadSpot(p, b, from) >= 0) return { boat: b, room };
        continue;
      }
      // Forklifts cannot put cargo on board: they take it to storage by the
      // jib crane over the ship for it to lift on, or leave it by the ship.
      const cranes = [...this.cranes.values()].filter(
        (c) => c.kind === 'jib' && near(this, c.idx, b.berth),
      );
      for (const c of cranes) {
        for (const store of jibStores(this, c)) {
          const space = Math.min(room, bayRoom(store, false));
          if (store === source || space <= 0 || !this.takesExports(store)) continue;
          const at = this.dropAt(p, store, from);
          if (at >= 0) return { store, room: space };
        }
      }
      // What is already set down for it counts against what it takes.
      for (const q of this.piles.values()) {
        if (q !== source && this.pileFor(b, q.idx)) room -= q.crates.length + q.incoming;
      }
      if (room <= 0) continue;
      for (const t of this.pickupSpots(b)) {
        // With no dockhands to carry it on board, only where a crane reaches.
        if (!this.pileFor(b, t)) continue;
        const pile = this.pileAt(t, false, true);
        if (pile && this.pathFor(p, from, t))
          return { pile, room: Math.min(room, bayRoom(pile, false)) };
      }
    }
    return null;
  }

  /** Whether a jib crane can swing a crate on board from tile `t`. */
  inJibReach(c: Crane, t: number): boolean {
    const m = this.map;
    const d = Math.max(Math.abs(m.xOf(t) - m.xOf(c.idx)), Math.abs(m.yOf(t) - m.yOf(c.idx)));
    return d <= B.JIB_REACH;
  }

  /**
   * Whether exports set down on quay tile `t` go on board coaster `b`: in
   * reach of a jib crane over it, or beside it for the dockhands to carry.
   */
  pileFor(b: Boat, t: number): boolean {
    if (b.vessel !== 'coaster' || b.state !== 'moored') return false;
    if (this.people.some((q) => q.kind === 'dockhand') && this.pickupSpots(b).includes(t)) {
      return true;
    }
    for (const c of this.cranes.values()) {
      if (c.kind === 'jib' && near(this, c.idx, b.berth) && this.inJibReach(c, t)) return true;
    }
    return false;
  }

  /** Exports left on the quay where nothing will put them on board: their ship has gone. */
  stranded(pile: Bay): boolean {
    return !!pile.out && !this.boats.some((b) => this.pileFor(b, pile.idx));
  }

  /** Outgoing crate storage a forklift can take exports back into from `from`. */
  exportHome(
    p: Dockhand,
    from: number,
  ): { boat?: Boat; crane?: Crane; pile?: Bay; store?: Bay; room: number } | null {
    // Ice goes back into a truck bay.
    const ice = p.cargoFees.some((f) => cargoOf(f, 'goods') === 'ice');
    const stores = [...this.bays.values()]
      .filter((b) => (ice ? truckBay(b) : this.takesExports(b)) && bayRoom(b, false) > 0)
      .sort((a, b) => this.distTo(from, a) - this.distTo(from, b));
    const store = stores.find((b) => this.dropAt(p, b, from) >= 0);
    return store ? { store, room: bayRoom(store, false) } : null;
  }

  /** A dock tile beside the ship this worker can get to from `from`, or -1. */
  loadSpot(p: Dockhand, b: Boat, from: number): number {
    const cost = this.costFor(p);
    for (const t of this.pickupSpots(b)) {
      if (Number.isFinite(cost(t)) && this.pathFor(p, from, t)) return t;
    }
    return -1;
  }

  /** Unloaded, with room on board and someone to load it: it takes exports on. */
  wantsLoad(b: Boat): boolean {
    return (
      b.state === 'moored' &&
      b.crates === 0 &&
      b.reserved === 0 &&
      (b.loadQuota ?? outCap(b)) - (b.out ?? 0) - (b.outIncoming ?? 0) > 0
    );
  }

  /** Exports of this kind waiting anywhere in the port, for a ship to take. */
  exportsWaiting(boxes: boolean): number {
    let n = 0;
    for (const s of boxes ? this.yards.values() : this.bays.values()) n += s.exports?.length ?? 0;
    if (boxes) for (const c of this.cranes.values()) n += c.outStack?.length ?? 0;
    else for (const p of this.piles.values()) if (p.out) n += p.crates.length;
    return n;
  }

  /**
   * Exports this ship could take on: from storage, and those already set
   * down where they go on board it, at its own crane or on the quay by it,
   * or left behind by a ship gone; not those at another berth for the ship
   * lying there or to come, nor shippers' cargo still outside the port.
   */
  exportsFor(b: Boat): number {
    const boxes = b.vessel === 'feeder';
    let n = 0;
    // Fishing boats take the ice in the truck bays, coasters what is in storage.
    for (const s of boxes ? this.yards.values() : this.bays.values()) {
      // Not canned fish still waiting on its export papers.
      if (boxes || truckBay(s) === (b.vessel === 'smack')) n += this.readyIn(s, true);
    }
    if (b.vessel === 'smack') return n;
    if (boxes) {
      for (const c of this.cranes.values()) {
        if (craneReaches(this, c, b)) n += c.outStack?.length ?? 0;
      }
    } else {
      for (const p of this.piles.values()) {
        if (p.out && (this.pileFor(b, p.idx) || this.stranded(p))) n += p.crates.length;
      }
    }
    return n;
  }

  /**
   * Exports on their way on board a ship: carried to it, or set down at a
   * container crane over it, or on their way there.
   */
  exportsComing(b: Boat): number {
    let n = b.outIncoming ?? 0;
    if (b.vessel !== 'feeder') return n;
    for (const c of this.cranes.values()) {
      if (c.kind !== 'jib' && craneReaches(this, c, b)) {
        n += (c.outStack?.length ?? 0) + (c.outReserved ?? 0);
      }
    }
    return n;
  }

  /**
   * A ship unloaded stays to take exports on board while any are waiting and
   * being brought to it, until it is full or nothing has come for a while.
   */
  stillLoading(b: Boat): boolean {
    if (outCap(b) === 0) return false;
    if ((b.outIncoming ?? 0) > 0) return true;
    if ((b.out ?? 0) >= outCap(b)) return false;
    // Those already at its cranes, or on their way there, it takes anyway.
    const coming = this.exportsComing(b) - (b.outIncoming ?? 0);
    // It takes what is in the port when it is ready to go, never waiting for
    // more to come in, nor to fill up.
    if (b.loadQuota === undefined) {
      const claimed = this.boats
        .filter((o) => o !== b && o.state === 'moored' && o.vessel === b.vessel)
        .reduce((n, o) => n + Math.max(0, (o.loadQuota ?? 0) - (o.out ?? 0)), 0);
      const room = outCap(b) - (b.out ?? 0);
      const take = clamp(Math.max(coming, this.exportsFor(b) - claimed), 0, room);
      b.loadQuota = (b.out ?? 0) + take;
      // The line allows time to load as well as to unload.
      b.grace += take * B.MOORED_TICKS_PER_CRATE;
    }
    if ((b.out ?? 0) >= b.loadQuota) return false;
    // Nothing left in the port that other ships alongside are not taking.
    const theirs = this.boats
      .filter((o) => o !== b && o.state === 'moored' && o.vessel === b.vessel)
      .reduce(
        (n, o) => n + Math.max(0, (o.loadQuota ?? 0) - (o.out ?? 0) - (o.outIncoming ?? 0)),
        0,
      );
    if (Math.max(coming, this.exportsFor(b) - theirs) <= 0) return false;
    // Its own cargo still being cleared off the crane comes first; and those
    // at its cranes, or on their way there, are coming.
    const busy =
      coming > 0 ||
      [...this.cranes.values()].some((c) => c.stack.length > 0 && craneReaches(this, c, b));
    b.loadIdle = busy ? 0 : (b.loadIdle ?? 0) + 1;
    return b.loadIdle < B.LOAD_WAIT;
  }

  /** What an unloaded ship alongside is doing: taking exports on, or waiting to sail. */
  readyWords(b: Boat): string {
    const out = b.out ?? 0;
    if (b.loadQuota === undefined || out < b.loadQuota || (b.outIncoming ?? 0) > 0) {
      return `Taking exports on board, ${out}${b.loadQuota ? ` of ${b.loadQuota}` : ''}`;
    }
    const why = {
      fairway: ', waiting for the way out to clear',
      tug: ', waiting for its tug',
      others: ', letting a ship ready before it go first',
      room: ', waiting for a ship turning off its berth',
    };
    // Canned fish still waiting on its papers stays for the next coaster.
    let papers = 0;
    if (b.vessel === 'coaster')
      for (const s of this.bays.values()) papers += this.holds(s, true).length;
    const later = papers > 0 ? `; ${papers} crates of canned fish wait on their export papers` : '';
    return `Ready to sail${out > 0 ? ` with ${out} exports` : ''}${b.holdUp ? why[b.holdUp] : ''}${later}`;
  }

  /** What each crate on a crate truck holds, in load order. */
  truckCargo(t: Truck): Cargo[] {
    // A shipper's are all alike.
    if (t.exports) return Array<Cargo>(t.cargo).fill(cargoOf(t.value, 'goods'));
    const fees = t.fees ?? [];
    return Array.from({ length: t.cargo }, (_, k) => (k < fees.length ? cargoOf(fees[k]) : 'fish'));
  }

  /** Exports go on board: the shipper pays for each as it does. */
  shipOut(b: Boat, fees: number[]): void {
    if (fees.length === 0) return;
    const total = fees.reduce((n, f) => n + f, 0);
    b.out = (b.out ?? 0) + fees.length;
    (b.outFees ??= []).push(...fees);
    b.loadIdle = 0;
    book(this, 'exports', total);
    this.stats.earned += total;
    this.stats.exported = (this.stats.exported ?? 0) + fees.length;
    moneyAt(this, total, b.berth);
    // Ice on board a fishing boat, towards the town's ice house, or canned
    // fish on a coaster, towards its builders' yard.
    const goal = this.town && landmarkGoal(this.town, this.tier)?.goal;
    if (goal?.aboard && this.town) {
      this.town.goal += fees.filter((f) => cargoOf(f, 'goods') === goal.cargo).length;
      openLandmark(this, landmarkDue(this.town, false, this.tier));
    }
  }

  /**
   * A crane with nothing to unload loads a ship instead: a jib crane from
   * crate storage in reach or exports left on the quay beside it, a
   * container crane from what the stackers have brought it.
   */
  loadShip(c: Crane): void {
    const boxes = c.kind !== 'jib';
    const ship = this.boats.find(
      (b) => (b.vessel === 'feeder') === boxes && this.wantsLoad(b) && craneReaches(this, c, b),
    );
    if (!ship) return;
    let take: (() => number) | null = null;
    let from: { store?: Bay; pile?: Bay } = {};
    if (boxes) {
      if (c.outStack?.length) {
        const k = c.liftSlot;
        if (
          c.liftBoat !== ship.id ||
          k === undefined ||
          k < 0 ||
          outSlots(this, ship).includes(k)
        ) {
          c.liftBoat = ship.id;
          c.liftSlot = deckSlot(this, c, ship, true);
        }
        if (c.liftSlot! < 0) return;
        take = () => {
          // Off the top of the stacks, at a gantry crane.
          const i = Math.max(0, craneTop(this, c, true));
          cranePlaces(this, c).out.splice(i, 1);
          (ship.outLooks ??= []).push(...this.outLooks(c).splice(i, 1));
          outSlots(this, ship).push(c.liftSlot!);
          c.liftSlot = undefined;
          return c.outStack!.splice(i, 1)[0];
        };
      }
    } else {
      const store = jibStores(this, c).find(
        (a) => this.readyIn(a, true) - (a.outReserved ?? 0) > 0,
      );
      const pile = [...this.piles.values()].find(
        (q) => q.out && q.crates.length - (q.reserved ?? 0) > 0 && this.inJibReach(c, q.idx),
      );
      from = store ? { store } : pile ? { pile } : {};
      if (store) {
        take = () =>
          this.takeReady(store, true, 0, 1, undefined, {
            from: this.exportLooks(store),
            to: [],
          })[0];
      } else if (pile) {
        take = () => {
          const fee = pile.crates.shift()!;
          this.tidyPile(pile.idx);
          return fee;
        };
      }
    }
    if (!take) return;
    const m = this.map;
    c.busy = true;
    if (!boxes) this.jibJobs.set(c, { boat: ship, load: true, ...from });
    c.angle = Math.atan2(ship.y - (m.yOf(c.idx) + 0.5), ship.x - (m.xOf(c.idx) + 0.5));
    if (++c.timer < craneTicks(c)) return;
    c.timer = 0;
    const fee = take();
    if (fee !== undefined) this.shipOut(ship, [fee]);
  }

  /**
   * Shippers' trucks come in on their timetable, each to a parking space
   * outside the port to have its paperwork done. With nowhere to park, they
   * do not come. An ice works' trucks need no paperwork: they drive
   * straight to a truck bay, like the hauliers'. The cannery's park only to
   * wait their turn: their crates have their export papers done in storage.
   */
  spawnShipments(): void {
    const m = this.map;
    for (const c of shippers(this)) {
      if (this.tick < c.nextBoatTick) continue;
      if (isIce(c.terms)) {
        this.spawnIce(c);
        continue;
      }
      const wide = needsWideSpace(c.terms.capacity, c.terms.cargo === 'container');
      const space = this.freeParking(null, true, wide);
      const from = this.arrival(space ? space.tiles[0] : m.entry);
      if (!this.entryClear(from.tile)) continue;
      const into = space ? this.intoSpace(from.tile, space, -1) : null;
      if (!space || !into) {
        c.nextBoatTick = this.tick + 60;
        tip(this, 'parking');
        nag(
          this,
          'parking',
          `${c.terms.name}'s trucks need parking outside the port, by a public road, to do their paperwork.`,
          'bad',
        );
        continue;
      }
      c.nextBoatTick = this.tick + Math.round((TICKS_PER_DAY * c.terms.capacity) / c.terms.perDay);
      this.trucks.push({
        id: this.nextId++,
        contractId: c.id,
        company: c.terms.name,
        capacity: c.terms.capacity,
        x: m.xOf(from.tile) + 0.5,
        y: m.yOf(from.tile) + 0.5,
        dir: from.dir,
        path: into.path,
        goal: into.path[into.path.length - 1],
        park: space.tiles[0],
        parkFrom: into.via,
        lot: space.tiles,
        state: 'toPark',
        bayIdx: -1,
        cargo: c.terms.capacity,
        value:
          c.terms.cargo === 'container'
            ? c.terms.fee
            : withCargo(c.terms.fee, c.terms.goods ?? 'goods'),
        boxes: c.terms.cargo === 'container',
        exports: true,
        idle: 0,
        timer: 0,
        variant: c.terms.color,
      });
    }
  }

  /**
   * An ice works' truck, straight to the nearest truck bay with room for
   * its load and a free spot to unload at; none comes while there is none.
   */
  spawnIce(c: Contract & { terms: ShipperTerms }): void {
    const m = this.map;
    const bay = [...this.bays.values()].find((b) => truckBay(b) && !b.large);
    if (!bay) {
      c.nextBoatTick = this.tick + 60;
      nag(this, 'iceBay', `${c.terms.name}'s trucks bring ice to a truck bay. Build one.`, 'bad');
      return;
    }
    const from = this.arrival(bay.idx);
    if (!this.entryClear(from.tile)) return;
    const truck: Truck = {
      id: this.nextId++,
      contractId: c.id,
      company: c.terms.name,
      capacity: c.terms.capacity,
      x: m.xOf(from.tile) + 0.5,
      y: m.yOf(from.tile) + 0.5,
      dir: from.dir,
      path: [],
      goal: from.tile,
      state: 'toBay',
      bayIdx: -1,
      cargo: c.terms.capacity,
      value: withCargo(c.terms.fee, 'ice'),
      boxes: false,
      exports: true,
      idle: 0,
      timer: 0,
      variant: c.terms.color,
    };
    const to = this.exportStore(truck);
    // Every truck bay full, or none it can get to: it comes a little later.
    if (!to) {
      c.nextBoatTick = this.tick + 60;
      if (![...this.bays.values()].some((b) => this.iceBay(b))) {
        nag(
          this,
          'iceBayFree',
          `${c.terms.name}'s ice waits for a truck bay of its own: the catch and the ice never share one. Build another truck bay.`,
          'bad',
        );
      }
      return;
    }
    c.nextBoatTick = this.tick + Math.round((TICKS_PER_DAY * c.terms.capacity) / c.terms.perDay);
    to.store.exportIncoming = (to.store.exportIncoming ?? 0) + truck.cargo;
    truck.bayIdx = to.store.idx;
    truck.path = to.path;
    truck.goal = to.dock;
    this.trucks.push(truck);
  }

  /**
   * Storage with room for a shipper's truck to unload into and a free spot
   * beside it, the nearest it can get to from `from`.
   */
  exportStore(t: Truck): { store: Bay; dock: number; path: number[] } | null {
    const from = this.tileOf(t);
    // Ice to a bay that holds ice already before another, keeping the rest for the catch.
    const iced = (b: Bay) => (this.iceTruck(t) && this.holdsIce(b) ? 0 : 1);
    const stores = [...(t.boxes ? this.yards : this.bays).values()]
      .filter((b) => this.takesFrom(b, t) && bayRoom(b, t.boxes) >= t.cargo)
      .sort((a, b) => iced(a) - iced(b) || this.distTo(from, a) - this.distTo(from, b));
    for (const store of stores) {
      const to = this.dockFor(
        store,
        (d, avoid) =>
          this.routeFrom(t, d, this.avoiding(this.truckCostFor(store.idx, -1, t), avoid)),
        this.lengthOf(t),
      );
      if (to) return { store, ...to };
    }
    return null;
  }

  /** Some outgoing storage of its kind has room for a shipper's truck's load. */
  outgoingRoom(t: Truck): boolean {
    return [...(t.boxes ? this.yards : this.bays).values()].some(
      (b) => this.takesFrom(b, t) && bayRoom(b, t.boxes) >= t.cargo,
    );
  }

  /** Say, now and then, that shippers' trucks are waiting because no outgoing storage has room. */
  outgoingFull(boxes: boolean): void {
    const kind = boxes ? 'boxes' : 'crates';
    const stores = [...(boxes ? this.yards : this.bays).values()].filter((b) => b.outgoing);
    nag(
      this,
      `outFull:${kind}`,
      stores.length === 0
        ? `Shippers' trucks are waiting with ${boxes ? 'containers' : 'crates'} to ship: mark out ${boxes ? 'a container yard' : 'crate storage'} for cargo going out.`
        : `Outgoing ${boxes ? 'container yards are' : 'crate storage is'} full: shippers' trucks are waiting in parking. Mark out more, or get ships loading.`,
      'bad',
    );
  }

  /** A heap on the quay, or storage, being collected from: exports from container yards too. */
  stock(i: number): Bay | undefined {
    return this.piles.get(i) ?? this.bays.get(i) ?? this.yards.get(i);
  }

  /** Forget a heap on the quay once it is gone and nobody is coming for it. */
  tidyPile(i: number): void {
    const pile = this.piles.get(i);
    if (pile && pile.crates.length + pile.incoming + (pile.reserved ?? 0) === 0) {
      this.piles.delete(i);
    }
  }

  removePile(i: number): void {
    const pile = this.piles.get(i);
    if (pile && pile.crates.length > 0) {
      message(this, `${pile.crates.length} crates waiting on the quay were lost.`, 'bad');
    }
    this.piles.delete(i);
  }

  /**
   * Whether another machine of the same kind, free or about to be, is nearer
   * `tile` and can get there; it will take the job instead.
   */
  nearerMachine(p: Dockhand, tile: number): boolean {
    const mine = this.dist(this.tileOf(p), tile);
    let best: Dockhand | null = null;
    let bestDist = mine;
    for (const q of this.people) {
      if (q === p || q.kind !== p.kind || q.needsRepair || q.fuel < B.LOW_FUEL || q.stuck) continue;
      const free =
        q.state === 'idle' ||
        q.state === 'dropping' ||
        (q.state === 'toDepot' && q.depotTask === 'park');
      if (!free) continue;
      const d = this.dist(this.tileOf(q), tile);
      if (d < bestDist) {
        best = q;
        bestDist = d;
      }
    }
    if (!best || !this.pathFor(best, this.tileOf(best), tile)) return false;
    // And it has somewhere to take the load from there.
    return isBoxy(p) ? !!this.yardWithRoom(best, tile) : !!this.bayWithRoom(best, tile);
  }

  /** Dock tiles beside a moored boat's hull. */
  pickupSpots(b: Boat): number[] {
    const fp = mooredTiles(this, b.berth, b.jetty, boatHalf(this, b.vessel === 'feeder')) ?? [
      b.berth,
    ];
    const spots = new Set<number>([b.jetty]);
    for (const t of fp) {
      for (const n of this.map.neighbors4(t)) if (isDock(this.map.build[n])) spots.add(n);
    }
    return [...spots];
  }

  workersAt(tile: number): number {
    let n = 0;
    for (const q of this.people) {
      if (q.goal === tile && (q.state === 'toPickup' || q.state === 'picking')) n++;
    }
    return n;
  }

  sourceValid(p: Dockhand): boolean {
    if (p.craneIdx >= 0) return this.cranes.has(p.craneIdx);
    if (p.stockIdx >= 0) return !!this.stock(p.stockIdx);
    const boat = this.boats.find((b) => b.id === p.boatId);
    return !!boat && boat.state === 'moored';
  }

  /** Lift up to the planned number of crates; returns their fees. */
  takeFromSource(p: Dockhand): number[] {
    p.cleared = undefined;
    if (p.craneIdx >= 0) {
      const crane = this.cranes.get(p.craneIdx);
      p.craneIdx = -1;
      if (!crane) return [];
      crane.reserved = Math.max(0, crane.reserved - p.planned);
      // Set straight onto it off the ship.
      if (p.handed) {
        const { fees, looks, from } = p.handed;
        p.handed = undefined;
        p.cargoFrom = from;
        p.cargoLooks = looks;
        return fees;
      }
      const n = Math.min(p.planned, crane.stack.length);
      if (crane.kind !== 'jib') {
        // Off the top of its stacks, one at a time.
        const fees: number[] = [];
        p.cargoFrom = [];
        p.cargoLooks = [];
        for (let k = 0; k < n; k++) {
          // The one it pulled up to, while nothing has been set on it.
          const places = cranePlaces(this, crane).stack;
          const chosen = p.takeAt === undefined ? -1 : places.indexOf(p.takeAt);
          const kinds = craneKinds(this, crane);
          const free = chosen >= 0 && !kinds.has(p.takeAt! + craneStacks(crane));
          p.takeAt = undefined;
          const i = free ? chosen : craneTop(this, crane, false);
          if (i < 0) break;
          cranePlaces(this, crane).stack.splice(i, 1);
          p.cargoFrom.push(...(crane.stackFrom ?? []).splice(i, 1));
          p.cargoLooks.push(...this.stackLooks(crane).splice(i, 1));
          fees.push(...crane.stack.splice(i, 1));
        }
        return fees;
      }
      p.cargoFrom = crane.kind === 'jib' ? undefined : (crane.stackFrom ?? []).splice(0, n);
      p.cargoLooks = crane.kind === 'jib' ? undefined : this.stackLooks(crane).splice(0, n);
      return crane.stack.splice(0, n);
    }
    if (p.stockIdx >= 0) {
      const pile = this.stock(p.stockIdx);
      const at = p.stockIdx;
      p.stockIdx = -1;
      if (!pile) return [];
      if (p.outbound && !pile.pile) {
        pile.outReserved = Math.max(0, (pile.outReserved ?? 0) - p.planned);
        const out = (pile.exports ??= []);
        const n = Math.min(p.planned, out.length, this.onPallet(p, pile));
        if (!pile.yard) {
          // Never canned fish still waiting on its export papers.
          const looks = { from: this.exportLooks(pile), to: [] as number[] };
          const fees = this.takeReady(pile, true, this.takenFrom(p, pile, n), n, undefined, looks);
          p.cargoLooks = looks.to;
          return fees;
        }
        // Off the top of the stacks in a yard.
        const fees: number[] = [];
        p.cargoLooks = [];
        const reach = p.kind === 'stacker' ? this.reachFrom(pile, p.goal) : undefined;
        for (let k = 0; k < n; k++) {
          const i = this.yardTop(pile, true, undefined, reach);
          if (i < 0) break;
          this.yardSlots(pile).exports.splice(i, 1);
          p.cargoLooks.push(...this.exportLooks(pile).splice(i, 1));
          fees.push(...out.splice(i, 1));
        }
        return fees;
      }
      pile.reserved = Math.max(0, (pile.reserved ?? 0) - p.planned);
      const n = Math.min(p.planned, pile.crates.length, this.onPallet(p, pile));
      // Out of storage, never a crate still in customs; and those taken
      // have cleared, wherever they go.
      const fees = pile.tiles
        ? this.takeReady(pile, false, this.takenFrom(p, pile, n), n)
        : pile.crates.splice(0, n);
      if (pile.tiles) p.cleared = true;
      this.tidyPile(at);
      return fees;
    }
    const boat = this.boats.find((b) => b.id === p.boatId);
    p.boatId = -1;
    if (!boat) return [];
    boat.reserved = Math.max(0, boat.reserved - p.planned);
    const n = Math.min(p.planned, boat.crates);
    boat.crates -= n;
    return Array.from({ length: n }, () => boat.fee);
  }

  /**
   * Nearest truck bay or crate storage with room that this worker can reach
   * from `from`; with `onward`, only those the trucks can get to.
   */
  bayWithRoom(p: Dockhand, from: number, onward = false, held = false): Bay | null {
    // Crates waiting on customs only into crate storage, not a truck bay.
    const only = held ? (b: Bay) => !!b.tiles : undefined;
    return this.nearestWithRoom(p, from, this.bays, false, onward, only);
  }

  /** Nearest container yard with room this stacker or tractor can reach from `from`. */
  yardWithRoom(p: Dockhand, from: number): Bay | null {
    return this.nearestWithRoom(p, from, this.yards, true, false, (b) => this.servesYard(p, b));
  }

  /**
   * Whether this machine can work a container yard: a terminal tractor
   * cannot lift a container, so only where a yard gantry lifts it off and on.
   */
  servesYard(p: Dockhand, yard: Bay): boolean {
    return p.kind !== 'tractor' || (this.yardGantry(yard) && this.laneThrough(yard));
  }

  nearestWithRoom(
    p: Dockhand,
    from: number,
    among: Map<number, Bay>,
    boxes: boolean,
    onward = false,
    only?: (b: Bay) => boolean,
  ): Bay | null {
    const bays = [...among.values()]
      .filter(
        (b) =>
          this.dropRoom(b, boxes) > 0 &&
          this.takesImports(b) &&
          (!onward || this.truckable(b)) &&
          (!only || only(b)),
      )
      .sort((a, b) => this.bayCost(from, a, boxes) - this.bayCost(from, b, boxes));
    return bays.find((b) => this.dropAt(p, b, from) >= 0) ?? null;
  }

  /**
   * How far off a bay is to bring cargo to: crates go a good way further to
   * a truck bay where a truck waits for them, to set them straight on it.
   */
  bayCost(from: number, b: Bay, boxes: boolean): number {
    const waiting = !boxes && this.truckRoom(b) > b.incoming;
    return this.distTo(from, b) - (waiting ? B.TRUCK_WAITING_PULL : 0);
  }

  /**
   * Room on crate trucks loading at a truck bay, besides what dockhands and
   * forklifts loading it from its stack are bringing them: crates carried
   * there go straight on, however many the bay holds already.
   */
  truckRoom(b: Bay): number {
    if (b.tiles || b.yard || b.pile) return 0;
    let room = 0;
    for (const t of this.trucks) {
      if (t.state !== 'loading' || t.bayIdx !== b.idx || !this.byHand(t, b)) continue;
      room += Math.max(0, t.capacity - t.cargo - (t.coming ?? 0));
    }
    return room;
  }

  /** Room for crates brought to a bay: on its stack, or straight onto a truck there. */
  dropRoom(b: Bay, boxes: boolean): number {
    return bayRoom(b, boxes) + (boxes ? 0 : this.truckRoom(b));
  }

  /**
   * Storage by a crane, its machines-only ground: it loads and unloads, so
   * it takes cargo either way, but one way at a time.
   */
  byCrane(b: Bay): boolean {
    return !!b.tiles && b.tiles.some((t) => nearCrane(this.map, t));
  }

  /**
   * Whether cargo coming in may go here: truck bays, and storage marked out
   * for cargo coming in, by a crane or not.
   */
  takesImports(b: Bay): boolean {
    if (!b.tiles) return !this.holdsIce(b);
    return !b.outgoing && !b.shut;
  }

  /** Whether exports may go here: only storage marked out for cargo going out, and not shut. */
  takesExports(b: Bay): boolean {
    return !!b.tiles && !!b.outgoing && !b.shut;
  }

  /**
   * Where shipper's truck `t` unloads: ice into a truck bay, for the
   * fishing boats; the rest into outgoing storage.
   */
  takesFrom(b: Bay, t: Truck): boolean {
    return this.iceTruck(t) ? this.iceBay(b) : this.takesExports(b);
  }

  /**
   * A truck bay the ice may go into: never one holding the catch, or with
   * any on its way, nor with a truck in it loading: ice and catch keep to
   * bays of their own.
   */
  iceBay(b: Bay): boolean {
    if (
      !truckBay(b) ||
      b.large ||
      b.crates.length > 0 ||
      b.incoming > 0 ||
      (b.reserved ?? 0) > 0 ||
      this.trucks.some((q) => q.bayIdx === b.idx && !q.exports)
    ) {
      return false;
    }
    // One holding ice already, or a free one while another is left for the catch.
    return (
      this.holdsIce(b) ||
      [...this.bays.values()].some((o) => o !== b && truckBay(o) && !this.holdsIce(o))
    );
  }

  /** A truck bay given over to ice for the boats, with some in it or on its way. */
  holdsIce(b: Bay): boolean {
    return truckBay(b) && ((b.exports?.length ?? 0) > 0 || (b.exportIncoming ?? 0) > 0);
  }

  /** What a crate truck loading at storage waits on, when it is crates still in customs. */
  customsHold(t: Truck): string {
    const bay = this.dest(t.bayIdx);
    if (t.boxes || !bay?.tiles || this.holds(bay, false).length === 0) return '';
    if (this.cratesFor(t, bay) + (t.coming ?? 0) > 0) return '';
    return `, waiting for crates still in customs: the next clear in ${Math.ceil((this.nextHold(bay, false) / TICKS_PER_DAY) * 24)} h`;
  }

  /** The cannery's truck bringing canned fish: its export papers are done in the port. */
  cannedTruck(t: Truck): boolean {
    return !!t.exports && !t.boxes && cargoOf(t.value, 'goods') === 'canned';
  }

  /** A shipper's truck bringing ice. */
  iceTruck(t: Truck): boolean {
    return !!t.exports && !t.boxes && cargoOf(t.value, 'goods') === 'ice';
  }

  /**
   * Stop storage taking any more cargo, so it empties out, or open it to
   * cargo again.
   */
  shutStore(idx: number, shut: boolean): void {
    const b = this.dest(idx);
    if (!b?.tiles || !!b.shut === shut) return;
    b.shut = shut || undefined;
    const what = b.yard ? 'container yard' : 'crate storage';
    if (!shut) return;
    // Say so when that leaves nowhere for the cargo to go.
    const kind = [...(b.yard ? this.yards : this.bays).values()].filter(
      (a) => a.tiles && !!a.outgoing === !!b.outgoing,
    );
    if (kind.every((a) => a.shut)) {
      message(
        this,
        `Every ${b.outgoing ? 'outgoing ' : ''}${what} has stopped taking ${b.yard ? 'containers' : 'crates'}: ${b.outgoing ? "shippers' trucks will wait" : b.yard ? 'the cranes will stop once their stacks fill' : 'forklifts will take crates to the truck bays'}.`,
        'bad',
      );
    }
  }

  /** Crate storage a jib crane can swing crates off a boat into: in reach and taking them. */
  jibStows(c: Crane): boolean {
    return jibStores(this, c).some((a) => this.takesImports(a));
  }

  /** Trucks can get to this bay or storage area to load. */
  truckable(b: Bay): boolean {
    return this.roadTo(b) < Infinity;
  }

  /** Tiles from `from` to the nearest part of a bay or storage area. */
  distTo(from: number, b: Bay): number {
    return b.tiles ? Math.min(...b.tiles.map((t) => this.dist(from, t))) : this.dist(from, b.idx);
  }

  /**
   * Where a worker coming from `from` sets a load down at a bay, or at the
   * nearest tiles of a storage area they can get to; -1 if they cannot.
   */
  dropAt(p: Dockhand, b: Bay, from: number): number {
    if (!b.tiles) return this.pathFor(p, from, b.idx) ? b.idx : -1;
    if (p.kind === 'tractor') return this.tractorSpot(p, b, from);
    if (p.kind === 'stacker' && b.yard) return this.stackSide(p, b, from, 'drop');
    // A forklift sets its pallet down in the next place in crate storage.
    if (p.kind === 'forklift' && !b.yard) {
      const t = this.palletTile(b, false);
      return this.pathFor(p, from, t) ? t : -1;
    }
    const near = [...b.tiles].sort((x, y) => this.dist(from, x) - this.dist(from, y)).slice(0, 4);
    return near.find((t) => this.pathFor(p, from, t)) ?? -1;
  }

  /**
   * Where a reach stacker stands to work a yard's stacks: on the port road
   * or quay beside its edge, never among them, facing a stack it can reach
   * from there; for `drop`, one with room for another, for `pick` one with
   * a container on top that `ok` lets through (`exports` for exports). The
   * nearest it can get to from `from`, one no other machine has if it can
   * be, or -1.
   */
  stackSide(
    p: Dockhand,
    b: Bay,
    from: number,
    work: 'drop' | 'pick',
    exports = false,
    ok?: (i: number) => boolean,
  ): number {
    const tiles = b.tiles ?? [b.idx];
    const spots: number[] = [];
    tiles.forEach((t, n) => {
      const reach = new Set([n]);
      const fits =
        work === 'drop'
          ? this.nextYardSlot(b, undefined, reach) >= 0
          : this.yardTop(b, exports, ok, reach) >= 0;
      if (!fits) return;
      for (const s of this.stackSides(b, t)) if (!spots.includes(s)) spots.push(s);
    });
    spots.sort(
      (x, y) =>
        Number(this.spotTaken(x, p)) - Number(this.spotTaken(y, p)) ||
        this.dist(from, x) - this.dist(from, y),
    );
    return spots.slice(0, 6).find((s) => this.pathFor(p, from, s)) ?? -1;
  }

  /** Every tile port machines can drive to from their depots. */
  machineGround(): Set<number> {
    if (this.machineCache) return this.machineCache;
    const m = this.map;
    const seen = new Set<number>();
    const queue: number[] = [];
    for (let i = 0; i < m.build.length; i++) {
      if (m.build[i] === Build.Depot) {
        seen.add(i);
        queue.push(i);
      }
    }
    while (queue.length > 0) {
      const from = queue.pop()!;
      for (const n of m.neighbors4(from)) {
        if (seen.has(n) || !Number.isFinite(this.driveCost(n, from))) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    return (this.machineCache = seen);
  }

  /**
   * Where a stacker can stand beside yard tile `t` to work its stacks: on
   * one of their long sides, as it takes a container side on, never at an
   * end. The containers lie along the yard's long side.
   */
  stackSides(b: Bay, t: number): number[] {
    const m = this.map;
    const tiles = b.tiles ?? [b.idx];
    const xs = tiles.map((i) => m.xOf(i));
    const ys = tiles.map((i) => m.yOf(i));
    const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
    const ground = this.machineGround();
    return m
      .neighbors4(t)
      .filter((s) => ground.has(s) && (alongX ? m.xOf(s) === m.xOf(t) : m.yOf(s) === m.yOf(t)));
  }

  /**
   * The tiles of a yard (by their place in its tiles) with stacks the
   * machines can get at, beside them; with a gantry, it reaches them all.
   */
  workable(b: Bay): Set<number> | undefined {
    if (this.yardGantry(b)) return undefined;
    const out = new Set<number>();
    (b.tiles ?? [b.idx]).forEach((t, n) => {
      if (this.stackSides(b, t).length > 0) out.add(n);
    });
    return out.size > 0 ? out : undefined;
  }

  /** The tiles of a yard (by their place in its tiles) a stacker standing at `at` reaches. */
  reachFrom(b: Bay, at: number): Set<number> {
    const m = this.map;
    const out = new Set<number>();
    (b.tiles ?? [b.idx]).forEach((t, n) => {
      if (m.neighbors4(t).includes(at)) out.add(n);
    });
    return out;
  }

  /**
   * Where a terminal tractor stands for a yard's gantry to lift a container
   * off it or on: in the lane its rails run along, nearest the gantry,
   * clear of other machines and where the trucks load if it can be; -1 if
   * it cannot get there.
   */
  tractorSpot(p: Dockhand, yard: Bay, from: number): number {
    const lane = this.gantryLane(yard);
    if (!lane) return -1;
    const trucks = new Set<number>(this.storeSpots(yard));
    // Where a truck stands or is on its way to, and the tile either side of
    // one longer than a tile, is no place to pull in, not while there is another.
    const free = this.freeDockSet(yard, B.MACHINE_LENGTH.tractor);
    const order = [...lane.keys()].sort(
      (a, b) =>
        Number(this.spotTaken(a, p)) - Number(this.spotTaken(b, p)) ||
        Number(trucks.has(a) && !free.has(a)) - Number(trucks.has(b) && !free.has(b)) ||
        Number(trucks.has(a)) - Number(trucks.has(b)) ||
        Math.abs(lane.get(a)!) - Math.abs(lane.get(b)!),
    );
    return order.find((t) => drivable(this.map.build[t]) && this.pathFor(p, from, t)) ?? -1;
  }

  /**
   * When each container in a yard clears customs, kept in step with its
   * containers; an older save's are clear already.
   */
  readyList(b: Bay): number[] {
    b.boxReady ??= [];
    while (b.boxReady.length < b.boxes.length) b.boxReady.unshift(0);
    if (b.boxReady.length > b.boxes.length) b.boxReady.length = b.boxes.length;
    return b.boxReady;
  }

  /** Whether customs have cleared a container ready at `r` (see boxReady). */
  isClear(r: number): boolean {
    return r >= 0 && r <= this.tick;
  }

  /** How the containers on a crane's stack look, kept beside them. */
  stackLooks(c: Crane): number[] {
    return (c.stackLooks = aligned(c.stack, c.stackLooks, c.idx));
  }

  /** How the exports set down for a crane look. */
  outLooks(c: Crane): number[] {
    return (c.outLooks = aligned(c.outStack ?? [], c.outLooks, c.idx + 1));
  }

  /** How the containers in a yard look. */
  boxLooks(b: Bay): number[] {
    return (b.boxLooks = aligned(b.boxes, b.boxLooks, b.idx));
  }

  /**
   * The slot each container in a yard is stacked in, and each export,
   * kept beside them: a container set down goes in the lowest free place
   * with one under it, across the whole yard before it goes higher; under
   * a yard gantry, up first (see freeYardSlot).
   */
  yardSlots(b: Bay): { boxes: number[]; exports: number[] } {
    const boxes = (b.boxSlots ??= []);
    const exports = (b.exportSlots ??= []);
    if (boxes.length > b.boxes.length) boxes.length = b.boxes.length;
    if (exports.length > (b.exports?.length ?? 0)) exports.length = b.exports?.length ?? 0;
    const cap = bayCap(b);
    const used = new Set<number>();
    for (const list of [boxes, exports]) {
      list.forEach((k, i) => {
        if (k >= cap || used.has(k)) list[i] = -1;
        else used.add(k);
      });
    }
    const ready = this.readyList(b);
    for (const [list, n, out] of [
      [boxes, b.boxes.length, false],
      [exports, b.exports?.length ?? 0, true],
    ] as const) {
      for (let i = 0; i < n; i++) {
        if (i < list.length && list[i] >= 0) continue;
        const k = this.freeYardSlot(b, boxes, exports, out ? undefined : ready[i]);
        list[i] = k;
        used.add(k);
      }
    }
    return { boxes, exports };
  }

  /**
   * Where a container goes in a yard: on the ground while there is room,
   * then on a stack whose top clears customs no sooner than it does (one
   * off the same ship, or later), so it never buries one that will be
   * ready first; failing that, the lowest free place with one under it.
   * -1 if the yard is full. `ready` is when it clears, as in boxReady.
   * With `strict`, -1 rather than a place that buries one ready sooner.
   */
  freeYardSlot(
    b: Bay,
    boxes: number[],
    exports: number[],
    ready?: number,
    reach: Set<number> | undefined = this.workable(b),
    strict = false,
  ): number {
    const cap = bayCap(b);
    const under = new Map<number, number | undefined>();
    const list = this.readyList(b);
    boxes.forEach((k, i) => k >= 0 && under.set(k, list[i]));
    exports.forEach((k) => k >= 0 && under.set(k, undefined));
    // The place its gantry is setting one down in is kept for that.
    const kept = b.gantryTo;
    // When a container leaves, as best known: waiting on its ship to finish
    // last of all, and those from one ship alike.
    const when = (r: number | undefined) => (r === undefined ? Infinity : r < 0 ? 1e12 - r : r);
    // Under a yard gantry, which reaches every stack, it goes up first: on
    // the fullest stack topped by one off the same ship (an export on an
    // export), so a ship's containers fill stacks of their own, clear
    // customs together, and those that come later start new ones rather
    // than bury them.
    if (this.yardGantry(b)) {
      let up = -1;
      for (let k = YARD_STACKS; k < cap; k++) {
        const p = yardPlace(k);
        if (p.tier === 0 || k === kept || under.has(k) || !under.has(k - YARD_STACKS)) continue;
        if (reach && !reach.has(p.tile)) continue;
        const below = under.get(k - YARD_STACKS);
        if (below === ready && (up < 0 || p.tier > yardPlace(up).tier)) up = k;
      }
      if (up >= 0) return up;
    }
    let fallback = -1;
    for (let tier = 0; tier < YARD_TIERS; tier++) {
      for (let k = tier * YARD_STACKS; k < cap; k++) {
        const p = yardPlace(k);
        if (p.tier !== tier || k === kept || under.has(k) || (reach && !reach.has(p.tile))) {
          continue;
        }
        if (tier === 0) return k;
        if (!under.has(k - YARD_STACKS)) continue;
        const below = under.get(k - YARD_STACKS);
        if (ready === undefined || when(below) >= when(ready)) return k;
        if (fallback < 0) fallback = k;
      }
    }
    return strict ? -1 : fallback;
  }

  /**
   * Containers customs have cleared that a truck cannot get at, with one
   * still in customs on them: for each such stack, the container on top of
   * it, by its place in the yard's list, and the yard tile, those with the
   * fewest on top of a cleared one first.
   */
  buried(b: Bay): { at: number; tile: number }[] {
    const slots = this.yardSlots(b);
    const ready = this.readyList(b);
    const index = new Map<number, number>();
    slots.boxes.forEach((k, i) => index.set(k, i));
    const exported = new Set(slots.exports);
    const out: { at: number; tile: number; above: number }[] = [];
    const cap = bayCap(b);
    for (let base = 0; base < cap; base += B.BOXES_PER_STORE_TILE) {
      for (let stack = 0; stack < YARD_STACKS; stack++) {
        let top = -1;
        let above = 0;
        let clearBelow = false;
        for (let tier = YARD_TIERS - 1; tier >= 0; tier--) {
          const k = base + tier * YARD_STACKS + stack;
          if (exported.has(k)) break;
          const i = index.get(k);
          if (i === undefined) continue;
          if (top < 0) top = i;
          if (this.isClear(ready[i])) {
            clearBelow = above > 0;
            break;
          }
          above++;
        }
        if (clearBelow) out.push({ at: top, tile: yardPlace(slots.boxes[top]).tile, above });
      }
    }
    return out.sort((x, y) => x.above - y.above).map(({ at, tile }) => ({ at, tile }));
  }

  /** How many cleared containers in a yard lie under ones still in customs. */
  buriedCount(b: Bay): number {
    return Math.max(0, this.cleared(b) - this.reachable(b));
  }

  /** Where the next container set down in this yard goes. */
  nextYardSlot(b: Bay, ready?: number, reach?: Set<number>): number {
    const { boxes, exports } = this.yardSlots(b);
    return this.freeYardSlot(b, boxes, exports, ready, reach);
  }

  /**
   * The container in a yard (with `exports`, the export) that can be lifted
   * off the top of its stack, highest first, of those `ok` lets through; -1
   * if none is on top. One with another on it waits until that has gone.
   */
  yardTop(
    b: Bay,
    exports: boolean,
    ok: (i: number) => boolean = () => true,
    reach?: Set<number>,
  ): number {
    const slots = this.yardSlots(b);
    const used = new Set([...slots.boxes, ...slots.exports]);
    if (b.gantryTo !== undefined) used.add(b.gantryTo);
    const list = exports ? slots.exports : slots.boxes;
    let best = -1;
    let high = -1;
    list.forEach((k, i) => {
      const { tier, tile } = yardPlace(k);
      if (reach && !reach.has(tile)) return;
      if (tier < YARD_TIERS - 1 && used.has(k + YARD_STACKS)) return;
      if (tier > high && ok(i)) {
        best = i;
        high = tier;
      }
    });
    return best;
  }

  /** The cleared container on top of its stack a truck takes next from a yard, or -1. */
  clearTop(b: Bay, reach?: Set<number>): number {
    const ready = this.readyList(b);
    return this.yardTop(b, false, (i) => this.isClear(ready[i]), reach);
  }

  /**
   * How many cleared containers trucks can take off a yard one after
   * another: down each stack from the top, until one waiting for customs,
   * or an export, is in the way.
   */
  reachable(b: Bay): number {
    const slots = this.yardSlots(b);
    const ready = this.readyList(b);
    const at = new Map<number, boolean>();
    slots.boxes.forEach((k, i) => at.set(k, this.isClear(ready[i])));
    for (const k of slots.exports) at.set(k, false);
    let n = 0;
    const cap = bayCap(b);
    for (let base = 0; base < cap; base += B.BOXES_PER_STORE_TILE) {
      for (let stack = 0; stack < YARD_STACKS; stack++) {
        for (let tier = YARD_TIERS - 1; tier >= 0; tier--) {
          const clear = at.get(base + tier * YARD_STACKS + stack);
          if (clear === undefined) continue;
          if (!clear) break;
          n++;
        }
      }
    }
    return n;
  }

  /** How the exports waiting in storage look. */
  exportLooks(b: Bay): number[] {
    return (b.exportLooks = aligned(b.exports ?? [], b.exportLooks, b.idx + 1));
  }

  /** How the containers a stacker carries look. */
  carriedLooks(p: Dockhand): number[] {
    return (p.cargoLooks = aligned(p.cargoFees, p.cargoLooks, p.id));
  }

  /** Containers customs have cleared. */
  cleared(b: Bay): number {
    return this.readyList(b).filter((r) => this.isClear(r)).length;
  }

  /** Ticks since the longest-cleared container in this yard cleared customs, or 0. */
  clearedFor(b: Bay): number {
    const since = Math.min(Infinity, ...this.readyList(b).filter((r) => this.isClear(r)));
    return Number.isFinite(since) ? this.tick - since : 0;
  }

  /** Containers whose ship is still being unloaded, so customs have not started on them. */
  pending(b: Bay): number {
    return this.readyList(b).filter((r) => r < 0).length;
  }

  /** Ticks until the next container in this yard clears customs, or -1. */
  nextClear(b: Bay): number {
    const next = Math.min(Infinity, ...this.readyList(b).filter((r) => r > this.tick));
    return Number.isFinite(next) ? next - this.tick : -1;
  }

  /** What a truck could take away from this bay now. */
  collectable(b: Bay): number {
    return this.readyIn(b, false) + (b.yard ? this.reachable(b) : b.boxes.length);
  }

  // ── Customs and export papers on crates ───────────────────

  /**
   * When each crate at a bay still waiting on customs, or (`out`) each of
   * its exports on export papers, clears, soonest first: those cleared are
   * dropped, and never more than there are crates of the kinds that wait.
   */
  holds(b: Bay, out: boolean): number[] {
    const list = out ? b.papers : b.customs;
    if (!list) return [];
    let gone = 0;
    while (gone < list.length && list[gone] <= this.tick) gone++;
    const fees = out ? (b.exports ?? []) : b.crates;
    const waits = out ? needsPapers : needsCustoms;
    let n = 0;
    for (const f of fees) if (waits(f)) n++;
    list.splice(0, Math.max(gone, list.length - n));
    if (list.length > 0) return list;
    if (out) b.papers = undefined;
    else b.customs = undefined;
    return [];
  }

  /**
   * Which of a bay's crates, or (`out`) its exports, still wait: the newest
   * of the kinds that do. Shorter than the list where the rest do not.
   */
  waitMask(b: Bay, out: boolean): boolean[] {
    let n = this.holds(b, out).length;
    // None waits: an empty list does, as every index of it is not set.
    if (n === 0) return [];
    const fees = out ? (b.exports ?? []) : b.crates;
    const mask = fees.map(() => false);
    const waits = out ? needsPapers : needsCustoms;
    for (let i = fees.length - 1; i >= 0 && n > 0; i--) {
      if (waits(fees[i])) {
        mask[i] = true;
        n--;
      }
    }
    return mask;
  }

  /** Which of a bay's crates then its exports, in that order, still wait. */
  heldMask(b: Bay): boolean[] {
    const into = this.waitMask(b, false);
    const out = this.waitMask(b, true);
    if (into.length + out.length === 0) return [];
    return [...b.crates.map((_, i) => !!into[i]), ...out];
  }

  /** Crates at a bay, or (`out`) exports, free to go: none waiting on customs or papers. */
  readyIn(b: Bay, out: boolean): number {
    return (out ? (b.exports?.length ?? 0) : b.crates.length) - this.holds(b, out).length;
  }

  /**
   * Crates just set down at a bay start on customs, or as exports on their
   * papers, if they are of a kind that waits: in crate storage, as only
   * there may they wait. Those carried out of storage cleared do not.
   */
  startHolds(b: Bay, fees: number[], out: boolean): void {
    if (!b.tiles || b.yard) return;
    const waits = out ? needsPapers : needsCustoms;
    const n = fees.filter(waits).length;
    if (n === 0) return;
    const until = this.tick + (out ? B.EXPORT_PAPERS_TICKS : B.CRATE_CUSTOMS_TICKS);
    const list = out ? (b.papers ??= []) : (b.customs ??= []);
    for (let k = 0; k < n; k++) list.push(until);
    tip(this, out ? 'papers' : 'crateCustoms');
  }

  /**
   * Up to `n` crates off a bay's crates, or (`out`) its exports, none of
   * them still waiting and all of them ones `fits` lets through: those from
   * `at` on if they all may go, else the first that may. How each looks,
   * where the bay keeps that, comes off with it into `looks`.
   */
  takeReady(
    b: Bay,
    out: boolean,
    at: number,
    n: number,
    fits: (fee: number) => boolean = () => true,
    looks?: { from: number[]; to: number[] },
  ): number[] {
    const list = out ? (b.exports ??= []) : b.crates;
    if (n <= 0 || list.length === 0) return [];
    const wait = this.waitMask(b, out);
    const ok = (i: number) => !wait[i] && fits(list[i]);
    let pick: number[] = [];
    if (at >= 0 && at + n <= list.length) {
      pick = Array.from({ length: n }, (_, k) => at + k);
      if (!pick.every(ok)) pick = [];
    }
    if (pick.length === 0) {
      for (let i = 0; i < list.length && pick.length < n; i++) if (ok(i)) pick.push(i);
    }
    const fees: number[] = [];
    for (let k = pick.length - 1; k >= 0; k--) {
      fees.unshift(list.splice(pick[k], 1)[0]);
      if (looks && pick[k] < looks.from.length) looks.to.unshift(...looks.from.splice(pick[k], 1));
    }
    return fees;
  }

  /** Ticks until the next crate at a bay, or (`out`) export, clears; -1 if none waits. */
  nextHold(b: Bay, out: boolean): number {
    const h = this.holds(b, out);
    return h.length > 0 ? h[0] - this.tick : -1;
  }

  /** What a crate storage's view says of the crates waiting in it on customs and papers. */
  holdsView(b: Bay): Pick<BayView, 'waiting' | 'customs' | 'papers'> {
    const customs = this.holds(b, false).length;
    const papers = this.holds(b, true).length;
    if (customs + papers === 0) return {};
    return {
      waiting: this.heldMask(b),
      customs: customs > 0 ? { n: customs, next: this.nextHold(b, false) } : undefined,
      papers: papers > 0 ? { n: papers, next: this.nextHold(b, true) } : undefined,
    };
  }

  /**
   * Containers (or crates) at a bay or yard ready to go that no truck is
   * already coming for: room on the trucks heading there, parked for it or
   * loading at it is spoken for. Leaving `except` out of those.
   */
  unclaimed(b: Bay, boxes: boolean, except?: Truck): number {
    const ready = boxes
      ? b.yard
        ? this.reachable(b) - (b.truckReserved ?? 0)
        : b.boxes.length
      : this.readyIn(b, false);
    let claimed = 0;
    for (const t of this.trucks) {
      if (t === except || t.bayIdx !== b.idx || t.exports || t.boxes !== boxes) continue;
      if (
        t.state !== 'toPark' &&
        t.state !== 'parked' &&
        t.state !== 'toBay' &&
        t.state !== 'loading'
      ) {
        continue;
      }
      claimed += Math.max(0, t.capacity - t.cargo - (t.coming ?? 0));
    }
    return ready - claimed;
  }

  /** The truck bay, storage area or heap on the quay a load is going to. */
  dest(idx: number): Bay | undefined {
    return this.bays.get(idx) ?? this.yards.get(idx) ?? this.piles.get(idx);
  }

  /** The worker holds crates but their bay is gone or unreachable. */
  /** Where the worker is taking the load is still there to take it. */
  dropValid(p: Dockhand): boolean {
    if (p.toBoat !== undefined && p.toBoat >= 0) {
      return this.boats.some((b) => b.id === p.toBoat && b.state === 'moored');
    }
    if (p.toCrane !== undefined && p.toCrane >= 0) return this.cranes.has(p.toCrane);
    return !!this.dest(p.bayIdx);
  }

  /** Give back room promised at a ship or crane for `n` exports not coming after all. */
  releaseTarget(p: Dockhand, n: number): void {
    if (n <= 0) return;
    const store = p.outbound ? this.dest(p.bayIdx) : undefined;
    if (store?.tiles) store.exportIncoming = Math.max(0, (store.exportIncoming ?? 0) - n);
    const ship = this.boats.find((b) => b.id === p.toBoat);
    if (ship) ship.outIncoming = Math.max(0, (ship.outIncoming ?? 0) - n);
    const crane = p.toCrane !== undefined ? this.cranes.get(p.toCrane) : undefined;
    if (crane) crane.outReserved = Math.max(0, (crane.outReserved ?? 0) - n);
  }

  /** Exports put on board a ship, or set down for a crane; false for anything else. */
  dropOutbound(p: Dockhand): boolean {
    if (p.toBoat !== undefined && p.toBoat >= 0) {
      const ship = this.boats.find((b) => b.id === p.toBoat);
      if (!ship || ship.state !== 'moored') {
        this.retargetCrate(p);
        return true;
      }
      ship.outIncoming = Math.max(0, (ship.outIncoming ?? 0) - p.planned);
      this.shipOut(ship, p.cargoFees);
    } else if (p.toCrane !== undefined && p.toCrane >= 0) {
      const crane = this.cranes.get(p.toCrane);
      if (!crane) {
        this.retargetCrate(p);
        return true;
      }
      crane.outReserved = Math.max(0, (crane.outReserved ?? 0) - p.planned);
      this.outLooks(crane).push(...this.carriedLooks(p));
      (crane.outStack ??= []).push(...p.cargoFees);
    } else if (p.outbound && this.dest(p.bayIdx)?.tiles) {
      // Into storage by a jib crane, for it to lift on board.
      const store = this.dest(p.bayIdx)!;
      store.exportIncoming = Math.max(0, (store.exportIncoming ?? 0) - p.planned);
      this.exportLooks(store).push(...this.carriedLooks(p));
      (store.exports ??= []).push(...p.cargoFees);
    } else return false;
    p.carrying = 0;
    p.cargoFees = [];
    p.planned = 0;
    p.toBoat = -1;
    p.toCrane = -1;
    p.outbound = false;
    p.state = 'idle';
    return true;
  }

  retargetCrate(p: Dockhand): void {
    if (p.outbound) return this.retargetExports(p);
    const boxy = isBoxy(p);
    const old = this.dest(p.bayIdx);
    if (old) bayIncoming(old, boxy, -p.planned);
    this.tidyPile(p.bayIdx);
    const here = this.tileOf(p);
    const held = !boxy && !p.cleared && p.cargoFees.some(needsCustoms);
    const bay = boxy ? this.yardWithRoom(p, here) : this.bayWithRoom(p, here, false, held);
    const goal = bay ? this.dropAt(p, bay, here) : -1;
    if (bay && goal >= 0 && this.headTo(p, goal)) {
      bayIncoming(bay, boxy, p.planned);
      p.bayIdx = bay.idx;
      p.state = 'toDrop';
      return;
    }
    nag(this, 'putDown', `${p.name} had nowhere to take their load and put it down.`, 'bad');
    p.carrying = 0;
    p.cargoFees = [];
    p.planned = 0;
    p.bayIdx = -1;
    p.path = [];
    p.state = 'idle';
  }

  /** Exports in hand whose ship or crane is gone: to another, or back into storage. */
  retargetExports(p: Dockhand): void {
    this.releaseTarget(p, p.planned);
    const old = this.dest(p.bayIdx);
    if (old?.pile) bayIncoming(old, false, -p.planned);
    this.tidyPile(p.bayIdx);
    p.toBoat = -1;
    p.toCrane = -1;
    p.bayIdx = -1;
    const here = this.tileOf(p);
    const target = this.exportTarget(p, here);
    if (target && target.room >= p.carrying) {
      if (target.boat) {
        const spot = this.loadSpot(p, target.boat, here);
        if (spot >= 0 && this.headTo(p, spot)) {
          target.boat.outIncoming = (target.boat.outIncoming ?? 0) + p.planned;
          p.toBoat = target.boat.id;
          p.state = 'toDrop';
          return;
        }
      } else if (target.crane && this.headTo(p, this.craneSpot(p, target.crane, true))) {
        target.crane.outReserved = (target.crane.outReserved ?? 0) + p.planned;
        p.toCrane = target.crane.idx;
        p.state = 'toDrop';
        return;
      }
    }
    // Back to wait in storage for the next ship.
    const boxy = isBoxy(p);
    const store = [...(boxy ? this.yards : this.bays).values()]
      .filter(
        (b) => this.takesExports(b) && bayRoom(b, boxy) >= p.carrying && this.servesYard(p, b),
      )
      .sort((a, b) => this.distTo(here, a) - this.distTo(here, b))[0];
    if (store) {
      this.exportLooks(store).push(...this.carriedLooks(p));
      (store.exports ??= []).push(...p.cargoFees);
    } else
      nag(
        this,
        'putDownExports',
        `${p.name} had nowhere to take the exports and put them down.`,
        'bad',
      );
    p.carrying = 0;
    p.cargoFees = [];
    p.planned = 0;
    p.outbound = false;
    p.path = [];
    p.state = 'idle';
  }

  cancelJob(p: Dockhand): void {
    this.releaseTruckJob(p);
    this.releaseTarget(p, p.planned);
    if (!p.carrying && p.outbound) {
      const heap = this.stock(p.stockIdx) ?? this.yards.get(p.stockIdx);
      if (heap && !heap.pile) heap.outReserved = Math.max(0, (heap.outReserved ?? 0) - p.planned);
    }
    if (!p.carrying) {
      const boat = this.boats.find((b) => b.id === p.boatId);
      if (boat) boat.reserved = Math.max(0, boat.reserved - p.planned);
      const crane = this.cranes.get(p.craneIdx);
      if (crane) crane.reserved = Math.max(0, crane.reserved - p.planned);
      const pile = this.stock(p.stockIdx);
      if (pile) pile.reserved = Math.max(0, (pile.reserved ?? 0) - p.planned);
      this.tidyPile(p.stockIdx);
    }
    const bay = this.dest(p.bayIdx);
    if (bay && !(p.outbound && bay.tiles)) bayIncoming(bay, isBoxy(p), -p.planned);
    this.tidyPile(p.bayIdx);
    p.boatId = -1;
    p.craneIdx = -1;
    p.stockIdx = -1;
    p.bayIdx = -1;
    p.toBoat = -1;
    p.toCrane = -1;
    p.outbound = false;
    p.hutIdx = -1;
    p.carrying = 0;
    p.cargoFees = [];
    p.cargoReady = undefined;
    p.restack = undefined;
    p.planned = 0;
    p.path = [];
    p.state = 'idle';
  }

  // ── Jib cranes ────────────────────────────────────────────

  // ── Trucks and bays ───────────────────────────────────────

  addBay(i: number): void {
    this.bays.set(i, {
      idx: i,
      large: this.map.build[i] === Build.LargeBay,
      boxes: [],
      boxIncoming: 0,
      crates: [],
      incoming: 0,
      nextTruckTick: 0,
      noAccess: false,
    });
  }

  /** Where trucks stand to load: in a truck bay, or beside a storage area. */
  loadingDocks(bay: Bay): number[] {
    return bay.tiles ? this.storeSpots(bay) : [bay.idx];
  }

  /**
   * Tiles beside a storage area trucks can reach and stand on to load: public
   * roads, or port roads and quays behind a port gate. One truck loads at a
   * time for every STORE_TILES_PER_TRUCK tiles of it, at the spots nearest
   * the highway.
   */
  storeSpots(a: Bay): number[] {
    const cached = this.spotCache.get(a.idx);
    if (cached) return cached;
    const most = Math.max(1, Math.floor(a.tiles!.length / B.STORE_TILES_PER_TRUCK));
    const spots = loadingSpots(this.map, a.tiles!, this.truckReaches());
    // At a yard with a gantry, trucks load anywhere in the lane its rails
    // run along, beside the yard: under it, and all the way along the yard
    // either way from it. Where trucks cannot get to that lane, they load
    // where they can.
    const rails = a.yard ? this.gantryLane(a) : null;
    const lane = rails
      ? spots
          .filter((s) => rails.has(s))
          .sort((p, q) => Math.abs(rails.get(p)!) - Math.abs(rails.get(q)!))
      : [];
    const out = lane.length > 0 ? lane : spots.slice(0, most);
    this.spotCache.set(a.idx, out);
    return out;
  }

  /**
   * The lane a yard's gantry runs along on its rails, beside the yard: each
   * tile with how far it is from the gantry (along the frame's +x, which is
   * (dy, -dx) on the map, for the gantry's own offset (dx, dy) into the
   * yard), as far as the yard runs either way. Null without a gantry.
   */
  gantryLane(a: Bay): Map<number, number> | null {
    const cached = this.laneOfCache.get(a.idx);
    if (cached !== undefined) return cached;
    const lane = this.findGantryLane(a);
    this.laneOfCache.set(a.idx, lane);
    return lane;
  }

  findGantryLane(a: Bay): Map<number, number> | null {
    const m = this.map;
    const area = new Set(a.tiles ?? [a.idx]);
    const g = this.gantryOf(a);
    if (g < 0) return null;
    const into = gantryYard(m, g)?.into;
    if (into === undefined || !area.has(into)) return null;
    const dx = m.xOf(into) - m.xOf(g);
    const dy = m.yOf(into) - m.yOf(g);
    const lane = new Map<number, number>([[g, 0]]);
    for (const sign of [1, -1]) {
      for (let k = 1; ; k++) {
        const x = m.xOf(g) + dy * k * sign;
        const y = m.yOf(g) - dx * k * sign;
        if (!m.inBounds(x + dx, y + dy) || !area.has(m.idx(x + dx, y + dy))) break;
        lane.set(m.idx(x, y), k * sign);
      }
    }
    return lane;
  }

  /**
   * How far trucks drive from the highway to each tile they can get to, or
   * -1: public roads, and port roads and quays through a port gate.
   */
  truckReaches(): Int32Array {
    this.reachCache ??= truckReach(this.map);
    return this.reachCache;
  }

  /** Tiles trucks drive from the highway to load at a bay, or Infinity. */
  roadTo(bay: Bay): number {
    const reach = this.truckReaches();
    const ends = bay.tiles
      ? this.storeSpots(bay).map((s) => reach[s])
      : this.map
          .neighbors4(bay.idx)
          .filter((n) => reach[n] >= 0)
          .map((n) => reach[n] + 1);
    if (ends.length === 0) return Infinity;
    // The way along the highway goes twice as fast as on other roads: as
    // so much shorter a drive.
    return Math.min(...ends) - this.highwayLeg() * (1 - B.TRUCK_SPEED / B.HIGHWAY_SPEED);
  }

  /** Tiles along the highway from its nearer end to the nearest exit, or 0 without one. */
  highwayLeg(): number {
    const m = this.map;
    if (!hasHighway(m)) return 0;
    let best = Infinity;
    for (const y of exitRows(m)) best = Math.min(best, y, m.h - 1 - y);
    return Number.isFinite(best) ? best : 0;
  }

  /** A dock at this bay no truck is using or heading for, or -1. */
  /** Whether the last dockFor found a way to any free spot, through a truck or not. */
  dockRouted = false;
  /** Whether it found one it could get to but not turn round from to leave. */
  dockTurn = false;

  /** Standing at a loading spot, loading or unloading. */
  docked(o: Truck): boolean {
    return o.state === 'loading' || o.state === 'delivering';
  }

  /**
   * A free loading spot at this bay or storage, and the way there by `route`,
   * that does not drive up the lane through a truck already standing at a
   * spot: one beyond it waits until there is a way past, rather than going
   * through it. The furthest along such a lane first. Null when there is none.
   * Only this bay's own trucks count for the order along its lane: one
   * driving on past another's, as a road on through a yard's loading lane,
   * gets by those at it in traffic. At a yard gantry's one-way lane trucks
   * queue instead; see joinQueue.
   */
  dockFor(
    bay: Bay,
    route: (dock: number, avoid: ReadonlySet<number>) => number[] | null,
    len = 1,
  ): { dock: number; path: number[] } | null {
    if (this.oneWayLane(bay)) return this.joinQueue(bay, route, len);
    const m = this.map;
    const standing = this.trucks.filter((o) => this.docked(o) && o.bayIdx === bay.idx);
    // Trucks on their way in to a loading spot: where each will stand, and
    // how far the nearest of them still has to go to each tile of its way
    // there, where this one would stop in its way.
    const coming = this.trucks.filter((o) => o.state === 'toBay' && o.path.length > 0);
    const willStand = new Set(coming.filter((o) => o.bayIdx === bay.idx).map((o) => o.goal));
    const onTheirWay = new Map<number, number>();
    for (const o of coming) {
      o.path.slice(0, -1).forEach((i, k) => {
        if ((onTheirWay.get(i) ?? Infinity) > k) onTheirWay.set(i, k);
      });
    }
    const open = this.freeDockSet(bay, len);
    const free = this.loadingDocks(bay).filter((d) => open.has(d));
    this.dockRouted = false;
    // The furthest in first, so those that come after stop short of it
    // rather than having to get past.
    let best: { dock: number; path: number[] } | null = null;
    this.dockTurn = false;
    // Its way there keeps off the spots the others stand at or are going to
    // where it can, by the lane beside them, rather than up the lane behind
    // them all.
    const taken = new Set([...standing.map((o) => this.tileOf(o)), ...willStand]);
    for (const dock of free) {
      const path = route(dock, taken);
      if (!path) continue;
      // It has to be able to drive away again, never backing out.
      const came = path.length >= 2 ? path[path.length - 2] : -1;
      const away = this.departure(dock);
      const out = this.drivePath(dock, came, away, this.truckCostFor(away, bay.idx));
      if (!out) {
        this.dockTurn = true;
        continue;
      }
      this.dockRouted = true;
      const through = path.some((i, k) => {
        const prev = k > 0 ? path[k - 1] : -1;
        if (prev < 0) return false;
        const dx = m.xOf(i) - m.xOf(prev);
        const dy = m.yOf(i) - m.yOf(prev);
        // In its lane: on its tile, going the way it faces.
        return standing.some(
          (o) => this.tileOf(o) === i && Math.cos(o.dir) * dx + Math.sin(o.dir) * dy > 0.5,
        );
      });
      // Nor drive in past where one coming in will stand, nor stop where
      // one coming in has yet to get past by the time it gets there: so the
      // first in go deepest and the rest stop short of them, and none
      // blocks the lane behind it. One coming in ahead of it, as all on
      // the same road in are, gets past first.
      const past = path.slice(0, -1).some((i) => willStand.has(i));
      const toPass = onTheirWay.get(dock);
      const inTheWay = toPass !== undefined && toPass + 2 >= path.length;
      if (!through && !past && !inTheWay && (!best || path.length > best.path.length)) {
        best = { dock, path };
      }
    }
    return best;
  }

  /**
   * Trucks at a yard gantry reserve no spot: they join its queue, while
   * there is room in it, a few longer than the spots along the lane, and
   * head for the far end of the lane; there each takes the deepest spot
   * free as it comes along, or waits behind the one in front (see
   * alongLane). The way to the far end, or null with the queue full or no
   * way in and out again.
   */
  joinQueue(
    bay: Bay,
    route: (dock: number, avoid: ReadonlySet<number>) => number[] | null,
    len: number,
  ): { dock: number; path: number[] } | null {
    const m = this.map;
    const ways = this.laneWays();
    this.dockRouted = false;
    this.dockTurn = false;
    const docks = this.loadingDocks(bay).filter((d) => ways.has(d));
    if (docks.length === 0) return null;
    const [dx, dy] = ways.get(docks[0])!;
    const deep = (d: number) => m.xOf(d) * dx + m.yOf(d) * dy;
    docks.sort((a, b) => deep(b) - deep(a));
    const full = !this.queueRoom(bay, len);
    for (const dock of docks) {
      const path = route(dock, new Set());
      if (!path) continue;
      const came = path.length >= 2 ? path[path.length - 2] : -1;
      const away = this.departure(dock);
      if (!this.drivePath(dock, came, away, this.truckCostFor(away, bay.idx))) {
        this.dockTurn = true;
        continue;
      }
      this.dockRouted = true;
      return full ? null : { dock, path };
    }
    return null;
  }

  /** Trucks loading at a yard gantry, or on their way in to its queue. */
  queued(bay: Bay): Truck[] {
    return this.trucks.filter(
      (o) => o.bayIdx === bay.idx && (o.state === 'toBay' || this.docked(o)),
    );
  }

  /** How many trucks are loading at a yard gantry or on their way in to its queue. */
  inQueue(bay: Bay): number {
    return this.queued(bay).length;
  }

  /**
   * Whether a yard gantry's queue has room for another truck `len` long:
   * as long, bumper to bumper, as its lane and a little more, back along
   * the way in. Long trucks take more of it than short ones.
   */
  queueRoom(bay: Bay, len = 1): boolean {
    const used = this.queued(bay).reduce((n, o) => n + this.lengthOf(o) + B.TRUCK_GAP, 0);
    return used + len <= this.loadingDocks(bay).length + B.GANTRY_QUEUE_EXTRA;
  }

  /**
   * A truck on its way in to a spot beside a storage area goes on to one
   * further along the lane that has come free since it set off, so the
   * lane fills from the far end: one stopping short, near where trucks come
   * in, keeps all the rest from being sent in past it.
   */
  goDeeper(t: Truck, bay: Bay): void {
    if (this.oneWayLane(bay)) return this.alongLane(t, bay);
    // Where it could stop were it not already on its way to one.
    t.state = 'parked';
    const to = this.dockFor(
      bay,
      (d, avoid) => this.routeFrom(t, d, this.avoiding(this.truckCostFor(bay.idx, -1, t), avoid)),
      this.lengthOf(t),
    );
    t.state = 'toBay';
    // Further along the lane: the same way it is going, straight on past the
    // spot it was going to; never round another way, nor back round to one.
    if (!to || to.dock === t.goal || !t.path.every((i, k) => to.path[k] === i)) return;
    if (to.path.length - t.path.length > this.dist(t.goal, to.dock)) return;
    t.goal = to.dock;
    t.path = to.path;
  }

  /**
   * On its way in along a yard gantry's one-way lane, a truck takes the
   * deepest free spot on its way that no truck stands short of: on to one
   * further along that has come free since it set off, or short of one
   * standing between it and the spot it was going to, so that it unloads
   * now rather than waiting behind, and the lane fills from the far end.
   * With none, it waits in the lane behind the one in its way.
   */
  alongLane(t: Truck, bay: Bay): void {
    const standing = new Set(
      this.trucks
        .filter((o) => o !== t && this.docked(o) && o.bayIdx === bay.idx)
        .map((o) => this.tileOf(o)),
    );
    for (const p of this.people) {
      if (p.kind !== 'tractor') continue;
      if (
        (p.state === 'picking' && p.stockIdx === bay.idx) ||
        (p.state === 'dropping' && p.bayIdx === bay.idx)
      ) {
        standing.add(this.tileOf(p));
      }
    }
    // The spots free were it not on its way to one itself.
    t.state = 'parked';
    const open = this.freeDockSet(bay, this.lengthOf(t));
    t.state = 'toBay';
    // Its way, and on along the lane past the end of it.
    const m = this.map;
    const lane = this.gantryLane(bay);
    const way = this.laneWays().get(t.goal);
    const ahead = [...t.path];
    if (lane && way && t.path.length > 0) {
      for (;;) {
        const last = ahead[ahead.length - 1];
        const x = m.xOf(last) + way[0];
        const y = m.yOf(last) + way[1];
        if (!m.inBounds(x, y) || !lane.has(m.idx(x, y))) break;
        ahead.push(m.idx(x, y));
      }
    }
    let best = -1;
    for (let k = 0; k < ahead.length; k++) {
      if (standing.has(ahead[k])) break;
      if (open.has(ahead[k])) best = k;
    }
    if (best < 0 || ahead[best] === t.goal) return;
    const dock = ahead[best];
    // It has to be able to drive away from there too.
    const came = best > 0 ? ahead[best - 1] : this.tileOf(t);
    const away = this.departure(dock);
    if (!this.drivePath(dock, came, away, this.truckCostFor(away, bay.idx))) return;
    t.goal = dock;
    t.path = ahead.slice(0, best + 1);
  }

  /** A truck's way by `cost`, keeping off tiles in `avoid` where there is a short way round. */
  avoiding(cost: CostFn, avoid: ReadonlySet<number>): CostFn {
    return avoid.size === 0 ? cost : (i, from) => cost(i, from) + (avoid.has(i) ? 20 : 0);
  }

  /**
   * The loading spots at a bay no truck is at or on its way to, nor so close
   * along the lane to one that is that a truck `len` long would not fit
   * between: a long truck at a spot reaches over the next.
   */
  freeDockSet(bay: Bay, len = 1): Set<number> {
    const m = this.map;
    // At a yard gantry, those on their way in to its queue hold no spot.
    const queue = this.oneWayLane(bay);
    const at = this.trucks.filter(
      (t) => this.docked(t) || (t.state === 'toBay' && !(queue && t.bayIdx === bay.idx)),
    );
    const taken = new Set(at.filter((t) => t.bayIdx === bay.idx).map((t) => t.goal));
    // Along a yard gantry's lane, the tractors it lifts for stand where the
    // trucks load: each takes its tile, and the next either way from a long truck.
    const lane = bay.yard ? this.gantryLane(bay) : null;
    const tractors = lane ? this.tractorsIn(bay) : [];
    const crowds = (d: number) =>
      tractors.some((g) => Math.abs(lane!.get(d)! - lane!.get(g)!) < (len + 1) / 2 - 0.05) ||
      at.some((o) => {
        if (o.goal === d) return o.bayIdx !== bay.idx;
        // Which way it lies there: as it stands, or as it will come in.
        const prev = o.path.length >= 2 ? o.path[o.path.length - 2] : this.behind(o);
        const dir = this.docked(o)
          ? o.dir
          : prev >= 0
            ? Math.atan2(m.yOf(o.goal) - m.yOf(prev), m.xOf(o.goal) - m.xOf(prev))
            : o.dir;
        const dx = m.xOf(d) - m.xOf(o.goal);
        const dy = m.yOf(d) - m.yOf(o.goal);
        const along = Math.abs(dx * Math.cos(dir) + dy * Math.sin(dir));
        const across = Math.abs(dy * Math.cos(dir) - dx * Math.sin(dir));
        return across < 0.5 && along < (len + this.lengthOf(o)) / 2 - 0.05;
      });
    return new Set(this.loadingDocks(bay).filter((d) => !taken.has(d) && !crowds(d)));
  }

  /** The lane tiles of a yard its terminal tractors stand at for the gantry, or are on their way to. */
  tractorsIn(yard: Bay): number[] {
    const lane = this.gantryLane(yard);
    if (!lane) return [];
    return this.people
      .filter(
        (p) =>
          p.kind === 'tractor' &&
          (((p.state === 'picking' || p.state === 'toPickup') && p.stockIdx === yard.idx) ||
            ((p.state === 'dropping' || p.state === 'toDrop') && p.bayIdx === yard.idx)),
      )
      .map((p) => (p.state === 'picking' || p.state === 'dropping' ? this.tileOf(p) : p.goal))
      .filter((i) => lane.has(i));
  }

  freeDock(bay: Bay): number {
    const taken = new Set(
      this.trucks
        .filter(
          (t) =>
            t.bayIdx === bay.idx &&
            (t.state === 'toBay' || t.state === 'loading' || t.state === 'delivering'),
        )
        .map((t) => t.goal),
    );
    return this.loadingDocks(bay).find((d) => !taken.has(d)) ?? -1;
  }

  removeBay(i: number): void {
    const bay = this.bays.get(i);
    if (bay && bay.crates.length + bay.boxes.length > 0) {
      message(
        this,
        `${bay.crates.length} crates and ${bay.boxes.length} containers were lost with the truck bay.`,
        'bad',
      );
    }
    this.bays.delete(i);
  }

  /**
   * Trucks drive on public roads, and on port roads once they are through a
   * port gate: never straight from one to the other. A truck bay is only
   * enterable as the destination, or the one being left, from any side of it
   * that touches a road. Storage areas they load beside, never drive into.
   */
  /** How trucks drive; through only the parking space `t` is in, or going into or out of. */
  truckCostFor(target: number, home = -1, t?: Truck): CostFn {
    this.runsCache ??= laneRuns(this.map);
    return this.parkCost(
      t,
      this.throughCost(
        this.laneCost(truckCost(this.map, target, home, t?.lot && new Set(t.lot), this.runsCache)),
        target,
        home,
      ),
    );
  }

  /**
   * How a truck with a parking space of its own drives by `base`: into it
   * only off the road on its lot's in side, coming the way the lot runs or
   * straight at it, never round a hairpin; out of it only onto the road on
   * the far side, going on that way. However it finds its way, the first
   * time or held up on the way.
   */
  parkCost(t: Truck | undefined, base: CostFn): CostFn {
    const lot = t?.lot;
    if (!lot) return base;
    const space = this.spaceAt(lot[0]);
    const flow = space && this.lotOf(lot[0])?.flow;
    if (!space || !flow) return base;
    const m = this.map;
    const own = new Set(space.tiles);
    const inEnd = space.ends[flow.in];
    const outEnd = space.ends[1 - flow.in];
    const step = (i: number, s: number) =>
      m.idx(m.xOf(i) + flow.along[0] * s, m.yOf(i) + flow.along[1] * s);
    const hairpinIn = step(inEnd, 1);
    const hairpinOut = step(outEnd, -1);
    // On its way in, the way in; in the space or just out of it, the way out.
    const goingIn = t!.state === 'toPark';
    const here = this.tileOf(t!);
    const goingOut = own.has(here) || here === outEnd;
    // Gone on its way, it keeps out of the space it had, as of any other.
    if (!goingIn && !goingOut) return (i, from) => (own.has(i) ? Infinity : base(i, from));
    return (i, from) => {
      if (from !== undefined && from >= 0) {
        if (goingIn && own.has(i) && !own.has(from) && from !== inEnd) return Infinity;
        if (goingIn && i === inEnd && from === hairpinIn) return Infinity;
        if (goingOut && own.has(from) && !own.has(i) && i !== outEnd) return Infinity;
        if (goingOut && from === outEnd && i === hairpinOut) return Infinity;
      }
      return base(i, from);
    };
  }

  /** How trucks drive by `base`, and only one way along a yard gantry's lane. */
  laneCost(base: CostFn): CostFn {
    const lanes = this.laneWays();
    const rails = this.gantryRailWays();
    if (lanes.size === 0 && rails.size === 0) return base;
    const m = this.map;
    return (i, from) => {
      if (from !== undefined && from >= 0) {
        const dx = m.xOf(i) - m.xOf(from);
        const dy = m.yOf(i) - m.yOf(from);
        // Never across a yard gantry's rails: into its lane and out again
        // only at the ends, along it.
        if (this.crossesRails(from, i)) return Infinity;
        const way = lanes.get(i) ?? lanes.get(from);
        if (way && dx * way[0] + dy * way[1] < 0) return Infinity;
      }
      return base(i, from);
    };
  }

  /**
   * Whether a step from tile `a` to its neighbour `b`, straight or across a
   * corner, crosses a yard gantry's rails: onto or off its lane other than
   * along it.
   */
  crossesRails(a: number, b: number): boolean {
    const rails = this.railCache ?? this.gantryRailWays();
    if (rails.size === 0) return false;
    const ra = rails.get(a);
    const rb = rails.get(b);
    if (!ra && !rb) return false;
    const m = this.map;
    const dx = m.xOf(b) - m.xOf(a);
    const dy = m.yOf(b) - m.yOf(a);
    const across = (r: [number, number] | undefined) => !!r && dx * r[1] - dy * r[0] !== 0;
    return across(ra) || across(rb);
  }

  /**
   * The tiles of each yard gantry's lane, under it along the yard, and of
   * each gantry crane's rails along the quay, with the way the rails run
   * along them: trucks and machines drive along them, never across.
   */
  gantryRailWays(): Map<number, [number, number]> {
    if (this.railCache) return this.railCache;
    const m = this.map;
    const out = new Map<number, [number, number]>();
    this.railYard.clear();
    for (const y of this.yards.values()) {
      const lane = this.gantryLane(y);
      if (!lane) continue;
      const g = [...lane].find(([, k]) => k === 0)?.[0];
      if (g === undefined) continue;
      const area = new Set(y.tiles ?? [y.idx]);
      const into = m.neighbors4(g).find((n) => area.has(n));
      if (into === undefined) continue;
      // The rails run square to the way the gantry reaches into the yard.
      const ix = m.xOf(into) - m.xOf(g);
      const iy = m.yOf(into) - m.yOf(g);
      for (const t of lane.keys()) {
        out.set(t, [iy, -ix]);
        this.railYard.set(t, y.idx);
      }
    }
    // And a gantry crane's: its two rows along the quay, the stack's and
    // the one behind it where tractors line up and stackers work, the
    // length of its rails. Along them, never across.
    for (const c of this.cranes.values()) {
      if (c.kind !== 'gantry') continue;
      const a = this.quayHeading(c);
      const way: [number, number] = [Math.round(Math.cos(a)), Math.round(Math.sin(a))];
      if (Math.abs(way[0]) + Math.abs(way[1]) !== 1) continue;
      for (const t of gantryRails(m, c.idx, m.orient[c.idx] & 3)) {
        if (t >= 0 && !out.has(t)) out.set(t, way);
      }
    }
    return (this.railCache = out);
  }

  /**
   * How trucks drive by `base`, keeping out from under a yard gantry
   * unless it is the yard they are bound for or leaving: the long way
   * round, if it is not much longer, rather than through its lane, where
   * the trucks it loads queue and it lifts over them.
   */
  throughCost(base: CostFn, target: number, home: number): CostFn {
    const rails = this.gantryRailWays();
    if (rails.size === 0) return base;
    return (i, from) => {
      const c = base(i, from);
      const yard = this.railYard.get(i);
      if (yard === undefined || !Number.isFinite(c) || yard === target || yard === home) return c;
      return c + B.GANTRY_LANE_DETOUR;
    };
  }

  /**
   * The lane along a yard gantry's rails is one way for trucks, where a
   * truck can drive off either end of it and away to the highway: in at the
   * end the shorter way from the highway, out at the other, so that those
   * queueing along it to load never meet one leaving head on, and each goes
   * on out past the spots beyond it. Each lane tile with the way along it.
   * A lane with a way out at one end only is driven in and back out again.
   */
  laneWays(): Map<number, [number, number]> {
    if (this.laneCache) return this.laneCache;
    const m = this.map;
    const base = truckCost(m);
    const out = new Map<number, [number, number]>();
    for (const y of this.yards.values()) {
      const lane = this.gantryLane(y);
      if (!lane || lane.size < 2) continue;
      const tiles = [...lane.entries()].sort((a, b) => a[1] - b[1]).map(([t]) => t);
      const first = tiles[0];
      const last = tiles[tiles.length - 1];
      const dx = Math.sign(m.xOf(last) - m.xOf(first));
      const dy = Math.sign(m.yOf(last) - m.yOf(first));
      // Tiles from the road off this end of the lane to the highway, not
      // back through the lane; Infinity with no way.
      const off: CostFn = (i, from) => (lane.has(i) ? Infinity : base(i, from));
      const away = (end: number, s: number) => {
        const x = m.xOf(end) + dx * s;
        const yy = m.yOf(end) + dy * s;
        if (!m.inBounds(x, yy)) return Infinity;
        const road = m.idx(x, yy);
        const path = this.drivePath(road, end, this.departure(road), off);
        return path ? path.length : Infinity;
      };
      const ra = away(first, -1);
      const rb = away(last, 1);
      if (!Number.isFinite(ra) || !Number.isFinite(rb)) continue;
      const way: [number, number] = ra <= rb ? [dx, dy] : [0 - dx, 0 - dy];
      for (const t of tiles) out.set(t, way);
    }
    return (this.laneCache = out);
  }

  /** Whether trucks load at this storage along a one-way lane, under a yard gantry. */
  oneWayLane(bay: Bay): boolean {
    return !!bay.yard && this.loadingDocks(bay).some((d) => this.laneWays().has(d));
  }

  lots(): ParkingLot[] {
    this.lotsCache ??= parkingLots(this.map);
    return this.lotsCache;
  }

  /** The lot of parking tile `i` is in, if any. */
  lotOf(i: number): ParkingLot | undefined {
    return this.lots().find((l) => l.tiles.includes(i));
  }

  /**
   * Why a lot is no use to the trucks: badly laid out, or out of their
   * reach; null when it works.
   */
  lotTrouble(lot: ParkingLot): string | null {
    if (lot.why) return lot.why;
    const reach = this.truckReaches();
    return lot.spaces.some((s) => reach[s.ends[0]] >= 0 && reach[s.ends[1]] >= 0)
      ? null
      : lot.outside
        ? 'Trucks cannot get to the roads beside it from the highway'
        : 'Trucks cannot get to the port roads beside it: they come in through a port gate';
  }

  /**
   * A free parking space for a truck bound for `bay`, nearest it: outside
   * the port only when `outside`, two tiles wide for the big trucks; null
   * when there is none.
   */
  freeParking(bay: Bay | null, outside = false, wide = false): ParkingSpace | null {
    const reach = this.truckReaches();
    const taken = new Set(this.trucks.map((t) => t.park ?? -1));
    let best: ParkingSpace | null = null;
    let bestD = Infinity;
    for (const lot of this.lots()) {
      if (lot.why || (outside && !lot.outside) || (wide && !lot.wide)) continue;
      for (const space of lot.spaces) {
        const [a, b] = space.ends;
        // In from one road and out onto the other: both must lead somewhere.
        if (!space.ok || taken.has(space.tiles[0]) || reach[a] < 0 || reach[b] < 0) continue;
        const d = bay ? this.distTo(space.tiles[0], bay) : Math.min(reach[a], reach[b]);
        if (d < bestD) {
          bestD = d;
          best = space;
        }
      }
    }
    return best;
  }

  /**
   * The way from `from` into a parking space: to the road on whichever side
   * is nearer, then onto the space's tile on that side. Null if neither can
   * be reached.
   */
  intoSpace(
    from: number,
    space: ParkingSpace,
    target: number,
  ): { path: number[]; via: number } | null {
    const m = this.map;
    const base = truckCost(m, target, -1, new Set(space.tiles));
    const flow = this.lotOf(space.tiles[0])?.flow;
    if (!flow) return null;
    // In off the road on the lot's in side only, coming the way it runs or
    // straight at it: never round a hairpin into a space leaning the other way.
    const end = space.ends[flow.in];
    const wrong = m.idx(m.xOf(end) + flow.along[0], m.yOf(end) + flow.along[1]);
    // Up to it by the road, never through the space itself the wrong way.
    const own = new Set(space.tiles);
    const cost: CostFn = (i, f) =>
      own.has(i) || (i === end && f === wrong) ? Infinity : base(i, f);
    const way = this.drivePath(from, -1, end, cost);
    if (!way) return null;
    const first = flow.in === 0 ? space.tiles[0] : space.tiles[space.tiles.length - 1];
    return { path: [...way, first], via: end };
  }

  /** Parked: stand across the middle of the space, at an angle, nose to the far side. */
  parkUp(t: Truck): void {
    const m = this.map;
    const tiles = t.lot ?? [this.tileOf(t)];
    t.x = tiles.reduce((n, i) => n + m.xOf(i) + 0.5, 0) / tiles.length;
    t.y = tiles.reduce((n, i) => n + m.yOf(i) + 0.5, 0) / tiles.length;
    // Leaning the way its lot runs, as its spaces are painted.
    const flow = this.lotOf(tiles[0])?.flow;
    if (flow) {
      t.dir = Math.atan2(flow.along[1] + flow.across[1], flow.along[0] + flow.across[0]);
      return;
    }
    const from = t.parkFrom ?? this.tileOf(t);
    const ahead = Math.atan2(t.y - (m.yOf(from) + 0.5), t.x - (m.xOf(from) + 0.5));
    t.dir = ahead + Math.PI / 4;
  }

  /** Whether a shipper's truck like `t` is parked near this storage, with its paperwork done, waiting for a spot. */
  stagedFor(store: Bay, t: Truck): boolean {
    return this.trucks.some(
      (o) =>
        o.staged === store.idx &&
        o.state === 'parked' &&
        o.boxes === t.boxes &&
        this.tick >= (o.papers ?? Infinity),
    );
  }

  /** The parking space whose first tile is `park`, if any. */
  spaceAt(park: number | undefined): ParkingSpace | undefined {
    if (park === undefined) return undefined;
    return this.lots()
      .flatMap((l) => l.spaces)
      .find((s) => s.tiles[0] === park);
  }

  /**
   * A shipper's truck with its paperwork done, waiting for a spot at the
   * outgoing storage, moves on to a parking space much nearer it, inside the
   * port where there is one: there it is at the spot moments after it comes
   * free, rather than a long drive away, with the spot standing empty all
   * the while. Only as many wait there for each storage as it has spots.
   */
  stageNearer(t: Truck): void {
    const to = this.stagingSpace(t);
    if (!to) return;
    const { store, space, into } = to;
    t.lot = [...space.tiles, ...(t.lot ?? [])];
    t.park = space.tiles[0];
    t.parkFrom = into.via;
    t.path = into.path;
    t.goal = into.path[into.path.length - 1];
    t.state = 'toPark';
    t.staged = store.idx;
  }

  /** The parking space a shipper's truck would move nearer the outgoing storage to, and the way there; see stageNearer. */
  stagingSpace(
    t: Truck,
  ): { store: Bay; space: ParkingSpace; into: { path: number[]; via: number } } | null {
    const here = this.tileOf(t);
    const stores = [...(t.boxes ? this.yards : this.bays).values()]
      .filter((b) => this.takesFrom(b, t) && bayRoom(b, t.boxes) >= t.cargo)
      .sort((a, b) => this.distTo(here, a) - this.distTo(here, b));
    const wide = needsWideSpace(t.capacity, t.boxes);
    for (const store of stores) {
      const staged = this.trucks.filter(
        (o) => o.staged === store.idx && (o.state === 'toPark' || o.state === 'parked'),
      ).length;
      if (staged >= this.loadingDocks(store).length) continue;
      const space = this.freeParking(store, false, wide);
      if (!space) continue;
      if (this.distTo(space.tiles[0], store) + B.STAGE_NEARER_BY > this.distTo(here, store)) {
        continue;
      }
      // Out of its space, and in by whichever side of the new one is nearer:
      // through its own space and the new one only.
      const cost = this.laneCost(
        truckCost(this.map, -1, -1, new Set([...(t.lot ?? []), ...space.tiles])),
      );
      let into: { path: number[]; via: number } | null = null;
      for (const [k, end] of space.ends.entries()) {
        const way = this.routeFrom(t, end, cost);
        if (!way || (into && way.length >= into.path.length - 1)) continue;
        const first = k === 0 ? space.tiles[0] : space.tiles[space.tiles.length - 1];
        into = { path: [...way, first], via: end };
      }
      if (into) return { store, space, into };
    }
    return null;
  }

  /**
   * The way out from where a truck is to `goal`: from a parking space,
   * always forwards, on across it and out onto the road on the far side.
   */
  routeFrom(t: Truck, goal: number, cost: CostFn): number[] | null {
    const here = this.tileOf(t);
    let from = here;
    let prefix: number[] = [];
    const lot = t.lot;
    if (lot?.includes(here) && t.parkFrom !== undefined) {
      const space = this.lots()
        .flatMap((l) => l.spaces)
        .find((s) => s.tiles[0] === lot[0]);
      if (space) {
        const fromA = t.parkFrom === space.ends[0];
        const order = fromA ? space.tiles : [...space.tiles].reverse();
        const exit = fromA ? space.ends[1] : space.ends[0];
        prefix = [...order.slice(order.indexOf(here) + 1), exit];
        from = exit;
        // Out onto the road going on the way the lot runs, never back round.
        const flow = this.lotOf(lot[0])?.flow;
        if (flow) {
          const m = this.map;
          const back = m.idx(m.xOf(exit) - flow.along[0], m.yOf(exit) - flow.along[1]);
          const base = cost;
          cost = (i, f) => (f === exit && i === back ? Infinity : base(i, f));
        }
      }
    }
    if (from === goal) return prefix;
    const came =
      prefix.length >= 2 ? prefix[prefix.length - 2] : prefix.length === 1 ? here : this.behind(t);
    const rest = this.drivePath(from, came, goal, cost);
    return rest ? [...prefix, ...rest] : null;
  }

  /** Trucks parked, or on their way to park, waiting to load at this bay. */
  queuedAt(bay: Bay): number {
    return this.trucks.filter(
      (t) => !t.exports && t.bayIdx === bay.idx && (t.state === 'toPark' || t.state === 'parked'),
    ).length;
  }

  spawnTrucks(): void {
    const m = this.map;
    const firms = hauliers(this);
    const out = new Map<number, number>();
    // A truck that has left the port is away on its round, and back for
    // more only once its haulier's return is due.
    for (const t of this.trucks) {
      if (!t.away && t.drop === undefined) out.set(t.contractId, (out.get(t.contractId) ?? 0) + 1);
    }
    for (const h of firms) {
      h.returns = (h.returns ?? []).filter((at) => at > this.tick);
      out.set(h.id, (out.get(h.id) ?? 0) + h.returns.length);
    }
    // Fullest bays get trucks first. Container trucks collect from the yards,
    // and from large bays still holding containers from older saves.
    const load = (b: Bay) =>
      b.crates.length / bayCap(b) + b.boxes.length / (b.yard ? bayCap(b) : B.TRUCK_CAPACITY);
    const bays = [...this.bays.values(), ...this.yards.values()]
      .filter((b) => {
        // Only where there is cargo no truck is already coming for.
        if (this.unclaimed(b, false) <= 0 && this.unclaimed(b, true) <= 0) return false;
        if (this.tick < b.nextTruckTick) return false;
        if (this.loadingDocks(b).length === 0) {
          this.cutOff(b);
          return false;
        }
        // With every spot taken, more trucks queue in the parking, a few at a time.
        if (this.freeDock(b) >= 0) return true;
        return this.queuedAt(b) < this.loadingDocks(b).length && !!this.freeParking(b);
      })
      .sort((a, b) => load(b) - load(a) || a.idx - b.idx);

    for (const bay of this.bays.values()) {
      if (bay.crates.length >= bayCap(bay)) this.bayFullTicks += 10;
    }
    for (const bay of bays) {
      const from = this.arrival(bay.idx);
      if (!this.entryClear(from.tile)) continue;
      // Container trucks collect containers; big trucks only fit a large bay.
      const free = (h: (typeof firms)[number]) => (out.get(h.id) ?? 0) < h.terms.fleet;
      // A container truck goes only for a full load: as many cleared
      // containers as it carries that no other truck is coming for; or for
      // what there is, once that has been waiting a good while.
      const boxes = this.unclaimed(bay, true);
      const boxTruck = (h: (typeof firms)[number]) => free(h) && h.terms.cargo === 'container';
      const haulier =
        (boxes > 0
          ? (firms.find((h) => boxTruck(h) && boxes >= h.terms.capacity) ??
            (this.clearedFor(bay) >= B.PART_LOAD_WAIT ? firms.find(boxTruck) : undefined))
          : undefined) ??
        (this.unclaimed(bay, false) > 0
          ? firms.find(
              (h) =>
                free(h) && !h.terms.cargo && (bay.large || h.terms.capacity <= B.TRUCK_CAPACITY),
            )
          : undefined);
      if (!haulier) {
        if (firms.some((h) => (h.returns?.length ?? 0) > 0)) tip(this, 'roundTrip');
        const stuck = firms.some(
          (h) => h.terms.capacity > B.TRUCK_CAPACITY && (out.get(h.id) ?? 0) < h.terms.fleet,
        );
        if (stuck && !this.warnedBigTrucks && ![...this.bays.values()].some((b) => b.large)) {
          this.warnedBigTrucks = true;
          message(this, 'Big trucks need a large truck bay. Build one so they can collect.', 'bad');
        }
        const boxTrucks = firms.some((h) => h.terms.cargo === 'container');
        if (bay.yard && !boxTrucks && !this.warnedBoxTrucks) {
          this.warnedBoxTrucks = true;
          message(this, 'Containers are piling up in the yard. Sign a container haulier.', 'bad');
        }
        continue;
      }
      // A container truck goes on to a yard only when its gantry or a free
      // reach stacker is there to load it; otherwise it waits in parking
      // inside the port, or is not sent yet.
      const boxy = haulier.terms.cargo === 'container';
      const served = !boxy || this.handlerFree(bay);
      const len = B.truckLength(haulier.terms.capacity, boxy);
      const to = this.dockFor(
        bay,
        (d, avoid) =>
          this.drivePath(from.tile, -1, d, this.avoiding(this.truckCostFor(bay.idx), avoid)),
        len,
      );
      // No way to any free spot at all, rather than only past a truck there:
      // not sent, even to wait, as none could ever load there. Free for a
      // truck as long as this one: with none, dockFor tried no way at all.
      if (!to && !this.dockRouted && this.freeDockSet(bay, len).size > 0) {
        this.cutOff(bay, this.dockTurn);
        continue;
      }
      const spot = served && to ? to.dock : -1;
      // Waiting for a reach stacker, as for a spot, only a few queue in the parking.
      if (spot < 0 && this.queuedAt(bay) >= this.loadingDocks(bay).length) continue;
      const wide = needsWideSpace(haulier.terms.capacity, boxy);
      const space = spot >= 0 ? null : this.freeParking(bay, false, wide);
      // A bay beside it may have just sent a truck to the spot they share.
      if (spot < 0 && !space) continue;
      const into = space ? this.intoSpace(from.tile, space, bay.idx) : null;
      const path = space ? (into?.path ?? null) : (to?.path ?? null);
      const dock = path && path.length > 0 ? path[path.length - 1] : spot;
      if (!path) {
        this.cutOff(bay);
        continue;
      }
      bay.noAccess = false;
      out.set(haulier.id, (out.get(haulier.id) ?? 0) + 1);
      const truck: Truck = {
        id: this.nextId++,
        contractId: haulier.id,
        company: haulier.terms.name,
        capacity: haulier.terms.capacity,
        x: m.xOf(from.tile) + 0.5,
        y: m.yOf(from.tile) + 0.5,
        dir: from.dir,
        path,
        goal: dock,
        state: space ? 'toPark' : 'toBay',
        park: space?.tiles[0],
        parkFrom: into?.via,
        lot: space?.tiles,
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

  /** No truck can get to this bay: say so once, and try again in a while. */
  cutOff(bay: Bay, turn = false): void {
    const what = bay.yard ? 'container yard' : bay.tiles ? 'crate storage area' : 'truck bay';
    const why = turn
      ? `Trucks could get to this ${what} but not drive away again: they never turn about on a road one tile wide. Give them a way on, a junction, or a block of road two wide to turn in.`
      : bay.tiles
        ? `Trucks cannot reach this ${what}: they load storage from inside the port, from a port road or quay beside it through a port gate, not beside machines-only ground.`
        : `Trucks cannot reach this ${what}: it needs a public road to the highway, or port roads from a port gate.`;
    // Crate storage out of the trucks' way is a buffer the forklifts empty.
    if (!bay.noAccess && !bay.warehouse) message(this, why, 'bad');
    bay.noAccess = true;
    bay.noAccessWhy = why;
    bay.nextTruckTick = this.tick + 100;
  }

  updateTruck(t: Truck): void {
    const bay = this.dest(t.bayIdx);
    switch (t.state) {
      case 'toPark': {
        const cost = this.truckCostFor(t.bayIdx, -1, t);
        const r = this.move(
          t,
          cost,
          false,
          this.pace(t, cost),
          this.mayEnter(t),
          this.truckReroute(t),
        );
        if (r === 'blocked' || this.map.build[t.park ?? -1] !== Build.Parking) {
          return this.removeTruck(t);
        }
        if (r === 'arrived') {
          t.state = 'parked';
          t.idle = 0;
          // Only the space it is in now, not the one it came from too.
          const space = this.spaceAt(t.park);
          if (space) t.lot = space.tiles;
          this.parkUp(t);
          // A shipper's truck has its paperwork done while it waits; the
          // cannery's, from the town, have their export papers done inside
          // the port instead, crate by crate in storage.
          if (t.exports && t.papers === undefined) {
            t.papers = this.tick + (this.cannedTruck(t) ? 0 : B.PAPERWORK_TICKS);
          }
        }
        return;
      }
      case 'parked': {
        if (t.exports) {
          if (this.tick < (t.papers ?? 0) || (this.tick + t.id) % 10 !== 0) return;
          const to = this.exportStore(t);
          if (!to) {
            if (!this.outgoingRoom(t)) this.outgoingFull(t.boxes);
            else this.stageNearer(t);
            return;
          }
          // Containers wait parked until the yard's gantry or a stacker is free.
          if (t.boxes && !this.handlerFree(to.store, t)) return;
          // One waiting in parking near the storage takes the spot before one
          // far off outside the port, which moves nearer itself instead.
          if (t.staged === undefined && this.stagedFor(to.store, t)) return this.stageNearer(t);
          to.store.exportIncoming = (to.store.exportIncoming ?? 0) + t.cargo;
          t.bayIdx = to.store.idx;
          t.park = undefined;
          t.staged = undefined;
          t.path = to.path;
          t.goal = to.dock;
          t.state = 'toBay';
          return;
        }
        // Parked until a loading spot comes free, or there is nothing to wait for.
        if (!bay || this.map.build[t.park ?? -1] !== Build.Parking) return this.leavePark(t);
        if ((this.tick + t.id) % 10 !== 0) return;
        if (this.collectable(bay) === 0 && (t.idle += 10) >= B.TRUCK_GIVE_UP) {
          return this.leavePark(t);
        }
        // A yard no truck can load at and drive away from again: it goes.
        if (bay.noAccess) return this.leavePark(t);
        if (t.boxes && !this.handlerFree(bay, t)) return;
        const to = this.dockFor(
          bay,
          (d, avoid) =>
            this.routeFrom(t, d, this.avoiding(this.truckCostFor(bay.idx, -1, t), avoid)),
          this.lengthOf(t),
        );
        if (!to) {
          // No free spot it could get to and drive away from again: it
          // gives up in a while, and the bay shows why.
          if (!this.dockRouted && this.freeDockSet(bay, this.lengthOf(t)).size > 0) {
            this.cutOff(bay, this.dockTurn);
            this.leavePark(t);
          }
          return;
        }
        const { dock, path } = to;
        t.park = undefined;
        t.path = path;
        t.goal = dock;
        t.state = 'toBay';
        return;
      }
      case 'toBay': {
        if (!bay) return t.exports ? this.headOut(t) : this.truckLeave(t);
        if (t.backing) {
          if (this.backIn(t, bay)) t.state = t.exports ? 'delivering' : 'loading';
          return;
        }
        if (bay.tiles && (this.tick + t.id) % 10 === 0) this.goDeeper(t, bay);
        const cost = this.truckCostFor(t.bayIdx, -1, t);
        const r = this.move(
          t,
          cost,
          false,
          this.pace(t, cost),
          this.mayEnter(t),
          this.truckReroute(t),
        );
        if (r === 'blocked') {
          if (t.exports) bay.exportIncoming = Math.max(0, (bay.exportIncoming ?? 0) - t.cargo);
          return this.removeTruck(t);
        }
        if (r === 'arrived') t.state = t.exports ? 'delivering' : 'loading';
        else if (r === 'moving') this.startBacking(t, bay);
        return;
      }
      case 'delivering': {
        // Unloading a shipper's goods into storage, for the ships.
        if (!bay) return this.headOut(t);
        // Ice in a truck bay comes off by hand, dockhands' and forklifts'.
        if (this.iceTruck(t) && truckBay(bay)) {
          if (t.cargo <= 0 && (t.taking ?? 0) === 0) this.headOut(t);
          return;
        }
        // Containers at a yard with no gantry come off by reach stacker.
        if (this.byStacker(t, bay)) {
          if (t.cargo <= 0) {
            tip(this, 'exports');
            this.headOut(t);
          }
          return;
        }
        if (this.gantryElsewhere(t, bay)) return;
        if (bay.gantryOn === t.id) {
          // Off the truck onto the gantry's spreader: it may go on its way
          // now, while the gantry carries it along and sets it down.
          if (!this.liftTaken(bay)) return;
          this.offToGantry(bay, {
            by: t.id,
            at: this.gantryLane(bay)?.get(t.goal) ?? 0,
            slot: t.cargo - 1,
            fees: [t.value],
            looks: [boxLookOf(t.id, t.cargo - 1)],
            exports: true,
            planned: 1,
          });
        } else {
          if (++t.timer % this.truckTicks(t, bay) !== 0) return;
          this.exportLooks(bay).push(boxLookOf(t.id, t.cargo - 1));
          (bay.exports ??= []).push(t.value);
          // Canned fish waits there for its export papers.
          this.startHolds(bay, [t.value], true);
          bay.exportIncoming = Math.max(0, (bay.exportIncoming ?? 0) - 1);
        }
        if (--t.cargo <= 0) {
          tip(this, 'exports');
          this.headOut(t);
        }
        return;
      }
      case 'loading': {
        if (!bay) return this.truckLeave(t);
        const every = this.truckTicks(t, bay);
        if (t.cargo < t.capacity && this.gantryElsewhere(t, bay)) return;
        if (bay.gantryOn === t.id ? !this.liftDone(bay) : ++t.timer % every !== 0) return;
        this.gantryDone(bay, t.id);
        // Containers at a yard with no gantry go on by reach stacker: it
        // waits while one is on its way.
        // With nothing more here for it, it goes with what it has rather
        // than wait for more.
        // None of the kind of crate it takes, either.
        const none = () =>
          this.unclaimed(bay, t.boxes, t) <= 0 || (!t.boxes && this.cratesFor(t, bay) <= 0);
        const done = (t.coming ?? 0) === 0 && none();
        // Crates go on by hand: dockhands and forklifts load it, as
        // containers at a yard with no gantry go on by reach stacker.
        const hands = this.byHand(t, bay);
        if (this.byStacker(t, bay) || hands) {
          if ((t.coming ?? 0) > 0) t.idle = 0;
          else t.idle += every;
          const full = t.cargo >= t.capacity;
          // With crates there for it, it waits as long as it would for any.
          const waiting = hands && this.cratesFor(t, bay) > 0;
          const bored =
            t.cargo > 0 && !waiting ? t.idle >= B.TRUCK_PATIENCE : t.idle >= B.TRUCK_GIVE_UP;
          if (full || bored || done) this.truckLeave(t);
          return;
        }
        const stock = t.boxes ? bay.boxes : bay.crates;
        // Containers only once customs have cleared them, whichever those
        // are: under a gantry, the one it took up.
        const lifted = t.lifting === undefined ? -1 : this.boxLooks(bay).indexOf(t.lifting);
        t.lifting = undefined;
        const at = t.boxes && bay.yard ? (lifted >= 0 ? lifted : this.clearTop(bay)) : 0;
        // Crates its crew loads besides those dockhands and forklifts bring
        // it: none they are on their way for, nor more than it has room for
        // with theirs.
        const spare = t.boxes ? stock.length : this.cratesFor(t, bay);
        const coming = t.boxes ? 0 : (t.coming ?? 0);
        if (coming > 0) t.idle = 0;
        if (spare > 0 && at >= 0 && t.cargo + coming < t.capacity) {
          if (t.boxes && bay.yard) this.yardSlots(bay).boxes.splice(at, 1);
          if (t.boxes && bay.yard) this.readyList(bay).splice(at, 1);
          if (t.boxes && bay.yard) (t.looks ??= []).push(this.boxLooks(bay).splice(at, 1)[0]);
          const fee = t.boxes ? stock.splice(at, 1)[0] : this.cratesOff(t, bay, at, 1)[0];
          t.value += fee;
          if (!t.boxes) (t.fees ??= []).push(fee);
          t.cargo++;
          t.idle = 0;
        } else {
          t.idle += every;
        }
        const full = t.cargo >= t.capacity;
        const bored = t.cargo > 0 ? t.idle >= B.TRUCK_PATIENCE : t.idle >= B.TRUCK_GIVE_UP;
        if (full || bored || (done && none())) this.truckLeave(t);
        return;
      }
      case 'toTown': {
        if (t.round) {
          if (this.driveRound(t)) t.round = undefined;
          return;
        }
        const cost = this.truckCostFor(t.goal, t.bayIdx);
        const r = this.move(
          t,
          cost,
          false,
          this.pace(t, cost),
          this.mayEnter(t),
          this.truckReroute(t),
        );
        if (r === 'blocked') this.headOut(t);
        else if (r === 'arrived' && t.then && this.town) {
          // Out on the highway: round past the edge of the map and in on the town's road.
          const m = this.map;
          const gate = this.town.gate;
          const ey = m.yOf(m.entry) + 0.5;
          const gy = m.yOf(gate) + 0.5;
          t.round = [HIGHWAY_X, ey, HIGHWAY_X, gy, m.xOf(gate) + 0.5, gy];
          t.path = t.then;
          t.goal = t.then.length > 0 ? t.then[t.then.length - 1] : gate;
          t.then = undefined;
        } else if (r === 'arrived') {
          t.state = 'unloading';
          t.timer = 0;
        }
        return;
      }
      case 'unloading': {
        const n = t.dropCount ?? 0;
        if (++t.timer < n * B.UNLOAD_TICKS) return;
        // Just the crates the business takes come off; the rest go on by road.
        const def = BUSINESSES[this.map.build[t.drop ?? -1]];
        const fees = t.fees ?? [];
        const off: number[] = [];
        if (!t.boxes && def) {
          for (let k = 0; k < fees.length && off.length < n;) {
            if (def.takes.includes(cargoOf(fees[k]))) off.push(...fees.splice(k, 1));
            else k++;
          }
        }
        const worth =
          off.length > 0 ? off.reduce((a, f) => a + f, 0) : (t.value * n) / Math.max(1, t.cargo);
        // The town pays a little extra for goods brought to its door.
        const bonus = Math.round(worth * B.TOWN_DELIVERY_BONUS);
        if (bonus > 0) {
          book(this, 'town', bonus);
          this.stats.earned += bonus;
          moneyAt(this, bonus, t.drop ?? this.tileOf(t));
        }
        if (this.town) this.town.local += t.boxes ? n * B.CONTAINER_GOODS : n;
        t.value -= Math.round(worth);
        t.cargo -= n;
        this.headOut(t);
        return;
      }
      case 'leaving': {
        const cost = this.truckCostFor(t.goal, t.bayIdx, t);
        const r = this.move(
          t,
          cost,
          false,
          this.pace(t, cost),
          this.mayEnter(t),
          this.truckReroute(t),
        );
        if (r === 'arrived' || r === 'blocked') this.removeTruck(t);
        return;
      }
    }
  }

  /** Trucks stop at a level crossing while the barriers are down. */
  level = (i: number): boolean =>
    this.map.build[i] !== Build.Crossing ||
    // As the barriers will be by the end of this tick: the train moves after the trucks.
    !crossingClosed(this.rail.train, this.map.yOf(i), 1);

  // ── Rules of the road ─────────────────────────────────────
  //
  // Trucks keep to the right (see snapshot), so those going opposite ways
  // pass each other, and never hold each other up, even turning across
  // one another. Going the same way, each keeps its distance behind the
  // one ahead. A junction is where the rules come in: a truck goes onto one
  // only with room to get off it again, waits while another is driving
  // across it, and gives way to traffic on a bigger road and to traffic
  // coming from its right. Out of parking,
  // it gives way to everything. Only moving traffic is given way to; between
  // two trucks both standing at the line, one goes and the other waits, by
  // an order that takes turns, so two never wait for each other. A truck
  // held up for long enough waives the rules, then its room, and at the
  // very last its distance, so the roads never lock up for good.

  /** Loading at the kerb, unloading in town, parked or away on the highway: off the road. */
  onRoad(o: Truck): boolean {
    return (
      o.state !== 'loading' &&
      o.state !== 'delivering' &&
      o.state !== 'unloading' &&
      o.state !== 'parked' &&
      !o.round
    );
  }

  /** On the road and moving, rather than standing in a queue or at a line. */
  rolling(o: Vehicle): boolean {
    if (!isTruck(o)) return o.path.length > 0 && o.blocked === 0;
    return this.onRoad(o) && o.path.length > 0 && (o.held ?? 0) === 0;
  }

  /** Each vehicle's tile, and the one it came onto it from, by id; see noteTiles. Not saved. */
  cameFrom = new Map<number, { tile: number; from: number }>();

  /** Note which tile each truck and machine is on, and which it came from onto it. */
  noteTiles(): void {
    const seen = new Set<number>();
    for (const v of [...this.trucks, ...this.people]) {
      if (!isTruck(v) && !isBoxy(v)) continue;
      seen.add(v.id);
      const tile = this.tileOf(v);
      const rec = this.cameFrom.get(v.id);
      if (!rec) this.cameFrom.set(v.id, { tile, from: -1 });
      else if (rec.tile !== tile) {
        rec.from = rec.tile;
        rec.tile = tile;
      }
    }
    if (this.cameFrom.size > seen.size + 64) {
      for (const id of this.cameFrom.keys()) if (!seen.has(id)) this.cameFrom.delete(id);
    }
  }

  /**
   * The way a truck or machine goes across junction `i`, keeping right,
   * about the tile's middle (see laneLine): all of it coming up to it, what
   * is left of it, its tail and all, once on it. Null when not known.
   */
  wayAcross(v: Vehicle, i: number): readonly (readonly [number, number])[] | null {
    const m = this.map;
    const here = this.tileOf(v);
    const lane = isTruck(v) ? B.TRUCK_LANE : B.MACHINE_LANE;
    let from: number;
    let to: number | undefined;
    if (here === i) {
      // Where it came onto it from; or, not seen coming, the way it faces.
      const rec = this.cameFrom.get(v.id);
      const ax = Math.cos(v.dir);
      const ay = Math.sin(v.dir);
      const [bx, by] = Math.abs(ax) >= Math.abs(ay) ? [Math.sign(ax), 0] : [0, Math.sign(ay)];
      const back = m.inBounds(m.xOf(i) - bx, m.yOf(i) - by)
        ? m.idx(m.xOf(i) - bx, m.yOf(i) - by)
        : -1;
      from = rec && rec.tile === i && rec.from >= 0 ? rec.from : back;
      if (from < 0) return null;
      to = v.path[0] === i ? v.path[1] : v.path[0];
    } else {
      const k = v.path.indexOf(i);
      if (k < 0 || k > 1) return null;
      from = k === 0 ? here : v.path[0];
      to = v.path[k + 1];
    }
    const near = m.neighbors4(i);
    if (!near.includes(from)) return null;
    const h = this.heading(from, i);
    const e = to !== undefined && near.includes(to) ? this.heading(i, to) : h;
    const way = laneLine(h, e, lane);
    if (here !== i) return way;
    const x = v.x - Math.sin(v.dir) * lane - (m.xOf(i) + 0.5);
    const y = v.y + Math.cos(v.dir) * lane - (m.yOf(i) + 0.5);
    return wayFrom(way, [x, y], this.vehicleLength(v) / 2);
  }

  /**
   * Whether `o`, though in front of `t`, is only crossing the junction or
   * bend just ahead of it on a way that never meets its own, as one turns
   * off a roundabout where the other comes on, or two going opposite ways
   * round a corner keep to their own sides of it: then it is not in its way.
   * Not only the first such ahead: one still rounding the corner of a
   * roundabout before the arm it turns off at is not held up by one that
   * has come on there.
   */
  clearAcross(t: Vehicle, o: Vehicle): boolean {
    // One broken down there is not crossing: it stands in the way of all.
    if (this.brokenDown(o)) return false;
    const junctions = this.junctions();
    const j = [this.tileOf(t), t.path[0], t.path[1]].find(
      (i) =>
        i !== undefined &&
        (this.tileOf(o) === i || o.path[0] === i) &&
        (junctions[i] === 1 || (this.wayAcross(t, i)?.length ?? 0) >= 3),
    );
    if (j === undefined) return false;
    const a = this.wayAcross(t, j);
    const b = a && this.wayAcross(o, j);
    return !!a && !!b && !waysMeet(a, b);
  }

  /** Trucks on the road and the port machines driving among them. */
  traffic(): Vehicle[] {
    return [...this.trucks.filter((o) => this.onRoad(o)), ...this.machinesOnRoad()];
  }

  /**
   * How far a truck may drive this tick: its speed, short of a safe gap
   * behind the one ahead. Driving by `cost`, it finds a way round one
   * standing in its way, as goRound.
   */
  pace(t: Truck, cost?: CostFn): () => number {
    return () => {
      const still = t.path.length > 0 && t.x === t.lastX && t.y === t.lastY;
      t.held = still ? (t.held ?? 0) + 1 : 0;
      t.lastX = t.x;
      t.lastY = t.y;
      // Off the map at the end of the way, it drives on out.
      const stop = t.state !== 'leaving';
      // Up to speed on the highway, between its exits, slowing for one ahead.
      const here = this.tileOf(t);
      const fast =
        isHighway(this.map.build[here]) &&
        [here, t.path[0], t.path[1]].every(
          (i) => i === undefined || (isHighway(this.map.build[i]) && !isExit(this.map, i)),
        );
      const speed = fast ? B.HIGHWAY_SPEED : B.TRUCK_SPEED;
      if (t.held > B.TRUCK_SQUEEZE_AFTER * 4) return this.drive(t, speed, Infinity, stop);
      const gap = this.gapAhead(t) - B.TRUCK_GAP;
      const room = Math.min(gap, this.toStopLine(t), this.toCrossing(t, gap));
      if (cost && t.held === B.REROUTE_AFTER) this.goRound(t, cost);
      return this.drive(t, speed, room, stop);
    };
  }

  /**
   * Held up behind a truck standing at a loading spot, or a machine at
   * work, a truck finds a way round it if there is a short one, by the
   * other lane of a wide road, rather than wait there until it is done: a
   * truck loading beside a through road would otherwise hold up all behind
   * it, and the queue back up across the roads it crosses until they lock.
   */
  goRound(t: Truck, cost: CostFn): void {
    const standing = this.standingTiles();
    const o = [...this.trucks, ...this.people].find((q) => q.id === t.blocker);
    if (!o || !standing.has(this.tileOf(o))) return;
    const path = this.drivePath(
      this.tileOf(t),
      this.behind(t),
      t.goal,
      // Some way along the other lane is shorter than waiting for it.
      (i, from) => cost(i, from) + (standing.has(i) ? 20 : 0),
    );
    if (path) t.path = path;
  }

  /**
   * How far a truck can go before its front bumper reaches the edge of a
   * tile it may not drive into yet (a junction it must give way at, or a
   * level crossing with the barriers down): a long truck stops with its
   * nose at the line, not in the junction. Infinity if none is near.
   */
  toStopLine(t: Vehicle): number {
    if (t.path.length === 0) return Infinity;
    const m = this.map;
    const here = this.tileOf(t);
    const half = this.vehicleLength(t) / 2;
    const enter = this.mayEnter(t);
    let d = Math.hypot(m.xOf(t.path[0]) + 0.5 - t.x, m.yOf(t.path[0]) + 0.5 - t.y);
    for (let k = 0; k < t.path.length && d - 0.5 < half + 1.5; k++) {
      const i = t.path[k];
      if (i !== here && !enter(i)) return d - 0.5 - half;
      d += 1;
    }
    return Infinity;
  }

  /**
   * Don't block the box: how far a truck can go before its front reaches a
   * tile just ahead that another's way crosses, when the queue in front
   * would leave it standing there across that way; Infinity if none is
   * near. Where roads two wide meet there is no junction to wait at (see
   * junctions), and a queue backing up through a crossing stops the
   * traffic across it, which on a loop of roads stops the queue itself.
   */
  toCrossing(t: Truck, room: number): number {
    if (room === Infinity || t.path.length === 0) return Infinity;
    const m = this.map;
    const crossings = this.crossings();
    const here = this.tileOf(t);
    const half = this.lengthOf(t) / 2;
    let x = t.x;
    let y = t.y;
    let d = 0;
    for (const i of t.path) {
      const cx = m.xOf(i) + 0.5;
      const cy = m.yOf(i) + 0.5;
      const len = Math.hypot(cx - x, cy - y);
      d += len;
      // Up to its front, and as far as it could go anyway.
      if (d - 0.5 > room + half) break;
      // Not where it is going to stop anyway.
      if (i !== here && i !== t.goal && len > 1e-6) {
        const hx = (cx - x) / len;
        const hy = (cy - y) / len;
        const across = crossings
          .get(i)
          ?.some((c) => c.id !== t.id && Math.abs(c.dx * hx + c.dy * hy) < 0.5);
        // Its nose already in it, it goes on; else it stops short unless
        // there is room to get all the way over.
        if (across && d - 0.5 >= half - 0.05 && room < d + 0.5 + half) return d - 0.5 - half;
      }
      x = cx;
      y = cy;
    }
    return Infinity;
  }

  /** The tiles trucks and machines in traffic are about to drive onto, and which way; once a tick. */
  crossings(): Map<number, Crossing[]> {
    if (this.crossingCache?.tick === this.tick) return this.crossingCache.at;
    const m = this.map;
    const at = new Map<number, Crossing[]>();
    for (const o of this.traffic()) {
      let from = this.tileOf(o);
      for (const i of o.path.slice(0, 3)) {
        if (i === from) continue;
        const dx = m.xOf(i) - m.xOf(from);
        const dy = m.yOf(i) - m.yOf(from);
        const len = Math.hypot(dx, dy);
        const list = at.get(i) ?? [];
        list.push({ id: o.id, dx: dx / len, dy: dy / len });
        at.set(i, list);
        from = i;
      }
    }
    this.crossingCache = { tick: this.tick, at };
    return at;
  }

  /** Where a truck is on the road: on the right-hand side of it, or in the middle of a parking space. */
  lanePos(o: Truck): [number, number] {
    if (o.state === 'parked') return [o.x, o.y];
    return [o.x - Math.sin(o.dir) * B.TRUCK_LANE, o.y + Math.cos(o.dir) * B.TRUCK_LANE];
  }

  /** Room to the back of the nearest truck ahead in the same lane, going the same way; Infinity if none. */
  gapAhead(t: Truck): number {
    this.passRing(t);
    let best = Infinity;
    t.blocker = undefined;
    for (const o of this.trucks) {
      // A truck standing at a loading spot holds up the lane like any other,
      // where it is on the way: round the corners, as one turning off short
      // of it gets by.
      if (o === t || !(this.onRoad(o) || this.docked(o))) continue;
      if (t.passing?.ids.includes(o.id)) continue;
      // Out on the highway, off the port's ground, trucks pass through each
      // other rather than ever queue: none holds up another there.
      if (isHighway(this.map.build[this.tileOf(o)])) continue;
      if (this.clearAcross(t, o)) continue;
      const along = this.docked(o) ? this.onWay(t, o) : this.ahead(t, o);
      // Two caught across each other, as one turns past the other: the newer one waits.
      if (along < 0 || (o.id > t.id && this.ahead(o, t) >= 0)) continue;
      // Bumper to bumper: half of each truck's length off the middles.
      const gap = along - (this.lengthOf(t) + this.lengthOf(o)) / 2;
      if (gap < best) {
        best = gap;
        t.blocker = o.id;
      }
    }
    // And behind a reach stacker or tractor in its way, as behind a truck.
    for (const o of this.machinesOnRoad()) {
      if (t.passing?.ids.includes(o.id) || this.clearAcross(t, o)) continue;
      const along = this.onWay(t, o);
      if (along < 0 || (o.path.length > 0 && o.id > t.id && this.onWay(o, t) >= 0)) continue;
      const gap = along - (this.lengthOf(t) + this.vehicleLength(o)) / 2;
      this.makeWay(o);
      if (gap < best) {
        best = gap;
        t.blocker = o.id;
      }
    }
    return best;
  }

  /**
   * Trucks and machines each waiting on the next all the way round, as
   * where a wide road crosses itself: one of them drives on through the
   * rest, minding only what else is about, until it has gone its own length
   * and is clear of where they were all caught. Not only while it is held
   * up: once it moves it no longer is, and it would stop again at once
   * behind the one it was waiting on. It goes once any of them has waited
   * long enough, not only itself: one that has just edged onto another
   * tile has its own wait start again.
   */
  passRing(v: Vehicle): void {
    const ring = this.heldFor(v) > 0 ? this.ring(v) : null;
    if (ring && Math.max(...[v, ...ring].map((o) => this.heldFor(o))) > B.TRUCK_RING_AFTER) {
      v.passing = { ids: ring.map((o) => o.id), x: v.x, y: v.y };
    }
    const pass = v.passing;
    if (pass && Math.hypot(v.x - pass.x, v.y - pass.y) > this.vehicleLength(v) + B.TRUCK_GAP) {
      v.passing = undefined;
    }
  }

  /**
   * The others in a ring of trucks and machines each held up behind the
   * next, back round to this one, when this is the one of them to go; null
   * if it is in none, or another is to go. The one to go is held up by one
   * crossing its way or coming at it, not queueing behind one going its
   * way, as only going on through that undoes the knot: the lowest numbered
   * such, or of them all if none is.
   */
  ring(t: Vehicle): Vehicle[] | null {
    if (this.vehicleCache?.tick !== this.tick) {
      const by = new Map<number, Vehicle>(this.trucks.map((o) => [o.id, o]));
      for (const q of this.people) if (isBoxy(q)) by.set(q.id, q);
      this.vehicleCache = { tick: this.tick, by };
    }
    const by = this.vehicleCache.by;
    let at: Vehicle | undefined = t;
    const ring: Vehicle[] = [t];
    // However far round: a loop of roads can fill all the way.
    while (at?.blocker !== undefined) {
      at = by.get(at.blocker);
      if (!at || this.heldFor(at) === 0 || (at !== t && ring.includes(at))) return null;
      if (at === t) {
        const across = ring.filter(
          (v) => Math.cos(this.goingTo(by.get(v.blocker!)!) - this.goingTo(v)) < 0.7,
        );
        const go = (across.length > 0 ? across : ring).reduce((a, b) => (b.id < a.id ? b : a));
        return go === t ? ring.slice(1) : null;
      }
      ring.push(at);
    }
    return null;
  }

  /**
   * How far ahead of truck `t` truck `o` is, in its lane and not coming the
   * other way on its own side of the road, short of where it turns off;
   * -1 if it is not.
   */
  ahead(t: Truck, o: Truck): number {
    const m = this.map;
    let reach = 3 + this.lengthOf(t);
    // The way it is about to go, which for one setting off from where it
    // stood may not be the way it faces yet.
    const dir = this.goingTo(t);
    const hx = Math.cos(dir);
    const hy = Math.sin(dir);
    // Only as far as the tile where its way turns: what is straight on past
    // that is off its way, as one in the lane beside it it turns away from.
    let along0 = 0;
    for (const i of t.path) {
      const dx = m.xOf(i) + 0.5 - t.x;
      const dy = m.yOf(i) + 0.5 - t.y;
      if (Math.abs(dy * hx - dx * hy) > 0.05) {
        reach = Math.min(reach, along0 + 0.5);
        break;
      }
      along0 = dx * hx + dy * hy;
      if (along0 > reach) break;
    }
    const tx = t.x - hy * B.TRUCK_LANE;
    const ty = t.y + hx * B.TRUCK_LANE;
    const [ox, oy] = this.lanePos(o);
    const dx = ox - tx;
    const dy = oy - ty;
    const along = dx * hx + dy * hy;
    if (along < 0 || along > reach) return -1;
    // Going the other way, by where it is headed rather than how it faces,
    // it passes: the two never hold each other up.
    if (Math.abs(dy * hx - dx * hy) > 0.45 || Math.cos(this.goingTo(o) - dir) < -0.2) return -1;
    return along;
  }

  /**
   * How far along its way truck or machine `t` comes up to truck or
   * machine `o`: round its corners and across its diagonals, in its lane
   * and not coming the other way on its own side of the road, a little
   * past the end of its way; -1 if it does not.
   */
  onWay(t: Vehicle, o: Vehicle): number {
    const m = this.map;
    const reach = 3 + this.vehicleLength(t);
    const lane = isTruck(t) ? B.TRUCK_LANE : B.MACHINE_LANE;
    const [ox, oy] = this.roadPos(o);
    let x = t.x;
    let y = t.y;
    let dir = t.dir;
    let run = 0;
    for (let k = 0; k <= t.path.length && run < reach; k++) {
      // Past the end of its way, only as far as its own front reaches.
      const last = k === t.path.length;
      const on = last ? this.vehicleLength(t) / 2 + B.TRUCK_GAP : 0;
      const nx = last ? x + Math.cos(dir) * on : m.xOf(t.path[k]) + 0.5;
      const ny = last ? y + Math.sin(dir) * on : m.yOf(t.path[k]) + 0.5;
      const len = Math.hypot(nx - x, ny - y);
      if (len < 1e-6) continue;
      const hx = (nx - x) / len;
      const hy = (ny - y) / len;
      dir = Math.atan2(hy, hx);
      const dx = ox - (x - hy * lane);
      const dy = oy - (y + hx * lane);
      const along = dx * hx + dy * hy;
      const across = Math.abs(dy * hx - dx * hy);
      // Clear of each other side by side; round a corner, what is just
      // short of it only if it has turned that way already.
      // Facing its way counts as much as going it: one stopped to turn
      // about still fills the lane it stands in.
      const facing = Math.max(Math.cos(this.goingTo(o) - dir), Math.cos(o.dir - dir));
      const from = k > 0 && facing > 0.7 ? -0.3 : 0;
      // One broken down fills the road as far as it reaches across it,
      // whichever way it faces.
      const broken = this.brokenDown(o);
      const wide = broken ? (Math.abs(Math.sin(o.dir - dir)) * this.vehicleLength(o)) / 2 : 0;
      if (along >= from && along <= len && across <= 0.3 + wide && (broken || facing >= -0.2)) {
        return run + Math.max(0, along);
      }
      run += len;
      x = nx;
      y = ny;
    }
    return -1;
  }

  /** A machine broken down where it stands, waiting for its repair: nothing gets past it. */
  brokenDown(o: Vehicle): boolean {
    return !isTruck(o) && o.state === 'broken';
  }

  /** Where a truck or machine is on the road: on the right-hand side of it, as each is shown. */
  roadPos(o: Vehicle): [number, number] {
    if (isTruck(o)) return this.lanePos(o);
    const lane = B.MACHINE_LANE;
    return [o.x - Math.sin(o.dir) * lane, o.y + Math.cos(o.dir) * lane];
  }

  /** How long a truck or machine is, in tiles. */
  vehicleLength(o: Vehicle): number {
    return isTruck(o) ? this.lengthOf(o) : B.MACHINE_LENGTH[o.kind as 'stacker' | 'tractor'];
  }

  /** How long a truck or machine has been held up, in ticks. */
  heldFor(o: Vehicle): number {
    return isTruck(o) ? (o.held ?? 0) : o.blocked;
  }

  /** Which way a truck or machine is going: towards the next tile on its way, or the way it faces. */
  goingTo(t: Vehicle): number {
    const next = t.path[0];
    if (next === undefined) return t.dir;
    const dx = this.map.xOf(next) + 0.5 - t.x;
    const dy = this.map.yOf(next) + 0.5 - t.y;
    return Math.hypot(dx, dy) > 1e-3 ? Math.atan2(dy, dx) : t.dir;
  }

  /** How long a truck is, in tiles. */
  lengthOf(t: Truck): number {
    return B.truckLength(t.capacity, t.boxes);
  }

  /**
   * Where three or more roads meet, for the trucks. Not inside a stretch of
   * port road two or more wide all round, where trucks drive as they find
   * room. Cleared when the port changes.
   */
  junctions(): Uint8Array {
    if (this.junctionCache) return this.junctionCache;
    const m = this.map;
    const road = truckCost(m);
    const out = new Uint8Array(m.build.length);
    for (let i = 0; i < m.build.length; i++) if (junctionAt(m, i, road)) out[i] = 1;
    this.junctionCache = out;
    return out;
  }

  /**
   * Where a truck has room to come round and go back the way it came: a
   * junction, where it can back into the side road; a block of road two
   * wide each way; a truck bay or business it drives into; and the highway
   * off the edge of the map. Nowhere else does it turn about on the spot.
   * Cleared when the port changes.
   */
  turnable(i: number): boolean {
    if (!this.turnCache) {
      const m = this.map;
      const road = truckCost(m);
      const ok = (x: number, y: number) =>
        m.inBounds(x, y) && Number.isFinite(road(m.idx(x, y))) && !isHighway(m.build[m.idx(x, y)]);
      const out = new Uint8Array(m.build.length);
      const junctions = this.junctions();
      // No coming round on the highway, nor anywhere on a one-way road.
      const highway = hasHighway(m);
      for (let k = 0; k < m.build.length; k++) {
        const b = m.build[k];
        if (isHighway(b) || oneWay(m, k) >= 0) continue;
        const end = !highway && (k === m.entry || k === this.town?.gate);
        if (end || isBay(b) || isTownBuilding(b)) {
          out[k] = 1;
          continue;
        }
        if (!Number.isFinite(road(k))) continue;
        const ways = m
          .neighbors4(k)
          .filter((n) => Number.isFinite(road(n)) && linked(m, k, n)).length;
        const x = m.xOf(k);
        const y = m.yOf(k);
        const open = [-1, 1].some((dx) =>
          [-1, 1].some((dy) => ok(x + dx, y) && ok(x, y + dy) && ok(x + dx, y + dy)),
        );
        if (junctions[k] || ways >= 3 || open) out[k] = 1;
      }
      this.turnCache = out;
    }
    return this.turnCache[i] === 1;
  }

  /** A truck's way from `from`, having come from `cameFrom` (-1: either way), never turning about where it cannot. */
  drivePath(from: number, cameFrom: number, goal: number, cost: CostFn): number[] | null {
    const m = this.map;
    return findDrivePath(m.w, m.h, from, cameFrom, goal, cost, (i) => this.turnable(i));
  }

  /** A truck's new way to its goal when the old one is blocked: never turning about where it cannot. */
  truckReroute(t: Truck): (cost: CostFn) => number[] | null {
    return (cost) => this.drivePath(this.tileOf(t), this.behind(t), t.goal, cost);
  }

  /** The tile a truck has just come from, by the way it faces. */
  behind(t: Truck): number {
    const m = this.map;
    const here = this.tileOf(t);
    const dx = Math.round(Math.cos(t.dir));
    const dy = Math.round(Math.sin(t.dir));
    if (Math.abs(dx) + Math.abs(dy) !== 1) return -1;
    const x = m.xOf(here) - dx;
    const y = m.yOf(here) - dy;
    return m.inBounds(x, y) ? m.idx(x, y) : -1;
  }

  /**
   * How much a road's traffic has priority: the highway over public road,
   * public road over port road, all over parking.
   */
  roadRank(i: number): number {
    const b = this.map.build[i];
    return isHighway(b) ? 3 : isPublicRoad(b) ? 2 : b === Build.Parking ? 0 : 1;
  }

  /**
   * Where a truck coming in for `goal` comes onto the map: off the end of
   * the highway nearer it, heading in; on a map without one, at the end of
   * the main road.
   */
  arrival(goal: number): { tile: number; dir: number } {
    const m = this.map;
    if (!hasHighway(m)) return { tile: m.entry, dir: 0 };
    const ins = highwayIns(m);
    const tile = nearestEnd(
      m,
      ins.map((s) => s.tile),
      m.yOf(goal),
    );
    return ins.find((s) => s.tile === tile)!;
  }

  /** Where a truck at `from` leaves the map: the end of the highway nearer it. */
  departure(from: number): number {
    const m = this.map;
    return hasHighway(m) ? nearestEnd(m, highwayOuts(m), m.yOf(from)) : m.entry;
  }

  /** Unit heading from tile `a` to the neighbouring tile `b`. */
  heading(a: number, b: number): [number, number] {
    const m = this.map;
    return [m.xOf(b) - m.xOf(a), m.yOf(b) - m.yOf(a)];
  }

  /** Whether a truck or machine about to drive onto junction `i` has room to drive off it again. */
  roomPast(t: Vehicle, i: number): boolean {
    const exit = t.path[1];
    if (exit === undefined) return true;
    const [ex, ey] = this.heading(i, exit);
    for (const o of this.traffic()) {
      if (o === t || this.rolling(o)) continue;
      const tile = this.tileOf(o);
      if (tile !== exit && tile !== i) continue;
      // Standing just past it in the lane we want, or still on it going our way.
      if (Math.cos(o.dir) * ex + Math.sin(o.dir) * ey > 0.7) return false;
    }
    return true;
  }

  /**
   * Of two trucks both standing at a junction, which goes first: a strict
   * order at any moment, so that one of them does, which turns over every
   * few seconds so that both get to.
   */
  goesFirst(a: Vehicle, b: Vehicle, i: number): boolean {
    const turn = Math.floor(this.tick / B.TRUCK_TAKE_TURNS) + i;
    return (turn & 1) === 0 ? a.id < b.id : a.id > b.id;
  }

  /**
   * Whether a truck, or a port machine in traffic, may drive on into tile
   * `i`: the level crossing is open, and at a junction, or coming out of
   * parking, the rules of the road let it.
   */
  mayEnter(t: Vehicle): (i: number) => boolean {
    return (i) => {
      const m = this.map;
      // Its nose already over the line: it is committed, and goes on
      // rather than stop across the junction.
      const d = Math.hypot(m.xOf(i) + 0.5 - t.x, m.yOf(i) + 0.5 - t.y);
      if (d - 0.5 < this.vehicleLength(t) / 2 - 0.05 && i === t.path[0]) return true;
      // Onto and along the highway nobody gives way: they pass through each other there.
      if (isHighway(m.build[i])) return true;
      if (!this.level(i)) return false;
      const here = this.tileOf(t);
      const fromParking = m.build[here] === Build.Parking && m.build[i] !== Build.Parking;
      if (!this.junctions()[i] && !fromParking) return true;
      const held = this.heldFor(t);
      if (held > B.TRUCK_SQUEEZE_AFTER * 2) return true;
      if (!this.roomPast(t, i)) return false;
      const [hx, hy] = this.heading(here, i);
      const exit = t.path[1];
      const [ex, ey] = exit === undefined ? [hx, hy] : this.heading(i, exit);
      // Only those whose way across the junction meets ours hold us up:
      // not one turning off where we turn on, or into a side road as we
      // turn out of it, in the other lane.
      const mine = this.wayAcross(t, i);
      const meets = (o: Vehicle) => {
        const theirs = mine && this.wayAcross(o, i);
        return !mine || !theirs || waysMeet(mine, theirs);
      };
      // Traffic lights: only on green, then minding what is still across it.
      if (hasLights(m, i)) {
        const green = greenAt(i, this.tick);
        if (green !== (hx !== 0 ? 'ew' : 'ns')) return false;
        for (const o of this.traffic()) {
          if (o === t || this.tileOf(o) !== i || !this.rolling(o)) continue;
          const ox = Math.cos(o.dir);
          const oy = Math.sin(o.dir);
          if (ox * ex + oy * ey > 0.7 || !meets(o)) continue;
          return false;
        }
        return true;
      }
      if (held > B.TRUCK_SQUEEZE_AFTER) return true;

      const rank = fromParking ? 0 : this.roadRank(here) + this.onOneWay(here, i);
      const cx = m.xOf(i) + 0.5;
      const cy = m.yOf(i) + 0.5;
      for (const o of this.traffic()) {
        if (o === t || o.path.length === 0) continue;
        const ox = Math.cos(o.dir);
        const oy = Math.sin(o.dir);
        const there = this.tileOf(o);
        if (there === i) {
          // Driving across it now, other than on our way out of it, or
          // on a way that never meets ours.
          if (!this.rolling(o)) continue;
          if (ox * ex + oy * ey > 0.7 || !meets(o)) continue;
          return false;
        }
        // Coming up to it, from another road.
        if (o.path[0] !== i && !(o.path[1] === i && this.rolling(o))) continue;
        const dx = o.x - cx;
        const dy = o.y - cy;
        if (Math.hypot(dx, dy) > 1.8) continue;
        const along = ox * hx + oy * hy;
        // Behind us, our way; or coming the other way, which never holds
        // us up, even turning across it; or going a way that never meets ours.
        if (along > 0.7 || along < -0.7 || !meets(o)) continue;
        const theirRank =
          m.build[there] === Build.Parking && m.build[i] !== Build.Parking
            ? 0
            : this.roadRank(there) + this.onOneWay(there, i);
        const fromRight = dx * -hy + dy * hx > 0.5;
        const yields = theirRank > rank || (theirRank === rank && fromRight);
        if (!yields) continue;
        if (this.rolling(o)) return false;
        // Both standing: take turns, unless it is only queueing to get on.
        if (this.roomPast(o, i) && this.goesFirst(o, t, i)) return false;
      }
      return true;
    };
  }

  /**
   * Traffic already on a one-way road, going on along it through a
   * junction, has the right of way over traffic joining it: round a
   * roundabout, and down a one-way street.
   */
  onOneWay(from: number, junction: number): number {
    const m = this.map;
    const f = oneWay(m, junction);
    return !isHighway(m.build[junction]) && f >= 0 && oneWay(m, from) >= 0 ? 0.5 : 0;
  }

  /** Nobody standing at the end of the highway (or road) where a new truck comes in. */
  entryClear(tile = this.map.entry): boolean {
    const m = this.map;
    // Trucks on the highway pass through each other.
    if (isHighway(m.build[tile])) return true;
    const cx = m.xOf(tile) + 0.5;
    const cy = m.yOf(tile) + 0.5;
    return this.trucks.every(
      (o) =>
        !this.onRoad(o) || Math.hypot(o.x - cx, o.y - cy) > this.lengthOf(o) + B.TRUCK_GAP + 0.2,
    );
  }

  truckLeave(t: Truck): void {
    const bay = this.dest(t.bayIdx);
    if (bay) bay.nextTruckTick = this.tick + 30;
    // Off on its round: its haulier cannot send it again until it is back.
    const haulier = this.contracts.find((c) => c.id === t.contractId);
    if (haulier && !t.away) (haulier.returns ??= []).push(this.tick + B.TRUCK_ROUND_TRIP);
    t.away = true;
    if (t.cargo > 0) {
      if (this.town) this.town.today += t.boxes ? t.cargo * B.CONTAINER_GOODS : t.cargo;
      // Towards the town's next landmark, crates of what it wants sent out.
      const goal = this.town && landmarkGoal(this.town, this.tier)?.goal;
      if (goal && !goal.aboard && !t.boxes && this.town) {
        this.town.goal += (t.fees ?? []).filter((f) => cargoOf(f) === goal.cargo).length;
        openLandmark(this, landmarkDue(this.town, false, this.tier));
      }
      const income = t.value;
      book(this, t.boxes ? 'containers' : 'cargo', income);
      this.stats.earned += income;
      this.stats.trucks++;
      moneyAt(this, income, this.tileOf(t));
      if (this.deliverInTown(t)) return;
    }
    this.headOut(t);
  }

  /** What a crate truck is taking to town, in words: "crates of fish", or just "crates". */
  cratesOf(t: Truck): string {
    const def = BUSINESSES[this.map.build[t.drop ?? -1]];
    return def?.takes.length === 1 ? `crates of ${cargoName(def.takes[0])}` : 'crates';
  }

  /** How many of a truck's crates (or containers) a business takes. */
  takenBy(t: Truck, def: Business): number {
    if (def.boxes !== t.boxes) return 0;
    if (t.boxes) return t.cargo;
    return (t.fees ?? []).filter((f) => def.takes.includes(cargoOf(f))).length;
  }

  /**
   * Send a loaded truck by way of the town, when one of its businesses
   * takes what it carries and still wants some today, and the trucks can
   * get there.
   */
  deliverInTown(t: Truck): boolean {
    const town = this.town;
    if (!town) return false;
    const m = this.map;
    const takes = new Map<number, number>();
    for (const code of new Set(m.build)) {
      const def = BUSINESSES[code];
      const n = def ? Math.min(this.takenBy(t, def), Math.floor(town.wants[code] ?? 0)) : 0;
      if (n > 0) takes.set(code, n);
    }
    if (takes.size === 0) return false;
    const here = this.tileOf(t);
    // Out to the highway and round to the town's road, unless the roads join up on the map.
    const out =
      town.gate >= 0
        ? this.drivePath(here, this.behind(t), m.entry, this.truckCostFor(m.entry, t.bayIdx))
        : null;
    const round = Math.abs(m.yOf(town.gate) - m.yOf(m.entry)) + 2 * Math.abs(HIGHWAY_X);
    let best: { path: number[]; then?: number[]; len: number } | null = null;
    let drop = -1;
    for (let i = 0; i < m.build.length; i++) {
      if (!takes.has(m.build[i])) continue;
      // Delivered at the kerb, on the street the business faces.
      const front = frontOf(m, i, m.orient[i] & 3);
      if (front < 0 || !isPublicRoad(m.build[front])) continue;
      const cost = this.truckCostFor(front, t.bayIdx);
      const direct = this.drivePath(here, this.behind(t), front, cost);
      if (direct && (!best || direct.length < best.len)) {
        best = { path: direct, len: direct.length };
        drop = i;
      }
      const inn = out && this.drivePath(town.gate, -1, front, cost);
      const len = out && inn ? out.length + round + inn.length : Infinity;
      if (out && inn && (!best || len < best.len)) {
        best = { path: out, then: inn, len };
        drop = i;
      }
    }
    if (!best) return false;
    const code = m.build[drop];
    const count = takes.get(code)!;
    town.wants[code] = (town.wants[code] ?? 0) - count;
    t.state = 'toTown';
    t.path = best.path;
    t.then = best.then;
    t.goal = best.path.length > 0 ? best.path[best.path.length - 1] : here;
    t.drop = drop;
    t.dropCount = count;
    return true;
  }

  /** Along the highway past the edge of the map, from the port's road round to the town's. */
  driveRound(t: Truck): boolean {
    const r = t.round!;
    let budget = B.TRUCK_SPEED;
    while (budget > 1e-6 && r.length > 0) {
      const dx = r[0] - t.x;
      const dy = r[1] - t.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) t.dir = Math.atan2(dy, dx);
      if (d <= budget) {
        t.x = r[0];
        t.y = r[1];
        r.splice(0, 2);
        budget -= d;
      } else {
        t.x += (dx / d) * budget;
        t.y += (dy / d) * budget;
        budget = 0;
      }
    }
    return r.length === 0;
  }

  /**
   * A truck turning off the road into a truck bay goes on past the
   * entrance and backs in, to stand facing out on the side of the bay away
   * from its crates, its bed to them; coming at the bay straight on, it
   * swings its nose round across the entrance and backs in from there.
   */
  startBacking(t: Truck, bay: Bay): void {
    if (
      bay.tiles ||
      (t.exports && !this.iceTruck(t)) ||
      t.path.length !== 1 ||
      t.path[0] !== bay.idx
    ) {
      return;
    }
    const from = t.trail?.[1];
    if (from === undefined || from < 0 || from === bay.idx) return;
    const m = this.map;
    const [fx, fy] = [m.xOf(from) + 0.5, m.yOf(from) + 0.5];
    const before = t.trail?.[0] ?? -1;
    const road =
      before >= 0 ? Math.atan2(fy - m.yOf(before) - 0.5, fx - m.xOf(before) - 0.5) : t.dir;
    t.backing = { x: fx, y: fy, dir: road, k: 0, v: Math.min(t.v ?? 0, 0.2) };
  }

  /** Backs a truck on into its bay; true once it stands there, facing out. */
  backIn(t: Truck, bay: Bay): boolean {
    const b = t.backing!;
    // Slowing from the speed it came at.
    b.v = Math.max(B.TRUCK_BACK_SPEED, b.v * 0.8);
    b.k = Math.min(BACK_TURN, b.k + b.v);
    const cx = this.map.xOf(bay.idx) + 0.5;
    const cy = this.map.yOf(bay.idx) + 0.5;
    const f = b.k / BACK_TURN;
    // Where the game has it, for the trucks round it: on its way in.
    t.x = b.x + (cx - b.x) * f;
    t.y = b.y + (cy - b.y) * f;
    t.v = 0;
    if (f < 1) return false;
    t.dir = Math.atan2(b.y - cy, b.x - cx);
    t.path = [];
    t.backing = undefined;
    return true;
  }

  /**
   * Where a truck backing into its bay shows, and which way it faces: on
   * past the entrance, swinging its nose away from the bay, then backing
   * round into it, as backIn has it so far through.
   */
  backingPose(t: Truck): { x: number; y: number; dir: number } {
    const b = t.backing!;
    const bay = t.bayIdx;
    const m = this.map;
    const lane = B.TRUCK_LANE;
    const rx = Math.cos(b.dir);
    const ry = Math.sin(b.dir);
    const into = Math.atan2(m.yOf(bay) + 0.5 - b.y, m.xOf(bay) + 0.5 - b.x);
    const ix = Math.cos(into);
    const iy = Math.sin(into);
    // Set off from its lane, facing along the road...
    const p0 = { x: b.x - ry * lane, y: b.y + rx * lane };
    // ...on past the entrance, turning its nose away from the bay; or,
    // coming at it straight on, round to the left across the entrance...
    const ahead = Math.cos(b.dir - into) > 0.5;
    const nx = ahead ? ry : rx - ix * 0.7;
    const ny = ahead ? -rx : ry - iy * 0.7;
    const ql = Math.hypot(nx, ny);
    const qx = nx / ql;
    const qy = ny / ql;
    const q = ahead
      ? { x: b.x + ix * 0.3 + qx * 0.4, y: b.y + iy * 0.3 + qy * 0.4 }
      : { x: p0.x + rx * 0.65 - ix * 0.1, y: p0.y + ry * 0.65 - iy * 0.1 };
    // ...and back into the bay, to stand facing out on the right of it.
    const e = { x: b.x + ix + iy * lane, y: b.y + iy - ix * lane };
    const f = b.k / BACK_TURN;
    const bez = (
      a: { x: number; y: number },
      c1: { x: number; y: number },
      c2: { x: number; y: number },
      d: { x: number; y: number },
      u: number,
    ) => {
      const v = 1 - u;
      const at = (k: 'x' | 'y') =>
        v * v * v * a[k] + 3 * v * v * u * c1[k] + 3 * v * u * u * c2[k] + u * u * u * d[k];
      const to = (k: 'x' | 'y') =>
        3 * v * v * (c1[k] - a[k]) + 6 * v * u * (c2[k] - c1[k]) + 3 * u * u * (d[k] - c2[k]);
      return { x: at('x'), y: at('y'), tx: to('x'), ty: to('y') };
    };
    if (f < BACK_PULL) {
      const p = bez(
        p0,
        { x: p0.x + rx * 0.3, y: p0.y + ry * 0.3 },
        { x: q.x - qx * 0.3, y: q.y - qy * 0.3 },
        q,
        f / BACK_PULL,
      );
      return { x: p.x, y: p.y, dir: Math.atan2(p.ty, p.tx) };
    }
    const p = bez(
      q,
      { x: q.x - qx * 0.4, y: q.y - qy * 0.4 },
      { x: e.x - ix * 0.55, y: e.y - iy * 0.55 },
      e,
      (f - BACK_PULL) / (1 - BACK_PULL),
    );
    return { x: p.x, y: p.y, dir: Math.atan2(-p.ty, -p.tx) };
  }

  /** Off to the highway and away: from town, by the town's own road. */
  headOut(t: Truck): void {
    const m = this.map;
    const here = this.tileOf(t);
    const gate = this.town?.gate ?? -1;
    // Off the highway at the nearer end, or the other if that is no way out.
    const exits = hasHighway(m)
      ? [this.departure(here), ...highwayOuts(m).filter((e) => e !== this.departure(here))]
      : gate >= 0 && m.yOf(here) > m.limit
        ? [gate, m.entry]
        : [m.entry];
    for (const exit of exits) {
      const path = this.routeFrom(t, exit, this.truckCostFor(exit, t.bayIdx, t));
      if (!path) continue;
      t.state = 'leaving';
      t.goal = exit;
      t.path = path;
      return;
    }
    this.removeTruck(t);
  }

  /** A parked truck gives up waiting and drives off. */
  leavePark(t: Truck): void {
    this.truckLeave(t);
    t.park = undefined;
  }

  removeTruck(t: Truck): void {
    this.trucks = this.trucks.filter((q) => q !== t);
  }

  // ── Movement ──────────────────────────────────────────────

  /** Advance an agent along its path, repathing if the next tile became blocked. */
  move(
    a: Agent,
    cost: CostFn,
    diagonal: boolean,
    speedAt: (i: number) => number,
    canEnter?: (i: number) => boolean,
    /** Finding a new way when the old one is blocked; a plain path search if not given. */
    repath?: (cost: CostFn) => number[] | null,
  ): 'moving' | 'arrived' | 'blocked' | 'waiting' {
    const w = this.map.w;
    let budget = speedAt(this.tileOf(a));
    let repaths = 0;
    const cuts = 'contractId' in a;
    while (budget > 1e-6 && a.path.length > 0) {
      const next = a.path[0];
      // Hold back at the edge of a tile someone else is standing on.
      if (canEnter && next !== this.tileOf(a) && !canEnter(next)) {
        a.v = 0;
        return 'waiting';
      }
      if (!Number.isFinite(cost(next, this.tileOf(a)))) {
        const p =
          repaths++ < 1
            ? repath
              ? repath(cost)
              : findPath(w, this.map.h, this.tileOf(a), a.goal, cost, diagonal)
            : null;
        if (!p) {
          a.path = [];
          return 'blocked';
        }
        a.path = p;
        continue;
      }
      // A truck steers across the corner through a jog; anything else to
      // the middle of each tile.
      const at = cuts ? this.steerPoints(a, 1)[0] : undefined;
      const tx = at ? at.x : (next % w) + 0.5;
      const ty = at ? at.y : Math.floor(next / w) + 0.5;
      const dx = tx - a.x;
      const dy = ty - a.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) a.dir = Math.atan2(dy, dx);
      if (d <= budget) {
        a.x = tx;
        a.y = ty;
        budget -= d;
        // On the edge it comes into the corner by, it has passed no tile yet.
        if (at && !at.passes) continue;
        const passed = a.path.shift()!;
        if (cuts) a.trail = [a.trail?.[1] ?? -1, passed];
      } else {
        a.x += (dx / d) * budget;
        a.y += (dy / d) * budget;
        budget = 0;
      }
    }
    if (a.path.length === 0) a.v = 0;
    return a.path.length === 0 ? 'arrived' : 'moving';
  }

  /**
   * Where a truck steers for the next `n` tiles of its way: the middle of
   * each, but through a jog, two corners one after the other turning one
   * way and then back as from one lane to the next, across the corners at
   * 45 degrees, from the edge it comes into the first by to the edge it
   * leaves the last by, rather than square round both; a staircase of them
   * all the way in one straight line. Each point says whether reaching it
   * passes a tile of the way: the edge it comes into a jog by passes none.
   */
  steerPoints(a: Agent, n: number): { x: number; y: number; passes: boolean }[] {
    const m = this.map;
    const w = m.w;
    const path = a.path;
    const step = (from: number | undefined, to: number | undefined) => {
      if (from === undefined || to === undefined || from < 0 || to < 0) return 0;
      const d = to - from;
      return d === 1 || d === -1 || d === w || d === -w ? d : 0;
    };
    const mid = (i: number) => ({ x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5 });
    const edge = (p: number, q: number) => {
      const a0 = mid(p);
      const b0 = mid(q);
      return { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
    };
    const before = (k: number, back: number): number | undefined => {
      const j = k - back;
      if (j >= 0) return path[j];
      return a.trail?.[2 + j];
    };
    const out: { x: number; y: number; passes: boolean }[] = [];
    for (let k = 0; k < Math.min(n, path.length); k++) {
      const t = path[k];
      const p = before(k, 1);
      const din = step(p, t);
      const dout = step(t, path[k + 1]);
      const corner = din !== 0 && dout !== 0 && dout !== din && dout !== -din;
      // Turning back the way it went before the last corner, on from a
      // jog's diagonal; or about to, at the next tile.
      const stair = corner && step(before(k, 2), p) === dout;
      const ahead = corner && step(path[k + 1], path[k + 2]) === din;
      if (stair || ahead) {
        if (!stair) {
          // Onto the diagonal at the edge it comes in by, unless past it.
          const e = edge(p!, t);
          const ux = din === 1 ? 1 : din === -1 ? -1 : 0;
          const uy = din === w ? 1 : din === -w ? -1 : 0;
          const past = k === 0 && (a.x - e.x) * ux + (a.y - e.y) * uy > -1e-6;
          if (!past) out.push({ ...e, passes: false });
        }
        out.push({ ...edge(t, path[k + 1]), passes: true });
      } else out.push({ ...mid(t), passes: true });
    }
    return out;
  }

  /**
   * How far a truck or port machine goes this tick, at most `top`: it gets
   * up to speed gradually, eases off in good time for a corner (the sharper
   * the slower), brakes to a stop at the end of its way rather than pulling
   * up dead, and keeps to what lets it stop within `room`, short of whatever
   * is ahead of it. With `stop` false it runs on off the end (off the map).
   */
  drive(a: Agent, top: number, room = Infinity, stop = true): number {
    const w = this.map.w;
    const accel = top / B.VEHICLE_ACCEL_TICKS;
    const brake = top / B.VEHICLE_BRAKE_TICKS;
    // How fast it may go with `d` to go to where it must be down to `v`.
    const by = (v: number, d: number) => Math.sqrt(v * v + 2 * brake * Math.max(0, d));
    const sight = (top * top) / (2 * brake) + top;
    let want = Math.min(top, by(0, room));
    let x = a.x;
    let y = a.y;
    let heading = a.dir;
    let run = 0;
    // Where it steers, as move does: across the corner through a jog.
    const points =
      'contractId' in a
        ? this.steerPoints(a, Math.min(a.path.length, Math.ceil(sight) + 2))
        : a.path.map((i) => ({ x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5, passes: true }));
    let k = 0;
    for (; k < points.length && run <= sight; k++) {
      const nx = points[k].x;
      const ny = points[k].y;
      const len = Math.hypot(nx - x, ny - y);
      const dir = len > 1e-6 ? Math.atan2(ny - y, nx - x) : heading;
      // A bend where this stretch meets the last. Into a jog's diagonal and
      // out of it, half a corner either way, it need not slow.
      if (k > 0 && len > 1e-6) {
        const bend = Math.abs(wrapAngle(dir - heading));
        const corner = top * Math.max(B.CORNER_SPEED, Math.cos(Math.min(bend, Math.PI / 2)));
        if (bend > Math.PI / 4 + 0.01) want = Math.min(want, by(corner, run));
      }
      run += len;
      x = nx;
      y = ny;
      heading = dir;
    }
    // Stopping at the end of the way, creeping the last bit.
    if (stop && k === points.length && points.length >= a.path.length) {
      want = Math.min(want, Math.max(by(0, run), top * 0.15));
    }
    const v = a.v ?? 0;
    a.v = want < v ? want : Math.min(want, v + accel);
    return a.v;
  }

  tileOf(a: Agent): number {
    return this.map.idx(Math.floor(a.x), Math.floor(a.y));
  }

  dist(a: number, b: number): number {
    const m = this.map;
    return Math.abs(m.xOf(a) - m.xOf(b)) + Math.abs(m.yOf(a) - m.yOf(b));
  }

  /** Whether a gantry crane works this berth. */
  gantryReaches(berth: number): boolean {
    for (const c of this.cranes.values()) {
      if (c.kind === 'gantry' && craneFront(this, c).some((t) => near(this, t, berth))) return true;
    }
    return false;
  }

  /** People living in the town, which the port's tier waits on. */
  townSize(): number {
    return this.town ? population(this.town, this.map) : 0;
  }

  // ── Output ────────────────────────────────────────────────

  /** What the view sees of the game this frame; see systems/snapshot.ts. */
  snapshot(): Snapshot {
    return buildSnapshot(this);
  }

  /** What happened since the last frame, for the view; see systems/output.ts. */
  drainEvents(): SimEvent[] {
    return eventsOut(this);
  }

  drainTileChanges(): TileChange[] {
    return tilesOut(this);
  }

  drainPlotChanges(): { plots: number[]; bought: number } | undefined {
    return plotsOut(this);
  }

  // ── Explanations ──────────────────────────────────────────
  //
  // Why something is held up, in words, for the info panels: the same
  // checks the sim makes, said out loud.
}
