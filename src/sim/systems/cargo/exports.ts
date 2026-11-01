// Cargo going out: the shippers' goods coming in by truck, waiting in storage
// and on the quay, and going on board the ships.

import type { World } from '../../world';
import {
  carriesIce,
  dropAt,
  jibRoom,
  holdsIce,
  iceStore,
  isIceCrate,
  iceBay,
  iceTruck,
  outLooks,
  pickupSpots,
  servesYard,
  stackSide,
  takesExports,
  takesFrom,
  takesIce,
  tidyPile,
  workersAt,
} from './stores';
import { holds, readyIn, takeReady, waitMask } from './customs';
import { crateSlots, stackOf, takeFirst } from './places';
import { avoiding, dockFor, intoSpace, truckCostFor } from '../roads/bays';
import { arrival, entryClear, lengthOf } from '../roads/traffic';
import type { Bay, Boat, Crane, Crate, Dockhand, Truck } from '../../state';
import {
  bayRoom,
  clamp,
  craneTicks,
  cratesAt,
  exportsAt,
  isBoxy,
  outAboard,
  outCap,
  truckBay,
} from '../../helpers';
import type { Source } from '../../helpers';
import { craneSpot, palletTile } from '../yardGantry';
import type { CostFn } from '../../path';
import * as B from '../../balance';
import { costFor, headTo } from '../workforce/dockhands';
import {
  craneHeld,
  craneReaches,
  craneTop,
  deckSlot,
  exportRoom,
  jibGround,
  jibReach,
  jibStores,
  outSlots,
  takeOffCrane,
} from '../cranes';
import { near } from '../boats/berthing';
import { cargoOf, withCargo } from '../../cargo';
import type { Cargo } from '../../cargo';
import { book, shippers } from '../economy';
import { moneyAt, nag, tip } from '../output';
import { landmarkDue, landmarkGoal } from '../../town';
import { openLandmark } from '../townBusiness';
import { isIce } from '../../contracts';
import type { Contract, ShipperTerms } from '../../contracts';
import { needsWideSpace } from '../../rules/parking';
import { walkableAt } from '../../rules/placement';
import { TICKS_PER_DAY } from '../../types';
import { feesOn } from './beds';
import { feesOf, put, stamp } from './hold';

/**
 * Exports waiting to go on a ship being loaded: dockhands carry crates on
 * board from storage, forklifts bring them from storage to storage by a
 * jib crane over the ship, stackers take containers to the crane that
 * lifts them on board. Those an older game left on the quay are taken too.
 */
export function exportSources(w: World, p: Dockhand, here: number, sources: Source[]): void {
  // Exports left on the quay with nothing to put them on board: forklifts
  // take them to a ship being loaded, or back into storage.
  if (p.kind === 'forklift') {
    for (const pile of w.piles.values()) {
      const avail = cratesAt(pile) - (pile.reserved ?? 0);
      if (avail > 0 && stranded(w, pile)) {
        sources.push({ tile: pile.idx, avail, pile, out: true, rank: 2 });
      }
    }
  }
  const boxy = isBoxy(p);
  // Ice in the truck bays, for dockhands to carry on board the fishing
  // boats, or forklifts to take to storage by a jib crane over one.
  const smacks = !boxy && w.boats.some((b) => b.vessel === 'smack' && wantsLoad(w, b));
  const coasters = !boxy && w.boats.some((b) => b.vessel === 'coaster' && wantsLoad(w, b));
  if (smacks) {
    for (const bay of w.bays.values()) {
      const avail = cratesAt(bay, true) - (bay.outReserved ?? 0);
      const tile = avail > 0 && truckBay(bay) ? dropAt(w, p, bay, here) : -1;
      if (tile >= 0) sources.push({ tile, avail, pile: bay, out: true, rank: 1 });
    }
  }
  if (!w.boats.some((b) => wantsLoad(w, b) && (b.vessel === 'feeder') === boxy)) return;
  const stores = boxy ? w.yards.values() : w.bays.values();
  for (const store of stores) {
    // Canned fish waits for its export papers.
    const avail = readyIn(w, store, true) - (store.outReserved ?? 0);
    if (!store.tiles || avail <= 0 || !servesYard(w, p, store)) continue;
    // Ice in storage for the fishing boats, the rest for the coasters.
    if (!boxy && !(iceStore(w, store) ? smacks : coasters)) continue;
    const tile =
      p.kind === 'stacker' && store.yard
        ? stackSide(w, p, store, here, 'pick', true)
        : p.kind === 'forklift' && !store.yard
          ? palletTile(w, store, true, false, true)
          : dropAt(w, p, store, here);
    if (tile >= 0) sources.push({ tile, avail, pile: store, out: true, rank: 1 });
  }
  if (p.kind !== 'dockhand') return;
  for (const pile of w.piles.values()) {
    const avail = cratesAt(pile) - (pile.reserved ?? 0);
    if (pile.out && avail > 0) sources.push({ tile: pile.idx, avail, pile, out: true, rank: 1 });
  }
}

