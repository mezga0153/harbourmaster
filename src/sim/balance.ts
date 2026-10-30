// Tuning values. See plan.md §14.

import { TICKS_PER_DAY } from './types';

export const START_CASH = 5000;
export const START_YEAR = 1962;

export const START_DOCKHANDS = 2;
export const HIRE_FEE = 100;
export const WAGE_DOCKHAND = 40; // per day, for the starting crew
export const WAGE_BASE = 30;
export const WAGE_PER_SKILL = 6;
export const CANDIDATES = 3;

// Needs. Energy and morale run from 0 to 100.
export const START_MORALE = 75;
export const TIRED_ENERGY = 30; // goes on a break below this
export const WORK_DRAIN = 0.18; // energy per tick while working
export const IDLE_DRAIN = 0.02;
export const HUT_REST = 1.2; // energy per tick resting in a break hut
export const FLOOR_REST = 0.4; // resting with nowhere to sit
export const HUT_SLOTS = 3;
export const MORALE_HUT_BREAK = 2;
export const MORALE_FLOOR_BREAK = -4;
export const MORALE_EXHAUSTED = -3; // ran completely out of energy
export const QUIT_MORALE = 15;
export const RAISE_CHANCE = 0.08; // per dockhand per day, when not delighted
export const RAISE_MORALE_BELOW = 65;
export const RAISE_STEP = 10; // per day
export const RAISE_ACCEPT_MORALE = 20;
export const RAISE_REFUSE_MORALE = -20;
export const QUIT_DAYS = 2; // days in a row below QUIT_MORALE before quitting

export const CRATE_FEE = 20; // paid when a truck leaves with the crate
export const TRUCK_CAPACITY = 6;
export const BIG_TRUCK_CAPACITY = 8;
export const STARTER_HAULIER_FEE = 20; // per day
export const TRUCK_PATIENCE = 120; // ticks a part-loaded truck waits for more crates
/** Ticks a cleared container waits for a full truckload before a truck comes for it anyway. */
export const PART_LOAD_WAIT = 300;
export const TRUCK_GIVE_UP = 600; // ticks an empty truck waits before leaving
/** Ticks a shipper's truck spends parked outside the port on its paperwork before it may come in: a day. */
export const PAPERWORK_TICKS = TICKS_PER_DAY;
/** Tiles nearer the outgoing storage a parking space must be for a shipper's truck waiting for a spot to move to it. */
export const STAGE_NEARER_BY = 6;
/**
 * Tiles of road back from a yard gantry's lane that trucks may queue along
 * for it, beyond the lane itself. More holds up the traffic on the roads
 * in, which other yards' trucks share: in a busy port it costs more than
 * it gains.
 */
export const GANTRY_QUEUE_EXTRA = 0;
/** Ticks an unloaded ship waits for exports to be brought to it before it leaves without. */
export const LOAD_WAIT = 300;
/** A tile of truck parking, one truck to a tile. */
export const PARKING_COST = 60;
/**
 * Ticks a truck is away once it leaves the map, on its round and back,
 * before its haulier can send it again: on top of its drive along the
 * highway on the map, either way.
 */
export const TRUCK_ROUND_TRIP = 40;
/** Ticks a container waits in the yard for customs to clear it before a truck may take it: a day. */
export const CUSTOMS_TICKS = TICKS_PER_DAY;
export const BAY_CAPACITY = 12;
export const LARGE_BAY_CAPACITY = 28;
// Ticks to put one crate on a truck: by hand at a truck bay, quicker with
// the room of a large bay, and out of a storage area quickest.
export const BAY_LOAD_TICKS = 10;
export const LARGE_BAY_LOAD_TICKS = 7;
export const STORE_LOAD_TICKS = 3;
export const YARD_LOAD_TICKS = 5; // per container

// Storage areas: port road or quay marked out for crates or containers.
export const CRATE_STORE_COST = 100; // per tile
export const BOX_STORE_COST = 250;
export const CRATE_STORE_TIER = 1;
export const BOX_STORE_TIER = 2;
export const CRATES_PER_STORE_TILE = 16;
export const BOXES_PER_STORE_TILE = 6;
/** A storage area loads one truck at a time for every this many tiles. */
export const STORE_TILES_PER_TRUCK = 2;

export const BOAT_INTERVAL_DAYS = 1; // starter fishery
export const BOAT_CRATES_MIN = 8;
export const BOAT_CRATES_MAX = 12;
export const BOAT_MAX_LOAD = 16;
export const BOAT_DRAFT = 1; // metres
export const MAX_BOATS = 24;

