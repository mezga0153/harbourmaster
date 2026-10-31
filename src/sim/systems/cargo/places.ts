// Where each crate stands in crate storage or a truck bay's stack: the slot it
// was set down in, kept from then until it is taken, so the crates already
// there never move as others come and go.
//
// Crate storage stacks its crates as a truck bay does, one stack to a tile
// in the middle of it, with room all round for the forklifts: two rows, each
// two crates wide and four high, slot = tile * 16 + row * 8 + layer * 2 +
// side, as the 3D view lays them out; each row is two pallet places, one on
// the other, of four crates each. A large bay's yard is four by four, a
// layer of sixteen at a time, up to 28. A crate stands on the ground or on the one
// below it; a forklift sets its load down only on empty ground or on a
// whole layer, so it sits level; dockhands set crates down one at a time,
// filling the place they started first. Crates that will wait in storage
// on customs or export papers go on the ground while there is room, so
// they never bury ones free to go.
//
// A forklift gets its forks under a pallet only from the end of the stack
// its row faces: the front row from the tile before it, the back row from
// the one after (see forksAlongZ). Where that side has no ground to drive
// on, or a truck stands there, it reaches the row only through the other
// while that is empty; so it takes and sets down only pallets it can get
// to, and where a stack has ground at just one end, its far row fills
// first and is emptied last.

import type { World } from '../../world';
import type { Bay, Dockhand } from '../../state';
import * as B from '../../balance';
import { needsCustoms, needsPapers } from '../../helpers';
import { drivable, forksAlongZ } from '../../rules';
import { Build } from '../../types';
import { jibLoadReach } from './exports';
import { jibTiles } from './stores';

/** Crates in a crate storage pallet place, and in a layer of one. */
export const PLACE = B.FORKLIFT_CAPACITY;
const PER_TILE = B.CRATES_PER_STORE_TILE;
/** A truck bay's stack: crates in each of its two rows, and how many slots in all. */
const BAY_ROW = 8;
const BAY_SLOTS = 16;
/** A large bay's yard: crates in a layer, and how many slots in all. */
const LARGE_LAYER = 16;
const LARGE_SLOTS = 28;

/** Pallet places on each tile of crate storage. */
const PLACES = PER_TILE / PLACE;

/** Which stack slot `s` of a bay is in: in crate storage, the tile (by its place in its tiles). */
export function stackOf(b: Bay, s: number): number {
  return shape(b).stack(s);
}

/** The slot under `s` at a bay, or -1 on the ground. */
export function slotBelow(b: Bay, s: number): number {
  return shape(b).below(s);
}

/** How many slots a bay has. */
export function slotCount(b: Bay): number {
  return shape(b).cap;
}

/** Whether each crate at this bay keeps a slot of its own: crate storage and truck bays. */
export function slotted(b: Bay): boolean {
  return !b.yard && !b.pile;
}

/** How a bay's slots stand on each other. */
interface Shape {
  /** Slots in all. */
  cap: number;
  /** The slot under `s`, or -1 on the ground. */
  below(s: number): number;
  /** The slot on top of `s`, or -1 if none can go there. */
  above(s: number): number;
  /** How many crates up `s` is. */
  height(s: number): number;
  /** Which stack `s` is in: one to a tile of crate storage, a truck bay's own. */
  stack(s: number): number;
}

/**
 * A pallet place: four slots one after another, two side by side, two
 * high, that a forklift's load fills; slot `s` is in place s / PLACE.
 */
function placeIn(s: number): number {
  return Math.floor(s / PLACE);
}