/** Take on carrying exports from `src` towards a ship, if there is one to take them. */
export function takeExportJob(w: World, p: Dockhand, src: Source, cost: CostFn): boolean {
  if (!Number.isFinite(cost(src.tile))) return false;
  if (workersAt(w, src.tile) >= B.WORKERS_PER_SPOT) return false;
  const heap0 = src.pile!;
  const target =
    exportTarget(w, p, src.tile, heap0) ??
    (heap0.pile && stranded(w, heap0) ? exportHome(w, p, src.tile) : null);
  if (!target) return false;
  const planned = Math.min(p.capacity, src.avail, target.room);
  // A forklift brings a whole load to storage by a jib crane, or what the
  // ship still takes: not a crate or two into the last gaps there, while
  // the crane makes room for the rest.
  if (target.want !== undefined && planned < Math.min(p.capacity, src.avail, target.want)) {
    return false;
  }
  if (!headTo(w, p, src.tile)) return false;
  const heap = src.pile!;
  if (heap.pile) heap.reserved = (heap.reserved ?? 0) + planned;
  else heap.outReserved = (heap.outReserved ?? 0) + planned;
  p.toBoat = -1;
  p.toCrane = -1;
  p.bayIdx = -1;
  if (target.boat) {
    target.boat.outIncoming = (target.boat.outIncoming ?? 0) + planned;
    p.toBoat = target.boat.id;
  } else if (target.crane) {
    target.crane.outReserved = (target.crane.outReserved ?? 0) + planned;
    p.toCrane = target.crane.idx;
  } else if (target.store) {
    target.store.exportIncoming = (target.store.exportIncoming ?? 0) + planned;
    p.bayIdx = target.store.idx;
  }
  p.outbound = true;
  p.planned = planned;
  p.boatId = -1;
  p.craneIdx = -1;
  p.stockIdx = heap.idx;
  p.state = 'toPickup';
  return true;
}

/**
 * Where a worker takes exports picked up at `from`: a stacker to a crane
 * over a feeder being loaded; a dockhand on board a coaster being loaded;
 * a forklift into storage by a jib crane over one, for it to lift on
 * board. Nobody sets them down on the bare quay.
 */
