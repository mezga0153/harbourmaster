// Customs and export papers on crates, and the jobs that move them: what waits
// and what is cleared, and giving a job up.

import { bedCap } from './beds';
import type { World } from '../../world';
import type { Bay, Crate, Dockhand, Truck } from '../../state';
import { bayIncoming, bayRoom, boxesAt, isBoxy, needsCustoms } from '../../helpers';
import { nag } from '../output';
import type { BayView } from '../../../protocol/views';
import {
  bayWithRoom,
  carriedLooks,
  dropAt,
  jibTiles,
  nearestWithRoom,
  offJibRoom,
  outLooks,
  putBox,
  reachable,
  servesYard,
  stock,
  takesExports,
  tidyPile,
  yardWithRoom,
} from './stores';
import { exportTarget, loadSpot } from './exports';
import { headTo } from '../workforce/dockhands';
import { craneSpot } from '../yardGantry';
import { releaseTruckJob } from '../truckLoading';
import {
  cratesIn,
  loadFits,
  setDown,
  slotsOf,
  slotted,
  stackOf,
  takeAt,
  takeOrder,
} from './places';
import { feesOf, waits } from './hold';

/**
 * When each crate at a bay still waiting on customs, or (`out`) each of
 * its exports on export papers, clears, soonest first.
 */
export function holds(w: World, b: Bay, out: boolean): number[] {
  return cratesIn(b, out)
    .filter((c) => waits(c, w.tick))
    .map((c) => c.clears!)
    .sort((x, y) => x - y);
}

/**
 * Which of a bay's crates, or (`out`) its exports, still wait, oldest
 * first (see slotsOf); empty where none does.
 */
export function waitMask(w: World, b: Bay, out: boolean): boolean[] {
  const mask = cratesIn(b, out).map((c) => waits(c, w.tick));
  return mask.some((m) => m) ? mask : [];
}

/** Which of a bay's crates then its exports, in that order, still wait. */
export function heldMask(w: World, b: Bay): boolean[] {
  const mask = [...cratesIn(b, false), ...cratesIn(b, true)].map((c) => waits(c, w.tick));
  return mask.some((m) => m) ? mask : [];
}

/** Crates at a bay (or `out`, exports) free to go: none still waiting. */
export function readyIn(w: World, b: Bay, out: boolean): number {
  if (b.yard) return out ? boxesAt(b, true) : 0;
  return cratesIn(b, out).filter((c) => !waits(c, w.tick)).length;
}

/**
 * Up to `n` crates off a bay's crates, or (`out`) its exports, none of
 * them still waiting and all of them ones `fits` lets through: those from
 * `at` on (an index into them oldest first, see slotsOf) if they all may
 * go, else the first that may. In crate storage, only off the stacks in
 * `only` (by tile, see stackOf) if given.
 */
export function takeReady(
  w: World,
  b: Bay,
  out: boolean,
  at: number,
  n: number,
  fits: (fee: number) => boolean = () => true,
  only?: Set<number>,
): Crate[] {
  const slots = slotsOf(b, out);
  if (n <= 0 || slots.length === 0) return [];
  const crates = cratesIn(b, out);
  const inReach = (i: number) => !only || (slotted(b) && only.has(stackOf(b, slots[i])));
  const ok = (i: number) => !waits(crates[i], w.tick) && fits(crates[i].fee) && inReach(i);
  let pick: number[] = [];
  // In crate storage and at a truck bay each crate keeps its slot: only
  // ones with none on top, from the place `at` is in first.
  if (slotted(b)) pick = takeOrder(w, b, out, at, n, ok);
  else if (at >= 0 && at + n <= slots.length) {
    pick = Array.from({ length: n }, (_, k) => at + k);
    if (!pick.every(ok)) pick = [];
  }
  // Else the top ones that may go, so none is taken from under another
  // that need not be.
  if (pick.length === 0 && !slotted(b)) {
    for (let i = slots.length - 1; i >= 0 && pick.length < n; i--) if (ok(i)) pick.unshift(i);
  }
  return takeAt(b, out, pick);
}

