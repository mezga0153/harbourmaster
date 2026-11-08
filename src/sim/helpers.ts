import { TICKS_PER_DAY } from './types';
import type { Bay, Boat, Crane, Dockhand, DockhandState, GantryLift, Ledger, Truck } from './state';
import * as B from './balance';
import { cargoOf } from './cargo';
import type { Contract } from './contracts';
import { count } from './systems/cargo/hold';
import type { Train } from './railway';
// Small helpers the simulation's systems share: geometry, the arithmetic of
// bays, decks and yards, and the words for what a worker is doing.

/** Days gone by kept for the finance charts. */
export const FINANCE_DAYS = 60;
/** Ticks between cargo counts kept for the statistics charts, and how many are kept: a week's. */
export const CARGO_EVERY = TICKS_PER_DAY / 10;
/** How far a truck backing into a truck bay goes, in tiles, and the share of it spent pulling on past the entrance. */
export const BACK_TURN = 2.2;
export const BACK_PULL = 0.35;
export const CARGO_SAMPLES = 70;

export function emptyLedger(): Ledger {
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
export function laneOf(dir: number): number {
  return ((Math.round(dir / (Math.PI / 2)) % 4) + 4) % 4;
}

export function isMachine(p: { kind: string }): boolean {
  return p.kind !== 'dockhand';
}

/** Reach stackers and terminal tractors move containers; everyone else crates. */
export function isBoxy(p: { kind: string }): boolean {
  return p.kind === 'stacker' || p.kind === 'tractor';
}

/** What drives the port's roads in traffic: trucks, and the reach stackers and terminal tractors. */
export type Vehicle = Truck | Dockhand;

/** A truck or machine about to drive across a tile, and which way. */
export interface Crossing {
  id: number;
  dx: number;
  dy: number;
}

export function isTruck(o: Vehicle): o is Truck {
  return 'contractId' in o;
}

/** Where slot `k` lies on a feeder's deck: its bay from the stern, row across and tier up. */
export function deckPlace(k: number): { bay: number; row: number; tier: number } {
  const per = B.FEEDER_BAYS * B.FEEDER_ROWS;
  return {
    bay: Math.floor((k % per) / B.FEEDER_ROWS),
    row: k % B.FEEDER_ROWS,
    tier: Math.floor(k / per),
  };
}

/** Stacks of containers on each tile of a yard, and how high. */
export const YARD_STACKS = 2;
export const YARD_TIERS = B.BOXES_PER_STORE_TILE / YARD_STACKS;

/** Where slot `k` of a yard is: the tile (by its place in the yard's tiles), the stack on it and the tier. */
export function yardPlace(k: number): { tile: number; stack: number; tier: number } {
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
export function craneStacks(c: Crane): number {
  return c.kind === 'gantry' ? B.GANTRY_RAILS * 2 : 2;
}

/** Ticks a crane takes to lift one crate or container. */
export function craneTicks(c: Crane): number {
  return c.kind === 'gantry'
    ? B.GANTRY_TICKS
    : c.kind === 'harbour'
      ? B.HARBOUR_CRANE_TICKS
      : B.CRANE_TICKS;
}

/** Most a crane sets down before it waits for them to be taken away. */
export function craneStack(c: Crane): number {
  return c.kind === 'gantry'
    ? B.GANTRY_STACK
    : c.kind === 'harbour'
      ? B.HARBOUR_CRANE_STACK
      : B.CRANE_STACK;
}

/** Somewhere a worker can pick up a load. */
export interface Source {
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
  /** A port train standing in its siding for a stacker to load (`load`) or unload, from `yard`. */
  train?: Train;
  yard?: Bay;
  /** Lower goes first. */
  rank: number;
}

/** A container on a yard gantry's spreader, lifted off a truck or tractor that has gone. */

/** Ticks a yard gantry's lift takes in all. */
export function liftTicks(l: GantryLift): number {
  return Math.max(1, l.legs[0] + l.legs[1] + l.legs[2] + l.legs[3]);
}

/** Room left at a bay for crates, or at a container yard for containers. */
export function bayRoom(b: Bay, boxes: boolean): number {
  if (b.pile) return boxes ? 0 : B.PILE_CRATES - cratesAt(b) - b.incoming;
  if (b.yard) return boxes ? bayCap(b) - boxesAt(b) - b.boxIncoming - outHeld(b) : 0;
  if (boxes) return 0;
  return bayCap(b) - cratesAt(b) - b.incoming - outHeld(b);
}

/** Room storage gives over to exports, there or on their way. */
export function outHeld(b: Bay): number {
  return exportsAt(b) + (b.exportIncoming ?? 0);
}

/** How many crates or containers a ship takes out. Fishing boats take ice. */
export function outCap(b: { vessel: string }): number {
  return b.vessel === 'feeder'
    ? B.FEEDER_MAX_LOAD
    : b.vessel === 'coaster'
      ? B.COASTER_MAX_LOAD
      : b.vessel === 'smack'
        ? B.SMACK_ICE_LOAD
        : 0;
}

/** A truck bay: no storage marked out, no yard, not crates landed on the quay. */
export function truckBay(b: Bay): boolean {
  return !b.tiles && !b.yard && !b.pile;
}

export function bayIncoming(b: Bay, boxes: boolean, delta: number): void {
  if (boxes) b.boxIncoming = Math.max(0, b.boxIncoming + delta);
  else b.incoming = Math.max(0, b.incoming + delta);
}

/**
 * Crates of timber and goods off the coasters wait in storage for customs
 * to clear them before a truck may take them; the catch and ice are fresh,
 * and need none.
 */
export function needsCustoms(fee: number): boolean {
  const c = cargoOf(fee);
  return c === 'timber' || c === 'goods';
}

/** Crates of goods and canned fish wait in storage for their export inspection before they may go on board. */
export function needsPapers(fee: number): boolean {
  const c = cargoOf(fee, 'goods');
  return c === 'canned' || c === 'goods';
}

/** Crates and exports in a bay or crate storage. */
export function heldIn(b: Bay): number {
  return cratesAt(b) + cratesAt(b, true);
}

/** Exports waiting at a bay: containers in a yard, crates elsewhere. */
export function exportsAt(b: Bay): number {
  return b.yard ? boxesAt(b, true) : cratesAt(b, true);
}

/** Exports a ship has taken on board. */
export function outAboard(b: Boat): number {
  return count(b.loaded ?? []);
}

/**
 * Containers waiting at a yard (or `out`, to go out on a ship), or at a
 * large truck bay from an older save.
 */
export function boxesAt(b: Bay, out = false): number {
  if (b.yard) return count(b.cells ?? [], out);
  return out ? 0 : (b.boxes?.length ?? 0);
}

/**
 * Crates at a bay coming in (or `out`, going out); a heap on the quay's
 * all count as coming in, whichever way they go.
 */
export function cratesAt(b: Bay, out = false): number {
  const cells = b.cells ?? [];
  if (b.yard) return 0;
  if (b.pile) return out ? 0 : count(cells);
  return count(cells, out);
}

export function bayCap(b: Bay): number {
  if (b.pile) return B.PILE_CRATES;
  if (b.tiles) {
    return b.tiles.length * (b.yard ? B.BOXES_PER_STORE_TILE : B.CRATES_PER_STORE_TILE);
  }
  return b.large ? B.LARGE_BAY_CAPACITY : B.BAY_CAPACITY;
}

/** Ticks to put one crate or container on a truck here. */
export function loadTicks(b: Bay): number {
  if (b.yard) return B.YARD_LOAD_TICKS;
  if (b.warehouse) return B.STORE_LOAD_TICKS;
  return b.large ? B.LARGE_BAY_LOAD_TICKS : B.BAY_LOAD_TICKS;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** An angle brought into -π..π. */
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Distance from a point to the segment x0,y0 to x1,y1. */
export function toSegment(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
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
export function hullGap(
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
export function boxLookOf(from: number, k: number): number {
  return from * 97 + k;
}

/**
 * The looks kept beside a list of containers, the same length as it: any
 * missing (from older saves) made up at the front, any spare dropped.
 */
export function aligned(items: number[], looks: number[] | undefined, seed: number): number[] {
  const out = looks ?? [];
  while (out.length < items.length) out.unshift(boxLookOf(seed, 1000 + out.length));
  if (out.length > items.length) out.splice(0, out.length - items.length);
  return out;
}

export function cancelFee(c: Contract): number {
  return Math.round(c.signingFee * B.CANCEL_FEE_SHARE);
}

export const ACTIVITY: Record<DockhandState, string> = {
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
export const STACKER_ACTIVITY: Partial<Record<DockhandState, string>> = {
  toPickup: 'Heading to the crane',
  picking: 'Lifting a container',
  toDrop: 'Taking a container to the yard',
  dropping: 'Stacking a container',
};

/** Terminal tractors carry containers the cranes and yard gantries lift on and off. */
export const TRACTOR_ACTIVITY: Partial<Record<DockhandState, string>> = {
  toPickup: 'Heading for a container',
  picking: 'Having a container lifted on',
  toDrop: 'Carrying a container',
  dropping: 'Having a container lifted off',
};

/** Forklifts take on what is landed on the quay or by a crane. */
export const FORKLIFT_ACTIVITY: Partial<Record<DockhandState, string>> = {
  toPickup: 'Heading to the cargo',
  picking: 'Lifting crates',
};

/** What a worker is up to; `landing` when setting a load down on the quay, as in an older game. */
export function activity(p: Dockhand, landing: boolean): string {
  if (p.state === 'idle' && p.stuck) return p.stuck;
  if (p.state === 'toDrop' && p.waitingWhy) return p.waitingWhy;
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

/** The dockhand states in which one is at work on a crate. */
export const WORKING: ReadonlySet<DockhandState> = new Set([
  'toPickup',
  'picking',
  'toDrop',
  'dropping',
]);