export function exportTarget(
  w: World,
  p: Dockhand,
  from: number,
  source?: Bay,
): { boat?: Boat; crane?: Crane; store?: Bay; room: number; want?: number } | null {
  if (isBoxy(p)) {
    for (const c of w.cranes.values()) {
      if (c.kind === 'jib') continue;
      // No more than a ship it reaches still takes, less those already
      // set down for it or on their way, so none are left behind.
      const want = Math.max(
        0,
        ...w.boats
          .filter((b) => wantsLoad(w, b) && craneReaches(w, c, b))
          .map((b) => (b.loadQuota ?? outCap(b)) - outAboard(b) - exportsComing(w, b)),
      );
      const room = Math.min(exportRoom(w, c), want);
      if (room <= 0) continue;
      if (w.pathFor(p, from, craneSpot(w, p, c, true))) return { crane: c, room };
    }
    return null;
  }
  // Ice, from a truck bay or storage, goes on board a fishing boat; the
  // rest on board a coaster.
  const ice = source ? truckBay(source) || iceStore(w, source) : carriesIce(w, p);
  for (const b of w.boats) {
    if (b.vessel !== (ice ? 'smack' : 'coaster') || !wantsLoad(w, b)) continue;
    let room = (ice ? (b.loadQuota ?? outCap(b)) : outCap(b)) - outAboard(b) - (b.outIncoming ?? 0);
    if (p.kind === 'dockhand') {
      if (room > 0 && loadSpot(w, p, b, from) >= 0) return { boat: b, room };
      continue;
    }
    // Forklifts cannot put cargo on board: they take it to storage by the
    // jib crane over the ship for it to lift on. Not out of storage a jib
    // crane is already loading a ship from, or forklifts carry it back and
    // forth between two cranes each loading a ship.
    if (source && jibLoadsFrom(w, source, from)) return null;
    const cranes = [...w.cranes.values()].filter(
      (c) => c.kind === 'jib' && near(w, c.idx, b.berth),
    );
    // A fishing boat takes only a few: no more than it has room for, less
    // the ice already by its cranes or on its way there.
    if (ice) room -= iceByCranes(w, cranes);
    for (const c of cranes) {
      for (const store of jibStores(w, c)) {
        // Only as many as fit on the tiles of it the crane reaches.
        const space = Math.min(room, bayRoom(store, false), jibRoom(w, c, store));
        const takes = ice ? takesIce(w, store) : takesExports(w, store);
        if (store === source || space <= 0 || !takes) continue;
        const at = dropAt(w, p, store, from);
        if (at >= 0) return { store, room: space, want: room };
      }
    }
  }
  return null;
}

/** Ice in storage beside these jib cranes, where they reach it, or on its way there. */
function iceByCranes(w: World, cranes: Crane[]): number {
  const stores = new Set(cranes.flatMap((c) => jibStores(w, c)).filter((s) => iceStore(w, s)));
  let n = 0;
  for (const s of stores) {
    n += Math.max(...cranes.map((c) => jibReady(w, c, s))) + (s.exportIncoming ?? 0);
  }
  return n;
}

/**
 * Whether tile `t` of crate storage `store` is in reach of a jib crane
 * with a ship under it waiting to be loaded, that would lift the exports
 * there on board: on the tiles beside it only, however far the storage
 * goes on beyond them.
 */
function jibLoadsFrom(w: World, store: Bay, t: number): boolean {
  return jibsLoading(w, store).some((c) => jibGround(w, c).includes(t));
}

/**
 * The jib cranes beside crate storage `store` with a ship under them
 * waiting to be loaded from it: a fishing boat from storage holding ice,
 * a coaster from the rest.
 */
export function jibsLoading(w: World, store: Bay): Crane[] {
  const vessel = iceStore(w, store) ? 'smack' : 'coaster';
  return [...w.cranes.values()].filter(
    (c) =>
      c.kind === 'jib' &&
      jibStores(w, c).includes(store) &&
      w.boats.some((b) => b.vessel === vessel && wantsLoad(w, b) && near(w, c.idx, b.berth)),
  );
}

/**
 * The stacks of crate storage `store` (by tile) the jib cranes loading
 * ships from it reach, where forklifts set exports down for them; none
 * if no jib crane is loading from it.
 */
export function jibLoadReach(w: World, store: Bay): Set<number> | undefined {
  const cranes = jibsLoading(w, store);
  if (cranes.length === 0) return undefined;
  return new Set(cranes.flatMap((c) => [...jibReach(w, c, store)]));
}

/** Exports in crate storage free to go that a jib crane can lift on board: on the tiles beside it. */
export function jibReady(w: World, c: Crane, store: Bay): number {
  const reach = jibReach(w, c, store);
  const wait = waitMask(w, store, true);
  return crateSlots(w, store).exports.filter(
    (s, i) => !wait[i] && s >= 0 && reach.has(stackOf(store, s)),
  ).length;
}

/** Whether a jib crane can swing a crate on board from tile `t`: right beside it. */
export function inJibReach(w: World, c: Crane, t: number): boolean {
  return near(w, c.idx, t);
}

/**
 * Whether exports set down on quay tile `t` go on board coaster `b`: in
 * reach of a jib crane over it, or beside it for the dockhands to carry.
 */
export function pileFor(w: World, b: Boat, t: number): boolean {
  if (b.vessel !== 'coaster' || b.state !== 'moored') return false;
  if (w.people.some((q) => q.kind === 'dockhand') && pickupSpots(w, b).includes(t)) {
    return true;
  }
  for (const c of w.cranes.values()) {
    if (c.kind === 'jib' && near(w, c.idx, b.berth) && inJibReach(w, c, t)) return true;
  }
  return false;
}

