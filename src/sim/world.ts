import type {
  Agent,
  Bay,
  Boat,
  Cells,
  Crane,
  Crate,
  Dockhand,
  JibJob,
  SaveData,
  Truck,
  Tug,
} from './state';
import { fromOld, type OldCrates } from './systems/cargo/places';
import type {
  Capacity,
  CargoSample,
  Command,
  FinanceDay,
  Ledger,
  SimEvent,
  Stats,
} from '../protocol';
import * as B from './balance';
import {
  makeOffer,
  paysPerContainer,
  STARTER_FISHERY,
  STARTER_HAULIER,
  type Contract,
  type Offer,
} from './contracts';
import { ownBuilt } from './land';
import { GameMap } from './map';
import { DEFAULT_PILOT, type PilotId } from './systems/boats/pilots';
import { extendMap, generateMap, kerbOf, turnAbout } from './mapgen';
import { randomName, townName } from './names';
import { crossingClosed, layRailway, newRail, stepRail, type RailState } from './railway';
import {
  clearTown,
  foundTown,
  TOWN_LAYOUT,
  growTown,
  population,
  townHomes,
  townStageUp,
  townWants,
  landmarksByPopulation,
  LANDMARKS,
  type Town,
} from './town';
import { type Candidate } from './staff';
import { findPath, type CostFn } from './path';
import { Rng } from './rng';
import { anchorOf, ON_QUAY, drivable, type ParkingLot, walkableAt } from './rules';
import { MACHINES } from './machines';
import { Build, isBay, Store, storesBoxes, TICKS_PER_DAY, type MachineKind } from './types';
import { CARGO_EVERY, CARGO_SAMPLES, emptyLedger, isMachine } from './helpers';
import type { Crossing, Vehicle } from './helpers';
import { message, tip } from './systems/output';
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
  cancelContract,
  fire,
  hire,
  newDay,
  refreshCandidates,
  sailNow,
  signContract,
  smallTrucks,
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
import { buildTown } from './systems/townBusiness';
import { buyTug, updateTugs } from './systems/tugs';
import { craneCells, putOnCrane, updateCrane } from './systems/cranes';
import { boatCostFor, near, spawnBoat, spawnBoats, updateBoat } from './systems/boats/berthing';
import { docks } from './systems/boats/berthing';
import { craneFront } from './systems/boats/berthing';
import { liftDone, settleGantry } from './systems/yardGantry';
import { countOccupancy } from './systems/workforce/crowding';
import {
  buyMachine,
  craneStackTiles,
  depotRoom,
  spawnDockhand,
  throughDoor,
  updateDockhand,
} from './systems/workforce/dockhands';
import { spawnShipments } from './systems/cargo/exports';
import { putBox, shutStore, yardCells } from './systems/cargo/stores';
import { addBay, addKerb, crossesRails, faceRoads, lots, parkUp } from './systems/roads/bays';
import { nameBays } from './designations';
import { noteTiles } from './systems/roads/traffic';
import { spawnTrucks, steerPoints, updateTruck } from './systems/roads/trucks';
import {
  loadingDocks as loadingDocksOf,
  freeDockSet as freeDockSetOf,
  routeFrom as routeFromOf,
} from './systems/roads/bays';
import { drivePath as drivePathOf, headOut as headOutOf } from './systems/roads/traffic';
import { yardGantry as yardGantryOf, gantryTruck as gantryTruckOf } from './systems/yardGantry';
import { exportsFor as exportsForOf } from './systems/cargo/exports';
import {
  gantryLane as gantryLaneOf,
  storeSpots as storeSpotsOf,
  freeParking as freeParkingOf,
  laneWays as laneWaysOf,
} from './systems/roads/bays';
import { spotTaken as spotTakenOf, pathFor as pathForOf } from './systems/workforce/crowding';
import {
  exportStore as exportStoreOf,
  outgoingRoom as outgoingRoomOf,
} from './systems/cargo/exports';
import { distTo as distToOf, collectable as collectableOf } from './systems/cargo/stores';
import { handlerFree as handlerFreeOf } from './systems/yardGantry';
import type { ParkingSpace } from './rules/parking';
import { truckLeave as truckLeaveOf } from './systems/roads/traffic';
import { shipOut as shipOutOf } from './systems/cargo/exports';

