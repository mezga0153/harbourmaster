// Cranes at the quay: jib cranes lifting crates, and harbour and gantry cranes
// lifting containers off the ships and exports on, their landing stacks, and
// the tractors they hand to.

import type { World } from '../world';
import { boatHalf, craneFront, mooredTiles, near } from './boats/berthing';
import type { Bay, Boat, Crane, Dockhand, JibLift } from '../state';
import * as B from '../balance';
import { aligned, boxLookOf, craneStack, craneStacks, craneTicks, deckPlace } from '../helpers';
import type { CraneView } from '../../protocol/views';
import { besideStack } from './yardGantry';
import { exportTaken, nextSlots, waitsIn } from './cargo/places';
import { loadShip, wantsLoad } from './cargo/exports';
import { carriedLooks, jibStore, outLooks, readyList, stackLooks } from './cargo/stores';
import { startHolds } from './cargo/customs';

export function addCrane(w: World, i: number, kind: Crane['kind']): void {
  w.cranes.set(i, { idx: i, kind, stack: [], reserved: 0, timer: 0, angle: 0, busy: false });
}

/**
 * Lift cargo off a boat moored beside the crane: a container crane onto
 * its landing stack or a tractor under it, a jib crane only ever into crate
 * storage for cargo coming in within its reach, never down at its feet.
 * With none in reach, or all of it full, a jib crane unloads nothing.
 */
export function updateCrane(w: World, c: Crane): void {
  c.busy = false;
  w.jibJobs.delete(c);
  // A tractor waiting under it for a container there is none of goes: no
  // ship to unload, or one it has not lifted from in a good while.
  if (c.kind !== 'jib' && c.stack.length === 0) {
    for (const p of w.people) {
      if (p.state !== 'picking' || underGantry(w, p) !== c || p.timer <= 1 || p.handed) {
        continue;
      }
      const waited = B.TRACTOR_WAIT_TICKS - p.timer;
      if (!unloadingAt(w, c) || waited > B.TRACTOR_GIVE_UP) p.timer = 1;
    }
  }
  if (serveTractor(w, c)) return;
  const boxes = c.kind !== 'jib';
  const store = boxes ? undefined : jibStore(w, c);
  if (boxes ? stackFull(w, c) : !store) return loadShip(w, c);
  const m = w.map;
  const reaches = (b: Boat) => craneReaches(w, c, b);
  const boat = w.boats.find(
    (b) =>
      b.state === 'moored' &&
      (b.vessel === 'feeder') === boxes &&
      b.crates - b.reserved > 0 &&
      reaches(b),
  );
  if (!boat) return loadShip(w, c);
  // A container crane lifts them a tier at a time, from the top down, so
  // the ship stays even, in its own share of it when others work it too.
  if (boxes && !liftingFrom(w, c, boat)) {
    c.liftBoat = boat.id;
    c.liftSlot = deckSlot(w, c, boat, false);
    if (c.liftSlot < 0) return;
    // Straight onto a tractor already waiting for one as it starts, or
    // one called to it pulling in by the time it has it over the bay.
    c.handTo = (directTo(w, c) ?? pullingIn(w, c))?.id;
  }
  c.busy = true;
  // One pulling in under it part way through the lift gets it, if the
  // one it lifted it for has not come.
  if (boxes && !handingTo(w, c)) c.handTo = directTo(w, c)?.id ?? c.handTo;
  if (!boxes) w.jibJobs.set(c, { boat, load: false, store });
  c.angle = Math.atan2(boat.y - (m.yOf(c.idx) + 0.5), boat.x - (m.xOf(c.idx) + 0.5));
  if (++c.timer < craneTicks(c)) return;
  c.timer = 0;
  boat.crates--;
  if (store) {
    store.crates.push(boat.fee);
    startHolds(w, store, [boat.fee], false);
    w.stats.cratesHandled++;
    return;
  }
  // Out of the slot on its deck the ship drew it in: onto a tractor
  // waiting under a gantry crane for one, or else its stack.
  const slot = c.liftSlot ?? boat.crates + (boat.lifted?.length ?? 0);
  const look = boxLookOf(boat.id, slot);
  (boat.lifted ??= []).push(slot);
  c.liftSlot = undefined;
  // Onto the one it had it for, or any other there for one now.
  const tractor = handingTo(w, c) ?? directTo(w, c);
  if (tractor) {
    tractor.handed = { fees: [boat.fee], looks: [look], from: [boat.id] };
    tractor.timer = 1;
  } else {
    stackLooks(w, c).push(look);
    c.stack.push(boat.fee);
    (c.stackFrom ??= []).push(boat.id);
  }
  if (boat.crates === 0) {
    boat.lifted = [];
    shipUnloaded(w, boat);
  }
}