/** Ticks until the next crate at a bay, or (`out`) export, clears; -1 if none waits. */
export function nextHold(w: World, b: Bay, out: boolean): number {
  const h = holds(w, b, out);
  return h.length > 0 ? h[0] - w.tick : -1;
}

/** What a crate storage's view says of the crates waiting in it on customs and papers. */
export function holdsView(w: World, b: Bay): Pick<BayView, 'waiting' | 'customs' | 'papers'> {
  const customs = holds(w, b, false).length;
  const papers = holds(w, b, true).length;
  if (customs + papers === 0) return {};
  return {
    waiting: heldMask(w, b),
    customs: customs > 0 ? { n: customs, next: nextHold(w, b, false) } : undefined,
    papers: papers > 0 ? { n: papers, next: nextHold(w, b, true) } : undefined,
  };
}

/**
 * Containers (or crates) at a bay or yard ready to go that no truck is
 * already coming for: room on the trucks heading there, parked for it or
 * loading at it is spoken for. Leaving `except` out of those.
 */
export function unclaimed(w: World, b: Bay, boxes: boolean, except?: Truck): number {
  const ready = boxes
    ? b.yard
      ? reachable(w, b) - (b.truckReserved ?? 0)
      : boxesAt(b)
    : readyIn(w, b, false);
  let claimed = 0;
  for (const t of w.trucks) {
    if (t === except || t.bayIdx !== b.idx || t.exports || t.boxes !== boxes) continue;
    if (
      t.state !== 'toPark' &&
      t.state !== 'parked' &&
      t.state !== 'toBay' &&
      t.state !== 'loading'
    ) {
      continue;
    }
    claimed += Math.max(0, bedCap(w, t) - t.cargo - (t.coming ?? 0));
  }
  return ready - claimed;
}

/** The truck bay, storage area or heap on the quay a load is going to. */
export function dest(w: World, idx: number): Bay | undefined {
  return w.bays.get(idx) ?? w.yards.get(idx) ?? w.piles.get(idx);
}

/** The worker holds crates but their bay is gone or unreachable. */
/** Where the worker is taking the load is still there to take it. */
export function dropValid(w: World, p: Dockhand): boolean {
  if (p.toBoat !== undefined && p.toBoat >= 0) {
    return w.boats.some((b) => b.id === p.toBoat && b.state === 'moored');
  }
  if (p.toCrane !== undefined && p.toCrane >= 0) return w.cranes.has(p.toCrane);
  return !!dest(w, p.bayIdx);
}

/** Give back room promised at a ship or crane for `n` exports not coming after all. */
export function releaseTarget(w: World, p: Dockhand, n: number): void {
  if (n <= 0) return;
  const store = p.outbound ? dest(w, p.bayIdx) : undefined;
  if (store?.tiles) store.exportIncoming = Math.max(0, (store.exportIncoming ?? 0) - n);
  const ship = w.boats.find((b) => b.id === p.toBoat);
  if (ship) ship.outIncoming = Math.max(0, (ship.outIncoming ?? 0) - n);
  const crane = p.toCrane !== undefined ? w.cranes.get(p.toCrane) : undefined;
  if (crane) crane.outReserved = Math.max(0, (crane.outReserved ?? 0) - n);
}

/** Exports put on board a ship, or set down for a crane; false for anything else. */
export function dropOutbound(w: World, p: Dockhand): boolean {
  if (p.toBoat !== undefined && p.toBoat >= 0) {
    const ship = w.boats.find((b) => b.id === p.toBoat);
    if (!ship || ship.state !== 'moored') {
      retargetCrate(w, p);
      return true;
    }
    ship.outIncoming = Math.max(0, (ship.outIncoming ?? 0) - p.planned);
    w.shipOut(ship, feesOf(p.load));
  } else if (p.toCrane !== undefined && p.toCrane >= 0) {
    const crane = w.cranes.get(p.toCrane);
    if (!crane) {
      retargetCrate(w, p);
      return true;
    }
    crane.outReserved = Math.max(0, (crane.outReserved ?? 0) - p.planned);
    outLooks(w, crane).push(...carriedLooks(w, p));
    (crane.outStack ??= []).push(...feesOf(p.load));
  } else if (p.outbound && dest(w, p.bayIdx)?.tiles) {
    // Into storage by a jib crane, for it to lift on board.
    const store = dest(w, p.bayIdx)!;
    store.exportIncoming = Math.max(0, (store.exportIncoming ?? 0) - p.planned);
    setDown(w, store, p.load, true, p, { cleared: true });
  } else return false;
  p.carrying = 0;
  p.load = [];
  p.planned = 0;
  p.toBoat = -1;
  p.toCrane = -1;
  p.outbound = false;
  p.state = 'idle';
  return true;
}

