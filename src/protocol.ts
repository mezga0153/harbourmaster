// Messages between the main thread and the sim worker. See plan.md §11, Threads.

import type { Cargo } from './sim/cargo';
import type { Terms } from './sim/contracts';
import type { MapData } from './sim/map';
import type { Train } from './sim/railway';
import type { SaveData } from './sim/world';
import type { Candidate, Trait } from './sim/staff';
import type { BuildKind, MachineKind, StoreKind } from './sim/types';

export type Command =
  | { type: 'build'; kind: BuildKind; tiles: number[]; facing?: number }
  | { type: 'bulldoze'; tiles: number[] }
  /** Mark port road and quay tiles for port machines only, or clear the mark. */
  | { type: 'forkliftOnly'; tiles: number[]; on: boolean }
  /** Clear storage and machines-only marks, wherever they can be. */
  | { type: 'unmark'; tiles: number[] }
  /** Mark port road and quay tiles out as storage, or clear them. */
  | { type: 'store'; tiles: number[]; kind: StoreKind; on: boolean }
  /** Stop a storage area (by its first tile) taking any more cargo, so it empties out, or open it again. */
  | { type: 'shutStore'; idx: number; shut: boolean }
  /** A ship taking exports on board sails now with those it has. */
  | { type: 'sailNow'; id: number }
  /** Open an exit off the highway at row `row`, with a road off it. */
  | { type: 'exit'; row: number }
  /** Make road tiles one way, the way the drag ran along them; or (`on` false) two way again. */
  | { type: 'oneWay'; tiles: number[]; on: boolean }
  /** Put up traffic lights at a junction, or take them down. */
  | { type: 'lights'; tile: number }
  /** Let trucks through a port gate both ways, only in, or only out. */
  | { type: 'gateWay'; tile: number; way: 'both' | 'in' | 'out' }
  /** A roundabout: a ring of one-way road round an island at `tile`. */
  | { type: 'roundabout'; tile: number }
  /** Dredge (dig the seabed deeper, or the shore out into sea) or reclaim (fill it in). */
  | { type: 'terraform'; tiles: number[]; raise: boolean }
  | { type: 'hire'; candidateId: number }
  | { type: 'fire'; id: number }
  | { type: 'loan'; amount: number }
  | { type: 'upgrade' }
  | { type: 'buyMachine'; kind: MachineKind; tile?: number }
  /** A harbour tug, at the tug berth at `tile` or any free one. */
  | { type: 'buyTug'; tile?: number }
  | { type: 'raise'; id: number; accept: boolean }
  | { type: 'signContract'; id: number }
  | { type: 'cancelContract'; id: number }
  | { type: 'setSpeed'; speed: number }
  /** The player has found out for themselves what this advisor tip would teach them. */
  | { type: 'learnt'; tip: string }
  | { type: 'newGame'; seed?: number }
  | { type: 'save' }
  /** The game as a save, for the player to keep in a file; answered with `exported`. */
  | { type: 'exportSave' }
  /** Carry on from a save the player picked from a file, if it is one this version can read. */
  | { type: 'importSave'; save: unknown; name: string }
  /** Dev server only: jump ahead for testing. */
  | {
      type: 'debug';
      cash?: number;
      tier?: number;
      coaster?: boolean;
      containers?: boolean;
      /** People wanting to live in town. */
      town?: number;
      /** Send the next train now. */
      train?: boolean;
    }
  /** Dev server only: post the whole game state back, for the debug bridge. */
  | { type: 'dumpSave' }
  /** Dev server only: carry on from this game instead, from the debug bridge. */
  | { type: 'loadSave'; save: SaveData };

export type EntityKind = 'dockhand' | 'forklift' | 'stacker' | 'tractor' | 'boat' | 'truck';