export const SAVE_VERSION = 11;
export const SPEEDS = [0, 1, 2, 4, 8];

export type { SaveData, Tug } from './state';

/** How an older save kept what a worker carries: fees, with how each looks and so on beside them. */
interface OldLoad {
  cargoFees?: number[];
  cargoLooks?: number[];
  cargoFrom?: number[];
  cargoReady?: number[];
  handed?: Crate[] | { fees: number[]; looks: number[]; from: number[] };
}

/** What a worker carries as saved, copied for the game to keep, or from an older save's lists. */
function loadCarried(d: Omit<Dockhand, 'handed'> & OldLoad): Dockhand {
  const { cargoFees, cargoLooks, cargoFrom, cargoReady, handed, ...p } = d;
  p.load = p.load
    ? p.load.map((c) => ({ ...c }))
    : (cargoFees ?? []).map((fee, k) => ({
        fee,
        at: 0,
        look: cargoLooks?.[k],
        from: cargoFrom?.[k],
        ready: cargoReady?.[k],
      }));
  const was = handed;
  const out: Dockhand = p;
  if (Array.isArray(was)) out.handed = was.map((c) => ({ ...c }));
  else if (was) {
    out.handed = was.fees.map((fee, k) => ({ fee, at: 0, look: was.looks[k], from: was.from[k] }));
  }
  return out;
}

/** How an older save kept a container yard's containers: fees in lists, and their slots, looks and customs beside them. */
interface OldYard {
  boxes?: number[];
  boxReady?: number[];
  boxSlots?: number[];
  boxLooks?: number[];
  outBoxes?: number[];
  exports?: number[];
  exportSlots?: number[];
  exportLooks?: number[];
  crates?: number[];
}

/** What a gantry holds as saved; an older save's as fees with how each looks and the ship it came off beside them. */
function oldHeld(h: {
  load?: Crate[];
  fees?: number[];
  looks?: number[];
  from?: number[];
}): Crate[] {
  if (h.load) return h.load.map((c) => ({ ...c }));
  return (h.fees ?? []).map((fee, k) => ({ fee, at: 0, look: h.looks?.[k], from: h.from?.[k] }));
}

/**
 * A container yard as saved, copied for the game to keep, or from an
 * older save's lists into its cells: each container in the slot it had,
 * the rest where they would go now; those with no customs time clear.
 */
function loadYard(w: World, d: Bay & OldYard): Bay {
  const {
    boxes,
    boxReady,
    boxSlots,
    boxLooks,
    outBoxes,
    exports,
    exportSlots,
    exportLooks,
    crates,
    ...y
  } = d;
  void crates;
  y.yard = true;
  y.gantryHeld = y.gantryHeld && { ...y.gantryHeld, load: oldHeld(y.gantryHeld) };
  if (Array.isArray(y.cells) && !boxes) {
    y.cells = y.cells.map((c) => c && { ...c });
    return y;
  }
  y.cells = [];
  const cells = yardCells(y);
  const later: [Crate, boolean][] = [];
  for (const [fees, slots, looks, out] of [
    [boxes ?? [], boxSlots, boxLooks, false],
    [outBoxes ?? exports ?? [], exportSlots, exportLooks, true],
  ] as const) {
    // Older saves have no customs times: all clear.
    const ready = out ? [] : (boxReady ?? []);
    const pad = fees.length - ready.length;
    fees.forEach((fee, i) => {
      const c: Crate = { fee, at: i - fees.length, look: looks?.[i] };
      if (out) c.out = true;
      else c.ready = i < pad ? 0 : ready[i - pad];
      const s = slots?.[i] ?? -1;
      if (s >= 0 && s < cells.length && !cells[s]) cells[s] = c;
      else later.push([c, out]);
    });
  }
  for (const [c, out] of later) putBox(w, y, c, out);
  return y;
}