export function retargetCrate(w: World, p: Dockhand): void {
  p.waitingWhy = undefined;
  if (p.outbound) return retargetExports(w, p);
  const boxy = isBoxy(p);
  const old = dest(w, p.bayIdx);
  if (old) bayIncoming(old, boxy, -p.planned);
  tidyPile(w, p.bayIdx);
  const here = w.tileOf(p);
  const held = !boxy && !p.cleared && p.load.some((c) => needsCustoms(c.fee));
  const bay = boxy
    ? yardWithRoom(w, p, here)
    : (onwardFor(w, p, here, (b) => !held || !!b.tiles) ?? bayWithRoom(w, p, here, false, held));
  const goal = bay ? dropAt(w, p, bay, here) : -1;
  if (bay && goal >= 0 && headTo(w, p, goal)) {
    bayIncoming(bay, boxy, p.planned);
    p.bayIdx = bay.idx;
    p.state = 'toDrop';
    return;
  }
  nag(w, 'putDown', `${p.name} had nowhere to take their load and put it down.`, 'bad');
  p.carrying = 0;
  p.load = [];
  p.planned = 0;
  p.bayIdx = -1;
  p.path = [];
  p.state = 'idle';
}

/**
 * The nearest truck bay or crate storage the crates in a worker's hands
 * may go on to and leave from: one the trucks get to and are not kept out
 * of (see cutOff), taking cargo coming in, with room for them, `ok` by it,
 * and in storage room off the tiles a jib crane swings into, which are
 * kept for it. Null if there is none.
 */
export function onwardFor(
  w: World,
  p: Dockhand,
  here: number,
  ok: (b: Bay) => boolean,
): Bay | null {
  const room = (b: Bay) =>
    b.tiles && jibTiles(w, b).size > 0
      ? offJibRoom(w, b, Math.max(1, p.carrying))
      : loadFits(w, b, p.carrying, p);
  return nearestWithRoom(w, p, here, w.bays, false, true, (b) => !b.noAccess && ok(b) && room(b));
}

/**
 * A forklift come to set its load down where there is no place for it
 * level, nor empty ground, as those there now stand: on to a truck bay or
 * storage the trucks get to with one (see onwardFor), else, with crates
 * not yet through storage, the nearest storage with one as they may wait
 * there; or it waits there, saying why, never taking crates out of storage
 * into other storage the trucks cannot reach, only to move them again.
 */
export function noPlace(w: World, p: Dockhand, bay: Bay): void {
  const here = w.tileOf(p);
  const held = !p.cleared && !p.outbound && p.load.some((c) => needsCustoms(c.fee));
  const ok = (b: Bay) => b !== bay && (!held || !!b.tiles);
  const other = p.outbound
    ? null
    : (onwardFor(w, p, here, ok) ??
      (p.cleared
        ? null
        : nearestWithRoom(
            w,
            p,
            here,
            w.bays,
            false,
            false,
            (b) => ok(b) && loadFits(w, b, p.carrying, p),
          )));
  const goal = other ? dropAt(w, p, other, here) : -1;
  if (other && goal >= 0 && headTo(w, p, goal)) {
    bayIncoming(bay, false, -p.planned);
    bayIncoming(other, false, p.planned);
    p.bayIdx = other.idx;
    p.waitingWhy = undefined;
    return;
  }
  p.waitingWhy = noPlaceWhy(p, bay);
}