/** Exports left on the quay where nothing will put them on board: their ship has gone. */
export function stranded(w: World, pile: Bay): boolean {
  return !!pile.out && !w.boats.some((b) => pileFor(w, b, pile.idx));
}

/** Outgoing crate storage a forklift can take exports back into from `from`. */
export function exportHome(
  w: World,
  p: Dockhand,
  from: number,
): { boat?: Boat; crane?: Crane; store?: Bay; room: number; want?: number } | null {
  // Ice goes back into a truck bay.
  const ice = p.load.some((c) => cargoOf(c.fee, 'goods') === 'ice');
  const stores = [...w.bays.values()]
    .filter((b) => (ice ? truckBay(b) : takesExports(w, b)) && bayRoom(b, false) > 0)
    .sort((a, b) => w.distTo(from, a) - w.distTo(from, b));
  const store = stores.find((b) => dropAt(w, p, b, from) >= 0);
  return store ? { store, room: bayRoom(store, false) } : null;
}

/** A dock tile beside the ship this worker can get to from `from`, or -1. */
export function loadSpot(w: World, p: Dockhand, b: Boat, from: number): number {
  const cost = costFor(w, p);
  for (const t of pickupSpots(w, b)) {
    if (Number.isFinite(cost(t)) && w.pathFor(p, from, t)) return t;
  }
  return -1;
}

/** Unloaded, with room on board and someone to load it: it takes exports on. */
export function wantsLoad(_w: World, b: Boat): boolean {
  return (
    b.state === 'moored' &&
    b.crates === 0 &&
    b.reserved === 0 &&
    (b.loadQuota ?? outCap(b)) - outAboard(b) - (b.outIncoming ?? 0) > 0
  );
}

/** Exports of this kind waiting anywhere in the port, for a ship to take. */
export function exportsWaiting(w: World, boxes: boolean): number {
  let n = 0;
  for (const s of boxes ? w.yards.values() : w.bays.values()) n += exportsAt(s);
  if (boxes) for (const c of w.cranes.values()) n += craneHeld(c, true);
  else for (const p of w.piles.values()) if (p.out) n += cratesAt(p);
  return n;
}

/**
 * Exports this ship could take on: from storage, and those already set
 * down where they go on board it, at its own crane or on the quay by it,
 * or left behind by a ship gone; not those at another berth for the ship
 * lying there or to come, nor shippers' cargo still outside the port.
 */
export function exportsFor(w: World, b: Boat): number {
  const boxes = b.vessel === 'feeder';
  let n = 0;
  // Fishing boats take the ice in the truck bays and storage, coasters
  // the rest in storage.
  for (const s of boxes ? w.yards.values() : w.bays.values()) {
    // Not canned fish still waiting on its export papers.
    const ice = !boxes && (truckBay(s) || iceStore(w, s));
    if (boxes || ice === (b.vessel === 'smack')) n += readyIn(w, s, true);
  }
  if (b.vessel === 'smack') return n;
  if (boxes) {
    for (const c of w.cranes.values()) {
      if (craneReaches(w, c, b)) n += craneHeld(c, true);
    }
  } else {
    for (const p of w.piles.values()) {
      if (p.out && (pileFor(w, b, p.idx) || stranded(w, p))) n += cratesAt(p);
    }
  }
  return n;
}

/**
 * Exports on their way on board a ship: carried to it, or set down at a
 * container crane over it, or on their way there; or in storage beside a
 * jib crane over it, where it reaches them, or on their way there.
 */
export function exportsComing(w: World, b: Boat): number {
  let n = b.outIncoming ?? 0;
  if (b.vessel !== 'feeder') {
    // Ice for a fishing boat, the rest for a coaster.
    const ice = b.vessel === 'smack';
    const cranes = [...w.cranes.values()].filter(
      (c) => c.kind === 'jib' && near(w, c.idx, b.berth),
    );
    const stores = new Set(cranes.flatMap((c) => jibStores(w, c)));
    if (stores.size === 0) return n;
    for (const s of stores) {
      if (iceStore(w, s) === ice) n += Math.max(...cranes.map((c) => jibReady(w, c, s)));
    }
    for (const p of w.people) {
      const to = p.outbound && p.bayIdx >= 0 ? w.bays.get(p.bayIdx) : undefined;
      if (to && stores.has(to) && carriesIce(w, p) === ice) n += p.planned;
    }
    return n;
  }
  for (const c of w.cranes.values()) {
    if (c.kind !== 'jib' && craneReaches(w, c, b)) {
      n += craneHeld(c, true) + (c.outReserved ?? 0);
    }
  }
  return n;
}