export interface EntityView {
  id: number;
  kind: EntityKind;
  /** Tile-space position; tile (x, y) has its centre at (x + 0.5, y + 0.5). */
  x: number;
  y: number;
  /** Heading in radians, atan2(dy, dx) in tile space. */
  dir: number;
  /** Crates carried. */
  load: number;
  moving: boolean;
  /**
   * Workers picking a load up or setting one down: how far through, 0 to 1.
   * The load leaves where it was, or shows where it goes, as it ends.
   */
  handling?: number;
  /** Crates: what each holds, in the order they are loaded, as far as it is known. */
  cargo?: Cargo[];
  /** Fishing boats: what they bring in, which is the kind of boat they are. */
  catch?: Cargo;
  /** Dockhands on a break: sat on the bench outside the break hut. */
  sitting?: boolean;
  name: string;
  activity: string;
  /** Per-entity paint colour index (trucks, boats). */
  variant: number;
  /** Most crates it can hold. */
  capacity: number;
  /** Needs attention, e.g. a broken-down machine. */
  alert: boolean;
  /** Boats: 'smack', 'coaster' or 'feeder'. */
  vessel?: string;
  /** Carries containers rather than crates. */
  boxes?: boolean;
  /** Containers carried: how each looks, in load order. */
  looks?: number[];
  /** A feeder's deck: the slot each container in `looks` is in; without it, the first `load`. */
  deck?: number[];
  /** Boats under way: where it plots it will be over the next while, as x, y pairs. */
  plot?: number[];
  /** Boats: the boat it is giving way to. */
  givingWayTo?: number;
  /** Why it is held up, when it is, and what would help. */
  why?: string;
  /** Ships: how their visit is going. */
  visit?: BoatVisit;
  /**
   * Reach stackers and terminal tractors at work: taking a container off
   * where it is ('pick') or setting one down ('drop'), how far through
   * that they are (0 to 1) and how many ticks it takes in all. The
   * container changes hands at the end. `handAt`: where, if known.
   */
  handStage?: 'pick' | 'drop';
  handPhase?: number;
  handTicks?: number;
  handAt?: HandAt;
}

/**
 * Where a machine takes a container from or sets one down: a crane's stack
 * (by the crane), a yard (by its first tile) or a truck's container slot;
 * the container by how it looks, or with no look the next free place.
 * `along`: at a yard gantry, which way the lane under it runs, as a heading.
 */
/** A ship's visit so far, for its panel; times in ticks, -1 for not known or not begun. */
export interface BoatVisit {
  /** Since it came in from sea. */
  inPort: number;
  /** Waiting at anchor for a berth. */
  anchored: number;
  /** Unloading: how long it has been at it, or took. */
  unloading: number;
  unloaded: boolean;
  /** Taking exports on board, likewise; `loads` false if it takes none. */
  loading: number;
  loaded: boolean;
  loads: boolean;
  /** Exports on board, and how many it takes this visit once that is known. */
  out: number;
  quota?: number;
  /** Time alongside the line allows this visit, and how much has counted against it. */
  allowed: number;
  worked: number;
  /** The line's goodwill, 0 to 100, and how this visit would move it if the ship sailed now. */
  mood?: number;
  moodChange: number;
  /** It is taking exports on board, and can be sent off with those it has. */
  canSail: boolean;
  /** Coming in, held up by a ship moored in its way: which, and for how long so far. */
  heldBy?: string;
  heldFor?: number;
}

export interface HandAt {
  crane?: number;
  yard?: number;
  truck?: number;
  slot?: number;
  look?: number;
  along?: number;
  /** In a yard: the place it is stacked in, or goes; see YardView.slots. */
  place?: number;
  /**
   * Crate storage (by its first tile): `place` is then which pallet's
   * place, see storage, or `slot` which crate's.
   */
  store?: number;
  /** Crates landed on the quay at this tile, or at a truck bay: `slot` is which. */
  pile?: number;
  bay?: number;
}

export interface CraneView {
  idx: number;
  kind: 'jib' | 'harbour' | 'gantry';
  stack: number;
  /** Container cranes: exports set down for it to lift on board. */
  out: number;
  /** Container cranes: how each container on the stack looks, then the exports. */
  looks?: number[];
  /** Gantry cranes: the place on the stack each of those is in: four stacks, four high. */
  places?: number[];
  /** Most it sets down before waiting for them to be taken away. */
  max: number;
  angle: number;
  busy: boolean;
  /** Jib cranes: crate storage areas in reach. */
  stores: number;
  /** What it is doing, or why it is not. */
  why: string;
  /** Why no ship can ever come alongside it, if none can. */
  trouble?: string;
  /**
   * Container cranes at work: lifting a container off a ship's deck or an
   * export onto it, the ship, the deck slot, how the container looks, and
   * how far through the lift it is (0 to 1).
   */
  working?: 'load' | 'unload' | 'give' | 'take';
  /** A gantry crane lifting a container onto a terminal tractor ('give') or off one ('take'). */
  workTruck?: number;
  workBoat?: number;
  workSlot?: number;
  workLook?: number;
  workPhase?: number;
  /**
   * Jib cranes at work: the crate storage (by its first tile) or the pile on
   * the quay (by its tile) the crate goes into or comes from, else its
   * landing stack; the crate's place there; and whether it is on a pallet.
   */
  workStore?: number;
  workPile?: number;
  workPlace?: number;
  workPallet?: boolean;
  /** Jib cranes: the crates on the landing stack are on pallets. */
  pallets?: boolean;
}

