import { cargoOf, withCargo, type Cargo } from './cargo';
import type {
  BayView,
  Capacity,
  CargoSample,
  CargoStats,
  Command,
  ContractView,
  CraneView,
  ProblemView,
  BoatVisit,
  EntityView,
  FinanceDay,
  HandAt,
  Ledger,
  LedgerCategory,
  SimEvent,
  Snapshot,
  StaffView,
  Stats,
  TileChange,
  TownView,
} from '../protocol';
import * as B from './balance';
import {
  fisheryDailyCrates,
  makeOffer,
  paysPerContainer,
  STARTER_FISHERY,
  STARTER_HAULIER,
  type Contract,
  type FisheryTerms,
  type HaulierTerms,
  type Offer,
  type ShipperTerms,
  type Terms,
} from './contracts';
import { GameMap, type MapData } from './map';
import { extendMap, generateMap } from './mapgen';
import { randomName, townName } from './names';
import { crossingClosed, layRailway, newRail, stepRail, type RailState } from './railway';
import {
  laneLine,
  waysMeet,
  wayFrom,
  exitError,
  exitRows,
  GATE_IN,
  GATE_OUT,
  greenAt,
  hasHighway,
  hasLights,
  HIGHWAY_COLUMNS,
  highwayIns,
  highwayOuts,
  isExit,
  isHighway,
  layHighway,
  LIGHTS,
  linked,
  nearestEnd,
  ONE_WAY,
  oneWay,
  setExit,
  stepFacing,
} from './roads';
import {
  BUSINESSES,
  clearTown,
  foundTown,
  HIGHWAY_X,
  TOWN_LAYOUT,
  growTown,
  population,
  townDay,
  townHomes,
  townStageUp,
  townTarget,
  townWants,
  type Town,
} from './town';
import { makeCandidate, paceFactor, thought, traitDef, type Candidate, type Trait } from './staff';
import { findDrivePath, findPath, type CostFn } from './path';
import { Rng } from './rng';
import {
  anchorOf,
  bestFacing,
  buoyGates,
  frontOf,
  BUILDABLES,
  bulldozeError,
  bulldozeTiles,
  bulldozeValue,
  footprint,
  gantryGround,
  gantryRails,
  gantryOver,
  harbourCentre,
  partOrient,
  FORKLIFT_ONLY,
  ON_QUAY,
  forkliftOnly,
  forkliftOnlyError,
  drivable,
  reflood,
  terraform,
  terraformCost,
  terraformError,
  machinePlacementError,
  nearCrane,
  needsWideSpace,
  parkingLots,
  type ParkingLot,
  type ParkingSpace,
  placementCost,
  placementError,
  ROTATABLE,
  storeError,
  unmarkable,
  unmarkRefund,
  STORE_COST,
  STORE_LABEL,
  STORE_TIER,
  loadingSpots,
  truckCost,
  laneRuns,
  truckReach,
  walkableAt,
  gateWay,
  junctionAt,
  lightsError,
  oneWayError,
  ROUNDABOUT_RING,
  roundaboutCost,
  roundaboutError,
  liftMarks,
  ON_PORT_ROAD,
  roadUnderParking,
  PARK_FLIP,
  PARK_MIRROR,
  nextParkWay,
  gantryYard,
} from './rules';
import { MACHINES } from './machines';
import { BUILD_TIER, MACHINE_TIER, TIERS } from './tiers';
import {
  Build,
  Deco,
  isBay,
  isTownBuilding,
  isBuoy,
  isCrane,
  isDock,
  isPublicRoad,
  Store,
  STORE_CODE,
  storesBoxes,
  storesOutgoing,
  Terrain,
  TICKS_PER_DAY,
  type BuildKind,
  type MachineKind,
  type StoreKind,
} from './types';

export const SAVE_VERSION = 11;
export const SPEEDS = [0, 1, 2, 4, 8];
/** The advisor's first steps, one each time a boat leaves; see departTips. */
const FIRST_STEPS = ['speed', 'jetty', 'contract', 'screens'];

interface Agent {
  id: number;
  x: number;
  y: number;
  dir: number;
  /** Tiles still to walk through, next first. */
  path: number[];
  goal: number;
  /** Trucks and port machines: how fast it is going, in tiles a tick; see drive. */
  v?: number;
  /** Trucks: the last two tiles of its way it has passed, the older first; see steerPoints. */
  trail?: [number, number];
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
  /**
   * Cargo set down being collected from: a heap landed on the quay, or a
   * storage area trucks cannot get to; or -1.
   */
  stockIdx: number;
  /** Where the load goes: a truck bay, or for containers a yard. */
  bayIdx: number;
  /** Stackers: the ship each container carried came off, by id. */
  cargoFrom?: number[];
  /** Stackers: how each container carried looks; see boxLookOf. */
  cargoLooks?: number[];
  /**
   * The place on a crane's stack of the container it is taking, or in crate
   * storage of the pallet a forklift is taking, chosen as it pulls up.
   */
  takeAt?: number;
  /** A tractor under a gantry crane: what the crane set straight on it off the ship. */
  handed?: { fees: number[]; looks: number[]; from: number[] };
  /** Exports: the ship they are going on board, or the crane they go to; else -1. */
  toBoat?: number;
  toCrane?: number;
  /** The load is exports, going out. */
  outbound?: boolean;
  /**
   * Stackers: the truck at a container yard it is loading (`truckLoad`) or
   * unloading, where no yard gantry does it.
   */
  truckId?: number;
  truckLoad?: boolean;
  /** Stackers: the yard, and which of its tiles, it is restacking at; see restackJob. */
  restack?: { yard: number; tile: number };
  /** Stackers: when customs clear each container carried, where that is known already (restacking). */
  cargoReady?: number[];
  /** Reach stackers and tractors: what it is keeping its distance behind, if anything; see roomAhead. */
  blocker?: number;
  /** The tile of crane stack on its way it last looked for a way round; see walk. */
  replanned?: number;
  /** The tile it last drove in from, which it may not turn back to where it cannot turn about. */
  came?: number;
  /** The ring it is driving on through, and where it set off from; see passRing. */
  passing?: { ids: number[]; x: number; y: number };
}

interface Crane {
  idx: number;
  /**
   * Jib cranes lift crates; harbour and gantry cranes lift containers off
   * feeders. A gantry's stack is the bay between its legs.
   */
  kind: 'jib' | 'harbour' | 'gantry';
  /** Fees of the crates on the landing stack. */
  stack: number[];
  /** The stack holds a coaster's pallets, which only forklifts can move. */
  pallets?: boolean;
  reserved: number;
  /** Container cranes: the ship each container on the stack came off, by id. */
  stackFrom?: number[];
  /** Container cranes: exports set down for it to lift on board, and those on the way. */
  outStack?: number[];
  /** Container cranes: how each container on the stack, and each export, looks. */
  stackLooks?: number[];
  outLooks?: number[];
  outReserved?: number;
  timer: number;
  angle: number;
  busy: boolean;
  /**
   * Container cranes: the ship and the slot on its deck it is lifting a
   * container from, or setting an export into; see deckSlot.
   */
  liftBoat?: number;
  liftSlot?: number;
  /**
   * The tractor waiting under it as it began a lift off the ship, or called
   * to it and pulling in by the time it has it: it sets the container
   * straight onto that one, if it is there for it.
   */
  handTo?: number;
  /**
   * A gantry crane: the terminal tractor under it it is lifting a container
   * onto from its stack (`give`), or an export off onto its stack.
   */
  serving?: {
    id: number;
    give: boolean;
    ship?: number;
    /**
     * Taken off the tractor, which has gone on its way: on the spreader
     * until set down on the stack or on board.
     */
    held?: { fees: number[]; looks: number[]; planned: number };
  };
  /**
   * A gantry crane: the place on its landing stack each container lifted
   * off is in, and each export; see cranePlaces.
   */
  places?: number[];
  outPlaces?: number[];
}

/**
 * A jib crane's lift: a crate off `boat`, or with `load` an export on board
 * it, into or out of crate storage `store` or the pile on the quay `pile`,
 * else onto its own landing stack.
 */
interface JibJob {
  boat: Boat;
  load: boolean;
  store?: Bay;
  pile?: Bay;
}

/** A jib crane's lift for the view: which slot on the boat, which place at the other end. */
interface JibLift extends JibJob {
  slot: number;
  place: number;
  phase: number;
  /** The crate is on a pallet, as a coaster's are. */
  pallet: boolean;
}

type Vessel = keyof typeof B.VESSELS;

/** A berth, the dock tile it lies against, and the vessel lying there. */
interface Moorage {
  berth: number;
  jetty: number;
  vessel: Vessel;
}

/**
 * A harbour tug. It lies at its berth until a coaster or feeder needs
 * working in or out, sails out to meet it, keeps station alongside while
 * the ship comes round and alongside or pulls out, then goes back.
 */
export interface Tug extends Agent {
  name: string;
  /** Its tug berth. */
  home: number;
  speed: number;
  state: 'idle' | 'out' | 'assist' | 'back';
  /** The ship it is out to, or -1. */
  ship: number;
  /** Ticks until it plans its way again. */
  plan: number;
}

const TUG_NAMES = ['Hercules', 'Samson', 'Goliath', 'Titan', 'Atlas', 'Bulldog', 'Ajax', 'Brutus'];

interface Boat extends Agent {
  /** Sails in to the anchorage, waits there if needed, then moors at a jetty. */
  state: 'approaching' | 'anchored' | 'arriving' | 'moored' | 'leaving';
  /** Feeders carry containers (counted in `crates`) and need a harbour crane. */
  vessel: Vessel;
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
  /** Exports taken on board, on their way to it, and ticks since one last came. */
  out?: number;
  outIncoming?: number;
  loadIdle?: number;
  /** Crates taken on board to go out, each as its fee; see cargo.ts. */
  outFees?: number[];
  /** Feeders: how each export taken on board looks, and the deck slot it is in. */
  outLooks?: number[];
  outSlots?: number[];
  /** Feeders: deck slots the cranes have lifted their containers from. */
  lifted?: number[];
  /**
   * Exports it takes on board this visit: what was waiting in the port when
   * it was unloaded, less what other ships had claimed. Set then.
   */
  loadQuota?: number;
  /** Loaded and ready to sail: what it is still waiting on, if anything. */
  holdUp?: 'fairway' | 'tug' | 'others' | 'room';
  /**
   * Coming in to its berth: a ship moored across its way it has stopped
   * short of, by id, how many ticks it has waited, and the tick last counted;
   * and where it was as it began to wait, as it may creep a little meanwhile.
   */
  waitingOn?: number;
  waitedFor?: number;
  waitedAt?: number;
  waitedFrom?: [number, number];
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
  /**
   * A long ship's manoeuvre, ahead or astern with the helm over, or swung
   * round by tugs where it lies, and until when.
   */
  plan?: { helm: number; astern: boolean; pivot?: boolean; until: number; out?: boolean };
  /** Where the approach line to its berth starts and ends, see approachPath. */
  lineup?: number;
  lineEnd?: number;
  /**
   * A long ship coming in to a berth: heading for the start of the approach
   * line, lining up there, then running in along it; or leaving, running out
   * along the dock to open water (`lineup`) before it turns.
   */
  berthing?: 'lead' | 'align' | 'line' | 'out';
  /**
   * The boat whose way it is clearing, at the head of any chain of boats
   * backing out of each other's way.
   */
  yieldFor?: number;
  /** Speed going astern, which builds up and comes off gradually too. */
  sternway?: number;
  /** Closest it has got to its goal, and ticks since it last got closer. */
  best?: number;
  stall?: number;
  /**
   * The lane this boat holds while it comes alongside or pulls out (see
   * fairwayOf): one boat at a time per lane, so they do not meet in the
   * narrows.
   */
  fairway?: number;
  /** Where a leaving boat cast off, to tell when it is clear of the dock. */
  castOff?: number;
  /** The dock it cast off from. */
  castDock?: number;
  /** Casting off: 1 easing sideways off the dock, 2 backing out. */
  undock?: number;
  /** Ticks left squeezing past other boats after being wedged in, and the boats it squeezes past. */
  squeeze?: number;
  squeezePast?: number[];
  /** Ticks a boat lying still has kept it from going ahead, however it swings meanwhile. */
  stillFor?: number;
  /**
   * Ticks held up by a boat under way that gets nowhere either, as one met
   * head on backing off along its own way; and until when it is going round
   * it, every hull under way in its reckoning. Not saved.
   */
  headOn?: number;
  roundUntil?: number;
  /**
   * Ticks it has been beside the clear water off a moored boat's bow or
   * stern, and the tick that was last counted; see giveWay.
   */
  keptFor?: number;
  keptTick?: number;
  /**
   * Water a ship pulling out of its berth keeps to itself, as circles (x, y,
   * radius): the lane along the dock it runs out by and the water it turns
   * in at the end of it, then just that, until it has come round onto its
   * course or the tick `until`. Everyone else keeps out.
   */
  room?: { spots: [number, number, number][]; until: number; turning?: boolean };
  /** Has turned for sea after pulling out, and given its room back. */
  turned?: boolean;
  /**
   * Leaving: how far it has sailed since it cast off. Out of sight once
   * that is as far as boats come into sight on their way in.
   */
  sailed?: number;
  /** The ticks it came in from sea, moored, was unloaded, and done loading. */
  came?: number;
  mooredAt?: number;
  unloadedAt?: number;
  loadedAt?: number;
}

interface Truck extends Agent {
  state:
    'toPark' | 'parked' | 'toBay' | 'loading' | 'delivering' | 'toTown' | 'unloading' | 'leaving';
  /** The parking space it has taken (its first tile), while heading to it or parked there. */
  park?: number;
  /** The road it drove into the space from: it leaves by the far side. */
  parkFrom?: number;
  /** The tiles of the space it is driving into, parked in or leaving. */
  lot?: number[];
  /**
   * Backing into its truck bay: where it set off into the bay from, facing
   * along the road, how far through the turn it is, in tiles, and how fast
   * it is going.
   */
  backing?: { x: number; y: number; dir: number; k: number; v: number };
  /** A business in town it is delivering part of its load to, and how much. */
  drop?: number;
  /** Off the map: the highway round to the town's road, as x, y pairs still to drive. */
  round?: number[];
  /** The way on into town, once round on the highway. */
  then?: number[];
  dropCount?: number;
  contractId: number;
  company: string;
  capacity: number;
  bayIdx: number;
  cargo: number;
  /** Total fees of the cargo on board, paid when the truck leaves. */
  value: number;
  /** Carries containers instead of crates. */
  boxes: boolean;
  /** Has left the port, and counts as away on its round until its haulier's return is due. */
  away?: boolean;
  /** Ticks it has not moved for, with somewhere to go, and where it was; see pace. */
  held?: number;
  lastX?: number;
  lastY?: number;
  /** The truck it is keeping its distance behind, if any; see gapAhead. */
  blocker?: number;
  /** The ring it is driving on through, and where it set off from; see passRing. */
  passing?: { ids: number[]; x: number; y: number };
  /** A shipper's truck, bringing goods in to go out on the ships. */
  exports?: boolean;
  /** When its paperwork is done and it may drive into the port. */
  papers?: number;
  /** A shipper's truck: the outgoing storage it has moved to parking near, to wait for a spot. */
  staged?: number;
  /** Containers reach stackers are bringing it, or taking off it. */
  coming?: number;
  /** Container trucks: how each container on board looks, in load order. */
  looks?: number[];
  /** Crate trucks: each crate on board, as its fee, in load order; see cargo.ts. */
  fees?: number[];
  /** How the container a yard gantry is lifting onto it looks, from when it took it up. */
  lifting?: number;
  taking?: number;
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
  /**
   * Container yards: when each of `boxes` clears customs; minus the ship's
   * id while that ship is still being unloaded, as the clock only starts
   * once it is. Older saves have none: all clear.
   */
  boxReady?: number[];
  boxIncoming: number;
  /** Fee of each crate waiting here. */
  crates: number[];
  /** Crates being carried here right now. */
  incoming: number;
  nextTruckTick: number;
  noAccess: boolean;
  /** Why trucks cannot reach it, as the player was told; see cutOff. */
  noAccessWhy?: string;
  /** A container yard, marked out for containers. */
  yard?: boolean;
  /** Storage for cargo going out on the ships, not coming in. */
  outgoing?: boolean;
  /**
   * Storage stopped from taking any more, so it empties out: what is in it
   * still goes on to the trucks or the ships, but nothing new is brought.
   */
  shut?: boolean;
  /**
   * Cargo dockhands have lifted off a boat and set down on the quay beside
   * it, for the forklifts to take on; on pallets, or not.
   */
  pile?: boolean;
  pallets?: boolean;
  /** Crates promised to forklifts on their way to the pile. */
  reserved?: number;
  /** A heap of exports on the quay, waiting to go on board. */
  out?: boolean;
  /** Storage areas: the fees of goods waiting to go out on a ship. */
  exports?: number[];
  /** Exports on their way here by truck. */
  exportIncoming?: number;
  /** Container yards: the truck or tractor its gantry is part way through a lift for; see gantryFor. */
  gantryOn?: number;
  /** Container yards: where its gantry's carriage stands along its rails, as gantryLane counts. */
  gantryAt?: number;
  /** Container yards: the lift its gantry is part way through; see startLift. */
  gantryLift?: GantryLift;
  /**
   * The place in a container yard its gantry is setting a container down
   * in, kept for it from when it takes it up so nothing else is stacked
   * there meanwhile.
   */
  gantryTo?: number;
  /**
   * Container yards: a container its gantry has lifted off a truck or
   * tractor that has gone on its way, on the spreader until it is set down
   * at the end of the lift; see offToGantry.
   */
  gantryHeld?: GantryHeld;
  /** Exports promised to workers on their way to take them on board. */
  outReserved?: number;
  /** Container yards: cleared containers promised to stackers loading trucks. */
  truckReserved?: number;
  /** Container yards: how each container, and each export, looks. */
  boxLooks?: number[];
  exportLooks?: number[];
  /** Container yards: the slot each container, and each export, is stacked in; see yardSlots. */
  boxSlots?: number[];
  exportSlots?: number[];
  /**
   * Crate storage: the place each pallet is in, holding the next four of
   * its crates then its exports; see palletPlaces.
   */
  places?: number[];
  /**
   * A storage area: the port road and quay tiles marked out for it, lowest
   * first; its main tile is the first. Trucks load from beside it.
   */
  tiles?: number[];
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
  /** Container fees raised by half (older saves' deals still at the old rate otherwise). */
  containerFees2?: boolean;
  candidates: Candidate[];
  cranes: Crane[];
  congestion: number;
  jam: { moving: number; waiting: number };
  tier: number;
  loan: number;
  today: Ledger;
  yesterday: Ledger | null;
  /** Older saves have none. */
  history?: FinanceDay[];
  /** Older saves have none. */
  cargoLog?: CargoSample[];
  daysInRed: number;
  bankrupt: boolean;
  map: MapData;
  people: Dockhand[];
  boats: Boat[];
  /** Older saves have none. */
  tugs?: Tug[];
  trucks: Truck[];
  bays: Bay[];
  yards?: Bay[];
  piles?: Bay[];
  /** Older saves have no town or railway; one is laid out when they load. */
  town?: Town | null;
  rail?: RailState;
  /** State of the town and railway's own random numbers. */
  scenery?: number;
  /** Advisor tips already given; see tip(). */
  tips?: string[];
  /** Boats that have left the port so far, for the advisor; see departTips. */
  departed?: number;
  /** When container ships lately finished unloading; see unloadedAt. */
  unloaded?: [number, number][];
}

/** Days gone by kept for the finance charts. */
const FINANCE_DAYS = 60;
/** Ticks between cargo counts kept for the statistics charts, and how many are kept: a week's. */
const CARGO_EVERY = TICKS_PER_DAY / 10;
/** How far a truck backing into a truck bay goes, in tiles, and the share of it spent pulling on past the entrance. */
const BACK_TURN = 2.2;
const BACK_PULL = 0.35;
const CARGO_SAMPLES = 70;

function emptyLedger(): Ledger {
  return {
    cargo: 0,
    containers: 0,
    exports: 0,
    town: 0,
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

/** Reach stackers and terminal tractors move containers; everyone else crates. */
function isBoxy(p: { kind: string }): boolean {
  return p.kind === 'stacker' || p.kind === 'tractor';
}

/** What drives the port's roads in traffic: trucks, and the reach stackers and terminal tractors. */
type Vehicle = Truck | Dockhand;

/** A truck or machine about to drive across a tile, and which way. */
interface Crossing {
  id: number;
  dx: number;
  dy: number;
}

function isTruck(o: Vehicle): o is Truck {
  return 'contractId' in o;
}

/** Where slot `k` lies on a feeder's deck: its bay from the stern, row across and tier up. */
function deckPlace(k: number): { bay: number; row: number; tier: number } {
  const per = B.FEEDER_BAYS * B.FEEDER_ROWS;
  return {
    bay: Math.floor((k % per) / B.FEEDER_ROWS),
    row: k % B.FEEDER_ROWS,
    tier: Math.floor(k / per),
  };
}

/** Stacks of containers on each tile of a yard, and how high. */
const YARD_STACKS = 2;
const YARD_TIERS = B.BOXES_PER_STORE_TILE / YARD_STACKS;

/** Where slot `k` of a yard is: the tile (by its place in the yard's tiles), the stack on it and the tier. */
function yardPlace(k: number): { tile: number; stack: number; tier: number } {
  const r = k % B.BOXES_PER_STORE_TILE;
  return {
    tile: Math.floor(k / B.BOXES_PER_STORE_TILE),
    stack: r % YARD_STACKS,
    tier: Math.floor(r / YARD_STACKS),
  };
}

/**
 * Stacks side by side on a container crane's landing stack: a gantry
 * crane's along its rails, two deep, a harbour crane's two.
 */
function craneStacks(c: Crane): number {
  return c.kind === 'gantry' ? B.GANTRY_RAILS * 2 : 2;
}

/** Ticks a crane takes to lift one crate or container. */
function craneTicks(c: Crane): number {
  return c.kind === 'gantry'
    ? B.GANTRY_TICKS
    : c.kind === 'harbour'
      ? B.HARBOUR_CRANE_TICKS
      : B.CRANE_TICKS;
}

/** Most a crane sets down before it waits for them to be taken away. */
function craneStack(c: Crane): number {
  return c.kind === 'gantry'
    ? B.GANTRY_STACK
    : c.kind === 'harbour'
      ? B.HARBOUR_CRANE_STACK
      : B.CRANE_STACK;
}

/** Somewhere a worker can pick up a load. */
interface Source {
  tile: number;
  avail: number;
  boat?: Boat;
  crane?: Crane;
  /** A heap on the quay, or storage the trucks cannot reach. */
  pile?: Bay;
  /** Exports, taken from storage or the quay to go on board. */
  out?: boolean;
  /** A truck at a yard for a stacker to load (`load`) or unload. */
  truck?: Truck;
  load?: boolean;
  /** Lower goes first. */
  rank: number;
}

/** A container on a yard gantry's spreader, lifted off a truck or tractor that has gone. */
interface GantryHeld {
  /** The truck or tractor it came off, and where along the rails that stood. */
  by: number;
  at: number;
  /** Its container slot on that, for the view. */
  slot: number;
  fees: number[];
  looks: number[];
  /** The ship each came off, for customs; for a tractor's imports. */
  from?: number[];
  /** A shipper's export, or one a tractor brought back, rather than one in from a ship. */
  exports: boolean;
  /** How many were planned to come here, held as incoming until set down. */
  planned: number;
}

/** A yard gantry at work, for the view; see gantryWork. */
type GantryWork = {
  working?: 'load' | 'unload';
  workLook?: number;
  workAt?: number;
  workTruck?: number;
  workSlot?: number;
  workPhase?: number;
  /** Where in the yard the container it sets down goes. */
  workYard?: number;
  /** The lift's legs, as shares of it (see liftMarks), and how many ticks it takes in all. */
  workLegs?: number[];
  workTicks?: number;
  /** The tick the lift began: a new one begins with a new tick. */
  workStart?: number;
  /** The truck or tractor it came off has gone: the container is on the spreader alone. */
  released?: boolean;
};

/**
 * A yard gantry's lift, in ticks from `start`: running along its rails to
 * the container, taking it up, carrying it along to where it goes, and
 * setting it down there, `to` along its rails, where it then stands.
 */
interface GantryLift {
  start: number;
  legs: [number, number, number, number];
  to: number;
}

/** Ticks a yard gantry's lift takes in all. */
function liftTicks(l: GantryLift): number {
  return Math.max(1, l.legs[0] + l.legs[1] + l.legs[2] + l.legs[3]);
}

/** Room left at a bay for crates, or at a container yard for containers. */
function bayRoom(b: Bay, boxes: boolean): number {
  if (b.pile) return boxes ? 0 : B.PILE_CRATES - b.crates.length - b.incoming;
  if (b.yard) return boxes ? bayCap(b) - b.boxes.length - b.boxIncoming - outHeld(b) : 0;
  if (boxes) return 0;
  return bayCap(b) - b.crates.length - b.incoming - outHeld(b);
}

/** Room storage gives over to exports, there or on their way. */
function outHeld(b: Bay): number {
  return (b.exports?.length ?? 0) + (b.exportIncoming ?? 0);
}

/** How many crates or containers a ship takes out. Fishing boats take none. */
function outCap(b: { vessel: string }): number {
  return b.vessel === 'feeder'
    ? B.FEEDER_MAX_LOAD
    : b.vessel === 'coaster'
      ? B.COASTER_MAX_LOAD
      : 0;
}

function bayIncoming(b: Bay, boxes: boolean, delta: number): void {
  if (boxes) b.boxIncoming = Math.max(0, b.boxIncoming + delta);
  else b.incoming = Math.max(0, b.incoming + delta);
}

/** Crates and exports in a bay or crate storage. */
function heldIn(b: Bay): number {
  return b.crates.length + (b.exports?.length ?? 0);
}

function bayCap(b: Bay): number {
  if (b.tiles) {
    return b.tiles.length * (b.yard ? B.BOXES_PER_STORE_TILE : B.CRATES_PER_STORE_TILE);
  }
  return b.large ? B.LARGE_BAY_CAPACITY : B.BAY_CAPACITY;
}

/** Ticks to put one crate or container on a truck here. */
function loadTicks(b: Bay): number {
  if (b.yard) return B.YARD_LOAD_TICKS;
  if (b.warehouse) return B.STORE_LOAD_TICKS;
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

/** Distance from a point to the segment x0,y0 to x1,y1. */
function toSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const vx = x1 - x0;
  const vy = y1 - y0;
  const l = vx * vx + vy * vy;
  const t = l > 0 ? clamp(((px - x0) * vx + (py - y0) * vy) / l, 0, 1) : 0;
  return Math.hypot(px - x0 - vx * t, py - y0 - vy * t);
}

/**
 * Clear water between two hulls, each taken as its keel line with half its
 * beam all round it; below zero they touch.
 */
function hullGap(
  ax: number,
  ay: number,
  ad: number,
  av: { length: number; beam: number },
  bx: number,
  by: number,
  bd: number,
  bv: { length: number; beam: number },
): number {
  const ah = av.length / 2 - av.beam / 2;
  const bh = bv.length / 2 - bv.beam / 2;
  const a0x = ax - Math.cos(ad) * ah;
  const a0y = ay - Math.sin(ad) * ah;
  const a1x = ax + Math.cos(ad) * ah;
  const a1y = ay + Math.sin(ad) * ah;
  const b0x = bx - Math.cos(bd) * bh;
  const b0y = by - Math.sin(bd) * bh;
  const b1x = bx + Math.cos(bd) * bh;
  const b1y = by + Math.sin(bd) * bh;
  const side = (x0: number, y0: number, x1: number, y1: number, px: number, py: number) =>
    (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
  const crossed =
    side(a0x, a0y, a1x, a1y, b0x, b0y) * side(a0x, a0y, a1x, a1y, b1x, b1y) < 0 &&
    side(b0x, b0y, b1x, b1y, a0x, a0y) * side(b0x, b0y, b1x, b1y, a1x, a1y) < 0;
  const keels = crossed
    ? 0
    : Math.min(
        toSegment(a0x, a0y, b0x, b0y, b1x, b1y),
        toSegment(a1x, a1y, b0x, b0y, b1x, b1y),
        toSegment(b0x, b0y, a0x, a0y, a1x, a1y),
        toSegment(b1x, b1y, a0x, a0y, a1x, a1y),
      );
  return keels - (av.beam + bv.beam) / 2;
}

/**
 * How a container looks, which the renderer turns into its paint: fixed by
 * the ship or truck that brought it and its place on board, and kept beside
 * its fee wherever it goes, so it keeps its colours from ship to truck.
 */
function boxLookOf(from: number, k: number): number {
  return from * 97 + k;
}

/**
 * The looks kept beside a list of containers, the same length as it: any
 * missing (from older saves) made up at the front, any spare dropped.
 */
function aligned(items: number[], looks: number[] | undefined, seed: number): number[] {
  const out = looks ?? [];
  while (out.length < items.length) out.unshift(boxLookOf(seed, 1000 + out.length));
  if (out.length > items.length) out.splice(0, out.length - items.length);
  return out;
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

/** Terminal tractors carry containers the cranes and yard gantries lift on and off. */
const TRACTOR_ACTIVITY: Partial<Record<DockhandState, string>> = {
  toPickup: 'Heading for a container',
  picking: 'Having a container lifted on',
  toDrop: 'Carrying a container',
  dropping: 'Having a container lifted off',
};

/** Forklifts take on what is landed on the quay or by a crane. */
const FORKLIFT_ACTIVITY: Partial<Record<DockhandState, string>> = {
  toPickup: 'Heading to the cargo',
  picking: 'Lifting crates',
};

/** What a worker is up to; `landing` when setting a load down on the quay. */
function activity(p: Dockhand, landing: boolean): string {
  if (p.state === 'idle' && p.stuck) return p.stuck;
  if (p.truckId !== undefined && !isBoxy(p)) {
    if (p.state === 'toPickup') return 'Heading to load a truck';
    if (p.state === 'picking') return 'Picking up crates for a truck';
    if (p.state === 'dropping') return 'Loading crates onto a truck';
  }
  if (p.truckId !== undefined) {
    if (p.state === 'toPickup') return 'Heading to a truck at the container yard';
    if (p.state === 'picking') {
      return p.truckLoad ? 'Lifting a container off the stack' : 'Lifting a container off a truck';
    }
    if (p.state === 'dropping') {
      return p.truckLoad ? 'Setting a container on a truck' : 'Stacking a container';
    }
  }
  if (p.restack) {
    return p.state === 'picking'
      ? 'Lifting a container off one customs have cleared, to restack it'
      : 'Heading to restack the yard';
  }
  if (landing && (p.state === 'toDrop' || p.state === 'dropping')) {
    return 'Setting a crate down on the quay';
  }
  if (p.kind === 'forklift' && FORKLIFT_ACTIVITY[p.state]) return FORKLIFT_ACTIVITY[p.state]!;
  if (p.kind === 'tractor' && TRACTOR_ACTIVITY[p.state]) return TRACTOR_ACTIVITY[p.state]!;
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
  private tugHeld = new WeakMap<Tug, number>();
  trucks: Truck[] = [];
  bays = new Map<number, Bay>();
  /** Container yards, by their main tile. Crate storage areas are with the bays. */
  yards = new Map<number, Bay>();
  /** Cargo landed on the quay beside boats, by tile. */
  piles = new Map<number, Bay>();
  /** The storage area each tile is part of, by its main tile, or -1. Not saved. */
  private storeOf: Int32Array;
  /** Where trucks stand to load at each storage area; cleared when the port changes. */
  private spotCache = new Map<number, number[]>();
  /** Each tile of a yard gantry's lane with the way trucks drive along it; see laneWays. */
  private laneCache: Map<number, [number, number]> | null = null;
  /** Each tile of a yard gantry's lane with the way its rails run; see gantryRailWays. */
  private railCache: Map<number, [number, number]> | null = null;
  /** The yard each tile of a yard gantry's lane is beside, by its first tile; with railCache. */
  private railYard = new Map<number, number>();
  /** Every tile of the lanes under the yard gantries; see yardLaneTiles. */
  private yardLaneCache: Set<number> | null = null;
  /** How far the roads run across from each tile, for keeping right; see laneRuns. */
  private runsCache: Uint8Array | null = null;
  /** Each yard's gantry lane, by the yard; see gantryLane. */
  private laneOfCache = new Map<number, Map<number, number> | null>();
  /** Which yard each yard gantry works; see gantries. */
  private gantryCache: { byYard: Map<number, number>; idle: Map<number, string> } | null = null;
  /** How far by road trucks have to each tile they can reach; see truckReach. */
  private reachCache: Int32Array | null = null;
  /** Junctions trucks give way at; see junctions. */
  private junctionCache: Uint8Array | null = null;
  /** Where quay gantry cranes have containers set down, this tick; see craneStackTiles. */
  private craneStackCache: { tick: number; at: Set<number> } | null = null;
  /** Which way tractors stand where cranes lift onto them; see lineUpAt. */
  private lineUpCache: Map<number, [number, number]> | null = null;
  /** Trucks and port machines by id, this tick; see ring. */
  private vehicleCache: { tick: number; by: Map<number, Vehicle> } | null = null;
  /** Where trucks and machines are about to drive, this tick; see crossings. */
  private crossingCache: { tick: number; at: Map<number, Crossing[]> } | null = null;
  /** Where trucks can turn about; see turnable. */
  private turnCache: Uint8Array | null = null;
  /** Where port machines can drive from their depots; see machineGround. */
  private machineCache: Set<number> | null = null;
  /** The parking lots, and whether each works; see parkingLots. */
  private lotsCache: ParkingLot[] | null = null;
  /** The town up the coast, which grows with the port. */
  town: Town | null = null;
  /** The step up the player has been told the town is big enough for. */
  private tierReadyTold = 0;
  rail: RailState;
  /**
   * The town and the trains draw their own random numbers, so they never
   * change what happens at the port.
   */
  readonly scenery: Rng;

  private anchorageTile = -1;
  /** Ticks today with a full truck bay, for the advisor. Not saved. */
  private bayFullTicks = 0;
  /** Cached planning estimate; cleared when the port changes. Not saved. */
  private capacityCache: Capacity | null = null;
  /** Dock groups and the coordinated tiles; cleared when the map changes. Not saved. */
  private dockCache: ReturnType<World['docks']> | null = null;
  private gateCache: Set<number>[] | null = null;
  /** Boats held up this tick only by a ship pulling out. Not saved. */
  private roomWait = new WeakSet<Boat>();
  /**
   * Where each boat under way will be over the next LOOKOUT_TICKS, at the
   * pace it is keeping (see plot), drawn once a tick. Not saved.
   */
  private plots = new Map<Boat, Float64Array>();
  private plotsAt = -1;
  /**
   * The share of its speed a boat keeping clear holds to, and the boat it
   * is keeping clear of. Not saved.
   */
  private keepingClear = new WeakMap<Boat, { pace: number; of: number }>();
  /** Ticks each boat under way has lain still, for plotCourses. Not saved. */
  private stillFor = new WeakMap<Boat, number>();
  /** Boats coming alongside, lining up, casting off or pulling out. Not saved. */
  private handling = new WeakSet<Boat>();
  /** What each jib crane at work is lifting this tick, for the view. Not saved. */
  private jibJobs = new WeakMap<Crane, JibJob>();
  private buoyCache: Uint8Array | null = null;
  private frontCache: Int32Array | null = null;
  /** What routes pay to pass close to a jetty, quay or the shore; see shoreRing. */
  private ringCache: Float32Array | null = null;
  private coordinated = new Set<number>();
  /** Dock tile → its dock's key (the dock's lowest tile), with docks(). */
  private dockKey = new Map<number, number>();
  /** Advisor tips already given, so each comes once a game. */
  tipsSeen = new Set<string>();
  /** Boats that have left the port so far, for the advisor; see departTips. */
  private departed = 0;
  /** When each container ship lately finished unloading, by id, for customs. */
  unloadedAt = new Map<number, number>();
  private warnedOffice = false;
  /** When each repeating warning may next be given, and the gap after that. Not saved. */
  private nags = new Map<string, { next: number; gap: number }>();
  /** Demurrage charged since midnight, told once a day at most. */
  private demurrageToday = { amount: 0, ships: 0 };
  /** Lines signed this session whose first boat has not come in, to say when it does. Not saved. */
  private firstBoat = new Set<string>();
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
    this.storeOf = new Int32Array(map.w * map.h).fill(-1);
    this.scenery = new Rng(seed ^ 0x7a3c1);
    this.rail = newRail(this.scenery);
  }

  /** Lay the railway and found the town, on a new map or one from an older save. */
  private settle(): void {
    layRailway(this.map);
    this.town = foundTown(this.map, townName(this.scenery), () => {});
  }

  /** A new game; `size`, the port's land, for a map as big as they were before. */
  static create(seed: number, size?: number): World {
    const { map, spawn } = generateMap(seed, size);
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
    world.tip('welcome');
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
    for (const bay of s.bays) {
      world.bays.set(bay.idx, {
        ...bay,
        crates: [...bay.crates],
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
    world.layHighwayIn();
    if (s.town === undefined) world.settle();
    else if (s.town) world.relay({ ...s.town });
    // The town's trucks drive to it off the highway now, not round past the map.
    if (world.town) world.town.gate = -1;
    // Parked trucks stand the way their lot's spaces lean, as it now runs one way.
    for (const t of world.trucks) if (t.state === 'parked' && t.lot) world.parkUp(t);
    world.rebuildStores();
    return world;
  }

  /** Bring a town from an older save up to date, laying it out again under the current rules. */
  private relay(old: Town): void {
    const t: Town = {
      ...old,
      supplied: old.supplied ?? 0,
      local: old.local ?? 0,
      wants: old.wants ?? townWants(this.map),
      layout: old.layout ?? 1,
      gate: old.gate ?? -1,
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
        return this.build(cmd.kind, cmd.tiles, cmd.facing);
      case 'bulldoze':
        return this.bulldoze(cmd.tiles);
      case 'forkliftOnly':
        return this.markForkliftOnly(cmd.tiles, cmd.on);
      case 'exit':
        return this.openExit(cmd.row);
      case 'oneWay':
        return this.markOneWay(cmd.tiles, cmd.on);
      case 'lights':
        return this.toggleLights(cmd.tile);
      case 'gateWay':
        return this.setGateWay(cmd.tile, cmd.way);
      case 'roundabout':
        return this.buildRoundabout(cmd.tile);
      case 'unmark':
        return this.unmark(cmd.tiles);
      case 'store':
        return this.markStore(cmd.tiles, cmd.kind, cmd.on);
      case 'shutStore':
        return this.shutStore(cmd.idx, cmd.shut);
      case 'sailNow':
        return this.sailNow(cmd.id);
      case 'terraform':
        return this.terraform(cmd.tiles, cmd.raise);
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
      case 'buyTug':
        return this.buyTug(cmd.tile);
      case 'raise':
        return this.answerRaise(cmd.id, cmd.accept);
      case 'signContract':
        return this.signContract(cmd.id);
      case 'cancelContract':
        return this.cancelContract(cmd.id);
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
          // A building on a quay remembers it, to leave it when cleared.
          const quay = this.map.build[t] === Build.Quay ? ON_QUAY : 0;
          // A road over the railway is a level crossing.
          const crossing = def.code === Build.Road && this.map.build[t] === Build.Rail;
          // Parking is marked out on a road: which kind it was, for when it is unmarked.
          const under =
            kind === 'parking' && this.map.build[t] === Build.PortRoad ? ON_PORT_ROAD : 0;
          this.map.build[t] = crossing ? Build.Crossing : def.code;
          this.map.orient[t] =
            (ROTATABLE.has(kind) ? partOrient(f, k) : 0) |
            (kind === 'parking' ? this.map.orient[t] & ON_QUAY : quay) |
            under;
          this.map.deco[t] = Deco.None;
          this.dirty.add(t);
        });
        if (kind === 'truckBay' || kind === 'largeBay') this.addBay(i);
        if (kind === 'jibCrane') this.addCrane(i, 'jib');
        if (kind === 'jibCrane' || kind === 'harbourCrane' || kind === 'gantryCrane') {
          this.tip('cranes');
        }
        if (kind === 'yardGantry') this.tip('yardGantry');
        if (kind === 'harbourCrane') this.addCrane(i, 'harbour');
        if (kind === 'gantryCrane') {
          this.addCrane(i, 'gantry');
          this.keepForMachines(gantryGround(this.map, i, f));
        }
      }
      if (skipped.length === left.length) break;
      left = skipped;
    }
    if (spent > 0) this.moneyAt(-spent, tiles[tiles.length - 1]);
    if (spent > 0 && kind === 'road') this.exitsFor(tiles);
    if (spent > 0 && (kind === 'jetty' || kind === 'quay')) {
      this.dockCache = null;
      const idle = this.docks().some((g) => !g.coordinated);
      if (idle && !this.warnedOffice) {
        this.warnedOffice = true;
        this.message(
          kind === 'quay'
            ? 'Quays need a harbour office to coordinate them. Boats will not use this one until you build one.'
            : `Only ${B.FREE_DOCKS} jetties can run without a harbour office or harbourmaster's hut. Build one so boats use this jetty.`,
          'bad',
        );
      }
    } else if (spent > 0 && kind === 'office') {
      this.warnedOffice = false;
      this.message('The harbour office is open and coordinating berths.', 'good');
    } else if (spent > 0 && kind === 'harbourHut') {
      this.warnedOffice = false;
      this.message(
        `The harbourmaster's hut is open, looking after ${B.JETTIES_PER_HUT} more jetties.`,
        'good',
      );
    } else if (spent > 0 && kind === 'parking') {
      // Laid out where trucks cannot use it: say why.
      this.lotsCache = null;
      this.reachCache = null;
      const lot = this.parkingLots().find((l) => l.tiles.some((i) => tiles.includes(i)));
      const trouble = lot && this.lotTrouble(lot);
      if (trouble) this.message(`This parking is no use yet: ${trouble.toLowerCase()}.`, 'bad');
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

  /** Mark port roads and quays for port machines only, free: round a gantry crane's rails. */
  private keepForMachines(tiles: number[]): void {
    for (const t of tiles) {
      const b = this.map.build[t];
      if ((b !== Build.Quay && b !== Build.PortRoad) || forkliftOnly(this.map, t)) continue;
      this.map.orient[t] |= FORKLIFT_ONLY;
      this.dirty.add(t);
    }
  }

  private markForkliftOnly(tiles: number[], on: boolean): void {
    if (this.tier < B.FORKLIFT_ONLY_TIER) {
      return this.message(
        `Machines-only areas unlock at the ${TIERS[B.FORKLIFT_ONLY_TIER].name}.`,
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
      if (on) this.tip('machinesOnly');
    }
    if (spent > 0) this.moneyAt(-spent, tiles[tiles.length - 1]);
    else if (firstError) this.message(firstError, 'bad');
  }

  // ── Roads: the highway's exits, one-way roads, lights, gates ────

  /**
   * A public road just built up to the highway, meeting it head on rather
   * than running alongside, opens an exit there; or says why it cannot.
   */
  private exitsFor(tiles: number[]): void {
    const m = this.map;
    if (!hasHighway(m)) return;
    const road = (x: number, y: number) => m.inBounds(x, y) && isPublicRoad(m.build[m.idx(x, y)]);
    const rows = new Set<number>();
    for (const i of tiles) {
      const y = m.yOf(i);
      if (m.xOf(i) !== HIGHWAY_COLUMNS || !road(HIGHWAY_COLUMNS, y)) continue;
      if (isExit(m, m.idx(1, y)) || road(HIGHWAY_COLUMNS, y - 1) || road(HIGHWAY_COLUMNS, y + 1))
        continue;
      rows.add(y);
    }
    for (const y of rows) this.openExit(y, true);
  }

  /** Open an exit off the highway at row `row`, and the road off it; `auto`, for a road built up to it. */
  private openExit(row: number, auto = false): void {
    const m = this.map;
    const why = (text: string) =>
      this.message(auto ? `The road meets the highway, but no exit opens: ${text}` : text, 'bad');
    if (this.tier < B.EXIT_TIER) {
      return why(
        auto
          ? `exits open from the ${TIERS[B.EXIT_TIER].name}.`
          : `Highway exits open at the ${TIERS[B.EXIT_TIER].name}.`,
      );
    }
    const err = exitError(m, row);
    if (err) return why(auto ? `${err[0].toLowerCase()}${err.slice(1)}.` : err);
    if (this.cash < B.EXIT_COST) {
      return why(
        auto ? `an exit costs $${B.EXIT_COST.toLocaleString('en-US')}.` : 'Not enough money',
      );
    }
    this.book('construction', -B.EXIT_COST);
    setExit(m, row, true);
    const beside = m.idx(HIGHWAY_COLUMNS, row);
    if (m.build[beside] === Build.None) {
      m.build[beside] = Build.Road;
      m.orient[beside] = 0;
      m.deco[beside] = Deco.None;
    }
    for (let x = 0; x <= HIGHWAY_COLUMNS; x++) this.dirty.add(m.idx(x, row));
    this.moneyAt(-B.EXIT_COST, beside);
    this.tip('exits');
  }

  /**
   * Make road tiles one way, the way the drag ran over them (the last the
   * way it came onto it); one tile on its own is turned the other way.
   * With `on` false, they go back to two way.
   */
  private markOneWay(tiles: number[], on: boolean): void {
    const m = this.map;
    // Truck parking picked: its lot turned round, to run the other way.
    const lots = new Set(
      tiles.filter((i) => m.build[i] === Build.Parking).map((i) => this.lotOf(i)),
    );
    for (const lot of lots) {
      if (!lot) continue;
      const next = nextParkWay(m, lot.tiles);
      for (const t of lot.tiles) {
        m.orient[t] = (m.orient[t] & ~(PARK_FLIP | PARK_MIRROR)) | next;
        this.dirty.add(t);
      }
    }
    if (lots.size > 0) this.lotsCache = null;
    tiles = tiles.filter((i) => m.build[i] !== Build.Parking);
    if (tiles.length === 0) return;
    if (this.tier < B.ONE_WAY_TIER) {
      return this.message(`One-way roads unlock at the ${TIERS[B.ONE_WAY_TIER].name}.`, 'bad');
    }
    let spent = 0;
    let firstError: string | null = null;
    tiles.forEach((i, k) => {
      if (i < 0 || i >= m.build.length || firstError === 'Not enough money') return;
      const err = oneWayError(m, i);
      if (err) {
        firstError ??= err;
        return;
      }
      const was = oneWay(m, i);
      if (!on) {
        if (was < 0) return;
        m.orient[i] &= ~ONE_WAY;
        this.dirty.add(i);
        return;
      }
      const next = tiles[k + 1];
      const prev = tiles[k - 1];
      const along = (a: number, b: number) => m.neighbors4(a).includes(b);
      const f =
        next !== undefined && along(i, next)
          ? stepFacing(m, i, next)
          : prev !== undefined && along(prev, i)
            ? stepFacing(m, prev, i)
            : was >= 0
              ? was ^ 2
              : -1;
      if (f < 0) {
        firstError ??= 'Drag along the road the way the traffic should go';
        return;
      }
      if (f === was) return;
      if (this.cash < B.ONE_WAY_COST) {
        firstError = 'Not enough money';
        return;
      }
      this.book('construction', -B.ONE_WAY_COST);
      spent += B.ONE_WAY_COST;
      m.orient[i] = (m.orient[i] & ~3) | ONE_WAY | f;
      this.dirty.add(i);
    });
    if (spent > 0) {
      this.moneyAt(-spent, tiles[tiles.length - 1]);
      this.tip('oneWay');
    } else if (firstError) this.message(firstError, 'bad');
  }

  /** Put up traffic lights at a junction, or take them down again for nothing back. */
  private toggleLights(i: number): void {
    const m = this.map;
    if (i < 0 || i >= m.build.length) return;
    if (this.tier < B.LIGHTS_TIER) {
      return this.message(`Traffic lights unlock at the ${TIERS[B.LIGHTS_TIER].name}.`, 'bad');
    }
    const err = lightsError(m, i);
    if (err) return this.message(err, 'bad');
    const tiles = [i];
    const on = !hasLights(m, i);
    if (on && this.cash < B.LIGHTS_COST) return this.message('Not enough money', 'bad');
    if (on) {
      this.book('construction', -B.LIGHTS_COST);
      this.moneyAt(-B.LIGHTS_COST, i);
      this.tip('lights');
    }
    for (const t of tiles) {
      m.orient[t] = on ? m.orient[t] | LIGHTS : m.orient[t] & ~LIGHTS;
      this.dirty.add(t);
    }
  }

  /** Let trucks through a port gate both ways, only in, or only out. */
  private setGateWay(i: number, way: 'both' | 'in' | 'out'): void {
    const m = this.map;
    if (i < 0 || i >= m.build.length) return;
    const g = anchorOf(m, i);
    if (m.build[g] !== Build.Gate) return this.message('Pick a port gate', 'bad');
    if (this.tier < B.ONE_WAY_TIER) {
      return this.message(`One-way gates unlock at the ${TIERS[B.ONE_WAY_TIER].name}.`, 'bad');
    }
    if (gateWay(m, g) === way) return;
    if (this.cash < B.GATE_WAY_COST) return this.message('Not enough money', 'bad');
    this.book('construction', -B.GATE_WAY_COST);
    this.moneyAt(-B.GATE_WAY_COST, g);
    const bits = way === 'in' ? GATE_IN : way === 'out' ? GATE_OUT : 0;
    m.orient[g] = (m.orient[g] & ~(GATE_IN | GATE_OUT)) | bits;
    this.dirty.add(g);
  }

  /** A roundabout round an island at `c`: a ring of one-way road, keeping right. */
  private buildRoundabout(c: number): void {
    const m = this.map;
    if (c < 0 || c >= m.build.length) return;
    if (this.tier < B.LIGHTS_TIER) {
      return this.message(`Roundabouts unlock at the ${TIERS[B.LIGHTS_TIER].name}.`, 'bad');
    }
    const err = roundaboutError(m, c);
    if (err) return this.message(err, 'bad');
    const cost = roundaboutCost(m, c);
    if (this.cash < cost) return this.message('Not enough money', 'bad');
    this.book('construction', -cost);
    this.moneyAt(-cost, c);
    const cx = m.xOf(c);
    const cy = m.yOf(c);
    // The island in the middle.
    m.build[c] = Build.None;
    m.orient[c] = 0;
    m.deco[c] = Deco.None;
    this.dirty.add(c);
    for (const [dx, dy, f] of ROUNDABOUT_RING) {
      const i = m.idx(cx + dx, cy + dy);
      m.build[i] = Build.Road;
      m.orient[i] = ONE_WAY | f;
      m.deco[i] = Deco.None;
      this.dirty.add(i);
    }
    this.tip('roundabout');
  }

  /**
   * Lay the highway down the west edge of a map from before it ran on the
   * map: the roads that went off the edge there join it at exits, and
   * anything else in its way is cleared. Trucks out on the old highway
   * round to the town head off.
   */
  private layHighwayIn(): void {
    const m = this.map;
    if (hasHighway(m)) return;
    const exits = new Set<number>([m.yOf(m.entry)]);
    let cleared = false;
    for (let y = 0; y < m.h; y++) {
      if (isPublicRoad(m.build[m.idx(0, y)]) && isPublicRoad(m.build[m.idx(HIGHWAY_COLUMNS, y)])) {
        exits.add(y);
      }
      for (let x = 0; x < HIGHWAY_COLUMNS; x++) {
        const i = m.idx(x, y);
        if (m.build[i] === Build.None || isPublicRoad(m.build[i])) continue;
        this.bays.delete(i);
        this.yards.delete(i);
        cleared = true;
      }
    }
    const row = m.yOf(m.entry);
    const beside = m.idx(HIGHWAY_COLUMNS, row);
    if (m.build[beside] === Build.None) m.build[beside] = Build.Road;
    layHighway(m, exits);
    m.entry = m.idx(HIGHWAY_COLUMNS - 1, row);
    if (cleared) this.rebuildStores();
    for (const t of this.trucks) {
      if (!t.round && !t.then) continue;
      t.round = undefined;
      t.then = undefined;
      this.headOut(t);
    }
  }

  /** Mark port road and quay tiles out as storage, or clear them, for a refund. */
  /**
   * Clear whatever marks lie on the tiles: storage, which gives back what
   * bulldozing it would, and machines-only marks, for nothing. The ground
   * kept round cranes and gantry rails stays as it is.
   */
  private unmark(tiles: number[]): void {
    let refund = 0;
    let stores = false;
    let any = false;
    for (const i of tiles) {
      if (i < 0 || i >= this.map.build.length) continue;
      const what = unmarkable(this.map, i);
      if (what.store) {
        refund += unmarkRefund(this.map, i);
        this.map.store[i] = Store.None;
        stores = true;
      }
      if (what.machines) this.map.orient[i] &= ~FORKLIFT_ONLY;
      if (what.road) this.map.orient[i] &= ~(ONE_WAY | LIGHTS);
      if (what.parking) {
        // The road it was marked out on, back as it was.
        refund += unmarkRefund(this.map, i);
        this.map.build[i] = roadUnderParking(this.map, i);
        this.map.orient[i] &= ON_QUAY;
      }
      if (what.store || what.machines || what.road || what.parking) {
        this.dirty.add(i);
        any = true;
      }
    }
    if (stores) this.rebuildStores();
    if (refund > 0) {
      this.book('construction', refund);
      this.moneyAt(refund, tiles[tiles.length - 1]);
    }
    if (!any) this.message('Nothing marked out here that can be cleared', 'bad');
  }

  private markStore(tiles: number[], kind: StoreKind, on: boolean): void {
    const tier = STORE_TIER[kind];
    if (this.tier < tier) {
      return this.message(`${STORE_LABEL[kind]} unlocks at the ${TIERS[tier].name}.`, 'bad');
    }
    let net = 0;
    let firstError: string | null = null;
    let changed = false;
    for (const i of tiles) {
      if (i < 0 || i >= this.map.build.length) continue;
      const err =
        storeError(this.map, i, kind, on) ??
        (on && this.piles.has(i) ? 'Cargo is waiting on the quay here' : null);
      if (err) {
        firstError ??= err;
        continue;
      }
      const value = on ? -STORE_COST[kind] : Math.floor(STORE_COST[kind] * B.BULLDOZE_REFUND);
      if (value < 0 && this.cash < -value) {
        firstError = 'Not enough money';
        break;
      }
      this.book('construction', value);
      net += value;
      this.map.store[i] = on ? STORE_CODE[kind] : Store.None;
      this.dirty.add(i);
      changed = true;
    }
    if (changed) this.rebuildStores();
    if (changed && on) this.tip(kind === 'boxes' ? 'yards' : 'storage');
    if (net !== 0) this.moneyAt(net, tiles[tiles.length - 1]);
    else if (firstError) this.message(firstError, 'bad');
  }

  /**
   * Gather the storage marked out on the map into areas, one for each run of
   * touching tiles of a kind, keeping what they held: each area's goods are
   * set down a tile's worth at a time and picked up again by the new areas.
   * Whatever was on a tile no longer marked out is lost.
   */
  private rebuildStores(): void {
    const m = this.map;
    // Any container on a gantry's spreader goes down first, with the rest.
    for (const y of this.yards.values()) this.settleGantry(y);
    const old = [...this.bays.values(), ...this.yards.values()].filter((b) => b.tiles);
    const held = new Map<number, number[]>();
    const ready = new Map<number, number[]>();
    const lost = { crates: 0, boxes: 0 };
    for (const a of old) {
      const goods = a.yard ? a.boxes : a.crates;
      const clear = a.yard ? this.readyList(a) : [];
      const per = a.yard ? B.BOXES_PER_STORE_TILE : B.CRATES_PER_STORE_TILE;
      const tiles = a.tiles!;
      tiles.forEach((t, k) => {
        const last = k === tiles.length - 1;
        held.set(t, goods.slice(k * per, last ? undefined : (k + 1) * per));
        ready.set(t, clear.slice(k * per, last ? undefined : (k + 1) * per));
      });
      lost[a.yard ? 'boxes' : 'crates'] += goods.length;
      (a.yard ? this.yards : this.bays).delete(a.idx);
    }
    this.spotCache.clear();
    this.laneCache = null;
    this.railCache = null;
    this.laneOfCache.clear();
    this.yardLaneCache = null;
    this.gantryCache = null;
    this.storeOf.fill(-1);
    for (let i = 0; i < m.store.length; i++) {
      const kind = m.store[i];
      if (!kind || this.storeOf[i] >= 0) continue;
      const tiles: number[] = [];
      const stack = [i];
      this.storeOf[i] = i;
      while (stack.length > 0) {
        const t = stack.pop()!;
        tiles.push(t);
        for (const n of m.neighbors4(t)) {
          if (m.store[n] !== kind || this.storeOf[n] >= 0) continue;
          this.storeOf[n] = i;
          stack.push(n);
        }
      }
      tiles.sort((a, b) => a - b);
      const yard = storesBoxes(kind);
      const area: Bay = {
        idx: i,
        large: !yard,
        warehouse: !yard,
        yard,
        outgoing: storesOutgoing(kind),
        tiles,
        boxes: [],
        boxIncoming: 0,
        crates: [],
        incoming: 0,
        nextTruckTick: 0,
        noAccess: false,
      };
      const goods = tiles.flatMap((t) => held.get(t) ?? []).slice(0, bayCap(area));
      (yard ? area.boxes : area.crates).push(...goods);
      if (yard) {
        area.boxReady = tiles.flatMap((t) => ready.get(t) ?? []).slice(0, goods.length);
        // Joined up from areas stacked at different times: oldest first.
        const order = goods.map((_, k) => k).sort((x, y) => area.boxReady![x] - area.boxReady![y]);
        area.boxes = order.map((k) => goods[k]);
        area.boxReady = order.map((k) => area.boxReady![k]);
      }
      lost[yard ? 'boxes' : 'crates'] -= goods.length;
      (yard ? this.yards : this.bays).set(i, area);
    }
    // Loads on their way, and trucks loading, go to the area their old one became.
    const remap = new Map<number, number>();
    for (const a of old) {
      const code =
        STORE_CODE[
          a.yard ? (a.outgoing ? 'boxesOut' : 'boxes') : a.outgoing ? 'cratesOut' : 'crates'
        ];
      const t = a.tiles!.find((t) => m.store[t] === code);
      const now = t === undefined ? -1 : this.storeOf[t];
      remap.set(a.idx, now);
      const area = this.dest(now);
      if (area) {
        area.nextTruckTick = Math.max(area.nextTruckTick, a.nextTruckTick);
        area.noAccess ||= a.noAccess;
        // Joined with one shut, it stays shut.
        if (a.shut) area.shut = true;
      }
    }
    for (const p of this.people) {
      const now = remap.get(p.bayIdx);
      if (now !== undefined) p.bayIdx = now;
      const area = this.dest(p.bayIdx);
      if (area?.tiles && p.planned > 0) {
        // Exports on their way into storage by a crane, or cargo coming in.
        if (p.outbound) area.exportIncoming = (area.exportIncoming ?? 0) + p.planned;
        else bayIncoming(area, isBoxy(p), p.planned);
      }
      // And forklifts on their way to collect from storage.
      const from = remap.get(p.stockIdx);
      if (from !== undefined) p.stockIdx = from;
      const store = this.bays.get(p.stockIdx);
      if (store?.tiles && !p.carrying) store.reserved = (store.reserved ?? 0) + p.planned;
    }
    for (const t of this.trucks) t.bayIdx = remap.get(t.bayIdx) ?? t.bayIdx;
    // Exports go with the area their old one became, as far as there is room.
    for (const a of old) {
      const goods = a.exports ?? [];
      const area = this.dest(remap.get(a.idx) ?? -1);
      const room = area ? Math.max(0, bayRoom(area, !!a.yard)) : 0;
      if (area) (area.exports ??= []).push(...goods.slice(0, room));
      lost[a.yard ? 'boxes' : 'crates'] += Math.max(0, goods.length - room);
    }
    for (const t of this.trucks) {
      const area = this.dest(t.bayIdx);
      if (t.exports && t.state === 'toBay' && area?.tiles) {
        area.exportIncoming = (area.exportIncoming ?? 0) + t.cargo;
      }
    }
    for (const p of this.people) {
      const area = this.dest(p.stockIdx);
      if (p.outbound && !p.carrying && area?.tiles) {
        area.outReserved = (area.outReserved ?? 0) + p.planned;
      }
    }
    const what = [
      lost.crates > 0 && `${lost.crates} crate${lost.crates === 1 ? '' : 's'}`,
      lost.boxes > 0 && `${lost.boxes} container${lost.boxes === 1 ? '' : 's'}`,
    ].filter(Boolean);
    if (what.length > 0) {
      this.message(
        `${what.join(' and ')} stored there ${lost.crates + lost.boxes === 1 ? 'was' : 'were'} lost.`,
        'bad',
      );
    }
  }

  /**
   * Dredge or reclaim each tile a step. Like docks, a channel dug inland
   * from the shore fits in one drag, in as many rounds as it takes.
   */
  private terraform(tiles: number[], raise: boolean): void {
    if (this.tier < B.TERRAFORM_TIER) {
      const what = raise ? 'Land reclamation' : 'Dredging';
      return this.message(`${what} unlocks at the ${TIERS[B.TERRAFORM_TIER].name}.`, 'bad');
    }
    const m = this.map;
    let spent = 0;
    let firstError: string | null = null;
    const done = new Set<number>();
    let left = tiles.filter((i) => i >= 0 && i < m.build.length);
    let broke = false;
    for (let progress = true; progress && !broke && left.length > 0;) {
      progress = false;
      firstError = null;
      const skipped: number[] = [];
      for (const i of left) {
        const cx = m.xOf(i) + 0.5;
        const cy = m.yOf(i) + 0.5;
        const err =
          terraformError(m, i, raise, done) ??
          (this.boats.some((b) => Math.hypot(b.x - cx, b.y - cy) < 1.5)
            ? 'A boat is in the way'
            : null);
        if (err) {
          firstError ??= err;
          skipped.push(i);
          continue;
        }
        const cost = terraformCost(m, i, raise);
        if (cost > this.cash) {
          firstError = 'Not enough money';
          broke = true;
          break;
        }
        this.book('construction', -cost);
        spent += cost;
        terraform(m, i, raise);
        done.add(i);
        this.dirty.add(i);
        progress = true;
      }
      left = skipped;
    }
    if (done.size > 0) {
      for (const i of reflood(m)) this.dirty.add(i);
      this.dockCache = null;
      this.capacityCache = null;
    }
    if (spent > 0) this.moneyAt(-spent, tiles[tiles.length - 1]);
    else if (firstError) this.message(firstError, 'bad');
  }

  private bulldoze(tiles: number[]): void {
    // Ground a gantry crane taken down kept for machines, to give back.
    const freed: number[] = [];
    let net = 0;
    let lastError: string | null = null;
    let stores = false;
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
      if (isHighway(this.map.build[i])) {
        // Closing an exit: the barrier down the middle goes back across.
        setExit(this.map, this.map.yOf(i), false);
        for (let x = 0; x < HIGHWAY_COLUMNS; x++) this.dirty.add(this.map.idx(x, this.map.yOf(i)));
        continue;
      }
      if (this.map.build[i] === Build.Gantry) {
        this.cranes.delete(i);
        freed.push(...gantryGround(this.map, i, this.map.orient[i] & 3));
      }
      if (this.map.build[i] === Build.JibCrane || this.map.build[i] === Build.HarbourCrane) {
        // Taking down a crane leaves the quay it stood on.
        this.cranes.delete(i);
        this.map.build[i] = Build.Quay;
      } else if (this.map.build[i] === Build.Crossing) {
        // Taking up a level crossing leaves the line.
        this.map.build[i] = Build.Rail;
      } else if (this.map.build[i] !== Build.None) {
        if (isBay(this.map.build[i])) this.removeBay(i);
        this.removePile(i);
        for (const b of bulldozeTiles(this.map, i)) {
          this.map.build[b] = this.map.orient[b] & ON_QUAY ? Build.Quay : Build.None;
          this.map.orient[b] = 0;
          if (this.map.store[b]) {
            this.map.store[b] = Store.None;
            stores = true;
          }
          this.dirty.add(b);
        }
      } else if (this.map.deco[i] !== Deco.None) {
        this.map.deco[i] = Deco.None;
      } else {
        this.map.terrain[i] = Terrain.Grass;
      }
      this.dirty.add(i);
    }
    if (stores) this.rebuildStores();
    // What no other gantry crane's rails still need goes back to everyone.
    for (const t of freed) {
      if (!forkliftOnly(this.map, t) || gantryOver(this.map, t, true) >= 0) continue;
      this.map.orient[t] &= ~FORKLIFT_ONLY;
      this.dirty.add(t);
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

  /** People in the town: the port may grow a step once there are enough of them. */
  private townSize(): number {
    return this.town ? population(this.town, this.map) : 0;
  }

  /** Tell the player, once, when the town has grown enough for the next step up. */
  private townGrownEnough(): void {
    const next = TIERS[this.tier + 1];
    if (!next || next.comingSoon || this.townSize() < next.town) return;
    if (this.tierReadyTold >= this.tier + 1) return;
    this.tierReadyTold = this.tier + 1;
    const name = this.town?.name ?? 'The town';
    this.message(
      `${name} has grown to ${this.townSize().toLocaleString('en-US')} people: the harbour authority will let the port become a ${next.name}. See the Port panel (P).`,
      'good',
    );
  }

  canUpgrade(): boolean {
    const next = TIERS[this.tier + 1];
    if (!next || next.comingSoon) return false;
    return this.townSize() >= next.town && this.cash >= next.cost;
  }

  private upgrade(): void {
    const next = TIERS[this.tier + 1];
    if (!next || next.comingSoon) return this.message('No further upgrades yet.', 'info');
    if (this.townSize() < next.town) {
      return this.message(
        `The harbour authority waits for the town to grow: ${next.name} needs ${next.town.toLocaleString('en-US')} people in town, it has ${this.townSize().toLocaleString('en-US')}.`,
        'bad',
      );
    }
    if (this.cash < next.cost) {
      return this.message(
        `Not enough cash for the harbour authority's fee of $${next.cost.toLocaleString('en-US')}.`,
        'bad',
      );
    }
    this.book('construction', -next.cost);
    this.tier++;
    this.capacityCache = null;
    this.message(
      `The port is now a ${next.name}! New buildings and machines are unlocked.`,
      'good',
    );
    this.tip(`tier${this.tier}`);
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
    const offer = makeOffer(
      this.rng,
      this.nextId++,
      this.tick,
      kind,
      taken,
      this.tier,
      this.stats.containers,
    );
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
      // Shippers come with the Coastal Wharf: before it, the same draws as ever.
      const pick = (): Terms['kind'] => {
        const roll = this.rng.next();
        if (this.tier < 1) return roll < 0.6 ? 'fishery' : 'haulier';
        return roll < 0.5 ? 'fishery' : roll < 0.8 ? 'haulier' : 'shipper';
      };
      const kind: Terms['kind'] = !has('haulier')
        ? 'haulier'
        : !has('fishery')
          ? 'fishery'
          : this.tier >= 1 && !has('shipper')
            ? 'shipper'
            : pick();
      const before = this.offers.length;
      this.addOffer(kind);
      // Nobody of that kind wants to deal: maybe the other kind does.
      if (this.offers.length === before) this.addOffer(kind === 'haulier' ? 'fishery' : 'haulier');
      // The Contracts button counts the offers: only an empty board is news.
      if (before === 0 && this.offers.length > 0) {
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
    this.firstBoat.add(offer.terms.name);
    this.tipsSeen.add('contract');
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

  private shippers(): (Contract & { terms: ShipperTerms })[] {
    return this.contracts.filter((c) => c.terms.kind === 'shipper') as (Contract & {
      terms: ShipperTerms;
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

  /**
   * How a boat's visit moves its line's goodwill, were it to sail now: up
   * for coming and going, down for each while it waited at anchor or took
   * longer alongside than the line allows.
   */
  private visitMood(b: Boat): number {
    const slowTicks = Math.max(0, b.mooredTicks - b.grace);
    return (
      B.SATISFACTION_PER_BOAT -
      b.anchorTicks / B.ANCHOR_PENALTY_TICKS -
      slowTicks / B.MOORED_PENALTY_TICKS
    );
  }

  /** A ship taking exports on board, unloaded, sent off now with those it has. */
  private canSail(b: Boat): boolean {
    return (
      b.state === 'moored' &&
      b.crates === 0 &&
      b.reserved === 0 &&
      outCap(b) > 0 &&
      b.loadedAt === undefined
    );
  }

  /**
   * Send a ship taking exports on board off with those it has: what the
   * cranes are lifting on board goes on, the rest waits for the next ship.
   */
  private sailNow(id: number): void {
    const b = this.boats.find((q) => q.id === id);
    if (!b || !this.canSail(b)) return;
    b.loadQuota = b.out ?? 0;
  }

  /** How a ship's visit is going, for its panel. */
  private visitView(b: Boat): BoatVisit {
    const t = this.tick;
    const c = this.contracts.find((x) => x.id === b.contractId);
    return {
      inPort: b.came !== undefined ? t - b.came : -1,
      anchored: b.anchorTicks,
      unloading: b.mooredAt !== undefined ? (b.unloadedAt ?? t) - b.mooredAt : -1,
      unloaded: b.unloadedAt !== undefined,
      loading: b.unloadedAt !== undefined ? (b.loadedAt ?? t) - b.unloadedAt : -1,
      loaded: b.loadedAt !== undefined,
      loads: outCap(b) > 0,
      out: b.out ?? 0,
      quota: b.loadQuota,
      allowed: Math.round(b.grace),
      worked: b.mooredTicks,
      mood: c && Math.round(c.satisfaction),
      moodChange: Math.round(this.visitMood(b) * 10) / 10,
      canSail: this.canSail(b),
      ...this.heldView(b),
    };
  }

  /** A ship coming in held up a while by one moored in its way: which, and how long so far. */
  private heldView(b: Boat): { heldBy?: string; heldFor?: number } {
    const o = b.waitingOn !== undefined && this.boats.find((q) => q.id === b.waitingOn);
    if (!o || b.state !== 'arriving' || (b.waitedFor ?? 0) <= B.BERTH_BLOCKED_TICKS) return {};
    const what =
      o.vessel === 'feeder' ? 'feeder ship' : o.vessel === 'coaster' ? 'coaster' : 'boat';
    return { heldBy: `the ${o.company} ${what}`, heldFor: b.waitedFor };
  }

  private judgeVisit(b: Boat, gaveUp: boolean): void {
    const slowTicks = Math.max(0, b.mooredTicks - b.grace);
    const demurrage = Math.round(
      ((b.anchorTicks + slowTicks) / TICKS_PER_DAY) * B.DEMURRAGE_PER_DAY,
    );
    if (demurrage > 0) {
      this.penalty(demurrage, this.tileOf(b));
      this.demurrageToday.amount += demurrage;
      this.demurrageToday.ships++;
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
    const delta = this.visitMood(b) - (gaveUp ? B.GAVE_UP_PENALTY : 0);
    // Good visits lift it to 100 at most; above that (set so by hand) it
    // only comes down.
    c.satisfaction = Math.max(0, Math.min(Math.max(100, c.satisfaction), c.satisfaction + delta));
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
    this.nag(
      'bays',
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
    const bays = [...this.bays.values()];
    let walk = 0;
    for (const j of jetties) {
      const d = Math.min(...bays.map((b) => this.distTo(j, b)));
      walk += Number.isFinite(d) ? d : 0;
    }
    const avgWalk = jetties.length && bays.length ? walk / jetties.length : 0;
    let hasHut = false;
    for (let i = 0; i < m.build.length && !hasHut; i++) hasHut = m.build[i] === Build.BreakHut;
    // Share of the day spent working rather than resting.
    const uptime = hasHut ? 0.88 : 0.72;
    // Dockhands carrying crates all the way to a bay, or setting them down on
    // the quay beside the boat for the forklifts.
    let carrying = 0;
    let landing = 0;
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
        carrying += (TICKS_PER_DAY * uptime) / tripTicks;
        landing += (TICKS_PER_DAY * uptime) / (handling + 2 / (B.WALK_SPEED * pace));
      }
    }
    // Jib cranes lift while a boat lies alongside, a good part of the day
    // going on boats coming and going, and those with crate storage in
    // reach stow it there and then.
    let lifting = 0;
    let stowing = 0;
    for (const c of this.cranes.values()) {
      if (c.kind !== 'jib' || !this.dockInUse(c.idx)) continue;
      const rate = (TICKS_PER_DAY / B.CRANE_TICKS) * 0.3;
      lifting += rate;
      if (this.jibStows(c)) stowing += rate;
    }
    // Off the boats and on to the bays: with forklifts about, dockhands land
    // the cargo and the forklifts take it on; without, dockhands carry it all
    // the way, and what the cranes stack too. Pallets always go by forklift.
    const forks = forklifting > 0;
    const off = (forks ? landing : carrying) + lifting;
    const on = forks ? forklifting + stowing : carrying + stowing;

    // One truck trip: highway to bay and back, plus loading. A bay loads one
    // truck at a time, so trucks beyond the number of bays add nothing.
    this.roadLen = Math.min(Infinity, ...[...this.bays.values()].map((b) => this.roadTo(b)));
    // Time lost in queues on narrow walkways comes straight off the top.
    const unloading = Math.min(off, on) * (1 - this.congestion);
    const palletDemand = this.fisheries()
      .filter((c) => c.terms.vessel === 'coaster')
      .reduce((n, c) => n + fisheryDailyCrates(c.terms), 0);
    this.capacityCache = {
      congestion: this.congestion,
      demand: Math.round(demand),
      unloading: Math.round(unloading),
      trucking: this.truckingWith(null),
      off: Math.round(off * (1 - this.congestion)),
      moved: Math.round(on * (1 - this.congestion)),
      deepBerths: this.berthCount(B.COASTER_DRAFT, true),
      pallets: {
        demand: Math.round(palletDemand),
        unloading: Math.round(
          Math.min(landing + lifting, forklifting + stowing) * (1 - this.congestion),
        ),
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
    const cranes = [...this.cranes.values()].filter((c) => c.kind !== 'jib');
    // A crane only works while a feeder is alongside; allow for gaps.
    const lifting = cranes.reduce((n, c) => n + (TICKS_PER_DAY / craneTicks(c)) * 0.6, 0);
    const yards = [...this.yards.values()];
    let walk = 0;
    for (const c of cranes) {
      const at = this.pickTile(c);
      walk += yards.length ? Math.min(...yards.map((y) => this.distTo(at, y))) : 0;
    }
    const avg = cranes.length && yards.length ? walk / cranes.length : 0;
    const stackers = this.people.filter((p) => p.kind === 'stacker').length;
    const trip = (2 * avg * 1.2) / B.STACKER_SPEED + (B.PICK_TICKS + B.DROP_TICKS) * 2.5;
    // Without a yard gantry the stackers also lift each container onto its
    // truck: a short trip from the stack to the road beside it, and handling.
    const bare = yards.length ? yards.filter((y) => !this.yardGantry(y)).length / yards.length : 0;
    const loading = (2 * 1.5 * 1.2) / B.STACKER_SPEED + (B.PICK_TICKS + B.DROP_TICKS) * 2.5;
    // Terminal tractors only work yards with a gantry, which lifts for them.
    const tractors = yards.some((y) => this.yardGantry(y))
      ? this.people.filter((p) => p.kind === 'tractor').length
      : 0;
    const haul = (2 * avg * 1.2) / B.TRACTOR_SPEED + B.PICK_TICKS + B.YARD_GANTRY_TICKS;
    const moving =
      avg > 0
        ? stackers * ((TICKS_PER_DAY * 0.85) / (trip + bare * loading)) +
          tractors * ((TICKS_PER_DAY * 0.85) / haul)
        : 0;
    let trucking = 0;
    // Trucks load beside the yards, one at a time at each spot, while the
    // others are away on their rounds.
    const road = Math.min(Infinity, ...yards.map((y) => this.roadTo(y)));
    if (Number.isFinite(road)) {
      const carried = this.hauliers()
        .filter((h) => h.terms.cargo === 'container')
        .reduce(
          (n, h) => n + h.terms.fleet * this.truckRate(h.terms.capacity, road, B.YARD_LOAD_TICKS),
          0,
        );
      const docks = yards.reduce((n, y) => n + this.loadingDocks(y).length, 0);
      const loaded = (docks * TICKS_PER_DAY) / (B.YARD_LOAD_TICKS + 15);
      trucking = Math.min(carried, loaded);
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
    // Each dock loads one truck at a time, while the others are away on
    // their rounds; big trucks only fit large bays and storage. So the most
    // the trucks can carry, or the docks load, whichever is less.
    const docks = [...this.bays.values()].flatMap((b) =>
      this.loadingDocks(b).map(() => ({ large: b.large, load: loadTicks(b) })),
    );
    if (docks.length === 0) return 0;
    const large = docks.some((d) => d.large);
    const load = docks.reduce((n, d) => n + d.load, 0) / docks.length;
    let carried = 0;
    for (const t of terms) {
      if (t.capacity > B.TRUCK_CAPACITY && !large) continue;
      carried += t.fleet * this.truckRate(t.capacity, this.roadLen, load);
    }
    const loaded = docks.reduce((n, d) => n + this.dockRate(d.load), 0);
    return Math.round(Math.min(carried, loaded));
  }

  /** What one truck carries a day: in from the highway, loading, back out, then its round. */
  private truckRate(capacity: number, road: number, load: number): number {
    const ticks = (2 * road) / B.TRUCK_SPEED + capacity * load + 30 + B.TRUCK_ROUND_TRIP;
    return (capacity * TICKS_PER_DAY) / ticks;
  }

  /** What one loading dock puts on trucks a day, kept busy, with time to pull in and out. */
  private dockRate(load: number): number {
    return (B.TRUCK_CAPACITY * TICKS_PER_DAY) / (B.TRUCK_CAPACITY * load + 30);
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
    this.noteTiles();
    if (this.tick % TICKS_PER_DAY === 0) this.newDay();
    // The cargo counts, ten times a day for a week, for the statistics charts.
    if (this.tick % CARGO_EVERY === 0) {
      this.cargoLog.push({ tick: this.tick, cargo: this.cargoStats() });
      if (this.cargoLog.length > CARGO_SAMPLES) this.cargoLog.shift();
    }
    this.spawnBoats();
    for (const b of [...this.boats]) this.updateBoat(b);
    this.updateTugs();
    for (const c of this.cranes.values()) this.updateCrane(c);
    this.countOccupancy();
    for (const p of this.people) this.updateDockhand(p);
    if (this.tick % 10 === 0) this.spawnTrucks();
    if (this.tick % 10 === 5) this.spawnShipments();
    for (const t of [...this.trucks]) this.updateTruck(t);
    for (const y of this.yards.values()) if (y.gantryHeld && this.liftDone(y)) this.settleGantry(y);
    stepRail(this.rail, this.scenery, this.tick, this.map.h, this.town?.stage ?? 0);
    if (this.town && this.tick % B.TOWN_BUILD_TICKS === 0) this.buildTown(this.town);
  }

  // ── The town ──────────────────────────────────────────────

  /** The town's builders keep up with the people moving in. */
  private buildTown(t: Town): void {
    if (townHomes(this.map) < t.demand) {
      const built = growTown(t, this.map, (i) => this.dirty.add(i));
      // A new street can join up roads.
      if (built) this.gateCache = null;
    }
    const stage = townStageUp(t, this.map);
    if (stage) {
      const a = /^[aeiou]/i.test(stage) ? 'an' : 'a';
      this.message(`${t.name} has grown into ${a} ${stage.toLowerCase()}.`, 'good');
    }
  }

  private businessViews(): TownView['businesses'] {
    const out = new Map<number, TownView['businesses'][number]>();
    for (const code of this.map.build) {
      const def = BUSINESSES[code];
      if (!def) continue;
      const v = out.get(code) ?? { label: def.label, count: 0, boxes: def.boxes, perDay: 0 };
      v.count++;
      v.perDay += def.perDay;
      out.set(code, v);
    }
    return [...out.values()];
  }

  /** People working at the port and driving for its hauliers. */
  private jobs(): number {
    return this.people.length + this.hauliers().reduce((n, h) => n + h.terms.fleet, 0);
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
    // Containers in transit from a ship are stacked within the day.
    for (const [id, at] of this.unloadedAt) {
      if (this.tick - at > TICKS_PER_DAY * 3) this.unloadedAt.delete(id);
    }
    if (this.town) townDay(this.town, this.jobs(), this.map);
    this.townGrownEnough();
    const late = this.demurrageToday;
    this.demurrageToday = { amount: 0, ships: 0 };
    if (late.amount >= B.DEMURRAGE_NOTICE) {
      this.nag(
        'demurrage',
        `Ships kept waiting cost $${late.amount.toLocaleString('en-US')} in demurrage today, from ${late.ships} ship${late.ships === 1 ? '' : 's'}.`,
        'bad',
      );
    }
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
      const cost =
        c.kind === 'gantry'
          ? B.GANTRY_RUNNING_COST
          : c.kind === 'harbour'
            ? B.HARBOUR_CRANE_RUNNING_COST
            : B.CRANE_RUNNING_COST;
      this.book('maintenance', -cost);
    }
    this.book('maintenance', -B.TUG_RUNNING_COST * this.tugs.length);
    const yardGantries = this.map.build.filter((c) => c === Build.YardGantry).length;
    this.book('maintenance', -B.YARD_GANTRY_RUNNING_COST * yardGantries);
    for (const p of this.people) {
      if (isMachine(p) && this.rng.next() < B.FORKLIFT_BREAKDOWN) p.needsRepair = true;
    }
    this.book('interest', -this.interestDue());
    // The day done, kept for the finance charts: two months of them.
    this.history.push({ tick: this.tick, cash: this.cash, ledger: this.today });
    if (this.history.length > FINANCE_DAYS) this.history.shift();
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
    // Boats come in from out beyond the outermost pair of green buoys, if
    // any of the open sea lies out there.
    const gate = buoyGates(this.map, false).find((g) => g.b >= 0);
    const m = this.map;
    const beyond = gate
      ? edge.filter((i) => this.gateSide(gate.a, gate.b, m.xOf(i) + 0.5, m.yOf(i) + 0.5) > 0)
      : [];
    const start = this.rng.pick(beyond.length > 0 ? beyond : edge);
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
      // Containers are all alike; a crate holds the catch.
      fee: terms.vessel === 'feeder' ? terms.fee : withCargo(terms.fee, terms.catch ?? 'fish'),
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
      came: this.tick,
    };
    boat.grace = B.MOORED_GRACE_TICKS + boat.crates * B.MOORED_TICKS_PER_CRATE;
    this.boats.push(boat);
    this.stats.boats++;
    // The first boat of the game is already coming in, a few tiles off the
    // jetty, and heads straight for a berth.
    if (close) {
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
    const path = this.route(boat, from, spot, this.boatCostFor(boat.draft));
    if (path) {
      // Its way from the edge of the map is long on the open sea: it comes
      // into sight only the last of it out.
      const at = this.inSight(boat, path);
      if (at > 0) {
        boat.x = this.map.xOf(path[at - 1]) + 0.5;
        boat.y = this.map.yOf(path[at - 1]) + 0.5;
      }
      boat.path = path.slice(at);
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
   * Where a boat goes by the buoys on its way from `from` to `to`, in order.
   * Coming in, the green ones between the two, furthest from the docks
   * first; going out, the red ones further out than it is, nearest first.
   * Between a pair it crosses the line joining them, in a lane of its own
   * and well clear of both; a lone buoy it passes close by.
   */
  private buoyStops(b: Boat, from: number, to: number, cost: CostFn): number[] {
    const m = this.map;
    const c = harbourCentre(m);
    const d = (i: number) => Math.hypot(m.xOf(i) + 0.5 - c.x, m.yOf(i) + 0.5 - c.y);
    const out = b.state === 'leaving';
    const here = d(from);
    const there = to >= 0 ? d(to) : 0;
    const stops: number[] = [];
    let at = from;
    for (const g of buoyGates(m, out)) {
      const far = g.b < 0 ? d(g.a) : (d(g.a) + d(g.b)) / 2;
      if (out ? far <= here + 0.5 : far >= here - 0.5 || far <= there + 0.5) continue;
      // A pair is crossed one way only, in from the sea or out to it. A
      // boat already on the far side has nothing to cross, rather than
      // going all the way round to come at it the right way.
      const side = g.b < 0 ? 0 : this.gateSide(g.a, g.b, m.xOf(at) + 0.5, m.yOf(at) + 0.5);
      if (out ? side > 0 : side < 0) continue;
      const way = g.b < 0 ? [g.a] : this.crossing(b, g.a, g.b, out, cost);
      stops.push(...way);
      at = way.at(-1) ?? at;
    }
    return stops;
  }

  /**
   * Which side of the line between buoys `a` and `b` x, y lies on: above
   * zero on the side away from the docks, below on the side towards them.
   */
  private gateSide(a: number, b: number, x: number, y: number): number {
    const m = this.map;
    const c = harbourCentre(m);
    const ax = m.xOf(a) + 0.5;
    const ay = m.yOf(a) + 0.5;
    const ux = m.xOf(b) + 0.5 - ax;
    const uy = m.yOf(b) + 0.5 - ay;
    const side = (px: number, py: number) => -uy * (px - ax) + ux * (py - ay);
    const docks = side(c.x, c.y);
    return docks === 0 ? 0 : -Math.sign(docks) * side(x, y);
  }

  /**
   * Where a boat crosses between buoys `a` and `b`: a tile short of the
   * line, one on it and one beyond, so it comes square across rather than
   * running along the line. None if there is no room.
   */
  private crossing(boat: Boat, a: number, b: number, out: boolean, cost: CostFn): number[] {
    const m = this.map;
    const ax = m.xOf(a) + 0.5;
    const ay = m.yOf(a) + 0.5;
    const len = Math.hypot(m.xOf(b) + 0.5 - ax, m.yOf(b) + 0.5 - ay);
    const ux = (m.xOf(b) + 0.5 - ax) / len;
    const uy = (m.yOf(b) + 0.5 - ay) / len;
    const room = B.GATE_CLEARANCE + B.VESSELS[boat.vessel].beam / 2 + 0.5;
    if (len < room * 2) return [];
    // Across the line, the way the boat is going: out from the docks or in.
    const c = harbourCentre(m);
    const outwards = -uy * (ax - c.x) + ux * (ay - c.y) > 0 ? 1 : -1;
    const nx = -uy * outwards * (out ? 1 : -1);
    const ny = ux * outwards * (out ? 1 : -1);
    const tile = (t: number, n: number) =>
      m.idx(Math.floor(ax + ux * t + nx * n), Math.floor(ay + uy * t + ny * n));
    // Each boat has a lane of its own across the middle of the gap.
    const lane = ((boat.id * 7) % 9) / 8 - 0.5;
    const want = len / 2 + lane * (len - room * 2) * 0.8;
    // The nearest place along the line to there that the boat can sail across.
    for (let off = 0; off <= len; off += 0.5) {
      for (const t of [want - off, want + off]) {
        if (t < room || t > len - room) continue;
        const way = [tile(t, -1.5), tile(t, 0), tile(t, 1.5)];
        if (way.every((i) => cost(i) === 1)) return way;
      }
    }
    return [];
  }

  /** Tiles within two of a buoy, which routes keep off. Not saved. */
  private nearBuoy(): Uint8Array {
    if (this.buoyCache) return this.buoyCache;
    const m = this.map;
    const near = new Uint8Array(m.build.length);
    for (let i = 0; i < m.build.length; i++) {
      if (!isBuoy(m.build[i])) continue;
      const x = m.xOf(i);
      const y = m.yOf(i);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (m.inBounds(x + dx, y + dy)) near[m.idx(x + dx, y + dy)] = 1;
        }
      }
    }
    this.buoyCache = near;
    return near;
  }

  /**
   * Tiles on the lines between pairs of buoys, the green ones or the red,
   * which boats coming in or going out must not cut past. Not saved.
   */
  private gateLines(out: boolean): Set<number> {
    if (this.gateCache) return this.gateCache[out ? 1 : 0];
    const m = this.map;
    const lines = [false, true].map((out) => {
      const tiles = new Set<number>();
      for (const g of buoyGates(m, out)) {
        if (g.b < 0) continue;
        const ax = m.xOf(g.a) + 0.5;
        const ay = m.yOf(g.a) + 0.5;
        const ux = m.xOf(g.b) + 0.5 - ax;
        const uy = m.yOf(g.b) + 0.5 - ay;
        const n = Math.ceil(Math.hypot(ux, uy) * 4);
        for (let k = 1; k < n; k++) {
          const i = m.idx(Math.floor(ax + (ux * k) / n), Math.floor(ay + (uy * k) / n));
          if (!isBuoy(m.build[i])) tiles.add(i);
        }
      }
      return tiles;
    });
    this.gateCache = lines;
    return lines[out ? 1 : 0];
  }

  /** A route through each of `stops` in turn; any it cannot reach it leaves out. */
  private via(from: number, stops: number[], to: number, cost: CostFn): number[] | null {
    const m = this.map;
    const path: number[] = [];
    let at = from;
    for (const s of stops) {
      const leg = findPath(m.w, m.h, at, s, cost, true);
      if (!leg) continue;
      path.push(...leg);
      at = s;
    }
    const last = findPath(m.w, m.h, at, to, cost, true);
    if (last) return [...path, ...last];
    return stops.length > 0 ? findPath(m.w, m.h, from, to, cost, true) : null;
  }

  /** A route for this boat from `from` to `to`, by way of the buoys it should pass. */
  private route(b: Boat, from: number, to: number, cost: CostFn): number[] | null {
    return this.via(from, this.buoyStops(b, from, to, cost), to, this.byDocks(cost, from, to));
  }

  /**
   * Routes keep out of the water in front of other docks, where boats come
   * alongside and pull out: past them further out, not across it. The docks
   * at either end of the route are free to use.
   */
  private byDocks(cost: CostFn, from: number, to: number): CostFn {
    const front = this.dockFront();
    const own = [front[from], front[to]];
    return (i) =>
      front[i] >= 0 && !own.includes(front[i]) ? cost(i) * B.DOCK_FRONT_COST : cost(i);
  }

  /**
   * For water within a few tiles of a jetty or quay, the dock it lies off
   * (its key, see dockKey); -1 elsewhere. Not saved.
   */
  private dockFront(): Int32Array {
    if (this.frontCache) return this.frontCache;
    this.docks();
    const m = this.map;
    const front = new Int32Array(m.build.length).fill(-1);
    const near = new Float32Array(m.build.length).fill(Infinity);
    const r = B.DOCK_FRONT_RANGE;
    for (const [i, key] of this.dockKey) {
      const x = m.xOf(i);
      const y = m.yOf(i);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const d = Math.hypot(dx, dy);
          if (d > r || !m.inBounds(x + dx, y + dy)) continue;
          const j = m.idx(x + dx, y + dy);
          if (m.ocean[j] && d < near[j]) {
            near[j] = d;
            front[j] = key;
          }
        }
      }
    }
    this.frontCache = front;
    return front;
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
    x += 9;
    // Out beyond the water off the furthest dock, too.
    for (let i = 0; i < m.build.length; i++) {
      if (isDock(m.build[i])) x = Math.max(x, m.xOf(i) + B.DOCK_FRONT_RANGE + 2);
    }
    x = Math.min(x, m.w - 8);
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
    const south = Math.min(m.limit - 5, row + 10);
    this.anchorageTile = m.idx(x, open(north) >= open(south) ? north : south);
    return this.anchorageTile;
  }

  /**
   * Whether a long ship coming in is pointing away from where its way goes
   * on, still a ship's length or more off its berth, not just waiting on
   * others. A small boat turns on the spot.
   */
  private cannotTurn(b: Boat): boolean {
    const m = this.map;
    if (B.VESSELS[b.vessel].length < B.CAREFUL_LENGTH) return false;
    const next = b.path[0];
    if (next === undefined || this.roomWait.has(b) || b.yieldFor !== undefined) return false;
    // Lining up alongside, swinging round slowly, is not being stuck.
    if (b.berthing === 'align' || b.berthing === 'line' || b.berthing === 'out') return false;
    const far =
      Math.hypot(m.xOf(b.berth) + 0.5 - b.x, m.yOf(b.berth) + 0.5 - b.y) >
      B.VESSELS[b.vessel].length;
    const course = Math.atan2(m.yOf(next) + 0.5 - b.y, m.xOf(next) + 0.5 - b.x);
    return far && Math.cos(course - b.dir) < 0;
  }

  /**
   * A boat coming in that has given up its berth sails back out to the
   * anchorage, to wait its turn again: it keeps the time it has waited, so
   * it is called in first.
   */
  private backToSea(b: Boat): void {
    this.freeFairway(b);
    b.berth = b.jetty = -1;
    b.lineup = b.lineEnd = b.berthing = undefined;
    b.plan = undefined;
    b.waitingOn = undefined;
    b.waitedFor = 0;
    b.stall = 0;
    b.held = 0;
    b.best = Infinity;
    const spot = this.anchorSpot(b);
    const path = this.route(b, this.tileOf(b), spot, this.boatCostFor(b.draft));
    if (!path) {
      b.state = 'anchored';
      b.speed = 0;
      return;
    }
    b.path = path;
    b.goal = spot;
    b.state = 'approaching';
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
    const front = this.dockFront();
    // A long ship needs open water to come round in when it is called in,
    // so it anchors out to sea of the anchorage, furthest out first, never
    // in towards the docks.
    const seaward = B.VESSELS[boat.vessel].length >= B.CAREFUL_LENGTH;
    for (let r = 0; r < 14; r++) {
      const ring: [number, number][] = [];
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = seaward ? -1 : -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push([cx + dx * 2, cy + dy]);
        }
      }
      if (seaward) ring.sort((p, q) => q[0] - p[0]);
      for (const [x, y] of ring) {
        if (!m.inBounds(x, y)) continue;
        // Stay out of the fairway in front of the harbour, and out of the
        // water off the docks that ships manoeuvre in.
        if (Math.abs(y - row) < 6) continue;
        const i = m.idx(x, y);
        if (this.boatCostFor(boat.draft)(i) !== 1 || front[i] >= 0) continue;
        const clear = taken.every((t) => Math.hypot(m.xOf(t.at) - x, m.yOf(t.at) - y) > t.room);
        if (clear && this.swingRoom(boat, x + 0.5, y + 0.5)) return i;
      }
    }
    return centre;
  }

  /** Open water, nothing built, all within `r` tiles of x, y. */
  private openAround(x: number, y: number, r: number): boolean {
    const m = this.map;
    for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++) {
      for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
        if (Math.hypot(tx + 0.5 - x, ty + 0.5 - y) > r + 0.5 || !m.inBounds(tx, ty)) continue;
        const i = m.idx(tx, ty);
        if (m.isLand(i) || (m.build[i] !== Build.None && !isBuoy(m.build[i]))) return false;
      }
    }
    return true;
  }

  /**
   * Whether a boat can lie at anchor here and swing round it: a small boat
   * clear of the shore; a long ship coming round under way to head off
   * anywhere too, so open water all round, a whole ship's length each way,
   * clear of moored boats.
   */
  private swingRoom(boat: Boat, x: number, y: number): boolean {
    const v = B.VESSELS[boat.vessel];
    // A small boat swings round on its anchor clear of the shore.
    if (v.length < B.CAREFUL_LENGTH) return this.openAround(x, y, v.length / 2 + 0.5);
    const r = v.length;
    if (!this.openAround(x, y, r)) return false;
    return this.boats.every(
      (o) =>
        o === boat ||
        o.state !== 'moored' ||
        Math.hypot(o.x - x, o.y - y) > r + B.VESSELS[o.vessel].length / 2,
    );
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
    // Off the port's own coast, not the country's past it.
    for (let y = 1; y < this.map.limit - 1; y++) {
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
      // Boats give buoys a wide berth, unless making for one.
      fn = (i) =>
        !this.map.ocean[i] || this.map.depth[i] < draft
          ? Infinity
          : this.map.build[i] === Build.None
            ? this.nearBuoy()[i]
              ? B.BUOY_DETOUR / 2
              : 1
            : isBuoy(this.map.build[i])
              ? B.BUOY_DETOUR
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
   * Two boats moored at these berths would lie too close: each hull keeps
   * BERTH_END_GAP of clear water off its bow and its stern, so boats lying
   * end to end in one lane have room between them.
   */
  private berthsClash(a: Moorage, b: Moorage): boolean {
    const m = this.map;
    const extent = (q: Moorage) => {
      const v = B.VESSELS[q.vessel];
      const along = v.length / 2 + B.BERTH_END_GAP / 2;
      // Lying along the dock: along x when the jetty is in another row.
      return m.yOf(q.jetty) !== m.yOf(q.berth) ? [along, v.beam / 2] : [v.beam / 2, along];
    };
    const [ax, ay] = extent(a);
    const [bx, by] = extent(b);
    return (
      Math.abs(m.xOf(a.berth) - m.xOf(b.berth)) < ax + bx - 1e-6 &&
      Math.abs(m.yOf(a.berth) - m.yOf(b.berth)) < ay + by - 1e-6
    );
  }

  /** The vessel berths are counted and handed out for. */
  private vesselFor(wide: boolean, needCrane: boolean): Vessel {
    return needCrane ? 'feeder' : wide ? 'coaster' : 'smack';
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
    let huts = 0;
    for (const b of m.build) {
      if (b === Build.Office) offices++;
      else if (b === Build.HarbourHut) huts++;
    }
    groups.slice(0, offices * B.DOCKS_PER_OFFICE).forEach((g) => (g.coordinated = true));
    // Jetties the offices leave: a few run on their own while there is no
    // office, and each harbourmaster's hut looks after a few more.
    groups
      .filter((g) => !g.quay && !g.coordinated)
      .slice(0, huts * B.JETTIES_PER_HUT + (offices > 0 ? 0 : B.FREE_DOCKS))
      .forEach((g) => (g.coordinated = true));
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

  /** A jib crane stands over this berth. */
  private jibAt(berth: number): boolean {
    const m = this.map;
    return [...this.cranes.values()].some(
      (c) =>
        c.kind === 'jib' &&
        Math.max(Math.abs(m.xOf(c.idx) - m.xOf(berth)), Math.abs(m.yOf(c.idx) - m.yOf(berth))) <= 1,
    );
  }

  /** A harbour or gantry crane stands over this berth. */
  private harbourCraneReaches(berth: number): boolean {
    for (const c of this.cranes.values()) {
      if (c.kind !== 'jib' && this.craneFront(c).some((t) => this.near(t, berth))) return true;
    }
    return false;
  }

  /** Whether a container crane stands at this dock tile, at the quay edge a ship lies against. */
  private craneAgainst(j: number): boolean {
    for (const c of this.cranes.values()) {
      if (c.kind !== 'jib' && this.craneFront(c).includes(j)) return true;
    }
    return false;
  }

  /** Whether a gantry crane works this berth. */
  private gantryReaches(berth: number): boolean {
    for (const c of this.cranes.values()) {
      if (c.kind === 'gantry' && this.craneFront(c).some((t) => this.near(t, berth))) return true;
    }
    return false;
  }

  /** Within a tile of each other, diagonals too. */
  private near(a: number, b: number): boolean {
    const m = this.map;
    return Math.max(Math.abs(m.xOf(a) - m.xOf(b)), Math.abs(m.yOf(a) - m.yOf(b))) <= 1;
  }

  /** The quay-edge tiles a crane reaches out over the water from. */
  private craneFront(c: Crane): number[] {
    if (c.kind !== 'gantry') return [c.idx];
    return footprint(this.map, 'gantryCrane', c.idx, this.map.orient[c.idx]).slice(0, 2);
  }

  /**
   * Where a load is collected from a crane: its landing stack, or for a
   * gantry the bay between its back legs.
   */
  private pickTile(c: Crane): number {
    if (c.kind !== 'gantry') return c.idx;
    return footprint(this.map, 'gantryCrane', c.idx, this.map.orient[c.idx])[2];
  }

  berthCount(draft: number, wide = false, needCrane = false): number {
    const m = this.map;
    const water = this.boatCostFor(draft);
    const vessel = this.vesselFor(wide, needCrane);
    const chosen: Moorage[] = [];
    for (let j = 0; j < m.build.length; j++) {
      if (!this.dockInUse(j)) continue;
      for (const n of m.neighbors4(j)) {
        if (water(n) !== 1) continue;
        if (wide && !this.wideQuay(j, n)) continue;
        if (needCrane !== this.harbourCraneReaches(n)) continue;
        if (!needCrane && !walkableAt(m, j) && !this.jibAt(n)) continue;
        const here = { berth: n, jetty: j, vessel };
        if (!this.footprint(n, j, this.boatHalf(needCrane))) continue;
        if (!chosen.some((c) => this.berthsClash(here, c))) chosen.push(here);
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
    const vessel = this.vesselFor(wide, needCrane);
    const taken = this.boats.filter((b) => b.berth >= 0);
    const out: { berth: number; jetty: number; d: number; craned: boolean }[] = [];
    // With nobody to unload by hand, boats wait for a berth under a jib crane.
    let cranes = false;
    const forks = this.forklifts();
    for (let j = 0; j < m.build.length; j++) {
      if (!this.dockInUse(j)) continue;
      for (const n of m.neighbors4(j)) {
        if (water(n) !== 1) continue;
        if (wide && !this.wideQuay(j, n)) continue;
        // Berths under a harbour crane are kept for container ships, which
        // lie square in front of the crane, centred on it.
        if (needCrane ? !this.craneAgainst(j) : this.harbourCraneReaches(n)) continue;
        if (!this.footprint(n, j, this.boatHalf(needCrane))) continue;
        const nx = m.xOf(n);
        const ny = m.yOf(n);
        // A crane is only any use with forklifts to take what it lands, or
        // storage it can swing it into: dockhands keep away from cranes.
        // Lying square under the jib crane, centred on it.
        const jib = this.cranes.get(j);
        const craned = !!jib && jib.kind === 'jib' && (forks || this.jibStows(jib));
        cranes ||= craned;
        // Nobody could unload it by hand next to a crane, or off machines-only quay.
        if (!needCrane && !craned && !walkableAt(m, j)) continue;
        const here = { berth: n, jetty: j, vessel };
        if (taken.some((t) => this.berthsClash(here, t))) continue;
        // Not while another boat is still pulling out of it.
        const bx = m.xOf(n) + 0.5;
        const by = m.yOf(n) + 0.5;
        const busy = this.boats.some(
          (b) => b.state === 'leaving' && Math.hypot(b.x - bx, b.y - by) < 2.5,
        );
        if (busy) continue;
        // The harbour master sends boats to the best-equipped free berth:
        // under a crane first, then a quay forklifts can reach; a container
        // ship under a gantry crane rather than a slower harbour crane.
        const bonus = needCrane
          ? this.gantryReaches(n)
            ? 200
            : 0
          : craned
            ? 200
            : m.build[j] === Build.Jetty
              ? 0
              : 100;
        const d = Math.abs(nx - m.xOf(from)) + Math.abs(ny - m.yOf(from)) - bonus;
        out.push({ berth: n, jetty: j, d, craned });
      }
    }
    const hands = needCrane || this.people.some((q) => q.kind === 'dockhand');
    if (!hands && cranes && out.some((b) => !b.craned)) this.tip('noHands');
    return out
      .filter((b) => hands || !cranes || b.craned)
      .sort((a, b) => a.d - b.d || a.berth - b.berth);
  }

  private tryBerth(boat: Boat): boolean {
    const from = this.tileOf(boat);
    const feeder = boat.vessel === 'feeder';
    // One boat at a time comes alongside or pulls out in each lane; the rest
    // wait at the anchorage, out of the way. Of the berths with a clear lane,
    // the best few that can be reached.
    const berths = this.freeBerths(from, boat.draft, boat.vessel !== 'smack', feeder)
      .filter((c) => this.fairwayFree(boat, c.jetty, c.berth))
      .slice(0, 6);
    for (const c of berths) {
      const path =
        (B.VESSELS[boat.vessel].length >= B.LINE_UP_LENGTH
          ? this.approachPath(boat, from, c.berth, c.jetty)
          : null) ?? this.route(boat, from, c.berth, this.seaWay(boat));
      if (!path) continue;
      boat.berth = c.berth;
      boat.jetty = c.jetty;
      // A big ship lining up out at sea takes the lane only once it is there.
      if (boat.berthing !== 'lead') this.takeFairway(boat);
      boat.best = Infinity;
      boat.path = path;
      boat.goal = c.berth;
      boat.state = 'arriving';
      return true;
    }
    boat.state = 'anchored';
    return false;
  }

  /**
   * The way in to a berth: out to a line a tile off it, along that line, so
   * the ship comes up parallel to the dock, then sideways in. The longer the
   * ship, the further out it lines up: half as far again as its length, or
   * as much of that as there is open water for. Null when there is no clear
   * line either way along.
   */
  private approachPath(boat: Boat, from: number, berth: number, jetty: number): number[] | null {
    const m = this.map;
    const ox = m.xOf(berth) - m.xOf(jetty);
    const oy = m.yOf(berth) - m.yOf(jetty);
    const ax = oy !== 0 ? 1 : 0;
    const ay = oy !== 0 ? 0 : 1;
    const length = B.VESSELS[boat.vessel].length;
    const sea = this.seaWay(boat);
    let best: number[] | null = null;
    boat.lineup = boat.lineEnd = boat.berthing = undefined;
    for (const s of [1, -1]) {
      const run = this.openAlong(boat, berth, jetty, s, length / 2);
      if (run < 0) continue;
      const line: number[] = [];
      for (let k = run; k >= 0; k--) {
        line.push(m.idx(m.xOf(berth) + ox + ax * s * k, m.yOf(berth) + oy + ay * s * k));
      }
      const lead = this.route(boat, from, line[0], sea);
      if (!lead) continue;
      const path = [...lead, ...line.slice(1), berth];
      if (!best || path.length < best.length) {
        best = path;
        boat.lineup = line[0];
        boat.lineEnd = line[line.length - 1];
        boat.berthing = 'lead';
      }
    }
    return best;
  }

  /**
   * A long ship leaving its berth runs out along the dock, a tile off it,
   * to open water before it turns: bow first if there is room that way,
   * otherwise astern. Sets it up as berthing 'out'.
   */
  private planRunOut(b: Boat): void {
    b.lineup = b.lineEnd = b.berthing = undefined;
    const v = B.VESSELS[b.vessel];
    if (v.length < B.RUN_OUT_LENGTH) return;
    const m = this.map;
    const ox = m.xOf(b.berth) - m.xOf(b.jetty);
    const oy = m.yOf(b.berth) - m.yOf(b.jetty);
    const ax = oy !== 0 ? 1 : 0;
    const ay = oy !== 0 ? 0 : 1;
    // Bow first: the way along the dock the ship is pointing.
    const ahead = Math.cos(b.dir) * ax + Math.sin(b.dir) * ay >= 0 ? 1 : -1;
    // A tile off the dock, with plenty of room to swing if it can be had,
    // at least just enough; or where the water off the berth is too
    // shallow, straight along the dock from the berth itself.
    for (const [s, r, off] of [
      [ahead, v.length / 2 + 0.5, 1],
      [-ahead, v.length / 2 + 0.5, 1],
      [ahead, v.length / 2, 1],
      [-ahead, v.length / 2, 1],
      [ahead, v.length / 2, 0],
      [-ahead, v.length / 2, 0],
    ]) {
      const run = this.openAlong(b, b.berth, b.jetty, s, r, off);
      if (run < 0) continue;
      const x = m.xOf(b.berth) + ox * off;
      const y = m.yOf(b.berth) + oy * off;
      b.lineEnd = m.idx(x, y);
      b.lineup = m.idx(x + ax * s * run, y + ay * s * run);
      b.berthing = 'out';
      return;
    }
  }

  /**
   * How many tiles along the dock, going `s` way (1 or -1) on the line
   * `off` tiles out from the berth, a long ship has to go to find open water `r` tiles
   * all round to turn in: between half its length and half as long again,
   * and -1 when there is none.
   */
  private openAlong(
    boat: Boat,
    berth: number,
    jetty: number,
    s: number,
    r: number,
    off = 1,
  ): number {
    const m = this.map;
    const water = this.boatCostFor(boat.draft);
    const ax = m.yOf(berth) !== m.yOf(jetty) ? 1 : 0;
    const ay = 1 - ax;
    const ox = (m.xOf(berth) - m.xOf(jetty)) * off;
    const oy = (m.yOf(berth) - m.yOf(jetty)) * off;
    const length = B.VESSELS[boat.vessel].length;
    const least = Math.ceil(length / 2) + 1;
    const most = Math.ceil(length * 1.5) + 1;
    const at = (k: number) => [m.xOf(berth) + ox + ax * s * k, m.yOf(berth) + oy + ay * s * k];
    const [x0, y0] = at(0);
    if (!m.inBounds(x0, y0) || water(m.idx(x0, y0)) !== 1) return -1;
    // As far out along the dock as the water stays open...
    let run = 0;
    while (run < most) {
      const [x, y] = at(run + 1);
      if (!m.inBounds(x, y) || water(m.idx(x, y)) !== 1) break;
      run++;
    }
    // ...and back to where there is room to swing round.
    while (run >= least) {
      const [x, y] = at(run);
      if (this.openAround(x + 0.5, y + 0.5, r)) return run;
      run--;
    }
    return -1;
  }

  /**
   * Coming alongside, moving to x, y would take a boat further into water a
   * ship pulling out has claimed, other than water round its own berth.
   */
  private intoClaimed(b: Boat, x: number, y: number): boolean {
    const m = this.map;
    const bx = m.xOf(b.berth) + 0.5;
    const by = m.yOf(b.berth) + 0.5;
    return this.boats.some((o) => {
      if (o === b || !o.room) return false;
      const spots = o.room.spots;
      if (spots.some(([sx, sy, r]) => Math.hypot(bx - sx, by - sy) < r + 1)) return false;
      return spots.some(
        ([sx, sy, r]) =>
          Math.hypot(x - sx, y - sy) < r &&
          Math.hypot(x - sx, y - sy) < Math.hypot(b.x - sx, b.y - sy),
      );
    });
  }

  /** Lying in the water a ship pulling out has claimed: it waits to cast off. */
  private boxedIn(b: Boat): boolean {
    return this.boats.some((o) =>
      o.room?.spots.some(([x, y, r]) => Math.hypot(b.x - x, b.y - y) < r + 0.5),
    );
  }

  /**
   * A ship that claims water to turn in as it pulls out lets a boat in that
   * water go first if it has been ready to leave longer: first ready, first
   * out, so no boat waits out one ship after another.
   * One that is itself waiting on the fairway, its tug or room to turn is
   * not waited for: the rest go on round it.
   */
  private letsGoFirst(b: Boat): boolean {
    const v = B.VESSELS[b.vessel];
    if (v.length < B.RUN_OUT_LENGTH) return false;
    // As far as its run out along the dock and the water it turns in reach.
    const reach = v.length * 2 + B.ROOM_MARGIN;
    return this.boats.some(
      (o) =>
        o !== b &&
        o.state === 'moored' &&
        o.crates === 0 &&
        o.reserved === 0 &&
        o.timer > b.timer &&
        // Not one that cannot go anyway, held up by something else.
        (o.holdUp === undefined || o.holdUp === 'others') &&
        Math.hypot(o.x - b.x, o.y - b.y) < reach,
    );
  }

  private updateBoat(b: Boat): void {
    this.plotCourses();
    if (b.state === 'anchored' || b.state === 'moored') {
      // A container ship takes long to work, and allows for that.
      const patience = B.BOAT_GIVE_UP_TICKS + (b.vessel === 'feeder' ? b.grace : 0);
      if (b.anchorTicks + b.mooredTicks > patience && b.crates > 0) {
        // The claim message in judgeVisit explains what happened.
        if (b.state === 'anchored' || !this.boxedIn(b)) return this.depart(b, true);
      }
    }
    switch (b.state) {
      case 'approaching':
        if (this.sail(b, null) !== 'moving') {
          b.state = 'anchored';
          b.speed = 0;
          const queue = this.boats.filter((q) => q.state === 'anchored').length;
          if (!this.tryBerth(b) && queue === 1) {
            this.nag('queue', 'Boats are queueing at the anchorage. Every berth is taken.', 'info');
          }
        }
        return;
      case 'anchored':
        b.anchorTicks++;
        // The harbour master calls in whoever has waited longest and fits a
        // free berth: a ship waiting for a crane berth does not hold up the
        // boats behind it.
        if (this.tick % 10 === 0 && this.nextInQueue() === b) {
          const queue = this.boats
            .filter((q) => q.state === 'anchored')
            .sort((p, q) => q.anchorTicks - p.anchorTicks);
          for (const q of queue) if (this.tryBerth(q)) break;
        }
        return;
      case 'arriving': {
        // Unable to come round for a good while, still far off its berth, as
        // a long ship pointing the wrong way in a basin: it gives the berth
        // up and heads back out to sea, to be called in again from the
        // anchorage with room to come in properly.
        if ((b.stall ?? 0) > B.BOAT_WEDGED_AFTER && this.cannotTurn(b)) return this.backToSea(b);
        // Come alongside: lie along the berth, parallel to the dock edge.
        const alongX = this.map.yOf(b.jetty) !== this.map.yOf(b.berth);
        // Something has been built where its hull would lie: another berth.
        const gone = !this.footprint(b.berth, b.jetty, this.boatHalf(b.vessel === 'feeder'));
        const r = gone ? 'blocked' : this.sail(b, alongX ? 0 : Math.PI / 2);
        if (r === 'blocked') {
          this.freeFairway(b);
          b.berth = b.jetty = -1;
          b.state = 'anchored';
          b.speed = 0;
        } else if (r === 'arrived') {
          this.freeFairway(b);
          b.state = 'moored';
          b.speed = 0;
          // Alongside, it is no longer wedged in anywhere.
          b.squeeze = 0;
          b.held = 0;
          b.lineup = b.lineEnd = b.berthing = undefined;
          b.timer = 0;
          b.mooredAt = this.tick;
          const what =
            b.vessel === 'feeder' ? 'feeder ship' : b.vessel === 'coaster' ? 'coaster' : 'boat';
          const cargo =
            b.vessel === 'feeder'
              ? 'containers'
              : b.vessel === 'coaster'
                ? 'crates on pallets'
                : 'crates';
          // Only a new line's first boat is news; the rest are routine.
          if (this.firstBoat.delete(b.company)) {
            this.message(`A ${b.company} ${what} has moored with ${b.crates} ${cargo}.`, 'info');
          }
          if (b.vessel === 'coaster') this.tip('pallets');
          if (b.vessel === 'coaster' && !this.people.some((p) => p.kind === 'forklift')) {
            this.nag(
              'pallets',
              'Pallets wait on the quay until a forklift takes them on. Buy one at a depot.',
              'bad',
            );
          }
        }
        return;
      }
      case 'moored': {
        if (b.crates === 0 && b.reserved === 0) b.unloadedAt ??= this.tick;
        // Unloaded, a coaster or feeder takes exports on board before it goes.
        const loading = b.crates === 0 && b.reserved === 0 && this.stillLoading(b);
        // Unloading and loading count against us; waiting for the fairway does not.
        if (b.crates > 0 || b.reserved > 0 || loading) b.mooredTicks++;
        if (loading) {
          // Kept loading long past its time, it sails with what it has.
          if (b.mooredTicks > b.grace + B.LOAD_OVERRUN_TICKS) b.loadQuota = b.out ?? 0;
          // Lying in the way of a ship coming in, it takes on what is on its
          // way to it, and no more.
          if (this.waitingFor(b)) {
            b.loadQuota = Math.min(b.loadQuota ?? Infinity, (b.out ?? 0) + this.exportsComing(b));
          }
          b.timer = 0;
          return;
        }
        if (b.crates === 0 && b.reserved === 0) {
          // Done loading for this visit: it takes on nothing more while it waits to sail.
          b.loadQuota = b.out ?? 0;
          b.loadedAt ??= this.tick;
          if (++b.timer <= 30) return;
          b.holdUp = this.boxedIn(b)
            ? 'room'
            : this.letsGoFirst(b)
              ? 'others'
              : !this.tugReady(b)
                ? 'tug'
                : this.takeFairway(b, true)
                  ? undefined
                  : 'fairway';
          if (!b.holdUp) this.depart(b, false);
        }
        return;
      }
      case 'leaving':
        this.claimRoom(b);
        // Clear of the dock: the next boat may use its fairway.
        if (b.fairway !== undefined && b.castOff !== undefined && b.berthing !== 'out') {
          const m = this.map;
          if (Math.hypot(b.x - m.xOf(b.castOff) - 0.5, b.y - m.yOf(b.castOff) - 0.5) > 3) {
            this.freeFairway(b);
          }
        }
        const [x, y] = [b.x, b.y];
        const r = this.sail(b, null);
        // Out of sight, out on the open sea: it is gone. By how far it has
        // sailed, not where it is on its way, as that is planned anew
        // whenever it finds another way out.
        b.sailed = (b.sailed ?? 0) + Math.hypot(b.x - x, b.y - y);
        if (r !== 'moving' || (b.sailed >= B.SAIL_IN_TILES && this.outOfSight(b))) {
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
    const cx = (i: number) => (i % w) + 0.5;
    const cy = (i: number) => Math.floor(i / w) + 0.5;
    const accel = v.speed * B.BOAT_ACCEL;
    let speed = b.speed ?? 0;
    if (b.path.length === 0) b.path = [b.goal];
    // Waypoints already passed drop off; the last one is the goal itself.
    // A long ship also counts one close by as passed once it is beyond it,
    // heading on towards the next, rather than turning back for it.
    const passed = (p: number, q: number) => {
      if (v.length < B.CAREFUL_LENGTH || Math.hypot(cx(p) - b.x, cy(p) - b.y) >= 2) return false;
      const qx = cx(q) - cx(p);
      const qy = cy(q) - cy(p);
      const along = (Math.cos(b.dir) * qx + Math.sin(b.dir) * qy) / Math.hypot(qx, qy);
      return along > 0.7 && (b.x - cx(p)) * qx + (b.y - cy(p)) * qy > 0;
    };
    while (
      b.path.length > 1 &&
      (Math.hypot(cx(b.path[0]) - b.x, cy(b.path[0]) - b.y) < 0.9 || passed(b.path[0], b.path[1]))
    ) {
      b.path.shift();
    }
    const goal = b.path[b.path.length - 1];
    const gx = cx(goal);
    const gy = cy(goal);
    let remaining = Math.hypot(cx(b.path[0]) - b.x, cy(b.path[0]) - b.y);
    for (let k = 1; k < b.path.length; k++) {
      remaining += Math.hypot(cx(b.path[k]) - cx(b.path[k - 1]), cy(b.path[k]) - cy(b.path[k - 1]));
    }
    // Out on open water, or handling: coming alongside, lining up or
    // casting off, when others keep clear of it.
    const free =
      remaining > 2.5 && (b.berthing === undefined || b.berthing === 'lead') && !b.undock;
    if (free) this.handling.delete(b);
    else this.handling.add(b);

    // Final approach to a berth: line up with it and crab in sideways.
    // A big ship close by works itself in with tugs: swings into line where
    // it lies, if there is room, and slides across.
    const close =
      v.length >= B.CAREFUL_LENGTH &&
      b.berthing !== 'lead' &&
      b.berthing !== 'align' &&
      Math.hypot(gx - b.x, gy - b.y) < 3;
    if (moor !== null && (remaining < 1.6 || close)) {
      // A boat pulling out, held up with this one in its way: it backs off
      // its berth to let it by, rather than wait alongside it for good.
      if (v.length < B.CAREFUL_LENGTH && this.inWayOfHeld(b)) {
        const d = Math.hypot(b.x - gx, b.y - gy);
        const [ux, uy] =
          d > 0.05 ? [(b.x - gx) / d, (b.y - gy) / d] : [-Math.cos(b.dir), -Math.sin(b.dir)];
        const nx = b.x + ux * v.speed * 0.2;
        const ny = b.y + uy * v.speed * 0.2;
        const ships = this.stillNear(b);
        if (
          this.navigable(nx, ny, this.boatCostFor(b.draft)) &&
          this.clips(b, nx, ny, b.dir, ships) <= this.clips(b, b.x, b.y, b.dir, ships) &&
          !this.crowds(b, nx, ny)
        ) {
          b.x = nx;
          b.y = ny;
        }
        b.speed = 0;
        return 'moving';
      }
      const left = Math.min(remaining, Math.hypot(gx - b.x, gy - b.y));
      const flip = Math.abs(wrapAngle(moor - b.dir)) > Math.PI / 2 ? Math.PI : 0;
      const err = wrapAngle(moor + flip - b.dir);
      // A long ship swings into line only as far as its hull clears the
      // dock, unless it has been at it a long while.
      // Without a tug a coaster or feeder comes round and alongside slowly.
      const hand = this.handiness(b);
      const turned = b.dir + clamp(err, -v.turn * 0.6 * hand, v.turn * 0.6 * hand);
      // Every boat minds its whole hull this close to the dock.
      const ships = this.stillNear(b);
      speed = Math.min(speed, (0.03 + left * 0.1) * hand);
      let step = Math.min(left, Math.max(speed, 0.008));
      if (v.length < B.CAREFUL_LENGTH) {
        // A small boat swings into line as it comes in. Failing that, it
        // comes across onto the line of its berth and then in along it,
        // rather than cut the corner of the dock; or swings where it lies;
        // or eases back a touch to have room to swing. Always with its hull
        // no nearer the dock or another boat (short of being wedged there
        // for good).
        const now = this.clips(b, b.x, b.y, b.dir, ships);
        const stuck = (b.held ?? 0) > B.BOAT_WEDGED_AFTER;
        const alongX = Math.abs(Math.cos(moor)) > 0.5;
        const toward = (dx: number, dy: number): [number, number] => {
          const d = Math.hypot(dx, dy);
          const k = d > step ? step / d : 1;
          return [b.x + dx * k, b.y + dy * k];
        };
        const straight = toward(gx - b.x, gy - b.y);
        const across = alongX ? toward(0, gy - b.y) : toward(gx - b.x, 0);
        const along = alongX ? toward(gx - b.x, 0) : toward(0, gy - b.y);
        const back: [number, number] =
          left > 1e-6
            ? [b.x + ((b.x - gx) / left) * 0.02, b.y + ((b.y - gy) / left) * 0.02]
            : [b.x, b.y];
        const ways: [number, number, number][] = [];
        for (const [x, y] of [straight, across, along]) {
          ways.push([turned, x, y], [b.dir, x, y]);
        }
        ways.push([turned, b.x, b.y], [turned, back[0], back[1]]);
        const way = ways.find(([d, x, y]) => {
          // Getting somewhere: closer, or further round into line. The last
          // half tile in, nearly in line, or it has no room left to swing.
          const near = Math.hypot(gx - x, gy - y);
          const off = Math.abs(wrapAngle(moor + flip - d));
          const closer = near < left - 1e-4 && (near > 0.5 || off < 0.3);
          const swung = off < Math.abs(err) - 1e-4;
          if (!closer && !swung) return false;
          // Wedged there for good, it may brush the dock or a moored boat
          // getting in, but never close on a boat under way.
          return (
            (stuck || (this.clips(b, x, y, d, ships) <= now && !this.intoClaimed(b, x, y))) &&
            !this.crowds(b, x, y, d)
          );
        });
        const was = left;
        if (way) {
          b.dir = way[0];
          b.x = way[1];
          b.y = way[2];
        } else b.held = (b.held ?? 0) + 1;
        step = Math.max(0, was - Math.hypot(gx - b.x, gy - b.y));
      } else {
        const clear =
          (b.held ?? 0) > 60 ||
          this.clips(b, b.x, b.y, turned, ships) <= this.clips(b, b.x, b.y, b.dir, ships);
        const swingInto = this.crowds(b, b.x, b.y, turned) && (b.held ?? 0) <= B.BOAT_WEDGED_AFTER;
        if (clear && !swingInto) b.dir = turned;
        b.held = (b.held ?? 0) + 1;
        if (left > 1e-6) {
          const nx = b.x + ((gx - b.x) / left) * step;
          const ny = b.y + ((gy - b.y) / left) * step;
          // A long ship lines up first and comes in sideways only as its
          // hull clears the dock, nor on top of another boat passing its
          // berth, short of being wedged there for good.
          const crowded =
            this.crowds(b, nx, ny) ||
            (this.intoClaimed(b, nx, ny) && (b.held ?? 0) <= B.BOAT_WEDGED_AFTER);
          const slide =
            !crowded &&
            ((b.held ?? 0) > 150 ||
              this.clips(b, nx, ny, b.dir, ships) <= this.clips(b, b.x, b.y, b.dir, ships));
          if (slide) {
            b.x = nx;
            b.y = ny;
          } else step = 0;
        }
      }
      b.speed = speed;
      if (left - step < 0.02 && Math.abs(err) < 0.04) {
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
    // Going round a boat met head on, all of them.
    const avoid = this.seaWay(b, (b.roundUntil ?? 0) > this.tick);
    // And no nearer a pier's corner, or a boat lying at its berth, than
    // where it is or where it aims for: it keeps the wide circle round them
    // that it planned.
    const wide = this.wideOf(b);
    const here = wide(this.tileOf(b));
    const clearTo =
      (cap: number): CostFn =>
      (i) => {
        const w = i === goal ? 0 : wide(i);
        return avoid(i) - w === 1 && w <= cap ? 1 : Infinity;
      };
    // A boat has moored across the route since it was planned: find a way
    // round it, rather than brush past its bow or stern.
    const across = b.path.slice(0, 3).some((i) => i !== goal && !Number.isFinite(avoid(i)));
    if (across && !b.berthing && !b.undock && (this.tick + b.id) % 10 === 0) {
      const round = this.route(b, this.tileOf(b), goal, avoid);
      if (round && round.length > 0) b.path = round;
    }
    let ahead = 0;
    // Coming in to a berth, keep to the approach line along the dock: never
    // cut the corner past where it starts.
    const line = moor !== null && b.berthing === 'lead' ? b.path.indexOf(b.lineup ?? -1) : -1;
    const most = line >= 0 ? Math.min(line + 1, 4) : 4;
    for (let k = 1; k < Math.min(b.path.length, most); k++) {
      // A buoy is passed, and the line between a pair crossed, not cut past.
      const at = b.path[k - 1];
      if (isBuoy(this.map.build[at]) || this.gateLines(b.state === 'leaving').has(at)) break;
      const clear = clearTo(Math.max(here, wide(b.path[k])));
      if (!this.openWater(b.x, b.y, cx(b.path[k]), cy(b.path[k]), clear, v.beam / 2 + 0.05)) {
        break;
      }
      ahead = k;
    }
    b.path.splice(0, ahead);
    const target = b.path[0];
    // Buoys are passed close by, on the boat's starboard side.
    const passBy = isBuoy(this.map.build[target]) ? B.BUOY_CLEARANCE : 0;
    const tx = cx(target) - Math.sin(b.dir) * passBy;
    const ty = cy(target) + Math.cos(b.dir) * passBy;
    const want = Math.atan2(ty - b.y, tx - b.x);
    if (b.undock && this.castingOff(b, want)) return 'moving';
    if (b.berthing === 'out' && b.lineup !== undefined && b.lineEnd !== undefined) {
      return this.runOut(b, b.lineup, b.lineEnd, goal, cx, cy);
    }
    if (b.berthing && b.lineup !== undefined && b.lineEnd !== undefined && moor !== null) {
      const sx = cx(b.lineup);
      const sy = cy(b.lineup);
      const along = Math.atan2(cy(b.lineEnd) - sy, cx(b.lineEnd) - sx);
      if (b.berthing === 'lead' && Math.hypot(sx - b.x, sy - b.y) < 1.2) {
        // Wait out there until the lane in to the berth is clear.
        if (!this.takeFairway(b)) {
          b.speed = Math.max(0, (b.speed ?? 0) - accel * 2);
          return this.afterMove(b, b.speed, true, moor, goal, cx, cy);
        }
        b.berthing = 'align';
        b.timer = 0;
      }
      if (b.berthing === 'align') {
        b.timer++;
        if (b.timer > 600) {
          // Cannot come round here after all: find another way in.
          b.berthing = undefined;
          b.stall = B.BOAT_REROUTE_AFTER - 1;
        } else if (Math.abs(wrapAngle(along - b.dir)) < 0.12) {
          b.berthing = 'line';
          b.path = b.path.slice(Math.max(0, b.path.indexOf(b.lineup) + 1));
        } else {
          // Out at the start of the line, come round to lie along it: with
          // tugs where it lies if there is room, otherwise under way.
          return this.lineUp(b, along, sx, sy, moor, goal, cx, cy);
        }
      }
    }
    const way = this.giveWay(b);
    b.stillFor = way.still ? (b.stillFor ?? 0) + 1 : 0;
    // Held up a while by a boat under way that gets nowhere either, as two
    // met head on, one backing off along its own way in front of the other:
    // it goes round it, as round a boat lying still.
    const stuckOn =
      !!way.by &&
      way.by.state !== 'moored' &&
      way.by.state !== 'anchored' &&
      way.speed < 0.2 &&
      (way.by.speed ?? 0) < B.VESSELS[way.by.vessel].speed * 0.2;
    b.headOn = stuckOn ? (b.headOn ?? 0) + 1 : 0;
    if (b.headOn > B.HEAD_ON_TICKS && !b.berthing && !b.undock) {
      b.headOn = 0;
      const round = this.route(b, this.tileOf(b), goal, this.seaWay(b, true));
      if (round && round.length > 0) {
        b.path = round;
        b.roundUntil = this.tick + B.HEAD_ON_TICKS * 2;
      }
    }
    // The rules of the road, out on open water: look ahead for boats on a
    // collision course.
    const road = free && !b.squeeze ? this.rulesOfTheRoad(b) : { bias: 0, slow: 1 };
    if (!free || b.squeeze) this.keepingClear.delete(b);
    const course = wrapAngle(want + road.bias);
    const err = wrapAngle(course - b.dir);
    // A boat needs way on to turn: it never spins on the spot, it slows and
    // swings round in an arc.
    const turn = v.turn * (0.3 + (0.7 * speed) / v.speed);
    const small = v.length < B.CAREFUL_LENGTH;
    // Ease off for sharp bends, to stop at the goal, and for other boats,
    // but keep some way on through a bend so it swings round in an arc.
    const bend = (a: number) =>
      v.speed * Math.max(0.25, Math.cos(Math.min(Math.abs(a), Math.PI / 2)) ** 2);
    let desired = bend(err);
    // Looking ahead: ease off in good time for the next bend, rather than
    // braking hard on reaching it…
    if (b.path.length > 1) {
      const next = b.path[1];
      const corner = wrapAngle(
        Math.atan2(cy(next) - ty, cx(next) - tx) - Math.atan2(ty - b.y, tx - b.x),
      );
      const reach = Math.hypot(tx - b.x, ty - b.y);
      desired = Math.min(desired, Math.sqrt(bend(corner) ** 2 + 2 * accel * reach));
    }
    // …and to stop at the goal, unless it is just sailing off the map.
    if (b.state !== 'leaving')
      desired = Math.min(desired, Math.sqrt(2 * accel * remaining) + 0.004);
    desired *= way.speed * road.slow;
    // A ship carries its way: it brakes only a little harder than it speeds up.
    speed += clamp(desired - speed, -accel * B.BOAT_BRAKE, accel);
    speed = Math.max(0, speed);

    // A boat with right of way is waiting on this one: go astern to clear
    // its way, as long as nothing is behind. Backing and getting nowhere for
    // too long counts as wedged too.
    if (way.makeWay >= 0) {
      b.yieldFor = way.makeWay;
      // Take the way off first, then go astern: no stopping dead, unless
      // it is in water a ship pulling out has claimed, where it backs at once.
      const coast = this.roomWait.has(b) ? 0 : Math.max(0, (b.speed ?? 0) - accel * 2);
      if (coast > 0) {
        const nx = b.x + Math.cos(b.dir) * coast;
        const ny = b.y + Math.sin(b.dir) * coast;
        if (this.navigable(nx, ny, this.boatCostFor(b.draft)) && !this.crowds(b, nx, ny)) {
          b.x = nx;
          b.y = ny;
          b.speed = coast;
          return 'moving';
        }
      }
      this.goAstern(b);
      if ((b.held ?? 0) > B.BOAT_WEDGED_AFTER) {
        this.startSqueeze(b);
        b.held = 0;
        b.stall = 0;
      }
      return 'moving';
    }
    b.yieldFor = undefined;
    b.astern = false;
    // Small boats nip about; a long ship works itself round, ahead or
    // astern, minding its whole hull. So does a small boat boxed in against
    // a dock, until it is clear.
    if (small && !(b.plan && this.tick < b.plan.until)) {
      const made = this.nip(b, speed, clamp(err, -turn, turn), cx(target), cy(target), way.speed);
      if (made === null) return 'moving';
      if (made !== 'boxed') return this.afterMove(b, made, false, moor, goal, cx, cy);
    }
    // The whole hull keeps clear of the shore, docks and boats lying still.
    // A boat already touching something may only get clearer.
    const ships = this.stillNear(b);
    const now = this.clips(b, b.x, b.y, b.dir, ships);
    const fits = (x: number, y: number, d: number) =>
      this.clips(b, x, y, d, ships) <= now && !this.crowds(b, x, y, d);
    // Room is only needed as far as the goal: past a berth lies the dock.
    const reach = Math.min(v.length / 2 + 1, remaining);
    // Take any sternway off before going ahead again.
    if ((b.sternway ?? 0) > 0 && !b.plan?.astern) {
      const back = Math.max(0, (b.sternway ?? 0) - accel * 2);
      const sx = b.x - Math.cos(b.dir) * back;
      const sy = b.y - Math.sin(b.dir) * back;
      const moved = fits(sx, sy, b.dir);
      if (moved) {
        b.x = sx;
        b.y = sy;
      }
      b.sternway = moved ? back : 0;
      return 'moving';
    }

    // Pick a manoeuvre the whole hull has room for: ahead with the helm
    // over, or astern swinging the bow round, whichever brings it nearest
    // to heading for its next waypoint. Kept for a few ticks so it does not
    // dither between ahead and astern.
    let plan = b.plan && this.tick < b.plan.until ? b.plan : undefined;
    const step = (p: { helm: number; astern: boolean; pivot?: boolean }) => {
      if (p.pivot) {
        const swing = v.turn * 0.5 * this.handiness(b);
        const d = wrapAngle(b.dir + clamp(err, -swing, swing));
        return { d, x: b.x, y: b.y, back: 0 };
      }
      const delta =
        Math.sign(p.helm) === Math.sign(err) && !p.astern
          ? clamp(err, -Math.abs(p.helm) * turn, Math.abs(p.helm) * turn)
          : p.helm * turn * (p.astern ? 0.5 : 1);
      const d = wrapAngle(b.dir + delta);
      const back = Math.min(v.speed * 0.4, (b.sternway ?? 0) + accel);
      const dist = p.astern ? -back : speed;
      return { d, x: b.x + Math.cos(d) * dist, y: b.y + Math.sin(d) * dist, back };
    };
    if (plan && !fits(step(plan).x, step(plan).y, step(plan).d)) plan = undefined;
    // Held up for good by something lying still ahead, with where it is
    // going behind it, as at the head of a basin: nothing will move out of
    // its way and it cannot come round where it lies. It backs out, swinging
    // its bow round towards its course, until it is clear to come round. So
    // too, getting nowhere pointing away from its course, as in a basin too
    // narrow for it to turn in.
    if (plan?.out && Math.abs(err) < Math.PI / 6) plan = undefined;
    const boxedIn = way.still && (b.held ?? 0) > 30;
    const cannotTurn = Math.abs(err) > Math.PI / 2 && (b.stall ?? 0) > B.BOAT_REROUTE_AFTER;
    if (!plan && Math.abs(err) > Math.PI / 6 && (boxedIn || cannotTurn)) {
      const helm = [Math.sign(err) || 1, 0].find((h) => {
        const n = step({ helm: h, astern: true });
        return fits(n.x, n.y, n.d);
      });
      if (helm !== undefined && this.clearAstern(b)) {
        plan = { helm, astern: true, until: this.tick + 60, out: true };
        b.plan = plan;
      }
    }
    if (!plan) {
      // Aim a ship's length or so along the route, not just at the next
      // waypoint, so a manoeuvre is judged by where it leaves the ship.
      // It should get there heading the way the route goes on.
      // Where the rules of the road put it: round other boats.
      const rd = Math.hypot(tx - b.x, ty - b.y);
      let ax = b.x + Math.cos(course) * rd;
      let ay = b.y + Math.sin(course) * rd;
      let adir = course;
      let left = Math.max(2, v.length * 0.75) - Math.hypot(ax - b.x, ay - b.y);
      for (let k = 1; k < b.path.length && left > 0; k++) {
        const nx = cx(b.path[k]);
        const ny = cy(b.path[k]);
        const seg = Math.hypot(nx - ax, ny - ay);
        const t = Math.min(1, left / Math.max(seg, 1e-6));
        adir = Math.atan2(ny - ay, nx - ax);
        ax += (nx - ax) * t;
        ay += (ny - ay) * t;
        left -= seg;
      }
      if (left > 0 && moor !== null) {
        // As far as the berth itself: lie the way it will moor.
        adir = Math.abs(wrapAngle(moor - b.dir)) > Math.PI / 2 ? wrapAngle(moor + Math.PI) : moor;
      }
      if (b.berthing === 'lead' && b.lineup !== undefined && b.path.includes(b.lineup)) {
        // Heading out to the start of the approach line: just get there.
        ax = cx(b.lineup);
        ay = cy(b.lineup);
        adir = Math.atan2(ay - b.y, ax - b.x);
      }
      // Held up by a boat lying still in its way, it does not go on at it:
      // it swings round where it lies, or backs off, towards the next turn
      // of its way rather than a ship's length along it, which may lie on
      // past that boat.
      const heldStill = way.still && (b.stillFor ?? 0) > B.HELD_STILL_TICKS;
      if (heldStill && b.path[0] !== undefined) {
        ax = cx(b.path[0]);
        ay = cy(b.path[0]);
        adir = Math.atan2(ay - b.y, ax - b.x);
      }
      // The best whose very first step is clear too.
      const best = this.manoeuvre(b, ax, ay, adir, speed, ships, now, reach).find((o) => {
        if (heldStill && !o.pivot && !o.astern) return false;
        const n = step(o);
        return fits(n.x, n.y, n.d);
      });
      plan = best
        ? { helm: best.helm, astern: best.astern, pivot: best.pivot, until: this.tick + 8 }
        : undefined;
      b.plan = plan;
    }
    let backed = false;
    const next = plan ? step(plan) : null;
    if (plan && next && !fits(next.x, next.y, next.d)) {
      // The run looked clear but this step is not: think again next tick.
      b.plan = undefined;
      speed = 0;
    } else if (
      plan &&
      next &&
      // Ahead only as the way ahead lets it; but swinging round where it
      // lies, or backing off, takes it no nearer what it waits for, so it
      // may: else, held by a boat lying still off its bow, a long ship
      // that cannot turn without way on would wait there for good.
      (way.speed > 0.05 || plan.pivot || (plan.astern && this.clearAstern(b)))
    ) {
      b.dir = next.d;
      b.x = next.x;
      b.y = next.y;
      if (plan.astern || plan.pivot) {
        b.sternway = next.back;
        speed = 0;
        backed = true;
      } else b.sternway = 0;
    } else if ((b.held ?? 0) > B.BOAT_WEDGED_AFTER / 2 || (b.squeeze ?? 0) > 0) {
      // Boxed in for a long time: work along the path at a crawl, as a
      // skipper would with a bit of throttle and rudder.
      const px = cx(target) - b.x;
      const py = cy(target) - b.y;
      const d = Math.hypot(px, py);
      const crawl = Math.min(d, v.speed * 0.2);
      speed = 0;
      if (d > 1e-6 && way.speed > 0.05) {
        b.x += (px / d) * crawl;
        b.y += (py / d) * crawl;
        speed = crawl;
      }
    } else speed = 0;
    return this.afterMove(b, speed, backed, moor, goal, cx, cy);
  }

  /**
   * A long ship leaving runs straight out along the dock, ahead or astern,
   * keeping its heading, to the open water at `end`; there it is free to
   * turn for the sea.
   */
  private runOut(
    b: Boat,
    end: number,
    start: number,
    goal: number,
    cx: (i: number) => number,
    cy: (i: number) => number,
  ): 'moving' | 'blocked' {
    const v = B.VESSELS[b.vessel];
    const ex = cx(end);
    const ey = cy(end);
    const len = Math.hypot(ex - cx(start), ey - cy(start));
    const ux = (ex - cx(start)) / len;
    const uy = (ey - cy(start)) / len;
    const gone = (b.x - cx(start)) * ux + (b.y - cy(start)) * uy;
    if (gone >= len - 0.2) {
      // Out in open water: on its way to sea.
      b.lineup = b.lineEnd = b.berthing = undefined;
      const from = this.tileOf(b);
      b.path = this.route(b, from, goal, this.seaWay(b)) ?? [goal];
      b.best = Infinity;
      b.stall = 0;
      return 'moving';
    }
    const fwd = Math.cos(b.dir) * ux + Math.sin(b.dir) * uy >= 0;
    const ships = this.stillNear(b);
    const now = this.clips(b, b.x, b.y, b.dir, ships);
    const way = this.giveWay(b);
    const accel = v.speed * B.BOAT_ACCEL;
    const top = (fwd ? 0.75 : 0.5) * v.speed * way.speed * (0.4 + 0.6 * this.handiness(b));
    const speed = clamp(
      (b.speed ?? 0) + accel,
      0,
      Math.min(top, Math.sqrt(2 * accel * (len - gone)) + 0.004),
    );
    // Along the line, easing back onto it if it has drifted.
    const side = -(b.x - cx(start)) * uy + (b.y - cy(start)) * ux;
    const x = b.x + ux * speed - -uy * side * 0.05;
    const y = b.y + uy * speed - ux * side * 0.05;
    if (speed > 0 && this.clips(b, x, y, b.dir, ships) <= now) {
      b.x = x;
      b.y = y;
      b.speed = fwd ? speed : 0;
      b.sternway = fwd ? 0 : speed;
      b.astern = !fwd;
      return this.afterMove(b, speed, true, null, goal, cx, cy);
    }
    b.speed = 0;
    b.sternway = 0;
    return this.afterMove(b, 0, false, null, goal, cx, cy);
  }

  /**
   * A long ship at the start of its approach line comes round to lie along
   * it, heading for the berth: swung by tugs where it lies when there is room
   * for the whole hull, otherwise worked round under way.
   */
  private lineUp(
    b: Boat,
    along: number,
    sx: number,
    sy: number,
    moor: number,
    goal: number,
    cx: (i: number) => number,
    cy: (i: number) => number,
  ): 'moving' | 'blocked' {
    const v = B.VESSELS[b.vessel];
    const ships = this.stillNear(b);
    const now = this.clips(b, b.x, b.y, b.dir, ships);
    const hand = this.handiness(b);
    const swung = wrapAngle(b.dir + clamp(wrapAngle(along - b.dir), -v.turn * hand, v.turn * hand));
    if (this.clips(b, b.x, b.y, swung, ships) <= now) {
      b.dir = swung;
      b.speed = 0;
      return this.afterMove(b, 0, true, moor, goal, cx, cy);
    }
    // No room to swing here: manoeuvre towards a point along the line.
    const options = this.manoeuvre(
      b,
      sx + Math.cos(along) * 2,
      sy + Math.sin(along) * 2,
      along,
      v.speed * 0.25,
      ships,
      now,
      v.length / 2 + 1,
    );
    for (const plan of options) {
      if (plan.pivot) continue;
      const step = plan.astern ? -v.speed * 0.25 : v.speed * 0.25;
      const d = wrapAngle(b.dir + plan.helm * v.turn * (plan.astern ? 0.25 : 0.5));
      const x = b.x + Math.cos(d) * step;
      const y = b.y + Math.sin(d) * step;
      if (this.clips(b, x, y, d, ships) > now) continue;
      b.dir = d;
      b.x = x;
      b.y = y;
      b.speed = Math.max(0, step);
      return this.afterMove(b, b.speed, plan.astern, moor, goal, cx, cy);
    }
    return this.afterMove(b, 0, false, moor, goal, cx, cy);
  }

  /**
   * A small boat's step: swing towards its course by up to `turn` and go
   * ahead, as far round as its whole hull stays clear of the shore and the
   * docks (or at least no less clear than it is). Otherwise it works along
   * the path at a crawl, as a skipper would with a bit of throttle and
   * rudder, still minding the hull. Returns the speed made good, null
   * while it is still taking sternway off, or 'boxed' when there is no
   * room for any of that.
   */
  private nip(
    b: Boat,
    speed: number,
    turn: number,
    tx: number,
    ty: number,
    way: number,
  ): number | null | 'boxed' {
    const v = B.VESSELS[b.vessel];
    const cost = this.boatCostFor(b.draft);
    const ships = this.stillNear(b);
    const now = this.clips(b, b.x, b.y, b.dir, ships);
    // Squeezing past as a last resort, it may brush the dock too. Else its
    // hull comes no nearer another boat's, under way or not, once close.
    const fits = (x: number, y: number, d: number) =>
      ((b.squeeze ?? 0) > 0 ||
        (this.navigable(x, y, cost) && this.clips(b, x, y, d, ships) <= now)) &&
      !this.crowds(b, x, y, d);
    // Take any sternway off before going ahead again.
    if ((b.sternway ?? 0) > 0) {
      const back = Math.max(0, (b.sternway ?? 0) - v.speed * B.BOAT_ACCEL * 2);
      const sx = b.x - Math.cos(b.dir) * back;
      const sy = b.y - Math.sin(b.dir) * back;
      const moved = fits(sx, sy, b.dir);
      if (moved) {
        b.x = sx;
        b.y = sy;
      }
      b.sternway = moved ? back : 0;
      return null;
    }
    for (const share of [1, 0.5, 0]) {
      const d = wrapAngle(b.dir + turn * share);
      const nx = b.x + Math.cos(d) * speed;
      const ny = b.y + Math.sin(d) * speed;
      if (this.navigable(nx + Math.cos(d) * 0.3, ny + Math.sin(d) * 0.3, cost) && fits(nx, ny, d)) {
        b.dir = d;
        b.x = nx;
        b.y = ny;
        return speed;
      }
    }
    const px = tx - b.x;
    const py = ty - b.y;
    const d = Math.hypot(px, py);
    const step = Math.min(d, v.speed * 0.2);
    if (d <= 1e-6 || way <= 0.05) return 0;
    const turned = wrapAngle(b.dir + turn);
    for (const dir of [turned, b.dir]) {
      const nx = b.x + (px / d) * step;
      const ny = b.y + (py / d) * step;
      if (!fits(nx, ny, dir)) continue;
      b.dir = dir;
      b.x = nx;
      b.y = ny;
      return step;
    }
    return 'boxed';
  }

  /** Book-keeping after a step: held up, wedged, getting nowhere. */
  private afterMove(
    b: Boat,
    speed: number,
    backed: boolean,
    moor: number | null,
    goal: number,
    cx: (i: number) => number,
    cy: (i: number) => number,
  ): 'moving' | 'blocked' {
    const v = B.VESSELS[b.vessel];
    b.speed = speed;

    // Waiting for a ship to pull out is not being wedged in.
    const waiting = this.roomWait.has(b);
    b.held = speed < v.speed * 0.1 && !backed && !waiting ? (b.held ?? 0) + 1 : 0;
    // Wedged in for most of a day: squeeze past for a while, as a last
    // resort so the harbour never locks up for good.
    if (b.squeeze) b.squeeze--;
    else if (b.held > B.BOAT_WEDGED_AFTER || (b.stall ?? 0) > B.BOAT_WEDGED_AFTER * 2) {
      this.startSqueeze(b);
      b.held = 0;
      b.stall = 0;
    }
    // Getting no closer, held up or going round in circles: find another way,
    // round every other boat this time. Coming in to a berth, closer means
    // closer to the start of the approach line until the boat is on it.
    const aim = b.lineup !== undefined && b.path.includes(b.lineup) ? b.lineup : goal;
    const straight = Math.hypot(cx(aim) - b.x, cy(aim) - b.y);
    if (straight < (b.best ?? Infinity) - 0.05) {
      b.best = straight;
      b.stall = 0;
    } else b.stall = (b.stall ?? 0) + 1;
    const steady = b.berthing === 'align' || b.berthing === 'line' || b.berthing === 'out';
    if (!steady && b.stall > B.BOAT_REROUTE_AFTER && b.stall % B.BOAT_REROUTE_AFTER === 0) {
      const from = this.tileOf(b);
      const path =
        (moor !== null && b.state === 'arriving' && v.length >= B.LINE_UP_LENGTH
          ? this.approachPath(b, from, b.berth, b.jetty)
          : null) ??
        this.route(b, from, goal, this.seaWay(b, true)) ??
        this.route(b, from, goal, this.seaWay(b));
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
      const step = v.speed * 0.2 * this.handiness(b);
      // A long ship gets a tile out, or with no run out along the dock, out
      // as far as it takes to have room to swing; a small boat far enough
      // that its stern swings clear of the dock as it turns.
      const runAlong = b.berthing === 'out' && b.lineEnd === b.castOff;
      const clear = runAlong
        ? 0.3
        : b.berthing === 'out'
          ? 1
          : v.length < B.CAREFUL_LENGTH
            ? v.length / 2 - 0.3
            : this.openAround(b.x, b.y, v.length / 2)
              ? 1
              : 4;
      const ships = this.stillNear(b);
      const sx = b.x + ax * step;
      const sy = b.y + ay * step;
      const room =
        this.navigable(sx, sy, cost) &&
        this.clips(b, sx, sy, b.dir, ships) <= this.clips(b, b.x, b.y, b.dir, ships) &&
        !this.crowds(b, sx, sy);
      if (off < clear && room) {
        b.x += ax * step;
        b.y += ay * step;
        b.speed = 0;
        return true;
      }
      b.undock = 2;
    }
    // Running out along the dock: no swinging round yet.
    if (b.berthing === 'out') {
      b.undock = undefined;
      return false;
    }
    const err = wrapAngle(want - b.dir);
    const backed = Math.hypot(b.x - bx, b.y - by);
    if (Math.abs(err) > 1.75 && backed < 2.5) {
      // Gathering sternway gradually, like any other way.
      const back = Math.min(v.speed * 0.5, (b.sternway ?? 0) + v.speed * B.BOAT_ACCEL);
      const sx = b.x - Math.cos(b.dir) * back;
      const sy = b.y - Math.sin(b.dir) * back;
      const stern = { ...this.hullOf(b), hx: -Math.cos(b.dir), hy: -Math.sin(b.dir) };
      // Going astern the stern swings one way and the bow the other.
      const swing = v.turn * 0.4 * this.handiness(b);
      const swung = wrapAngle(b.dir + clamp(err, -swing, swing));
      const ships = this.stillNear(b);
      const roomAstern =
        this.clips(b, sx, sy, swung, ships) <= this.clips(b, b.x, b.y, b.dir, ships) &&
        !this.crowds(b, sx, sy, swung);
      const clear =
        roomAstern &&
        this.boats.every(
          (o) => o === b || this.inWay(stern, this.hullOf(o), stern.half + 0.3) === null,
        );
      if (clear) {
        b.x = sx;
        b.y = sy;
        b.dir = swung;
        b.speed = 0;
        b.sternway = back;
        b.astern = true;
        return true;
      }
    }
    // Any sternway left comes off gradually in sail().
    b.undock = undefined;
    b.astern = false;
    return false;
  }

  /** Back off slowly to clear the way for another boat, if nothing is astern. */
  /** Nothing under way or lying still just astern of a boat, for it to back into. */
  private clearAstern(b: Boat): boolean {
    const astern = { ...this.hullOf(b), hx: -Math.cos(b.dir), hy: -Math.sin(b.dir) };
    return this.boats.every(
      (o) => o === b || this.inWay(astern, this.hullOf(o), astern.half + 0.3) === null,
    );
  }

  private goAstern(b: Boat): void {
    const v = B.VESSELS[b.vessel];
    const cost = this.boatCostFor(b.draft);
    const back = Math.min(v.speed * 0.3, (b.sternway ?? 0) + v.speed * B.BOAT_ACCEL);
    const sx = b.x - Math.cos(b.dir) * back;
    const sy = b.y - Math.sin(b.dir) * back;
    const sternX = sx - Math.cos(b.dir) * 0.3;
    const sternY = sy - Math.sin(b.dir) * 0.3;
    const moved =
      this.clearAstern(b) &&
      this.navigable(sx, sy, cost) &&
      this.navigable(sternX, sternY, cost) &&
      !this.crowds(b, sx, sy);
    if (moved) {
      b.x = sx;
      b.y = sy;
    }
    b.speed = 0;
    b.sternway = moved ? back : 0;
    b.astern = true;
    b.held = (b.held ?? 0) + 1;
  }

  /** Open water here; past the map edge is open sea, where boats come and go. */
  /**
   * How many points of the hull, lying at x, y heading dir, are over land
   * or a dock, or inside one of `ships`. Points along the keel from stern
   * to bow and along both sides. (Depth is the route's business: a hull's
   * ends may hang over the shallows, as at a berth.)
   */
  private clips(b: Boat, x: number, y: number, dir: number, ships: Boat[]): number {
    const v = B.VESSELS[b.vessel];
    const m = this.map;
    const cost: CostFn = (i) =>
      m.isLand(i) || (m.build[i] !== Build.None && !isBuoy(m.build[i])) ? Infinity : 1;
    const hx = Math.cos(dir);
    const hy = Math.sin(dir);
    const side = (v.beam / 2) * 0.9;
    const n = Math.max(2, Math.ceil(v.length / 0.45));
    let hits = 0;
    const at = (px: number, py: number) => {
      if (!this.navigable(px, py, cost)) return hits++;
      for (const o of ships) {
        const w = B.VESSELS[o.vessel];
        const ox = Math.cos(o.dir);
        const oy = Math.sin(o.dir);
        const rx = px - o.x;
        const ry = py - o.y;
        const along = Math.abs(rx * ox + ry * oy);
        const across = Math.abs(-rx * oy + ry * ox);
        if (along < w.length / 2 + 0.05 && across < w.beam / 2 + 0.05) return hits++;
      }
    };
    for (let k = 0; k <= n; k++) {
      const t = -v.length / 2 + (v.length * k) / n;
      const px = x + hx * t;
      const py = y + hy * t;
      at(px, py);
      // The ends taper to a point.
      if (k > 0 && k < n) {
        at(px - hy * side, py + hx * side);
        at(px + hy * side, py - hx * side);
      }
    }
    return hits;
  }

  // ── Trucks at container yards ─────────────────────────

  /** A yard gantry stands beside this container yard, to load its trucks. */
  private yardGantry(yard: Bay): boolean {
    return this.gantryOf(yard) >= 0;
  }

  /**
   * The yard gantry that works this container yard, by its tile, or -1:
   * one that spans it (see gantryYard), the first where two stand by it;
   * never one beside it that spans another yard.
   */
  private gantryOf(yard: Bay): number {
    return this.gantries().byYard.get(yard.idx) ?? -1;
  }

  /**
   * Every yard gantry and the yard it works, by the yard's first tile;
   * and those that work none: beside no yard, or a second by one. Cleared
   * when the map changes.
   */
  private gantries(): { byYard: Map<number, number>; idle: Map<number, string> } {
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
  private handlerFree(bay: Bay, except?: Truck): boolean {
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
  private gantryTruck(y: Bay): Truck | undefined {
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
  private fromGantry(y: Bay, i: number): number {
    return Math.abs((this.gantryLane(y)?.get(i) ?? 0) - (y.gantryAt ?? 0));
  }

  /**
   * What a yard's gantry is doing, for the view: a truck it is loading or
   * unloading, and where that truck stands along its rails.
   */
  private gantryWork(y: Bay): GantryWork {
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
        const workYard = y.gantryTo ?? this.stackedAt(p, y, this.customsFor(p.cargoFrom?.[0]));
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
  private liftView(
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
  private slotAlong(y: Bay, slot: number | undefined): number {
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
  private startLift(y: Bay, from: number, to: number): number {
    const at = y.gantryAt ?? from;
    // Taking it up and setting it down take as long as a lift always did.
    const up = Math.floor(B.YARD_GANTRY_TICKS / 2);
    const down = B.YARD_GANTRY_TICKS - up;
    const run = (d: number) => Math.round(Math.abs(d) / B.YARD_GANTRY_SPEED);
    y.gantryLift = { start: this.tick, legs: [run(from - at), up, run(to - from), down], to };
    return liftTicks(y.gantryLift);
  }

  /** Whether the lift a yard's gantry is part way through is done. */
  private liftDone(y: Bay): boolean {
    const l = y.gantryLift;
    return !l || this.tick - l.start >= liftTicks(l);
  }

  /** Ticks from the start of a yard gantry's lift until its spreader has the container up. */
  private takenIn(y: Bay): number {
    const l = y.gantryLift;
    // Not before the view has it taken: half way through taking it up.
    return l ? l.legs[0] + Math.ceil(l.legs[1] / 2) : 0;
  }

  /** Whether a yard gantry's spreader has taken up the container it is lifting. */
  private liftTaken(y: Bay): boolean {
    const l = y.gantryLift;
    return !l || this.tick - l.start >= this.takenIn(y);
  }

  /**
   * A yard gantry has lifted a container off the truck or tractor it was
   * working: that one is free to go, and the gantry carries the container
   * on and sets it down at the end of the lift, taking on no other till then.
   */
  private offToGantry(y: Bay, held: GantryHeld): void {
    y.gantryHeld = held;
    y.gantryOn = undefined;
  }

  /** A yard gantry sets down the container it lifted off a truck or tractor gone on its way. */
  private settleGantry(y: Bay): void {
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
      const ready = h.fees.map((_, k) => this.customsFor(h.from?.[k]));
      if (to !== undefined && h.fees.length === 1) this.yardSlots(y).boxes.push(to);
      this.readyList(y).push(...ready);
      this.boxLooks(y).push(...h.looks);
      y.boxes.push(...h.fees);
      bayIncoming(y, true, -h.planned);
      this.stats.containers += h.fees.length;
      this.tip('customs');
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
  private gantryLifts(): Map<number, GantryWork & { yard: number }> {
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
  private handView(
    p: Dockhand,
  ): Pick<EntityView, 'handStage' | 'handPhase' | 'handTicks' | 'handAt'> {
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
  private palletPlaces(b: Bay, n = 0): number[] {
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
  private crateSlot(b: Bay, k: number, n = k + 1): number {
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
  private pickPallet(b: Bay, out: boolean, p?: Dockhand): number {
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
    for (let j = last; j >= 0; j--) {
      if (j * per >= from && (j + 1) * per <= to && !taken.has(places[j])) return j;
    }
    return last;
  }

  /**
   * The tile of crate storage the pallet a forklift takes is on (`pick`),
   * or the place the next goes: four pallets to a tile.
   */
  private palletTile(b: Bay, pick: boolean, coming = !pick, out = false, p?: Dockhand): number {
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
  private onPallet(p: Dockhand, b: Bay): number {
    if (p.kind !== 'forklift' || !b.tiles || b.yard) return Infinity;
    const j = this.pickPallet(b, !!p.outbound, p);
    return Math.min(B.FORKLIFT_CAPACITY, heldIn(b) - j * B.FORKLIFT_CAPACITY);
  }

  /**
   * Where in crate storage's crates, or its exports, `n` taken off it come
   * from: a forklift's whole pallet from wherever it is, its place left
   * free; else the last.
   */
  private takenFrom(p: Dockhand, b: Bay, n: number): number {
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
  private toPallet(p: Dockhand, b: Bay | undefined, pick: boolean): boolean {
    if (p.kind !== 'forklift' || !b?.tiles || b.yard) return false;
    const tile = this.palletTile(b, pick, false, !!p.outbound, p);
    return tile !== this.tileOf(p) && this.headTo(p, tile);
  }

  /**
   * The crate a forklift or dockhand takes, or the place it sets one down:
   * the last there, or the next place after it, as each shows its crates
   * in order; in crate storage a forklift's whole pallet (see storage).
   */
  private crateAt(p: Dockhand, pick: boolean): HandAt | undefined {
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
    if (pick) {
      const crane = this.cranes.get(p.craneIdx);
      if (crane?.kind === 'jib') return { crane: crane.idx, slot: crane.stack.length - 1 };
      const boat = this.boats.find((b) => b.id === p.boatId);
      if (boat) return onBoat(boat);
      const pile = this.piles.get(p.stockIdx);
      if (pile) return { pile: pile.idx, slot: pile.crates.length - 1 };
      const bay = this.bays.get(p.stockIdx);
      if (!bay) return undefined;
      // Off a truck bay's stack, as onto a truck there.
      return bay.tiles ? store(bay) : { bay: bay.idx, slot: last(bay.crates.length) };
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
  private handAt(p: Dockhand, pick: boolean): HandAt | undefined {
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
            look: this.stackLooks(crane)[Math.max(0, this.takingAt(p, crane))],
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
      const place = crane && crane.kind !== 'jib' ? this.nextCranePlace(crane, true) : undefined;
      return (crane && this.craneHand(p, crane)) ?? { crane: p.toCrane, place };
    }
    if (p.toBoat !== undefined && p.toBoat >= 0) return undefined;
    const yard = this.yards.get(p.bayIdx);
    if (!yard) return undefined;
    // Where it will be stacked, by when customs clear it.
    const ready = p.outbound ? undefined : (p.cargoReady?.[0] ?? this.customsFor(p.cargoFrom?.[0]));
    return { ...lane(yard), place: this.stackedAt(p, yard, ready) };
  }

  /**
   * The place in a yard a container a machine sets down goes: a stacker's
   * on a stack it reaches from where it stands, if there is room on one.
   */
  private stackedAt(p: Dockhand, yard: Bay, ready?: number): number {
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
  private cleanSlot(yard: Bay, at: number, ready: number): number {
    const { boxes, exports } = this.yardSlots(yard);
    return this.freeYardSlot(yard, boxes, exports, ready, this.reachFrom(yard, at), true);
  }

  /**
   * A tractor under a gantry crane stands where it is, in the bay between
   * the legs, lined up along the quay for the crane to lift onto or off it.
   */
  private craneHand(p: Dockhand, c: Crane): HandAt | undefined {
    if (p.kind !== 'tractor' || c.kind === 'jib') return undefined;
    return { crane: c.idx, along: this.quayHeading(c) };
  }

  /**
   * Where a machine stands to work a place on a gantry crane's stack: on
   * the landward row of its rails, behind the stack the place is in.
   */
  private besideStack(c: Crane, place: number): number {
    const m = this.map;
    const along = (place % craneStacks(c)) % B.GANTRY_RAILS;
    const back = gantryRails(m, c.idx, m.orient[c.idx] & 3)[along * 2 + 1];
    return back >= 0 && Number.isFinite(this.driveCost(back)) ? back : this.pickTile(c);
  }

  /** Which way the quay edge a container crane stands on runs, as a heading. */
  private quayHeading(c: Crane): number {
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
  private craneSpot(p: Dockhand, c: Crane, drop = false): number {
    // A stacker at a gantry crane goes along it to the stack it works: the
    // export on top it takes, or the next place for one it brings.
    if (p.kind === 'stacker' && c.kind === 'gantry') {
      const place = drop
        ? this.nextCranePlace(c, true)
        : this.cranePlaces(c).stack[this.craneTop(c, false)];
      return place === undefined || place < 0 ? this.pickTile(c) : this.besideStack(c, place);
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
      return deepest >= 0 ? deepest : (lane.find(free) ?? lane[0] ?? this.pickTile(c));
    }
    if (p.kind !== 'tractor' || c.kind !== 'harbour') return this.pickTile(c);
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
    return sides.find((t) => !this.spotTaken(t, p)) ?? sides[0] ?? this.pickTile(c);
  }

  /**
   * The row a gantry crane's rails run along behind its stack, on the
   * landward side of the containers it sets down: where tractors line up
   * along the quay for it to lift onto or off, the length of its rails. The
   * machines' ground only, nearest the bay between its legs first.
   */
  private craneLane(c: Crane): number[] {
    const m = this.map;
    const pick = this.pickTile(c);
    const ground = this.machineGround();
    return gantryRails(m, c.idx, m.orient[c.idx] & 3)
      .filter((t, k) => k % 2 === 1 && t >= 0 && ground.has(t))
      .sort((a, b) => this.dist(pick, a) - this.dist(pick, b));
  }

  /** Which way the lane under a yard's gantry runs, as a heading; see gantryLane. */
  private laneHeading(y: Bay): number | undefined {
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
  private gantryTractor(y: Bay): Dockhand | undefined {
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
  private liftedLoad(
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
  private yardLooks(
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
  private gantryElsewhere(t: Truck, bay: Bay): boolean {
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
  private gantryHolder(y: Bay): Vehicle | undefined {
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
  private gantryFor(p: Dockhand): boolean {
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
      this.keepGantryTo(y, this.stackedAt(p, y, this.customsFor(p.cargoFrom?.[0])));
      this.startLift(y, lane, this.slotAlong(y, y.gantryTo));
      p.timer = Math.max(1, this.takenIn(y));
    } else {
      const top = this.yardTop(y, true);
      p.timer = this.startLift(y, this.slotAlong(y, this.yardSlots(y).exports[top]), lane);
    }
    return true;
  }

  /** Keep a place in a yard for the container its gantry sets down. */
  private keepGantryTo(y: Bay, at: number): void {
    y.gantryTo = at >= 0 ? at : undefined;
  }

  /**
   * A lift done: the gantry is free for the next. Returns the place it kept
   * in the yard for the container it set down, if it did.
   */
  private gantryDone(bay: Bay | undefined, id: number): number | undefined {
    if (bay?.gantryOn !== id) return undefined;
    const to = bay.gantryTo;
    bay.gantryOn = bay.gantryTo = undefined;
    // It stands where it set the container down, for the next.
    if (bay.gantryLift) bay.gantryAt = bay.gantryLift.to;
    bay.gantryLift = undefined;
    return to;
  }

  /** Ticks a truck takes to load or unload one at a bay or yard: a yard gantry lifts at its own pace. */
  private truckTicks(t: Truck, bay: Bay): number {
    return t.boxes && bay.yard && this.yardGantry(bay) ? B.YARD_GANTRY_TICKS : loadTicks(bay);
  }

  /** A container truck at a yard with no gantry, which reach stackers load or unload. */
  private byStacker(t: Truck, bay: Bay): boolean {
    return t.boxes && !!bay.yard && !this.yardGantry(bay);
  }

  /**
   * A crate truck at a truck bay or crate storage, which only dockhands and
   * forklifts load: it has no crew of its own.
   */
  private byHand(t: Truck, bay: Bay): boolean {
    return !t.boxes && !bay.yard && !bay.pile;
  }

  /**
   * A crate truck loading at the truck bay a dockhand or forklift brings
   * crates to, with room for them all: they go straight onto it.
   */
  private straightOnto(p: Dockhand, bay: Bay): Truck | undefined {
    if (isBoxy(p) || p.outbound || p.truckId !== undefined || bay.tiles || p.carrying <= 0) {
      return undefined;
    }
    return this.trucks.find(
      (t) =>
        t.state === 'loading' &&
        t.bayIdx === bay.idx &&
        this.byHand(t, bay) &&
        t.cargo + (t.coming ?? 0) + p.carrying <= t.capacity,
    );
  }

  /**
   * Whether someone else is at work at this truck bay, setting crates down
   * on its stack or loading the truck in it: only one at a time works one.
   */
  private bayTaken(p: Dockhand, bay: Bay): boolean {
    if (bay.tiles || bay.yard || bay.pile) return false;
    return this.people.some(
      (q) =>
        q !== p &&
        ((q.state === 'dropping' && q.bayIdx === bay.idx) ||
          (q.truckId !== undefined && q.stockIdx === bay.idx && q.state === 'picking')),
    );
  }

  /** Crate trucks waiting to be loaded, for dockhands and forklifts. */
  private crateTruckSources(sources: Source[]): void {
    for (const t of this.trucks) {
      if (t.state !== 'loading') continue;
      const bay = this.dest(t.bayIdx);
      if (!bay || !this.byHand(t, bay)) continue;
      // Loaded from the stack till it is full or the stack is gone; crates
      // brought meanwhile go straight on while there is room on it.
      const avail = Math.min(
        t.capacity - t.cargo - (t.coming ?? 0),
        bay.crates.length - (bay.reserved ?? 0),
      );
      if (avail <= 0) continue;
      // Once the boats are seen to, nearest first, as crates in storage are.
      sources.push({ tile: this.crateTruckSpot(bay, t), avail, truck: t, load: true, rank: 1 });
    }
  }

  /**
   * Where a dockhand or forklift loading a crate truck takes the crates
   * from: the truck bay it stands in, or the tile of the crate storage
   * beside where it stands, nearest it.
   */
  private crateTruckSpot(bay: Bay, t: Truck): number {
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
  private takeCrateTruckJob(p: Dockhand, src: Source): boolean {
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
    const room = Math.min(
      t.capacity - t.cargo - (t.coming ?? 0),
      bay.crates.length - (bay.reserved ?? 0),
    );
    const n = Math.min(p.capacity, src.avail, room);
    if (n <= 0) return false;
    if (!this.headTo(p, src.tile)) return false;
    bay.reserved = (bay.reserved ?? 0) + n;
    t.coming = (t.coming ?? 0) + n;
    p.truckId = t.id;
    p.truckLoad = true;
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
  private crateTruckJob(p: Dockhand): boolean {
    const t = this.trucks.find((q) => q.id === p.truckId);
    const bay = this.dest(p.bayIdx);
    const live = !!t && !!bay && t.bayIdx === bay.idx && t.state === 'loading';
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
        const fees = bay.crates.splice(bay.tiles ? this.takenFrom(p, bay, n) : 0, n);
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

  /** Crates a dockhand or forklift has for a truck: on it if it is still loading, else back where they came from. */
  private landCrates(p: Dockhand, t: Truck | undefined, bay: Bay | undefined, live: boolean): void {
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
  private truckSources(sources: Source[]): void {
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
  private besideTruck(yard: Bay, t: Truck, load: boolean): number[] {
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
  private takeTruckJob(p: Dockhand, src: Source): boolean {
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
  private truckJob(p: Dockhand): boolean {
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
  private landTruckLoad(
    p: Dockhand,
    t: Truck | undefined,
    yard: Bay | undefined,
    live: boolean,
  ): void {
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
  private releaseTruckJob(p: Dockhand): void {
    if (p.truckId === undefined) return;
    const t = this.trucks.find((q) => q.id === p.truckId);
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

  private endTruckJob(p: Dockhand): void {
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

  /** Coasters and feeders, which tugs work in and out. */
  private needsTugs(b: Boat): boolean {
    return b.vessel === 'coaster' || b.vessel === 'feeder';
  }

  /**
   * A ship wanting a tug now: coming in the last stretch to its berth,
   * nearly unloaded (so the tug is there when it casts off), or pulling out.
   */
  private wantsTug(b: Boat): boolean {
    if (!this.needsTugs(b)) return false;
    const m = this.map;
    if (b.state === 'arriving') {
      return Math.hypot(m.xOf(b.berth) + 0.5 - b.x, m.yOf(b.berth) + 0.5 - b.y) < B.TUG_MEET;
    }
    const soon = b.state === 'moored' && b.crates + b.reserved <= B.TUG_CALL_LOAD;
    return soon || this.pullingOut(b);
  }

  /**
   * Ready to cast off: unless its tug is just about to come alongside, when
   * it waits that moment for it, or it has waited long enough.
   */
  private tugReady(b: Boat): boolean {
    const tug = this.tugs.find((t) => t.ship === b.id);
    if (!tug || tug.state !== 'out') return true;
    const close = Math.hypot(tug.x - b.x, tug.y - b.y) < B.VESSELS[b.vessel].length / 2 + 3;
    return !close || b.timer > 30 + B.TUG_WAIT;
  }

  /** A tug alongside, working this ship. */
  private tugged(b: Boat): boolean {
    return this.tugs.some((t) => t.ship === b.id && t.state === 'assist');
  }

  /**
   * How handy a ship is swinging round, crabbing in alongside and easing
   * off the dock: fully with a tug alongside (and a small boat always), much
   * less on its own.
   */
  private handiness(b: Boat): number {
    return !this.needsTugs(b) || this.tugged(b) ? 1 : B.UNTUGGED_HANDLING;
  }

  /** Buy a tug at a tug berth: the one at `tile`, or any without its tug. */
  private buyTug(tile?: number): void {
    if (this.tier < B.TUG_TIER) {
      return this.message(`Tugs unlock at the ${TIERS[B.TUG_TIER].name}.`, 'bad');
    }
    const m = this.map;
    const free = (i: number) =>
      m.build[i] === Build.TugBerth && !this.tugs.some((t) => t.home === i);
    let home = tile ?? -1;
    if (tile === undefined) {
      for (let i = 0; i < m.build.length && home < 0; i++) if (free(i)) home = i;
      if (home < 0) {
        return this.message('Build a tug berth first, in the water beside a jetty or quay.', 'bad');
      }
    } else if (tile < 0 || tile >= m.build.length || m.build[tile] !== Build.TugBerth) {
      return this.message('Click a tug berth to buy a tug there', 'bad');
    } else if (!free(tile)) {
      return this.message('That berth has its tug already. Each takes one.', 'bad');
    }
    if (this.cash < B.TUG_PRICE) return this.message('Not enough money', 'bad');
    this.book('construction', -B.TUG_PRICE);
    const name = `Tug ${TUG_NAMES[this.tugs.length % TUG_NAMES.length]}`;
    this.tugs.push({
      id: this.nextId++,
      name,
      home,
      ...this.tugBerthPose(home),
      goal: home,
      speed: 0,
      state: 'idle',
      ship: -1,
      path: [],
      plan: 0,
    });
    this.moneyAt(-B.TUG_PRICE, home);
    this.message(`${name} is ready at its berth.`, 'good');
  }

  /** Where a tug lies at its berth: in the middle, alongside the dock. */
  private tugBerthPose(home: number): { x: number; y: number; dir: number } {
    const m = this.map;
    const dock = m.neighbors4(home).find((n) => isDock(m.build[n])) ?? home;
    const out = Math.atan2(m.yOf(home) - m.yOf(dock), m.xOf(home) - m.xOf(dock));
    return { x: m.xOf(home) + 0.5, y: m.yOf(home) + 0.5, dir: wrapAngle(out + Math.PI / 2) };
  }

  private updateTugs(): void {
    // A tug whose berth has gone lies up at another free one, or is sold.
    for (const t of [...this.tugs]) {
      if (this.map.build[t.home] === Build.TugBerth) continue;
      const other = this.map.build.findIndex(
        (c, i) => c === Build.TugBerth && !this.tugs.some((q) => q.home === i),
      );
      if (other >= 0) {
        t.home = other;
        if (t.state === 'idle') t.state = 'back';
        t.path = [];
        t.plan = 0;
        continue;
      }
      this.tugs = this.tugs.filter((q) => q !== t);
      this.book('construction', B.TUG_PRICE / 2);
      this.message(
        `With its berth gone, ${t.name} was sold for $${(B.TUG_PRICE / 2).toLocaleString('en-US')}.`,
        'info',
      );
    }
    // Each ship wanting one gets the nearest free tug.
    for (const b of this.boats) {
      if (!this.wantsTug(b) || this.tugs.some((t) => t.ship === b.id)) continue;
      let best: Tug | undefined;
      for (const t of this.tugs) {
        if (t.ship >= 0) continue;
        if (!best || Math.hypot(t.x - b.x, t.y - b.y) < Math.hypot(best.x - b.x, best.y - b.y)) {
          best = t;
        }
      }
      if (!best) break;
      best.ship = b.id;
      best.state = 'out';
      best.path = [];
      best.plan = 0;
    }
    for (const t of this.tugs) this.updateTug(t);
  }

  private updateTug(t: Tug): void {
    const ship = t.ship >= 0 ? this.boats.find((b) => b.id === t.ship) : undefined;
    // Done, or no longer wanted: back to its berth.
    if (t.ship >= 0 && (!ship || !this.wantsTug(ship))) {
      t.ship = -1;
      t.state = 'back';
      t.path = [];
      t.plan = 0;
    }
    if (t.state === 'idle') return;
    if (t.state === 'back' || !ship) {
      const home = this.tugBerthPose(t.home);
      if (this.steerTug(t, home.x, home.y, t.home, true) < 0.08 && t.speed < 0.02) {
        Object.assign(t, home);
        t.speed = 0;
        t.state = 'idle';
        t.path = [];
      }
      return;
    }
    const spot = this.tugSpot(ship);
    if (t.state === 'out') {
      if (Math.hypot(spot.x - t.x, spot.y - t.y) > 0.9) {
        const goal = this.map.idx(
          clamp(Math.floor(spot.x), 0, this.map.w - 1),
          clamp(Math.floor(spot.y), 0, this.map.h - 1),
        );
        this.steerTug(t, spot.x, spot.y, goal, false);
        return;
      }
      t.state = 'assist';
    }
    // Alongside: keep station on the ship, swinging round with it.
    const dx = spot.x - t.x;
    const dy = spot.y - t.y;
    const d = Math.hypot(dx, dy);
    const step = Math.min(d, 0.2);
    if (d > 1e-6) {
      t.x += (dx / d) * step;
      t.y += (dy / d) * step;
    }
    t.dir = wrapAngle(t.dir + clamp(wrapAngle(spot.dir - t.dir), -0.12, 0.12));
    t.speed = ship.speed ?? 0;
  }

  /**
   * Where a tug works a ship: alongside, forward of midships, on the side
   * away from the dock it is coming alongside or leaving.
   */
  private tugSpot(b: Boat): { x: number; y: number; dir: number } {
    const m = this.map;
    const v = B.VESSELS[b.vessel];
    const fx = Math.cos(b.dir);
    const fy = Math.sin(b.dir);
    let px = -fy;
    let py = fx;
    const berth = b.state === 'leaving' ? b.castOff : b.berth;
    const dock = b.state === 'leaving' ? b.castDock : b.jetty;
    if (berth !== undefined && dock !== undefined && berth >= 0 && dock >= 0) {
      const ax = m.xOf(berth) - m.xOf(dock);
      const ay = m.yOf(berth) - m.yOf(dock);
      if (px * ax + py * ay < 0) {
        px = -px;
        py = -py;
      }
    }
    const along = v.length * 0.2;
    const off = v.beam / 2 + B.VESSELS.tug.beam / 2 + 0.05;
    return { x: b.x + fx * along + px * off, y: b.y + fy * along + py * off, dir: b.dir };
  }

  /**
   * Steer a tug towards x, y (in tile `goal`) the way a boat moves, nimbly:
   * along a route clear of hulls lying still, stopping for anything in its
   * way, and with `stop` set, coming to rest there. Returns how far it has
   * still to go.
   */
  private steerTug(t: Tug, gx: number, gy: number, goal: number, stop: boolean): number {
    const v = B.VESSELS.tug;
    const m = this.map;
    const way = this.seaWayFor(B.TUG_DRAFT, goal, null);
    const cost: CostFn = (i) => (i === t.home || i === goal ? 1 : way(i));
    const left = Math.hypot(gx - t.x, gy - t.y);
    // Plan the way there now and then: what it is meeting moves.
    if (--t.plan <= 0) {
      t.path = findPath(m.w, m.h, this.tileOf(t), goal, cost, true) ?? [];
      t.plan = 25;
    }
    const cx = (i: number) => (i % m.w) + 0.5;
    const cy = (i: number) => Math.floor(i / m.w) + 0.5;
    while (t.path.length > 1 && Math.hypot(cx(t.path[0]) - t.x, cy(t.path[0]) - t.y) < 0.7) {
      t.path.shift();
    }
    // The furthest of the next few waypoints with open water to it; the
    // last is the point itself.
    let ahead = 0;
    for (let k = 1; k < Math.min(t.path.length - 1, 4); k++) {
      if (!this.openWater(t.x, t.y, cx(t.path[k]), cy(t.path[k]), cost, v.beam / 2 + 0.05)) break;
      ahead = k;
    }
    t.path.splice(0, ahead);
    const [tx, ty] = t.path.length > 1 ? [cx(t.path[0]), cy(t.path[0])] : [gx, gy];
    const err = wrapAngle(Math.atan2(ty - t.y, tx - t.x) - t.dir);
    const turn = v.turn * (0.4 + (0.6 * t.speed) / v.speed);
    t.dir = wrapAngle(t.dir + clamp(err, -turn, turn));
    const accel = v.speed * B.BOAT_ACCEL * 2;
    let desired = v.speed * Math.max(0.2, Math.cos(Math.min(Math.abs(err), Math.PI / 2)) ** 2);
    // Easing off to stop there, or to come up alongside a ship under way.
    desired = Math.min(desired, stop ? Math.sqrt(2 * accel * left) + 0.003 : 0.03 + left * 0.1);
    // Stopping for boats moving in its way, but not the ship it is out to;
    // its route already keeps clear of those lying still.
    const me = {
      x: t.x,
      y: t.y,
      hx: Math.cos(t.dir),
      hy: Math.sin(t.dir),
      half: v.length / 2,
      beam: v.beam / 2,
    };
    const look = me.half + 0.4 + (t.speed * t.speed) / (2 * accel);
    // Held up a while, it noses on past for a spell.
    const held = this.tugHeld.get(t) ?? 0;
    const moving = (o: Boat) => (o.speed ?? 0) + (o.sternway ?? 0) > 0.01;
    const hulls =
      held < 0
        ? []
        : [
            ...this.boats.filter((o) => o.id !== t.ship && moving(o)).map((o) => this.hullOf(o)),
            ...this.tugs
              .filter((o) => o !== t && o.state !== 'idle')
              .map((o) => ({
                x: o.x,
                y: o.y,
                hx: Math.cos(o.dir),
                hy: Math.sin(o.dir),
                half: v.length / 2,
                beam: v.beam / 2,
              })),
          ];
    for (const h of hulls) {
      const gap = this.inWay(me, h, look);
      if (gap !== null) desired = Math.min(desired, Math.max(0, (gap - me.half - 0.15) * 0.2));
    }
    t.speed = clamp(t.speed + clamp(desired - t.speed, -accel * 1.5, accel), 0, v.speed);
    // Counting up while held, then down (below zero) while it noses past.
    const stuck = t.speed < 0.01 && left > 0.3;
    this.tugHeld.set(t, held < 0 ? held + 1 : stuck ? (held >= 40 ? -30 : held + 1) : 0);
    const nx = t.x + Math.cos(t.dir) * t.speed;
    const ny = t.y + Math.sin(t.dir) * t.speed;
    // Afloat in deep enough water; the margin round hulls is for routes.
    const water = this.boatCostFor(B.TUG_DRAFT);
    const afloat: CostFn = (i) => (i === t.home || i === goal ? 1 : water(i));
    if (this.navigable(nx, ny, afloat)) {
      t.x = nx;
      t.y = ny;
    } else t.speed = 0;
    return left;
  }

  /** Moving to x, y heading `dir` would bring the hull up against another boat's. */
  private crowds(b: Boat, x: number, y: number, dir = b.dir): boolean {
    const v = B.VESSELS[b.vessel];
    // Squeezing past as a last resort, through the boats it is wedged
    // against, but no nearer any other.
    return this.boats.some((o) => {
      const w = B.VESSELS[o.vessel];
      if (o === b || Math.hypot(o.x - x, o.y - y) > (v.length + w.length) / 2 + 1) return false;
      if (this.squeezingPast(b, o)) return false;
      const before = hullGap(b.x, b.y, b.dir, v, o.x, o.y, o.dir, w);
      const after = hullGap(x, y, dir, v, o.x, o.y, o.dir, w);
      return after < 0.1 && after < before;
    });
  }

  /**
   * Another boat with right of way over this one, under way but held up a
   * while, with this one in the water it would go on into.
   */
  private inWayOfHeld(b: Boat): Boat | undefined {
    const me = this.hullOf(b);
    return this.boats.find((o) => {
      if (o === b || o.state === 'moored' || o.state === 'anchored') return false;
      if ((o.held ?? 0) <= 20 || !this.outranks(o, b)) return false;
      if (Math.hypot(o.x - b.x, o.y - b.y) > 6) return false;
      const ov = B.VESSELS[o.vessel];
      const look = ov.length / 2 + 0.6 + ov.speed / (2 * B.BOAT_ACCEL);
      return this.inWay(this.wakeOf(o), me, look) !== null;
    });
  }

  /**
   * Wedged in for good: squeeze past the boats it is wedged against, for a
   * while, as a last resort so the harbour never locks up. Only those: it
   * keeps clear of any other that comes near meanwhile.
   */
  private startSqueeze(b: Boat): void {
    const v = B.VESSELS[b.vessel];
    b.squeeze = 200;
    // Never over a boat lying still, moored or at anchor.
    b.squeezePast = this.boats
      .filter(
        (o) =>
          o !== b &&
          o.state !== 'moored' &&
          o.state !== 'anchored' &&
          hullGap(b.x, b.y, b.dir, v, o.x, o.y, o.dir, B.VESSELS[o.vessel]) < B.WEDGED_GAP,
      )
      .map((o) => o.id);
  }

  /** Squeezing past this boat, one it was wedged against; see startSqueeze. */
  private squeezingPast(b: Boat, o: Boat): boolean {
    return (b.squeeze ?? 0) > 0 && !!b.squeezePast?.includes(o.id);
  }

  /** Boats lying still near this one, that its hull must keep clear of. */
  private stillNear(b: Boat): Boat[] {
    const v = B.VESSELS[b.vessel];
    return this.boats.filter(
      (o) =>
        o !== b &&
        o.state === 'moored' &&
        Math.hypot(o.x - b.x, o.y - b.y) < v.length + B.VESSELS[o.vessel].length / 2 + 2,
    );
  }

  /**
   * The rules of the road, roughly as at sea. Every boat under way plots
   * where it will be over the next while, and keeps a lookout for any other
   * boat whose plot comes too close to its own. Then whoever has to keep
   * clear (see burden) eases off, as far as it takes for the other to pass
   * ahead of it; meeting head on, both alter to starboard, so they pass
   * port to port. A boat with right of way holds its course and speed, but
   * acts too when a collision is close and the other has not. Returns a
   * turn to add (starboard positive) and a share of speed to keep.
   */
  private rulesOfTheRoad(b: Boat): { bias: number; slow: number } {
    const mine = this.plot(b, 1);
    let bias = 0;
    /** Plots of the boats to keep clear of, and the first of those boats. */
    const clearOf: [Boat, Float64Array][] = [];
    let first: { of: number; at: number } | undefined;
    for (const [o, theirs] of this.plots) {
      if (o === b || !this.underWay(theirs)) continue;
      const meet = this.meeting(b, mine, o, theirs);
      if (!meet) continue;
      const ticks = meet.at * B.PLOT_STEP;
      const duty = this.burden(b, o);
      const close = ticks <= B.STAND_ON_TICKS;
      if (duty === 'both') {
        // Head on: alter to starboard, the more the sooner they would meet.
        const urgency = clamp(1.3 - ticks / B.LOOKOUT_TICKS, 0, 1) * (meet.gap < 0 ? 1 : 0.6);
        bias += 1.2 * urgency;
      }
      if (duty === 'give' || close) {
        clearOf.push([o, theirs]);
        if (!first || meet.at < first.at) first = { of: o.id, at: meet.at };
      }
    }
    bias = clamp(bias, -0.9, 0.9);
    if (!first) {
      this.keepingClear.delete(b);
      return { bias, slow: 1 };
    }
    // The most way it can keep and still let every one of them by; failing
    // that, whatever puts off meeting the longest.
    let best = { pace: 1, at: -1 };
    for (const pace of [1, 0.75, 0.5, 0.3, 0.15, 0]) {
      const plot = pace === 1 ? mine : this.plot(b, pace);
      let at = Infinity;
      for (const [o, theirs] of clearOf) {
        at = Math.min(at, this.meeting(b, plot, o, theirs)?.at ?? Infinity);
      }
      if (at > best.at) best = { pace, at };
      if (at === Infinity) break;
    }
    this.keepingClear.set(b, { pace: best.pace, of: first.of });
    return { bias, slow: best.pace };
  }

  /**
   * Whether a plot goes anywhere. A boat lying stopped, waiting or keeping
   * clear, is a boat in the way like any other (see giveWay), not one to
   * plan round: planning round boats that are waiting on each other would
   * leave them all waiting.
   */
  private underWay(plot: Float64Array): boolean {
    const end = plot.length - 3;
    return Math.hypot(plot[end] - plot[0], plot[end + 1] - plot[1]) > 0.5;
  }

  /**
   * Draw every boat under way's plot for this tick, at the pace it keeps,
   * before the first of them moves.
   */
  private plotCourses(): void {
    if (this.plotsAt === this.tick) return;
    this.plotsAt = this.tick;
    this.plots.clear();
    for (const b of this.boats) {
      if (b.state === 'moored' || b.state === 'anchored') continue;
      // A boat that has lain still a while, waiting or swinging round where
      // it lies, or backing out of another's way, is plotted lying there
      // until it gets going ahead again: it is not coming on along its way.
      const v = B.VESSELS[b.vessel];
      const moving = (b.speed ?? 0) > v.speed * 0.1 && !b.astern;
      const still = moving ? 0 : (this.stillFor.get(b) ?? 0) + 1;
      this.stillFor.set(b, still);
      this.plots.set(b, this.plot(b, still > 10 ? 0 : (this.keepingClear.get(b)?.pace ?? 1)));
    }
  }

  /**
   * Where a boat under way will be, every PLOT_STEP ticks for LOOKOUT_TICKS,
   * as x, y, heading: along its route as it sails it (see sail), gathering
   * and taking off way, slowing for bends and to stop at its goal, and
   * swinging round no faster than it can turn. `pace` is the share of its
   * speed it keeps to. Running out along the dock, it goes straight out
   * keeping its heading and stops to turn at the end; casting off, it is
   * taken to lie where it is.
   */
  private plot(b: Boat, pace: number): Float64Array {
    const v = B.VESSELS[b.vessel];
    const n = Math.floor(B.LOOKOUT_TICKS / B.PLOT_STEP) + 1;
    const out = new Float64Array(n * 3);
    const w = this.map.w;
    const xs = [b.x];
    const ys = [b.y];
    const runOut = b.berthing === 'out' && b.lineup !== undefined;
    const route = b.undock ? [] : runOut ? [b.lineup!] : b.path;
    for (const i of route) {
      xs.push((i % w) + 0.5);
      ys.push(Math.floor(i / w) + 0.5);
    }
    const accel = v.speed * B.BOAT_ACCEL;
    const bend = (a: number) =>
      v.speed * Math.max(0.25, Math.cos(Math.min(Math.abs(a), Math.PI / 2)) ** 2);
    const stops = b.state !== 'leaving' || runOut;
    let x = b.x;
    let y = b.y;
    let d = b.dir;
    let speed = Math.max(0, (b.speed ?? 0) - (b.sternway ?? 0));
    let leg = 1;
    let left = 0;
    for (let k = 1; k < xs.length; k++) left += Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]);
    for (let t = 0; t < n * B.PLOT_STEP; t++) {
      if (t % B.PLOT_STEP === 0) {
        const s = (t / B.PLOT_STEP) * 3;
        out[s] = x;
        out[s + 1] = y;
        out[s + 2] = d;
      }
      if (leg >= xs.length) continue;
      const lx = xs[leg] - x;
      const ly = ys[leg] - y;
      const reach = Math.hypot(lx, ly);
      const along = Math.atan2(ly, lx);
      let desired = v.speed * (runOut ? 0.75 : 1);
      if (!runOut) {
        // Swings round onto the leg as it goes, slowing to turn.
        const err = wrapAngle(along - d);
        const turn = v.turn * (0.3 + (0.7 * speed) / v.speed);
        d = wrapAngle(d + clamp(err, -turn, turn));
        desired = bend(err);
        if (leg + 1 < xs.length) {
          const corner = wrapAngle(
            Math.atan2(ys[leg + 1] - ys[leg], xs[leg + 1] - xs[leg]) - along,
          );
          desired = Math.min(desired, Math.sqrt(bend(corner) ** 2 + 2 * accel * reach));
        }
      }
      if (stops) desired = Math.min(desired, Math.sqrt(2 * accel * left) + 0.004);
      speed += clamp(desired * pace - speed, -accel * B.BOAT_BRAKE, accel);
      speed = Math.max(0, speed);
      // Along the route, leg after leg.
      let go = Math.min(speed, left);
      left -= go;
      while (go > 0 && leg < xs.length) {
        const rx = xs[leg] - x;
        const ry = ys[leg] - y;
        const r = Math.hypot(rx, ry);
        if (r <= go) {
          x = xs[leg];
          y = ys[leg];
          go -= r;
          leg++;
        } else {
          x += (rx / r) * go;
          y += (ry / r) * go;
          go = 0;
        }
      }
    }
    return out;
  }

  /**
   * The first point at which two plots bring the hulls closer than they
   * should pass (or, already that close, closer still), and the least
   * clear water between them; null when they keep clear.
   */
  private meeting(
    b: Boat,
    mine: Float64Array,
    o: Boat,
    theirs: Float64Array,
  ): { at: number; gap: number } | null {
    const v = B.VESSELS[b.vessel];
    const w = B.VESSELS[o.vessel];
    const n = mine.length / 3;
    // Too far apart to meet within the lookout at all.
    const span = (v.speed + w.speed) * B.LOOKOUT_TICKS + (v.length + w.length) / 2 + 1;
    if (Math.hypot(theirs[0] - mine[0], theirs[1] - mine[1]) > span) return null;
    const reach = (v.length + w.length) / 2 + B.PASSING_GAP;
    let limit = B.PASSING_GAP;
    let at = -1;
    let least = Infinity;
    for (let k = 0; k < n; k++) {
      const s = k * 3;
      if (Math.hypot(theirs[s] - mine[s], theirs[s + 1] - mine[s + 1]) > reach) continue;
      const gap = hullGap(
        mine[s],
        mine[s + 1],
        mine[s + 2],
        v,
        theirs[s],
        theirs[s + 1],
        theirs[s + 2],
        w,
      );
      if (k === 0) {
        limit = Math.min(B.PASSING_GAP, gap - 0.05);
        continue;
      }
      least = Math.min(least, gap);
      if (gap < limit && at < 0) at = k;
    }
    return at < 0 ? null : { at, gap: least };
  }

  /**
   * Which of two boats under way keeps clear, as at sea: of `b`, whether it
   * gives way to `o`, stands on, or (meeting head on) both alter to
   * starboard. A boat handling, coming alongside or pulling out, goes
   * first, then the bigger ship. Between boats of a size the one
   * overtaking keeps clear, and of two crossing the one with the other on
   * its starboard side. Anything else goes by right of way (see outranks).
   */
  private burden(b: Boat, o: Boat): 'give' | 'stand' | 'both' {
    const handling = (q: Boat) => this.handling.has(q) || this.pullingOut(q);
    if (handling(b) !== handling(o)) return handling(b) ? 'stand' : 'give';
    if (handling(b)) return this.outranks(o, b) ? 'give' : 'stand';
    const lb = B.VESSELS[b.vessel].length;
    const lo = B.VESSELS[o.vessel].length;
    if (lb > lo * 1.3) return 'stand';
    if (lo > lb * 1.3) return 'give';
    // Where each sees the other, starboard positive.
    const seen = wrapAngle(Math.atan2(o.y - b.y, o.x - b.x) - b.dir);
    const seenBy = wrapAngle(Math.atan2(b.y - o.y, b.x - o.x) - o.dir);
    // More than two points abaft the beam: coming up from astern.
    const abaft = Math.PI * 0.625;
    if (Math.abs(seenBy) > abaft && Math.abs(seen) < abaft) return 'give';
    if (Math.abs(seen) > abaft && Math.abs(seenBy) < abaft) return 'stand';
    if (
      Math.abs(wrapAngle(o.dir - b.dir)) > 2.6 &&
      Math.abs(seen) < 0.5 &&
      Math.abs(seenBy) < 0.5
    ) {
      return 'both';
    }
    if (seen > 0 && seenBy < 0) return 'give';
    if (seen < 0 && seenBy > 0) return 'stand';
    return this.outranks(o, b) ? 'give' : 'stand';
  }

  /**
   * The best manoeuvre for a long ship from where it lies: ahead or astern,
   * helm hard over either way, half or amidships. Each is tried out over a
   * short run (ahead as far as `reach`, astern a tile and a half) and must
   * keep the hull clear all the way. Best first: ending nearest the target
   * and pointing at it. Empty when nothing has room.
   */
  private manoeuvre(
    b: Boat,
    tx: number,
    ty: number,
    tdir: number,
    speed: number,
    ships: Boat[],
    now: number,
    reach: number,
  ): { helm: number; astern: boolean; pivot?: boolean }[] {
    const v = B.VESSELS[b.vessel];
    // Slow, a ship turns tighter for the distance it covers.
    const s = Math.max(speed, v.speed * 0.25);
    const curve = (v.turn * (0.3 + (0.7 * s) / v.speed)) / s;
    const step = 0.25;
    const options: { helm: number; astern: boolean; pivot?: boolean; score: number }[] = [];
    // Last of all, with tugs, swing round where it lies, if there is room.
    const want = Math.hypot(tx - b.x, ty - b.y) > 1.5 ? Math.atan2(ty - b.y, tx - b.x) : tdir;
    // Judged by where the swing leaves it, as far round as it has room for.
    const swing = wrapAngle(want - b.dir);
    if (Math.abs(swing) > 0.05) {
      const n = Math.ceil(Math.abs(swing) / 0.15);
      let ok = true;
      for (let k = 1; k <= n && ok; k++) {
        ok = this.clips(b, b.x, b.y, b.dir + (swing * k) / n, ships) <= now;
      }
      if (ok) {
        const off = Math.abs(wrapAngle(want - b.dir - swing));
        // Tugs are a last resort, less so the further it has to come round.
        options.push({
          helm: Math.sign(swing),
          astern: false,
          pivot: true,
          score:
            Math.hypot(tx - b.x, ty - b.y) +
            off * 1.5 +
            (this.tugged(b) ? 0.5 : 2.5) * (1 - Math.abs(swing) / Math.PI),
        });
      }
    }
    for (const astern of [false, true]) {
      const run = astern ? 1.5 : Math.max(step, reach);
      for (const helm of [0, -0.5, 0.5, -1, 1]) {
        let x = b.x;
        let y = b.y;
        let d = b.dir;
        let ok = true;
        // Judged at its best moment along the run: nearest the target and
        // pointing at it, before it sails past.
        let score = Infinity;
        for (let t = step; t <= run + 1e-6; t += step) {
          // Astern the rudder bites less.
          d = wrapAngle(d + helm * curve * step * (astern ? 0.5 : 1));
          x += Math.cos(d) * step * (astern ? -1 : 1);
          y += Math.sin(d) * step * (astern ? -1 : 1);
          if (this.clips(b, x, y, d, ships) > now) {
            ok = false;
            break;
          }
          // Far off, point at the target; close to it, lie the way the
          // route goes on from there.
          const near = Math.hypot(tx - x, ty - y);
          const aim = near > 1.5 ? Math.atan2(ty - y, tx - x) : tdir;
          score = Math.min(score, near + Math.abs(wrapAngle(aim - d)) * 1.5);
        }
        // Astern costs a little, and so does changing between ahead and
        // astern, so it does not dither.
        const change = b.plan && !b.plan.pivot && b.plan.astern !== astern ? 0.75 : 0;
        if (ok) options.push({ helm, astern, score: score + (astern ? 1 : 0) + change });
      }
    }
    return options.sort((p, q) => p.score - q.score);
  }

  private navigable(x: number, y: number, cost: CostFn): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    return !this.map.inBounds(tx, ty) || Number.isFinite(cost(this.map.idx(tx, ty)));
  }

  /**
   * Open water all along a straight line, so the boat can cut the corner;
   * with `half` set, clear of the shore and docks that far either side of
   * it too, so the hull does not clip the corner of a dock on the way.
   */
  private openWater(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    cost: CostFn,
    half = 0,
  ): boolean {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.ceil(len / 0.25);
    const ox = len > 0 ? (-(y1 - y0) / len) * half : 0;
    const oy = len > 0 ? ((x1 - x0) / len) * half : 0;
    const m = this.map;
    const shore: CostFn = (i) =>
      m.isLand(i) || (m.build[i] !== Build.None && !isBuoy(m.build[i])) ? Infinity : 1;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      if (!this.navigable(x, y, cost)) return false;
      if (
        half > 0 &&
        !(this.navigable(x + ox, y + oy, shore) && this.navigable(x - ox, y - oy, shore))
      ) {
        return false;
      }
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
   * Right of way: a boat pulling out of its berth goes first, then boats
   * leaving, boats coming in to a berth and those heading for the
   * anchorage; going the same way, the bigger ship, then the one that came
   * first. Boats lying still never move for anyone.
   */
  private outranks(a: Boat, b: Boat): boolean {
    const state = (q: Boat) =>
      q.state === 'leaving' ? 3 : q.state === 'arriving' ? 2 : q.state === 'approaching' ? 1 : 0;
    const rank = (q: Boat) => [this.pullingOut(q) ? 1 : 0, state(q), B.VESSELS[q.vessel].length];
    const ra = rank(a);
    const rb = rank(b);
    for (let k = 0; k < ra.length; k++) if (ra[k] !== rb[k]) return ra[k] > rb[k];
    return a.id < b.id;
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
  private giveWay(b: Boat): { speed: number; makeWay: number; still?: boolean; by?: Boat } {
    const me = this.hullOf(b);
    const v = B.VESSELS[b.vessel];
    // Looks out as far as it takes to stop gently from full speed, so it
    // eases off early rather than pulling up short.
    const accel = v.speed * B.BOAT_ACCEL;
    const stopping = (v.speed * v.speed) / (2 * accel);
    const look = me.half + 0.6 + stopping;
    let speed = 1;
    /** Id of the boat to back out of the way of, or -1. */
    let makeWay = -1;
    /** Brought up short by a boat lying still. */
    let stopped = false;
    /** The moored ship it stopped for, if one did. */
    let stoppedBy: Boat | undefined;
    /** The boat that holds it back most. */
    let by: Boat | undefined;
    // Held up a while beside the clear water off moored boats' ends, it goes
    // on past them minding only their hulls, until it is clear of them all:
    // counted however it creeps meanwhile, so it does not stop again at
    // every nudge forward.
    const patient = (b.keptFor ?? 0) < B.KEEP_CLEAR_PATIENCE;
    /** Beside such water still, and held up by it alone. */
    let byEnds = false;
    let heldByEnds = false;
    // Wedged in for most of a day: a last resort so the harbour never locks
    // up for good. It squeezes past.
    const wedged = (b.squeeze ?? 0) > 0;
    const m = this.map;
    // A long ship whose way goes on behind it is coming round: one lying
    // still off its bow is not in its way, as it swings away from it, its
    // whole hull minding that one as it goes (see sail).
    const next = b.path[0];
    const comingRound =
      v.length >= B.CAREFUL_LENGTH &&
      next !== undefined &&
      Math.cos(Math.atan2(m.yOf(next) + 0.5 - b.y, m.xOf(next) + 0.5 - b.x) - b.dir) < 0;
    this.roomWait.delete(b);
    for (const o of this.boats) {
      if (o === b) continue;
      const other = this.hullOf(o);
      const still = o.state === 'moored' || o.state === 'anchored';
      // Squeezing past the boats under way it is wedged against, never over
      // one lying still, nor into one only coming its way.
      if (wedged && !still && this.squeezingPast(b, o)) continue;
      if (comingRound && still) continue;
      // Keep out of the water a ship pulling out of its berth has claimed,
      // stopping short of it; already inside and heading further in, back
      // out. A boat coming in to a berth inside it has to pass through.
      const bound =
        o.room &&
        b.state === 'arriving' &&
        b.berth >= 0 &&
        o.room.spots.some(
          ([x, y, r]) => Math.hypot(m.xOf(b.berth) + 0.5 - x, m.yOf(b.berth) + 0.5 - y) < r + 1,
        );
      if (o.room && !bound && this.outranks(o, b)) {
        // Running out along the dock it may be going astern: look that way.
        const into = this.intoRoom(b.berthing === 'out' ? this.wakeOf(b) : me, o.room.spots, look);
        if (into !== null) {
          this.roomWait.add(b);
          if (into < 0) {
            if (makeWay < 0) makeWay = o.id;
            speed = 0;
          } else {
            speed = Math.min(
              speed,
              clamp(Math.sqrt(2 * accel * Math.max(0, into - 0.3)) / v.speed, 0, 1),
            );
          }
        }
      }
      // Off a moored boat's bow and stern lies clear water it keeps to
      // itself; a boat already in it, casting off beside it, need only
      // keep clear of the hull.
      // Held up by that alone a while, it goes on past, clear of the hull.
      // Running out along the dock it passes the berths beside it like
      // one casting off, minding only their hulls.
      const ends =
        still && b.berthing !== 'out'
          ? this.inWay(me, { ...other, half: other.half + B.BERTH_END_GAP }, look)
          : null;
      if (ends !== null) byEnds = true;
      const kept = patient ? ends : null;
      const ahead = kept !== null && kept > 0 ? kept : this.inWay(me, other, look);
      if (ahead !== null) {
        const gap = ahead - me.half;
        // Stop for anything lying still or with right of way; otherwise only
        // short of touching, while the other one gets out of the way.
        const yields = still || this.outranks(o, b);
        const room = yields ? 0.3 : 0.08;
        if (yields) {
          // As fast as still lets it stop in time, braking at its ordinary
          // rate, plus however fast the other is drawing away.
          const away = still
            ? 0
            : Math.max(0, ((o.speed ?? 0) - (o.sternway ?? 0)) * Math.cos(o.dir - b.dir));
          const safe = away + Math.sqrt(2 * accel * Math.max(0, gap - room));
          const slow = clamp(safe / v.speed, 0, 1);
          if (slow < speed) by = o;
          speed = Math.min(speed, slow);
          if (still && speed <= 0.05) {
            stopped = true;
            if (o.state === 'moored') stoppedBy = o;
          }
          if (kept !== null && kept > 0 && speed <= 0.1) {
            heldByEnds = true;
            // Held off the clear water at its end: waiting on it all the same.
            if (o.state === 'moored') stoppedBy ??= o;
          }
        } else {
          const slow = clamp((gap - room) / 0.5, 0, 1);
          if (slow < speed) by = o;
          speed = Math.min(speed, slow);
        }
      }
      // Something with right of way is held up, and this boat is in its way;
      // or a boat backing out of the way of one that outranks this one needs
      // this one to back too. The boat at the head of a chain always
      // outranks the rest, so no ring of boats ends up all waiting astern.
      if (makeWay >= 0 || still || (o.held ?? 0) <= 20) continue;
      const head = this.outranks(o, b)
        ? o.id
        : o.astern && o.yieldFor !== undefined
          ? o.yieldFor
          : -1;
      const lead = head === o.id ? o : this.boats.find((q) => q.id === head);
      if (!lead || lead === b || !this.outranks(lead, b)) continue;
      // As far ahead as that one looks out: out of its way, not just off its bow.
      const ov = B.VESSELS[o.vessel];
      const theirs = other.half + 0.6 + (ov.speed * ov.speed) / (2 * ov.speed * B.BOAT_ACCEL);
      if (this.inWay(this.wakeOf(o), me, Math.max(other.half + 0.8, theirs)) !== null) {
        makeWay = head;
      }
    }
    if (b.keptTick !== this.tick) {
      b.keptTick = this.tick;
      const past = (b.keptFor ?? 0) >= B.KEEP_CLEAR_PATIENCE;
      b.keptFor = heldByEnds || (past && byEnds) ? (b.keptFor ?? 0) + 1 : 0;
    }
    const held = stopped && speed <= 0.05;
    if (b.waitedAt !== this.tick) {
      b.waitedAt = this.tick;
      this.countWait(b, b.state === 'arriving' && speed <= 0.1 ? stoppedBy : undefined);
    }
    return { speed, makeWay, still: held, by };
  }

  /**
   * Count how long a ship coming in has been held up by moored ship `by`:
   * all the while it gets no further on, however it creeps or is let past
   * the clear water off that one's end a moment and stopped again; and from
   * nothing again once it is well on its way, the other has sailed, or it
   * is held up by another.
   */
  private countWait(b: Boat, by: Boat | undefined): void {
    const waiting = b.waitingOn !== undefined && this.boats.find((q) => q.id === b.waitingOn);
    const from = b.waitedFrom;
    const moved = from ? Math.hypot(b.x - from[0], b.y - from[1]) : Infinity;
    const still =
      !!waiting && waiting.state === 'moored' && b.state === 'arriving' && moved < B.WAIT_CREEP;
    if (by && by.id !== b.waitingOn) {
      b.waitingOn = by.id;
      b.waitedFor = 0;
      b.waitedFrom = [b.x, b.y];
    } else if (by || still) {
      b.waitedFor = (b.waitedFor ?? 0) + 1;
    } else {
      b.waitingOn = undefined;
      b.waitedFor = 0;
      b.waitedFrom = undefined;
    }
  }

  /**
   * A ship coming in that has waited a while for moored ship `b` to sail
   * out of its way, or undefined.
   */
  private waitingFor(b: Boat): Boat | undefined {
    return this.boats.find(
      (o) =>
        o.state === 'arriving' &&
        o.waitingOn === b.id &&
        (o.waitedFor ?? 0) > B.BERTH_BLOCKED_TICKS,
    );
  }

  /**
   * How far `me` can go ahead before its hull enters a room made of `spots`,
   * within `look` tiles; -1 when it is inside already and heading further
   * in, null when it is not heading into it.
   */
  private intoRoom(
    me: ReturnType<World['hullOf']>,
    spots: [number, number, number][],
    look: number,
  ): number | null {
    let into: number | null = null;
    for (const [x, y, radius] of spots) {
      const rx = x - me.x;
      const ry = y - me.y;
      const fwd = rx * me.hx + ry * me.hy;
      if (fwd <= 0) continue;
      const side = Math.abs(-rx * me.hy + ry * me.hx);
      const r = radius + me.beam;
      if (side >= r) continue;
      if (Math.hypot(rx, ry) < radius + me.half) return -1;
      const at = fwd - Math.sqrt(r * r - side * side) - me.half;
      if (at <= look) into = Math.min(into ?? Infinity, Math.max(0, at));
    }
    return into;
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
    return this.seaWayFor(b.draft, b.goal, b, strict);
  }

  /** Open water for a hull of this draft heading for `goal`; see seaWay. */
  private seaWayFor(draft: number, goal: number, self: Boat | null, strict = false): CostFn {
    const base = this.boatCostFor(draft);
    // Strict: every other hull is off limits, moving ones included.
    const still = this.boats
      .filter((o) => o !== self && (strict || o.state === 'moored' || o.state === 'anchored'))
      .map((o) => this.hullOf(o));
    const wide = this.wideOf(self);
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
      return i === goal ? c : c + wide(i);
    };
  }

  /**
   * What a route pays over open water to pass this close to the corner of
   * a pier, quay or the shore, or to a boat lying at its berth (other than
   * `self`): boats come round them in a wide circle, wider still where a
   * boat lies off the corner, rather than shave them.
   */
  private wideOf(self: Boat | null): CostFn {
    const ring = this.cornerRing();
    const moored = this.boats
      .filter((o) => o !== self && o.state === 'moored')
      .map((o) => this.hullOf(o));
    const w = this.map.w;
    return (i) => {
      const x = (i % w) + 0.5;
      const y = Math.floor(i / w) + 0.5;
      for (const h of moored) {
        const rx = x - h.x;
        const ry = y - h.y;
        const fwd = Math.abs(rx * h.hx + ry * h.hy);
        const side = Math.abs(-rx * h.hy + ry * h.hx);
        if (fwd < h.half + 0.6 + B.MOORED_CLEAR && side < h.beam + 0.8 + B.MOORED_CLEAR) {
          return ring[i] + B.MOORED_CLEAR_COST;
        }
      }
      return ring[i];
    };
  }

  /**
   * For each tile of water, what a route pays over open water for passing
   * this close to the corner of a jetty or quay: its end, say, with water
   * on two sides of it that meet; or this close to the bare shore, which
   * boats keep a tile or two off rather than brush along. Not the water
   * along a dock, nor in a corner between two. Derived from the map, so
   * not saved.
   */
  private cornerRing(): Float32Array {
    if (this.ringCache) return this.ringCache;
    const m = this.map;
    const out = new Float32Array(m.build.length);
    const hard = (x: number, y: number) => {
      if (!m.inBounds(x, y)) return false;
      const i = m.idx(x, y);
      return m.isLand(i) || (m.build[i] !== Build.None && !isBuoy(m.build[i]));
    };
    const water = (x: number, y: number) => m.inBounds(x, y) && m.ocean[m.idx(x, y)] && !hard(x, y);
    const r = Math.ceil(B.CORNER_CLOSE);
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const b = m.build[m.idx(x, y)];
        if (b === Build.None || isBuoy(b)) continue;
        const wx = water(x - 1, y) || water(x + 1, y);
        const wy = water(x, y - 1) || water(x, y + 1);
        if (!wx || !wy) continue;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (!water(x + dx, y + dy)) continue;
            const d = Math.hypot(dx, dy);
            const c =
              d < B.CORNER_NEAR ? B.CORNER_NEAR_COST : d < B.CORNER_CLOSE ? B.CORNER_CLOSE_COST : 0;
            const j = m.idx(x + dx, y + dy);
            out[j] = Math.max(out[j], c);
          }
        }
      }
    }
    // Off the bare shore: land with no dock on it, by how near its edge is.
    const shore = (x: number, y: number) => {
      if (!m.inBounds(x, y)) return false;
      const i = m.idx(x, y);
      return m.isLand(i) && !isDock(m.build[i]);
    };
    const reach = Math.ceil(B.SHORE_CLOSE);
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        if (!water(x, y)) continue;
        let d = Infinity;
        for (let dy = -reach; dy <= reach; dy++) {
          for (let dx = -reach; dx <= reach; dx++) {
            if (!shore(x + dx, y + dy)) continue;
            // From the middle of this tile to the nearest edge of that one.
            d = Math.min(
              d,
              Math.hypot(Math.max(0, Math.abs(dx) - 0.5), Math.max(0, Math.abs(dy) - 0.5)),
            );
          }
        }
        const c = d < B.SHORE_NEAR ? B.SHORE_NEAR_COST : d < B.SHORE_CLOSE ? B.SHORE_CLOSE_COST : 0;
        const j = m.idx(x, y);
        out[j] = Math.max(out[j], c);
      }
    }
    return (this.ringCache = out);
  }

  /**
   * The lane of water a boat comes alongside along: the row of a berth on
   * the long side of a jetty, or the column of one off its end. One boat at
   * a time moves in each lane, so boats in different lanes, even at the same
   * dock, do not wait for each other.
   */
  private fairwayOf(jetty: number, berth: number): number | undefined {
    this.docks();
    if (!this.dockKey.has(jetty)) return undefined;
    const m = this.map;
    // Berth beside the jetty tile (east or west): a lane down that column.
    return m.yOf(berth) === m.yOf(jetty) ? 2 * m.xOf(berth) + 1 : 2 * m.yOf(berth);
  }

  /**
   * No other boat holds the fairway to this berth. Pulling out, a boat goes
   * ahead of one that holds it but is still well out from its berth: it is
   * clear of the lane before the other gets there.
   */
  private fairwayFree(b: Boat, jetty: number, berth: number, leaving = false): boolean {
    const key = this.fairwayOf(jetty, berth);
    const m = this.map;
    const far = (o: Boat) =>
      o.state === 'arriving' &&
      Math.hypot(m.xOf(o.berth) + 0.5 - o.x, m.yOf(o.berth) + 0.5 - o.y) > B.FAIRWAY_FAR;
    return (
      key === undefined ||
      !this.boats.some((o) => o !== b && o.fairway === key && !(leaving && far(o)))
    );
  }

  /** Take the fairway to this boat's berth if no other boat holds it. */
  private takeFairway(b: Boat, leaving = false): boolean {
    if (!this.fairwayFree(b, b.jetty, b.berth, leaving)) return false;
    b.fairway = this.fairwayOf(b.jetty, b.berth);
    return true;
  }

  private freeFairway(b: Boat): void {
    b.fairway = undefined;
    b.castOff = undefined;
    b.castDock = undefined;
  }

  /** Pulling out of its berth: casting off, running out along the dock or turning for sea. */
  private pullingOut(b: Boat): boolean {
    return b.state === 'leaving' && (b.undock !== undefined || b.berthing === 'out' || !!b.room);
  }

  /**
   * A ship pulling out of its berth claims the water it needs: the lane
   * ahead of it along the dock as it runs out, and the water all round
   * where it turns for sea, keeping that until it has come round onto its
   * course.
   */
  private claimRoom(b: Boat): void {
    const v = B.VESSELS[b.vessel];
    const m = this.map;
    if (b.turned || v.length < B.RUN_OUT_LENGTH) return;
    if (b.room && this.tick > b.room.until) {
      b.room = undefined;
      b.turned = true;
      return;
    }
    const turn = v.length / 2 + B.ROOM_MARGIN;
    const until = b.room?.until ?? this.tick + B.ROOM_TICKS;
    if (b.berthing === 'out' && b.lineup !== undefined) {
      const ex = m.xOf(b.lineup) + 0.5;
      const ey = m.yOf(b.lineup) + 0.5;
      const n = Math.ceil(Math.hypot(ex - b.x, ey - b.y) / 0.5);
      const lane = v.beam / 2 + 0.5;
      const spots: [number, number, number][] = [];
      for (let k = 0; k < n; k++) {
        spots.push([b.x + ((ex - b.x) * k) / n, b.y + ((ey - b.y) * k) / n, lane]);
      }
      spots.push([ex, ey, turn]);
      b.room = { spots, until };
      return;
    }
    if (b.room?.turning) {
      const target = b.path[0] ?? b.goal;
      const course = Math.atan2(m.yOf(target) + 0.5 - b.y, m.xOf(target) + 0.5 - b.x);
      const [x, y, r] = b.room.spots[0];
      const round = Math.abs(wrapAngle(course - b.dir)) < 0.3;
      const out = Math.hypot(b.x - x, b.y - y) > r;
      if (round || out) {
        b.room = undefined;
        b.turned = true;
      }
      return;
    }
    // Off the berth, or at the end of its run out: room to turn.
    if (b.castOff !== undefined && b.undock === undefined) {
      b.room = { spots: [[b.x, b.y, turn]], until, turning: true };
    }
  }

  private depart(b: Boat, gaveUp: boolean): void {
    this.judgeVisit(b, gaveUp);
    this.departTips();
    // Leaving with containers still on board: customs start on those it landed.
    if (b.vessel === 'feeder') this.shipUnloaded(b);
    if (b.state === 'moored') {
      b.castOff = b.berth;
      b.castDock = b.jetty;
      b.undock = 1;
      this.planRunOut(b);
    } else this.freeFairway(b);
    b.state = 'leaving';
    b.berth = b.jetty = -1;
    const edge = this.seaEdgeTiles();
    const from = this.tileOf(b);
    // Out past the red buoys, then off the map level with the last of them.
    const stops = this.buoyStops(b, from, -1, this.seaWay(b));
    const last = stops.at(-1) ?? from;
    // Each boat keeps to a lane of its own out at sea, a few rows either
    // side, so departures do not all converge on one point. Crossing
    // between a pair of buoys it is in its lane already.
    const crossed = stops.length > 0 && !isBuoy(this.map.build[last]);
    const lane = this.map.yOf(last) + (crossed ? 0 : (((b.id * 7) % 9) - 4) * B.EXIT_LANES);
    const exit = edge.reduce(
      (best, i) =>
        Math.abs(this.map.yOf(i) - lane) < Math.abs(this.map.yOf(best) - lane) ? i : best,
      edge[0],
    );
    b.goal = exit;
    b.path = this.via(from, stops, exit, this.byDocks(this.seaWay(b), from, exit)) ?? [];
    b.sailed = 0;
    b.best = Infinity;
  }

  /** Not where another boat is, so none goes out of sight beside one. */
  private outOfSight(b: Boat): boolean {
    return this.boats.every(
      (o) => o === b || Math.hypot(o.x - b.x, o.y - b.y) > B.VESSELS[o.vessel].length + 2,
    );
  }

  /**
   * How many tiles from the start of a way in from sea a boat comes into
   * sight, B.SAIL_IN_TILES of it from the end. Not where another boat is,
   * so none comes into sight on top of one.
   */
  private inSight(b: Boat, path: number[]): number {
    const m = this.map;
    let left = 0;
    for (let k = path.length - 1; k > 0; k--) {
      left += Math.hypot(m.xOf(path[k]) - m.xOf(path[k - 1]), m.yOf(path[k]) - m.yOf(path[k - 1]));
      if (left < B.SAIL_IN_TILES) continue;
      const x = m.xOf(path[k - 1]) + 0.5;
      const y = m.yOf(path[k - 1]) + 0.5;
      if (
        this.boats.every(
          (o) => o === b || Math.hypot(o.x - x, o.y - y) > B.VESSELS[o.vessel].length + 2,
        )
      ) {
        return k;
      }
    }
    return 0;
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
      stockIdx: -1,
      bayIdx: -1,
      toBoat: -1,
      toCrane: -1,
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
    this.tip(kind === 'forklift' ? 'forklifts' : kind === 'tractor' ? 'tractors' : 'stackers');
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
      // Routine: the machine says so when picked, and shows a warning sign.
      if (this.goToDepot(p, 'repair')) return true;
      // No depot to reach: a mechanic comes out, at double the price.
      this.startRepair(p, B.REPAIR_COST * 2);
      this.nag(
        'callout',
        `${p.name} has broken down with no depot to reach. Mechanic called out at double the price.`,
        'bad',
      );
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
  /** Where port machines may be at all: port roads and quays, off the stacks in a container yard. */
  private groundCost: CostFn = (i) =>
    drivable(this.map.build[i]) && !storesBoxes(this.map.store[i]) ? 1 : Infinity;

  /**
   * Port machines drive on port roads and quays, never across the stacks in
   * a container yard; and across containers a gantry crane has set down
   * along the quay only where there is no other way at all, as on a pier
   * too narrow for anything else.
   */
  private driveCost: CostFn = (i, from) => {
    // Never across a yard gantry's rails, as trucks never do.
    if (from !== undefined && from >= 0 && this.crossesRails(from, i)) return Infinity;
    return this.groundCost(i) + (this.craneStackTiles().has(i) ? B.CRANE_STACK_DETOUR : 0);
  };

  /**
   * The quay with containers on it that a gantry crane has set down: on the
   * shipside row the length of its rails, which the machines work from the
   * row behind. Where none stand yet they drive freely.
   * Once a tick.
   */
  private craneStackTiles(): Set<number> {
    if (this.craneStackCache?.tick !== this.tick) {
      const m = this.map;
      const at = new Set<number>();
      for (const c of this.cranes.values()) {
        if (c.kind !== 'gantry') continue;
        const rails = gantryRails(m, c.idx, m.orient[c.idx] & 3);
        const { stack, out } = this.cranePlaces(c);
        for (const k of [...stack, ...out]) {
          const t = k < 0 ? -1 : rails[((k % craneStacks(c)) % B.GANTRY_RAILS) * 2];
          if (t >= 0) at.add(t);
        }
      }
      this.craneStackCache = { tick: this.tick, at };
    }
    return this.craneStackCache.at;
  }

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
    // A machine a crane has just set a container down beside is not lost.
    const cost = isMachine(p) ? this.groundCost : this.costFor(p);
    if (Number.isFinite(cost(this.tileOf(p)))) return false;
    const at = isMachine(p) && p.home >= 0 ? p.home : this.muster();
    p.x = this.map.xOf(at) + 0.5;
    p.y = this.map.yOf(at) + 0.5;
    p.path = [];
    return true;
  }

  private walk(p: Dockhand) {
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
  private laneCap(i: number): number {
    const b = this.map.build[i];
    return isBay(b) || this.map.store[i] || b === Build.BreakHut || b === Build.Depot
      ? B.GATHER_CAP
      : 1;
  }

  private laneFree(i: number, lane: number): boolean {
    return this.occupancy[i * 4 + lane] < this.laneCap(i);
  }

  /** Any lane of the tile in use at all. */
  private tileBusy(i: number): boolean {
    const o = this.occupancy;
    return o[i * 4] + o[i * 4 + 1] + o[i * 4 + 2] + o[i * 4 + 3] >= this.laneCap(i);
  }

  /**
   * A reach stacker or tractor held up in traffic: after a while it looks
   * for a way round whatever is standing in its way, and if it is still
   * held up long after, it squeezes on past, so nothing is stuck for good.
   */
  private resolveHold(p: Dockhand): void {
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
  private standingTiles(): Set<number> {
    const out = new Set<number>();
    for (const o of this.trucks) if (this.docked(o)) out.add(this.tileOf(o));
    for (const q of this.people) {
      if (isBoxy(q) && (q.state === 'picking' || q.state === 'dropping')) out.add(this.tileOf(q));
    }
    return out;
  }

  /** A machine standing idle in someone's way drives off home to park now, rather than in a while. */
  private makeWay(o: Vehicle): void {
    if (!isTruck(o) && o.state === 'idle' && o.path.length === 0) o.timer = B.PARK_AFTER;
  }

  /** The port machines that drive in traffic, wherever they are other than parked at their depot. */
  private machinesOnRoad(): Dockhand[] {
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
  private roomAhead(p: Dockhand): number {
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
  private workingAt(i: number, p: Dockhand): Dockhand | undefined {
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
  private spotTaken(i: number, p: Dockhand): boolean {
    return this.people.some(
      (q) =>
        q !== p &&
        isBoxy(q) &&
        (((q.state === 'picking' || q.state === 'dropping') && this.tileOf(q) === i) ||
          ((q.state === 'toPickup' || q.state === 'toDrop') && q.goal === i)),
    );
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
    if (p.kind === 'tractor') {
      // At a yard its gantry lifts it; under a gantry crane it waits for the
      // crane to (see serveTractor); a harbour crane sets it straight on.
      const yard = this.yards.get(p.state === 'picking' ? p.stockIdx : p.bayIdx);
      if (yard) return B.YARD_GANTRY_TICKS * Math.max(1, p.planned);
      if (this.underGantry(p)) return B.TRACTOR_WAIT_TICKS;
      return base;
    }
    if (p.kind === 'stacker') return Math.round(base * 2.5);
    if (p.kind === 'forklift') return Math.round(base * 1.5);
    return Math.max(1, Math.round(base * traitDef(p.trait).handling));
  }

  /** How far through picking a load up or setting one down a worker is, 0 to 1. */
  private handlingPhase(p: Dockhand): number | undefined {
    if (p.state !== 'picking' && p.state !== 'dropping') return undefined;
    const total = this.handlingTicks(p, p.state === 'picking' ? B.PICK_TICKS : B.DROP_TICKS);
    return clamp(1 - p.timer / total, 0, 1);
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
    if (!this.tipsSeen.has('hut')) this.tipUnless('hut', this.map.build.includes(Build.BreakHut));
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
  private lineUpAt(goal: number): [number, number] | null {
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
  private tileBehind(p: Dockhand): number {
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
  private roomToTurn(i: number): boolean {
    const m = this.map;
    if (m.build[i] === Build.Depot || isCrane(m.build[i])) return true;
    if (this.yardLaneTiles().has(i)) return false;
    return this.lineUpAt(i) !== null || this.gantryRailWays().has(i);
  }

  /** Every tile of the lanes under the yard gantries. Cleared when the port changes. */
  private yardLaneTiles(): Set<number> {
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
  private laneThrough(y: Bay): boolean {
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

  private updateDockhand(p: Dockhand): void {
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
          const top = crane && crane.kind !== 'jib' ? this.craneTop(crane, false, p) : -1;
          p.takeAt = top >= 0 ? this.cranePlaces(crane!).stack[top] : undefined;
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
          const clears = (k: number) => p.cargoReady?.[k] ?? this.customsFor(from[k]);
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
          onto.cargo += p.carrying;
          onto.value += p.cargoFees.reduce((n, f) => n + f, 0);
          (onto.fees ??= []).push(...p.cargoFees);
          onto.idle = 0;
        } else (boxy ? bay.boxes : bay.crates).push(...p.cargoFees);
        if (boxy) this.tip('customs');
        if (bay.pile) this.tip('landed');
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

  private headTo(p: Dockhand, goal: number): boolean {
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
  private diagnose(p: Dockhand): void {
    const here = this.tileOf(p);
    const boxy = isBoxy(p);
    const what = p.kind === 'tractor' ? 'Terminal tractors' : boxy ? 'Reach stackers' : 'Forklifts';
    const reach = (goal: number) => !!this.pathFor(p, here, goal);
    const sources: number[] = [];
    for (const c of this.cranes.values()) {
      if ((c.kind !== 'jib') === boxy && c.stack.length > 0) sources.push(this.pickTile(c));
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
      this.message(`${p.name}: ${stuck}.`, 'bad');
    }
  }

  /** Whether another dockhand stands within a step of this one, or it stands in a truck bay. */
  private crowded(p: Dockhand): boolean {
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
  private spreadOut(p: Dockhand): void {
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

  /**
   * Crane landing stacks first (they free the crane), then moored boats, then
   * cargo landed on the quay. Only dockhands unload boats: forklifts take on
   * what the dockhands and jib cranes have landed.
   */
  private assignJob(p: Dockhand): boolean {
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
      const ship = p.kind === 'tractor' ? (this.shipFor(crane)?.left ?? 0) : 0;
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
        const avail = store.crates.length - (store.reserved ?? 0);
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
    const moored = (s: Source) => s.boat?.mooredTicks ?? -1;
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
        if (!this.dueAt(p, src.crane, src.tile)) continue;
      } else if (this.workersAt(src.tile) >= B.WORKERS_PER_SPOT) continue;
      // A machine leaves the job to a free one nearer the pick-up.
      if (isMachine(p) && this.nearerMachine(p, src.tile)) continue;
      // Containers go to a container yard, crates to a truck bay or storage,
      // or off a boat onto the quay.
      const bay = boxy
        ? this.yardWithRoom(p, src.tile)
        : src.boat
          ? this.landing(p, src.tile, src.boat.vessel === 'coaster')
          : this.bayWithRoom(p, src.tile, !!src.pile?.tiles);
      if (!bay) continue;
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
  private takeRestackJob(p: Dockhand, here: number): boolean {
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

  private slotLists(b: Bay): [number[], number[]] {
    const { boxes, exports } = this.yardSlots(b);
    return [boxes, exports];
  }

  /**
   * A stacker restacking a yard: up to the stack, and the container off the
   * top of it, keeping when customs clear it; then it sets it down as any
   * other, where it buries nothing. True while it is at it.
   */
  private restackJob(p: Dockhand): boolean {
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

  private forklifts(): boolean {
    return this.people.some((q) => q.kind === 'forklift');
  }

  /**
   * Where a dockhand takes what they lift off a boat from dock tile `t`:
   * into crate storage marked out right there, else down on the quay for
   * the forklifts when there are any (pallets always wait for them), else
   * carried on to a truck bay or storage.
   */
  private landing(p: Dockhand, t: number, pallets: boolean): Bay | null {
    const store = this.bays.get(this.storeOf[t]);
    if (store && bayRoom(store, false) > 0 && this.takesImports(store)) return store;
    if (pallets || this.forklifts()) {
      const pile = this.pileAt(t, pallets);
      if (pile || pallets) return pile;
    }
    return this.bayWithRoom(p, t);
  }

  /**
   * The cargo landed on quay tile `t`, or a new heap there (not yet put
   * down), if it has room for this kind; null where forklifts could not
   * get to it: on a wooden jetty or under a crane.
   */
  private pileAt(t: number, pallets: boolean, out = false): Bay | null {
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
  private exportSources(p: Dockhand, here: number, sources: Source[]): void {
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
    if (!this.boats.some((b) => this.wantsLoad(b) && (b.vessel === 'feeder') === boxy)) return;
    const stores = boxy ? this.yards.values() : this.bays.values();
    for (const store of stores) {
      const avail = (store.exports?.length ?? 0) - (store.outReserved ?? 0);
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
  private takeExportJob(p: Dockhand, src: Source, cost: CostFn): boolean {
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
  private exportTarget(
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
            .filter((b) => this.wantsLoad(b) && this.craneReaches(c, b))
            .map((b) => (b.loadQuota ?? outCap(b)) - (b.out ?? 0) - this.exportsComing(b)),
        );
        const room = Math.min(this.exportRoom(c), want);
        if (room <= 0) continue;
        if (this.pathFor(p, from, this.craneSpot(p, c, true))) return { crane: c, room };
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
        (c) => c.kind === 'jib' && this.near(c.idx, b.berth),
      );
      for (const c of cranes) {
        for (const store of this.jibStores(c)) {
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
  private inJibReach(c: Crane, t: number): boolean {
    const m = this.map;
    const d = Math.max(Math.abs(m.xOf(t) - m.xOf(c.idx)), Math.abs(m.yOf(t) - m.yOf(c.idx)));
    return d <= B.JIB_REACH;
  }

  /**
   * Whether exports set down on quay tile `t` go on board coaster `b`: in
   * reach of a jib crane over it, or beside it for the dockhands to carry.
   */
  private pileFor(b: Boat, t: number): boolean {
    if (b.vessel !== 'coaster' || b.state !== 'moored') return false;
    if (this.people.some((q) => q.kind === 'dockhand') && this.pickupSpots(b).includes(t)) {
      return true;
    }
    for (const c of this.cranes.values()) {
      if (c.kind === 'jib' && this.near(c.idx, b.berth) && this.inJibReach(c, t)) return true;
    }
    return false;
  }

  /** Exports left on the quay where nothing will put them on board: their ship has gone. */
  private stranded(pile: Bay): boolean {
    return !!pile.out && !this.boats.some((b) => this.pileFor(b, pile.idx));
  }

  /** Outgoing crate storage a forklift can take exports back into from `from`. */
  private exportHome(
    p: Dockhand,
    from: number,
  ): { boat?: Boat; crane?: Crane; pile?: Bay; store?: Bay; room: number } | null {
    const stores = [...this.bays.values()]
      .filter((b) => this.takesExports(b) && bayRoom(b, false) > 0)
      .sort((a, b) => this.distTo(from, a) - this.distTo(from, b));
    const store = stores.find((b) => this.dropAt(p, b, from) >= 0);
    return store ? { store, room: bayRoom(store, false) } : null;
  }

  /** A dock tile beside the ship this worker can get to from `from`, or -1. */
  private loadSpot(p: Dockhand, b: Boat, from: number): number {
    const cost = this.costFor(p);
    for (const t of this.pickupSpots(b)) {
      if (Number.isFinite(cost(t)) && this.pathFor(p, from, t)) return t;
    }
    return -1;
  }

  /** Unloaded, with room on board and someone to load it: it takes exports on. */
  private wantsLoad(b: Boat): boolean {
    return (
      b.state === 'moored' &&
      b.crates === 0 &&
      b.reserved === 0 &&
      (b.loadQuota ?? outCap(b)) - (b.out ?? 0) - (b.outIncoming ?? 0) > 0
    );
  }

  /** Exports of this kind waiting anywhere in the port, for a ship to take. */
  private exportsWaiting(boxes: boolean): number {
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
  private exportsFor(b: Boat): number {
    const boxes = b.vessel === 'feeder';
    let n = 0;
    for (const s of boxes ? this.yards.values() : this.bays.values()) n += s.exports?.length ?? 0;
    if (boxes) {
      for (const c of this.cranes.values()) {
        if (this.craneReaches(c, b)) n += c.outStack?.length ?? 0;
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
  private exportsComing(b: Boat): number {
    let n = b.outIncoming ?? 0;
    if (b.vessel !== 'feeder') return n;
    for (const c of this.cranes.values()) {
      if (c.kind !== 'jib' && this.craneReaches(c, b)) {
        n += (c.outStack?.length ?? 0) + (c.outReserved ?? 0);
      }
    }
    return n;
  }

  /**
   * A ship unloaded stays to take exports on board while any are waiting and
   * being brought to it, until it is full or nothing has come for a while.
   */
  private stillLoading(b: Boat): boolean {
    if (outCap(b) === 0) return false;
    if ((b.outIncoming ?? 0) > 0) return true;
    if ((b.out ?? 0) >= outCap(b)) return false;
    // Those already at its cranes, or on their way there, it takes anyway.
    const coming = this.exportsComing(b) - (b.outIncoming ?? 0);
    // It takes what is in the port when it is ready to go, never waiting for
    // more to come in, nor to fill up.
    if (b.loadQuota === undefined) {
      const boxes = b.vessel === 'feeder';
      const claimed = this.boats
        .filter((o) => o !== b && o.state === 'moored' && (o.vessel === 'feeder') === boxes)
        .reduce((n, o) => n + Math.max(0, (o.loadQuota ?? 0) - (o.out ?? 0)), 0);
      const room = outCap(b) - (b.out ?? 0);
      const take = clamp(Math.max(coming, this.exportsFor(b) - claimed), 0, room);
      b.loadQuota = (b.out ?? 0) + take;
      // The line allows time to load as well as to unload.
      b.grace += take * B.MOORED_TICKS_PER_CRATE;
    }
    if ((b.out ?? 0) >= b.loadQuota) return false;
    // Nothing left in the port that other ships alongside are not taking.
    const boxes = b.vessel === 'feeder';
    const theirs = this.boats
      .filter((o) => o !== b && o.state === 'moored' && (o.vessel === 'feeder') === boxes)
      .reduce(
        (n, o) => n + Math.max(0, (o.loadQuota ?? 0) - (o.out ?? 0) - (o.outIncoming ?? 0)),
        0,
      );
    if (Math.max(coming, this.exportsFor(b) - theirs) <= 0) return false;
    // Its own cargo still being cleared off the crane comes first; and those
    // at its cranes, or on their way there, are coming.
    const busy =
      coming > 0 ||
      [...this.cranes.values()].some((c) => c.stack.length > 0 && this.craneReaches(c, b));
    b.loadIdle = busy ? 0 : (b.loadIdle ?? 0) + 1;
    return b.loadIdle < B.LOAD_WAIT;
  }

  /** What an unloaded ship alongside is doing: taking exports on, or waiting to sail. */
  private readyWords(b: Boat): string {
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
    return `Ready to sail${out > 0 ? ` with ${out} exports` : ''}${b.holdUp ? why[b.holdUp] : ''}`;
  }

  /** What each crate on a crate truck holds, in load order. */
  private truckCargo(t: Truck): Cargo[] {
    // A shipper's are all alike.
    if (t.exports) return Array<Cargo>(t.cargo).fill(cargoOf(t.value, 'goods'));
    const fees = t.fees ?? [];
    return Array.from({ length: t.cargo }, (_, k) => (k < fees.length ? cargoOf(fees[k]) : 'fish'));
  }

  /** Exports go on board: the shipper pays for each as it does. */
  private shipOut(b: Boat, fees: number[]): void {
    if (fees.length === 0) return;
    const total = fees.reduce((n, f) => n + f, 0);
    b.out = (b.out ?? 0) + fees.length;
    (b.outFees ??= []).push(...fees);
    b.loadIdle = 0;
    this.book('exports', total);
    this.stats.earned += total;
    this.stats.exported = (this.stats.exported ?? 0) + fees.length;
    this.moneyAt(total, b.berth);
  }

  /**
   * A crane with nothing to unload loads a ship instead: a jib crane from
   * crate storage in reach or exports left on the quay beside it, a
   * container crane from what the stackers have brought it.
   */
  private loadShip(c: Crane): void {
    const boxes = c.kind !== 'jib';
    const ship = this.boats.find(
      (b) => (b.vessel === 'feeder') === boxes && this.wantsLoad(b) && this.craneReaches(c, b),
    );
    if (!ship) return;
    let take: (() => number) | null = null;
    let from: { store?: Bay; pile?: Bay } = {};
    if (boxes) {
      if (c.outStack?.length) {
        const k = c.liftSlot;
        if (c.liftBoat !== ship.id || k === undefined || k < 0 || this.outSlots(ship).includes(k)) {
          c.liftBoat = ship.id;
          c.liftSlot = this.deckSlot(c, ship, true);
        }
        if (c.liftSlot! < 0) return;
        take = () => {
          // Off the top of the stacks, at a gantry crane.
          const i = Math.max(0, this.craneTop(c, true));
          this.cranePlaces(c).out.splice(i, 1);
          (ship.outLooks ??= []).push(...this.outLooks(c).splice(i, 1));
          this.outSlots(ship).push(c.liftSlot!);
          c.liftSlot = undefined;
          return c.outStack!.splice(i, 1)[0];
        };
      }
    } else {
      const store = this.jibStores(c).find(
        (a) => (a.exports?.length ?? 0) - (a.outReserved ?? 0) > 0,
      );
      const pile = [...this.piles.values()].find(
        (q) => q.out && q.crates.length - (q.reserved ?? 0) > 0 && this.inJibReach(c, q.idx),
      );
      from = store ? { store } : pile ? { pile } : {};
      if (store) take = () => store.exports!.shift()!;
      else if (pile) {
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
    this.shipOut(ship, [take()]);
  }

  /**
   * Shippers' trucks come in on their timetable, each to a parking space
   * outside the port to have its paperwork done. With nowhere to park, they
   * do not come.
   */
  private spawnShipments(): void {
    const m = this.map;
    for (const c of this.shippers()) {
      if (this.tick < c.nextBoatTick) continue;
      const wide = needsWideSpace(c.terms.capacity, c.terms.cargo === 'container');
      const space = this.freeParking(null, true, wide);
      const from = this.arrival(space ? space.tiles[0] : m.entry);
      if (!this.entryClear(from.tile)) continue;
      const into = space ? this.intoSpace(from.tile, space, -1) : null;
      if (!space || !into) {
        c.nextBoatTick = this.tick + 60;
        this.tip('parking');
        this.nag(
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
   * Storage with room for a shipper's truck to unload into and a free spot
   * beside it, the nearest it can get to from `from`.
   */
  private exportStore(t: Truck): { store: Bay; dock: number; path: number[] } | null {
    const from = this.tileOf(t);
    const stores = [...(t.boxes ? this.yards : this.bays).values()]
      .filter((b) => this.takesExports(b) && bayRoom(b, t.boxes) >= t.cargo)
      .sort((a, b) => this.distTo(from, a) - this.distTo(from, b));
    for (const store of stores) {
      const to = this.dockFor(
        store,
        (d, avoid) => this.routeFrom(t, d, this.avoiding(this.truckCost(store.idx, -1, t), avoid)),
        this.lengthOf(t),
      );
      if (to) return { store, ...to };
    }
    return null;
  }

  /** Some outgoing storage of its kind has room for a shipper's truck's load. */
  private outgoingRoom(t: Truck): boolean {
    return [...(t.boxes ? this.yards : this.bays).values()].some(
      (b) => this.takesExports(b) && bayRoom(b, t.boxes) >= t.cargo,
    );
  }

  /** Say, now and then, that shippers' trucks are waiting because no outgoing storage has room. */
  private outgoingFull(boxes: boolean): void {
    const kind = boxes ? 'boxes' : 'crates';
    const stores = [...(boxes ? this.yards : this.bays).values()].filter((b) => b.outgoing);
    this.nag(
      `outFull:${kind}`,
      stores.length === 0
        ? `Shippers' trucks are waiting with ${boxes ? 'containers' : 'crates'} to ship: mark out ${boxes ? 'a container yard' : 'crate storage'} for cargo going out.`
        : `Outgoing ${boxes ? 'container yards are' : 'crate storage is'} full: shippers' trucks are waiting in parking. Mark out more, or get ships loading.`,
      'bad',
    );
  }

  /** A heap on the quay, or storage, being collected from: exports from container yards too. */
  private stock(i: number): Bay | undefined {
    return this.piles.get(i) ?? this.bays.get(i) ?? this.yards.get(i);
  }

  /** Forget a heap on the quay once it is gone and nobody is coming for it. */
  private tidyPile(i: number): void {
    const pile = this.piles.get(i);
    if (pile && pile.crates.length + pile.incoming + (pile.reserved ?? 0) === 0) {
      this.piles.delete(i);
    }
  }

  private removePile(i: number): void {
    const pile = this.piles.get(i);
    if (pile && pile.crates.length > 0) {
      this.message(`${pile.crates.length} crates waiting on the quay were lost.`, 'bad');
    }
    this.piles.delete(i);
  }

  /**
   * Whether another machine of the same kind, free or about to be, is nearer
   * `tile` and can get there; it will take the job instead.
   */
  private nearerMachine(p: Dockhand, tile: number): boolean {
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
    if (p.stockIdx >= 0) return !!this.stock(p.stockIdx);
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
          const places = this.cranePlaces(crane).stack;
          const chosen = p.takeAt === undefined ? -1 : places.indexOf(p.takeAt);
          const kinds = this.craneKinds(crane);
          const free = chosen >= 0 && !kinds.has(p.takeAt! + craneStacks(crane));
          p.takeAt = undefined;
          const i = free ? chosen : this.craneTop(crane, false);
          if (i < 0) break;
          this.cranePlaces(crane).stack.splice(i, 1);
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
          const at = this.takenFrom(p, pile, n);
          p.cargoLooks = this.exportLooks(pile).splice(at, n);
          return out.splice(at, n);
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
      const fees = pile.crates.splice(pile.tiles ? this.takenFrom(p, pile, n) : 0, n);
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
  private bayWithRoom(p: Dockhand, from: number, onward = false): Bay | null {
    return this.nearestWithRoom(p, from, this.bays, false, onward);
  }

  /** Nearest container yard with room this stacker or tractor can reach from `from`. */
  private yardWithRoom(p: Dockhand, from: number): Bay | null {
    return this.nearestWithRoom(p, from, this.yards, true, false, (b) => this.servesYard(p, b));
  }

  /**
   * Whether this machine can work a container yard: a terminal tractor
   * cannot lift a container, so only where a yard gantry lifts it off and on.
   */
  private servesYard(p: Dockhand, yard: Bay): boolean {
    return p.kind !== 'tractor' || (this.yardGantry(yard) && this.laneThrough(yard));
  }

  private nearestWithRoom(
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
  private bayCost(from: number, b: Bay, boxes: boolean): number {
    const waiting = !boxes && this.truckRoom(b) > b.incoming;
    return this.distTo(from, b) - (waiting ? B.TRUCK_WAITING_PULL : 0);
  }

  /**
   * Room on crate trucks loading at a truck bay, besides what dockhands and
   * forklifts loading it from its stack are bringing them: crates carried
   * there go straight on, however many the bay holds already.
   */
  private truckRoom(b: Bay): number {
    if (b.tiles || b.yard || b.pile) return 0;
    let room = 0;
    for (const t of this.trucks) {
      if (t.state !== 'loading' || t.bayIdx !== b.idx || !this.byHand(t, b)) continue;
      room += Math.max(0, t.capacity - t.cargo - (t.coming ?? 0));
    }
    return room;
  }

  /** Room for crates brought to a bay: on its stack, or straight onto a truck there. */
  private dropRoom(b: Bay, boxes: boolean): number {
    return bayRoom(b, boxes) + (boxes ? 0 : this.truckRoom(b));
  }

  /**
   * Storage by a crane, its machines-only ground: it loads and unloads, so
   * it takes cargo either way, but one way at a time.
   */
  private byCrane(b: Bay): boolean {
    return !!b.tiles && b.tiles.some((t) => nearCrane(this.map, t));
  }

  /**
   * Whether cargo coming in may go here: truck bays, and storage marked out
   * for cargo coming in, by a crane or not.
   */
  private takesImports(b: Bay): boolean {
    return !b.tiles || (!b.outgoing && !b.shut);
  }

  /** Whether exports may go here: only storage marked out for cargo going out, and not shut. */
  private takesExports(b: Bay): boolean {
    return !!b.tiles && !!b.outgoing && !b.shut;
  }

  /**
   * Stop storage taking any more cargo, so it empties out, or open it to
   * cargo again.
   */
  private shutStore(idx: number, shut: boolean): void {
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
      this.message(
        `Every ${b.outgoing ? 'outgoing ' : ''}${what} has stopped taking ${b.yard ? 'containers' : 'crates'}: ${b.outgoing ? "shippers' trucks will wait" : b.yard ? 'the cranes will stop once their stacks fill' : 'forklifts will take crates to the truck bays'}.`,
        'bad',
      );
    }
  }

  /** Crate storage a jib crane can swing crates off a boat into: in reach and taking them. */
  private jibStows(c: Crane): boolean {
    return this.jibStores(c).some((a) => this.takesImports(a));
  }

  /** Trucks can get to this bay or storage area to load. */
  private truckable(b: Bay): boolean {
    return this.roadTo(b) < Infinity;
  }

  /** Tiles from `from` to the nearest part of a bay or storage area. */
  private distTo(from: number, b: Bay): number {
    return b.tiles ? Math.min(...b.tiles.map((t) => this.dist(from, t))) : this.dist(from, b.idx);
  }

  /**
   * Where a worker coming from `from` sets a load down at a bay, or at the
   * nearest tiles of a storage area they can get to; -1 if they cannot.
   */
  private dropAt(p: Dockhand, b: Bay, from: number): number {
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
  private stackSide(
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
  private machineGround(): Set<number> {
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
      for (const n of m.neighbors4(queue.pop()!)) {
        if (seen.has(n) || !Number.isFinite(this.driveCost(n))) continue;
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
  private stackSides(b: Bay, t: number): number[] {
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
  private workable(b: Bay): Set<number> | undefined {
    if (this.yardGantry(b)) return undefined;
    const out = new Set<number>();
    (b.tiles ?? [b.idx]).forEach((t, n) => {
      if (this.stackSides(b, t).length > 0) out.add(n);
    });
    return out.size > 0 ? out : undefined;
  }

  /** The tiles of a yard (by their place in its tiles) a stacker standing at `at` reaches. */
  private reachFrom(b: Bay, at: number): Set<number> {
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
  private tractorSpot(p: Dockhand, yard: Bay, from: number): number {
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
  private readyList(b: Bay): number[] {
    b.boxReady ??= [];
    while (b.boxReady.length < b.boxes.length) b.boxReady.unshift(0);
    if (b.boxReady.length > b.boxes.length) b.boxReady.length = b.boxes.length;
    return b.boxReady;
  }

  /** Whether customs have cleared a container ready at `r` (see boxReady). */
  private isClear(r: number): boolean {
    return r >= 0 && r <= this.tick;
  }

  /** How the containers on a crane's stack look, kept beside them. */
  private stackLooks(c: Crane): number[] {
    return (c.stackLooks = aligned(c.stack, c.stackLooks, c.idx));
  }

  /** How the exports set down for a crane look. */
  private outLooks(c: Crane): number[] {
    return (c.outLooks = aligned(c.outStack ?? [], c.outLooks, c.idx + 1));
  }

  /** How the containers in a yard look. */
  private boxLooks(b: Bay): number[] {
    return (b.boxLooks = aligned(b.boxes, b.boxLooks, b.idx));
  }

  /**
   * The slot each container in a yard is stacked in, and each export,
   * kept beside them: a container set down goes in the lowest free place
   * with one under it, across the whole yard before it goes higher; under
   * a yard gantry, up first (see freeYardSlot).
   */
  private yardSlots(b: Bay): { boxes: number[]; exports: number[] } {
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
  private freeYardSlot(
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
  private buried(b: Bay): { at: number; tile: number }[] {
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
  private buriedCount(b: Bay): number {
    return Math.max(0, this.cleared(b) - this.reachable(b));
  }

  /** Where the next container set down in this yard goes. */
  private nextYardSlot(b: Bay, ready?: number, reach?: Set<number>): number {
    const { boxes, exports } = this.yardSlots(b);
    return this.freeYardSlot(b, boxes, exports, ready, reach);
  }

  /**
   * The container in a yard (with `exports`, the export) that can be lifted
   * off the top of its stack, highest first, of those `ok` lets through; -1
   * if none is on top. One with another on it waits until that has gone.
   */
  private yardTop(
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
  private clearTop(b: Bay, reach?: Set<number>): number {
    const ready = this.readyList(b);
    return this.yardTop(b, false, (i) => this.isClear(ready[i]), reach);
  }

  /**
   * How many cleared containers trucks can take off a yard one after
   * another: down each stack from the top, until one waiting for customs,
   * or an export, is in the way.
   */
  private reachable(b: Bay): number {
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
  private exportLooks(b: Bay): number[] {
    return (b.exportLooks = aligned(b.exports ?? [], b.exportLooks, b.idx + 1));
  }

  /** How the containers a stacker carries look. */
  private carriedLooks(p: Dockhand): number[] {
    return (p.cargoLooks = aligned(p.cargoFees, p.cargoLooks, p.id));
  }

  /** Containers customs have cleared. */
  private cleared(b: Bay): number {
    return this.readyList(b).filter((r) => this.isClear(r)).length;
  }

  /** Ticks since the longest-cleared container in this yard cleared customs, or 0. */
  private clearedFor(b: Bay): number {
    const since = Math.min(Infinity, ...this.readyList(b).filter((r) => this.isClear(r)));
    return Number.isFinite(since) ? this.tick - since : 0;
  }

  /** Containers whose ship is still being unloaded, so customs have not started on them. */
  private pending(b: Bay): number {
    return this.readyList(b).filter((r) => r < 0).length;
  }

  /** Ticks until the next container in this yard clears customs, or -1. */
  private nextClear(b: Bay): number {
    const next = Math.min(Infinity, ...this.readyList(b).filter((r) => r > this.tick));
    return Number.isFinite(next) ? next - this.tick : -1;
  }

  /** What a truck could take away from this bay now. */
  private collectable(b: Bay): number {
    return b.crates.length + (b.yard ? this.reachable(b) : b.boxes.length);
  }

  /**
   * Containers (or crates) at a bay or yard ready to go that no truck is
   * already coming for: room on the trucks heading there, parked for it or
   * loading at it is spoken for. Leaving `except` out of those.
   */
  private unclaimed(b: Bay, boxes: boolean, except?: Truck): number {
    const ready = boxes
      ? b.yard
        ? this.reachable(b) - (b.truckReserved ?? 0)
        : b.boxes.length
      : b.crates.length;
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
  private dest(idx: number): Bay | undefined {
    return this.bays.get(idx) ?? this.yards.get(idx) ?? this.piles.get(idx);
  }

  /** The worker holds crates but their bay is gone or unreachable. */
  /** Where the worker is taking the load is still there to take it. */
  private dropValid(p: Dockhand): boolean {
    if (p.toBoat !== undefined && p.toBoat >= 0) {
      return this.boats.some((b) => b.id === p.toBoat && b.state === 'moored');
    }
    if (p.toCrane !== undefined && p.toCrane >= 0) return this.cranes.has(p.toCrane);
    return !!this.dest(p.bayIdx);
  }

  /** Give back room promised at a ship or crane for `n` exports not coming after all. */
  private releaseTarget(p: Dockhand, n: number): void {
    if (n <= 0) return;
    const store = p.outbound ? this.dest(p.bayIdx) : undefined;
    if (store?.tiles) store.exportIncoming = Math.max(0, (store.exportIncoming ?? 0) - n);
    const ship = this.boats.find((b) => b.id === p.toBoat);
    if (ship) ship.outIncoming = Math.max(0, (ship.outIncoming ?? 0) - n);
    const crane = p.toCrane !== undefined ? this.cranes.get(p.toCrane) : undefined;
    if (crane) crane.outReserved = Math.max(0, (crane.outReserved ?? 0) - n);
  }

  /** Exports put on board a ship, or set down for a crane; false for anything else. */
  private dropOutbound(p: Dockhand): boolean {
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

  private retargetCrate(p: Dockhand): void {
    if (p.outbound) return this.retargetExports(p);
    const boxy = isBoxy(p);
    const old = this.dest(p.bayIdx);
    if (old) bayIncoming(old, boxy, -p.planned);
    this.tidyPile(p.bayIdx);
    const here = this.tileOf(p);
    const bay = boxy ? this.yardWithRoom(p, here) : this.bayWithRoom(p, here);
    const goal = bay ? this.dropAt(p, bay, here) : -1;
    if (bay && goal >= 0 && this.headTo(p, goal)) {
      bayIncoming(bay, boxy, p.planned);
      p.bayIdx = bay.idx;
      p.state = 'toDrop';
      return;
    }
    this.nag('putDown', `${p.name} had nowhere to take their load and put it down.`, 'bad');
    p.carrying = 0;
    p.cargoFees = [];
    p.planned = 0;
    p.bayIdx = -1;
    p.path = [];
    p.state = 'idle';
  }

  /** Exports in hand whose ship or crane is gone: to another, or back into storage. */
  private retargetExports(p: Dockhand): void {
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
      this.nag(
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

  private cancelJob(p: Dockhand): void {
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

  private addCrane(i: number, kind: Crane['kind']): void {
    this.cranes.set(i, { idx: i, kind, stack: [], reserved: 0, timer: 0, angle: 0, busy: false });
  }

  /**
   * Swing crates from a boat moored beside the crane onto its landing stack,
   * or for a jib crane with crate storage in reach, straight into that.
   */
  private updateCrane(c: Crane): void {
    c.busy = false;
    this.jibJobs.delete(c);
    // A tractor waiting under it for a container there is none of goes: no
    // ship to unload, or one it has not lifted from in a good while.
    if (c.kind !== 'jib' && c.stack.length === 0) {
      for (const p of this.people) {
        if (p.state !== 'picking' || this.underGantry(p) !== c || p.timer <= 1 || p.handed) {
          continue;
        }
        const waited = B.TRACTOR_WAIT_TICKS - p.timer;
        if (!this.unloadingAt(c) || waited > B.TRACTOR_GIVE_UP) p.timer = 1;
      }
    }
    if (this.serveTractor(c)) return;
    const boxes = c.kind !== 'jib';
    const store = boxes
      ? undefined
      : this.jibStores(c).find((a) => bayRoom(a, false) > 0 && this.takesImports(a));
    if (!store && this.stackFull(c)) return this.loadShip(c);
    const m = this.map;
    const reaches = (b: Boat) => this.craneReaches(c, b);
    const boat = this.boats.find(
      (b) =>
        b.state === 'moored' &&
        (b.vessel === 'feeder') === boxes &&
        // One kind on the landing stack at a time: crates or pallets.
        (store || c.stack.length === 0 || (b.vessel === 'coaster') === !!c.pallets) &&
        b.crates - b.reserved > 0 &&
        reaches(b),
    );
    if (!boat) return this.loadShip(c);
    // A container crane lifts them a tier at a time, from the top down, so
    // the ship stays even, in its own share of it when others work it too.
    if (boxes && !this.liftingFrom(c, boat)) {
      c.liftBoat = boat.id;
      c.liftSlot = this.deckSlot(c, boat, false);
      if (c.liftSlot < 0) return;
      // Straight onto a tractor already waiting for one as it starts, or
      // one called to it pulling in by the time it has it over the bay.
      c.handTo = (this.directTo(c) ?? this.pullingIn(c))?.id;
    }
    c.busy = true;
    // One pulling in under it part way through the lift gets it, if the
    // one it lifted it for has not come.
    if (boxes && !this.handingTo(c)) c.handTo = this.directTo(c)?.id ?? c.handTo;
    if (!boxes) this.jibJobs.set(c, { boat, load: false, store });
    c.angle = Math.atan2(boat.y - (m.yOf(c.idx) + 0.5), boat.x - (m.xOf(c.idx) + 0.5));
    if (++c.timer < craneTicks(c)) return;
    c.timer = 0;
    boat.crates--;
    if (store) {
      store.crates.push(boat.fee);
      this.stats.cratesHandled++;
      return;
    }
    c.pallets = boat.vessel === 'coaster';
    // Out of the slot on its deck the ship drew it in: onto a tractor
    // waiting under a gantry crane for one, or else its stack.
    if (c.kind !== 'jib') {
      const slot = c.liftSlot ?? boat.crates + (boat.lifted?.length ?? 0);
      const look = boxLookOf(boat.id, slot);
      (boat.lifted ??= []).push(slot);
      c.liftSlot = undefined;
      // Onto the one it had it for, or any other there for one now.
      const tractor = this.handingTo(c) ?? this.directTo(c);
      if (tractor) {
        tractor.handed = { fees: [boat.fee], looks: [look], from: [boat.id] };
        tractor.timer = 1;
      } else {
        this.stackLooks(c).push(look);
        c.stack.push(boat.fee);
        (c.stackFrom ??= []).push(boat.id);
      }
      if (boat.crates === 0) {
        boat.lifted = [];
        this.shipUnloaded(boat);
      }
      return;
    }
    c.stack.push(boat.fee);
  }

  /** Which container on a crane's stack a machine picking at it takes: the one it chose, or the top. */
  private takingAt(p: Dockhand, c: Crane): number {
    const i = p.takeAt === undefined ? -1 : this.cranePlaces(c).stack.indexOf(p.takeAt);
    return i >= 0 ? i : this.craneTop(c, false);
  }

  /**
   * A terminal tractor called to container crane `c`, empty and on its way
   * there, that will pull in under it by the time it has a container off
   * the ship over the bay: the nearest such. It does not wait for it,
   * though: a ship kept longer at its berth waits longer for customs.
   */
  private pullingIn(c: Crane): Dockhand | undefined {
    const soon = craneTicks(c) * B.CRANE_LIFT_SET;
    let best: Dockhand | undefined;
    let bestD = Infinity;
    for (const p of this.people) {
      if (p.kind !== 'tractor' || p.state !== 'toPickup' || p.craneIdx !== c.idx) continue;
      if (p.carrying > 0 || p.handed) continue;
      const d = this.dist(this.tileOf(p), p.goal);
      if ((d * 1.25) / B.TRACTOR_SPEED > soon || d >= bestD) continue;
      best = p;
      bestD = d;
    }
    return best;
  }

  /** The tractor a crane is lifting one off the ship straight onto, if it is still waiting. */
  private handingTo(c: Crane): Dockhand | undefined {
    const p = c.handTo === undefined ? undefined : this.people.find((q) => q.id === c.handTo);
    const waiting = p && p.state === 'picking' && this.underGantry(p) === c && p.timer > 1;
    return waiting && !p.handed ? p : undefined;
  }

  /**
   * Containers still to come off a ship at container crane `c`, its share
   * where other cranes work the ship too, and in how many ticks it starts
   * on them: at once for a ship moored under it, about when it will be
   * alongside for one coming in to its berth. Null with neither.
   */
  private shipFor(c: Crane): { left: number; start: number } | null {
    if (c.kind === 'jib') return null;
    let best: { left: number; start: number } | null = null;
    for (const b of this.boats) {
      if (b.vessel !== 'feeder' || b.crates <= 0) continue;
      if (b.state !== 'moored' && b.state !== 'arriving') continue;
      if (!this.craneReaches(c, b)) continue;
      let cranes = 0;
      for (const k of this.cranes.values())
        if (k.kind !== 'jib' && this.craneReaches(k, b)) cranes++;
      const left = Math.ceil(b.crates / Math.max(1, cranes));
      const start = b.state === 'moored' ? 0 : this.alongsideIn(b);
      if (!best || start < best.start) best = { left, start };
    }
    return best;
  }

  /** About how many ticks a ship coming in to its berth has before it is alongside, moored. */
  private alongsideIn(b: Boat): number {
    const m = this.map;
    const d = Math.hypot(m.xOf(b.berth) + 0.5 - b.x, m.yOf(b.berth) + 0.5 - b.y);
    return d / (B.VESSELS[b.vessel].speed * 0.6) + B.ALONGSIDE_TICKS;
  }

  /**
   * Whether a terminal tractor should set off now for container crane `c`,
   * at `tile`: a container waits on its stack for it, or one will come off
   * a ship for it about as it gets there, a little before rather than
   * after, so the crane sets it straight on. Sent no sooner, so tractors
   * come one after another as fast as the crane can serve them, one
   * pulling in under it as the last pulls out, rather than all at once to
   * queue in each other's way.
   */
  private dueAt(p: Dockhand, c: Crane, tile: number): boolean {
    // Its place among the tractors called to the crane: each served in turn.
    const coming = this.people.filter(
      (q) =>
        q !== p &&
        q.kind === 'tractor' &&
        q.craneIdx === c.idx &&
        (q.state === 'toPickup' || q.state === 'picking'),
    ).length;
    if (coming >= B.TRACTORS_CALLED) return false;
    const turn = Math.max(craneTicks(c), B.TRACTOR_TURN);
    let ready = coming * turn;
    // Past what waits on the stack, one still to come off a ship for it.
    const off = coming + 1 - c.stack.length;
    if (off > 0) {
      const ship = this.shipFor(c);
      if (!ship || off > ship.left) return false;
      ready = Math.max(ready, ship.start + (off - 1) * craneTicks(c));
    }
    if (ready <= 0) return true;
    // Its drive there: round the corners a little longer than straight.
    const drive = (this.dist(this.tileOf(p), tile) * 1.25) / B.TRACTOR_SPEED;
    return drive + B.TRACTOR_EARLY >= ready;
  }

  /** A gantry crane with a ship alongside still to unload. */
  private unloadingAt(c: Crane): boolean {
    if (c.kind === 'jib') return false;
    return this.boats.some(
      (b) =>
        b.state === 'moored' && b.vessel === 'feeder' && b.crates > 0 && this.craneReaches(c, b),
    );
  }

  /** A terminal tractor waiting under a gantry crane for a container, for it to set one straight on. */
  private directTo(c: Crane): Dockhand | undefined {
    if (c.kind === 'jib') return undefined;
    return this.people.find(
      (p) => p.state === 'picking' && this.underGantry(p) === c && p.timer > 1 && !p.handed,
    );
  }

  /**
   * The places on a container crane's landing stack its containers and
   * exports are in, kept beside them: stacks side by side (see
   * craneStacks), four high on a gantry crane, two on a harbour crane. One
   * set down goes in the lowest free place with one of its own kind under
   * it, or on the ground: never an export on what came off a ship, nor the
   * other way, so neither is ever buried under the other.
   */
  private cranePlaces(c: Crane): { stack: number[]; out: number[] } {
    const stack = (c.places ??= []);
    const out = (c.outPlaces ??= []);
    if (stack.length > c.stack.length) stack.length = c.stack.length;
    if (out.length > (c.outStack?.length ?? 0)) out.length = c.outStack?.length ?? 0;
    const kinds = new Map<number, boolean>();
    for (const [list, isOut] of [
      [stack, false],
      [out, true],
    ] as const) {
      list.forEach((k, i) => {
        if (k < 0 || k >= craneStack(c) || kinds.has(k)) list[i] = -1;
        else kinds.set(k, isOut);
      });
    }
    for (const [list, n, isOut] of [
      [stack, c.stack.length, false],
      [out, c.outStack?.length ?? 0, true],
    ] as const) {
      for (let i = 0; i < n; i++) {
        if (i < list.length && list[i] >= 0) continue;
        // With no room of its own kind, anywhere free, rather than lose it.
        let k = this.freeCranePlace(c, kinds, isOut);
        if (k < 0) k = this.freeCranePlace(c, kinds, isOut, true);
        list[i] = k;
        if (k >= 0) kinds.set(k, isOut);
      }
    }
    return { stack, out };
  }

  /**
   * The lowest free place on a container crane's stack for an export
   * (`out`) or one off a ship: on one of the same kind, or else on the
   * ground; with `any`, on whatever is there. -1 if none.
   */
  private freeCranePlace(c: Crane, kinds: Map<number, boolean>, out: boolean, any = false): number {
    const n = craneStacks(c);
    // On one of its own kind first, keeping stacks free for the other.
    for (let k = n; k < craneStack(c); k++) {
      const under = kinds.get(k - n);
      if (!kinds.has(k) && under !== undefined && (any || under === out)) return k;
    }
    for (let k = 0; k < n; k++) if (!kinds.has(k)) return k;
    return -1;
  }

  /** The places on a container crane's stack, with whether an export is in each. */
  private craneKinds(c: Crane): Map<number, boolean> {
    const { stack, out } = this.cranePlaces(c);
    const kinds = new Map<number, boolean>();
    for (const k of stack) if (k >= 0) kinds.set(k, false);
    for (const k of out) if (k >= 0) kinds.set(k, true);
    return kinds;
  }

  /** Where the next container set down on a crane's stack goes: an export, with `out`. */
  private nextCranePlace(c: Crane, out = false): number {
    return this.freeCranePlace(c, this.craneKinds(c), out);
  }

  /**
   * How many more of a kind (exports with `out`) a container crane's stack
   * has room for, in places of their own: on their own stacks, and on the
   * ground of empty ones, less those `keep` empty stacks are held for.
   */
  private craneRoom(c: Crane, out: boolean, keep = 0): number {
    const n = craneStacks(c);
    const high = craneStack(c) / n;
    const kinds = this.craneKinds(c);
    let room = 0;
    let empty = 0;
    for (let col = 0; col < n; col++) {
      const bottom = kinds.get(col);
      if (bottom === undefined) {
        empty++;
        continue;
      }
      if (bottom !== out) continue;
      let h = 0;
      while (h < high && kinds.has(col + h * n)) h++;
      room += high - h;
    }
    return room + Math.max(0, empty - keep) * high;
  }

  /**
   * The container (with `out`, the export) on a crane's stack with none on
   * it, highest first, to take next, at the stack a stacker `by` stands at
   * if one there will do; -1 if none. A jib crane's come off in turn.
   */
  private craneTop(c: Crane, out: boolean, by?: Dockhand): number {
    if (c.kind === 'jib') return (out ? (c.outStack?.length ?? 0) : c.stack.length) > 0 ? 0 : -1;
    const places = this.cranePlaces(c);
    const used = new Set([...places.stack, ...places.out]);
    // A stacker standing along a gantry crane takes one from the stack it is at.
    const at = by?.kind === 'stacker' && c.kind === 'gantry' ? this.tileOf(by) : -1;
    const near = (k: number) => at < 0 || this.besideStack(c, k) === at;
    const anyNear = (out ? places.out : places.stack).some(
      (k) => near(k) && !used.has(k + craneStacks(c)),
    );
    let best = -1;
    let high = -1;
    (out ? places.out : places.stack).forEach((k, i) => {
      if (used.has(k + craneStacks(c))) return;
      if (anyNear && !near(k)) return;
      if (k > high) {
        best = i;
        high = k;
      }
    });
    return best;
  }

  /**
   * What a container crane is lifting, for the view: off a ship's deck or
   * onto it, which slot, how it looks and how far through the lift it is;
   * for a jib crane, see jibWork.
   */
  private craneWork(c: Crane, jibs: Map<Crane, JibLift>): Partial<CraneView> {
    if (c.kind === 'jib') return this.jibWork(c, jibs.get(c));
    const serve = c.serving;
    const p = serve && this.people.find((q) => q.id === serve.id);
    // Taken off a tractor already gone on, it still has it.
    const on = !!p || !!serve?.held;
    if (serve && on && serve.ship !== undefined && c.liftSlot !== undefined) {
      // Off the tractor straight on board.
      return {
        working: 'load',
        workBoat: serve.ship,
        workSlot: c.liftSlot,
        workTruck: serve.id,
        workLook: this.servedLooks(c, p)[0],
        workPhase: c.timer / craneTicks(c),
      };
    }
    if (serve && on) {
      const top = p && serve.give ? Math.max(0, this.takingAt(p, c)) : 0;
      return {
        working: serve.give ? 'give' : 'take',
        workTruck: serve.id,
        workLook: serve.give ? this.stackLooks(c)[top] : this.servedLooks(c, p)[0],
        workPhase: c.timer / craneTicks(c),
        workPlace: serve.give ? this.cranePlaces(c).stack[top] : this.nextCranePlace(c, true),
      };
    }
    const k = c.liftSlot;
    if (!c.busy || k === undefined || k < 0) return {};
    const b = this.boats.find((q) => q.id === c.liftBoat);
    if (!b) return {};
    const unload = this.liftingFrom(c, b);
    const top = this.craneTop(c, true);
    // Straight onto a tractor waiting under it, or onto its stack.
    const tractor = unload ? this.handingTo(c) : undefined;
    return {
      working: unload ? 'unload' : 'load',
      workBoat: b.id,
      workSlot: k,
      workLook: unload ? boxLookOf(b.id, k) : this.outLooks(c)[Math.max(0, top)],
      workPhase: c.timer / craneTicks(c),
      workTruck: tractor?.id,
      workPlace: unload ? this.nextCranePlace(c) : this.cranePlaces(c).out[Math.max(0, top)],
    };
  }

  /**
   * What a jib crane is lifting, for the view: off a boat or on board it,
   * the slot on its deck, where at the other end the crate goes or comes
   * from, and how far through the lift it is; and whether its landing stack
   * is of pallets, counting one being set down on it.
   */
  private jibWork(c: Crane, lift: JibLift | undefined): Partial<CraneView> {
    const toStack = !!lift && !lift.load && !lift.store;
    const pallets = c.stack.length > 0 ? !!c.pallets : toStack && lift!.pallet;
    if (!lift) return { pallets };
    return {
      working: lift.load ? 'load' : 'unload',
      workBoat: lift.boat.id,
      workSlot: lift.slot,
      workPhase: lift.phase,
      workStore: lift.store?.idx,
      workPile: lift.pile?.idx,
      workPlace: lift.place,
      workPallet: lift.pallet,
      pallets,
    };
  }

  /**
   * The crates jib cranes are part way through lifting, by crane: which
   * slot on the boat's deck (the top one unloading, the next free loading)
   * and which place in storage, on the quay or on its landing stack (the
   * next free one, or the last taking an export), each crane at the same
   * boat or store its own.
   */
  private jibLifts(): Map<Crane, JibLift> {
    const lifts = new Map<Crane, JibLift>();
    const ahead = new Map<object, number>();
    const nth = (key: object) => {
      const n = ahead.get(key) ?? 0;
      ahead.set(key, n + 1);
      return n;
    };
    for (const c of this.cranes.values()) {
      const job = c.kind === 'jib' && c.busy ? this.jibJobs.get(c) : undefined;
      if (!job) continue;
      const { boat: b, load, store, pile } = job;
      const aboard = b.crates + (b.out ?? 0);
      const slot = load ? aboard + nth(b) : aboard - 1 - nth(b);
      const there = store
        ? store.crates.length + (store.exports?.length ?? 0)
        : pile
          ? pile.crates.length
          : c.stack.length;
      const key = store ?? pile ?? c;
      const k = load ? there - 1 - nth(key) : there + nth(key);
      if (slot < 0 || k < 0) continue;
      // In crate storage, on its pallet, wherever that is.
      const place = store ? this.crateSlot(store, k, Math.max(k + 1, there)) : k;
      const pallet = load ? !!pile?.pallets : b.vessel === 'coaster';
      lifts.set(c, { ...job, slot, place, phase: c.timer / craneTicks(c), pallet });
    }
    return lifts;
  }

  /**
   * Crates jib cranes have set down at `where` (a boat, a store or a
   * crane's landing stack) and taken from it, that the counts do not have
   * yet: the sim moves each at the end of the lift, the view as the hook
   * takes it and sets it down.
   */
  private jibMoved(lifts: Map<Crane, JibLift>, where: object): { set: number; taken: number } {
    let set = 0;
    let taken = 0;
    for (const [c, l] of lifts) {
      const [from, to] = l.load ? [l.store ?? l.pile, l.boat] : [l.boat, l.store ?? c];
      if (from === where && l.phase >= B.CRANE_LIFT_TAKEN) taken++;
      if (to === where && l.phase >= B.CRANE_LIFT_SET) set++;
    }
    return { set, taken };
  }

  /**
   * The containers on a feeder's deck, for the view: by slot, with how each
   * looks. Its line's, less those lifted off, then the exports taken on; one
   * a crane is lifting leaves the deck as its spreader takes it, and an
   * export goes on as it is set down.
   */
  private deckView(b: Boat): { load: number; looks: number[]; deck: number[] } {
    const deck: number[] = [];
    const looks: number[] = [];
    const gone = new Set(b.lifted ?? []);
    const lifting = [...this.cranes.values()].filter(
      (c) => c.kind !== 'jib' && c.busy && c.liftBoat === b.id && c.liftSlot !== undefined,
    );
    for (const c of lifting) {
      const late = c.timer / craneTicks(c);
      if (this.liftingFrom(c, b) && late >= B.CRANE_LIFT_TAKEN) gone.add(c.liftSlot!);
    }
    for (let k = 0; k < b.crates + (b.lifted?.length ?? 0); k++) {
      if (gone.has(k)) continue;
      deck.push(k);
      looks.push(boxLookOf(b.id, k));
    }
    b.outLooks = aligned(Array(b.out ?? 0).fill(0), b.outLooks, b.id);
    deck.push(...this.outSlots(b).slice(0, b.out ?? 0));
    looks.push(...b.outLooks);
    for (const c of lifting) {
      const late = c.timer / craneTicks(c);
      const tractor =
        c.serving?.ship === b.id ? this.people.find((q) => q.id === c.serving!.id) : undefined;
      if ((tractor || c.serving?.held) && c.serving?.ship === b.id && late >= B.CRANE_LIFT_SET) {
        deck.push(c.liftSlot!);
        looks.push(this.servedLooks(c, tractor)[0]);
      } else if (!this.liftingFrom(c, b) && late >= B.CRANE_LIFT_SET && c.outStack?.length) {
        deck.push(c.liftSlot!);
        looks.push(this.outLooks(c)[Math.max(0, this.craneTop(c, true))]);
      }
    }
    return { load: deck.length, looks, deck };
  }

  /**
   * A crane's landing stack has no room for another off the ship: a
   * container crane's holds what it lifts off and exports set down for it,
   * or on their way to it, together, in the same places.
   */
  private stackFull(c: Crane): boolean {
    if (c.kind === 'jib') return c.stack.length >= craneStack(c);
    // Exports on their way need stacks of their own to go on.
    const coming = Math.max(0, (c.outReserved ?? 0) - this.craneRoom(c, true, Infinity));
    const keep = Math.ceil(coming / (craneStack(c) / craneStacks(c)));
    return this.craneRoom(c, false, keep) <= 0;
  }

  /**
   * Room on a container crane's stack for more exports: up to half of it,
   * so there is always room to unload a ship before loading it.
   */
  private exportRoom(c: Crane): number {
    const out = (c.outStack?.length ?? 0) + (c.outReserved ?? 0);
    return Math.min(craneStack(c) / 2 - out, this.craneRoom(c, true) - (c.outReserved ?? 0));
  }

  /** The gantry crane a terminal tractor is under, to have a container lifted on or off, or undefined. */
  private underGantry(p: Dockhand): Crane | undefined {
    if (p.kind !== 'tractor') return undefined;
    const at = p.state === 'picking' ? p.craneIdx : p.state === 'dropping' ? (p.toCrane ?? -1) : -1;
    const c = this.cranes.get(at);
    return c && c.kind !== 'jib' ? c : undefined;
  }

  /**
   * A gantry crane lifts a container off its stack onto a terminal tractor
   * waiting under it, or an export off one onto its stack, before it goes
   * on with the ship: between lifts, one at a time. True while it is at it.
   */
  private serveTractor(c: Crane): boolean {
    if (c.kind === 'jib') return false;
    const waiting = (p: Dockhand) => this.underGantry(p) === c && p.timer > 1;
    let p = c.serving && this.people.find((q) => q.id === c.serving!.id);
    // One taken off a tractor already gone on: it sees that lift through.
    if (c.serving?.held) p = undefined;
    else if (!p || !waiting(p)) {
      c.serving = undefined;
      // Only between lifts: never part way through one off the ship or on
      // board it. One left part way, its ship gone, counts for nothing.
      const ship = this.boats.find((b) => b.id === c.liftBoat && b.state === 'moored');
      if (c.timer > 0 && c.liftSlot !== undefined && ship) return false;
      c.timer = 0;
      // A ship alongside to unload sets one straight on a tractor; from
      // its stack while there is none, or its stack is too full to go on
      // unloading, or the tractor has waited a good while.
      const fromStack = (q: Dockhand) =>
        c.stack.length > 0 &&
        (!this.unloadingAt(c) ||
          this.stackFull(c) ||
          B.TRACTOR_WAIT_TICKS - q.timer > B.TRACTOR_GIVE_UP);
      p = this.people.find(
        (q) => waiting(q) && !q.handed && (q.state === 'dropping' || fromStack(q)),
      );
      if (!p) return false;
      c.serving = { id: p.id, give: p.state === 'picking' };
      // An export off a tractor goes straight on board a ship it is loading.
      const loading =
        p.state === 'dropping' &&
        this.boats.find(
          (b) => b.vessel === 'feeder' && this.wantsLoad(b) && this.craneReaches(c, b),
        );
      const slot = loading ? this.deckSlot(c, loading, true) : -1;
      if (loading && slot >= 0) {
        c.serving.ship = loading.id;
        c.liftBoat = loading.id;
        c.liftSlot = slot;
      }
      // The one off the top it lifts onto it.
      if (p.state === 'picking') {
        const top = this.craneTop(c, false);
        p.takeAt = top >= 0 ? this.cranePlaces(c).stack[top] : undefined;
      }
    }
    c.busy = true;
    ++c.timer;
    // An export off a tractor: once the spreader has it, the tractor is
    // free to go on its way, and the crane carries it on by itself.
    const serving = c.serving!;
    if (p && !serving.give && !serving.held && c.timer >= this.craneTakenIn(c)) {
      serving.held = { fees: p.cargoFees, looks: this.carriedLooks(p), planned: p.planned };
      p.carrying = 0;
      p.cargoFees = [];
      p.cargoLooks = undefined;
      p.planned = 0;
      p.toBoat = -1;
      p.toCrane = -1;
      p.outbound = false;
      p.state = 'idle';
      p = undefined;
    }
    if (c.timer < craneTicks(c)) return true;
    c.timer = 0;
    c.serving = undefined;
    const on = this.boats.find((b) => b.id === serving.ship && b.state === 'moored');
    const held = serving.held;
    if (held) {
      c.outReserved = Math.max(0, (c.outReserved ?? 0) - held.planned);
      if (on && c.liftSlot !== undefined && c.liftSlot >= 0) {
        // Set down on board the ship it is loading.
        (on.outLooks ??= []).push(...held.looks);
        this.outSlots(on).push(c.liftSlot);
        this.shipOut(on, held.fees);
        c.liftSlot = undefined;
      } else {
        this.outLooks(c).push(...held.looks);
        (c.outStack ??= []).push(...held.fees);
      }
      return true;
    }
    if (!p) return true;
    if (on && c.liftSlot !== undefined && c.liftSlot >= 0) {
      this.onBoardFrom(c, p, on, c.liftSlot);
      c.liftSlot = undefined;
      return true;
    }
    // Done: the tractor has it, or the stack has, as it finishes.
    p.timer = 1;
    return true;
  }

  /** Ticks into a container crane's lift until its spreader has the container up. */
  private craneTakenIn(c: Crane): number {
    // Not before the view has it taken.
    return Math.ceil(B.CRANE_LIFT_TAKEN * craneTicks(c));
  }

  /** How the containers a crane is lifting for a tractor look: on its spreader, or still on the tractor. */
  private servedLooks(c: Crane, p: Dockhand | undefined): number[] {
    return c.serving?.held?.looks ?? (p ? this.carriedLooks(p) : []);
  }

  /** A crane has lifted a tractor's export straight on board a ship, into deck slot `slot`. */
  private onBoardFrom(c: Crane, p: Dockhand, ship: Boat, slot: number): void {
    c.outReserved = Math.max(0, (c.outReserved ?? 0) - p.planned);
    (ship.outLooks ??= []).push(...this.carriedLooks(p));
    this.outSlots(ship).push(slot);
    this.shipOut(ship, p.cargoFees);
    p.carrying = 0;
    p.cargoFees = [];
    p.cargoLooks = undefined;
    p.planned = 0;
    p.toBoat = -1;
    p.toCrane = -1;
    p.outbound = false;
    p.state = 'idle';
  }

  /**
   * A crane's landing stack and exports for the view: as a gantry crane
   * lifting one onto a tractor or off one has it, off the stack once its
   * spreader has it, or on once set down.
   */
  private servedStack(
    c: Crane,
    set: number,
  ): { stack: number; out: number; looks?: number[]; places?: number[] } {
    const stack = c.stack.length + set;
    const out = c.outStack?.length ?? 0;
    if (c.kind === 'jib') return { stack, out };
    const looks = [...this.stackLooks(c), ...this.outLooks(c)];
    const gantry = true;
    const at = this.cranePlaces(c);
    const places = at && [...at.stack, ...at.out];
    const less = (i: number) => {
      looks.splice(i, 1);
      places?.splice(i, 1);
    };
    const serve = c.serving;
    const p = serve && this.people.find((q) => q.id === serve.id);
    const phase = c.timer / craneTicks(c);
    if (serve?.give && p && phase >= B.CRANE_LIFT_TAKEN && stack > 0) {
      less(Math.max(0, this.takingAt(p, c)));
      return { stack: stack - 1, out, looks, places };
    }
    if (
      serve &&
      !serve.give &&
      serve.ship === undefined &&
      (p || serve.held) &&
      phase >= B.CRANE_LIFT_SET
    ) {
      places?.push(this.nextCranePlace(c, true));
      return { stack, out: out + 1, looks: [...looks, ...this.servedLooks(c, p)], places };
    }
    // A gantry crane putting an export on board: off the stack once its
    // spreader has it (the ship shows it once it is set down; see deckView).
    const ship = this.boats.find((b) => b.id === c.liftBoat);
    const loading = gantry && c.busy && !serve && ship && !this.liftingFrom(c, ship);
    if (loading && c.liftSlot !== undefined && phase >= B.CRANE_LIFT_TAKEN && out > 0) {
      less(stack + Math.max(0, this.craneTop(c, true)));
      return { stack, out: out - 1, looks, places };
    }
    return { stack, out, looks, places };
  }

  /**
   * A tractor's load for the view while a gantry crane lifts onto it or off
   * it: on once set down, off once the spreader has it.
   */
  private servedLoad(
    p: Dockhand,
    view: { load: number; looks?: number[] },
  ): { load: number; looks?: number[] } {
    if (p.handed) return { load: p.handed.fees.length, looks: [...p.handed.looks] };
    const c = this.underGantry(p);
    if (!c) return view;
    const phase = c.timer / craneTicks(c);
    // Set straight on it off the ship.
    const ship = this.boats.find((b) => b.id === c.liftBoat);
    if (
      !c.serving &&
      this.handingTo(c) === p &&
      ship &&
      c.liftSlot !== undefined &&
      this.liftingFrom(c, ship) &&
      phase >= B.CRANE_LIFT_SET
    ) {
      return { load: 1, looks: [boxLookOf(ship.id, c.liftSlot)] };
    }
    const serve = c.serving;
    if (!serve || serve.id !== p.id) return view;
    if (serve.give && phase >= B.CRANE_LIFT_SET) {
      const top = Math.max(0, this.takingAt(p, c));
      return { load: view.load + 1, looks: [...(view.looks ?? []), this.stackLooks(c)[top]] };
    }
    if (!serve.give && phase >= B.CRANE_LIFT_TAKEN) return { load: 0, looks: [] };
    return view;
  }

  /** Whether a container crane is part way through a lift from this ship's deck. */
  private liftingFrom(c: Crane, b: Boat): boolean {
    const k = c.liftSlot;
    if (c.liftBoat !== b.id || k === undefined || k < 0) return false;
    return k < b.crates + (b.lifted?.length ?? 0) && !(b.lifted ?? []).includes(k);
  }

  /** The container cranes working a ship, from its stern to its bow. */
  private shipCranes(b: Boat): Crane[] {
    const m = this.map;
    const ax = Math.cos(b.dir);
    const ay = Math.sin(b.dir);
    const along = (c: Crane) => {
      const front = this.craneFront(c);
      const x = front.reduce((n, t) => n + m.xOf(t) + 0.5, 0) / front.length;
      const y = front.reduce((n, t) => n + m.yOf(t) + 0.5, 0) / front.length;
      return (x - b.x) * ax + (y - b.y) * ay;
    };
    return [...this.cranes.values()]
      .filter((c) => c.kind !== 'jib' && this.craneReaches(c, b))
      .sort((p, q) => along(p) - along(q) || p.idx - q.idx);
  }

  /** The bays of a ship that are a crane's to work, from..to, shared out with the others on it. */
  private craneBays(c: Crane, b: Boat): [number, number] {
    const all = this.shipCranes(b);
    const j = Math.max(0, all.indexOf(c));
    const n = Math.max(1, all.length);
    return [Math.floor((B.FEEDER_BAYS * j) / n), Math.floor((B.FEEDER_BAYS * (j + 1)) / n)];
  }

  /**
   * The deck slot a container crane lifts from next, or with `load` sets an
   * export into: a tier at a time across the whole ship, to keep it even,
   * from the top down unloading and the bottom up loading; in its own bays
   * while there is work in that tier there; -1 if none is left that another
   * crane is not already at.
   */
  private deckSlot(c: Crane, b: Boat, load: boolean): number {
    const taken = new Set<number>();
    for (const q of this.cranes.values()) {
      if (q !== c && q.busy && q.liftBoat === b.id && q.liftSlot !== undefined) {
        taken.add(q.liftSlot);
      }
    }
    const used = new Set(load ? this.outSlots(b) : (b.lifted ?? []));
    const total = load
      ? B.FEEDER_BAYS * B.FEEDER_ROWS * B.FEEDER_TIERS
      : b.crates + (b.lifted?.length ?? 0);
    const [lo, hi] = this.craneBays(c, b);
    const off = (bay: number) => (bay < lo ? lo - bay : bay >= hi ? bay - hi + 1 : 0);
    let best = -1;
    let bestKey: number[] = [];
    for (let k = 0; k < total; k++) {
      if (used.has(k) || taken.has(k)) continue;
      const p = deckPlace(k);
      const key = [load ? p.tier : -p.tier, off(p.bay), p.bay, p.row];
      const at = key.findIndex((v, i) => v !== bestKey[i]);
      if (best < 0 || (at >= 0 && key[at] < bestKey[at])) {
        best = k;
        bestKey = key;
      }
    }
    return best;
  }

  /** The deck slot each export on board a feeder is in, filling the lowest free for older saves. */
  private outSlots(b: Boat): number[] {
    const slots = (b.outSlots ??= []);
    for (let k = 0; slots.length < (b.out ?? 0); k++) if (!slots.includes(k)) slots.push(k);
    return slots;
  }

  /**
   * A container ship has been unloaded: customs start on all its containers
   * now, those already in a yard and those still on their way there.
   */
  private shipUnloaded(b: Boat): void {
    if (this.unloadedAt.has(b.id)) return;
    this.unloadedAt.set(b.id, this.tick);
    for (const y of this.yards.values()) {
      const ready = this.readyList(y);
      for (let k = 0; k < ready.length; k++) {
        if (ready[k] === -b.id) ready[k] = this.tick + B.CUSTOMS_TICKS;
      }
    }
  }

  /** When customs clear a container stacked now that came off ship `from`; see boxReady. */
  private customsFor(from: number | undefined): number {
    if (from === undefined) return this.tick + B.CUSTOMS_TICKS;
    const done = this.unloadedAt.get(from);
    if (done !== undefined) return done + B.CUSTOMS_TICKS;
    return this.boats.some((b) => b.id === from) ? -from : this.tick + B.CUSTOMS_TICKS;
  }

  /**
   * Whether a crane can work a ship: container cranes anywhere along its
   * hull, so several can work one ship; a jib crane the boat lying under it.
   */
  private craneReaches(c: Crane, b: Boat): boolean {
    if (c.kind === 'jib') return this.near(b.berth, c.idx);
    const front = this.craneFront(c);
    return (this.footprint(b.berth, b.jetty, this.boatHalf(true)) ?? [b.berth]).some((t) =>
      front.some((f) => this.near(f, t)),
    );
  }

  /** Crate storage a jib crane can swing round to, nearest first. */
  private jibStores(c: Crane): Bay[] {
    const m = this.map;
    const r = B.JIB_REACH;
    const found: Bay[] = [];
    for (let d = 1; d <= r; d++) {
      for (let dy = -d; dy <= d; dy++) {
        for (let dx = -d; dx <= d; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== d) continue;
          const x = m.xOf(c.idx) + dx;
          const y = m.yOf(c.idx) + dy;
          if (!m.inBounds(x, y)) continue;
          const a = this.bays.get(this.storeOf[m.idx(x, y)]);
          if (a && !found.includes(a)) found.push(a);
        }
      }
    }
    return found;
  }

  // ── Trucks and bays ───────────────────────────────────────

  private addBay(i: number): void {
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
  private loadingDocks(bay: Bay): number[] {
    return bay.tiles ? this.storeSpots(bay) : [bay.idx];
  }

  /**
   * Tiles beside a storage area trucks can reach and stand on to load: public
   * roads, or port roads and quays behind a port gate. One truck loads at a
   * time for every STORE_TILES_PER_TRUCK tiles of it, at the spots nearest
   * the highway.
   */
  private storeSpots(a: Bay): number[] {
    const cached = this.spotCache.get(a.idx);
    if (cached) return cached;
    const most = Math.max(1, Math.floor(a.tiles!.length / B.STORE_TILES_PER_TRUCK));
    const spots = loadingSpots(this.map, a.tiles!, this.truckReach());
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
  private gantryLane(a: Bay): Map<number, number> | null {
    const cached = this.laneOfCache.get(a.idx);
    if (cached !== undefined) return cached;
    const lane = this.findGantryLane(a);
    this.laneOfCache.set(a.idx, lane);
    return lane;
  }

  private findGantryLane(a: Bay): Map<number, number> | null {
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
  private truckReach(): Int32Array {
    this.reachCache ??= truckReach(this.map);
    return this.reachCache;
  }

  /** Tiles trucks drive from the highway to load at a bay, or Infinity. */
  private roadTo(bay: Bay): number {
    const reach = this.truckReach();
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
  private highwayLeg(): number {
    const m = this.map;
    if (!hasHighway(m)) return 0;
    let best = Infinity;
    for (const y of exitRows(m)) best = Math.min(best, y, m.h - 1 - y);
    return Number.isFinite(best) ? best : 0;
  }

  /** A dock at this bay no truck is using or heading for, or -1. */
  /** Whether the last dockFor found a way to any free spot, through a truck or not. */
  private dockRouted = false;
  /** Whether it found one it could get to but not turn round from to leave. */
  private dockTurn = false;

  /** Standing at a loading spot, loading or unloading. */
  private docked(o: Truck): boolean {
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
  private dockFor(
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
      const out = this.drivePath(dock, came, away, this.truckCost(away, bay.idx));
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
  private joinQueue(
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
      if (!this.drivePath(dock, came, away, this.truckCost(away, bay.idx))) {
        this.dockTurn = true;
        continue;
      }
      this.dockRouted = true;
      return full ? null : { dock, path };
    }
    return null;
  }

  /** Trucks loading at a yard gantry, or on their way in to its queue. */
  private queued(bay: Bay): Truck[] {
    return this.trucks.filter(
      (o) => o.bayIdx === bay.idx && (o.state === 'toBay' || this.docked(o)),
    );
  }

  /** How many trucks are loading at a yard gantry or on their way in to its queue. */
  private inQueue(bay: Bay): number {
    return this.queued(bay).length;
  }

  /**
   * Whether a yard gantry's queue has room for another truck `len` long:
   * as long, bumper to bumper, as its lane and a little more, back along
   * the way in. Long trucks take more of it than short ones.
   */
  private queueRoom(bay: Bay, len = 1): boolean {
    const used = this.queued(bay).reduce((n, o) => n + this.lengthOf(o) + B.TRUCK_GAP, 0);
    return used + len <= this.loadingDocks(bay).length + B.GANTRY_QUEUE_EXTRA;
  }

  /**
   * A truck on its way in to a spot beside a storage area goes on to one
   * further along the lane that has come free since it set off, so the
   * lane fills from the far end: one stopping short, near where trucks come
   * in, keeps all the rest from being sent in past it.
   */
  private goDeeper(t: Truck, bay: Bay): void {
    if (this.oneWayLane(bay)) return this.alongLane(t, bay);
    // Where it could stop were it not already on its way to one.
    t.state = 'parked';
    const to = this.dockFor(
      bay,
      (d, avoid) => this.routeFrom(t, d, this.avoiding(this.truckCost(bay.idx, -1, t), avoid)),
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
  private alongLane(t: Truck, bay: Bay): void {
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
    if (!this.drivePath(dock, came, away, this.truckCost(away, bay.idx))) return;
    t.goal = dock;
    t.path = ahead.slice(0, best + 1);
  }

  /** A truck's way by `cost`, keeping off tiles in `avoid` where there is a short way round. */
  private avoiding(cost: CostFn, avoid: ReadonlySet<number>): CostFn {
    return avoid.size === 0 ? cost : (i, from) => cost(i, from) + (avoid.has(i) ? 20 : 0);
  }

  /**
   * The loading spots at a bay no truck is at or on its way to, nor so close
   * along the lane to one that is that a truck `len` long would not fit
   * between: a long truck at a spot reaches over the next.
   */
  private freeDockSet(bay: Bay, len = 1): Set<number> {
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
  private tractorsIn(yard: Bay): number[] {
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

  private freeDock(bay: Bay): number {
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
   * port gate: never straight from one to the other. A truck bay is only
   * enterable as the destination, or the one being left, from any side of it
   * that touches a road. Storage areas they load beside, never drive into.
   */
  /** How trucks drive; through only the parking space `t` is in, or going into or out of. */
  private truckCost(target: number, home = -1, t?: Truck): CostFn {
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
  private parkCost(t: Truck | undefined, base: CostFn): CostFn {
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
  private laneCost(base: CostFn): CostFn {
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
  private crossesRails(a: number, b: number): boolean {
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
  private gantryRailWays(): Map<number, [number, number]> {
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
  private throughCost(base: CostFn, target: number, home: number): CostFn {
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
  private laneWays(): Map<number, [number, number]> {
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
  private oneWayLane(bay: Bay): boolean {
    return !!bay.yard && this.loadingDocks(bay).some((d) => this.laneWays().has(d));
  }

  private parkingLots(): ParkingLot[] {
    this.lotsCache ??= parkingLots(this.map);
    return this.lotsCache;
  }

  /** The lot of parking tile `i` is in, if any. */
  private lotOf(i: number): ParkingLot | undefined {
    return this.parkingLots().find((l) => l.tiles.includes(i));
  }

  /**
   * Why a lot is no use to the trucks: badly laid out, or out of their
   * reach; null when it works.
   */
  private lotTrouble(lot: ParkingLot): string | null {
    if (lot.why) return lot.why;
    const reach = this.truckReach();
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
  private freeParking(bay: Bay | null, outside = false, wide = false): ParkingSpace | null {
    const reach = this.truckReach();
    const taken = new Set(this.trucks.map((t) => t.park ?? -1));
    let best: ParkingSpace | null = null;
    let bestD = Infinity;
    for (const lot of this.parkingLots()) {
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
  private intoSpace(
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
  private parkUp(t: Truck): void {
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
  private stagedFor(store: Bay, t: Truck): boolean {
    return this.trucks.some(
      (o) =>
        o.staged === store.idx &&
        o.state === 'parked' &&
        o.boxes === t.boxes &&
        this.tick >= (o.papers ?? Infinity),
    );
  }

  /** The parking space whose first tile is `park`, if any. */
  private spaceAt(park: number | undefined): ParkingSpace | undefined {
    if (park === undefined) return undefined;
    return this.parkingLots()
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
  private stageNearer(t: Truck): void {
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
  private stagingSpace(
    t: Truck,
  ): { store: Bay; space: ParkingSpace; into: { path: number[]; via: number } } | null {
    const here = this.tileOf(t);
    const stores = [...(t.boxes ? this.yards : this.bays).values()]
      .filter((b) => this.takesExports(b) && bayRoom(b, t.boxes) >= t.cargo)
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
  private routeFrom(t: Truck, goal: number, cost: CostFn): number[] | null {
    const here = this.tileOf(t);
    let from = here;
    let prefix: number[] = [];
    const lot = t.lot;
    if (lot?.includes(here) && t.parkFrom !== undefined) {
      const space = this.parkingLots()
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
  private queuedAt(bay: Bay): number {
    return this.trucks.filter(
      (t) => !t.exports && t.bayIdx === bay.idx && (t.state === 'toPark' || t.state === 'parked'),
    ).length;
  }

  private spawnTrucks(): void {
    const m = this.map;
    const hauliers = this.hauliers();
    const out = new Map<number, number>();
    // A truck that has left the port is away on its round, and back for
    // more only once its haulier's return is due.
    for (const t of this.trucks) {
      if (!t.away && t.drop === undefined) out.set(t.contractId, (out.get(t.contractId) ?? 0) + 1);
    }
    for (const h of hauliers) {
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
      const free = (h: (typeof hauliers)[number]) => (out.get(h.id) ?? 0) < h.terms.fleet;
      // A container truck goes only for a full load: as many cleared
      // containers as it carries that no other truck is coming for; or for
      // what there is, once that has been waiting a good while.
      const boxes = this.unclaimed(bay, true);
      const boxTruck = (h: (typeof hauliers)[number]) => free(h) && h.terms.cargo === 'container';
      const haulier =
        (boxes > 0
          ? (hauliers.find((h) => boxTruck(h) && boxes >= h.terms.capacity) ??
            (this.clearedFor(bay) >= B.PART_LOAD_WAIT ? hauliers.find(boxTruck) : undefined))
          : undefined) ??
        (this.unclaimed(bay, false) > 0
          ? hauliers.find(
              (h) =>
                free(h) && !h.terms.cargo && (bay.large || h.terms.capacity <= B.TRUCK_CAPACITY),
            )
          : undefined);
      if (!haulier) {
        if (hauliers.some((h) => (h.returns?.length ?? 0) > 0)) this.tip('roundTrip');
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
      // A container truck goes on to a yard only when its gantry or a free
      // reach stacker is there to load it; otherwise it waits in parking
      // inside the port, or is not sent yet.
      const boxy = haulier.terms.cargo === 'container';
      const served = !boxy || this.handlerFree(bay);
      const len = B.truckLength(haulier.terms.capacity, boxy);
      const to = this.dockFor(
        bay,
        (d, avoid) =>
          this.drivePath(from.tile, -1, d, this.avoiding(this.truckCost(bay.idx), avoid)),
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
  private cutOff(bay: Bay, turn = false): void {
    const what = bay.yard ? 'container yard' : bay.tiles ? 'crate storage area' : 'truck bay';
    const why = turn
      ? `Trucks could get to this ${what} but not drive away again: they never turn about on a road one tile wide. Give them a way on, a junction, or a block of road two wide to turn in.`
      : bay.tiles
        ? `Trucks cannot reach this ${what}: they load storage from inside the port, from a port road or quay beside it through a port gate, not beside machines-only ground.`
        : `Trucks cannot reach this ${what}: it needs a public road to the highway, or port roads from a port gate.`;
    // Crate storage out of the trucks' way is a buffer the forklifts empty.
    if (!bay.noAccess && !bay.warehouse) this.message(why, 'bad');
    bay.noAccess = true;
    bay.noAccessWhy = why;
    bay.nextTruckTick = this.tick + 100;
  }

  private updateTruck(t: Truck): void {
    const bay = this.dest(t.bayIdx);
    switch (t.state) {
      case 'toPark': {
        const cost = this.truckCost(t.bayIdx, -1, t);
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
          // A shipper's truck has its paperwork done while it waits.
          if (t.exports && t.papers === undefined) t.papers = this.tick + B.PAPERWORK_TICKS;
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
          (d, avoid) => this.routeFrom(t, d, this.avoiding(this.truckCost(bay.idx, -1, t), avoid)),
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
          if (this.backIn(t, bay)) t.state = 'loading';
          return;
        }
        if (bay.tiles && (this.tick + t.id) % 10 === 0) this.goDeeper(t, bay);
        const cost = this.truckCost(t.bayIdx, -1, t);
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
        // Containers at a yard with no gantry come off by reach stacker.
        if (this.byStacker(t, bay)) {
          if (t.cargo <= 0) {
            this.tip('exports');
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
          bay.exportIncoming = Math.max(0, (bay.exportIncoming ?? 0) - 1);
        }
        if (--t.cargo <= 0) {
          this.tip('exports');
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
        const done = (t.coming ?? 0) === 0 && this.unclaimed(bay, t.boxes, t) <= 0;
        // Crates go on by hand: dockhands and forklifts load it, as
        // containers at a yard with no gantry go on by reach stacker.
        const hands = this.byHand(t, bay);
        if (this.byStacker(t, bay) || hands) {
          if ((t.coming ?? 0) > 0) t.idle = 0;
          else t.idle += every;
          const full = t.cargo >= t.capacity;
          // With crates there for it, it waits as long as it would for any.
          const waiting = hands && bay.crates.length > (bay.reserved ?? 0);
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
        const spare = t.boxes ? stock.length : stock.length - (bay.reserved ?? 0);
        const coming = t.boxes ? 0 : (t.coming ?? 0);
        if (coming > 0) t.idle = 0;
        if (spare > 0 && at >= 0 && t.cargo + coming < t.capacity) {
          if (t.boxes && bay.yard) this.yardSlots(bay).boxes.splice(at, 1);
          if (t.boxes && bay.yard) this.readyList(bay).splice(at, 1);
          if (t.boxes && bay.yard) (t.looks ??= []).push(this.boxLooks(bay).splice(at, 1)[0]);
          const fee = stock.splice(at, 1)[0];
          t.value += fee;
          if (!t.boxes) (t.fees ??= []).push(fee);
          t.cargo++;
          t.idle = 0;
        } else {
          t.idle += every;
        }
        const full = t.cargo >= t.capacity;
        const bored = t.cargo > 0 ? t.idle >= B.TRUCK_PATIENCE : t.idle >= B.TRUCK_GIVE_UP;
        if (full || bored || (done && this.unclaimed(bay, t.boxes, t) <= 0)) this.truckLeave(t);
        return;
      }
      case 'toTown': {
        if (t.round) {
          if (this.driveRound(t)) t.round = undefined;
          return;
        }
        const cost = this.truckCost(t.goal, t.bayIdx);
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
        // The town pays a little extra for goods brought to its door.
        const bonus = Math.round(((t.value * n) / Math.max(1, t.cargo)) * B.TOWN_DELIVERY_BONUS);
        if (bonus > 0) {
          this.book('town', bonus);
          this.stats.earned += bonus;
          this.moneyAt(bonus, t.drop ?? this.tileOf(t));
        }
        if (this.town) this.town.local += t.boxes ? n * B.CONTAINER_GOODS : n;
        t.value -= Math.round((t.value * n) / Math.max(1, t.cargo));
        t.cargo -= n;
        this.headOut(t);
        return;
      }
      case 'leaving': {
        const cost = this.truckCost(t.goal, t.bayIdx, t);
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
  private level = (i: number): boolean =>
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
  private onRoad(o: Truck): boolean {
    return (
      o.state !== 'loading' &&
      o.state !== 'delivering' &&
      o.state !== 'unloading' &&
      o.state !== 'parked' &&
      !o.round
    );
  }

  /** On the road and moving, rather than standing in a queue or at a line. */
  private rolling(o: Vehicle): boolean {
    if (!isTruck(o)) return o.path.length > 0 && o.blocked === 0;
    return this.onRoad(o) && o.path.length > 0 && (o.held ?? 0) === 0;
  }

  /** Each vehicle's tile, and the one it came onto it from, by id; see noteTiles. Not saved. */
  private cameFrom = new Map<number, { tile: number; from: number }>();

  /** Note which tile each truck and machine is on, and which it came from onto it. */
  private noteTiles(): void {
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
  private wayAcross(v: Vehicle, i: number): readonly (readonly [number, number])[] | null {
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
  private clearAcross(t: Vehicle, o: Vehicle): boolean {
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
  private traffic(): Vehicle[] {
    return [...this.trucks.filter((o) => this.onRoad(o)), ...this.machinesOnRoad()];
  }

  /**
   * How far a truck may drive this tick: its speed, short of a safe gap
   * behind the one ahead. Driving by `cost`, it finds a way round one
   * standing in its way, as goRound.
   */
  private pace(t: Truck, cost?: CostFn): () => number {
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
  private goRound(t: Truck, cost: CostFn): void {
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
  private toStopLine(t: Vehicle): number {
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
  private toCrossing(t: Truck, room: number): number {
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
  private crossings(): Map<number, Crossing[]> {
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
  private lanePos(o: Truck): [number, number] {
    if (o.state === 'parked') return [o.x, o.y];
    return [o.x - Math.sin(o.dir) * B.TRUCK_LANE, o.y + Math.cos(o.dir) * B.TRUCK_LANE];
  }

  /** Room to the back of the nearest truck ahead in the same lane, going the same way; Infinity if none. */
  private gapAhead(t: Truck): number {
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
  private passRing(v: Vehicle): void {
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
  private ring(t: Vehicle): Vehicle[] | null {
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
  private ahead(t: Truck, o: Truck): number {
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
  private onWay(t: Vehicle, o: Vehicle): number {
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
  private brokenDown(o: Vehicle): boolean {
    return !isTruck(o) && o.state === 'broken';
  }

  /** Where a truck or machine is on the road: on the right-hand side of it, as each is shown. */
  private roadPos(o: Vehicle): [number, number] {
    if (isTruck(o)) return this.lanePos(o);
    const lane = B.MACHINE_LANE;
    return [o.x - Math.sin(o.dir) * lane, o.y + Math.cos(o.dir) * lane];
  }

  /** How long a truck or machine is, in tiles. */
  private vehicleLength(o: Vehicle): number {
    return isTruck(o) ? this.lengthOf(o) : B.MACHINE_LENGTH[o.kind as 'stacker' | 'tractor'];
  }

  /** How long a truck or machine has been held up, in ticks. */
  private heldFor(o: Vehicle): number {
    return isTruck(o) ? (o.held ?? 0) : o.blocked;
  }

  /** Which way a truck or machine is going: towards the next tile on its way, or the way it faces. */
  private goingTo(t: Vehicle): number {
    const next = t.path[0];
    if (next === undefined) return t.dir;
    const dx = this.map.xOf(next) + 0.5 - t.x;
    const dy = this.map.yOf(next) + 0.5 - t.y;
    return Math.hypot(dx, dy) > 1e-3 ? Math.atan2(dy, dx) : t.dir;
  }

  /** How long a truck is, in tiles. */
  private lengthOf(t: Truck): number {
    return B.truckLength(t.capacity, t.boxes);
  }

  /**
   * Where three or more roads meet, for the trucks. Not inside a stretch of
   * port road two or more wide all round, where trucks drive as they find
   * room. Cleared when the port changes.
   */
  private junctions(): Uint8Array {
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
  private turnable(i: number): boolean {
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
  private drivePath(from: number, cameFrom: number, goal: number, cost: CostFn): number[] | null {
    const m = this.map;
    return findDrivePath(m.w, m.h, from, cameFrom, goal, cost, (i) => this.turnable(i));
  }

  /** A truck's new way to its goal when the old one is blocked: never turning about where it cannot. */
  private truckReroute(t: Truck): (cost: CostFn) => number[] | null {
    return (cost) => this.drivePath(this.tileOf(t), this.behind(t), t.goal, cost);
  }

  /** The tile a truck has just come from, by the way it faces. */
  private behind(t: Truck): number {
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
  private roadRank(i: number): number {
    const b = this.map.build[i];
    return isHighway(b) ? 3 : isPublicRoad(b) ? 2 : b === Build.Parking ? 0 : 1;
  }

  /**
   * Where a truck coming in for `goal` comes onto the map: off the end of
   * the highway nearer it, heading in; on a map without one, at the end of
   * the main road.
   */
  private arrival(goal: number): { tile: number; dir: number } {
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
  private departure(from: number): number {
    const m = this.map;
    return hasHighway(m) ? nearestEnd(m, highwayOuts(m), m.yOf(from)) : m.entry;
  }

  /** Unit heading from tile `a` to the neighbouring tile `b`. */
  private heading(a: number, b: number): [number, number] {
    const m = this.map;
    return [m.xOf(b) - m.xOf(a), m.yOf(b) - m.yOf(a)];
  }

  /** Whether a truck or machine about to drive onto junction `i` has room to drive off it again. */
  private roomPast(t: Vehicle, i: number): boolean {
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
  private goesFirst(a: Vehicle, b: Vehicle, i: number): boolean {
    const turn = Math.floor(this.tick / B.TRUCK_TAKE_TURNS) + i;
    return (turn & 1) === 0 ? a.id < b.id : a.id > b.id;
  }

  /**
   * Whether a truck, or a port machine in traffic, may drive on into tile
   * `i`: the level crossing is open, and at a junction, or coming out of
   * parking, the rules of the road let it.
   */
  private mayEnter(t: Vehicle): (i: number) => boolean {
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
  private onOneWay(from: number, junction: number): number {
    const m = this.map;
    const f = oneWay(m, junction);
    return !isHighway(m.build[junction]) && f >= 0 && oneWay(m, from) >= 0 ? 0.5 : 0;
  }

  /** Nobody standing at the end of the highway (or road) where a new truck comes in. */
  private entryClear(tile = this.map.entry): boolean {
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

  private truckLeave(t: Truck): void {
    const bay = this.dest(t.bayIdx);
    if (bay) bay.nextTruckTick = this.tick + 30;
    // Off on its round: its haulier cannot send it again until it is back.
    const haulier = this.contracts.find((c) => c.id === t.contractId);
    if (haulier && !t.away) (haulier.returns ??= []).push(this.tick + B.TRUCK_ROUND_TRIP);
    t.away = true;
    if (t.cargo > 0) {
      if (this.town) this.town.today += t.boxes ? t.cargo * B.CONTAINER_GOODS : t.cargo;
      const income = t.value;
      this.book(t.boxes ? 'containers' : 'cargo', income);
      this.stats.earned += income;
      this.stats.trucks++;
      this.moneyAt(income, this.tileOf(t));
      if (this.deliverInTown(t)) return;
    }
    this.headOut(t);
  }

  /**
   * Send a loaded truck by way of the town, when one of its businesses
   * still wants what it carries today and the trucks can get there.
   */
  private deliverInTown(t: Truck): boolean {
    const town = this.town;
    if (!town) return false;
    const kind = t.boxes ? 'boxes' : 'crates';
    const count = Math.min(t.cargo, Math.floor(town.wants[kind]));
    if (count <= 0) return false;
    const m = this.map;
    const here = this.tileOf(t);
    // Out to the highway and round to the town's road, unless the roads join up on the map.
    const out =
      town.gate >= 0
        ? this.drivePath(here, this.behind(t), m.entry, this.truckCost(m.entry, t.bayIdx))
        : null;
    const round = Math.abs(m.yOf(town.gate) - m.yOf(m.entry)) + 2 * Math.abs(HIGHWAY_X);
    let best: { path: number[]; then?: number[]; len: number } | null = null;
    let drop = -1;
    for (let i = 0; i < m.build.length; i++) {
      const def = BUSINESSES[m.build[i]];
      if (!def || def.boxes !== t.boxes) continue;
      // Delivered at the kerb, on the street the business faces.
      const front = frontOf(m, i, m.orient[i] & 3);
      if (front < 0 || !isPublicRoad(m.build[front])) continue;
      const cost = this.truckCost(front, t.bayIdx);
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
    town.wants[kind] -= count;
    t.state = 'toTown';
    t.path = best.path;
    t.then = best.then;
    t.goal = best.path.length > 0 ? best.path[best.path.length - 1] : here;
    t.drop = drop;
    t.dropCount = count;
    return true;
  }

  /** Along the highway past the edge of the map, from the port's road round to the town's. */
  private driveRound(t: Truck): boolean {
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
  private startBacking(t: Truck, bay: Bay): void {
    if (bay.tiles || t.exports || t.path.length !== 1 || t.path[0] !== bay.idx) return;
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
  private backIn(t: Truck, bay: Bay): boolean {
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
  private backingPose(t: Truck): { x: number; y: number; dir: number } {
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
  private headOut(t: Truck): void {
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
      const path = this.routeFrom(t, exit, this.truckCost(exit, t.bayIdx, t));
      if (!path) continue;
      t.state = 'leaving';
      t.goal = exit;
      t.path = path;
      return;
    }
    this.removeTruck(t);
  }

  /** A parked truck gives up waiting and drives off. */
  private leavePark(t: Truck): void {
    this.truckLeave(t);
    t.park = undefined;
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
  private steerPoints(a: Agent, n: number): { x: number; y: number; passes: boolean }[] {
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
  private drive(a: Agent, top: number, room = Infinity, stop = true): number {
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

  /**
   * A warning that comes back while the trouble lasts: given at once, then
   * again after a day, two, four and at most eight, so it is never noise.
   */
  private nag(key: string, text: string, tone: 'info' | 'good' | 'bad'): void {
    const n = this.nags.get(key);
    if (n && this.tick < n.next) return;
    const gap = n ? Math.min(n.gap * 2, TICKS_PER_DAY * 8) : TICKS_PER_DAY;
    this.nags.set(key, { next: this.tick + gap, gap });
    this.message(text, tone);
  }

  /** Have the advisor explain something, the first time it comes up in a game. */
  private tip(id: string): void {
    if (this.tipsSeen.has(id)) return;
    this.tipsSeen.add(id);
    this.events.push({ kind: 'tip', id });
  }

  /** As tip, but not if the player has already `done` what it would teach them. */
  private tipUnless(id: string, done: boolean): void {
    if (done) this.tipsSeen.add(id);
    else this.tip(id);
  }

  /**
   * The first steps, a boat leaving at a time: speeding the game up, then
   * another jetty, another contract and the finance and statistics screens.
   * Each comes after the one before, the next boat but one, and none the
   * player has already got round to.
   */
  private departTips(): void {
    const n = ++this.departed;
    const at = FIRST_STEPS.findIndex((id) => !this.tipsSeen.has(id));
    // One a boat, the first after the first boat has left.
    if (at < 0 || n <= at) return;
    const id = FIRST_STEPS[at];
    this.tipUnless(id, id === 'jetty' && this.docks().length > 1);
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
      depth: this.map.depth[i],
      ocean: this.map.ocean[i],
      build: this.map.build[i],
      orient: this.map.orient[i],
      deco: this.map.deco[i],
      store: this.map.store[i],
    }));
    this.dirty.clear();
    return out;
  }

  // ── Explanations ──────────────────────────────────────────
  //
  // Why something is held up, in words, for the info panels: the same
  // checks the sim makes, said out loud.

  /** What a ship coming in to its berth is doing: on its way, or waiting for one in its way to sail. */
  private arrivingWords(b: Boat): string {
    const o = b.waitingOn !== undefined && this.boats.find((q) => q.id === b.waitingOn);
    if (!o || (b.waitedFor ?? 0) <= B.BERTH_BLOCKED_TICKS) return 'Sailing to the jetty';
    const what =
      o.vessel === 'feeder' ? 'feeder ship' : o.vessel === 'coaster' ? 'coaster' : 'boat';
    return `Waiting for the ${o.company} ${what} moored in its way to sail`;
  }

  private boatWhy(b: Boat): string | undefined {
    const hands = this.people.some((q) => q.kind === 'dockhand');
    if (b.state === 'anchored') {
      if (b.vessel === 'feeder' && this.berthCount(b.draft, true, true) === 0) {
        return `No berth for a feeder ship: it needs a harbour or gantry crane on a quay two tiles wide, in ${B.FEEDER_DRAFT} m of water.`;
      }
      if (b.vessel === 'coaster' && this.berthCount(b.draft, true) === 0) {
        return `No berth for a coaster: it needs a quay two tiles wide, in ${B.COASTER_DRAFT} m of water.`;
      }
      if (
        b.vessel !== 'feeder' &&
        !hands &&
        [...this.cranes.values()].some((c) => c.kind === 'jib')
      ) {
        return 'With no dockhands to unload by hand, boats wait for a berth under a jib crane. Hire dockhands, or build more jib cranes.';
      }
      return 'Every berth it fits is taken, or a boat is coming or going in the way. More berths help.';
    }
    if (b.state === 'arriving' && (b.waitedFor ?? 0) > B.BERTH_BLOCKED_TICKS) {
      return 'A ship moored across its way in must sail first. One still taking exports on board takes those already on their way, then sails.';
    }
    if (b.state !== 'moored' || b.crates === 0) return undefined;
    if (b.vessel === 'feeder') {
      const cranes = [...this.cranes.values()].filter((c) => c.kind !== 'jib');
      if (cranes.length > 0 && cranes.every((c) => this.stackFull(c))) {
        return 'The cranes have set down all they can: reach stackers must take the containers to a container yard first.';
      }
      return undefined;
    }
    const jib = [...this.cranes.values()].find(
      (c) => c.kind === 'jib' && this.near(c.idx, b.berth),
    );
    const spots = this.pickupSpots(b).filter((t) => walkableAt(this.map, t));
    if (!jib && (spots.length === 0 || !hands)) {
      return hands
        ? 'Dockhands cannot get to it: it lies by machines-only ground. Forklifts cannot unload boats.'
        : 'Nobody to unload it: forklifts cannot unload boats. Hire dockhands, or berth boats under a jib crane.';
    }
    if (jib && jib.stack.length >= B.CRANE_STACK && !this.jibStows(jib)) {
      return "The crane's landing stack is full: a forklift must take it away. Crate storage within reach would take crates straight in.";
    }
    if (b.vessel === 'coaster' && !this.forklifts() && !(jib && this.jibStows(jib))) {
      return 'Its crates are on pallets: dockhands set them down on the quay, but only forklifts take them on.';
    }
    return undefined;
  }

  private workerWhy(p: Dockhand): string | undefined {
    if (p.state !== 'idle' || p.kind !== 'dockhand') return undefined;
    const waiting = this.boats.filter(
      (b) => b.state === 'moored' && b.vessel !== 'feeder' && b.crates - b.reserved > 0,
    );
    const outOfReach = waiting.filter(
      (b) => !this.pickupSpots(b).some((t) => walkableAt(this.map, t)),
    );
    if (waiting.length > 0 && outOfReach.length === waiting.length) {
      return 'Boats are waiting, but dockhands keep off machines-only ground and the ground round cranes.';
    }
    return undefined;
  }

  /** What a truck waiting in the parking to load is waiting for. */
  private parkedWords(t: Truck): string {
    const bay = this.dest(t.bayIdx);
    if (bay && t.boxes && !this.handlerFree(bay, t)) {
      return 'Parked, waiting for a free reach stacker to load it';
    }
    return 'Parked, waiting for a loading spot';
  }

  private truckWhy(t: Truck): string | undefined {
    if (t.exports && t.state === 'parked' && this.tick >= (t.papers ?? Infinity)) {
      const store = t.boxes ? 'container yard' : 'crate storage';
      if (!this.outgoingRoom(t)) return `No outgoing ${store} has room for its load.`;
      const stores = [...(t.boxes ? this.yards : this.bays).values()].filter(
        (b) => this.takesExports(b) && bayRoom(b, t.boxes) >= t.cargo,
      );
      // Those parked nearer, inside the port, take the spots first.
      const nearer =
        t.staged === undefined
          ? this.stagingSpace(t)
            ? ''
            : ' No free parking nearer the storage, inside the port, for it to wait at instead.'
          : '';
      if (t.staged === undefined && stores.some((b) => this.stagedFor(b, t))) {
        return `Waiting its turn: shippers' trucks parked nearer the outgoing ${store}, inside the port, unload first.${nearer}`;
      }
      if (stores.some((b) => this.oneWayLane(b)) && !stores.some((b) => this.queueRoom(b))) {
        return `Waiting its turn: the queue at the outgoing ${store}'s yard gantry is full. A longer yard along the gantry's lane gives room for more.${nearer}`;
      }
      // Spots free, but those on their way in to the others have to get past them first.
      const free = stores.some((b) => this.freeDockSet(b, this.lengthOf(t)).size > 0);
      return free
        ? `Waiting its turn: trucks already on their way in to unload at the outgoing ${store} go first, so it would not stand in their way.${nearer}`
        : `Outgoing ${t.boxes ? 'container yards have' : 'crate storage has'} room, but every spot beside it to unload is taken${t.boxes ? ', or spoken for by trucks on their way in' : ''}. More tiles along the side trucks use give more spots.${nearer}`;
    }
    if (t.state === 'parked' && !t.exports) {
      const bay = this.dest(t.bayIdx);
      if (!bay) return undefined;
      const what = bay.yard ? 'container yard' : bay.tiles ? 'crate storage' : 'truck bay';
      if (bay.noAccess) return bay.noAccessWhy;
      if (this.oneWayLane(bay)) {
        const n = this.inQueue(bay);
        return `The queue at the yard gantry is full: ${n} ${n === 1 ? 'truck is' : 'trucks are'} loading or lined up for it. A longer yard along the gantry's lane gives room for more.`;
      }
      if (!t.boxes || this.handlerFree(bay, t)) {
        const going = this.trucks.filter(
          (o) => o.bayIdx === bay.idx && (o.state === 'toBay' || this.docked(o)),
        ).length;
        return this.freeDockSet(bay, this.lengthOf(t)).size === 0
          ? `Every loading spot at the ${what} is taken: ${going} ${going === 1 ? 'truck is' : 'trucks are'} loading there or on the way.${bay.tiles ? ' A truck longer than a tile takes the spots either side of it too.' : ''}${bay.yard ? " A longer yard along the gantry's lane gives more spots." : ''}`
          : `Spots at the ${what} are free, but trucks on their way in go first, so it would not stand in their way.`;
      }
      const stackers = this.people.filter((p) => p.kind === 'stacker').length;
      return `This yard has no yard gantry: reach stackers load its trucks, and ${stackers === 0 ? 'there are none' : `all ${stackers} are busy`}. More reach stackers, or a yard gantry here, load trucks sooner.`;
    }
    if (t.state !== 'loading') return undefined;
    const bay = this.dest(t.bayIdx);
    if (!bay) return undefined;
    if (t.boxes && bay.yard && this.cleared(bay) === 0 && bay.boxes.length > 0) {
      return 'Waiting for customs to clear the containers in the yard.';
    }
    if (this.collectable(bay) === 0) {
      return 'Waiting for more cargo. It leaves part-loaded if none comes soon.';
    }
    if (this.byHand(t, bay) && (t.coming ?? 0) === 0) {
      const crew = this.people.filter((p) => p.kind === 'dockhand' || p.kind === 'forklift');
      return crew.length === 0
        ? 'Dockhands or forklifts load crate trucks, and there are none. Hire some.'
        : 'Waiting for a dockhand or forklift to load it: they are busy, or cannot walk or drive here. More of them, or a path to this bay, load it sooner.';
    }
    return undefined;
  }

  private craneWhy(c: Crane): string {
    const full = this.stackFull(c);
    if (c.kind === 'jib') {
      const stores = this.jibStores(c);
      if (c.busy) {
        return stores.some((a) => bayRoom(a, false) > 0 && this.takesImports(a))
          ? 'Swinging crates straight into crate storage.'
          : 'Lifting crates onto its landing stack.';
      }
      if (full) {
        return 'Landing stack full: waiting for a forklift to take it away. Dockhands keep off the ground round a crane.';
      }
      if (c.stack.length > 0) return 'Waiting for a forklift to collect its landing stack.';
      return this.berthTrouble(c) ? 'No boat can come alongside it.' : 'No boat lying under it.';
    }
    if (c.busy) return 'Lifting containers off the ship.';
    // Nowhere for them to go: every yard with room has stopped taking them.
    const yards = [...this.yards.values()].filter((y) => !y.outgoing && bayRoom(y, true) > 0);
    if (c.stack.length > 0 && yards.length > 0 && yards.every((y) => y.shut)) {
      return 'Every container yard with room has stopped taking containers: open one to them again, or mark out another.';
    }
    if (full) {
      return c.kind === 'gantry'
        ? 'The bay between its legs is full: waiting for reach stackers.'
        : 'Stack full: waiting for reach stackers.';
    }
    return c.stack.length > 0
      ? 'Waiting for reach stackers to take the containers to a yard.'
      : this.berthTrouble(c)
        ? 'No container ship can come alongside it.'
        : 'No container ship alongside.';
  }

  /**
   * Why no ship can ever come alongside this crane, as the harbour master
   * would see it, or null if one could and there is simply none there now.
   * A jib crane takes any boat; a container crane a feeder, against a quay
   * two wide, with room for its hull and water deep enough.
   */
  private berthTrouble(c: Crane): string | null {
    const m = this.map;
    const feeder = c.kind !== 'jib';
    const draft = feeder ? B.FEEDER_DRAFT : B.BOAT_DRAFT;
    const water = this.boatCostFor(draft);
    const what = feeder ? 'a container ship' : 'a boat';
    let deepest = -1;
    let office = false;
    let wide = false;
    let room = false;
    // Berths square in front of it, where a ship lies centred on it, as the
    // harbour master looks for them (see freeBerths).
    for (const j of feeder ? this.craneFront(c) : [c.idx]) {
      for (const n of m.neighbors4(j)) {
        if (m.ocean[n] !== 1 || m.build[n] !== Build.None) continue;
        deepest = Math.max(deepest, m.depth[n]);
        if (!this.dockInUse(j)) continue;
        office = true;
        if (feeder && !this.wideQuay(j, n)) continue;
        wide = true;
        if (!this.footprint(n, j, this.boatHalf(feeder))) continue;
        room = true;
        if (water(n) === 1) return null;
      }
    }
    if (deepest < 0) return `No open water beside it for ${what} to lie in.`;
    if (!office) {
      return 'No ship will come: this quay is not run by a harbour office. Build one nearby.';
    }
    if (!wide)
      return 'A container ship moors only against a quay two tiles wide: widen the quay here.';
    if (!room) {
      const reach = this.boatHalf(feeder);
      return `No room alongside for ${what}'s hull: it lies centred on the crane, and needs open water ${reach} tile${reach === 1 ? '' : 's'} either way along the quay from it.`;
    }
    return `The water alongside is only ${deepest.toFixed(1)} m deep, and ${what} needs ${draft} m: dredge in front of it.`;
  }

  /**
   * Everything on the map that cannot work as it is built, for a red mark
   * over it: a crane no ship can come alongside, storage or a truck bay the
   * trucks cannot reach, parking no truck can use.
   */
  private problems(): ProblemView[] {
    const m = this.map;
    const out: ProblemView[] = [];
    const middle = (tiles: number[]) => ({
      x: tiles.reduce((n, i) => n + m.xOf(i) + 0.5, 0) / tiles.length,
      y: tiles.reduce((n, i) => n + m.yOf(i) + 0.5, 0) / tiles.length,
    });
    for (const c of this.cranes.values()) {
      const text = this.berthTrouble(c);
      const h = c.kind === 'jib' ? 1.7 : c.kind === 'gantry' ? 2.9 : 2.3;
      if (text) out.push({ ...middle([c.idx]), h, text, type: 'crane', idx: c.idx });
    }
    // Yard gantries working no yard: beside none, or a second by one.
    for (const [g, text] of this.gantries().idle) {
      out.push({ ...middle([g]), h: 1.6, text, type: 'yardGantry', idx: g });
    }
    for (const b of [...this.bays.values(), ...this.yards.values()]) {
      // Crate storage the trucks cannot reach is still a buffer the forklifts empty.
      if (!b.noAccess || b.warehouse || (b.tiles && !b.yard)) continue;
      out.push({
        ...middle(b.tiles ?? [b.idx]),
        h: 1.2,
        text: b.noAccessWhy ?? 'Trucks cannot reach it.',
        type: b.yard ? 'yard' : 'bay',
        idx: b.idx,
      });
    }
    for (const lot of this.parkingLots()) {
      const why = this.lotTrouble(lot);
      if (why)
        out.push({
          ...middle(lot.tiles),
          h: 0.9,
          text: `Not in use: ${why}.`,
          type: 'parking',
          idx: lot.tiles[0],
        });
    }
    return out;
  }

  /** Cargo waiting at each step from boat to truck, for the cargo flow. */
  private waitingCargo(): Snapshot['stock'] {
    const cranes = [...this.cranes.values()];
    const yards = [...this.yards.values()];
    const boxes = yards.reduce((n, y) => n + y.boxes.length, 0);
    const cleared = yards.reduce((n, y) => n + this.cleared(y), 0);
    return {
      landed:
        [...this.piles.values()].reduce((n, p) => n + p.crates.length, 0) +
        cranes.filter((c) => c.kind === 'jib').reduce((n, c) => n + c.stack.length, 0),
      stored: [...this.bays.values()].reduce((n, b) => n + b.crates.length, 0),
      crateExports: this.exportsWaiting(false),
      boxExports: this.exportsWaiting(true),
      boxLanded: cranes.filter((c) => c.kind !== 'jib').reduce((n, c) => n + c.stack.length, 0),
      boxCustoms: boxes - cleared,
      boxCleared: cleared,
    };
  }

  /** Every crate and container in the port, by where it is; see CargoStats. */
  private cargoStats(): CargoStats {
    const into = () => ({
      atSea: 0,
      onShips: 0,
      landed: 0,
      carried: 0,
      customs: 0,
      ready: 0,
      onTrucks: 0,
    });
    const out = () => ({ waiting: 0, comingIn: 0, stored: 0, carried: 0, atCrane: 0, aboard: 0 });
    const c: CargoStats = {
      crates: into(),
      containers: into(),
      crateExports: out(),
      containerExports: out(),
    };
    for (const b of this.boats) {
      if (b.state === 'leaving') continue;
      const boxes = b.vessel === 'feeder';
      const f = boxes ? c.containers : c.crates;
      if (b.state === 'moored') {
        f.onShips += b.crates;
        (boxes ? c.containerExports : c.crateExports).aboard += b.out ?? 0;
      } else f.atSea += b.crates;
    }
    for (const k of this.cranes.values()) {
      const boxes = k.kind !== 'jib';
      (boxes ? c.containers : c.crates).landed += k.stack.length;
      (boxes ? c.containerExports : c.crateExports).atCrane += k.outStack?.length ?? 0;
    }
    for (const p of this.piles.values()) c.crates.landed += p.crates.length;
    for (const b of this.bays.values()) {
      // Storage no truck can reach is a buffer by the cranes.
      if (b.noAccess && b.tiles) c.crates.landed += b.crates.length;
      else c.crates.ready += b.crates.length;
      c.containers.ready += b.boxes.length;
      c.crateExports.stored += b.exports?.length ?? 0;
    }
    for (const y of this.yards.values()) {
      const clear = this.cleared(y);
      c.containers.ready += clear;
      c.containers.customs += y.boxes.length - clear;
      c.containerExports.stored += y.exports?.length ?? 0;
    }
    for (const p of this.people) {
      if (!p.carrying) continue;
      const boxes = isBoxy(p);
      if (p.outbound) (boxes ? c.containerExports : c.crateExports).carried += p.carrying;
      else (boxes ? c.containers : c.crates).carried += p.carrying;
    }
    for (const t of this.trucks) {
      if (t.cargo <= 0) continue;
      if (!t.exports) {
        (t.boxes ? c.containers : c.crates).onTrucks += t.cargo;
        continue;
      }
      const e = t.boxes ? c.containerExports : c.crateExports;
      if (t.state === 'parked' || t.state === 'toPark') e.waiting += t.cargo;
      else if (t.state === 'toBay' || t.state === 'delivering') e.comingIn += t.cargo;
    }
    return c;
  }

  snapshot(): Snapshot {
    const entities: EntityView[] = [];
    const staff: StaffView[] = [];
    const lifts = this.gantryLifts();
    const jibs = this.jibLifts();
    const moved = (where: object) => this.jibMoved(jibs, where);
    for (const p of this.people) {
      entities.push({
        id: p.id,
        kind: p.kind,
        x: p.x,
        y: p.y,
        dir: p.dir,
        ...this.servedLoad(
          p,
          this.liftedLoad(
            p.carrying,
            isBoxy(p) ? [...this.carriedLooks(p)] : undefined,
            lifts.get(p.id),
          ),
        ),
        moving: p.path.length > 0,
        cargo: isBoxy(p)
          ? undefined
          : p.cargoFees.map((f) => cargoOf(f, p.outbound ? 'goods' : 'fish')),
        handling: this.handlingPhase(p),
        sitting:
          p.state === 'resting' && p.hutIdx >= 0 && this.map.build[p.hutIdx] === Build.BreakHut,
        name: p.name,
        activity:
          p.blocked > 3
            ? 'Waiting for someone to get out of the way'
            : activity(p, this.piles.has(p.bayIdx)),
        variant: 0,
        capacity: p.capacity,
        alert: p.state === 'broken' || (p.state === 'idle' && !!p.stuck),
        why: this.workerWhy(p),
        ...this.handView(p),
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
        activity: activity(p, this.piles.has(p.bayIdx)),
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
    const kind = (q: Boat) =>
      q.vessel === 'feeder' ? 'feeder ship' : q.vessel === 'coaster' ? 'coaster' : 'boat';
    for (const b of this.boats) {
      const plot = this.plots.get(b);
      const clear = this.keepingClear.get(b);
      const giving =
        clear && clear.pace < 1 ? this.boats.find((q) => q.id === clear.of) : undefined;
      entities.push({
        id: b.id,
        kind: 'boat',
        x: b.x,
        y: b.y,
        dir: b.dir,
        ...(b.vessel === 'feeder'
          ? this.deckView(b)
          : {
              load: b.crates + (b.out ?? 0) + moved(b).set - moved(b).taken,
              // Its catch, then what it has taken on board to go out.
              cargo: [
                ...Array<Cargo>(b.crates).fill(cargoOf(b.fee)),
                ...(b.outFees ?? []).map((f) => cargoOf(f, 'goods')),
              ],
            }),
        moving: b.path.length > 0,
        name: b.company,
        activity:
          (b.state === 'approaching'
            ? 'Sailing in from sea'
            : b.state === 'anchored'
              ? 'Waiting at anchor for a berth'
              : b.state === 'arriving'
                ? this.arrivingWords(b)
                : b.state === 'moored' && b.crates === 0 && b.reserved === 0
                  ? this.readyWords(b)
                  : b.state === 'moored'
                    ? `Unloading, ${b.crates} ${b.vessel === 'feeder' ? 'containers' : 'crates'} left`
                    : 'Heading back out to sea') +
          (giving ? `, giving way to a ${giving.company} ${kind(giving)}` : '') +
          (this.tugged(b) ? ', with a tug alongside' : ''),
        plot: plot && [...plot].flatMap((v, k) => (k % 9 < 2 ? [Math.round(v * 100) / 100] : [])),
        givingWayTo: giving?.id,
        variant: b.variant,
        capacity:
          b.vessel === 'feeder'
            ? B.FEEDER_MAX_LOAD
            : b.vessel === 'coaster'
              ? B.COASTER_MAX_LOAD
              : B.BOAT_MAX_LOAD,
        alert:
          b.state === 'anchored' ||
          (b.state === 'arriving' && (b.waitedFor ?? 0) > B.BERTH_BLOCKED_TICKS),
        why: this.boatWhy(b),
        vessel: b.vessel,
        boxes: b.vessel === 'feeder',
        visit: this.visitView(b),
      });
    }
    for (const t of this.tugs) {
      const ship = this.boats.find((b) => b.id === t.ship);
      const whose = ship ? `the ${ship.company} ${kind(ship)}` : 'a ship';
      entities.push({
        id: t.id,
        kind: 'boat',
        x: t.x,
        y: t.y,
        dir: t.dir,
        load: 0,
        moving: t.state !== 'idle',
        name: t.name,
        activity:
          t.state === 'idle'
            ? 'Lying at its berth'
            : t.state === 'out'
              ? `Heading out to ${whose}`
              : t.state === 'assist'
                ? ship?.state === 'leaving'
                  ? `Working ${whose} out of its berth`
                  : `Working ${whose} in alongside`
                : 'Heading back to its berth',
        variant: 0,
        capacity: 0,
        alert: false,
        vessel: 'tug',
      });
    }
    for (const t of this.trucks) {
      const shown = t.backing
        ? this.backingPose(t)
        : { x: this.lanePos(t)[0], y: this.lanePos(t)[1], dir: t.dir };
      entities.push({
        id: t.id,
        kind: 'truck',
        ...shown,
        // A shipper's containers are all alike; the rest as they were loaded.
        ...this.liftedLoad(
          t.cargo,
          t.boxes
            ? t.exports
              ? Array.from({ length: t.cargo }, (_, k) => boxLookOf(t.id, k))
              : [...aligned(Array(t.cargo).fill(0), t.looks, t.id)]
            : undefined,
          lifts.get(t.id),
        ),
        cargo: t.boxes ? undefined : this.truckCargo(t),
        moving: t.path.length > 0,
        name: t.company,
        activity:
          t.exports && (t.state === 'toPark' || t.state === 'parked')
            ? t.staged !== undefined && t.state === 'toPark'
              ? `Paperwork done, driving to parking nearer the outgoing storage to wait for a spot`
              : this.tick < (t.papers ?? Infinity) || t.state === 'toPark'
                ? `Bringing ${t.cargo} ${t.boxes ? 'containers' : 'crates'} to ship: paperwork first, parked outside the port`
                : this.outgoingRoom(t)
                  ? `Paperwork done, waiting for a free spot to unload at the outgoing storage`
                  : `Paperwork done, waiting for storage with room for its ${t.boxes ? 'containers' : 'crates'}`
            : t.exports && t.state === 'toBay'
              ? `Bringing ${t.cargo} ${t.boxes ? 'containers' : 'crates'} to storage, to ship`
              : t.state === 'delivering'
                ? `Unloading ${t.cargo} ${t.boxes ? 'containers' : 'crates'} to ship`
                : t.state === 'toPark'
                  ? 'Driving to the parking'
                  : t.state === 'parked'
                    ? this.parkedWords(t)
                    : t.state === 'toBay'
                      ? 'Driving to the truck bay'
                      : t.state === 'loading'
                        ? `Loading, ${t.cargo}/${t.capacity} ${t.boxes ? 'containers' : 'crates'}`
                        : t.state === 'toTown' || t.state === 'unloading'
                          ? `${t.state === 'toTown' ? 'Delivering' : 'Unloading'} ${t.dropCount} ${t.boxes ? 'containers' : 'crates'} at the ${BUSINESSES[this.map.build[t.drop ?? 0]]?.label ?? 'town'} in ${this.town?.name ?? 'town'}`
                          : 'Heading out to the highway',
        variant: t.variant,
        capacity: t.capacity,
        alert: false,
        boxes: t.boxes,
        why: this.truckWhy(t),
      });
    }
    const bays: BayView[] = [...this.bays.values()].map((b) => ({
      idx: b.idx,
      stock: b.crates.length + moved(b).set,
      boxes: b.boxes.length,
      capacity: bayCap(b),
      large: b.large,
      warehouse: !!b.warehouse,
      exports: (b.exports?.length ?? 0) - moved(b).taken,
      places: b.tiles && this.palletPlaces(b, heldIn(b) + moved(b).set),
      outgoing: !!b.outgoing,
      shut: !!b.shut,
      byCrane: this.byCrane(b),
      tiles: b.tiles && [...b.tiles],
      noAccess: b.noAccess,
      noAccessWhy: b.noAccess ? b.noAccessWhy : undefined,
      cargo: [
        ...b.crates.map((f) => cargoOf(f)),
        ...(b.exports ?? []).map((f) => cargoOf(f, 'goods')),
      ],
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
          : this.trucks.filter((t) => t.contractId === c.id && !t.away).length,
      away: (c.returns ?? []).filter((at) => at > this.tick).length,
      backIn: (c.returns ?? []).reduce(
        (n, at) => (at > this.tick && (n < 0 || at - this.tick < n) ? at - this.tick : n),
        -1,
      ),
      waiting: this.boats.filter((b) => b.contractId === c.id && b.state === 'anchored').length,
      nextIn: c.terms.kind !== 'haulier' ? Math.max(0, c.nextBoatTick - this.tick) : -1,
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
      history: this.history,
      daysInRed: this.daysInRed,
      bankrupt: this.bankrupt,
      stats: { ...this.stats },
      cargo: this.cargoStats(),
      cargoLog: this.cargoLog,
      entities,
      bays,
      yards: [...this.yards.values()].map((y) => ({
        idx: y.idx,
        boxes: y.boxes.length,
        exports: y.exports?.length ?? 0,
        ...this.yardLooks(y, lifts),
        outgoing: !!y.outgoing,
        shut: !!y.shut,
        byCrane: this.byCrane(y),
        gantry: this.yardGantry(y),
        cleared: this.cleared(y),
        buried: this.buriedCount(y),
        nextClear: this.nextClear(y),
        pending: this.pending(y),
        capacity: bayCap(y),
        tiles: [...(y.tiles ?? [y.idx])],
        noAccess: y.noAccess,
        noAccessWhy: y.noAccess ? y.noAccessWhy : undefined,
      })),
      problems: this.problems(),
      parking: this.parkingLots().map((lot) => {
        const keys = new Set(lot.spaces.map((sp) => sp.tiles[0]));
        return {
          tiles: lot.tiles,
          outside: lot.outside,
          wide: lot.wide,
          spaces: lot.spaces.length,
          used: this.trucks.filter((t) => t.park !== undefined && keys.has(t.park)).length,
          why: this.lotTrouble(lot),
        };
      }),
      piles: [...this.piles.values()].map((p) => ({
        idx: p.idx,
        crates: p.crates.length - moved(p).taken,
        pallets: !!p.pallets,
        out: !!p.out,
        cargo: p.crates.map((f) => cargoOf(f, p.out ? 'goods' : 'fish')),
      })),
      contracts,
      capacity: this.capacity(),
      stock: this.waitingCargo(),
      docks: {
        total: this.docks().length,
        coordinated: this.docks().filter((g) => g.coordinated).length,
        offices: this.map.build.filter((b) => b === Build.Office).length,
        huts: this.map.build.filter((b) => b === Build.HarbourHut).length,
        inUse: this.docks().flatMap((g) => (g.coordinated ? g.tiles : [])),
        idle: this.docks().flatMap((g) => (g.coordinated ? [] : g.tiles)),
      },
      depots: this.depotViews(),
      progress: { tier: this.tier, town: this.townSize(), canUpgrade: this.canUpgrade() },
      cranes: [...this.cranes.values()].map((c) => ({
        idx: c.idx,
        kind: c.kind,
        ...this.servedStack(c, moved(c).set),
        max: craneStack(c),
        angle: c.angle,
        busy: c.busy,
        stores: c.kind === 'jib' ? this.jibStores(c).length : 0,
        why: this.craneWhy(c),
        trouble: this.berthTrouble(c) ?? undefined,
        ...this.craneWork(c, jibs),
      })),
      town: this.town && {
        name: this.town.name,
        stage: this.town.stage,
        population: population(this.town, this.map),
        homes: townHomes(this.map),
        target: Math.round(townTarget(this.town)),
        jobs: this.town.jobs,
        goods: Math.round(this.town.goods),
        supplied: Math.round(this.town.supplied),
        wants: { ...this.town.wants },
        businesses: this.businessViews(),
        x: this.map.xOf(this.town.centre),
        y: this.map.yOf(this.town.centre),
      },
      train: this.rail.train && { ...this.rail.train, cars: [...this.rail.train.cars] },
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
