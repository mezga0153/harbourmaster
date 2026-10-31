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

import type { World } from '../../world';
import type { Bay, Dockhand } from '../../state';
import * as B from '../../balance';
import { needsCustoms, needsPapers } from '../../helpers';

/** Crates in a crate storage pallet place, and in a layer of one. */
export const PLACE = B.FORKLIFT_CAPACITY;
const PER_TILE = B.CRATES_PER_STORE_TILE;
/** A truck bay's stack: crates in each of its two rows, and how many slots in all. */
const BAY_ROW = 8;
const BAY_SLOTS = 16;
/** A large bay's yard: crates in a layer, and how many slots in all. */
const LARGE_LAYER = 16;
const LARGE_SLOTS = 28;

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
      const s = freeSlot(b, used, kept, waitsIn(b, isOut, [fees[i]]), waitingSlots(w, b, list));
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

/** The slots kept at a bay for loads on their way down into them; see claimDrop. */
export function reserved(w: World, b: Bay, except?: Dockhand): Set<number> {
  const out = new Set<number>();
  const sh = shape(b);
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
 * ground while there is room for one that will wait (`ground`). -1 if
 * there is no room.
 */
export function freeSlot(
  b: Bay,
  used: Set<number>,
  kept = new Set<number>(),
  ground = false,
  waiting?: Set<number>,
): number {
  const sh = shape(b);
  const open = (s: number) => {
    if (used.has(s) || kept.has(s)) return false;
    const under = sh.below(s);
    return under < 0 || used.has(under);
  };
  if (ground) {
    let first = -1;
    for (let s = 0; s < sh.cap; s++) {
      if (!open(s) || sh.below(s) >= 0) continue;
      if (first < 0) first = s;
      // Beside one already on the ground first.
      const start = sh.stack(s) * PER_TILE;
      for (let k = start; k < start + PER_TILE; k++) if (used.has(k)) return s;
    }
    if (first >= 0) return first;
    // Else on another that waits, so it buries none free to go.
    if (waiting) for (let s = 0; s < sh.cap; s++) if (open(s) && waiting.has(sh.below(s))) return s;
  }
  // In storage, a stack already started first; in it the pallet on the
  // ground in one row, then in the other, before those on top of them, so
  // a forklift always has a whole one it may lift off clear.
  if (b.tiles) {
    let best = -1;
    let least = Infinity;
    for (let s = 0; s < sh.cap; s++) {
      if (!open(s)) continue;
      const first = sh.stack(s) * PER_TILE;
      let started = false;
      for (let k = first; k < first + PER_TILE && !started; k++) started = used.has(k);
      const rank = [0, 2, 1, 3][Math.floor((s % PER_TILE) / PLACE)];
      const v = (started ? 0 : 1e6) + first * 10 + rank * PLACE + (s % PLACE);
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
 * never on one with a crate missing from its top. On the lowest free
 * ground first, so the whole pallets already there stay clear to lift
 * off; on top of a stack when there is none. -1 if none fits.
 */
export function loadSlot(
  b: Bay,
  n: number,
  used: Set<number>,
  kept = new Set<number>(),
  _ground = false,
): number {
  const sh = shape(b);
  if (n <= 0) return -1;
  let stacked = -1;
  for (let s = 0; s + n <= sh.cap; s += 2) {
    if (placeIn(s) !== placeIn(s + n - 1)) continue;
    let ok = true;
    for (let k = s; k < s + n && ok; k++) ok = !used.has(k) && !kept.has(k);
    // The layer it goes on whole, and none set on top of where it goes.
    const under = [sh.below(s), sh.below(s + 1)];
    if (!ok || !under.every((u) => u < 0 || used.has(u))) continue;
    if (n === 1 && (used.has(s + 1) || kept.has(s + 1))) continue;
    if (under[0] < 0) return s;
    if (stacked < 0) stacked = s;
  }
  return stacked;
}

/** Whether a forklift's load sits level at slot `s` of this bay; see loadSlot. */
function fitsAt(b: Bay, s: number, n: number, used: Set<number>, kept: Set<number>): boolean {
  const sh = shape(b);
  if (s < 0 || s % 2 !== 0 || s + n > sh.cap || placeIn(s) !== placeIn(s + n - 1)) return false;
  for (let k = s; k < s + n; k++) if (used.has(k) || kept.has(k)) return false;
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
  return p.kind === 'forklift'
    ? loadSlot(b, Math.max(1, p.carrying), used, kept, ground)
    : freeSlot(b, used, kept, ground, waitingSlots(w, b));
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
    const ok = p.kind === 'forklift' ? fitsAt(b, p.dropAt!, n, used, kept) : !used.has(p.dropAt!);
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
  return loadSlot(b, Math.max(1, n), usedSlots(w, b), reserved(w, b, p)) >= 0;
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
    first = p?.kind === 'forklift' ? loadSlot(b, n, used, kept, ground) : -1;
  }
  for (let k = 0; k < n; k++) {
    const s = first >= 0 ? first + k : freeSlot(b, used, kept, ground, waitingSlots(w, b));
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
      // whole for the forklifts; at a truck bay the last slot of its stack
      // first, as it fills them.
      const v = b.tiles
        ? (s >= 0 && placeIn(s) === want ? 1e6 : 0) +
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

/** The slots the next `n` crates set down one at a time at a bay go into, in turn. */
export function nextSlots(w: World, b: Bay, n: number, ground = false): number[] {
  const used = usedSlots(w, b);
  const kept = reserved(w, b);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const s = freeSlot(b, used, kept, ground, waitingSlots(w, b));
    out.push(s);
    if (s >= 0) used.add(s);
  }
  return out;
}

/** The slot of the `nth` export (from 0) taken off a bay's exports from the top, one at a time. */
export function exportTaken(w: World, b: Bay, nth: number): number {
  const exports = crateSlots(w, b).exports;
  const picks = takeOrder(w, b, true, exports.length - 1, nth + 1, () => true);
  return picks.length > nth ? exports[picks[picks.length - 1 - nth]] : -1;
}

/**
 * The slots a bay's crates show in, its crates then its exports, as its
 * view has them: a jib crane's exports already on the hook (`taken`)
 * shown in none (-1), and after them all the places of those it has set
 * down that the lists do not have yet (`set`).
 */
export function shownSlots(
  w: World,
  b: Bay,
  moved: { set: number; taken: number },
): number[] | undefined {
  if (!slotted(b)) return undefined;
  const { crates, exports } = crateSlots(w, b);
  const gone = new Set<number>();
  for (let k = 0; k < moved.taken; k++) gone.add(exportTaken(w, b, k));
  return [...crates, ...exports.map((s) => (gone.has(s) ? -1 : s)), ...nextSlots(w, b, moved.set)];
}