/**
 * A ship unloaded stays to take exports on board while any are waiting and
 * being brought to it, until it is full or nothing has come for a while.
 */
export function stillLoading(w: World, b: Boat): boolean {
  if (outCap(b) === 0) return false;
  if (outAboard(b) >= outCap(b) && (b.outIncoming ?? 0) === 0) return false;
  // Those already at its cranes, or on their way there, it takes anyway.
  const coming = exportsComing(w, b) - (b.outIncoming ?? 0);
  // It takes what is in the port when it is ready to go, never waiting for
  // more to come in, nor to fill up.
  if (b.loadQuota === undefined) {
    const claimed = w.boats
      .filter((o) => o !== b && o.state === 'moored' && o.vessel === b.vessel)
      .reduce((n, o) => n + Math.max(0, (o.loadQuota ?? 0) - outAboard(o)), 0);
    const room = outCap(b) - outAboard(b);
    const take = clamp(Math.max(coming, w.exportsFor(b) - claimed), 0, room);
    b.loadQuota = outAboard(b) + take;
    // The line allows time to load as well as to unload.
    b.grace += take * B.MOORED_TICKS_PER_CRATE;
  }
  if ((b.outIncoming ?? 0) > 0) return true;
  if (outAboard(b) >= b.loadQuota) return false;
  // Nothing left in the port that other ships alongside are not taking.
  const theirs = w.boats
    .filter((o) => o !== b && o.state === 'moored' && o.vessel === b.vessel)
    .reduce((n, o) => n + Math.max(0, (o.loadQuota ?? 0) - outAboard(o) - (o.outIncoming ?? 0)), 0);
  if (Math.max(coming, w.exportsFor(b) - theirs) <= 0) return false;
  // Its own cargo still being cleared off the crane comes first; and those
  // at its cranes, or on their way there, are coming.
  const busy =
    coming > 0 || [...w.cranes.values()].some((c) => craneHeld(c) > 0 && craneReaches(w, c, b));
  b.loadIdle = busy ? 0 : (b.loadIdle ?? 0) + 1;
  return b.loadIdle < B.LOAD_WAIT;
}

/**
 * Why nothing puts the ice waiting in the port on board fishing boat `b`
 * alongside, if nothing can: dockhands carry it on from the quay beside
 * it, but never by a crane; under a jib crane, forklifts bring it to
 * crate storage for cargo going out beside the crane for it to lift on.
 */
export function iceTrouble(w: World, b: Boat): string | undefined {
  if (b.vessel !== 'smack' || b.state !== 'moored' || b.crates > 0 || outCap(b) === 0) return;
  if (outAboard(b) >= (b.loadQuota ?? outCap(b)) || (b.outIncoming ?? 0) > 0) return;
  if (w.exportsFor(b) === 0) return;
  const hands = w.people.some((q) => q.kind === 'dockhand');
  if (hands && pickupSpots(w, b).some((t) => walkableAt(w.map, t))) return;
  const cranes = [...w.cranes.values()].filter((c) => c.kind === 'jib' && near(w, c.idx, b.berth));
  if (cranes.length === 0) {
    return hands
      ? 'Nobody can put ice on board it: dockhands may not walk on the quay beside it, by a crane, and no jib crane stands over it to lift the ice on.'
      : 'Nobody can put ice on board it: dockhands carry it on, and there are none. Hire dockhands, or berth fishing boats under a jib crane.';
  }
  const stores = cranes.flatMap((c) => jibStores(w, c)).filter((s) => s.outgoing && !s.shut);
  if (stores.length === 0) {
    return 'The ice cannot reach it: dockhands may not walk by the jib crane over it, and the crane has no crate storage for cargo going out beside it for forklifts to bring the ice to. Mark some out next to the crane.';
  }
  if (!w.people.some((q) => q.kind === 'forklift')) {
    return 'The ice cannot reach it: dockhands may not walk by the jib crane over it, and only forklifts bring ice to the storage beside the crane for it to lift on board. Buy a forklift.';
  }
  if (!stores.some((s) => iceStore(w, s) || takesIce(w, s))) {
    return 'The crate storage for cargo going out beside the jib crane over it holds other exports, and ice and other exports keep to storage of their own: it waits for that storage to empty.';
  }
  return undefined;
}