/** Which container on a crane's stack a machine picking at it takes: the one it chose, or the top. */
export function takingAt(w: World, p: Dockhand, c: Crane): number {
  const i = p.takeAt === undefined ? -1 : cranePlaces(w, c).stack.indexOf(p.takeAt);
  return i >= 0 ? i : craneTop(w, c, false);
}

/**
 * A terminal tractor called to container crane `c`, empty and on its way
 * there, that will pull in under it by the time it has a container off
 * the ship over the bay: the nearest such. It does not wait for it,
 * though: a ship kept longer at its berth waits longer for customs.
 */
export function pullingIn(w: World, c: Crane): Dockhand | undefined {
  const soon = craneTicks(c) * B.CRANE_LIFT_SET;
  let best: Dockhand | undefined;
  let bestD = Infinity;
  for (const p of w.people) {
    if (p.kind !== 'tractor' || p.state !== 'toPickup' || p.craneIdx !== c.idx) continue;
    if (p.carrying > 0 || p.handed) continue;
    const d = w.dist(w.tileOf(p), p.goal);
    if ((d * 1.25) / B.TRACTOR_SPEED > soon || d >= bestD) continue;
    best = p;
    bestD = d;
  }
  return best;
}

/** The tractor a crane is lifting one off the ship straight onto, if it is still waiting. */
export function handingTo(w: World, c: Crane): Dockhand | undefined {
  const p = c.handTo === undefined ? undefined : w.people.find((q) => q.id === c.handTo);
  const waiting = p && p.state === 'picking' && underGantry(w, p) === c && p.timer > 1;
  return waiting && !p.handed ? p : undefined;
}

/**
 * Containers still to come off a ship at container crane `c`, its share
 * where other cranes work the ship too, and in how many ticks it starts
 * on them: at once for a ship moored under it, about when it will be
 * alongside for one coming in to its berth. Null with neither.
 */
export function shipFor(w: World, c: Crane): { left: number; start: number } | null {
  if (c.kind === 'jib') return null;
  let best: { left: number; start: number } | null = null;
  for (const b of w.boats) {
    if (b.vessel !== 'feeder' || b.crates <= 0) continue;
    if (b.state !== 'moored' && b.state !== 'arriving') continue;
    if (!craneReaches(w, c, b)) continue;
    let cranes = 0;
    for (const k of w.cranes.values()) if (k.kind !== 'jib' && craneReaches(w, k, b)) cranes++;
    const left = Math.ceil(b.crates / Math.max(1, cranes));
    const start = b.state === 'moored' ? 0 : alongsideIn(w, b);
    if (!best || start < best.start) best = { left, start };
  }
  return best;
}

/** About how many ticks a ship coming in to its berth has before it is alongside, moored. */
export function alongsideIn(w: World, b: Boat): number {
  const m = w.map;
  const d = Math.hypot(m.xOf(b.berth) + 0.5 - b.x, m.yOf(b.berth) + 0.5 - b.y);
  return d / (B.VESSELS[b.vessel].speed * 0.6) + B.ALONGSIDE_TICKS;
}

/**
 * Whether a terminal tractor should set off now for container crane `c`,
 * at `tile`: a container waits on its stack for it, or one will come off
 * a ship for it about as it gets there, a little before rather than
 * after, so the crane sets it straight on. Sent no sooner, so tractors
 * come one after another as fast as the crane can serve them, one
 * pulling in under it as the last pulls out, rather than all at once to
 * queue in each other's way.
 */
export function dueAt(w: World, p: Dockhand, c: Crane, tile: number): boolean {
  // Its place among the tractors called to the crane: each served in turn.
  const coming = w.people.filter(
    (q) =>
      q !== p &&
      q.kind === 'tractor' &&
      q.craneIdx === c.idx &&
      (q.state === 'toPickup' || q.state === 'picking'),
  ).length;
  if (coming >= B.TRACTORS_CALLED) return false;
  const turn = Math.max(craneTicks(c), B.TRACTOR_TURN);
  let ready = coming * turn;
  // Past what waits on the stack, one still to come off a ship for it.
  const off = coming + 1 - c.stack.length;
  if (off > 0) {
    const ship = shipFor(w, c);
    if (!ship || off > ship.left) return false;
    ready = Math.max(ready, ship.start + (off - 1) * craneTicks(c));
  }
  if (ready <= 0) return true;
  // Its drive there: round the corners a little longer than straight.
  const drive = (w.dist(w.tileOf(p), tile) * 1.25) / B.TRACTOR_SPEED;
  return drive + B.TRACTOR_EARLY >= ready;
}

/** A gantry crane with a ship alongside still to unload. */
export function unloadingAt(w: World, c: Crane): boolean {
  if (c.kind === 'jib') return false;
  return w.boats.some(
    (b) => b.state === 'moored' && b.vessel === 'feeder' && b.crates > 0 && craneReaches(w, c, b),
  );
}

