// Where each crate stands on a crate truck's bed: the place it was set down
// in, kept from then until it is taken off in town, so the crates already
// on board never move as others go on.
//
// A bed is rows of crates two wide, one on each side of the truck, from the
// cab back: slot = layer * perLayer + column * 2 + side, side 0 on the
// truck's left as it faces (its local -z in the 3D view), as vehicles.ts lays
// them out. Dockhands lift crates on by hand over the side, one at a time,
// and fill only the bottom layer. Forklifts may set a second layer on top,
// as in storage: their load goes down two crates along one side, one or two
// high (one along in the last column of an odd number, carried one on the
// other), only on the bare bed or on a whole level layer, and only from the
// truck's side. Both fill the side away from those who load it (the far
// side, see farSide) first, then the near side. A pickup has one layer,
// loaded by hand.

import type { World } from '../../world';
import type { Bay, Cells, Crate, Dockhand, Truck } from '../../state';
import { filled, put, sized, stamp, take, usedIn } from './hold';
import type { CellsView } from '../../../protocol/views';
import * as B from '../../balance';
import { boxLookOf, isMachine } from '../../helpers';
import { frontOf } from '../../rules/footprint';
import { dest } from './customs';
import { cargoOf } from '../../cargo';

/** Layers of crates a truck's bed can take: one on a pickup, two on a truck forklifts load. */
export function bedLayers(t: Truck): number {
  return t.pickup ? 1 : 2;
}

/** Slots on a truck's bed in all: its capacity a layer, times its layers. */
function slotsOf(t: Truck): number {
  return t.capacity * bedLayers(t);
}

/** How many crates a truck takes on: one layer by hand; two where forklifts load it too. */
export function bedCap(w: World, t: Truck): number {
  if (t.boxes) return t.capacity;
  return t.capacity * (bedLayers(t) > 1 && forkliftsAt(w) ? 2 : 1);
}

/** Whether the port has a forklift that could load a truck. */
export function forkliftsAt(w: World): boolean {
  return w.people.some((p) => p.kind === 'forklift');
}

/**
 * Which side of a truck those who load it come from the other way to,
 * and fill first: away from the stack of the truck bay it stands in, or
 * from the storage or bay it stands beside. Worked out as it starts to
 * load, and kept.
 */
export function farSide(w: World, t: Truck): 0 | 1 {
  if (t.far !== undefined) return t.far;
  const m = w.map;
  const bay = dest(w, t.bayIdx);
  // Its left, as it faces.
  const lx = Math.sin(t.dir);
  const ly = -Math.cos(t.dir);
  let dx = 0;
  let dy = 0;
  if (bay && !bay.tiles && !t.pickup && w.tileOf(t) === bay.idx) {
    // In a truck bay: its stack is on the right of the way in from its front.
    const f = frontOf(m, bay.idx, m.orient[bay.idx] & 3);
    const fx = f >= 0 ? m.xOf(f) - m.xOf(bay.idx) : 0;
    const fy = f >= 0 ? m.yOf(f) - m.yOf(bay.idx) : 1;
    [dx, dy] = [fy, -fx];
  } else if (bay) {
    const from = sourceTile(w, bay, t);
    dx = m.xOf(from) + 0.5 - t.x;
    dy = m.yOf(from) + 0.5 - t.y;
  }
  // The crates come from its left: its right is the far side.
  t.far = dx * lx + dy * ly > 0 ? 1 : 0;
  return t.far;
}

/** The tile of the bay or storage the crates come to a truck from: nearest it. */
function sourceTile(w: World, bay: Bay, t: Truck): number {
  if (!bay.tiles) return bay.idx;
  const m = w.map;
  const at = w.tileOf(t);
  return [...bay.tiles].sort(
    (a, b) =>
      Math.hypot(m.xOf(a) - m.xOf(at), m.yOf(a) - m.yOf(at)) -
      Math.hypot(m.xOf(b) - m.xOf(at), m.yOf(b) - m.yOf(at)),
  )[0];
}

/** A crate truck's bed: a cell for each place on it; see hold.ts. */
export function bedCells(t: Truck): Cells {
  return sized((t.load ??= []), slotsOf(t));
}

/** The slots of the crates on a truck's bed, in the order they went on. */
export function bedSlots(_w: World, t: Truck): number[] {
  const cells = t.load ?? [];
  return filled(cells).sort((x, y) => cells[x]!.at - cells[y]!.at || x - y);
}

