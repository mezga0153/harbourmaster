import type { Object3D, Vector3 } from 'three';

// The cranes' moving parts, and the lift each is at, kept from frame to
// frame; and what a crane's runner asks of the port round it.

/** What a crane at work asks of the rest of the port, frame by frame. */
export interface CraneSite {
  /** Game speed, so a lift takes as long as it does in the game. */
  speed(): number;
  /**
   * How far a gantry's carriage and trolley close on where they are going
   * this frame: quickly, in game time, so they are right over a container
   * by the time the spreader comes down on it, at any game speed.
   */
  follow(dt: number): number;
  /** Where a truck's, tractor's or ship's container slot is in the world, or null. */
  truckSlot(id: number, k: number, out: Vector3): Vector3 | null;
  /** Whether that slot shows a container. */
  slotShown(id: number, k: number): boolean;
  /** The crate or container in that slot, shown or not. */
  slotObject(id: number, k: number): Object3D | undefined;
  /** Which way that slot lies in the world, as a turn about y, or null. */
  slotTurn(id: number, k: number): number | null;
  /** How many containers looking like `look` are kept under `key` (a yard, or a crane's stack as -1 - idx). */
  kept(key: number, look: number): number;
  /** The containers kept under `key`, in slot order. */
  order(key: number): number[];
  /** Whether a crane's stack is kept each in its place, as the game has it. */
  placed(idx: number): boolean;
  /** The crate in crate storage `store` or pile `pile`, at `place`. */
  crateIn(store: number | undefined, pile: number | undefined, place: number): Object3D | undefined;
  /** How many containers a truck or tractor shows. */
  shownOn(id: number | undefined): number;
}

export interface YardGantryParts {
  /** The gantry's rails, laid out along +z from its tile into the yard and along x. */
  frame: Object3D;
  /** Legs, beams and trolley, running along x on the rails. */
  carriage: Object3D;
  /** Runs along the beam, along +z of the frame: out over the yard, back over the lane. */
  trolley: Object3D;
  /** Hoist rope from the trolley, scaled to its length, and the spreader on its end. */
  rope: Object3D;
  spreader: Object3D;
  /** The container on the spreader, shown while it carries one. */
  load: Object3D;
  /** How far along the beam the far legs stand, and how far down a truck's deck is. */
  far: number;
  laneDrop: number;
  /** Where in the yard the container it is moving is, in the frame; see slotFor. */
  pick: { x: number; z: number; drop: number } | null;
  /** How far along the rails the truck it is working stands. */
  laneAt: number;
  /** The truck it is working, and the container slot on it it lifts from or sets down in. */
  truck?: number;
  /** Its yard, by first tile, and how many like the one it moves were there as the lift began. */
  yard?: number;
  base: number;
  /** How many containers the truck or tractor it works showed as the lift began. */
  held: number;
  slot: number;
  work: 'load' | 'unload' | null;
  look: number;
  /** How far through a lift, 0 to 1. */
  phase: number;
  /**
   * The lift's legs, as shares of it (see liftMarks), how many ticks it
   * takes, and where the carriage and trolley were as it began: it runs
   * along its rails from there.
   */
  legs: number[];
  ticks: number;
  startX: number;
  startZ: number;
  /** How far along its rails it can run, either way, as laid out along its yard. */
  railFrom: number;
  railTo: number;
  /** The tile of the yard it works beside it (see gantryYard), or -1. */
  works: number;
  /** The tick the game began the lift it is at; see YardView.workStart. */
  liftStart?: number;
  /**
   * Where over the truck or tractor it took the container off it was, in
   * the frame: once it has it, that one may drive off, and it carries on
   * from there rather than follow it.
   */
  offAt?: { x: number; z: number; drop: number };
}

export interface CraneParts {
  /** Rotates about Y to point the jib at the boat being unloaded. */
  slew: Object3D;
  /** Cable from the jib tip, scaled to its length, and the hook on its end. */
  rope: Object3D;
  hook: Object3D;
  /** Cable length when idle, and how far it plays out while lifting. */
  rest: number;
  reach: number;
  stack: Object3D[];
  angle: number;
  target: number;
  busy: boolean;
  /** A gantry: `slew` is its trolley, running out along the boom and back instead. */
  fixed?: boolean;
  /** A ship-to-shore gantry: its parts, and the lift it is at; see runShipGantry. */
  sts?: ShipGantryParts;
  /** A jib crane: its jib, and the lift it is at; see runJib. */
  jib?: JibParts;
  /** A mobile harbour crane: its boom, and the lift it is at; see runHarbourCrane. */
  mhc?: HarbourCraneParts;
}

