// The things in the game as the simulation keeps them and the saves hold
// them: workers, cranes, boats, tugs, trucks, storage, the day's ledger.
// The rules that move them are in world.ts; what the view sees of them is
// in protocol/views.ts.

import type * as B from './balance';
import type { Contract, Offer } from './contracts';
import type { MapData } from './map';
import type { RailState } from './railway';
import type { Candidate, Trait } from './staff';
import type { Town } from './town';
import type { MachineKind } from './types';

export interface Agent {
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

export type DockhandState =
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

/** A worker that moves crates: a dockhand on foot or a forklift. */
export interface Dockhand extends Agent {
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
  /**
   * The slot at crate storage or a truck bay (`dropIn`) kept for the load
   * it is setting down, its first crate's; see claimDrop.
   */
  dropAt?: number;
  dropIn?: number;
  /** Why it is waiting where it is to set its load down, if it is. */
  waitingWhy?: string;
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
  /** Crates carried out of storage, so cleared already: no customs again where they go. */
  cleared?: boolean;
  /** Reach stackers and tractors: what it is keeping its distance behind, if anything; see roomAhead. */
  blocker?: number;
  /** The tile of crane stack on its way it last looked for a way round; see walk. */
  replanned?: number;
  /** The tile it last drove in from, which it may not turn back to where it cannot turn about. */
  came?: number;
  /** The ring it is driving on through, and where it set off from; see passRing. */
  passing?: { ids: number[]; x: number; y: number };
}

export interface Crane {
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
export interface JibJob {
  boat: Boat;
  load: boolean;
  store?: Bay;
  pile?: Bay;
}

/** A jib crane's lift for the view: which slot on the boat, which place at the other end. */
export interface JibLift extends JibJob {
  slot: number;
  place: number;
  phase: number;
  /** The crate is on a pallet, as a coaster's are. */
  pallet: boolean;
}

export type Vessel = keyof typeof B.VESSELS;

/** A berth, the dock tile it lies against, and the vessel lying there. */
export interface Moorage {
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

export interface Boat extends Agent {
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
  /**
   * The dockhands found nowhere to carry its crates into, last they looked:
   * no truck bay or crate storage for cargo coming in with room they can
   * walk to (`room`), or for timber and goods no crate storage (`customs`).
   * It waits meanwhile, as they set nothing down on the quay.
   */
  noRoom?: 'room' | 'customs';
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
  /**
   * Casting off, where it comes round for the sea: 0 right here off the
   * dock, more than that the tiles it still has to back out straight to
   * open water with room to; -1 if it found nowhere, and swings round
   * backing as it can. Worked out once it is off the dock (roomToComeRound).
   */
  backOut?: number;
  /**
   * Which way it comes round for the sea once off the dock, -1 or 1, as
   * planned with backOut: it keeps swinging that way until it heads on its
   * way, rather than dither between the two in the narrows.
   */
  comeRound?: number;
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

export interface Truck extends Agent {
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
  /**
   * The businesses in town it goes on to after this one, nearest first as
   * it goes, each with how many of its crates it drops there: those it
   * has that each takes and still wants today, kept for it as it set off.
   */
  stops?: { code: number; count: number }[];
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

export interface Bay {
  idx: number;
  /** Its designation, on its sign or painted on the ground: B3, C2; see designations.ts. */
  name?: string;
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
  /**
   * When customs clear each crate of timber or goods here still waiting on
   * them, soonest first: they are the newest of those crates, as the oldest
   * clear first. Older saves have none: all clear.
   */
  customs?: number[];
  /**
   * Outgoing crate storage: when the export papers are done for each crate
   * of canned fish still waiting on them, soonest first, the newest of them
   * as with customs.
   */
  papers?: number[];
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
   * Crate storage, before each crate kept a slot of its own: the place each
   * pallet was in, holding the next four of its crates then its exports.
   */
  places?: number[];
  /**
   * Crate storage and truck bays: the slot each crate, and each export,
   * was set down in, which it keeps until it is taken; see crateSlots.
   */
  crateSlots?: number[];
  outSlots?: number[];
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
  /** Each parking lot's designation, by its first tile. Older saves have none. */
  lotNames?: [number, string][];
}

export interface GantryHeld {
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
export type GantryWork = {
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
export interface GantryLift {
  start: number;
  legs: [number, number, number, number];
  to: number;
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