export interface TierProgress {
  tier: number;
  /** People in the town now, which the next step up needs enough of; see Tier.town. */
  town: number;
  canUpgrade: boolean;
}

export type LedgerCategory =
  /** Crates trucked out (and, in older saves, all cargo income). */
  | 'cargo'
  | 'containers'
  | 'exports'
  | 'town'
  | 'construction'
  | 'hiring'
  | 'wages'
  | 'hauliers'
  | 'contracts'
  | 'penalties'
  | 'maintenance'
  | 'interest';

/** Money in (positive) and out (negative) for one day, by category. */
export type Ledger = Record<LedgerCategory, number>;

/** One day gone by, for the finance charts: what came in and went out, and the cash left. */
export interface FinanceDay {
  /** The tick the day ended on. */
  tick: number;
  cash: number;
  ledger: Ledger;
}

export interface StaffView {
  id: number;
  kind: 'dockhand' | MachineKind;
  broken: boolean;
  /** Forklifts: 0 to 100. */
  fuel: number;
  /** Forklifts: depot tile, or -1. */
  home: number;
  name: string;
  skill: number;
  trait: Trait | null;
  wage: number;
  energy: number;
  morale: number;
  activity: string;
  thought: string;
  /** Wage this dockhand is asking for, or 0. */
  raiseAsk: number;
}

export interface ContractView {
  id: number;
  terms: Terms;
  satisfaction: number;
  /** What it costs you to end this contract. */
  cancelFee: number;
  /** What the company claims if it walks out. */
  breach: number;
  /** Boats of this company waiting at anchor right now. */
  waiting: number;
  /** Ticks until the next boat sets out, or -1 for hauliers. */
  nextIn: number;
  /** Hauliers: ticks until the next truck away is back, or -1. */
  backIn: number;
  /** Boats or trucks of this company currently at the port. */
  active: number;
  /** Hauliers: trucks away on their round, not back yet. */
  away: number;
}

export interface OfferView {
  id: number;
  terms: Terms;
  signingFee: number;
  expiresIn: number;
  breach: number;
  /** Trucking capacity (crates/day) if this offer were signed. */
  truckingAfter: number;
}

/** Crates per day: what the fisheries send versus what the port can move. */
export interface Capacity {
  demand: number;
  /** Crates a day lifted off the boats (dockhands, jib cranes) and moved on from the quay (forklifts, or dockhands carrying); unloading is the lesser. */
  off: number;
  moved: number;
  unloading: number;
  trucking: number;
  /** Berths deep enough for a coaster. */
  deepBerths: number;
  /** Coasters' crates come on pallets, which only forklifts take on from the quay. */
  pallets: { demand: number; unloading: number };
  /** Share of worker travel time lost waiting for each other yesterday. */
  congestion: number;
  /** Containers per day, once the port handles them. */
  boxes: { demand: number; lifting: number; moving: number; trucking: number; berths: number };
}

export interface BayView {
  idx: number;
  stock: number;
  /** Containers waiting. */
  boxes: number;
  capacity: number;
  large: boolean;
  /** A crate storage area, and the tiles marked out for it. */
  warehouse: boolean;
  /** Crates waiting here to go out on a ship. */
  exports: number;
  /**
   * Crate storage: the place each pallet is in, four to a tile, tile by
   * tile, holding the next four of its crates then its exports.
   */
  places?: number[];
  /** Storage for cargo going out; by a crane, either way, one at a time. */
  outgoing: boolean;
  /** Storage taking no more cargo, emptying out. */
  shut: boolean;
  byCrane: boolean;
  tiles?: number[];
  noAccess: boolean;
  /** Why trucks cannot reach it, when they cannot. */
  noAccessWhy?: string;
  /** What each crate holds: those in it, then its exports. */
  cargo?: Cargo[];
}