export const MAX_OFFERS = 4;
export const START_SATISFACTION = 75;
export const SATISFACTION_PER_BOAT = 6; // for a boat that never waited
export const ANCHOR_PENALTY_TICKS = 90; // -1 satisfaction per this many ticks at anchor
export const MOORED_GRACE_TICKS = 40; // plus MOORED_TICKS_PER_CRATE for each crate on board
export const MOORED_TICKS_PER_CRATE = 90; // about one dockhand's pace
export const MOORED_PENALTY_TICKS = 60;
/** Kept this long past its time allowed, unloading and loading, a ship sails with the exports it has. */
export const LOAD_OVERRUN_TICKS = 300;
export const BOAT_GIVE_UP_TICKS = 900; // a boat kept this long leaves with its cargo
export const GAVE_UP_PENALTY = 10; // extra satisfaction lost when a boat leaves full
export const NO_ROOM_PENALTY = 3; // a boat could not even enter the crowded harbour

// Money penalties. See the Contracts panel for how they are explained.
export const DEMURRAGE_PER_DAY = 300; // per boat, for each day it is kept waiting
/** A day's demurrage below this is not worth a message; the Finance panel still shows it. */
export const DEMURRAGE_NOTICE = 100;
export const LOST_CARGO_SHARE = 1; // of the cargo value, when a boat leaves still loaded
export const BREACH_MULTIPLIER = 2; // a walk-out costs this many times the signing fee…
export const BREACH_MIN = 1000; // …and never less than this
export const STARTER_SIGNING_FEE = 400; // nominal fee for the contract you start with
export const CANCEL_FEE_SHARE = 1; // of the signing fee, when you end a contract yourself
export const LOAN_STEP = 2500;
export const LOAN_MAX = 20000;
export const LOAN_DAILY_RATE = 0.004; // charged on the outstanding loan each day
export const BANKRUPT_DAYS = 7; // days in the red before the bank closes the port

export const WALK_SPEED = 0.24; // tiles per tick on a footpath

// Crowding: workers do not walk through each other.
export const GATHER_CAP = 3; // workers per lane on a truck bay or break hut tile
export const SIDESTEP_AFTER = 6; // ticks blocked before trying to step aside
export const REROUTE_AFTER = 18; // ticks blocked before looking for a way around
export const SQUEEZE_AFTER = 60; // ticks blocked before squeezing past anyway
export const WORKERS_PER_SPOT = 2; // sent to the same loading spot at once
export const TRUCK_SPEED = 0.7;
/** Trucks drive this far right of the middle of the road, in tiles. */
export const TRUCK_LANE = 0.18;
/** Room a truck keeps behind the one ahead of it, bumper to bumper, in tiles. */
export const TRUCK_GAP = 0.25;
/** Ticks trucks held up behind each other in a ring wait before the lowest numbered goes on. */
export const TRUCK_RING_AFTER = 40;
/** How long reach stackers and terminal tractors are, in tiles, for the room they keep in traffic. */
export const MACHINE_LENGTH = { stacker: 0.8, tractor: 0.9 };
/** How far right of the middle of the road reach stackers and terminal tractors drive (as entities.ts shows them). */
export const MACHINE_LANE = 0.2;
/** A truck's length in tiles: a container truck by how many it carries, a crate truck by its size. */
export function truckLength(capacity: number, boxes: boolean): number {
  // A container truck pulls a trailer for each, coupled one behind another.
  if (boxes) return 1.18 + 0.74 * Math.max(0, capacity - 1);
  return capacity > 6 ? 1.33 : capacity >= 6 ? 1.03 : 0.84;
}
/**
 * Trucks and port machines: ticks to get up to speed from standing, and to
 * brake to a stand from full speed; and the share of full speed they take
 * a right-angled corner at.
 */
export const VEHICLE_ACCEL_TICKS = 14;
export const VEHICLE_BRAKE_TICKS = 9;
export const CORNER_SPEED = 0.35;
/**
 * Ticks a truck waits on the others at a junction before it stops giving
 * way; twice this and it goes without room past it, four times and it
 * creeps on through the truck ahead, so traffic never locks up for good.
 */
export const TRUCK_SQUEEZE_AFTER = 150;
/** Ticks before two trucks standing at a junction swap which of them goes first. */
export const TRUCK_TAKE_TURNS = 30;
/**
 * How each kind of vessel handles: hull size in tiles, top speed in tiles a
 * tick, and how fast it can turn at that speed, in radians a tick. Big
 * ships are slow and need room to turn.
 */