/** How an older save kept what is on a crane's stack: fees in lists, and their places, looks and ships beside them. */
interface OldCrane {
  stack?: number[];
  stackFrom?: number[];
  stackLooks?: number[];
  outStack?: number[];
  outLooks?: number[];
  places?: number[];
  outPlaces?: number[];
}

/**
 * A crane as saved, copied for the game to keep, or from an older save's
 * lists into its cells: each in the place it had, the rest where they
 * would go now.
 */
function loadCrane(w: World, d: Crane & OldCrane): Crane {
  const { stack, stackFrom, stackLooks, outStack, outLooks, places, outPlaces, ...c } = d;
  const held = c.serving?.held;
  if (c.serving && held) c.serving = { ...c.serving, held: { ...held, load: oldHeld(held) } };
  if (Array.isArray(c.cells)) {
    c.cells = c.cells.map((q) => q && { ...q });
    return c;
  }
  c.cells = [];
  const cells = craneCells(c);
  const later: [Crate, boolean][] = [];
  for (const [fees, at, looks, from, out] of [
    [stack ?? [], places, stackLooks, stackFrom, false],
    [outStack ?? [], outPlaces, outLooks, undefined, true],
  ] as const) {
    fees.forEach((fee, i) => {
      const q: Crate = { fee, at: i - fees.length, look: looks?.[i], from: from?.[i] };
      if (out) q.out = true;
      const k = c.kind === 'jib' ? -1 : (at?.[i] ?? -1);
      if (k >= 0 && k < cells.length && !cells[k]) cells[k] = q;
      else later.push([q, out]);
    });
  }
  for (const [q, out] of later) putOnCrane(w, c, q, out);
  return c;
}

/**
 * A boat as saved, its exports on board copied for the game to keep; or
 * an older save's, kept as a count with their fees, looks and deck slots
 * beside it, each into its slot.
 */
function loadBoat(
  d: Boat & { out?: number; outFees?: number[]; outLooks?: number[]; outSlots?: number[] },
): Boat {
  const { out, outFees, outLooks, outSlots, ...b } = d;
  if (b.loaded) b.loaded = b.loaded.map((c) => c && { ...c });
  else if (out) {
    const cells: Cells = [];
    for (let i = 0; i < out; i++) {
      let k = outSlots?.[i] ?? -1;
      if (k < 0 || cells[k]) k = cells.findIndex((c) => !c);
      if (k < 0) k = cells.length;
      while (cells.length <= k) cells.push(null);
      cells[k] = { fee: outFees?.[i] ?? 0, at: i - out, out: true, look: outLooks?.[i] };
    }
    b.loaded = cells;
  }
  return b;
}

/**
 * A crate truck's bed as saved, copied for the game to keep; or an older
 * save's crates on it, kept as fees with their places on its bed beside
 * them, each into its place, any without one into the next free.
 */
function loadBed(t: Truck & { fees?: number[]; bed?: number[]; looks?: number[] }): Truck {
  const { fees, bed, looks, ...truck } = t;
  if (truck.load) truck.load = truck.load.map((c) => c && { ...c });
  else if (truck.boxes && looks) {
    // A haulier's containers, each its share of what they pay.
    const fee = truck.cargo > 0 ? truck.value / truck.cargo : 0;
    truck.load = looks
      .slice(0, truck.cargo)
      .map((look, k) => ({ fee, at: k - looks.length, look }));
  } else if (fees) {
    const cells: Cells = [];
    fees.forEach((fee, i) => {
      let s = bed?.[i] ?? -1;
      if (s < 0 || cells[s]) s = cells.findIndex((c) => !c);
      if (s < 0) s = Math.max(cells.length, i);
      while (cells.length <= s) cells.push(null);
      cells[s] = { fee, at: i - fees.length };
    });
    truck.load = cells;
  }
  return truck;
}