export interface JibParts {
  /** The jib, luffing about its foot on the cab, and the sections that run out of it. */
  luff: Object3D;
  mid: Object3D;
  end: Object3D;
  /** Where the cable hangs from, at the end of the jib. */
  tip: Object3D;
  /** The crate on the hook, of unit size scaled to the one it moves, and its pallet. */
  load: Object3D;
  pallet: Object3D;
  /** How far out from the pedestal the hook hangs. */
  out: number;
  work: 'load' | 'unload' | null;
  /** The boat and the slot on its deck the crate comes off or goes into. */
  boat: number;
  slot: number;
  /** Crate storage (by first tile) or a pile on the quay (by tile), else its landing stack. */
  store?: number;
  pile?: number;
  /** The crate's place there. */
  place: number;
  carriesPallet: boolean;
  /** How far through a lift, 0 to 1, kept in step with the game. */
  phase: number;
  /** What the lift is of, to take it up where the game has it when that changes. */
  key: string;
  /** Which way the jib was pointing, and how far out, as the lift began. */
  start: { angle: number; out: number };
}

/** A container set down on or lifted off a crane's stack that the game has not caught up with yet. */
export interface StackChange {
  look: number;
  /** The place on the stack, where the game keeps them in places. */
  place?: number;
  /** How many like it were on the stack as the lift began. */
  base: number;
  /** How long ago, in game seconds, so it is let go of if the game never does. */
  age: number;
}

export interface HarbourCraneParts {
  /** Its tile, which its stack's slots are kept under (as -1 - idx). */
  idx: number;
  /** The tile's model, which slots on the ship are brought into. */
  frame: Object3D;
  /** Luffed up and down about its foot, along +x of the slewing deck. */
  boom: Object3D;
  /** The boom's head, which the rope hangs from; it stays level as the boom luffs. */
  head: Object3D;
  /** The luffing ram from the deck up to the underside of the boom. */
  ram: Object3D;
  /** The spreader, turning under the hook, and the container on it while it carries one. */
  spreader: Object3D;
  load: Object3D;
  /** How far out from the tower the hook is, and how high, in the frame. */
  radius: number;
  height: number;
  /** How far the spreader is turned under the boom. */
  twist: number;
  /**
   * Which way round it slews from the ship to the stack (1 or -1), and back
   * the other way, kept from one lift to the next unless the other way is
   * clearly shorter, so it never goes the whole way round.
   */
  way: number;
  /**
   * Where the hook was as the lift began, and how far the spreader is
   * turned under the boom picking up and setting down, chosen then so it
   * does not change its mind as the ship rolls.
   */
  choice: { angle: number; radius: number; twist: number; from: number; to: number } | null;
  /** Off the ship or onto it, or a container onto a tractor beside it or off one. */
  work: 'load' | 'unload' | 'give' | 'take' | null;
  /** The tractor it lifts onto or off, or sets one straight on off the ship; -1 if none. */
  truck: number;
  /** The place on its stack the container it moves is in or goes, as the game has it. */
  place?: number;
  boat: number;
  slot: number;
  look: number;
  /** How far through a lift, 0 to 1, kept in step with the game. */
  phase: number;
  /** How far through the lift it was as last drawn. */
  drawn: number;
  /** Waiting on the ship's deck for the game to hand a container over. */
  held: boolean;
  /** Containers on its stack, and exports, for where the next goes. */
  stacked: number;
  /** How many like the one it moves were on its stack as the lift began. */
  base: number;
  /** The slot on its stack it sets the container it moves down in, or lifts it from. */
  pick: number;
  /**
   * An import set down on the stack, shown there from when it is let go
   * until the game has it there too; and an export lifted off it, gone
   * from when it is taken until the game has taken it away.
   */
  landing: StackChange | null;
  leaving: StackChange | null;
}

export interface ShipGantryParts {
  /** Its main tile, which its stack's slots are kept under (as -1 - idx). */
  idx: number;
  /** Laid out as built: x along the quay edge, the water off +z. */
  frame: Object3D;
  /** Legs, portal, boom and trolley, running along x on the rails. */
  carriage: Object3D;
  /** How far along x the carriage can run either way, on the rails. */
  from: number;
  to: number;
  /** The container on the spreader, shown while it carries one. */
  load: Object3D;
  /** Off the ship or onto it, or a container onto a tractor under it or off one. */
  work: 'load' | 'unload' | 'give' | 'take' | null;
  boat: number;
  slot: number;
  /** The tractor it is lifting a container onto or off, or setting one straight on off the ship. */
  truck: number;
  /** The place on its stack the container it moves is in, or goes. */
  place?: number;
  look: number;
  /** Waiting on the game to hand a container over, not to be brought into step meanwhile. */
  holding?: boolean;
  /** How far through a lift, 0 to 1, kept in step with the game. */
  phase: number;
  /** Containers on the stack between its legs, and exports, for where the next goes. */
  stacked: number;
  /** How many like the one it moves were on its stack as the lift began. */
  base: number;
  /**
   * Where over the tractor it took a container off it was, in the frame:
   * once it has it, the tractor may drive off, and it carries on from there.
   */
  offAt?: { x: number; z: number; drop: number };
}