/** The crates on a truck's bed, in the order they went on. */
export function onBoard(w: World, t: Truck): Crate[] {
  const cells = t.load ?? [];
  return bedSlots(w, t).map((s) => cells[s]!);
}

/** The fees of the crates on a truck's bed, in the order they went on. */
export function feesOn(w: World, t: Truck): number[] {
  return onBoard(w, t).map((c) => c.fee);
}

/** The slots kept on a truck for loads on their way to it, but `except`'s. */
function keptOn(w: World, t: Truck, except?: Dockhand): Set<number> {
  const out = new Set<number>();
  for (const q of w.people) {
    if (q === except || q.truckId !== t.id || !q.truckLoad) continue;
    for (const s of q.bedAt ?? []) out.add(s);
  }
  return out;
}

/** The bottom layer's slots in the order dockhands fill them: the far side first, from the cab back. */
function handOrder(w: World, t: Truck): number[] {
  const far = farSide(w, t);
  const cols = Math.ceil(t.capacity / 2);
  const out: number[] = [];
  for (const side of [far, 1 - far]) {
    for (let c = 0; c < cols; c++) if (c * 2 + side < t.capacity) out.push(c * 2 + side);
  }
  return out;
}

/** Where `n` crates a dockhand lifts onto a truck go: the next free on its bottom layer. */
function handSlots(w: World, t: Truck, n: number, taken: Set<number>): number[] {
  return handOrder(w, t)
    .filter((s) => !taken.has(s))
    .slice(0, n);
}

/**
 * Where a forklift's load of up to `n` goes on a truck: two crates along
 * one side, one or two high, the far side first, the bottom first, from
 * the cab back; only on the bare bed or on a whole layer under it all,
 * never on a crate missing from under it. As many of the `n` as fit in
 * the best such place; none if there is none.
 */
function forkSlots(w: World, t: Truck, n: number, used: Set<number>, kept: Set<number>): number[] {
  const far = farSide(w, t);
  const per = t.capacity;
  const cols = Math.ceil(per / 2);
  const layers = bedLayers(t);
  const at = (layer: number, c: number, side: number) =>
    c < cols && c * 2 + side < per && layer < layers ? layer * per + c * 2 + side : -1;
  let best: number[] = [];
  for (const side of [far, 1 - far]) {
    for (let layer = 0; layer < layers; layer++) {
      for (let c = 0; c < cols; c++) {
        // Two along, or one in the last column.
        const along = [c, c + 1].filter((k) => at(layer, k, side) >= 0);
        // Level under it: the bare bed, or every crate under where it goes there.
        if (layer > 0 && !along.every((k) => used.has(at(layer - 1, k, side)))) continue;
        const slots: number[] = [];
        for (let up = layer; up < layers && slots.length < n; up++) {
          const row = along.map((k) => at(up, k, side));
          if (row.some((s) => s < 0 || used.has(s) || kept.has(s))) break;
          for (const s of row) if (slots.length < n) slots.push(s);
        }
        if (slots.length === 0) continue;
        if (slots.length >= n) return slots;
        if (slots.length > best.length) best = slots;
      }
    }
  }
  return best;
}

/**
 * Where a worker's load of `n` goes on a truck now, the slots kept for
 * others left out: a dockhand's on the bottom layer, a forklift's level,
 * as many as fit.
 */
export function slotsFor(w: World, t: Truck, p: Dockhand, n: number): number[] {
  if (n <= 0) return [];
  const used = usedIn(bedCells(t));
  const kept = keptOn(w, t, p);
  if (isMachine(p)) return t.pickup ? [] : forkSlots(w, t, n, used, kept);
  return handSlots(w, t, n, new Set([...used, ...kept]));
}

/** Room on a truck's bed for crates no one is bringing yet, for any who load it. */
export function bedRoom(w: World, t: Truck): number {
  const used = usedIn(bedCells(t));
  const kept = keptOn(w, t);
  const layers = bedLayers(t) > 1 && forkliftsAt(w) ? 2 : 1;
  let n = 0;
  for (let s = 0; s < t.capacity * layers; s++) if (!used.has(s) && !kept.has(s)) n++;
  return n;
}