/** What an unloaded ship alongside is doing: taking exports on, or waiting to sail. */
export function readyWords(w: World, b: Boat): string {
  const out = outAboard(b);
  if (b.loadQuota === undefined || out < b.loadQuota || (b.outIncoming ?? 0) > 0) {
    const why = iceTrouble(w, b);
    return `Taking exports on board, ${out}${b.loadQuota ? ` of ${b.loadQuota}` : ''}${why ? ', but nothing can bring it the ice' : ''}`;
  }
  const why = {
    fairway: ', waiting for the way out to clear',
    tug: ', waiting for its tug',
    others: ', letting a ship ready before it go first',
    room: ', waiting for a ship turning off its berth',
  };
  // Canned fish still waiting on its papers stays for the next coaster.
  let papers = 0;
  if (b.vessel === 'coaster') for (const s of w.bays.values()) papers += holds(w, s, true).length;
  const later = papers > 0 ? `; ${papers} crates of canned fish wait on their export papers` : '';
  return `Ready to sail${out > 0 ? ` with ${out} exports` : ''}${b.holdUp ? why[b.holdUp] : ''}${later}`;
}

/** What each crate on a crate truck holds, in load order. */
export function truckCargo(w: World, t: Truck): Cargo[] {
  // A shipper's are all alike.
  if (t.exports) return Array<Cargo>(t.cargo).fill(cargoOf(t.value, 'goods'));
  const fees = t.load ? feesOn(w, t) : [];
  return Array.from({ length: t.cargo }, (_, k) => (k < fees.length ? cargoOf(fees[k]) : 'fish'));
}

/**
 * Exports go on board, into deck slot `slot` on a feeder if given, else
 * after those already there: the shipper pays for each as it does.
 */
export function shipOut(w: World, b: Boat, load: (Crate | number)[], slot?: number): void {
  if (load.length === 0) return;
  const crates = load.map((c) => (typeof c === 'number' ? { fee: c, at: 0 } : c));
  const fees = feesOf(crates);
  const total = fees.reduce((n, f) => n + f, 0);
  const cells = (b.loaded ??= []);
  for (const c of crates) {
    c.at = stamp(w.tick);
    c.out = true;
    let k = slot !== undefined && slot >= 0 && !cells[slot] ? slot : cells.length;
    if (cells[k]) k = cells.length;
    while (cells.length <= k) cells.push(null);
    put(cells, k, c);
    slot = undefined;
  }
  b.loadIdle = 0;
  book(w, 'exports', total);
  w.stats.earned += total;
  w.stats.exported = (w.stats.exported ?? 0) + fees.length;
  moneyAt(w, total, b.berth);
  // Ice on board a fishing boat, towards the town's ice house, or canned
  // fish on a coaster, towards its builders' yard.
  const goal = w.town && landmarkGoal(w.town, w.tier)?.goal;
  if (goal?.aboard && w.town) {
    w.town.goal += fees.filter((f) => cargoOf(f, 'goods') === goal.cargo).length;
    openLandmark(w, landmarkDue(w.town, false, w.tier));
  }
}

/**
 * A crane with nothing to unload loads a ship instead: a jib crane from
 * crate storage in reach or exports left on the quay beside it, a
 * container crane from what the stackers have brought it.
 */