function shape(b: Bay): Shape {
  if (b.large && !b.tiles) {
    return {
      cap: LARGE_SLOTS,
      below: (s) => (s >= LARGE_LAYER ? s - LARGE_LAYER : -1),
      above: (s) => (s + LARGE_LAYER < LARGE_SLOTS ? s + LARGE_LAYER : -1),
      height: (s) => Math.floor(s / LARGE_LAYER),
      stack: () => 0,
    };
  }
  // A truck bay's stack, and crate storage's, one to each tile: two rows,
  // each two crates wide and four high, a row filled to the top first.
  return {
    cap: b.tiles ? b.tiles.length * PER_TILE : BAY_SLOTS,
    below: (s) => (s % BAY_ROW >= 2 ? s - 2 : -1),
    above: (s) => (s % BAY_ROW < BAY_ROW - 2 ? s + 2 : -1),
    height: (s) => Math.floor((s % BAY_ROW) / 2),
    stack: (s) => Math.floor(s / PER_TILE),
  };
}

/** Which ends of a crate storage tile's stack a forklift can drive up to: now, and with no trucks about. */
interface Ends {
  now: [boolean, boolean];
  ever: [boolean, boolean];
}

/** Each storage tile's ends, worked out once a tick. */
let endsCache: { w: World; tick: number; trucks: Set<number>; at: Map<number, Ends> } | undefined;

/**
 * Which ends of the stack on crate storage tile `t` a forklift can drive
 * up to, the front row's then the back row's: port ground (not a depot),
 * and now, no truck standing there.
 */
function stackEnds(w: World, t: number): Ends {
  if (endsCache?.w !== w || endsCache.tick !== w.tick) {
    // Trucks standing still, loading, unloading or parked, stand in the way.
    const trucks = new Set<number>();
    for (const q of w.trucks) {
      if (q.state === 'loading' || q.state === 'delivering' || q.state === 'parked') {
        trucks.add(w.tileOf(q));
      }
    }
    endsCache = { w, tick: w.tick, trucks, at: new Map() };
  }
  const cache = endsCache;
  let ends = cache.at.get(t);
  if (ends) return ends;
  const m = w.map;
  const z = forksAlongZ(m, t);
  const side = (d: number) => {
    const [x, y] = [m.xOf(t) + (z ? 0 : d), m.yOf(t) + (z ? d : 0)];
    if (!m.inBounds(x, y)) return -1;
    const n = m.idx(x, y);
    return drivable(m.build[n]) && m.build[n] !== Build.Depot ? n : -1;
  };
  const [a, b] = [side(-1), side(1)];
  ends = {
    ever: [a >= 0, b >= 0],
    now: [a >= 0 && !cache.trucks.has(a), b >= 0 && !cache.trucks.has(b)],
  };
  cache.at.set(t, ends);
  return ends;
}

/** The tile (as an index into its tiles) and row of crate storage's pallet place `k`. */
function rowOf(k: number): [number, number] {
  return [Math.floor(k / PLACES), Math.floor((k % PLACES) / 2)];
}

/** Whether none of `used` is in row `row` of the stack on storage tile `n` (an index into its tiles). */
function rowEmpty(n: number, row: number, used: Set<number>): boolean {
  const first = n * PER_TILE + row * BAY_ROW;
  for (let s = first; s < first + BAY_ROW; s++) if (used.has(s)) return false;
  return true;
}

/**
 * Whether a forklift can get its forks under pallet place `k` in crate
 * storage now, `used` the slots with crates in them (or kept for some):
 * from the end of the stack its row faces, else through the other row
 * while that is empty. Anywhere else, always.
 */
export function reachable(w: World, b: Bay, k: number, used: Set<number>): boolean {
  if (!b.tiles || b.yard) return true;
  const [n, row] = rowOf(k);
  const t = b.tiles[n];
  if (t === undefined) return false;
  const { now } = stackEnds(w, t);
  if (now[row]) return true;
  return now[1 - row] && rowEmpty(n, 1 - row, used);
}

/**
 * Whether pallet place `k` is in the near row of a stack with ground at
 * one end only while its far row still has room: filled only once that
 * is full, so nothing is shut in behind it with room going spare.
 */
function shutsIn(w: World, b: Bay, k: number, used: Set<number>): boolean {
  if (!b.tiles || b.yard) return false;
  const [n, row] = rowOf(k);
  const t = b.tiles[n];
  if (t === undefined) return false;
  const { ever } = stackEnds(w, t);
  if (ever[0] === ever[1] || !ever[row]) return false;
  const first = n * PER_TILE + (1 - row) * BAY_ROW;
  for (let s = first; s < first + BAY_ROW; s++) if (!used.has(s)) return true;
  return false;
}