export const VESSELS = {
  smack: { length: 1.9, beam: 0.6, speed: 0.15, turn: 0.05 },
  coaster: { length: 2.7, beam: 0.84, speed: 0.11, turn: 0.032 },
  feeder: { length: 5.6, beam: 0.96, speed: 0.08, turn: 0.02 },
  tug: { length: 1.1, beam: 0.48, speed: 0.17, turn: 0.1 },
} as const;
/** Share of top speed a boat gains per tick; it sheds way at twice that. */
export const BOAT_ACCEL = 1 / 60;
/** How much harder than it gathers way a boat can take way off. */
export const BOAT_BRAKE = 1.25;
/** Rows apart that departing boats' lanes out to sea are spread. */
export const EXIT_LANES = 1;
/** Water a ship pulling out of its berth keeps clear to turn in, beyond half its length, in tiles. */
export const ROOM_MARGIN = 1;
/** Longest a ship pulling out keeps that water to itself, in ticks. */
export const ROOM_TICKS = 400;
/**
 * Boats under way plot where their hull will be this many ticks ahead, a
 * point every PLOT_STEP ticks, and look out for others' plots coming too close.
 */
export const LOOKOUT_TICKS = 90;
export const PLOT_STEP = 2;
/** Clear water two hulls under way keep between them as they pass, in tiles. */
export const PASSING_GAP = 0.4;
/** A boat with right of way still acts itself once a collision is this many ticks off. */
export const STAND_ON_TICKS = 25;
/** Ships at least this long mind their whole hull when they turn; see sail(). */
export const CAREFUL_LENGTH = 4;
/** Boats at least this long run out along the dock to open water before turning to leave. */
export const RUN_OUT_LENGTH = 2.5;
/** Ships at least this long line up along the dock well before a berth; see approachPath(). */
export const LINE_UP_LENGTH = 4;
/** Ticks a boat can be held up before it looks for another way. */
export const BOAT_REROUTE_AFTER = 50;
/** Ticks without getting closer before a boat squeezes past others, so traffic never locks up. */
export const BOAT_WEDGED_AFTER = 150;
/** Ticks a ship stands held up by a boat lying still ahead before it swings round or backs off instead. */
export const HELD_STILL_TICKS = 20;

export const PICK_TICKS = 8;
export const DROP_TICKS = 5;

export const FREE_DOCKS = 2; // jetties that work without a harbour office (never quays)
export const DOCKS_PER_OFFICE = 6;
export const MAX_JETTY_DEPTH = 3.5; // wooden piles only reach so far
export const MAX_QUAY_DEPTH = 8;
export const QUAY_COST_LAND = 120;
export const QUAY_COST_WATER = 300;

// Coastal Wharf machines.
export const COASTER_DRAFT = 2.5;
export const COASTER_MAX_LOAD = 24;
export const FORKLIFT_PRICE = 1500;
export const FORKLIFT_WAGE = 55; // operator, per day
export const FORKLIFT_CAPACITY = 4;
export const FORKLIFT_SPEED = 0.42; // tiles per tick
export const FORKLIFT_BREAKDOWN = 0.06; // chance per day
export const REPAIR_TICKS = 240;
export const REPAIR_COST = 112; // at a depot; a call-out to a broken-down forklift costs double
export const DEPOT_SLOTS = 3; // forklifts housed per depot
export const FUEL_PER_TICK = 0.05; // used while driving; a full tank lasts about 3 days of work
export const LOW_FUEL = 25; // heads home to refuel below this
export const REFUEL_PER_TICK = 2;
export const FUEL_COST = 45; // for a full tank
export const PARK_AFTER = 60; // idle ticks before a forklift drives home to park
export const SELL_SHARE = 0.5;
export const CRANE_RUNNING_COST = 30; // per day
export const CRANE_TICKS = 10; // per crate lifted
export const CRANE_STACK = 10;
/** Tiles a jib crane reaches round from where it stands, to swing crates straight into storage. */
export const JIB_REACH = 2;
/** Crates dockhands set down on one quay tile beside a boat, for the forklifts. */
export const PILE_CRATES = 8;

// Container Port.
export const FEEDER_DRAFT = 4;
export const FEEDER_MAX_LOAD = 72; // containers: six bays, three abreast, four high
/** A feeder's deck: bays along it, rows abreast, tiers high. */
export const FEEDER_BAYS = 6;
export const FEEDER_ROWS = 3;
export const FEEDER_TIERS = 4;
/**
 * How far through a container crane's lift (0 to 1) its spreader takes the
 * container, and sets it down.
 */