/** A terminal tractor waiting under a gantry crane for a container, for it to set one straight on. */
export function directTo(w: World, c: Crane): Dockhand | undefined {
  if (c.kind === 'jib') return undefined;
  return w.people.find(
    (p) => p.state === 'picking' && underGantry(w, p) === c && p.timer > 1 && !p.handed,
  );
}

/**
 * The places on a container crane's landing stack its containers and
 * exports are in, kept beside them: stacks side by side (see
 * craneStacks), four high on a gantry crane, two on a harbour crane. One
 * set down goes in the lowest free place with one of its own kind under
 * it, or on the ground: never an export on what came off a ship, nor the
 * other way, so neither is ever buried under the other.
 */
export function cranePlaces(w: World, c: Crane): { stack: number[]; out: number[] } {
  const stack = (c.places ??= []);
  const out = (c.outPlaces ??= []);
  if (stack.length > c.stack.length) stack.length = c.stack.length;
  if (out.length > (c.outStack?.length ?? 0)) out.length = c.outStack?.length ?? 0;
  const kinds = new Map<number, boolean>();
  for (const [list, isOut] of [
    [stack, false],
    [out, true],
  ] as const) {
    list.forEach((k, i) => {
      if (k < 0 || k >= craneStack(c) || kinds.has(k)) list[i] = -1;
      else kinds.set(k, isOut);
    });
  }
  for (const [list, n, isOut] of [
    [stack, c.stack.length, false],
    [out, c.outStack?.length ?? 0, true],
  ] as const) {
    for (let i = 0; i < n; i++) {
      if (i < list.length && list[i] >= 0) continue;
      // With no room of its own kind, anywhere free, rather than lose it.
      let k = freeCranePlace(w, c, kinds, isOut);
      if (k < 0) k = freeCranePlace(w, c, kinds, isOut, true);
      list[i] = k;
      if (k >= 0) kinds.set(k, isOut);
    }
  }
  return { stack, out };
}

/**
 * The lowest free place on a container crane's stack for an export
 * (`out`) or one off a ship: on one of the same kind, or else on the
 * ground; with `any`, on whatever is there. -1 if none.
 */
export function freeCranePlace(
  _w: World,
  c: Crane,
  kinds: Map<number, boolean>,
  out: boolean,
  any = false,
): number {
  const n = craneStacks(c);
  // On one of its own kind first, keeping stacks free for the other.
  for (let k = n; k < craneStack(c); k++) {
    const under = kinds.get(k - n);
    if (!kinds.has(k) && under !== undefined && (any || under === out)) return k;
  }
  for (let k = 0; k < n; k++) if (!kinds.has(k)) return k;
  return -1;
}

/** The places on a container crane's stack, with whether an export is in each. */
export function craneKinds(w: World, c: Crane): Map<number, boolean> {
  const { stack, out } = cranePlaces(w, c);
  const kinds = new Map<number, boolean>();
  for (const k of stack) if (k >= 0) kinds.set(k, false);
  for (const k of out) if (k >= 0) kinds.set(k, true);
  return kinds;
}

/** Where the next container set down on a crane's stack goes: an export, with `out`. */
export function nextCranePlace(w: World, c: Crane, out = false): number {
  return freeCranePlace(w, c, craneKinds(w, c), out);
}

/**
 * How many more of a kind (exports with `out`) a container crane's stack
 * has room for, in places of their own: on their own stacks, and on the
 * ground of empty ones, less those `keep` empty stacks are held for.
 */
export function craneRoom(w: World, c: Crane, out: boolean, keep = 0): number {
  const n = craneStacks(c);
  const high = craneStack(c) / n;
  const kinds = craneKinds(w, c);
  let room = 0;
  let empty = 0;
  for (let col = 0; col < n; col++) {
    const bottom = kinds.get(col);
    if (bottom === undefined) {
      empty++;
      continue;
    }
    if (bottom !== out) continue;
    let h = 0;
    while (h < high && kinds.has(col + h * n)) h++;
    room += high - h;
  }
  return room + Math.max(0, empty - keep) * high;
}

/**
 * The container (with `out`, the export) on a crane's stack with none on
 * it, highest first, to take next, at the stack a stacker `by` stands at
 * if one there will do; -1 if none. A jib crane's come off in turn.
 */