/**
 * The slot of each of a bay's crates, and of each of its exports, kept
 * beside them: brought up to date with the lists, any new ones at the end
 * set down one at a time (see freeSlot). A game saved before crates kept
 * their slots has a truck bay's as it showed them, one after another, and
 * crate storage's stacked afresh.
 */
export function crateSlots(w: World, b: Bay): { crates: number[]; exports: number[] } {
  const exports = b.exports ?? [];
  if (!b.crateSlots) {
    // Crate storage laid out afresh, a stack at a time.
    const all = b.tiles ? [] : oldLayout(b);
    b.crateSlots = all.slice(0, b.crates.length);
    b.outSlots = all.slice(b.crates.length);
    b.places = undefined;
  }
  const crates = b.crateSlots;
  const out = (b.outSlots ??= []);
  if (crates.length > b.crates.length) crates.length = b.crates.length;
  if (out.length > exports.length) out.length = exports.length;
  const cap = shape(b).cap;
  const used = new Set<number>();
  for (const list of [crates, out]) {
    list.forEach((s, i) => {
      if (s < 0 || s >= cap || used.has(s)) list[i] = -1;
      else used.add(s);
    });
  }
  const kept = reserved(w, b);
  for (const [list, fees, isOut] of [
    [crates, b.crates, false],
    [out, exports, true],
  ] as const) {
    for (let i = 0; i < fees.length; i++) {
      if (i < list.length && list[i] >= 0) continue;
      const s = freeSlot(b, used, kept, waitsIn(b, isOut, [fees[i]]), waitingSlots(w, b, list), w);
      list[i] = s;
      if (s >= 0) used.add(s);
    }
  }
  return { crates, exports: out };
}

/** Where a truck bay's crates then exports stood before each kept a slot of its own. */
function oldLayout(b: Bay): number[] {
  const n = b.crates.length + (b.exports?.length ?? 0);
  return Array.from({ length: n }, (_, k) => (k < shape(b).cap ? k : -1));
}

/**
 * The slots of a bay's crates still waiting on customs and its exports on
 * export papers, as customs.ts has them: the newest of the kinds that wait,
 * as many as wait. `partial` is a list being brought up to date, as far
 * as it goes.
 */
export function waitingSlots(w: World, b: Bay, partial?: number[]): Set<number> {
  const out = new Set<number>();
  if (!b.tiles || b.yard) return out;
  for (const [fees, slots, holds, waits] of [
    [
      b.crates,
      partial && partial === b.crateSlots ? partial : b.crateSlots,
      b.customs,
      needsCustoms,
    ],
    [
      b.exports ?? [],
      partial && partial === b.outSlots ? partial : b.outSlots,
      b.papers,
      needsPapers,
    ],
  ] as const) {
    let n = (holds ?? []).filter((t) => t > w.tick).length;
    for (let i = fees.length - 1; i >= 0 && n > 0; i--) {
      if (!waits(fees[i])) continue;
      n--;
      const s = slots?.[i];
      if (s !== undefined && s >= 0) out.add(s);
    }
  }
  return out;
}

/** Every slot taken at a bay, by its crates and its exports. */
export function usedSlots(w: World, b: Bay): Set<number> {
  const { crates, exports } = crateSlots(w, b);
  return new Set([...crates, ...exports].filter((s) => s >= 0));
}

/**
 * The slots kept at a bay for loads on their way down into them (see
 * claimDrop), and for the crates jib cranes are swinging into it.
 */