export const CRANE_LIFT_TAKEN = 0.35;
export const CRANE_LIFT_SET = 0.85;
// Container lines offer loads up to this many times bigger, growing with
// every FEEDER_GROWTH_CONTAINERS containers the port has handled.
export const FEEDER_GROWTH_MAX = 3;
export const FEEDER_GROWTH_CONTAINERS = 1000;
/**
 * Clear water kept between boats moored end to end along a dock, in tiles;
 * boats under way keep out of it too (see seaWay).
 */
export const BERTH_END_GAP = 0.3;
/** Ticks a boat stops short of a moored boat's bow or stern before going on past its hull. */
export const KEEP_CLEAR_PATIENCE = 40;
/** Ticks a ship coming in waits for one moored in its way before that one sails with what it has (and it is shown waiting). */
export const BERTH_BLOCKED_TICKS = 60;
/** How far a ship held up by one moored in its way may creep and still count as waiting on it, in tiles. */
export const WAIT_CREEP = 2;
/** Tiles out from its berth a boat holding a fairway lets a boat pulling out go first. */
export const FAIRWAY_FAR = 5;
/** Harbour tugs: a berth for one, the tug, and what it costs a day to run. */
export const TUG_BERTH_COST = 1500;
export const TUG_PRICE = 6000;
export const TUG_RUNNING_COST = 45;
export const TUG_DRAFT = 2;
/** Tugs come with the coasters, which need them first. */
export const TUG_TIER = 1;
/**
 * How handy a coaster or feeder is without a tug, swinging round, crabbing
 * in alongside, easing off the dock and running out along it, as a share of
 * how it handles with one.
 */
export const UNTUGGED_HANDLING = 0.35;
/** Tiles out from its berth a ship coming in calls its tug. */
export const TUG_MEET = 10;
/** A ship calls its tug with this much cargo still to unload, so it is there to cast off. */
export const TUG_CALL_LOAD = 4;
/** Ticks a ship ready to leave waits for a tug about to come alongside. */
export const TUG_WAIT = 60;
/** A feeder is a big ship: its berth runs 3 tiles either side of the middle. */
export const FEEDER_HALF_BERTH = 3;
export const HARBOUR_CRANE_TICKS = 50; // per container lifted
export const HARBOUR_CRANE_STACK = 4;
export const HARBOUR_CRANE_RUNNING_COST = 112; // per day
/**
 * Ship-to-shore gantry crane: quick, and sets containers down in the bay
 * between its legs, where only reach stackers collect them.
 */
export const GANTRY_COST = 30000;
export const GANTRY_TICKS = 16;
/**
 * Containers a gantry crane sets down along the quay at the shipside, the
 * length of its rails (see GANTRY_RAILS), two deep and two high.
 */
export const GANTRY_STACK = 24;
/** Quay a gantry crane's rails run along, centred on it: the length of a container ship. */
export const GANTRY_RAILS = 6;
/**
 * Tiles further a port machine will go round sooner than drive across the
 * containers a gantry crane has set down along the quay.
 */
export const CRANE_STACK_DETOUR = 40;
export const GANTRY_RUNNING_COST = 225;
/** A yard gantry, which loads the trucks at a container yard. */
export const YARD_GANTRY_COST = 12000;
export const YARD_GANTRY_RUNNING_COST = 90;
/** Ticks a yard gantry takes to take a container up and set it down, besides running along its rails. */
export const YARD_GANTRY_TICKS = 10;
/** Tiles further a truck would sooner go round than drive under a yard gantry not loading it. */
export const GANTRY_LANE_DETOUR = 12;
/** How fast a yard gantry runs along its rails, in tiles a tick. */
export const YARD_GANTRY_SPEED = 2;
export const STACKER_PRICE = 6000;
export const STACKER_WAGE = 80;
export const STACKER_SPEED = 0.32;
/**
 * A terminal tractor: carries one container at a time between the container
 * cranes and the yards with a yard gantry, which lifts it on and off.
 */
export const TRACTOR_PRICE = 3500;
export const TRACTOR_WAGE = 50;
export const TRACTOR_SPEED = 0.45;
/** Long enough for a tractor to wait under a gantry crane for it to lift a container on or off. */
export const TRACTOR_WAIT_TICKS = 100_000;
/** Ticks a tractor waits under a crane working a ship for one straight off it before it gives up. */
export const TRACTOR_GIVE_UP = 300;
/** Ticks before a crane lifts a container off a ship that a tractor called for it means to be there. */
export const TRACTOR_EARLY = 25;
/**
 * Ticks between one tractor and the next under a container crane, as one
 * pulls out loaded and the next pulls in: the crane lifts quicker than that.
 */