export function craneTop(w: World, c: Crane, out: boolean, by?: Dockhand): number {
  if (c.kind === 'jib') return (out ? (c.outStack?.length ?? 0) : c.stack.length) > 0 ? 0 : -1;
  const places = cranePlaces(w, c);
  const used = new Set([...places.stack, ...places.out]);
  // A stacker standing along a gantry crane takes one from the stack it is at.
  const at = by?.kind === 'stacker' && c.kind === 'gantry' ? w.tileOf(by) : -1;
  const near = (k: number) => at < 0 || besideStack(w, c, k) === at;
  const anyNear = (out ? places.out : places.stack).some(
    (k) => near(k) && !used.has(k + craneStacks(c)),
  );
  let best = -1;
  let high = -1;
  (out ? places.out : places.stack).forEach((k, i) => {
    if (used.has(k + craneStacks(c))) return;
    if (anyNear && !near(k)) return;
    if (k > high) {
      best = i;
      high = k;
    }
  });
  return best;
}

/**
 * What a container crane is lifting, for the view: off a ship's deck or
 * onto it, which slot, how it looks and how far through the lift it is;
 * for a jib crane, see jibWork.
 */
export function craneWork(w: World, c: Crane, jibs: Map<Crane, JibLift>): Partial<CraneView> {
  if (c.kind === 'jib') return jibWork(w, c, jibs.get(c));
  const serve = c.serving;
  const p = serve && w.people.find((q) => q.id === serve.id);
  // Taken off a tractor already gone on, it still has it.
  const on = !!p || !!serve?.held;
  if (serve && on && serve.ship !== undefined && c.liftSlot !== undefined) {
    // Off the tractor straight on board.
    return {
      working: 'load',
      workBoat: serve.ship,
      workSlot: c.liftSlot,
      workTruck: serve.id,
      workLook: servedLooks(w, c, p)[0],
      workPhase: c.timer / craneTicks(c),
    };
  }
  if (serve && on) {
    const top = p && serve.give ? Math.max(0, takingAt(w, p, c)) : 0;
    return {
      working: serve.give ? 'give' : 'take',
      workTruck: serve.id,
      workLook: serve.give ? stackLooks(w, c)[top] : servedLooks(w, c, p)[0],
      workPhase: c.timer / craneTicks(c),
      workPlace: serve.give ? cranePlaces(w, c).stack[top] : nextCranePlace(w, c, true),
    };
  }
  const k = c.liftSlot;
  if (!c.busy || k === undefined || k < 0) return {};
  const b = w.boats.find((q) => q.id === c.liftBoat);
  if (!b) return {};
  const unload = liftingFrom(w, c, b);
  const top = craneTop(w, c, true);
  // Straight onto a tractor waiting under it, or onto its stack.
  const tractor = unload ? handingTo(w, c) : undefined;
  return {
    working: unload ? 'unload' : 'load',
    workBoat: b.id,
    workSlot: k,
    workLook: unload ? boxLookOf(b.id, k) : outLooks(w, c)[Math.max(0, top)],
    workPhase: c.timer / craneTicks(c),
    workTruck: tractor?.id,
    workPlace: unload ? nextCranePlace(w, c) : cranePlaces(w, c).out[Math.max(0, top)],
  };
}

/**
 * What a jib crane is lifting, for the view: off a boat or on board it,
 * the slot on its deck, where at the other end the crate goes or comes
 * from, and how far through the lift it is; and whether its landing stack
 * is of pallets, counting one being set down on it.
 */
export function jibWork(_w: World, c: Crane, lift: JibLift | undefined): Partial<CraneView> {
  const toStack = !!lift && !lift.load && !lift.store;
  const pallets = c.stack.length > 0 ? !!c.pallets : toStack && lift!.pallet;
  if (!lift) return { pallets };
  return {
    working: lift.load ? 'load' : 'unload',
    workBoat: lift.boat.id,
    workSlot: lift.slot,
    workPhase: lift.phase,
    workStore: lift.store?.idx,
    workPile: lift.pile?.idx,
    workPlace: lift.place,
    workPallet: lift.pallet,
    pallets,
  };
}

/**
 * The crates jib cranes are part way through lifting, by crane: which
 * slot on the boat's deck (the top one unloading, the next free loading)
 * and which place in storage, on the quay or on its landing stack (the
 * next free one, or the last taking an export), each crane at the same
 * boat or store its own.
 */
export function jibLifts(w: World): Map<Crane, JibLift> {
  const lifts = new Map<Crane, JibLift>();
  const ahead = new Map<object, number>();
  const nth = (key: object) => {
    const n = ahead.get(key) ?? 0;
    ahead.set(key, n + 1);
    return n;
  };
  for (const c of w.cranes.values()) {
    const job = c.kind === 'jib' && c.busy ? w.jibJobs.get(c) : undefined;
    if (!job) continue;
    const { boat: b, load, store, pile } = job;
    const aboard = b.crates + (b.out ?? 0);
    const slot = load ? aboard + nth(b) : aboard - 1 - nth(b);
    const there = store
      ? store.crates.length + (store.exports?.length ?? 0)
      : pile
        ? pile.crates.length
        : c.stack.length;
    const key = store ?? pile ?? c;
    const k = load ? there - 1 - nth(key) : there + nth(key);
    if (slot < 0 || k < 0) continue;
    // In crate storage, the slot it is set down in or taken from.
    const n = k - there;
    const place = !store
      ? k
      : load
        ? exportTaken(w, store, there - 1 - k)
        : nextSlots(w, store, n + 1, waitsIn(store, false, [b.fee]))[n];
    const pallet = load ? !!pile?.pallets : b.vessel === 'coaster';
    lifts.set(c, { ...job, slot, place, phase: c.timer / craneTicks(c), pallet });
  }
  return lifts;
}

