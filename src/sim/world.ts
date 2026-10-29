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
  TownView,
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
  type ShipperTerms,
  type Terms,
} from './contracts';
import { GameMap, type MapData } from './map';
import { extendMap, generateMap } from './mapgen';
import { randomName, townName } from './names';
import { crossingClosed, layRailway, newRail, stepRail, type RailState } from './railway';
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
import { findPath, type CostFn } from './path';
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
  STORE_COST,
  STORE_LABEL,
  STORE_TIER,
  loadingSpots,
  truckCost,
  truckReach,
  walkableAt,
} from './rules';
import { MACHINES } from './machines';
import { BUILD_TIER, MACHINE_TIER, TIERS } from './tiers';
import {
  Build,
  Deco,
  isBay,
  isBuoy,
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
  /**
   * Cargo set down being collected from: a heap landed on the quay, or a
   * storage area trucks cannot get to; or -1.
   */
  stockIdx: number;
  /** Where the load goes: a truck bay, or for containers a yard. */
  bayIdx: number;
  /** Stackers: the ship each container carried came off, by id. */
  cargoFrom?: number[];
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
  outReserved?: number;
  timer: number;
  angle: number;
  busy: boolean;
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
  /**
   * Exports it takes on board this visit: what was waiting in the port when
   * it was unloaded, less what other ships had claimed. Set then.
   */
  loadQuota?: number;
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
  plan?: { helm: number; astern: boolean; pivot?: boolean; until: number };
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
  /** Ticks left squeezing past other boats after being wedged in. */
  squeeze?: number;
  /**
   * Water a ship pulling out of its berth keeps to itself, as circles (x, y,
   * radius): the lane along the dock it runs out by and the water it turns
   * in at the end of it, then just that, until it has come round onto its
   * course or the tick `until`. Everyone else keeps out.
   */
  room?: { spots: [number, number, number][]; until: number; turning?: boolean };
  /** Has turned for sea after pulling out, and given its room back. */
  turned?: boolean;
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
  /** A shipper's truck, bringing goods in to go out on the ships. */
  exports?: boolean;
  /** When its paperwork is done and it may drive into the port. */
  papers?: number;
  /** Containers reach stackers are bringing it, or taking off it. */
  coming?: number;
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
  /** A container yard, marked out for containers. */
  yard?: boolean;
  /**
   * Storage for cargo going out on the ships, not coming in. Storage by a
   * crane takes either, one way at a time; see takesImports.
   */
  outgoing?: boolean;
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
  /** Exports promised to workers on their way to take them on board. */
  outReserved?: number;
  /** Container yards: cleared containers promised to stackers loading trucks. */
  truckReserved?: number;
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
  /** When container ships lately finished unloading; see unloadedAt. */
  unloaded?: [number, number][];
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

/** Forklifts take on what is landed on the quay or by a crane. */
const FORKLIFT_ACTIVITY: Partial<Record<DockhandState, string>> = {
  toPickup: 'Heading to the cargo',
  picking: 'Lifting crates',
};

/** What a worker is up to; `landing` when setting a load down on the quay. */
function activity(p: Dockhand, landing: boolean): string {
  if (p.state === 'idle' && p.stuck) return p.stuck;
  if (p.truckId !== undefined) {
    if (p.state === 'toPickup') return 'Heading to a truck at the container yard';
    if (p.state === 'picking') {
      return p.truckLoad ? 'Lifting a container off the stack' : 'Lifting a container off a truck';
    }
    if (p.state === 'dropping') {
      return p.truckLoad ? 'Setting a container on a truck' : 'Stacking a container';
    }
  }
  if (landing && (p.state === 'toDrop' || p.state === 'dropping')) {
    return 'Setting a crate down on the quay';
  }
  if (p.kind === 'forklift' && FORKLIFT_ACTIVITY[p.state]) return FORKLIFT_ACTIVITY[p.state]!;
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
  /** How far by road trucks have to each tile they can reach; see truckReach. */
  private reachCache: Int32Array | null = null;
  /** The parking lots, and whether each works; see parkingLots. */
  private lotsCache: ParkingLot[] | null = null;
  /** The town up the coast, which grows with the port. */
  town: Town | null = null;
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
  private buoyCache: Uint8Array | null = null;
  private frontCache: Int32Array | null = null;
  private coordinated = new Set<number>();
  /** Dock tile → its dock's key (the dock's lowest tile), with docks(). */
  private dockKey = new Map<number, number>();
  /** Advisor tips already given, so each comes once a game. */
  tipsSeen = new Set<string>();
  /** When each container ship lately finished unloading, by id, for customs. */
  unloadedAt = new Map<number, number>();
  private warnedOffice = false;
  private warnedParking = false;
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

  static create(seed: number): World {
    const { map, spawn } = generateMap(seed);
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
    world.unloadedAt = new Map(s.unloaded ?? []);
    if (s.rail) world.rail = structuredClone(s.rail);
    // The line runs on through any country added to the map since.
    layRailway(world.map);
    if (s.town === undefined) world.settle();
    else if (s.town) world.relay({ ...s.town });
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
      tugs: this.tugs,
      trucks: this.trucks,
      bays: [...this.bays.values()],
      yards: [...this.yards.values()],
      piles: [...this.piles.values()],
      town: this.town,
      rail: this.rail,
      scenery: this.scenery.state,
      tips: [...this.tipsSeen],
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
    this.spotCache.clear();
    this.reachCache = null;
    this.lotsCache = null;
    switch (cmd.type) {
      case 'build':
        return this.build(cmd.kind, cmd.tiles, cmd.facing);
      case 'bulldoze':
        return this.bulldoze(cmd.tiles);
      case 'forkliftOnly':
        return this.markForkliftOnly(cmd.tiles, cmd.on);
      case 'store':
        return this.markStore(cmd.tiles, cmd.kind, cmd.on);
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
          this.map.build[t] = crossing ? Build.Crossing : def.code;
          this.map.orient[t] = (ROTATABLE.has(kind) ? partOrient(f, k) : 0) | quay;
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
        if (kind === 'gantryCrane') this.addCrane(i, 'gantry');
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

  /** Mark port road and quay tiles out as storage, or clear them, for a refund. */
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
      }
    }
    for (const p of this.people) {
      const now = remap.get(p.bayIdx);
      if (now !== undefined) p.bayIdx = now;
      const area = this.dest(p.bayIdx);
      if (area?.tiles && p.planned > 0) {
        // Exports on their way into storage by a crane, or cargo coming in.
        if (p.outbound) area.exportIncoming = (area.exportIncoming ?? 0) + p.planned;
        else bayIncoming(area, p.kind === 'stacker', p.planned);
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
      if (this.map.build[i] === Build.Gantry) this.cranes.delete(i);
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
      if (this.jibStores(c).length > 0) stowing += rate;
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
    const moving = avg > 0 ? stackers * ((TICKS_PER_DAY * 0.85) / (trip + bare * loading)) : 0;
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
    if (this.tick % TICKS_PER_DAY === 0) this.newDay();
    this.spawnBoats();
    for (const b of [...this.boats]) this.updateBoat(b);
    this.updateTugs();
    for (const c of this.cranes.values()) this.updateCrane(c);
    this.countOccupancy();
    for (const p of this.people) this.updateDockhand(p);
    if (this.tick % 10 === 0) this.spawnTrucks();
    if (this.tick % 10 === 5) this.spawnShipments();
    for (const t of [...this.trucks]) this.updateTruck(t);
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
        // Berths under a harbour crane are kept for container ships.
        if (needCrane !== this.harbourCraneReaches(n)) continue;
        if (!this.footprint(n, j, this.boatHalf(needCrane))) continue;
        const nx = m.xOf(n);
        const ny = m.yOf(n);
        // A crane is only any use with forklifts to take what it lands, or
        // storage it can swing it into: dockhands keep away from cranes.
        const craned = [...this.cranes.values()].some(
          (c) =>
            c.kind === 'jib' &&
            Math.max(Math.abs(m.xOf(c.idx) - nx), Math.abs(m.yOf(c.idx) - ny)) <= 1 &&
            (forks || this.jibStores(c).length > 0),
        );
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
        // under a crane first, then a quay forklifts can reach.
        const bonus = craned ? 200 : m.build[j] === Build.Jetty ? 0 : 100;
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
            this.message('Boats are queueing at the anchorage. Every berth is taken.', 'info');
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
          const what =
            b.vessel === 'feeder' ? 'feeder ship' : b.vessel === 'coaster' ? 'coaster' : 'boat';
          const cargo =
            b.vessel === 'feeder'
              ? 'containers'
              : b.vessel === 'coaster'
                ? 'crates on pallets'
                : 'crates';
          this.message(`A ${b.company} ${what} has moored with ${b.crates} ${cargo}.`, 'info');
          if (b.vessel === 'coaster') this.tip('pallets');
          if (b.vessel === 'coaster' && !this.people.some((p) => p.kind === 'forklift')) {
            this.message(
              'Pallets wait on the quay until a forklift takes them on. Buy one at a depot.',
              'bad',
            );
          }
        }
        return;
      }
      case 'moored': {
        // Unloaded, a coaster or feeder takes exports on board before it goes.
        const loading = b.crates === 0 && b.reserved === 0 && this.stillLoading(b);
        // Unloading and loading count against us; waiting for the fairway does not.
        if (b.crates > 0 || b.reserved > 0 || loading) b.mooredTicks++;
        if (loading) {
          // Kept loading long past its time, it sails with what it has.
          if (b.mooredTicks > b.grace + B.LOAD_OVERRUN_TICKS) b.loadQuota = b.out ?? 0;
          b.timer = 0;
          return;
        }
        if (b.crates === 0 && b.reserved === 0 && ++b.timer > 30) {
          const ready = !this.boxedIn(b) && !this.letsGoFirst(b) && this.tugReady(b);
          if (ready && this.takeFairway(b, true)) {
            this.depart(b, false);
          }
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
          return (
            stuck ||
            (this.clips(b, x, y, d, ships) <= now &&
              !this.crowds(b, x, y, d) &&
              !this.intoClaimed(b, x, y))
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
            (this.crowds(b, nx, ny) || this.intoClaimed(b, nx, ny)) &&
            (b.held ?? 0) <= B.BOAT_WEDGED_AFTER;
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
    const avoid = this.seaWay(b);
    const clear: CostFn = (i) => (avoid(i) === 1 ? 1 : Infinity);
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
        if (this.navigable(nx, ny, this.boatCostFor(b.draft))) {
          b.x = nx;
          b.y = ny;
          b.speed = coast;
          return 'moving';
        }
      }
      this.goAstern(b);
      if ((b.held ?? 0) > B.BOAT_WEDGED_AFTER) {
        b.squeeze = 200;
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
    const fits = (x: number, y: number, d: number) => this.clips(b, x, y, d, ships) <= now;
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
      // The best whose very first step is clear too.
      const best = this.manoeuvre(b, ax, ay, adir, speed, ships, now, reach).find((o) => {
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
    } else if (plan && next && way.speed > 0.05) {
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
    // Squeezing past as a last resort, it may brush the dock too.
    const fits = (x: number, y: number, d: number) =>
      (b.squeeze ?? 0) > 0 || (this.navigable(x, y, cost) && this.clips(b, x, y, d, ships) <= now);
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
      b.squeeze = 200;
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
        this.clips(b, sx, sy, b.dir, ships) <= this.clips(b, b.x, b.y, b.dir, ships);
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
        this.clips(b, sx, sy, swung, ships) <= this.clips(b, b.x, b.y, b.dir, ships);
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
  private goAstern(b: Boat): void {
    const v = B.VESSELS[b.vessel];
    const cost = this.boatCostFor(b.draft);
    const back = Math.min(v.speed * 0.3, (b.sternway ?? 0) + v.speed * B.BOAT_ACCEL);
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
    const m = this.map;
    return (yard.tiles ?? [yard.idx]).some((i) =>
      m.neighbors4(i).some((n) => m.build[n] === Build.YardGantry),
    );
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

  /** A container truck at a yard with no gantry, which reach stackers load or unload. */
  private byStacker(t: Truck, bay: Bay): boolean {
    return t.boxes && !!bay.yard && !this.yardGantry(bay);
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
            this.cleared(yard) - (yard.truckReserved ?? 0),
          )
        : t.cargo - (t.taking ?? 0);
      if (avail <= 0) continue;
      // A truck was only sent in because a stacker was free for it: it comes first.
      sources.push({ tile: this.besideTruck(yard, t), avail, truck: t, load, rank: -1 });
    }
  }

  /** The yard tile nearest a truck loading beside it, where a stacker works it. */
  private besideTruck(yard: Bay, t: Truck): number {
    const m = this.map;
    const near = (i: number) => Math.hypot(m.xOf(i) + 0.5 - t.x, m.yOf(i) + 0.5 - t.y);
    return (yard.tiles ?? [yard.idx]).reduce((a, b) => (near(b) < near(a) ? b : a));
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
          const at = ready.findIndex((r) => this.isClear(r));
          if (at >= 0) {
            ready.splice(at, 1);
            fee = yard.boxes.splice(at, 1)[0];
          } else t.coming = Math.max(0, (t.coming ?? 0) - 1);
        } else {
          t.taking = Math.max(0, (t.taking ?? 0) - 1);
          if (t.cargo > 0) {
            t.cargo--;
            fee = t.value;
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
        t.idle = 0;
      } else if (yard) {
        this.readyList(yard).push(0);
        yard.boxes.push(fee);
      }
    } else if (yard) {
      (yard.exports ??= []).push(fee);
      yard.exportIncoming = Math.max(0, (yard.exportIncoming ?? 0) - 1);
    }
  }

  /** Give back what a truck job promised, setting down anything in hand. */
  private releaseTruckJob(p: Dockhand): void {
    if (p.truckId === undefined) return;
    const t = this.trucks.find((q) => q.id === p.truckId);
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
    return this.boats.some((o) => {
      const w = B.VESSELS[o.vessel];
      if (o === b || Math.hypot(o.x - x, o.y - y) > (v.length + w.length) / 2 + 1) return false;
      const after = hullGap(x, y, dir, v, o.x, o.y, o.dir, w);
      return after < 0.1 && after < hullGap(b.x, b.y, b.dir, v, o.x, o.y, o.dir, w);
    });
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
      // it lies, is plotted lying there until it gets going again.
      const v = B.VESSELS[b.vessel];
      const moving = (b.speed ?? 0) + (b.sternway ?? 0) > v.speed * 0.1;
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
  private giveWay(b: Boat): { speed: number; makeWay: number } {
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
    // Wedged in for most of a day: a last resort so the harbour never locks
    // up for good. It squeezes past.
    const wedged = (b.squeeze ?? 0) > 0;
    const m = this.map;
    this.roomWait.delete(b);
    for (const o of this.boats) {
      if (o === b) continue;
      const other = this.hullOf(o);
      const still = o.state === 'moored' || o.state === 'anchored';
      // Squeezing past boats under way, never over one lying still.
      if (wedged && !still) continue;
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
      const kept =
        still && (b.held ?? 0) < B.KEEP_CLEAR_PATIENCE
          ? this.inWay(me, { ...other, half: other.half + B.BERTH_END_GAP }, look)
          : null;
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
          speed = Math.min(speed, clamp(safe / v.speed, 0, 1));
        } else {
          speed = Math.min(speed, clamp((gap - room) / 0.5, 0, 1));
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
      if (this.inWay(this.wakeOf(o), me, other.half + 0.8) !== null) makeWay = head;
    }
    return { speed, makeWay };
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
    this.tip(kind === 'stacker' ? 'stackers' : 'forklifts');
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
    if (p.truckId !== undefined && this.truckJob(p)) return;
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
        if (bay && !(p.outbound && bay.tiles)) {
          bayIncoming(bay, p.kind === 'stacker', -(p.planned - fees.length));
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
          if (!crane || !this.headTo(p, this.pickTile(crane))) this.retargetCrate(p);
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
          p.state = 'dropping';
          p.timer = this.handlingTicks(p, B.DROP_TICKS);
        }
        return;
      }
      case 'dropping': {
        if (--p.timer > 0) return;
        if (this.dropOutbound(p)) return;
        const bay = this.dest(p.bayIdx);
        if (!bay) return this.retargetCrate(p);
        const boxy = p.kind === 'stacker';
        // Customs clear a container a while after it is stacked in the yard.
        // Their times go on first, while the list still matches the yard.
        if (boxy) {
          const from = p.cargoFrom ?? [];
          this.readyList(bay).push(...p.cargoFees.map((_, k) => this.customsFor(from[k])));
          p.cargoFrom = undefined;
        }
        (boxy ? bay.boxes : bay.crates).push(...p.cargoFees);
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
    const boxy = p.kind === 'stacker';
    const what = boxy ? 'Reach stackers' : 'Forklifts';
    const reach = (goal: number) => !!this.pathFor(p, here, goal);
    const sources: number[] = [];
    for (const c of this.cranes.values()) {
      if ((c.kind !== 'jib') === boxy && c.stack.length > 0) sources.push(this.pickTile(c));
    }
    // Forklifts take what the dockhands land on the quay.
    if (!boxy)
      for (const pile of this.piles.values()) if (pile.crates.length) sources.push(pile.idx);
    let stuck: string | null = null;
    const dests = [...(boxy ? this.yards : this.bays).values()];
    if (!dests.some((d) => this.dropAt(p, d, here) >= 0)) {
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
    const boxy = p.kind === 'stacker';
    // Pallets off a coaster need the forks of a forklift.
    const forks = p.kind === 'forklift';
    const hands = p.kind === 'dockhand';
    const sources: Source[] = [];
    for (const crane of this.cranes.values()) {
      if ((crane.kind !== 'jib') !== boxy) continue;
      if (crane.pallets && crane.stack.length > 0 && !forks) continue;
      const avail = crane.stack.length - crane.reserved;
      if (avail > 0) sources.push({ tile: this.pickTile(crane), avail, crane, rank: 0 });
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
        for (const tile of this.collectAt(store))
          sources.push({ tile, avail, pile: store, rank: 1 });
      }
    }
    this.exportSources(p, here, sources);
    if (boxy) this.truckSources(sources);
    const ordered = sources.sort(
      (a, b) => a.rank - b.rank || this.dist(here, a.tile) - this.dist(here, b.tile),
    );

    for (const src of ordered) {
      if (src.out) {
        if (this.takeExportJob(p, src, cost)) return true;
        continue;
      }
      if (src.truck) {
        if (this.takeTruckJob(p, src)) return true;
        continue;
      }
      if (!Number.isFinite(cost(src.tile))) continue;
      // The foreman sends no more than two to the same spot; the rest wait.
      if (this.workersAt(src.tile) >= B.WORKERS_PER_SPOT) continue;
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
      const planned = Math.min(p.capacity, src.avail, bayRoom(bay, boxy));
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
    const boxy = p.kind === 'stacker';
    if (!this.boats.some((b) => this.wantsLoad(b) && (b.vessel === 'feeder') === boxy)) return;
    const stores = boxy ? this.yards.values() : this.bays.values();
    for (const store of stores) {
      const avail = (store.exports?.length ?? 0) - (store.outReserved ?? 0);
      if (!store.tiles || avail <= 0) continue;
      const tile = this.dropAt(p, store, here);
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
    const target = this.exportTarget(p, src.tile, src.pile);
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
    if (p.kind === 'stacker') {
      for (const c of this.cranes.values()) {
        if (c.kind === 'jib') continue;
        const room = craneStack(c) - (c.outStack?.length ?? 0) - (c.outReserved ?? 0);
        if (room <= 0) continue;
        if (!this.boats.some((b) => this.wantsLoad(b) && this.craneReaches(c, b))) continue;
        if (this.pathFor(p, from, this.pickTile(c))) return { crane: c, room };
      }
      return null;
    }
    const hands = this.people.some((q) => q.kind === 'dockhand');
    for (const b of this.boats) {
      if (b.vessel !== 'coaster' || !this.wantsLoad(b)) continue;
      const room = outCap(b) - (b.out ?? 0) - (b.outIncoming ?? 0);
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
      const jib = cranes.length > 0;
      if (!hands && !jib) continue;
      for (const t of this.pickupSpots(b)) {
        const pile = this.pileAt(t, false, true);
        if (pile && this.pathFor(p, from, t))
          return { pile, room: Math.min(room, bayRoom(pile, false)) };
      }
    }
    return null;
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
   * A ship unloaded stays to take exports on board while any are waiting and
   * being brought to it, until it is full or nothing has come for a while.
   */
  private stillLoading(b: Boat): boolean {
    if (outCap(b) === 0) return false;
    if ((b.outIncoming ?? 0) > 0) return true;
    if ((b.out ?? 0) >= outCap(b)) return false;
    // It takes what is in the port when it is ready to go, never waiting for
    // more to come in, nor to fill up.
    if (b.loadQuota === undefined) {
      const boxes = b.vessel === 'feeder';
      const claimed = this.boats
        .filter((o) => o !== b && o.state === 'moored' && (o.vessel === 'feeder') === boxes)
        .reduce((n, o) => n + Math.max(0, (o.loadQuota ?? 0) - (o.out ?? 0)), 0);
      const room = outCap(b) - (b.out ?? 0);
      const take = clamp(this.exportsWaiting(boxes) - claimed, 0, room);
      b.loadQuota = (b.out ?? 0) + take;
      // The line allows time to load as well as to unload.
      b.grace += take * B.MOORED_TICKS_PER_CRATE;
    }
    if ((b.out ?? 0) >= b.loadQuota) return false;
    if (this.exportsWaiting(b.vessel === 'feeder') === 0) return false;
    // Its own cargo still being cleared off the crane comes first.
    const busy = [...this.cranes.values()].some(
      (c) => c.stack.length > 0 && this.craneReaches(c, b),
    );
    b.loadIdle = busy ? 0 : (b.loadIdle ?? 0) + 1;
    return b.loadIdle < B.LOAD_WAIT;
  }

  /** Exports go on board: the shipper pays for each as it does. */
  private shipOut(b: Boat, fees: number[]): void {
    if (fees.length === 0) return;
    const total = fees.reduce((n, f) => n + f, 0);
    b.out = (b.out ?? 0) + fees.length;
    b.loadIdle = 0;
    this.book('cargo', total);
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
    if (boxes) {
      if (c.outStack?.length) take = () => c.outStack!.shift()!;
    } else {
      const store = this.jibStores(c).find(
        (a) => (a.exports?.length ?? 0) - (a.outReserved ?? 0) > 0,
      );
      const pile = [...this.piles.values()].find(
        (q) => q.out && q.crates.length - (q.reserved ?? 0) > 0 && this.near(q.idx, c.idx),
      );
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
      const into = space ? this.intoSpace(m.entry, space, -1) : null;
      if (!space || !into) {
        c.nextBoatTick = this.tick + 60;
        this.tip('parking');
        if (!this.warnedParking) {
          this.warnedParking = true;
          this.message(
            `${c.terms.name}'s trucks need parking outside the port, by a public road, to do their paperwork.`,
            'bad',
          );
        }
        continue;
      }
      this.warnedParking = false;
      c.nextBoatTick = this.tick + Math.round((TICKS_PER_DAY * c.terms.capacity) / c.terms.perDay);
      this.trucks.push({
        id: this.nextId++,
        contractId: c.id,
        company: c.terms.name,
        capacity: c.terms.capacity,
        x: m.xOf(m.entry) + 0.5,
        y: m.yOf(m.entry) + 0.5,
        dir: 0,
        path: into.path,
        goal: into.path[into.path.length - 1],
        park: space.tiles[0],
        parkFrom: into.via,
        lot: space.tiles,
        state: 'toPark',
        bayIdx: -1,
        cargo: c.terms.capacity,
        value: c.terms.fee,
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
      const dock = this.freeDock(store);
      if (dock < 0) continue;
      const path = this.routeFrom(t, dock, this.truckCost(store.idx, -1, t));
      if (path) return { store, dock, path };
    }
    return null;
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
    return p.kind === 'stacker' ? !!this.yardWithRoom(best, tile) : !!this.bayWithRoom(best, tile);
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
      const n = Math.min(p.planned, crane.stack.length);
      p.cargoFrom = crane.kind === 'jib' ? undefined : (crane.stackFrom ?? []).splice(0, n);
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
        return out.splice(0, Math.min(p.planned, out.length));
      }
      pile.reserved = Math.max(0, (pile.reserved ?? 0) - p.planned);
      const fees = pile.crates.splice(0, Math.min(p.planned, pile.crates.length));
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

  /** Nearest container yard with room this stacker can reach from `from`. */
  private yardWithRoom(p: Dockhand, from: number): Bay | null {
    return this.nearestWithRoom(p, from, this.yards, true);
  }

  private nearestWithRoom(
    p: Dockhand,
    from: number,
    among: Map<number, Bay>,
    boxes: boolean,
    onward = false,
  ): Bay | null {
    const bays = [...among.values()]
      .filter(
        (b) => bayRoom(b, boxes) > 0 && this.takesImports(b) && (!onward || this.truckable(b)),
      )
      .sort((a, b) => this.distTo(from, a) - this.distTo(from, b));
    return bays.find((b) => this.dropAt(p, b, from) >= 0) ?? null;
  }

  /**
   * Storage by a crane, its machines-only ground: it loads and unloads, so
   * it takes cargo either way, but one way at a time.
   */
  private byCrane(b: Bay): boolean {
    return !!b.tiles && b.tiles.some((t) => nearCrane(this.map, t));
  }

  /**
   * Whether cargo coming in may go here: truck bays, storage for incoming,
   * or storage by a crane holding no exports.
   */
  private takesImports(b: Bay): boolean {
    if (!b.tiles) return true;
    if (this.byCrane(b)) return outHeld(b) + (b.outReserved ?? 0) === 0;
    return !b.outgoing;
  }

  /** Whether exports may go here: storage for outgoing, or by a crane holding no imports. */
  private takesExports(b: Bay): boolean {
    if (!b.tiles) return false;
    if (this.byCrane(b)) {
      const held = b.crates.length + b.boxes.length + b.incoming + b.boxIncoming;
      return held + (b.reserved ?? 0) === 0;
    }
    return !!b.outgoing;
  }

  /** Trucks can get to this bay or storage area to load. */
  private truckable(b: Bay): boolean {
    return this.roadTo(b) < Infinity;
  }

  /** Tiles of a storage area to collect from: where it meets the drivable port. */
  private collectAt(store: Bay): number[] {
    const m = this.map;
    const edge = store.tiles!.filter((t) =>
      m.neighbors4(t).some((n) => !m.store[n] && drivable(m.build[n])),
    );
    return (edge.length > 0 ? edge : store.tiles!).slice(0, 4);
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
    const near = [...b.tiles].sort((x, y) => this.dist(from, x) - this.dist(from, y)).slice(0, 4);
    return near.find((t) => this.pathFor(p, from, t)) ?? -1;
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

  /** Containers customs have cleared. */
  private cleared(b: Bay): number {
    return this.readyList(b).filter((r) => this.isClear(r)).length;
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
    return b.crates.length + (b.yard ? this.cleared(b) : b.boxes.length);
  }

  /**
   * Containers (or crates) at a bay or yard ready to go that no truck is
   * already coming for: room on the trucks heading there, parked for it or
   * loading at it is spoken for. Leaving `except` out of those.
   */
  private unclaimed(b: Bay, boxes: boolean, except?: Truck): number {
    const ready = boxes
      ? b.yard
        ? this.cleared(b) - (b.truckReserved ?? 0)
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
      (crane.outStack ??= []).push(...p.cargoFees);
    } else if (p.outbound && this.dest(p.bayIdx)?.tiles) {
      // Into storage by a jib crane, for it to lift on board.
      const store = this.dest(p.bayIdx)!;
      store.exportIncoming = Math.max(0, (store.exportIncoming ?? 0) - p.planned);
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
    const boxy = p.kind === 'stacker';
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
    this.message(`${p.name} had nowhere to take their load and put it down.`, 'bad');
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
      } else if (target.crane && this.headTo(p, this.pickTile(target.crane))) {
        target.crane.outReserved = (target.crane.outReserved ?? 0) + p.planned;
        p.toCrane = target.crane.idx;
        p.state = 'toDrop';
        return;
      }
    }
    // Back to wait in storage for the next ship.
    const boxy = p.kind === 'stacker';
    const store = [...(boxy ? this.yards : this.bays).values()]
      .filter((b) => this.takesExports(b) && bayRoom(b, boxy) >= p.carrying)
      .sort((a, b) => this.distTo(here, a) - this.distTo(here, b))[0];
    if (store) (store.exports ??= []).push(...p.cargoFees);
    else this.message(`${p.name} had nowhere to take the exports and put them down.`, 'bad');
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
    if (bay && !(p.outbound && bay.tiles)) bayIncoming(bay, p.kind === 'stacker', -p.planned);
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
    const boxes = c.kind !== 'jib';
    const store = boxes
      ? undefined
      : this.jibStores(c).find((a) => bayRoom(a, false) > 0 && this.takesImports(a));
    if (!store && c.stack.length >= craneStack(c)) return this.loadShip(c);
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
    c.busy = true;
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
    c.stack.push(boat.fee);
    if (c.kind !== 'jib') {
      (c.stackFrom ??= []).push(boat.id);
      if (boat.crates === 0) this.shipUnloaded(boat);
    }
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
    const out = loadingSpots(this.map, a.tiles!, this.truckReach()).slice(0, most);
    this.spotCache.set(a.idx, out);
    return out;
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
    return ends.length > 0 ? Math.min(...ends) : Infinity;
  }

  /** A dock at this bay no truck is using or heading for, or -1. */
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
    return truckCost(this.map, target, home, t?.lot && new Set(t.lot));
  }

  private parkingLots(): ParkingLot[] {
    this.lotsCache ??= parkingLots(this.map);
    return this.lotsCache;
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
        if (taken.has(space.tiles[0]) || reach[a] < 0 || reach[b] < 0) continue;
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
    const cost = truckCost(m, target, -1, new Set(space.tiles));
    let best: { path: number[]; via: number } | null = null;
    for (const [k, end] of space.ends.entries()) {
      const way = findPath(m.w, m.h, from, end, cost, false);
      if (!way || (best && way.length >= best.path.length - 1)) continue;
      const first = k === 0 ? space.tiles[0] : space.tiles[space.tiles.length - 1];
      best = { path: [...way, first], via: end };
    }
    return best;
  }

  /** Parked: stand across the middle of the space, at an angle, nose to the far side. */
  private parkUp(t: Truck): void {
    const m = this.map;
    const tiles = t.lot ?? [this.tileOf(t)];
    t.x = tiles.reduce((n, i) => n + m.xOf(i) + 0.5, 0) / tiles.length;
    t.y = tiles.reduce((n, i) => n + m.yOf(i) + 0.5, 0) / tiles.length;
    const from = t.parkFrom ?? this.tileOf(t);
    const ahead = Math.atan2(t.y - (m.yOf(from) + 0.5), t.x - (m.xOf(from) + 0.5));
    t.dir = ahead + Math.PI / 4;
  }

  /**
   * The way out from where a truck is to `goal`: from a parking space,
   * always forwards, on across it and out onto the road on the far side.
   */
  private routeFrom(t: Truck, goal: number, cost: CostFn): number[] | null {
    const m = this.map;
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
      }
    }
    if (from === goal) return prefix;
    const rest = findPath(m.w, m.h, from, goal, cost, false);
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
      // Container trucks collect containers; big trucks only fit a large bay.
      const free = (h: (typeof hauliers)[number]) => (out.get(h.id) ?? 0) < h.terms.fleet;
      const haulier =
        (this.unclaimed(bay, true) > 0
          ? hauliers.find((h) => free(h) && h.terms.cargo === 'container')
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
      const spot = served ? this.freeDock(bay) : -1;
      const wide = needsWideSpace(haulier.terms.capacity, boxy);
      const space = spot >= 0 ? null : this.freeParking(bay, false, wide);
      if (!served && !space) continue;
      const into = space ? this.intoSpace(m.entry, space, bay.idx) : null;
      const path = space
        ? (into?.path ?? null)
        : findPath(m.w, m.h, m.entry, spot, this.truckCost(bay.idx), false);
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
        x: m.xOf(m.entry) + 0.5,
        y: m.yOf(m.entry) + 0.5,
        dir: 0,
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
  private cutOff(bay: Bay): void {
    // Crate storage out of the trucks' way is a buffer the forklifts empty.
    if (!bay.noAccess && !bay.warehouse) {
      const what = bay.yard ? 'container yard' : bay.tiles ? 'crate storage area' : 'truck bay';
      this.message(
        bay.tiles
          ? `Trucks cannot reach a ${what}: they load storage from inside the port, from a port road or quay beside it through a port gate, not beside machines-only ground.`
          : `Trucks cannot reach a ${what}: it needs a public road to the highway, or port roads from a port gate.`,
        'bad',
      );
    }
    bay.noAccess = true;
    bay.nextTruckTick = this.tick + 100;
  }

  private updateTruck(t: Truck): void {
    const bay = this.dest(t.bayIdx);
    switch (t.state) {
      case 'toPark': {
        const r = this.move(
          t,
          this.truckCost(t.bayIdx, -1, t),
          false,
          () => B.TRUCK_SPEED,
          this.level,
        );
        if (r === 'blocked' || this.map.build[t.park ?? -1] !== Build.Parking) {
          return this.removeTruck(t);
        }
        if (r === 'arrived') {
          t.state = 'parked';
          t.idle = 0;
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
          if (!to) return;
          // Containers wait parked until the yard's gantry or a stacker is free.
          if (t.boxes && !this.handlerFree(to.store, t)) return;
          to.store.exportIncoming = (to.store.exportIncoming ?? 0) + t.cargo;
          t.bayIdx = to.store.idx;
          t.park = undefined;
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
        if (t.boxes && !this.handlerFree(bay, t)) return;
        const dock = this.freeDock(bay);
        if (dock < 0) return;
        const path = this.routeFrom(t, dock, this.truckCost(bay.idx, -1, t));
        if (!path) return;
        t.park = undefined;
        t.path = path;
        t.goal = dock;
        t.state = 'toBay';
        return;
      }
      case 'toBay': {
        if (!bay) return t.exports ? this.headOut(t) : this.truckLeave(t);
        const r = this.move(
          t,
          this.truckCost(t.bayIdx, -1, t),
          false,
          () => B.TRUCK_SPEED,
          this.level,
        );
        if (r === 'blocked') {
          if (t.exports) bay.exportIncoming = Math.max(0, (bay.exportIncoming ?? 0) - t.cargo);
          return this.removeTruck(t);
        }
        if (r === 'arrived') t.state = t.exports ? 'delivering' : 'loading';
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
        if (++t.timer % loadTicks(bay) !== 0) return;
        (bay.exports ??= []).push(t.value);
        bay.exportIncoming = Math.max(0, (bay.exportIncoming ?? 0) - 1);
        if (--t.cargo <= 0) {
          this.tip('exports');
          this.headOut(t);
        }
        return;
      }
      case 'loading': {
        if (!bay) return this.truckLeave(t);
        const every = loadTicks(bay);
        if (++t.timer % every !== 0) return;
        // Containers at a yard with no gantry go on by reach stacker: it
        // waits while one is on its way.
        // With nothing more here for it, it goes with what it has rather
        // than wait for more.
        const done = (t.coming ?? 0) === 0 && this.unclaimed(bay, t.boxes, t) <= 0;
        if (this.byStacker(t, bay)) {
          if ((t.coming ?? 0) > 0) t.idle = 0;
          else t.idle += every;
          const full = t.cargo >= t.capacity;
          const bored = t.cargo > 0 ? t.idle >= B.TRUCK_PATIENCE : t.idle >= B.TRUCK_GIVE_UP;
          if (full || bored || done) this.truckLeave(t);
          return;
        }
        const stock = t.boxes ? bay.boxes : bay.crates;
        // Containers only once customs have cleared them, whichever those are.
        const at = t.boxes && bay.yard ? this.readyList(bay).findIndex((r) => this.isClear(r)) : 0;
        if (stock.length > 0 && at >= 0 && t.cargo < t.capacity) {
          if (t.boxes && bay.yard) this.readyList(bay).splice(at, 1);
          t.value += stock.splice(at, 1)[0];
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
        const r = this.move(
          t,
          this.truckCost(t.goal, t.bayIdx),
          false,
          () => B.TRUCK_SPEED,
          this.level,
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
          this.book('cargo', bonus);
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
        const cost = this.truckCost(this.map.entry, t.bayIdx, t);
        const r = this.move(t, cost, false, () => B.TRUCK_SPEED, this.level);
        if (r === 'arrived' || r === 'blocked') this.removeTruck(t);
        return;
      }
    }
  }

  /** Trucks stop at a level crossing while the barriers are down. */
  private level = (i: number): boolean =>
    this.map.build[i] !== Build.Crossing || !crossingClosed(this.rail.train, this.map.yOf(i));

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
      this.book('cargo', income);
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
        ? findPath(m.w, m.h, here, m.entry, this.truckCost(m.entry, t.bayIdx), false)
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
      const direct = findPath(m.w, m.h, here, front, cost, false);
      if (direct && (!best || direct.length < best.len)) {
        best = { path: direct, len: direct.length };
        drop = i;
      }
      const inn = out && findPath(m.w, m.h, town.gate, front, cost, false);
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

  /** Off to the highway and away: from town, by the town's own road. */
  private headOut(t: Truck): void {
    const m = this.map;
    const here = this.tileOf(t);
    const gate = this.town?.gate ?? -1;
    const exits = gate >= 0 && m.yOf(here) > m.limit ? [gate, m.entry] : [m.entry];
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

  /** Have the advisor explain something, the first time it comes up in a game. */
  private tip(id: string): void {
    if (this.tipsSeen.has(id)) return;
    this.tipsSeen.add(id);
    this.events.push({ kind: 'tip', id });
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
    if (b.state !== 'moored' || b.crates === 0) return undefined;
    if (b.vessel === 'feeder') {
      const cranes = [...this.cranes.values()].filter((c) => c.kind !== 'jib');
      if (cranes.length > 0 && cranes.every((c) => c.stack.length >= craneStack(c))) {
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
    if (jib && jib.stack.length >= B.CRANE_STACK && this.jibStores(jib).length === 0) {
      return "The crane's landing stack is full: a forklift must take it away. Crate storage within reach would take crates straight in.";
    }
    if (b.vessel === 'coaster' && !this.forklifts() && !(jib && this.jibStores(jib).length > 0)) {
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

  private truckWhy(t: Truck): string | undefined {
    if (t.exports && t.state === 'parked' && this.tick >= (t.papers ?? Infinity)) {
      return `No container yard or crate storage with room for its load, and a free spot beside it to unload.`;
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
    return undefined;
  }

  private craneWhy(c: Crane): string {
    const full = c.stack.length >= craneStack(c);
    if (c.kind === 'jib') {
      const stores = this.jibStores(c);
      if (c.busy) {
        return stores.some((a) => bayRoom(a, false) > 0)
          ? 'Swinging crates straight into crate storage.'
          : 'Lifting crates onto its landing stack.';
      }
      if (full) {
        return 'Landing stack full: waiting for a forklift to take it away. Dockhands keep off the ground round a crane.';
      }
      if (c.stack.length > 0) return 'Waiting for a forklift to collect its landing stack.';
      return 'No boat lying under it.';
    }
    if (c.busy) return 'Lifting containers off the ship.';
    if (full) {
      return c.kind === 'gantry'
        ? 'The bay between its legs is full: waiting for reach stackers.'
        : 'Stack full: waiting for reach stackers.';
    }
    return c.stack.length > 0
      ? 'Waiting for reach stackers to take the containers to a yard.'
      : 'No container ship alongside.';
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
        activity:
          p.blocked > 3
            ? 'Waiting for someone to get out of the way'
            : activity(p, this.piles.has(p.bayIdx)),
        variant: 0,
        capacity: p.capacity,
        alert: p.state === 'broken' || (p.state === 'idle' && !!p.stuck),
        why: this.workerWhy(p),
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
        load: b.crates + (b.out ?? 0),
        moving: b.path.length > 0,
        name: b.company,
        activity:
          (b.state === 'approaching'
            ? 'Sailing in from sea'
            : b.state === 'anchored'
              ? 'Waiting at anchor for a berth'
              : b.state === 'arriving'
                ? 'Sailing to the jetty'
                : b.state === 'moored' && b.crates === 0 && outCap(b) > 0
                  ? `Taking exports on board, ${b.out ?? 0} of ${outCap(b)}`
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
        alert: b.state === 'anchored',
        why: this.boatWhy(b),
        vessel: b.vessel,
        boxes: b.vessel === 'feeder',
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
          t.exports && (t.state === 'toPark' || t.state === 'parked')
            ? this.tick < (t.papers ?? Infinity) || t.state === 'toPark'
              ? `Bringing ${t.cargo} ${t.boxes ? 'containers' : 'crates'} to ship: paperwork first, parked outside the port`
              : `Paperwork done, waiting for storage with room for its ${t.boxes ? 'containers' : 'crates'}`
            : t.exports && t.state === 'toBay'
              ? `Bringing ${t.cargo} ${t.boxes ? 'containers' : 'crates'} to storage, to ship`
              : t.state === 'delivering'
                ? `Unloading ${t.cargo} ${t.boxes ? 'containers' : 'crates'} to ship`
                : t.state === 'toPark'
                  ? 'Driving to the parking'
                  : t.state === 'parked'
                    ? 'Parked, waiting for a loading spot'
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
      stock: b.crates.length,
      boxes: b.boxes.length,
      capacity: bayCap(b),
      large: b.large,
      warehouse: !!b.warehouse,
      exports: b.exports?.length ?? 0,
      outgoing: !!b.outgoing,
      byCrane: this.byCrane(b),
      tiles: b.tiles && [...b.tiles],
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
      daysInRed: this.daysInRed,
      bankrupt: this.bankrupt,
      stats: { ...this.stats },
      entities,
      bays,
      yards: [...this.yards.values()].map((y) => ({
        idx: y.idx,
        boxes: y.boxes.length,
        exports: y.exports?.length ?? 0,
        outgoing: !!y.outgoing,
        byCrane: this.byCrane(y),
        gantry: this.yardGantry(y),
        cleared: this.cleared(y),
        nextClear: this.nextClear(y),
        pending: this.pending(y),
        capacity: bayCap(y),
        tiles: [...(y.tiles ?? [y.idx])],
        noAccess: y.noAccess,
      })),
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
        crates: p.crates.length,
        pallets: !!p.pallets,
        out: !!p.out,
      })),
      contracts,
      capacity: this.capacity(),
      stock: this.waitingCargo(),
      docks: {
        total: this.docks().length,
        coordinated: this.docks().filter((g) => g.coordinated).length,
        offices: this.map.build.filter((b) => b === Build.Office).length,
        inUse: this.docks().flatMap((g) => (g.coordinated ? g.tiles : [])),
        idle: this.docks().flatMap((g) => (g.coordinated ? [] : g.tiles)),
      },
      depots: this.depotViews(),
      progress: { tier: this.tier, ...this.tierProgress(), canUpgrade: this.canUpgrade() },
      cranes: [...this.cranes.values()].map((c) => ({
        idx: c.idx,
        kind: c.kind,
        stack: c.stack.length,
        out: c.outStack?.length ?? 0,
        max: craneStack(c),
        angle: c.angle,
        busy: c.busy,
        stores: c.kind === 'jib' ? this.jibStores(c).length : 0,
        why: this.craneWhy(c),
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