/** Why a forklift waits to set its load down at a bay with no level place for it. */
export function noPlaceWhy(p: Dockhand, bay: Bay): string {
  const what = p.carrying === 1 ? 'its crate' : `its ${p.carrying} crates`;
  return bay.tiles
    ? `Waiting to set ${what} down in ${bay.name || 'the storage'}: no pallet place there is empty, or has a level layer for them to go on, till some are taken away`
    : `Waiting to set ${what} down at ${bay.name || 'the truck bay'}: its stack has a crate missing from the top, so they would not sit level, till that is filled or taken`;
}

/** Exports in hand whose ship or crane is gone: to another, or back into storage. */
export function retargetExports(w: World, p: Dockhand): void {
  releaseTarget(w, p, p.planned);
  const old = dest(w, p.bayIdx);
  if (old?.pile) bayIncoming(old, false, -p.planned);
  tidyPile(w, p.bayIdx);
  p.toBoat = -1;
  p.toCrane = -1;
  p.bayIdx = -1;
  const here = w.tileOf(p);
  const target = exportTarget(w, p, here);
  if (target && target.room >= p.carrying) {
    if (target.boat) {
      const spot = loadSpot(w, p, target.boat, here);
      if (spot >= 0 && headTo(w, p, spot)) {
        target.boat.outIncoming = (target.boat.outIncoming ?? 0) + p.planned;
        p.toBoat = target.boat.id;
        p.state = 'toDrop';
        return;
      }
    } else if (target.crane && headTo(w, p, craneSpot(w, p, target.crane, true))) {
      target.crane.outReserved = (target.crane.outReserved ?? 0) + p.planned;
      p.toCrane = target.crane.idx;
      p.state = 'toDrop';
      return;
    }
  }
  // Back to wait in storage for the next ship.
  const boxy = isBoxy(p);
  const store = [...(boxy ? w.yards : w.bays).values()]
    .filter((b) => takesExports(w, b) && bayRoom(b, boxy) >= p.carrying && servesYard(w, p, b))
    .sort((a, b) => w.distTo(here, a) - w.distTo(here, b))[0];
  if (store?.yard) {
    carriedLooks(w, p);
    for (const c of p.load) putBox(w, store, c, true);
  } else if (store) setDown(w, store, p.load, true, undefined, { cleared: true });
  else
    nag(w, 'putDownExports', `${p.name} had nowhere to take the exports and put them down.`, 'bad');
  p.carrying = 0;
  p.load = [];
  p.planned = 0;
  p.outbound = false;
  p.path = [];
  p.state = 'idle';
}

export function cancelJob(w: World, p: Dockhand): void {
  releaseTruckJob(w, p);
  releaseTarget(w, p, p.planned);
  if (!p.carrying && p.outbound) {
    const heap = stock(w, p.stockIdx) ?? w.yards.get(p.stockIdx);
    if (heap && !heap.pile) heap.outReserved = Math.max(0, (heap.outReserved ?? 0) - p.planned);
  }
  if (!p.carrying) {
    const boat = w.boats.find((b) => b.id === p.boatId);
    if (boat) boat.reserved = Math.max(0, boat.reserved - p.planned);
    const crane = w.cranes.get(p.craneIdx);
    if (crane) crane.reserved = Math.max(0, crane.reserved - p.planned);
    const pile = stock(w, p.stockIdx);
    if (pile) pile.reserved = Math.max(0, (pile.reserved ?? 0) - p.planned);
    tidyPile(w, p.stockIdx);
  }
  const bay = dest(w, p.bayIdx);
  if (bay && !(p.outbound && bay.tiles)) bayIncoming(bay, isBoxy(p), -p.planned);
  tidyPile(w, p.bayIdx);
  p.boatId = -1;
  p.craneIdx = -1;
  p.stockIdx = -1;
  p.bayIdx = -1;
  p.toBoat = -1;
  p.toCrane = -1;
  p.outbound = false;
  p.hutIdx = -1;
  p.carrying = 0;
  p.load = [];
  p.restack = undefined;
  p.planned = 0;
  p.path = [];
  p.state = 'idle';
}