/**
 * Crates jib cranes have set down at `where` (a boat, a store or a
 * crane's landing stack) and taken from it, that the counts do not have
 * yet: the sim moves each at the end of the lift, the view as the hook
 * takes it and sets it down.
 */
export function jibMoved(
  _w: World,
  lifts: Map<Crane, JibLift>,
  where: object,
): { set: number; taken: number } {
  let set = 0;
  let taken = 0;
  for (const [c, l] of lifts) {
    const [from, to] = l.load ? [l.store ?? l.pile, l.boat] : [l.boat, l.store ?? c];
    if (from === where && l.phase >= B.CRANE_LIFT_TAKEN) taken++;
    if (to === where && l.phase >= B.CRANE_LIFT_SET) set++;
  }
  return { set, taken };
}

/**
 * The containers on a feeder's deck, for the view: by slot, with how each
 * looks. Its line's, less those lifted off, then the exports taken on; one
 * a crane is lifting leaves the deck as its spreader takes it, and an
 * export goes on as it is set down.
 */
export function deckView(w: World, b: Boat): { load: number; looks: number[]; deck: number[] } {
  const deck: number[] = [];
  const looks: number[] = [];
  const gone = new Set(b.lifted ?? []);
  const lifting = [...w.cranes.values()].filter(
    (c) => c.kind !== 'jib' && c.busy && c.liftBoat === b.id && c.liftSlot !== undefined,
  );
  for (const c of lifting) {
    const late = c.timer / craneTicks(c);
    if (liftingFrom(w, c, b) && late >= B.CRANE_LIFT_TAKEN) gone.add(c.liftSlot!);
  }
  for (let k = 0; k < b.crates + (b.lifted?.length ?? 0); k++) {
    if (gone.has(k)) continue;
    deck.push(k);
    looks.push(boxLookOf(b.id, k));
  }
  b.outLooks = aligned(Array(b.out ?? 0).fill(0), b.outLooks, b.id);
  deck.push(...outSlots(w, b).slice(0, b.out ?? 0));
  looks.push(...b.outLooks);
  for (const c of lifting) {
    const late = c.timer / craneTicks(c);
    const tractor =
      c.serving?.ship === b.id ? w.people.find((q) => q.id === c.serving!.id) : undefined;
    if ((tractor || c.serving?.held) && c.serving?.ship === b.id && late >= B.CRANE_LIFT_SET) {
      deck.push(c.liftSlot!);
      looks.push(servedLooks(w, c, tractor)[0]);
    } else if (!liftingFrom(w, c, b) && late >= B.CRANE_LIFT_SET && c.outStack?.length) {
      deck.push(c.liftSlot!);
      looks.push(outLooks(w, c)[Math.max(0, craneTop(w, c, true))]);
    }
  }
  return { load: deck.length, looks, deck };
}

/**
 * A crane's landing stack has no room for another off the ship: a
 * container crane's holds what it lifts off and exports set down for it,
 * or on their way to it, together, in the same places.
 */
export function stackFull(w: World, c: Crane): boolean {
  if (c.kind === 'jib') return c.stack.length >= craneStack(c);
  // Exports on their way need stacks of their own to go on.
  const coming = Math.max(0, (c.outReserved ?? 0) - craneRoom(w, c, true, Infinity));
  const keep = Math.ceil(coming / (craneStack(c) / craneStacks(c)));
  return craneRoom(w, c, false, keep) <= 0;
}

/**
 * Room on a container crane's stack for more exports: up to half of it,
 * so there is always room to unload a ship before loading it.
 */
export function exportRoom(w: World, c: Crane): number {
  const out = (c.outStack?.length ?? 0) + (c.outReserved ?? 0);
  return Math.min(craneStack(c) / 2 - out, craneRoom(w, c, true) - (c.outReserved ?? 0));
}

/** The gantry crane a terminal tractor is under, to have a container lifted on or off, or undefined. */
export function underGantry(w: World, p: Dockhand): Crane | undefined {
  if (p.kind !== 'tractor') return undefined;
  const at = p.state === 'picking' ? p.craneIdx : p.state === 'dropping' ? (p.toCrane ?? -1) : -1;
  const c = w.cranes.get(at);
  return c && c.kind !== 'jib' ? c : undefined;
}

