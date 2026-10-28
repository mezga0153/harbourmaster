// Tuning values. See plan.md §14.

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
export const TRUCK_GIVE_UP = 600; // ticks an empty truck waits before leaving
export const BAY_CAPACITY = 12;
export const LARGE_BAY_CAPACITY = 28;
export const WAREHOUSE_CAPACITY = 60;
// Ticks to put one crate on a truck: by hand at a truck bay, quicker with
// the room of a large bay, and off the warehouse's loading docks quickest.
export const BAY_LOAD_TICKS = 10;
export const LARGE_BAY_LOAD_TICKS = 7;
export const WAREHOUSE_LOAD_TICKS = 3;
export const YARD_LOAD_TICKS = 5; // per container
export const WAREHOUSE_DOCKS = 2; // trucks loading at once

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
export const BOAT_GIVE_UP_TICKS = 900; // a boat kept this long leaves with its cargo
export const GAVE_UP_PENALTY = 10; // extra satisfaction lost when a boat leaves full
export const NO_ROOM_PENALTY = 3; // a boat could not even enter the crowded harbour

// Money penalties. See the Contracts panel for how they are explained.
export const DEMURRAGE_PER_DAY = 300; // per boat, for each day it is kept waiting
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
/**
 * How each kind of vessel handles: hull size in tiles, top speed in tiles a
 * tick, and how fast it can turn at that speed, in radians a tick. Big
 * ships are slow and need room to turn.
 */
export const VESSELS = {
  smack: { length: 1.9, beam: 0.6, speed: 0.15, turn: 0.07 },
  coaster: { length: 2.7, beam: 0.84, speed: 0.11, turn: 0.045 },
  feeder: { length: 5.6, beam: 0.96, speed: 0.08, turn: 0.028 },
} as const;
/** Ticks a boat can be held up before it looks for another way. */
export const BOAT_REROUTE_AFTER = 50;
/** Ticks without getting closer before a boat squeezes past others, so traffic never locks up. */
export const BOAT_WEDGED_AFTER = 150;

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
export const REPAIR_COST = 150; // at a depot; a call-out to a broken-down forklift costs double
export const DEPOT_SLOTS = 3; // forklifts housed per depot
export const FUEL_PER_TICK = 0.05; // used while driving; a full tank lasts about 3 days of work
export const LOW_FUEL = 25; // heads home to refuel below this
export const REFUEL_PER_TICK = 2;
export const FUEL_COST = 60; // for a full tank
export const PARK_AFTER = 60; // idle ticks before a forklift drives home to park
export const SELL_SHARE = 0.5;
export const CRANE_RUNNING_COST = 40; // per day
export const CRANE_TICKS = 10; // per crate lifted
export const CRANE_STACK = 10;

// Container Port.
export const FEEDER_DRAFT = 4;
export const FEEDER_MAX_LOAD = 24; // containers
/** A feeder is a big ship: its berth runs 3 tiles either side of the middle. */
export const FEEDER_HALF_BERTH = 3;
export const HARBOUR_CRANE_TICKS = 30; // per container lifted
export const HARBOUR_CRANE_STACK = 4;
export const HARBOUR_CRANE_RUNNING_COST = 150; // per day
export const STACKER_PRICE = 6000;
export const STACKER_WAGE = 80;
export const STACKER_SPEED = 0.32;
export const CONTAINER_TRUCK_CAPACITY = 2; // at most; some carry one
/** Container yard: a 2×2 stacking area that buffers containers for the trucks. */
export const YARD_BOXES = 24;
export const TREE_CLEAR_COST = 10;
/** Painting a port road or quay tile forklift-only, or back. */
export const FORKLIFT_ONLY_COST = 5;
export const FORKLIFT_ONLY_TIER = 1;
export const ROCK_CLEAR_COST = 50;
export const BULLDOZE_REFUND = 0.5;