export function reserved(w: World, b: Bay, except?: Dockhand): Set<number> {
  const out = new Set<number>();
  const sh = shape(b);
  for (const c of w.cranes.values()) {
    if (c.setInto?.store === b.idx && c.setInto.slot >= 0) out.add(c.setInto.slot);
  }
  for (const q of w.people) {
    if (q === except) continue;
    // Nothing set on a pallet a forklift is lifting off.
    if (
      q.kind === 'forklift' &&
      q.state === 'picking' &&
      q.stockIdx === b.idx &&
      q.takeAt !== undefined
    ) {
      for (let s = q.takeAt * PLACE; s < (q.takeAt + 1) * PLACE; s++) {
        const up = sh.above(s);
        if (up >= 0 && placeIn(up) !== q.takeAt) out.add(up);
      }
    }
    if (!claiming(q, b)) continue;
    for (let k = 0; k < Math.max(1, q.carrying); k++) out.add(q.dropAt! + k);
  }
  return out;
}

/** Whether a worker has a place at this bay kept for the load it is setting down. */
function claiming(q: Dockhand, b: Bay): boolean {
  return (
    q.dropAt !== undefined &&
    q.dropIn === b.idx &&
    q.bayIdx === b.idx &&
    (q.state === 'toDrop' || q.state === 'dropping')
  );
}

/**
 * Whether crates set down at a bay will wait there, on customs (or `out`,
 * export papers): in crate storage, as only there they wait; those
 * carried out of storage cleared do not.
 */
export function waitsIn(b: Bay, out: boolean, fees: number[], cleared = false): boolean {
  if (!b.tiles || b.yard) return false;
  return out ? fees.some(needsPapers) : !cleared && fees.some(needsCustoms);
}

/**
 * Where one crate set down on its own goes: on top of the place being
 * filled, if one is, so a place fills before the next is started; else
 * the lowest free place. Always on the ground or on another crate; on the
 * ground while there is room for one that will wait (`ground`). Only on
 * the stacks in `only` (by tile, see stackOf) if given, as a jib crane
 * reaches just those beside it. -1 if there is no room.
 */
export function freeSlot(
  b: Bay,
  used: Set<number>,
  kept = new Set<number>(),
  ground = false,
  waiting?: Set<number>,
  w?: World,
  only?: Set<number>,
): number {
  const sh = shape(b);
  const taken = new Set([...used, ...kept]);
  const open = (s: number) => {
    if (used.has(s) || kept.has(s)) return false;
    if (only && !only.has(sh.stack(s))) return false;
    const under = sh.below(s);
    return under < 0 || used.has(under);
  };
  // The near row of a stack with ground at one end only, last.
  const later = (s: number) => (w && shutsIn(w, b, placeIn(s), taken) ? 1 : 0);
  if (ground) {
    let first = -1;
    let beside = -1;
    for (let s = 0; s < sh.cap; s++) {
      if (!open(s) || sh.below(s) >= 0) continue;
      if (first < 0 || later(s) < later(first)) first = s;
      // Beside one already on the ground first.
      const start = sh.stack(s) * PER_TILE;
      let near = false;
      for (let k = start; k < start + PER_TILE && !near; k++) near = used.has(k);
      if (near && (beside < 0 || later(s) < later(beside))) beside = s;
    }
    if (beside >= 0 && later(beside) <= later(first)) return beside;
    if (first >= 0) return first;
    // Else on another that waits, so it buries none free to go.
    if (waiting) for (let s = 0; s < sh.cap; s++) if (open(s) && waiting.has(sh.below(s))) return s;
  }
  // In storage, a stack already started first; in it the pallet on the
  // ground in one row, then in the other, before those on top of them, so
  // a forklift always has a whole one it may lift off clear; but where it
  // has ground at one end only, the far row full first.
  if (b.tiles) {
    let best = -1;
    let least = Infinity;
    for (let s = 0; s < sh.cap; s++) {
      if (!open(s)) continue;
      const first = sh.stack(s) * PER_TILE;
      let started = false;
      for (let k = first; k < first + PER_TILE && !started; k++) started = used.has(k);
      const rank = [0, 2, 1, 3][Math.floor((s % PER_TILE) / PLACE)];
      const v = (started ? 0 : 1e6) + first * 10 + later(s) * 100 + rank * PLACE + (s % PLACE);
      if (v < least) [best, least] = [s, v];
    }
    return best;
  }
  for (let s = 0; s < sh.cap; s++) if (open(s)) return s;
  return -1;
}