/**
 * A gantry crane lifts a container off its stack onto a terminal tractor
 * waiting under it, or an export off one onto its stack, before it goes
 * on with the ship: between lifts, one at a time. True while it is at it.
 */
export function serveTractor(w: World, c: Crane): boolean {
  if (c.kind === 'jib') return false;
  const waiting = (p: Dockhand) => underGantry(w, p) === c && p.timer > 1;
  let p = c.serving && w.people.find((q) => q.id === c.serving!.id);
  // One taken off a tractor already gone on: it sees that lift through.
  if (c.serving?.held) p = undefined;
  else if (!p || !waiting(p)) {
    c.serving = undefined;
    // Only between lifts: never part way through one off the ship or on
    // board it. One left part way, its ship gone, counts for nothing.
    const ship = w.boats.find((b) => b.id === c.liftBoat && b.state === 'moored');
    if (c.timer > 0 && c.liftSlot !== undefined && ship) return false;
    c.timer = 0;
    // A ship alongside to unload sets one straight on a tractor; from
    // its stack while there is none, or its stack is too full to go on
    // unloading, or the tractor has waited a good while.
    const fromStack = (q: Dockhand) =>
      c.stack.length > 0 &&
      (!unloadingAt(w, c) || stackFull(w, c) || B.TRACTOR_WAIT_TICKS - q.timer > B.TRACTOR_GIVE_UP);
    p = w.people.find((q) => waiting(q) && !q.handed && (q.state === 'dropping' || fromStack(q)));
    if (!p) return false;
    c.serving = { id: p.id, give: p.state === 'picking' };
    // An export off a tractor goes straight on board a ship it is loading.
    const loading =
      p.state === 'dropping' &&
      w.boats.find((b) => b.vessel === 'feeder' && wantsLoad(w, b) && craneReaches(w, c, b));
    const slot = loading ? deckSlot(w, c, loading, true) : -1;
    if (loading && slot >= 0) {
      c.serving.ship = loading.id;
      c.liftBoat = loading.id;
      c.liftSlot = slot;
    }
    // The one off the top it lifts onto it.
    if (p.state === 'picking') {
      const top = craneTop(w, c, false);
      p.takeAt = top >= 0 ? cranePlaces(w, c).stack[top] : undefined;
    }
  }
  c.busy = true;
  ++c.timer;
  // An export off a tractor: once the spreader has it, the tractor is
  // free to go on its way, and the crane carries it on by itself.
  const serving = c.serving!;
  if (p && !serving.give && !serving.held && c.timer >= craneTakenIn(w, c)) {
    serving.held = { fees: p.cargoFees, looks: carriedLooks(w, p), planned: p.planned };
    p.carrying = 0;
    p.cargoFees = [];
    p.cargoLooks = undefined;
    p.planned = 0;
    p.toBoat = -1;
    p.toCrane = -1;
    p.outbound = false;
    p.state = 'idle';
    p = undefined;
  }
  if (c.timer < craneTicks(c)) return true;
  c.timer = 0;
  c.serving = undefined;
  const on = w.boats.find((b) => b.id === serving.ship && b.state === 'moored');
  const held = serving.held;
  if (held) {
    c.outReserved = Math.max(0, (c.outReserved ?? 0) - held.planned);
    if (on && c.liftSlot !== undefined && c.liftSlot >= 0) {
      // Set down on board the ship it is loading.
      (on.outLooks ??= []).push(...held.looks);
      outSlots(w, on).push(c.liftSlot);
      w.shipOut(on, held.fees);
      c.liftSlot = undefined;
    } else {
      outLooks(w, c).push(...held.looks);
      (c.outStack ??= []).push(...held.fees);
    }
    return true;
  }
  if (!p) return true;
  if (on && c.liftSlot !== undefined && c.liftSlot >= 0) {
    onBoardFrom(w, c, p, on, c.liftSlot);
    c.liftSlot = undefined;
    return true;
  }
  // Done: the tractor has it, or the stack has, as it finishes.
  p.timer = 1;
  return true;
}

/** Ticks into a container crane's lift until its spreader has the container up. */
export function craneTakenIn(_w: World, c: Crane): number {
  // Not before the view has it taken.
  return Math.ceil(B.CRANE_LIFT_TAKEN * craneTicks(c));
}

/** How the containers a crane is lifting for a tractor look: on its spreader, or still on the tractor. */
export function servedLooks(w: World, c: Crane, p: Dockhand | undefined): number[] {
  return c.serving?.held?.looks ?? (p ? carriedLooks(w, p) : []);
}