export function loadShip(w: World, c: Crane): void {
  const boxes = c.kind !== 'jib';
  const ship = w.boats.find(
    (b) => (b.vessel === 'feeder') === boxes && wantsLoad(w, b) && craneReaches(w, c, b),
  );
  if (!ship) return;
  let take: (() => { box?: Crate; slot?: number }) | null = null;
  let from: { store?: Bay; pile?: Bay } = {};
  if (boxes) {
    if (craneHeld(c, true)) {
      const k = c.liftSlot;
      if (c.liftBoat !== ship.id || k === undefined || k < 0 || outSlots(w, ship).includes(k)) {
        c.liftBoat = ship.id;
        c.liftSlot = deckSlot(w, c, ship, true);
      }
      if (c.liftSlot! < 0) return;
      take = () => {
        // Off the top of the stacks, at a gantry crane.
        const i = Math.max(0, craneTop(w, c, true));
        outLooks(w, c);
        const box = takeOffCrane(w, c, i, true);
        const slot = c.liftSlot!;
        c.liftSlot = undefined;
        return { box, slot };
      };
    }
  } else {
    // Off the tiles of storage beside it only: ice on board a fishing
    // boat, the rest on board a coaster.
    const ice = ship.vessel === 'smack';
    const store = jibStores(w, c).find(
      (a) =>
        iceStore(w, a) === ice &&
        jibReady(w, c, a) > 0 &&
        readyIn(w, a, true) - (a.outReserved ?? 0) > 0,
    );
    const pile = ice
      ? undefined
      : [...w.piles.values()].find(
          (q) => q.out && cratesAt(q) - (q.reserved ?? 0) > 0 && inJibReach(w, c, q.idx),
        );
    from = store ? { store } : pile ? { pile } : {};
    if (store) {
      take = () => ({
        box: takeReady(
          w,
          store,
          true,
          cratesAt(store, true) - 1,
          1,
          (f) => isIceCrate(f) === ice,
          jibReach(w, c, store),
        )[0],
      });
    } else if (pile) {
      take = () => {
        const box = takeFirst(pile, 1)[0];
        tidyPile(w, pile.idx);
        return { box };
      };
    }
  }
  if (!take) return;
  const m = w.map;
  c.busy = true;
  if (!boxes) w.jibJobs.set(c, { boat: ship, load: true, ...from });
  c.angle = Math.atan2(ship.y - (m.yOf(c.idx) + 0.5), ship.x - (m.xOf(c.idx) + 0.5));
  if (++c.timer < craneTicks(c)) return;
  c.timer = 0;
  const { box, slot } = take();
  if (box) w.shipOut(ship, [box], slot);
}

/**
 * Shippers' trucks come in on their timetable, each to a parking space
 * outside the port to have its paperwork done. With nowhere to park, they
 * do not come. An ice works' trucks need no paperwork: they drive
 * straight to a truck bay, like the hauliers'. The cannery's park only to
 * wait their turn: their crates have their export papers done in storage.
 */
export function spawnShipments(w: World): void {
  const m = w.map;
  for (const c of shippers(w)) {
    if (w.tick < c.nextBoatTick) continue;
    if (isIce(c.terms)) {
      spawnIce(w, c);
      continue;
    }
    const wide = needsWideSpace(c.terms.capacity, c.terms.cargo === 'container');
    const space = w.freeParking(null, true, wide);
    const from = arrival(w, space ? space.tiles[0] : m.entry);
    if (!entryClear(w, from.tile)) continue;
    const into = space ? intoSpace(w, from.tile, space, -1) : null;
    if (!space || !into) {
      c.nextBoatTick = w.tick + 60;
      tip(w, 'parking');
      nag(
        w,
        'parking',
        `${c.terms.name}'s trucks need parking outside the port, by a public road, to do their paperwork.`,
        'bad',
      );
      continue;
    }
    c.nextBoatTick = w.tick + Math.round((TICKS_PER_DAY * c.terms.capacity) / c.terms.perDay);
    w.trucks.push({
      id: w.nextId++,
      contractId: c.id,
      company: c.terms.name,
      capacity: c.terms.capacity,
      x: m.xOf(from.tile) + 0.5,
      y: m.yOf(from.tile) + 0.5,
      dir: from.dir,
      path: into.path,
      goal: into.path[into.path.length - 1],
      park: space.tiles[0],
      parkFrom: into.via,
      lot: space.tiles,
      state: 'toPark',
      bayIdx: -1,
      cargo: c.terms.capacity,
      value:
        c.terms.cargo === 'container'
          ? c.terms.fee
          : withCargo(c.terms.fee, c.terms.goods ?? 'goods'),
      boxes: c.terms.cargo === 'container',
      exports: true,
      idle: 0,
      timer: 0,
      variant: c.terms.color,
    });
  }
}