/**
 * A bay's crates as saved, copied for the game to keep, or from an older
 * save's lists into its cells (see fromOld).
 */
function loadCrates(w: World, b: Bay & OldCrates): Bay {
  const { crates, exports, crateSlots, outSlots, customs, papers, places, ...bay } = b as Bay &
    OldCrates & { places?: number[] };
  void places;
  if (Array.isArray(bay.cells)) {
    bay.cells = bay.cells.map((c) => c && { ...c });
    return bay;
  }
  fromOld(w, bay, { crates, exports, crateSlots, outSlots, customs, papers });
  return bay;
}

/**
 * The game: everything in the port and the town (see state.ts), made new or
 * from a save, stepped a tick at a time and told what the player does. The
 * rules that move it are functions over it in systems/, one file a subject
 * (boats, cranes, trucks, workers, cargo, money, the town); what the view
 * sees of it is built in systems/snapshot.ts. Its members are open to them.
 */
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
  /** How kind the game is, picked for a new port; see DIFFICULTIES. */
  difficulty: B.Difficulty = 'hard';
  /** Navigation policy; the debug menu can override it. Not saved. */
  pilot: PilotId = DEFAULT_PILOT;
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
  /** Where crates stand on the ground, this tick; see crateTiles. */
  crateTileCache: { tick: number; at: Set<number> } | null = null;
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
  /**
   * Parking lots, by their first tile, no truck could drive into the way
   * their arrows show, till when they are tried again; see noWayIn. Not saved.
   */
  noWayIn = new Map<number, number>();
  /** Each parking tile's lot's designation, for the lots to keep theirs when redrawn; see nameLots. */
  lotNames = new Map<number, string>();
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
  /**
   * How far, in tiles, the dockhands lately walked each crate off a boat
   * to where they set it down, as a running average; see longCarry. Not saved.
   */
  carryWalk = 0;
  /** Cached planning estimate; cleared when the port changes. Not saved. */
  capacityCache: Capacity | null = null;
  /** Dock groups and the coordinated tiles; cleared when the map changes. Not saved. */
  dockCache: ReturnType<typeof docks> | null = null;
  /** Tiles dockhands can walk to a truck bay or crate storage from; see landingReach. Not saved. */
  landingCache: Uint8Array | null = null;
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
  /** What routes pay to pass close to a jetty, quay or the shore; see cornerRing. */
  ringCache: Float32Array | null = null;
  /** Wider corner/shore clearances for longer hulls, by extra turning room. */
  wideRingCache = new Map<number, Float32Array>();
  coordinated = new Set<number>();
  /** Dock tile → its dock's key (the dock's lowest tile), with docks(). */
  dockKey = new Map<number, number>();
  /** Advisor tips already given, so each comes once a game. */
  tipsSeen = new Set<string>();
  learning: import('./state').LearningProgress = {
    tips: [],
    readTips: [],
    marks: [],
    guideSteps: {},
  };
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
   * New games start with a truck bay at the road's end, as they used to,
   * rather than the heap the pickups load from: for tests built round it.
   */
  static startBay = false;

  /**
   * A new game; `size`, the port's land, for a map as big as they were
   * before; `ownAll` owns every plot of it from the start.
   */
  static create(seed: number, size?: number, ownAll = World.ownAllLand): World {
    const { map, spawn } = generateMap(seed, size);
    const kerb = kerbOf(map, spawn);
    if (!World.startBay) turnAbout(map, kerb);
    if (ownAll) map.plots.fill(1);
    const world = new World(seed, map, new Rng(seed));
    world.settle();
    if (World.startBay) {
      map.build[kerb] = Build.TruckBay;
      map.orient[kerb] = 2; // entrance towards the road, -x
    }
    for (let i = 0; i < map.build.length; i++) {
      if (isBay(map.build[i]) && anchorOf(map, i) === i) addBay(world, i);
    }
    // No truck bay yet: the crates are heaped at the road's end for the pickups.
    if (!World.startBay) addKerb(world, kerb);
    for (let k = 0; k < B.START_DOCKHANDS; k++) {
      spawnDockhand(world, spawn, {
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
          (Array.isArray(p.load) || Array.isArray((p as OldLoad).cargoFees)) &&
          Number.isFinite(p.energy) &&
          Number.isFinite(p.wage) &&
          Number.isFinite(p.raiseAsk),
      ) &&
      d.bays.every((b) => Array.isArray(b.cells) || Array.isArray((b as OldCrates).crates)) &&
      d.contracts.every((c) => Number.isFinite(c.signingFee))
    );
  }

  static fromSave(s: SaveData): World {
    // Saves from before the country past the port's land get it added on.
    const map = extendMap(GameMap.fromData(s.map), s.seed);
    const world = new World(s.seed, map, new Rng(s.rng));
    world.tick = s.tick;
    world.difficulty = s.difficulty ?? 'hard';
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
    for (const c of s.cranes)
      world.cranes.set(c.idx, loadCrane(world, { ...c, kind: c.kind ?? 'jib' }));
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
    world.people = s.people.map((p) =>
      loadCarried({
        ...p,
        stockIdx: p.stockIdx ?? -1,
        toBoat: p.toBoat ?? -1,
        toCrane: p.toCrane ?? -1,
        path: [...p.path],
      }),
    );
    world.boats = s.boats.map((b) => loadBoat({ ...b, path: [...b.path] }));
    world.tugs = (s.tugs ?? []).map((t) => ({ ...t, path: [...t.path] }));
    world.trucks = s.trucks.map((t) => loadBed({ ...t, path: [...t.path] }));
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
    // Saves from before land was bought own every plot they built on, free;
    // saved in plots of another size, those too as well as what they owned.
    if (!s.map.plots) ownBuilt(m, generateMap(s.seed, m.w).map);
    else if ((s.map.plotSize ?? 16) !== B.PLOT_SIZE) {
      const kept = Uint8Array.from(m.plots);
      const bought = m.plotsBought;
      ownBuilt(m, generateMap(s.seed, m.w).map);
      for (let p = 0; p < kept.length; p++) if (kept[p]) m.plots[p] = 1;
      m.plotsBought = bought;
    }
    for (const bay of s.bays) {
      world.bays.set(
        bay.idx,
        loadCrates(world, {
          ...bay,
          boxes: bay.boxes?.length ? [...bay.boxes] : undefined,
          boxIncoming: bay.boxIncoming ?? 0,
          large: bay.large ?? false,
          tiles: bay.tiles ? [...bay.tiles] : bay.warehouse ? [bay.idx] : undefined,
        }),
      );
    }
    // Older saves' truck bays get their designations, lowest tile first.
    nameBays(world.bays.values());
    for (const [i, name] of s.lotNames ?? []) world.lotNames.set(i, name);
    for (const pile of s.piles ?? []) world.piles.set(pile.idx, loadCrates(world, { ...pile }));
    for (const y of s.yards ?? []) {
      world.yards.set(y.idx, loadYard(world, { ...y, tiles: y.tiles ? [...y.tiles] : [y.idx] }));
    }
    if (s.scenery !== undefined) world.scenery.state = s.scenery;
    world.tipsSeen = new Set(s.tips ?? []);
    world.learning = structuredClone(
      s.learning ?? { tips: s.tips ?? [], readTips: s.tips ?? [], marks: [], guideSteps: {} },
    );
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
    for (const t of world.trucks) if (t.state === 'parked' && t.lot) parkUp(world, t);
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
      if (p.home < 0 || depotRoom(this, p.home) >= 0) continue;
      const room = MACHINES[p.kind as MachineKind].room;
      for (let i = 0; i < this.map.build.length; i++) {
        if (this.map.build[i] === Build.Depot && depotRoom(this, i) >= room) {
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
      difficulty: this.difficulty,
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
      learning: this.learning,
      departed: this.departed,
      unloaded: [...this.unloadedAt],
      lotNames: lots(this).map((l) => [l.tiles[0], l.name!] as [number, string]),
    });
  }

  // ── Commands ──────────────────────────────────────────────

  /** What was worked out from the map, to work out again once it has changed. */
  forget(): void {
    this.capacityCache = null;
    this.dockCache = null;
    this.landingCache = null;
    this.gateCache = null;
    this.buoyCache = null;
    this.anchorageTile = -1;
    this.frontCache = null;
    this.ringCache = null;
    this.wideRingCache.clear();
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
    this.crateTileCache = null;
    this.lineUpCache = null;
  }

  command(cmd: Command): void {
    if (this.bankrupt) return;
    this.forget();
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
        return shutStore(this, cmd.idx, cmd.shut);
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
        return buyMachine(this, cmd.kind, cmd.tile);
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
      case 'readTip':
        if (this.tipsSeen.has(cmd.id) && !this.learning.readTips.includes(cmd.id))
          this.learning.readTips.push(cmd.id);
        return;
      case 'inspect': {
        const mark = cmd.kind === 'boat' ? 'inspectBoat' : 'inspectWorker';
        if (!this.learning.marks.includes(mark)) this.learning.marks.push(mark);
        return;
      }
      case 'help':
        if (cmd.id.length < 40 && Number.isInteger(cmd.step) && cmd.step >= 0 && cmd.step < 50) {
          this.learning.guideSteps[cmd.id] = cmd.step;
          if (cmd.action === 'complete' && !this.learning.marks.includes(`guide:${cmd.id}`))
            this.learning.marks.push(`guide:${cmd.id}`);
        }
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

  /** Testing shortcuts. The worker only forwards these on the dev server, but for the million (Shift+M). */
  debug(cmd: Extract<Command, { type: 'debug' }>): void {
    if (cmd.cash) {
      this.cash += cmd.cash;
      message(this, `Debug: +$${cmd.cash.toLocaleString('en-US')}`, 'good');
    }
    if (cmd.tier !== undefined) {
      this.tier = cmd.tier;
      smallTrucks(this);
    }
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
    if (cmd.pilot) this.pilot = cmd.pilot;
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

  // ── Tick ──────────────────────────────────────────────────

  /** One tick of the game: each system takes its turn; see systems/. */
  step(): void {
    if (this.bankrupt) return;
    if (!Number.isFinite(this.cash)) {
      // Never let a bad value spread through the economy; fail loudly instead.
      throw new Error(`Cash became ${this.cash} at tick ${this.tick}`);
    }
    this.tick++;
    noteTiles(this);
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
    countOccupancy(this);
    for (const p of this.people) updateDockhand(this, p);
    if (this.tick % 10 === 9) faceRoads(this);
    if (this.tick % 10 === 0) spawnTrucks(this);
    if (this.tick % 10 === 5) spawnShipments(this);
    for (const t of [...this.trucks]) updateTruck(this, t);
    for (const y of this.yards.values())
      if (y.gantryHeld && liftDone(this, y)) settleGantry(this, y);
    stepRail(this.rail, this.scenery, this.tick, this.map.h, this.town?.stage ?? 0);
    if (this.town && this.tick % B.TOWN_BUILD_TICKS === 0) buildTown(this, this.town);
  }

  // ── Ways through the port ─────────────────────────────────
  //
  // What each kind of agent may cross, as the path searches cost it, and
  // the odds and ends the systems keep between ticks.

  boatCosts = new Map<number, CostFn>();

  boatCost: CostFn = (i) => boatCostFor(this, B.BOAT_DRAFT)(i);

  /** Dockhands stay on the port: paths, jetties, quays and port buildings. */
  walkCost: CostFn = (i, from) =>
    walkableAt(this.map, i) && throughDoor(this, i, from) ? 1 : Infinity;

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
    if (from !== undefined && from >= 0 && crossesRails(this, from, i)) return Infinity;
    if (!throughDoor(this, i, from)) return Infinity;
    return this.groundCost(i) + (craneStackTiles(this).has(i) ? B.CRANE_STACK_DETOUR : 0);
  };

  walkSpeed = () => B.WALK_SPEED;

  /** Whether the last dockFor found a way to any free spot, through a truck or not. */
  dockRouted = false;
  /** Whether it found one it could get to but not turn round from to leave. */
  dockTurn = false;

  /** Trucks stop at a level crossing while the barriers are down. */
  level = (i: number): boolean =>
    this.map.build[i] !== Build.Crossing ||
    // As the barriers will be by the end of this tick: the train moves after the trucks.
    !crossingClosed(this.rail.train, this.map.yOf(i), 1);

  /** Each vehicle's tile, and the one it came onto it from, by id; see noteTiles. Not saved. */
  cameFrom = new Map<number, { tile: number; from: number }>();

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
      const at = cuts ? steerPoints(this, a, 1)[0] : undefined;
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

  tileOf(a: Agent): number {
    return this.map.idx(Math.floor(a.x), Math.floor(a.y));
  }

  dist(a: number, b: number): number {
    const m = this.map;
    return Math.abs(m.xOf(a) - m.xOf(b)) + Math.abs(m.yOf(a) - m.yOf(b));
  }

  // ── Queries the systems answer ────────────────────────────
  //
  // Readings of the port the systems make through the world rather than
  // call directly, so a test can stand in for one (`world.pathFor = () =>
  // ...`) and try a system on a port it has only sketched. Each is answered
  // by the system named in its import.

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

  loadingDocks(bay: Bay, pickup = false): number[] {
    return loadingDocksOf(this, bay, pickup);
  }

  freeDockSet(bay: Bay, len = 1, pickup = false): Set<number> {
    return freeDockSetOf(this, bay, len, pickup);
  }

  drivePath(from: number, cameFrom: number, goal: number, cost: CostFn): number[] | null {
    return drivePathOf(this, from, cameFrom, goal, cost);
  }

  routeFrom(t: Truck, goal: number, cost: CostFn): number[] | null {
    return routeFromOf(this, t, goal, cost);
  }

  yardGantry(yard: Bay): boolean {
    return yardGantryOf(this, yard);
  }

  gantryTruck(y: Bay): Truck | undefined {
    return gantryTruckOf(this, y);
  }

  headOut(t: Truck): void {
    return headOutOf(this, t);
  }

  exportsFor(b: Boat): number {
    return exportsForOf(this, b);
  }

  gantryLane(a: Bay): Map<number, number> | null {
    return gantryLaneOf(this, a);
  }

  storeSpots(a: Bay): number[] {
    return storeSpotsOf(this, a);
  }

  spotTaken(i: number, p: Dockhand): boolean {
    return spotTakenOf(this, i, p);
  }

  pathFor(p: Dockhand, from: number, goal: number): number[] | null {
    return pathForOf(this, p, from, goal);
  }

  freeParking(bay: Bay | null, outside = false, wide = false): ParkingSpace | null {
    return freeParkingOf(this, bay, outside, wide);
  }

  outgoingRoom(t: Truck): boolean {
    return outgoingRoomOf(this, t);
  }

  distTo(from: number, b: Bay): number {
    return distToOf(this, from, b);
  }

  laneWays(): Map<number, [number, number]> {
    return laneWaysOf(this);
  }

  collectable(b: Bay): number {
    return collectableOf(this, b);
  }

  handlerFree(bay: Bay, except?: Truck): boolean {
    return handlerFreeOf(this, bay, except);
  }

  exportStore(t: Truck): { store: Bay; dock: number; path: number[] } | null {
    return exportStoreOf(this, t);
  }

  truckLeave(t: Truck): void {
    return truckLeaveOf(this, t);
  }

  shipOut(b: Boat, load: (Crate | number)[], slot?: number): void {
    return shipOutOf(this, b, load, slot);
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
}
