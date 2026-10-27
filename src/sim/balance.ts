// Tuning values. See plan.md §14.

export const START_CASH = 5000;
export const START_YEAR = 1962;

export const HIRE_FEE = 100;
export const WAGE_DOCKHAND = 40; // per day

export const CRATE_FEE = 20; // paid when a truck leaves with the crate
export const TRUCK_CAPACITY = 6;
export const BIG_TRUCK_CAPACITY = 8;
export const STARTER_HAULIER_FEE = 20; // per day
export const TRUCK_PATIENCE = 120; // ticks a part-loaded truck waits for more crates
export const TRUCK_GIVE_UP = 600; // ticks an empty truck waits before leaving
export const BAY_CAPACITY = 16;

export const BOAT_INTERVAL_DAYS = 1; // starter fishery
export const BOAT_CRATES_MIN = 8;
export const BOAT_CRATES_MAX = 12;
export const BOAT_MAX_LOAD = 16;
export const BOAT_DRAFT = 1; // metres
export const MAX_BOATS = 10;

export const MAX_OFFERS = 4;
export const START_SATISFACTION = 75;
export const SATISFACTION_PER_BOAT = 5; // for a boat that never waited
export const ANCHOR_PENALTY_TICKS = 60; // -1 satisfaction per this many ticks at anchor
export const MOORED_GRACE_TICKS = 40; // plus MOORED_TICKS_PER_CRATE for each crate on board
export const MOORED_TICKS_PER_CRATE = 90; // about one dockhand's pace
export const MOORED_PENALTY_TICKS = 60;
export const BOAT_GIVE_UP_TICKS = 900; // a boat kept this long leaves with its cargo
export const GAVE_UP_PENALTY = 15; // extra satisfaction lost when that happens
export const DEMURRAGE_PER_DAY = 120; // charged for each day a boat is kept waiting
export const STARTER_BREACH_PENALTY = 300; // when the starter fishery walks out
export const CANCEL_FEE_SHARE = 0.5; // of the signing fee, when you end a contract
export const BANKRUPT_DAYS = 7; // days in the red before the bank closes the port

export const WALK_SPEED = 0.24; // tiles per tick on a footpath
export const TRUCK_SPEED = 0.5;
export const BOAT_SPEED = 0.15;

export const PICK_TICKS = 8;
export const DROP_TICKS = 5;

export const MAX_JETTY_DEPTH = 8;
export const TREE_CLEAR_COST = 10;
export const ROCK_CLEAR_COST = 50;
export const BULLDOZE_REFUND = 0.5;