/** Whether a truck's bottom layer is full, or kept for loads on their way: no more by hand. */
export function bottomFull(w: World, t: Truck): boolean {
  const used = new Set([...bedSlots(w, t), ...keptOn(w, t)]);
  for (let s = 0; s < t.capacity; s++) if (!used.has(s)) return false;
  return true;
}

/** Keep the slots a worker's load goes into on the truck it is loading, as it sets off with it. */
export function keepSlots(w: World, t: Truck, p: Dockhand, n: number): number[] {
  p.bedAt = slotsFor(w, t, p, n);
  return p.bedAt;
}

/**
 * Crates put on a truck by `p`, if given: into the slots kept for them
 * where those are free still, else where they would go now, else as by
 * hand. Its cargo and value go up by them.
 */
export function onBed(w: World, t: Truck, crates: Crate[], p?: Dockhand): void {
  const cells = bedCells(t);
  const used = usedIn(cells);
  let slots = p?.bedAt ?? [];
  if (p) p.bedAt = undefined;
  if (slots.length < crates.length || slots.some((s) => used.has(s) || s >= cells.length)) {
    slots = p ? slotsFor(w, t, p, crates.length) : [];
  }
  crates.forEach((c, k) => {
    let s = slots[k] ?? handOrder(w, t).find((q) => !used.has(q)) ?? -1;
    // With no place left, any; past the last if none.
    if (s < 0) s = cells.findIndex((c) => !c);
    if (s < 0) s = cells.length;
    while (cells.length <= s) cells.push(null);
    c.at = stamp(w.tick);
    put(cells, s, c);
    used.add(s);
  });
  t.cargo += crates.length;
  t.value += crates.reduce((n, c) => n + c.fee, 0);
}

/** What a crate truck's view shows in each place on its bed: each crate, with what it holds. */
export function bedView(t: Truck): CellsView {
  return (t.load ?? []).map((c) => c && { cargo: cargoOf(c.fee) });
}

/** A container put on a haulier's container truck, after any on it; its cargo and value go up by it. */
export function onTrailer(w: World, t: Truck, box: Crate): void {
  box.at = stamp(w.tick);
  (t.load ??= []).push(box);
  t.cargo++;
  t.value += box.fee;
}

/** How the containers on a haulier's container truck look, in load order. */
export function trailerLooks(t: Truck): number[] {
  const looks = (t.load ?? []).flatMap((c, k) =>
    c ? [(c.look ??= boxLookOf(t.id, 1000 + k))] : [],
  );
  // An older save's with no looks kept.
  while (looks.length < t.cargo) looks.push(boxLookOf(t.id, 1000 + looks.length));
  return looks.slice(0, t.cargo);
}

/**
 * The slots of a truck's crates in the order they come off: those on top,
 * then the rest, the last on first.
 */
export function topFirst(w: World, t: Truck): number[] {
  const cells = bedCells(t);
  const per = t.capacity;
  return bedSlots(w, t).sort(
    (a, b) => Math.floor(b / per) - Math.floor(a / per) || cells[b]!.at - cells[a]!.at || b - a,
  );
}

/**
 * Take the crates at `slots` off a truck's bed: any left on top of where
 * one came from settle into its place, as they would. Their fees; its
 * cargo and value go down by them.
 */
export function offBed(w: World, t: Truck, slots: number[]): number[] {
  const cells = bedCells(t);
  const fees = slots.map((s) => take(cells, s).fee);
  const per = t.capacity;
  cells.forEach((c, s) => {
    if (c && s >= per && !cells[s - per]) {
      cells[s - per] = c;
      cells[s] = null;
    }
  });
  t.cargo -= fees.length;
  t.value -= fees.reduce((n, f) => n + f, 0);
  void w;
  return fees;
}

/**
 * Ticks more than setting it down a worker takes to load a crate onto a
 * truck, and to come back from it: round to its far side, or out to a
 * pickup at the roadside. In a truck bay they lean over from behind its
 * stack.
 */
export function roundTicks(w: World, t: Truck, p: Dockhand, s = p.bedAt?.[0]): number {
  if (s === undefined || s < 0) return 0;
  const bay = dest(w, t.bayIdx);
  if (bay && !bay.tiles && !t.pickup && w.tileOf(t) === bay.idx) return 0;
  const way = (s % 2 === farSide(w, t) ? 1.2 : 0.4) + (t.pickup ? 0.6 : 0);
  return Math.ceil(way / (isMachine(p) ? B.FORKLIFT_SPEED : B.WALK_SPEED));
}