/** A crane has lifted a tractor's export straight on board a ship, into deck slot `slot`. */
export function onBoardFrom(w: World, c: Crane, p: Dockhand, ship: Boat, slot: number): void {
  c.outReserved = Math.max(0, (c.outReserved ?? 0) - p.planned);
  (ship.outLooks ??= []).push(...carriedLooks(w, p));
  outSlots(w, ship).push(slot);
  w.shipOut(ship, p.cargoFees);
  p.carrying = 0;
  p.cargoFees = [];
  p.cargoLooks = undefined;
  p.planned = 0;
  p.toBoat = -1;
  p.toCrane = -1;
  p.outbound = false;
  p.state = 'idle';
}

/**
 * A crane's landing stack and exports for the view: as a gantry crane
 * lifting one onto a tractor or off one has it, off the stack once its
 * spreader has it, or on once set down.
 */
export function servedStack(
  w: World,
  c: Crane,
  set: number,
): { stack: number; out: number; looks?: number[]; places?: number[] } {
  const stack = c.stack.length + set;
  const out = c.outStack?.length ?? 0;
  if (c.kind === 'jib') return { stack, out };
  const looks = [...stackLooks(w, c), ...outLooks(w, c)];
  const gantry = true;
  const at = cranePlaces(w, c);
  const places = at && [...at.stack, ...at.out];
  const less = (i: number) => {
    looks.splice(i, 1);
    places?.splice(i, 1);
  };
  const serve = c.serving;
  const p = serve && w.people.find((q) => q.id === serve.id);
  const phase = c.timer / craneTicks(c);
  if (serve?.give && p && phase >= B.CRANE_LIFT_TAKEN && stack > 0) {
    less(Math.max(0, takingAt(w, p, c)));
    return { stack: stack - 1, out, looks, places };
  }
  if (
    serve &&
    !serve.give &&
    serve.ship === undefined &&
    (p || serve.held) &&
    phase >= B.CRANE_LIFT_SET
  ) {
    places?.push(nextCranePlace(w, c, true));
    return { stack, out: out + 1, looks: [...looks, ...servedLooks(w, c, p)], places };
  }
  // A gantry crane putting an export on board: off the stack once its
  // spreader has it (the ship shows it once it is set down; see deckView).
  const ship = w.boats.find((b) => b.id === c.liftBoat);
  const loading = gantry && c.busy && !serve && ship && !liftingFrom(w, c, ship);
  if (loading && c.liftSlot !== undefined && phase >= B.CRANE_LIFT_TAKEN && out > 0) {
    less(stack + Math.max(0, craneTop(w, c, true)));
    return { stack, out: out - 1, looks, places };
  }
  return { stack, out, looks, places };
}

/**
 * A tractor's load for the view while a gantry crane lifts onto it or off
 * it: on once set down, off once the spreader has it.
 */
export function servedLoad(
  w: World,
  p: Dockhand,
  view: { load: number; looks?: number[] },
): { load: number; looks?: number[] } {
  if (p.handed) return { load: p.handed.fees.length, looks: [...p.handed.looks] };
  const c = underGantry(w, p);
  if (!c) return view;
  const phase = c.timer / craneTicks(c);
  // Set straight on it off the ship.
  const ship = w.boats.find((b) => b.id === c.liftBoat);
  if (
    !c.serving &&
    handingTo(w, c) === p &&
    ship &&
    c.liftSlot !== undefined &&
    liftingFrom(w, c, ship) &&
    phase >= B.CRANE_LIFT_SET
  ) {
    return { load: 1, looks: [boxLookOf(ship.id, c.liftSlot)] };
  }
  const serve = c.serving;
  if (!serve || serve.id !== p.id) return view;
  if (serve.give && phase >= B.CRANE_LIFT_SET) {
    const top = Math.max(0, takingAt(w, p, c));
    return { load: view.load + 1, looks: [...(view.looks ?? []), stackLooks(w, c)[top]] };
  }
  if (!serve.give && phase >= B.CRANE_LIFT_TAKEN) return { load: 0, looks: [] };
  return view;
}

/** Whether a container crane is part way through a lift from this ship's deck. */
export function liftingFrom(_w: World, c: Crane, b: Boat): boolean {
  const k = c.liftSlot;
  if (c.liftBoat !== b.id || k === undefined || k < 0) return false;
  return k < b.crates + (b.lifted?.length ?? 0) && !(b.lifted ?? []).includes(k);
}

