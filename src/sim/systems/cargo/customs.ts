// Customs and export papers on crates, and the jobs that move them: what waits and what is cleared, and giving a job up.

import type { World } from '../../world';
import type { Bay, Dockhand, Truck } from '../../state';
import { bayIncoming, bayRoom, isBoxy, needsCustoms, needsPapers } from '../../helpers';
import * as B from '../../balance';
import { nag, tip } from '../output';
import type { BayView } from '../../../protocol/views';
import {
  bayWithRoom,
  carriedLooks,
  dropAt,
  exportLooks,
  outLooks,
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

/**
 * When each crate at a bay still waiting on customs, or (`out`) each of
 * its exports on export papers, clears, soonest first: those cleared are
 * dropped, and never more than there are crates of the kinds that wait.
 */
export function holds(w: World, b: Bay, out: boolean): number[] {
  const list = out ? b.papers : b.customs;
  if (!list) return [];
  let gone = 0;
  while (gone < list.length && list[gone] <= w.tick) gone++;
  const fees = out ? (b.exports ?? []) : b.crates;
  const waits = out ? needsPapers : needsCustoms;
  let n = 0;
  for (const f of fees) if (waits(f)) n++;
  list.splice(0, Math.max(gone, list.length - n));
  if (list.length > 0) return list;
  if (out) b.papers = undefined;
  else b.customs = undefined;
  return [];
}

/**
 * Which of a bay's crates, or (`out`) its exports, still wait: the newest
 * of the kinds that do. Shorter than the list where the rest do not.
 */
export function waitMask(w: World, b: Bay, out: boolean): boolean[] {
  let n = holds(w, b, out).length;
  // None waits: an empty list does, as every index of it is not set.
  if (n === 0) return [];
  const fees = out ? (b.exports ?? []) : b.crates;
  const mask = fees.map(() => false);
  const waits = out ? needsPapers : needsCustoms;
  for (let i = fees.length - 1; i >= 0 && n > 0; i--) {
    if (waits(fees[i])) {
      mask[i] = true;
      n--;
    }
  }
  return mask;
}

/** Which of a bay's crates then its exports, in that order, still wait. */
export function heldMask(w: World, b: Bay): boolean[] {
  const into = waitMask(w, b, false);
  const out = waitMask(w, b, true);
  if (into.length + out.length === 0) return [];
  return [...b.crates.map((_, i) => !!into[i]), ...out];
}

/** Crates at a bay, or (`out`) exports, free to go: none waiting on customs or papers. */
export function readyIn(w: World, b: Bay, out: boolean): number {
  return (out ? (b.exports?.length ?? 0) : b.crates.length) - holds(w, b, out).length;
}

/**
 * Crates just set down at a bay start on customs, or as exports on their
 * papers, if they are of a kind that waits: in crate storage, as only
 * there may they wait. Those carried out of storage cleared do not.
 */
export function startHolds(w: World, b: Bay, fees: number[], out: boolean): void {
  if (!b.tiles || b.yard) return;
  const waits = out ? needsPapers : needsCustoms;
  const n = fees.filter(waits).length;
  if (n === 0) return;
  const until = w.tick + (out ? B.EXPORT_PAPERS_TICKS : B.CRATE_CUSTOMS_TICKS);
  const list = out ? (b.papers ??= []) : (b.customs ??= []);
  for (let k = 0; k < n; k++) list.push(until);
  tip(w, out ? 'papers' : 'crateCustoms');
}

/**
 * Up to `n` crates off a bay's crates, or (`out`) its exports, none of
 * them still waiting and all of them ones `fits` lets through: those from
 * `at` on if they all may go, else the first that may. How each looks,
 * where the bay keeps that, comes off with it into `looks`.
 */
export function takeReady(
  w: World,
  b: Bay,
  out: boolean,
  at: number,
  n: number,
  fits: (fee: number) => boolean = () => true,
  looks?: { from: number[]; to: number[] },
): number[] {
  const list = out ? (b.exports ??= []) : b.crates;
  if (n <= 0 || list.length === 0) return [];
  const wait = waitMask(w, b, out);
  const ok = (i: number) => !wait[i] && fits(list[i]);
  let pick: number[] = [];
  if (at >= 0 && at + n <= list.length) {
    pick = Array.from({ length: n }, (_, k) => at + k);
    if (!pick.every(ok)) pick = [];
  }
  if (pick.length === 0) {
    for (let i = 0; i < list.length && pick.length < n; i++) if (ok(i)) pick.push(i);
  }
  const fees: number[] = [];
  for (let k = pick.length - 1; k >= 0; k--) {
    fees.unshift(list.splice(pick[k], 1)[0]);
    if (looks && pick[k] < looks.from.length) looks.to.unshift(...looks.from.splice(pick[k], 1));
  }
  return fees;
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
      : b.boxes.length
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
    claimed += Math.max(0, t.capacity - t.cargo - (t.coming ?? 0));
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
    w.shipOut(ship, p.cargoFees);
  } else if (p.toCrane !== undefined && p.toCrane >= 0) {
    const crane = w.cranes.get(p.toCrane);
    if (!crane) {
      retargetCrate(w, p);
      return true;
    }
    crane.outReserved = Math.max(0, (crane.outReserved ?? 0) - p.planned);
    outLooks(w, crane).push(...carriedLooks(w, p));
    (crane.outStack ??= []).push(...p.cargoFees);
  } else if (p.outbound && dest(w, p.bayIdx)?.tiles) {
    // Into storage by a jib crane, for it to lift on board.
    const store = dest(w, p.bayIdx)!;
    store.exportIncoming = Math.max(0, (store.exportIncoming ?? 0) - p.planned);
    exportLooks(w, store).push(...carriedLooks(w, p));
    (store.exports ??= []).push(...p.cargoFees);
  } else return false;
  p.carrying = 0;
  p.cargoFees = [];
  p.planned = 0;
  p.toBoat = -1;
  p.toCrane = -1;
  p.outbound = false;
  p.state = 'idle';
  return true;
}

export function retargetCrate(w: World, p: Dockhand): void {
  if (p.outbound) return retargetExports(w, p);
  const boxy = isBoxy(p);
  const old = dest(w, p.bayIdx);
  if (old) bayIncoming(old, boxy, -p.planned);
  tidyPile(w, p.bayIdx);
  const here = w.tileOf(p);
  const held = !boxy && !p.cleared && p.cargoFees.some(needsCustoms);
  const bay = boxy ? yardWithRoom(w, p, here) : bayWithRoom(w, p, here, false, held);
  const goal = bay ? dropAt(w, p, bay, here) : -1;
  if (bay && goal >= 0 && headTo(w, p, goal)) {
    bayIncoming(bay, boxy, p.planned);
    p.bayIdx = bay.idx;
    p.state = 'toDrop';
    return;
  }
  nag(w, 'putDown', `${p.name} had nowhere to take their load and put it down.`, 'bad');
  p.carrying = 0;
  p.cargoFees = [];
  p.planned = 0;
  p.bayIdx = -1;
  p.path = [];
  p.state = 'idle';
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
  if (store) {
    exportLooks(w, store).push(...carriedLooks(w, p));
    (store.exports ??= []).push(...p.cargoFees);
  } else
    nag(w, 'putDownExports', `${p.name} had nowhere to take the exports and put them down.`, 'bad');
  p.carrying = 0;
  p.cargoFees = [];
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
  p.cargoFees = [];
  p.cargoReady = undefined;
  p.restack = undefined;
  p.planned = 0;
  p.path = [];
  p.state = 'idle';
}