/**
 * Where a forklift's load of `n` goes: the first of `n` slots one after
 * another in one pallet place, set on empty ground or on a whole layer,
 * never on one with a crate missing from its top; in crate storage only
 * where it can get its forks in (see reachable), the near row of a stack
 * with ground at one end only once the far one is full. On the lowest
 * free ground first, so the whole pallets already there stay clear to
 * lift off; on top of a stack when there is none. Only on the stacks in
 * `only` if given (see freeSlot). -1 if none fits.
 */
export function loadSlot(
  b: Bay,
  n: number,
  used: Set<number>,
  kept = new Set<number>(),
  w?: World,
  only?: Set<number>,
): number {
  const sh = shape(b);
  if (n <= 0) return -1;
  const taken = new Set([...used, ...kept]);
  let best = -1;
  let least = Infinity;
  for (let s = 0; s + n <= sh.cap; s += 2) {
    if (placeIn(s) !== placeIn(s + n - 1)) continue;
    if (only && !only.has(sh.stack(s))) continue;
    let ok = true;
    for (let k = s; k < s + n && ok; k++) ok = !used.has(k) && !kept.has(k);
    // The layer it goes on whole, and none set on top of where it goes.
    const under = [sh.below(s), sh.below(s + 1)];
    if (!ok || !under.every((u) => u < 0 || used.has(u))) continue;
    if (n === 1 && (used.has(s + 1) || kept.has(s + 1))) continue;
    if (w && !reachable(w, b, placeIn(s), taken)) continue;
    const v = (w && shutsIn(w, b, placeIn(s), taken) ? 2 : 0) + (under[0] < 0 ? 0 : 1);
    if (v < least) [best, least] = [s, v];
    if (v === 0) break;
  }
  return best;
}

/** Whether a forklift's load sits level at slot `s` of this bay; see loadSlot. */
function fitsAt(
  w: World,
  b: Bay,
  s: number,
  n: number,
  used: Set<number>,
  kept: Set<number>,
): boolean {
  const sh = shape(b);
  if (s < 0 || s % 2 !== 0 || s + n > sh.cap || placeIn(s) !== placeIn(s + n - 1)) return false;
  for (let k = s; k < s + n; k++) if (used.has(k) || kept.has(k)) return false;
  if (!reachable(w, b, placeIn(s), new Set([...used, ...kept]))) return false;
  return [sh.below(s), sh.below(s + 1)].every((u) => u < 0 || used.has(u));
}

/**
 * Where the load a worker is carrying goes down at this bay, as it would
 * now: the slot kept for it if it has one, else a forklift's whole load
 * level (see loadSlot), a dockhand's one crate on its own (see freeSlot).
 * The first of the slots, the rest following on; -1 if there is none.
 */
export function dropSlot(w: World, p: Dockhand, b: Bay): number {
  if (claiming(p, b)) return p.dropAt!;
  const used = usedSlots(w, b);
  const kept = reserved(w, b, p);
  const ground = waitsIn(b, !!p.outbound, p.cargoFees, p.cleared);
  if (p.kind !== 'forklift') return freeSlot(b, used, kept, ground, waitingSlots(w, b), w);
  const n = Math.max(1, p.carrying);
  const only = forkliftOnly(w, p, b);
  const s = only ? loadSlot(b, n, used, kept, w, only) : -1;
  return s >= 0 ? s : loadSlot(b, n, used, kept, w);
}

/**
 * The stacks (by tile) of crate storage a forklift sets its load down on
 * where a jib crane is beside it: exports for a ship under it on those it
 * reaches, for it to lift on board; other crates, moved within the same
 * storage to make room for the crane or brought from elsewhere, off them,
 * as those are kept for the crane. Anywhere otherwise.
 */
