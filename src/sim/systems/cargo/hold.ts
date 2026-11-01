// Crates where they stand. Each thing that holds crates keeps a cell for
// every place a crate can be, as the 3D view draws them, with the crate in
// it or null: a crate is in one cell, and a cell holds one crate, so where
// each crate is and what it is never come apart. A shape says how the cells
// stand on each other.
//
// Crate storage stacks its crates one stack to a tile, with room all round
// for the forklifts: two rows, each two crates wide and four high, cell =
// tile * 16 + row * 8 + layer * 2 + side; each row is two pallet places,
// one on the other, of four crates each. A truck bay's stack is one such
// tile. A large bay's yard is four by four, a layer of sixteen at a time,
// up to 28. A heap on the quay is two layers of four.

import type { Cells, Crate } from '../../state';
import * as B from '../../balance';

export type { Cells };

/** How a holder's cells stand on each other. */
export interface Shape {
  /** Cells in all. */
  cap: number;
  /** The cell under `s`, or -1 on the ground. */
  below(s: number): number;
  /** The cell on top of `s`, or -1 if none can go there. */
  above(s: number): number;
  /** How many crates up `s` is. */
  height(s: number): number;
  /** Which stack `s` is in: one to a tile of crate storage, a truck bay's own. */
  stack(s: number): number;
}

/** Crates on a tile of crate storage, and in a truck bay's stack. */
const PER_TILE = B.CRATES_PER_STORE_TILE;
/** Crates in each row of such a stack. */
const ROW = 8;
/** A large bay's yard: crates in a layer, and how many in all. */
const LARGE_LAYER = 16;
const LARGE_CELLS = 28;

/** Crate storage on `tiles` tiles, or a truck bay's stack (`tiles` 0, as it has none of its own). */
export function stackShape(tiles: number): Shape {
  return {
    cap: tiles > 0 ? tiles * PER_TILE : PER_TILE,
    below: (s) => (s % ROW >= 2 ? s - 2 : -1),
    above: (s) => (s % ROW < ROW - 2 ? s + 2 : -1),
    height: (s) => Math.floor((s % ROW) / 2),
    stack: (s) => Math.floor(s / PER_TILE),
  };
}

/** A large bay's yard: layers of sixteen. */
export function largeShape(): Shape {
  return {
    cap: LARGE_CELLS,
    below: (s) => (s >= LARGE_LAYER ? s - LARGE_LAYER : -1),
    above: (s) => (s + LARGE_LAYER < LARGE_CELLS ? s + LARGE_LAYER : -1),
    height: (s) => Math.floor(s / LARGE_LAYER),
    stack: () => 0,
  };
}

/** A heap on the quay: two layers of four. */
export function pileShape(): Shape {
  const layer = 4;
  return {
    cap: B.PILE_CRATES,
    below: (s) => (s >= layer ? s - layer : -1),
    above: (s) => (s + layer < B.PILE_CRATES ? s + layer : -1),
    height: (s) => Math.floor(s / layer),
    stack: () => 0,
  };
}

/** Cells `cells` has room for in all, grown to `cap` with empty ones (and never cut short). */
export function sized(cells: Cells, cap: number): Cells {
  while (cells.length < cap) cells.push(null);
  return cells;
}

/** Whether a crate goes the way `out` asks: going out, coming in, or (undefined) either. */
function goes(c: Crate, out?: boolean): boolean {
  return out === undefined || !!c.out === out;
}

/** The cells with a crate in, going out, coming in or (undefined) either. */
export function filled(cells: Cells, out?: boolean): number[] {
  const at: number[] = [];
  cells.forEach((c, s) => c && goes(c, out) && at.push(s));
  return at;
}

/** How many crates there are, going out, coming in or (undefined) either. */
export function count(cells: Cells, out?: boolean): number {
  let n = 0;
  for (const c of cells) if (c && goes(c, out)) n++;
  return n;
}

/** Every cell with a crate in. */
export function usedIn(cells: Cells): Set<number> {
  return new Set(filled(cells));
}

/** Put a crate in an empty cell. */
export function put(cells: Cells, s: number, c: Crate): void {
  if (s < 0 || s >= cells.length) throw new Error(`no cell ${s} of ${cells.length}`);
  if (cells[s]) throw new Error(`cell ${s} is taken`);
  cells[s] = c;
}

/** Take the crate out of a cell. */
export function take(cells: Cells, s: number): Crate {
  const c = cells[s];
  if (!c) throw new Error(`cell ${s} is empty`);
  cells[s] = null;
  return c;
}

/** Whether a crate still waits on customs or its export papers at `tick`. */
export function waits(c: Crate, tick: number): boolean {
  return c.clears !== undefined && c.clears > tick;
}

/** Whether nothing stands on the crate in `s`. */
export function clear(cells: Cells, sh: Shape, s: number): boolean {
  const up = sh.above(s);
  return up < 0 || !cells[up];
}