export interface YardView {
  idx: number;
  boxes: number;
  /** How each container looks, then each export. */
  looks: number[];
  /** The slot each is stacked in: a tile's two stacks, three high, tile by tile. */
  slots?: number[];
  /** Its gantry at work: the slot in the yard the container it moves is in, or is going to. */
  workYard?: number;
  /** Cleared by customs, so the trucks may take them. */
  cleared: number;
  /** Containers waiting here to go out on a ship. */
  exports: number;
  outgoing: boolean;
  /** Taking no more containers, emptying out. */
  shut: boolean;
  byCrane: boolean;
  /** A yard gantry beside it loads the trucks; else the reach stackers do. */
  gantry: boolean;
  /**
   * Its gantry at work: lifting containers onto a truck, or a shipper's
   * off one; and how the one it is moving looks.
   */
  working?: 'load' | 'unload';
  workLook?: number;
  /** How far along its rails the truck it is working stands, from the gantry. */
  workAt?: number;
  /**
   * The truck it is working, which of its container slots it lifts from or
   * sets down in, and how far through the lift it is, 0 to 1.
   */
  workTruck?: number;
  workSlot?: number;
  workPhase?: number;
  /**
   * Its lift's legs, as shares of it: running along its rails to the
   * container, taking it up, carrying it along, setting it down; and how
   * many ticks the lift takes in all. See liftMarks.
   */
  workLegs?: number[];
  workTicks?: number;
  /** The tick its lift began: a new lift has a new one. */
  workStart?: number;
  /** One container the gantry has taken up (-1) or set down (+1) that the counts do not have yet. */
  lifted: number;
  /** Cleared containers lying under ones still in customs, which the trucks cannot get at. */
  buried: number;
  /** Ticks until the next container clears, or -1. */
  nextClear: number;
  /** Containers whose ship is still being unloaded: customs start once it is. */
  pending: number;
  capacity: number;
  tiles: number[];
  noAccess: boolean;
  /** Why trucks cannot reach it, when they cannot. */
  noAccessWhy?: string;
}

export interface ParkingView {
  tiles: number[];
  outside: boolean;
  wide: boolean;
  spaces: number;
  used: number;
  why: string | null;
}

export interface PileView {
  idx: number;
  crates: number;
  pallets: boolean;
  /** Exports left by a ship, to go on board. */
  out: boolean;
  /** What each crate holds. */
  cargo?: Cargo[];
}

export interface Stats {
  cratesHandled: number;
  containers: number;
  boats: number;
  trucks: number;
  earned: number;
  /** Crates and containers shipped out; older saves have none. */
  exported?: number;
  /** Demurrage, breach penalties and contract buyouts paid. */
  penalties: number;
}

/** Where crates or containers coming in are in the port right now. */
export interface CargoIn {
  /** On ships at anchor or coming in. */
  atSea: number;
  /** On ships alongside, still to be lifted off. */
  onShips: number;
  /** Set down on the quay or a crane's stack, or in storage no truck can reach. */
  landed: number;
  /** Being carried by dockhands, forklifts, reach stackers or tractors. */
  carried: number;
  /** In a container yard, waiting for customs to clear them. */
  customs: number;
  /** In storage, ready for a truck to take out. */
  ready: number;
  /** On trucks loading or on their way out. */
  onTrucks: number;
}

/** Where crates or containers going out are in the port right now. */
export interface CargoOut {
  /** On shippers' trucks in the parking outside the port. */
  waiting: number;
  /** On shippers' trucks driving in or unloading. */
  comingIn: number;
  /** In outgoing storage. */
  stored: number;
  /** Being carried towards the ships. */
  carried: number;
  /** Set down at a crane for the ship it loads. */
  atCrane: number;
  /** On board ships still alongside. */
  aboard: number;
}

export interface CargoStats {
  crates: CargoIn;
  containers: CargoIn;
  crateExports: CargoOut;
  containerExports: CargoOut;
}

/** The cargo counts at one moment, for the statistics charts. */
export interface CargoSample {
  tick: number;
  cargo: CargoStats;
}