/**
 * An ice works' truck, straight to the nearest truck bay with room for
 * its load and a free spot to unload at; none comes while there is none.
 */
export function spawnIce(w: World, c: Contract & { terms: ShipperTerms }): void {
  const m = w.map;
  const bay = [...w.bays.values()].find((b) => truckBay(b) && !b.large);
  if (!bay) {
    c.nextBoatTick = w.tick + 60;
    nag(w, 'iceBay', `${c.terms.name}'s trucks bring ice to a truck bay. Build one.`, 'bad');
    return;
  }
  const from = arrival(w, bay.idx);
  if (!entryClear(w, from.tile)) return;
  const truck: Truck = {
    id: w.nextId++,
    contractId: c.id,
    company: c.terms.name,
    capacity: c.terms.capacity,
    x: m.xOf(from.tile) + 0.5,
    y: m.yOf(from.tile) + 0.5,
    dir: from.dir,
    path: [],
    goal: from.tile,
    state: 'toBay',
    bayIdx: -1,
    cargo: c.terms.capacity,
    value: withCargo(c.terms.fee, 'ice'),
    boxes: false,
    exports: true,
    idle: 0,
    timer: 0,
    variant: c.terms.color,
  };
  const to = w.exportStore(truck);
  // Every truck bay full, or none it can get to: it comes a little later.
  if (!to) {
    c.nextBoatTick = w.tick + 60;
    if (![...w.bays.values()].some((b) => iceBay(w, b))) {
      nag(
        w,
        'iceBayFree',
        `${c.terms.name}'s ice waits for a truck bay of its own: the catch and the ice never share one. Build another truck bay.`,
        'bad',
      );
    }
    return;
  }
  c.nextBoatTick = w.tick + Math.round((TICKS_PER_DAY * c.terms.capacity) / c.terms.perDay);
  to.store.exportIncoming = (to.store.exportIncoming ?? 0) + truck.cargo;
  truck.bayIdx = to.store.idx;
  truck.path = to.path;
  truck.goal = to.dock;
  w.trucks.push(truck);
}

/**
 * Storage with room for a shipper's truck to unload into and a free spot
 * beside it, the nearest it can get to from `from`.
 */
export function exportStore(
  w: World,
  t: Truck,
): { store: Bay; dock: number; path: number[] } | null {
  const from = w.tileOf(t);
  // Ice to a bay that holds ice already before another, keeping the rest for the catch.
  const iced = (b: Bay) => (iceTruck(w, t) && holdsIce(w, b) ? 0 : 1);
  const stores = [...(t.boxes ? w.yards : w.bays).values()]
    .filter((b) => takesFrom(w, b, t) && bayRoom(b, t.boxes) >= t.cargo)
    .sort((a, b) => iced(a) - iced(b) || w.distTo(from, a) - w.distTo(from, b));
  for (const store of stores) {
    const to = dockFor(
      w,
      store,
      (d, avoid) => w.routeFrom(t, d, avoiding(w, truckCostFor(w, store.idx, -1, t), avoid)),
      lengthOf(w, t),
    );
    if (to) return { store, ...to };
  }
  return null;
}

/** Some outgoing storage of its kind has room for a shipper's truck's load. */
export function outgoingRoom(w: World, t: Truck): boolean {
  return [...(t.boxes ? w.yards : w.bays).values()].some(
    (b) => takesFrom(w, b, t) && bayRoom(b, t.boxes) >= t.cargo,
  );
}

/** Say, now and then, that shippers' trucks are waiting because no outgoing storage has room. */
export function outgoingFull(w: World, boxes: boolean): void {
  const kind = boxes ? 'boxes' : 'crates';
  const stores = [...(boxes ? w.yards : w.bays).values()].filter((b) => b.outgoing);
  nag(
    w,
    `outFull:${kind}`,
    stores.length === 0
      ? `Shippers' trucks are waiting with ${boxes ? 'containers' : 'crates'} to ship: mark out ${boxes ? 'a container yard' : 'crate storage'} for cargo going out.`
      : `Outgoing ${boxes ? 'container yards are' : 'crate storage is'} full: shippers' trucks are waiting in parking. Mark out more, or get ships loading.`,
    'bad',
  );
}