/** The container cranes working a ship, from its stern to its bow. */
export function shipCranes(w: World, b: Boat): Crane[] {
  const m = w.map;
  const ax = Math.cos(b.dir);
  const ay = Math.sin(b.dir);
  const along = (c: Crane) => {
    const front = craneFront(w, c);
    const x = front.reduce((n, t) => n + m.xOf(t) + 0.5, 0) / front.length;
    const y = front.reduce((n, t) => n + m.yOf(t) + 0.5, 0) / front.length;
    return (x - b.x) * ax + (y - b.y) * ay;
  };
  return [...w.cranes.values()]
    .filter((c) => c.kind !== 'jib' && craneReaches(w, c, b))
    .sort((p, q) => along(p) - along(q) || p.idx - q.idx);
}

/** The bays of a ship that are a crane's to work, from..to, shared out with the others on it. */
export function craneBays(w: World, c: Crane, b: Boat): [number, number] {
  const all = shipCranes(w, b);
  const j = Math.max(0, all.indexOf(c));
  const n = Math.max(1, all.length);
  return [Math.floor((B.FEEDER_BAYS * j) / n), Math.floor((B.FEEDER_BAYS * (j + 1)) / n)];
}

/**
 * The deck slot a container crane lifts from next, or with `load` sets an
 * export into: a tier at a time across the whole ship, to keep it even,
 * from the top down unloading and the bottom up loading; in its own bays
 * while there is work in that tier there; -1 if none is left that another
 * crane is not already at.
 */
export function deckSlot(w: World, c: Crane, b: Boat, load: boolean): number {
  const taken = new Set<number>();
  for (const q of w.cranes.values()) {
    if (q !== c && q.busy && q.liftBoat === b.id && q.liftSlot !== undefined) {
      taken.add(q.liftSlot);
    }
  }
  const used = new Set(load ? outSlots(w, b) : (b.lifted ?? []));
  const total = load
    ? B.FEEDER_BAYS * B.FEEDER_ROWS * B.FEEDER_TIERS
    : b.crates + (b.lifted?.length ?? 0);
  const [lo, hi] = craneBays(w, c, b);
  const off = (bay: number) => (bay < lo ? lo - bay : bay >= hi ? bay - hi + 1 : 0);
  let best = -1;
  let bestKey: number[] = [];
  for (let k = 0; k < total; k++) {
    if (used.has(k) || taken.has(k)) continue;
    const p = deckPlace(k);
    const key = [load ? p.tier : -p.tier, off(p.bay), p.bay, p.row];
    const at = key.findIndex((v, i) => v !== bestKey[i]);
    if (best < 0 || (at >= 0 && key[at] < bestKey[at])) {
      best = k;
      bestKey = key;
    }
  }
  return best;
}

/** The deck slot each export on board a feeder is in, filling the lowest free for older saves. */
export function outSlots(_w: World, b: Boat): number[] {
  const slots = (b.outSlots ??= []);
  for (let k = 0; slots.length < (b.out ?? 0); k++) if (!slots.includes(k)) slots.push(k);
  return slots;
}

/**
 * A container ship has been unloaded: customs start on all its containers
 * now, those already in a yard and those still on their way there.
 */
export function shipUnloaded(w: World, b: Boat): void {
  if (w.unloadedAt.has(b.id)) return;
  w.unloadedAt.set(b.id, w.tick);
  for (const y of w.yards.values()) {
    const ready = readyList(w, y);
    for (let k = 0; k < ready.length; k++) {
      if (ready[k] === -b.id) ready[k] = w.tick + B.CUSTOMS_TICKS;
    }
  }
}

/** When customs clear a container stacked now that came off ship `from`; see boxReady. */
export function customsFor(w: World, from: number | undefined): number {
  if (from === undefined) return w.tick + B.CUSTOMS_TICKS;
  const done = w.unloadedAt.get(from);
  if (done !== undefined) return done + B.CUSTOMS_TICKS;
  return w.boats.some((b) => b.id === from) ? -from : w.tick + B.CUSTOMS_TICKS;
}

/**
 * Whether a crane can work a ship: container cranes anywhere along its
 * hull, so several can work one ship; a jib crane the boat lying under it.
 */
export function craneReaches(w: World, c: Crane, b: Boat): boolean {
  if (c.kind === 'jib') return near(w, b.berth, c.idx);
  const front = craneFront(w, c);
  return (mooredTiles(w, b.berth, b.jetty, boatHalf(w, true)) ?? [b.berth]).some((t) =>
    front.some((f) => near(w, f, t)),
  );
}

/**
 * Crate storage a jib crane can swing round to: right beside it, in the
 * machines-only ground round it, never further.
 */
export function jibStores(w: World, c: Crane): Bay[] {
  const m = w.map;
  const found: Bay[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = m.xOf(c.idx) + dx;
      const y = m.yOf(c.idx) + dy;
      if ((dx === 0 && dy === 0) || !m.inBounds(x, y)) continue;
      const a = w.bays.get(w.storeOf[m.idx(x, y)]);
      if (a && !found.includes(a)) found.push(a);
    }
  }
  return found;
}