export interface TownView {
  name: string;
  /** Index into TOWN_STAGES. */
  stage: number;
  population: number;
  homes: number;
  /** People the port's jobs and trade would support. */
  target: number;
  jobs: number;
  /** Crates' worth of goods sent out by road a day, lately. */
  goods: number;
  /** Crates' worth delivered to the town's businesses a day, lately. */
  supplied: number;
  /** What the businesses will still take today. */
  wants: { crates: number; boxes: number };
  businesses: { label: string; count: number; boxes: boolean; perDay: number }[];
  /** The chapel square the town grows out from. */
  x: number;
  y: number;
}

/**
 * Something on the map that cannot work as it is: a red mark over it, and
 * what is wrong, shown when it is picked.
 */
export interface ProblemView {
  /** Where the mark stands, in tiles, and how high: over the top of what is wrong. */
  x: number;
  y: number;
  h: number;
  text: string;
  /** What picking it selects. */
  type: 'crane' | 'bay' | 'yard' | 'parking' | 'yardGantry';
  idx: number;
}

export interface Snapshot {
  tick: number;
  cash: number;
  speed: number;
  seed: number;
  staff: number;
  wages: number;
  people: StaffView[];
  candidates: Candidate[];
  /** Daily haulier fees. */
  contractFees: number;
  loan: number;
  /** Interest charged on the loan at the end of today. */
  interest: number;
  today: Ledger;
  yesterday: Ledger | null;
  /** The last days gone by, oldest first; see FinanceDay. */
  history: FinanceDay[];
  /** Consecutive days ended in the red; bankrupt at BANKRUPT_DAYS. */
  daysInRed: number;
  bankrupt: boolean;
  stats: Stats;
  /** Every crate and container in the port, by where it is. */
  cargo: CargoStats;
  /** The same, every so often over the last days, oldest first. */
  cargoLog: CargoSample[];
  entities: EntityView[];
  bays: BayView[];
  /** Container yards, how many containers each holds, and whether trucks can reach it. */
  yards: YardView[];
  /** Truck parking, and why each lot is no use, if it is not. */
  parking: ParkingView[];
  /** Cargo dockhands have landed on the quay beside boats, for the forklifts. */
  piles: PileView[];
  contracts: ContractView[];
  offers: OfferView[];
  capacity: Capacity;
  /** Cargo waiting along the way from boat to truck, right now. */
  stock: {
    /** Crates on the quay and on jib cranes' landing stacks. */
    landed: number;
    /** Crates in truck bays and crate storage. */
    stored: number;
    /** Exports waiting in the port for a ship. */
    crateExports: number;
    boxExports: number;
    /** Containers set down by the cranes, for the stackers. */
    boxLanded: number;
    boxCustoms: number;
    boxCleared: number;
  };
  progress: TierProgress;
  cranes: CraneView[];
  /** Things that cannot work as they are, for red marks on the map. */
  problems: ProblemView[];
  depots: { idx: number; forklifts: number }[];
  /** Jetty and quay structures, and how many the harbour office coordinates. */
  docks: {
    total: number;
    coordinated: number;
    offices: number;
    /** Harbourmaster's huts, each looking after a few jetties. */
    huts: number;
    /** Tiles of the docks boats use, and of those they do not, for want of an office. */
    inUse: number[];
    idle: number[];
  };
  town: TownView | null;
  /** The train passing along the main line, if one is. */
  train: Train | null;
}

export type SimEvent =
  | { kind: 'message'; text: string; tone: 'info' | 'good' | 'bad' }
  | { kind: 'money'; amount: number; x: number; y: number }
  /** Something the advisor explains, the first time it matters. */
  | { kind: 'tip'; id: string };

export interface TileChange {
  i: number;
  terrain: number;
  depth: number;
  ocean: number;
  build: number;
  orient: number;
  deco: number;
  store: number;
}

export type WorkerMessage =
  | { type: 'init'; map: MapData; seed: number }
  | { type: 'frame'; snapshot: Snapshot; tiles: TileChange[]; events: SimEvent[] }
  /** Dev server only: the game as a save, for the debug bridge. */
  | { type: 'dump'; save: SaveData }
  /** The game as a save, to keep in a file; see exportSave. */
  | { type: 'exported'; save: SaveData };