function forkliftOnly(w: World, p: Dockhand, b: Bay): Set<number> | undefined {
  if (!b.tiles || b.yard) return undefined;
  if (p.outbound) return jibLoadReach(w, b);
  const near = jibTiles(w, b);
  if (near.size === 0) return undefined;
  return new Set(b.tiles.map((_, n) => n).filter((n) => !near.has(n)));
}

/**
 * Keep the slots a worker's load goes into at this bay as it comes to set
 * it down, so nothing else is put there meanwhile; false if there is no
 * place it may set it down in (for a forklift, none level).
 */
export function claimDrop(w: World, p: Dockhand, b: Bay): boolean {
  if (!slotted(b)) return true;
  if (claiming(p, b)) {
    const used = usedSlots(w, b);
    const kept = reserved(w, b, p);
    const n = Math.max(1, p.carrying);
    const ok =
      p.kind === 'forklift' ? fitsAt(w, b, p.dropAt!, n, used, kept) : !used.has(p.dropAt!);
    if (ok) return true;
  }
  p.dropAt = undefined;
  const s = dropSlot(w, p, b);
  if (s < 0) return false;
  p.dropAt = s;
  p.dropIn = b.idx;
  return true;
}

/** Whether a forklift's load of `n` has a level place to go at this bay. */
export function loadFits(w: World, b: Bay, n: number, p?: Dockhand): boolean {
  if (!slotted(b)) return true;
  return loadSlot(b, Math.max(1, n), usedSlots(w, b), reserved(w, b, p), w) >= 0;
}

/**
 * The last `n` crates (or `out`, exports) just put on a bay's list were
 * set down by `p`: into the slots kept for them, else as they would go
 * now, one at a time for any but a forklift.
 */
export function setDown(w: World, b: Bay, out: boolean, n: number, p?: Dockhand): void {
  if (!slotted(b) || n <= 0) return;
  const claimed = p && claiming(p, b) ? p.dropAt! : -1;
  if (p) p.dropAt = undefined;
  const { crates, exports } = crateSlots(w, b);
  const list = out ? exports : crates;
  const new_ = list.slice(list.length - n);
  const used = new Set([...crates, ...exports].filter((s) => s >= 0));
  for (const s of new_) used.delete(s);
  const kept = reserved(w, b, p);
  const fees = (out ? (b.exports ?? []) : b.crates).slice(-n);
  const ground = waitsIn(b, out, fees, p?.cleared);
  let first = claimed;
  if (first < 0 || ![...Array(n).keys()].every((k) => !used.has(first + k))) {
    first = p?.kind === 'forklift' ? loadSlot(b, n, used, kept, w) : -1;
  }
  for (let k = 0; k < n; k++) {
    const s = first >= 0 ? first + k : freeSlot(b, used, kept, ground, waitingSlots(w, b), w);
    list[list.length - n + k] = s;
    if (s >= 0) used.add(s);
  }
}

/**
 * Which of a bay's crates (or `out`, its exports) `n` taken off it are,
 * those `ok` lets go: only ones with none on top, from the place crate
 * `at` is in first, top down, then off the top of the others, the newest
 * first. Taking from under the rest, or from the middle of a stack, never
 * moves another.
 */
export function takeOrder(
  w: World,
  b: Bay,
  out: boolean,
  at: number,
  n: number,
  ok: (i: number) => boolean,
): number[] {
  const sh = shape(b);
  const { crates, exports } = crateSlots(w, b);
  const list = out ? exports : crates;
  const used = new Set([...crates, ...exports].filter((s) => s >= 0));
  const want = at >= 0 && at < list.length && list[at] >= 0 ? placeIn(list[at]) : -1;
  const whole = (k: number) => {
    for (let s = k * PLACE; s < (k + 1) * PLACE; s++) if (!used.has(s)) return false;
    return true;
  };
  const pick: number[] = [];
  while (pick.length < n) {
    let best = -1;
    let score = -Infinity;
    list.forEach((s, i) => {
      if (pick.includes(i) || !ok(i)) return;
      const up = s >= 0 ? sh.above(s) : -1;
      if (up >= 0 && used.has(up)) return;
      // In storage off a pallet not whole first, so those that are stay
      // whole for the forklifts, and one a forklift can get to before any
      // other; at a truck bay the last slot of its stack first, as it
      // fills them.
      const v = b.tiles
        ? (s >= 0 && placeIn(s) === want ? 1e6 : 0) +
          (s >= 0 && reachable(w, b, placeIn(s), used) ? 1e7 : 0) +
          (s >= 0 && !whole(placeIn(s)) ? 1e5 : 0) +
          (s >= 0 ? sh.height(s) : 0) * 1e3 +
          i
        : s;
      if (v > score) {
        score = v;
        best = i;
      }
    });
    if (best < 0) break;
    pick.push(best);
    used.delete(list[best]);
  }
  return pick.sort((a, c) => a - c);
}

