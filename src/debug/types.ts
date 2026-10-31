// Dev server only: what the debug overlays ask of the sim, and what it
// answers, on the page (the dev lab) or from the worker (the game). See
// collect.ts for how the answer is worked out and overlay.ts for how it is
// drawn.

/** Whose way across the map the passability layer shows. */
export type PassKind = 'walk' | 'drive' | 'fork' | 'truck';

/** What the overlays want worked out, each frame, while they are on. */
export interface DebugWant {
  /** Every agent's path, or just the selected one's. */
  allPaths: boolean;
  /** The selected entity, for its path and its job in full. */
  selected: number | null;
  /** Tile passability for one kind of agent, or none. */
  pass: PassKind | null;
  /** The trucks' road graph: which way they may step from each tile to the next. */
  roads: boolean;
  /** Crate slots in truck bays and storage, used and kept; bays trucks cannot reach. */
  slots: boolean;
}

/** An agent's way as the sim plans it. */
export interface DebugPath {
  id: number;
  kind: string;
  x: number;
  y: number;
  /** Tiles still to go through, next first. */
  path: number[];
  goal: number;
  /** What it is doing, as the sim has it: its state. */
  state?: string;
  /** Trucks round on the highway off the map: x, y pairs still to drive. */
  round?: number[];
}

/**
 * A grid of cells over the map, `cell` tiles square (1 for tiles, 0.25 for
 * a finer grid), starting at x0, y0, `nx` across: each cell's value is
 * PASS_OK, PASS_COSTLY, PASS_BLOCKED or PASS_HIDDEN, row by row.
 */
export interface DebugGrid {
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
  values: Uint8Array;
}

export const PASS_OK = 0;
export const PASS_COSTLY = 1;
export const PASS_BLOCKED = 2;
export const PASS_HIDDEN = 255;

/** A bay or storage area's crate slots: what each holds, and how it stands. */
export interface DebugSlots {
  idx: number;
  name: string;
  /** Its tiles, main tile first. */
  tiles: number[];
  /** Slots in all, and how many to a stack (one stack a tile of storage, one a bay). */
  cap: number;
  perStack: number;
  /** Slots with a crate (or export) in them, and those kept for loads on their way. */
  used: number[];
  kept: number[];
  /** A line about it: crates, incoming, reserved, shut, cut off and why. */
  note: string;
  noAccess: boolean;
}

export interface DebugView {
  tick: number;
  paths: DebugPath[];
  /** The selected entity's state, field by field, as the sim keeps it. */
  job?: [string, string][];
  pass?: { kind: PassKind; grid: DebugGrid };
  /** Directed steps a truck may take, as pairs of tiles: from, to. */
  roads?: Int32Array;
  slots?: DebugSlots[];
}