export const TRACTOR_TURN = 32;
/** Most tractors called ahead to one container crane for what is still to come off a ship. */
export const TRACTORS_CALLED = 8;
/** About how long a ship takes to make fast once it is at its berth, in ticks. */
export const ALONGSIDE_TICKS = 10;
export const CONTAINER_TRUCK_CAPACITY = 2; // at most; some carry one
export const TREE_CLEAR_COST = 10;
export const CROSSING_COST = 150; // a public road over the railway, with barriers
/** Marking a port road or quay tile for port machines only, or back. */
export const FORKLIFT_ONLY_COST = 5;
export const FORKLIFT_ONLY_TIER = 1;
export const ROCK_CLEAR_COST = 50;
export const BULLDOZE_REFUND = 0.5;

// Dredging and land reclamation: dear, a tile and a step at a time.
export const TERRAFORM_STEP = 2; // metres dug out or filled in per go
export const DREDGE_COST = 400; // per tile, per step deeper
export const DIG_LAND_COST = 800; // digging a shore tile out into sea
export const RECLAIM_COST = 500; // per tile, per step shallower
export const MAX_DREDGE_DEPTH = 12;
export const TERRAFORM_TIER = 1;

// Roads: the highway's exits, one-way roads and gates, traffic lights.
/** Opening a new exit off the highway, with its slip road. */
export const EXIT_COST = 6000;
export const EXIT_TIER = 2;
/**
 * Trucks drive the highway this fast between its exits, in tiles a tick:
 * nearly three times their pace on other roads. They pass through each
 * other out there, so nothing ahead is ever in the way.
 */
export const HIGHWAY_SPEED = 2;
/** Painting one tile of road one way. */
export const ONE_WAY_COST = 15;
export const ONE_WAY_TIER = 1;
/** Making a port gate one way. */
export const GATE_WAY_COST = 100;
export const LIGHTS_COST = 800;
export const LIGHTS_TIER = 2;
/** A roundabout: a ring of one-way road round a little island, 3×3. */
export const ROUNDABOUT_COST = 1200;

export const BUOY_COST = 150;
/** How far to one side of a lone buoy a boat passes it, in tiles. */
export const BUOY_CLEARANCE = 0.7;
/** Least room a boat leaves between its side and a buoy of a pair it crosses between. */
export const GATE_CLEARANCE = 1.2;
/** Water this close to a jetty or quay, in tiles, is kept for boats coming alongside and pulling out… */
export const DOCK_FRONT_RANGE = 5;
/** …so routes past the docks count it this many times over and keep further out. */
export const DOCK_FRONT_COST = 3;
/** What sailing over a buoy's tile costs a route, against 1 for open water. */
export const BUOY_DETOUR = 8;
/**
 * Boats round the corner of a jetty or quay in a wider circle than their
 * hulls need: water nearer the corner than CORNER_NEAR
 * tiles, centre to centre, costs routes this much more than open water,
 * and nearer than CORNER_CLOSE this much.
 */
export const CORNER_NEAR = 1.5;
export const CORNER_NEAR_COST = 3;
export const CORNER_CLOSE = 2.3;
export const CORNER_CLOSE_COST = 1;
/** And they keep this much further again off a boat lying at its berth, at this much more. */
export const MOORED_CLEAR = 1.3;
export const MOORED_CLEAR_COST = 3;

// The town that grows up around the port. See town.ts.
export const TOWN_START = 40; // people in the fishing village when the port opens
export const TOWN_BASE = 30; // who would live there without the port
export const TOWN_PER_JOB = 12; // people each job at the port or its hauliers keeps in town
export const TOWN_PER_GOODS = 3; // people per crate a day the port sends out by road
export const CONTAINER_GOODS = 8; // a container counts as this many crates of goods
export const TOWN_GROWTH = 0.2; // share of the gap to what the port supports closed each day
export const TOWN_BUILD_TICKS = 25; // the town's builders finish one job this often
export const TOWN_PER_LOCAL = 3; // more people per crate a day delivered to the town's businesses
export const TOWN_DELIVERY_BONUS = 0.25; // of a load's fees, paid when it is delivered in town
export const UNLOAD_TICKS = 4; // per crate or container, unloading at a town business