/** Drop the slots of crates (or `out`, exports) taken off a bay at `picks`, highest first. */
export function takeSlots(w: World, b: Bay, out: boolean, picks: number[]): void {
  if (!slotted(b)) return;
  const { crates, exports } = crateSlots(w, b);
  const list = out ? exports : crates;
  for (const i of [...picks].sort((a, c) => c - a)) if (i < list.length) list.splice(i, 1);
}

/** The slots of a pallet place in storage with crates in it, and which of the list are there. */
export function inPlace(w: World, b: Bay, place: number, out: boolean): number[] {
  const { crates, exports } = crateSlots(w, b);
  const list = out ? exports : crates;
  return list.flatMap((s, i) => (s >= 0 && placeIn(s) === place ? [i] : []));
}

/** Which place a slot is in at this bay. */
export function placeOf(_b: Bay, s: number): number {
  return placeIn(s);
}

/** Whether nothing stands on any crate of pallet place `place` at a bay, so it may be lifted off whole. */
export function clearOnTop(w: World, b: Bay, place: number): boolean {
  const sh = shape(b);
  const used = usedSlots(w, b);
  for (let s = place * PLACE; s < (place + 1) * PLACE; s++) {
    const up = sh.above(s);
    if (up >= 0 && placeIn(up) !== place && used.has(up)) return false;
  }
  return true;
}

/**
 * The slots the next `n` crates set down one at a time at a bay go into,
 * in turn: only on the stacks in `only` if given, and not in `also`,
 * kept for others on their way.
 */
export function nextSlots(
  w: World,
  b: Bay,
  n: number,
  ground = false,
  only?: Set<number>,
  also: number[] = [],
): number[] {
  const used = usedSlots(w, b);
  for (const s of also) if (s >= 0) used.add(s);
  const kept = reserved(w, b);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const s = freeSlot(b, used, kept, ground, waitingSlots(w, b), w, only);
    out.push(s);
    if (s >= 0) used.add(s);
  }
  return out;
}

/**
 * The slot of the `nth` export (from 0) taken off a bay's exports from the
 * top, one at a time; only off the stacks in `only` if given.
 */
export function exportTaken(w: World, b: Bay, nth: number, only?: Set<number>): number {
  const exports = crateSlots(w, b).exports;
  const sh = shape(b);
  const ok = (i: number) => !only || (exports[i] >= 0 && only.has(sh.stack(exports[i])));
  const picks = takeOrder(w, b, true, exports.length - 1, nth + 1, ok);
  return picks.length > nth ? exports[picks[picks.length - 1 - nth]] : -1;
}

/**
 * The slots a bay's crates show in, its crates then its exports, as its
 * view has them: jib cranes' exports already on the hook (`takenAt`)
 * shown in none (-1), and after them all the places those cranes have
 * set crates down in that the lists do not have yet (`setAt`).
 */
export function shownSlots(
  w: World,
  b: Bay,
  moved: { setAt: number[]; takenAt: number[] },
): number[] | undefined {
  if (!slotted(b)) return undefined;
  const { crates, exports } = crateSlots(w, b);
  const gone = new Set(moved.takenAt);
  return [...crates, ...exports.map((s) => (gone.has(s) ? -1 : s)), ...moved.setAt];
}
