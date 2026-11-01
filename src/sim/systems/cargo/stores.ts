// Storage and the cargo in it: bays, yards and piles, what goes where, who can
// reach it, and how containers are stacked and found.

import type { World } from '../../world';
import { dest, holds, nextHold, readyIn, takeReady, waitMask } from './customs';
import { roadTo } from '../roads/bays';
import type { Bay, Boat, Crane, Dockhand, Truck } from '../../state';
import { message } from '../output';
import * as B from '../../balance';
import { laneThrough } from '../workforce/crowding';
import {
  YARD_STACKS,
  YARD_TIERS,
  aligned,
  bayCap,
  bayRoom,
  cratesAt,
  craneStacks,
  heldIn,
  isBoxy,
  truckBay,
  yardPlace,
} from '../../helpers';
import { boatHalf, mooredTiles } from '../boats/berthing';
import { Build, TICKS_PER_DAY, isDock } from '../../types';
import { craneKinds, cranePlaces, craneTop, jibReach, jibStores } from '../cranes';
import { onPallet, palletPlaces, palletTile, takenFrom } from '../yardGantry';
import { crateSlots, loadSlot, reserved, slotCount, stackOf, takeTop, usedSlots } from './places';
import { byHand, cratesFor } from '../truckLoading';
import { drivable, nearCrane } from '../../rules/placement';
import { cargoOf } from '../../cargo';

/** A heap on the quay, or storage, being collected from: exports from container yards too. */
export function stock(w: World, i: number): Bay | undefined {
  return w.piles.get(i) ?? w.bays.get(i) ?? w.yards.get(i);
}

/** Forget a heap on the quay once it is gone and nobody is coming for it. */
export function tidyPile(w: World, i: number): void {
  const pile = w.piles.get(i);
  if (pile && cratesAt(pile) + pile.incoming + (pile.reserved ?? 0) === 0) {
    w.piles.delete(i);
  }
}

export function removePile(w: World, i: number): void {
  const pile = w.piles.get(i);
  if (pile && cratesAt(pile) > 0) {
    message(w, `${cratesAt(pile)} crates waiting on the quay were lost.`, 'bad');
  }
  w.piles.delete(i);
}

/**
 * Whether another machine of the same kind, free or about to be, is nearer
 * `tile` and can get there; it will take the job instead.
 */
export function nearerMachine(w: World, p: Dockhand, tile: number): boolean {
  const mine = w.dist(w.tileOf(p), tile);
  let best: Dockhand | null = null;
  let bestDist = mine;
  for (const q of w.people) {
    if (q === p || q.kind !== p.kind || q.needsRepair || q.fuel < B.LOW_FUEL || q.stuck) continue;
    const free =
      q.state === 'idle' ||
      q.state === 'dropping' ||
      (q.state === 'toDepot' && q.depotTask === 'park');
    if (!free) continue;
    const d = w.dist(w.tileOf(q), tile);
    if (d < bestDist) {
      best = q;
      bestDist = d;
    }
  }
  if (!best || !w.pathFor(best, w.tileOf(best), tile)) return false;
  // And it has somewhere to take the load from there.
  return isBoxy(p) ? !!yardWithRoom(w, best, tile) : !!bayWithRoom(w, best, tile);
}

/** Dock tiles beside a moored boat's hull. */
export function pickupSpots(w: World, b: Boat): number[] {
  const fp = mooredTiles(w, b.berth, b.jetty, boatHalf(w, b.vessel === 'feeder')) ?? [b.berth];
  const spots = new Set<number>([b.jetty]);
  for (const t of fp) {
    for (const n of w.map.neighbors4(t)) if (isDock(w.map.build[n])) spots.add(n);
  }
  return [...spots];
}

export function workersAt(w: World, tile: number): number {
  let n = 0;
  for (const q of w.people) {
    if (q.goal === tile && (q.state === 'toPickup' || q.state === 'picking')) n++;
  }
  return n;
}

export function sourceValid(w: World, p: Dockhand): boolean {
  if (p.craneIdx >= 0) return w.cranes.has(p.craneIdx);
  if (p.stockIdx >= 0) return !!stock(w, p.stockIdx);
  const boat = w.boats.find((b) => b.id === p.boatId);
  return !!boat && boat.state === 'moored';
}

/** Lift up to the planned number of crates; returns their fees. */
export function takeFromSource(w: World, p: Dockhand): number[] {
  p.cleared = undefined;
  // Moving crates within one storage, off the tiles by a jib crane.
  const within = p.stockIdx >= 0 && p.stockIdx === p.bayIdx && p.truckId === undefined;
  p.shiftIn = within ? p.stockIdx : undefined;
  if (p.craneIdx >= 0) {
    const crane = w.cranes.get(p.craneIdx);
    p.craneIdx = -1;
    if (!crane) return [];
    crane.reserved = Math.max(0, crane.reserved - p.planned);
    // Set straight onto it off the ship.
    if (p.handed) {
      const { fees, looks, from } = p.handed;
      p.handed = undefined;
      p.cargoFrom = from;
      p.cargoLooks = looks;
      return fees;
    }
    const n = Math.min(p.planned, crane.stack.length);
    if (crane.kind !== 'jib') {
      // Off the top of its stacks, one at a time.
      const fees: number[] = [];
      p.cargoFrom = [];
      p.cargoLooks = [];
      for (let k = 0; k < n; k++) {
        // The one it pulled up to, while nothing has been set on it.
        const places = cranePlaces(w, crane).stack;
        const chosen = p.takeAt === undefined ? -1 : places.indexOf(p.takeAt);
        const kinds = craneKinds(w, crane);
        const free = chosen >= 0 && !kinds.has(p.takeAt! + craneStacks(crane));
        p.takeAt = undefined;
        const i = free ? chosen : craneTop(w, crane, false);
        if (i < 0) break;
        cranePlaces(w, crane).stack.splice(i, 1);
        p.cargoFrom.push(...(crane.stackFrom ?? []).splice(i, 1));
        p.cargoLooks.push(...stackLooks(w, crane).splice(i, 1));
        fees.push(...crane.stack.splice(i, 1));
      }
      return fees;
    }
    p.cargoFrom = crane.kind === 'jib' ? undefined : (crane.stackFrom ?? []).splice(0, n);
    p.cargoLooks = crane.kind === 'jib' ? undefined : stackLooks(w, crane).splice(0, n);
    // A jib crane's landing stack, off the top.
    return crane.kind === 'jib'
      ? crane.stack.splice(crane.stack.length - n, n)
      : crane.stack.splice(0, n);
  }
  if (p.stockIdx >= 0) {
    const pile = stock(w, p.stockIdx);
    const at = p.stockIdx;
    p.stockIdx = -1;
    if (!pile) return [];
    if (p.outbound && !pile.pile) {
      pile.outReserved = Math.max(0, (pile.outReserved ?? 0) - p.planned);
      if (!pile.yard) {
        // Never canned fish still waiting on its export papers.
        const n = Math.min(p.planned, cratesAt(pile, true), onPallet(w, p, pile));
        return takeReady(w, pile, true, takenFrom(w, p, pile, n), n);
      }
      const out = (pile.outBoxes ??= []);
      const n = Math.min(p.planned, out.length);
      // Off the top of the stacks in a yard.
      const fees: number[] = [];
      p.cargoLooks = [];
      const reach = p.kind === 'stacker' ? reachFrom(w, pile, p.goal) : undefined;
      for (let k = 0; k < n; k++) {
        const i = yardTop(w, pile, true, undefined, reach);
        if (i < 0) break;
        yardSlots(w, pile).exports.splice(i, 1);
        p.cargoLooks.push(...exportLooks(w, pile).splice(i, 1));
        fees.push(...out.splice(i, 1));
      }
      return fees;
    }
    pile.reserved = Math.max(0, (pile.reserved ?? 0) - p.planned);
    const n = Math.min(p.planned, cratesAt(pile), onPallet(w, p, pile));
    // Out of storage, never a crate still in customs; and those taken
    // have cleared, wherever they go.
    const fees = pile.tiles
      ? takeReady(w, pile, false, takenFrom(w, p, pile, n), n)
      : takeTop(pile, n);
    if (pile.tiles) p.cleared = true;
    tidyPile(w, at);
    return fees;
  }
  const boat = w.boats.find((b) => b.id === p.boatId);
  p.boatId = -1;
  if (!boat) return [];
  boat.reserved = Math.max(0, boat.reserved - p.planned);
  const n = Math.min(p.planned, boat.crates);
  boat.crates -= n;
  return Array.from({ length: n }, () => boat.fee);
}

/**
 * Nearest truck bay or crate storage with room that this worker can reach
 * from `from`; with `onward`, only those the trucks can get to.
 */
export function bayWithRoom(
  w: World,
  p: Dockhand,
  from: number,
  onward = false,
  held = false,
  except?: Bay,
): Bay | null {
  // Crates waiting on customs only into crate storage, not a truck bay.
  const only = (b: Bay) => b !== except && (!held || !!b.tiles);
  return nearestWithRoom(w, p, from, w.bays, false, onward, only);
}

/** Nearest container yard with room this stacker or tractor can reach from `from`. */
export function yardWithRoom(w: World, p: Dockhand, from: number): Bay | null {
  return nearestWithRoom(w, p, from, w.yards, true, false, (b) => servesYard(w, p, b));
}

/**
 * Whether this machine can work a container yard: a terminal tractor
 * cannot lift a container, so only where a yard gantry lifts it off and on.
 */
export function servesYard(w: World, p: Dockhand, yard: Bay): boolean {
  return p.kind !== 'tractor' || (w.yardGantry(yard) && laneThrough(w, yard));
}

export function nearestWithRoom(
  w: World,
  p: Dockhand,
  from: number,
  among: Map<number, Bay>,
  boxes: boolean,
  onward = false,
  only?: (b: Bay) => boolean,
): Bay | null {
  const bays = [...among.values()]
    .filter(
      (b) =>
        dropRoom(w, b, boxes) > 0 &&
        takesImports(w, b) &&
        (!onward || truckable(w, b)) &&
        (!only || only(b)),
    )
    .sort((a, b) => bayCost(w, from, a, boxes) - bayCost(w, from, b, boxes));
  return bays.find((b) => dropAt(w, p, b, from) >= 0) ?? null;
}

/**
 * How far off a bay is to bring cargo to: crates go a good way further to
 * a truck bay where a truck waits for them, to set them straight on it.
 */
export function bayCost(w: World, from: number, b: Bay, boxes: boolean): number {
  const waiting = !boxes && truckRoom(w, b) > b.incoming;
  return w.distTo(from, b) - (waiting ? B.TRUCK_WAITING_PULL : 0);
}

/**
 * Room on crate trucks loading at a truck bay, besides what dockhands and
 * forklifts loading it from its stack are bringing them: crates carried
 * there go straight on, however many the bay holds already.
 */
export function truckRoom(w: World, b: Bay): number {
  if (b.tiles || b.yard || b.pile) return 0;
  let room = 0;
  for (const t of w.trucks) {
    if (t.state !== 'loading' || t.bayIdx !== b.idx || !byHand(w, t, b)) continue;
    room += Math.max(0, t.capacity - t.cargo - (t.coming ?? 0));
  }
  return room;
}

/** Room for crates brought to a bay: on its stack, or straight onto a truck there. */
export function dropRoom(w: World, b: Bay, boxes: boolean): number {
  return bayRoom(b, boxes) + (boxes ? 0 : truckRoom(w, b));
}

/**
 * Storage by a crane, its machines-only ground: it loads and unloads, so
 * it takes cargo either way, but one way at a time.
 */
export function byCrane(w: World, b: Bay): boolean {
  return !!b.tiles && b.tiles.some((t) => nearCrane(w.map, t));
}

/**
 * Whether cargo coming in may go here: truck bays, and storage marked out
 * for cargo coming in, by a crane or not.
 */
export function takesImports(w: World, b: Bay): boolean {
  if (!b.tiles) return !holdsIce(w, b);
  return !b.outgoing && !b.shut;
}

/** Whether exports may go here: only storage marked out for cargo going out, and not shut. */
export function takesExports(_w: World, b: Bay): boolean {
  return !!b.tiles && !!b.outgoing && !b.shut;
}

/**
 * Where shipper's truck `t` unloads: ice into a truck bay, for the
 * fishing boats; the rest into outgoing storage.
 */
export function takesFrom(w: World, b: Bay, t: Truck): boolean {
  return iceTruck(w, t) ? iceBay(w, b) : takesExports(w, b);
}

/**
 * A truck bay the ice may go into: never one holding the catch, or with
 * any on its way, nor with a truck in it loading: ice and catch keep to
 * bays of their own.
 */
export function iceBay(w: World, b: Bay): boolean {
  if (
    !truckBay(b) ||
    b.large ||
    cratesAt(b) > 0 ||
    b.incoming > 0 ||
    (b.reserved ?? 0) > 0 ||
    w.trucks.some((q) => q.bayIdx === b.idx && !q.exports)
  ) {
    return false;
  }
  // One holding ice already, or a free one while another is left for the catch.
  return (
    holdsIce(w, b) || [...w.bays.values()].some((o) => o !== b && truckBay(o) && !holdsIce(w, o))
  );
}

/** A truck bay given over to ice for the boats, with some in it or on its way. */
export function holdsIce(_w: World, b: Bay): boolean {
  return truckBay(b) && (cratesAt(b, true) > 0 || (b.exportIncoming ?? 0) > 0);
}

/** What a crate truck loading at storage waits on, when it is crates still in customs. */
export function customsHold(w: World, t: Truck): string {
  const bay = dest(w, t.bayIdx);
  if (t.boxes || !bay?.tiles || holds(w, bay, false).length === 0) return '';
  if (cratesFor(w, t, bay) + (t.coming ?? 0) > 0) return '';
  return `, waiting for crates still in customs: the next clear in ${Math.ceil((nextHold(w, bay, false) / TICKS_PER_DAY) * 24)} h`;
}

/** The cannery's truck bringing canned fish: its export papers are done in the port. */
export function cannedTruck(_w: World, t: Truck): boolean {
  return !!t.exports && !t.boxes && cargoOf(t.value, 'goods') === 'canned';
}

/** A shipper's truck bringing ice. */
export function iceTruck(_w: World, t: Truck): boolean {
  return !!t.exports && !t.boxes && cargoOf(t.value, 'goods') === 'ice';
}

/**
 * Stop storage taking any more cargo, so it empties out, or open it to
 * cargo again.
 */
export function shutStore(w: World, idx: number, shut: boolean): void {
  const b = dest(w, idx);
  if (!b?.tiles || !!b.shut === shut) return;
  b.shut = shut || undefined;
  const what = b.yard ? 'container yard' : 'crate storage';
  if (!shut) return;
  // Say so when that leaves nowhere for the cargo to go.
  const kind = [...(b.yard ? w.yards : w.bays).values()].filter(
    (a) => a.tiles && !!a.outgoing === !!b.outgoing,
  );
  if (kind.every((a) => a.shut)) {
    message(
      w,
      `Every ${b.outgoing ? 'outgoing ' : ''}${what} has stopped taking ${b.yard ? 'containers' : 'crates'}: ${b.outgoing ? "shippers' trucks will wait" : b.yard ? 'the cranes will stop once their stacks fill' : 'forklifts will take crates to the truck bays'}.`,
      'bad',
    );
  }
}

/** Crate storage a jib crane can swing crates off a boat into: in reach and taking them. */
export function jibStows(w: World, c: Crane): boolean {
  return jibStores(w, c).some((a) => takesImports(w, a));
}

/**
 * The crate storage a jib crane swings the next crate off a boat into: the
 * nearest in reach that takes cargo coming in and has room for it on the
 * tiles of it beside the crane, whatever room it has further off. With
 * none, it unloads nothing: it never sets crates down at its feet.
 */
export function jibStore(w: World, c: Crane): Bay | undefined {
  return jibStores(w, c).find(
    (a) => takesImports(w, a) && bayRoom(a, false) > 0 && jibRoom(w, c, a) > 0,
  );
}

/**
 * The stacks of crate storage `b` (by tile) in reach of a jib crane that
 * has no room left there to swing crates into: forklifts take crates off
 * these first, to make room. Empty if there are none.
 */
export function jibCramped(w: World, b: Bay): Set<number> {
  const out = new Set<number>();
  if (!b.tiles || b.yard || !takesImports(w, b)) return out;
  for (const c of w.cranes.values()) {
    if (c.kind !== 'jib' || !jibStores(w, c).includes(b) || jibStore(w, c)) continue;
    for (const n of jibReach(w, c, b)) out.add(n);
  }
  return out;
}

/**
 * Crates in crate storage `b` free to go on the stacks in `stacks` (by
 * tile), less those already spoken for.
 */
export function readyOn(w: World, b: Bay, stacks: Set<number>): number {
  const wait = waitMask(w, b, false);
  const n = crateSlots(w, b).crates.filter(
    (s, i) => !wait[i] && s >= 0 && stacks.has(stackOf(b, s)),
  ).length;
  return n - (b.reserved ?? 0);
}

/** Whether a forklift's load of `n` fits in crate storage `b` off the tiles any jib crane reaches. */
export function offJibRoom(w: World, b: Bay, n: number): boolean {
  if (!b.tiles) return false;
  const near = jibTiles(w, b);
  const off = new Set(b.tiles.map((_, k) => k).filter((k) => !near.has(k)));
  return loadSlot(b, n, usedSlots(w, b), reserved(w, b), w, off) >= 0;
}

/** The stacks of crate storage `b` (by tile) any jib crane reaches. */
export function jibTiles(w: World, b: Bay): Set<number> {
  const out = new Set<number>();
  for (const c of w.cranes.values()) {
    if (c.kind !== 'jib') continue;
    for (const n of jibReach(w, c, b)) out.add(n);
  }
  return out;
}

/** Free places for crates in crate storage `b` on the tiles a jib crane reaches. */
export function jibRoom(w: World, c: Crane, b: Bay): number {
  if (!b.tiles) return bayRoom(b, false);
  const reach = jibReach(w, c, b);
  const used = usedSlots(w, b);
  const kept = reserved(w, b);
  let n = 0;
  for (let s = 0; s < slotCount(b); s++) {
    if (reach.has(stackOf(b, s)) && !used.has(s) && !kept.has(s)) n++;
  }
  return n;
}

/** Trucks can get to this bay or storage area to load. */
export function truckable(w: World, b: Bay): boolean {
  return roadTo(w, b) < Infinity;
}

/** Tiles from `from` to the nearest part of a bay or storage area. */
export function distTo(w: World, from: number, b: Bay): number {
  return b.tiles ? Math.min(...b.tiles.map((t) => w.dist(from, t))) : w.dist(from, b.idx);
}

/**
 * Where a worker coming from `from` sets a load down at a bay, or at the
 * nearest tiles of a storage area they can get to; -1 if they cannot.
 */
export function dropAt(w: World, p: Dockhand, b: Bay, from: number): number {
  if (!b.tiles) return w.pathFor(p, from, b.idx) ? b.idx : -1;
  if (p.kind === 'tractor') return tractorSpot(w, p, b, from);
  if (p.kind === 'stacker' && b.yard) return stackSide(w, p, b, from, 'drop');
  // A forklift sets its pallet down in the next place in crate storage.
  if (p.kind === 'forklift' && !b.yard) {
    const t = palletTile(w, b, false);
    return w.pathFor(p, from, t) ? t : -1;
  }
  const near = [...b.tiles].sort((x, y) => w.dist(from, x) - w.dist(from, y)).slice(0, 4);
  return near.find((t) => w.pathFor(p, from, t)) ?? -1;
}

/**
 * Where a reach stacker stands to work a yard's stacks: on the port road
 * or quay beside its edge, never among them, facing a stack it can reach
 * from there; for `drop`, one with room for another, for `pick` one with
 * a container on top that `ok` lets through (`exports` for exports). The
 * nearest it can get to from `from`, one no other machine has if it can
 * be, or -1.
 */
export function stackSide(
  w: World,
  p: Dockhand,
  b: Bay,
  from: number,
  work: 'drop' | 'pick',
  exports = false,
  ok?: (i: number) => boolean,
): number {
  const tiles = b.tiles ?? [b.idx];
  const spots: number[] = [];
  tiles.forEach((t, n) => {
    const reach = new Set([n]);
    const fits =
      work === 'drop'
        ? nextYardSlot(w, b, undefined, reach) >= 0
        : yardTop(w, b, exports, ok, reach) >= 0;
    if (!fits) return;
    for (const s of stackSides(w, b, t)) if (!spots.includes(s)) spots.push(s);
  });
  spots.sort(
    (x, y) =>
      Number(w.spotTaken(x, p)) - Number(w.spotTaken(y, p)) || w.dist(from, x) - w.dist(from, y),
  );
  return spots.slice(0, 6).find((s) => w.pathFor(p, from, s)) ?? -1;
}

/** Every tile port machines can drive to from their depots. */
export function machineGround(w: World): Set<number> {
  if (w.machineCache) return w.machineCache;
  const m = w.map;
  const seen = new Set<number>();
  const queue: number[] = [];
  for (let i = 0; i < m.build.length; i++) {
    if (m.build[i] === Build.Depot) {
      seen.add(i);
      queue.push(i);
    }
  }
  while (queue.length > 0) {
    const from = queue.pop()!;
    for (const n of m.neighbors4(from)) {
      if (seen.has(n) || !Number.isFinite(w.driveCost(n, from))) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return (w.machineCache = seen);
}

/**
 * Tiles with crates standing on them, this tick, for forklifts to go round:
 * crate storage tiles with pallets on them, truck bays with a stack, piles
 * on the quay and jib cranes' landing stacks.
 */
export function crateTiles(w: World): Set<number> {
  if (w.crateTileCache?.tick === w.tick) return w.crateTileCache.at;
  const at = new Set<number>();
  const per = B.CRATES_PER_STORE_TILE / B.FORKLIFT_CAPACITY;
  const held = (b: Bay) => heldIn(b) > 0;
  for (const b of w.bays.values()) {
    if (b.yard || !held(b)) continue;
    if (!b.tiles) at.add(b.idx);
    else for (const k of palletPlaces(w, b)) if (k >= 0) at.add(b.tiles[Math.floor(k / per)]);
  }
  for (const p of w.piles.values()) if (held(p)) at.add(p.idx);
  for (const c of w.cranes.values()) if (c.kind === 'jib' && c.stack.length > 0) at.add(c.idx);
  w.crateTileCache = { tick: w.tick, at };
  return at;
}

/**
 * Where a stacker can stand beside yard tile `t` to work its stacks: on
 * one of their long sides, as it takes a container side on, never at an
 * end. The containers lie along the yard's long side.
 */
export function stackSides(w: World, b: Bay, t: number): number[] {
  const m = w.map;
  const tiles = b.tiles ?? [b.idx];
  const xs = tiles.map((i) => m.xOf(i));
  const ys = tiles.map((i) => m.yOf(i));
  const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
  const ground = machineGround(w);
  return m
    .neighbors4(t)
    .filter((s) => ground.has(s) && (alongX ? m.xOf(s) === m.xOf(t) : m.yOf(s) === m.yOf(t)));
}

/**
 * The tiles of a yard (by their place in its tiles) with stacks the
 * machines can get at, beside them; with a gantry, it reaches them all.
 */
export function workable(w: World, b: Bay): Set<number> | undefined {
  if (w.yardGantry(b)) return undefined;
  const out = new Set<number>();
  (b.tiles ?? [b.idx]).forEach((t, n) => {
    if (stackSides(w, b, t).length > 0) out.add(n);
  });
  return out.size > 0 ? out : undefined;
}

/** The tiles of a yard (by their place in its tiles) a stacker standing at `at` reaches. */
export function reachFrom(w: World, b: Bay, at: number): Set<number> {
  const m = w.map;
  const out = new Set<number>();
  (b.tiles ?? [b.idx]).forEach((t, n) => {
    if (m.neighbors4(t).includes(at)) out.add(n);
  });
  return out;
}

/**
 * Where a terminal tractor stands for a yard's gantry to lift a container
 * off it or on: in the lane its rails run along, nearest the gantry,
 * clear of other machines and where the trucks load if it can be; -1 if
 * it cannot get there.
 */
export function tractorSpot(w: World, p: Dockhand, yard: Bay, from: number): number {
  const lane = w.gantryLane(yard);
  if (!lane) return -1;
  const trucks = new Set<number>(w.storeSpots(yard));
  // Where a truck stands or is on its way to, and the tile either side of
  // one longer than a tile, is no place to pull in, not while there is another.
  const free = w.freeDockSet(yard, B.MACHINE_LENGTH.tractor);
  const order = [...lane.keys()].sort(
    (a, b) =>
      Number(w.spotTaken(a, p)) - Number(w.spotTaken(b, p)) ||
      Number(trucks.has(a) && !free.has(a)) - Number(trucks.has(b) && !free.has(b)) ||
      Number(trucks.has(a)) - Number(trucks.has(b)) ||
      Math.abs(lane.get(a)!) - Math.abs(lane.get(b)!),
  );
  return order.find((t) => drivable(w.map.build[t]) && w.pathFor(p, from, t)) ?? -1;
}

/**
 * When each container in a yard clears customs, kept in step with its
 * containers; an older save's are clear already.
 */
export function readyList(_w: World, b: Bay): number[] {
  b.boxReady ??= [];
  while (b.boxReady.length < b.boxes.length) b.boxReady.unshift(0);
  if (b.boxReady.length > b.boxes.length) b.boxReady.length = b.boxes.length;
  return b.boxReady;
}

/** Whether customs have cleared a container ready at `r` (see boxReady). */
export function isClear(w: World, r: number): boolean {
  return r >= 0 && r <= w.tick;
}

/** How the containers on a crane's stack look, kept beside them. */
export function stackLooks(_w: World, c: Crane): number[] {
  return (c.stackLooks = aligned(c.stack, c.stackLooks, c.idx));
}

/** How the exports set down for a crane look. */
export function outLooks(_w: World, c: Crane): number[] {
  return (c.outLooks = aligned(c.outStack ?? [], c.outLooks, c.idx + 1));
}

/** How the containers in a yard look. */
export function boxLooks(_w: World, b: Bay): number[] {
  return (b.boxLooks = aligned(b.boxes, b.boxLooks, b.idx));
}

/**
 * The slot each container in a yard is stacked in, and each export,
 * kept beside them: a container set down goes in the lowest free place
 * with one under it, across the whole yard before it goes higher; under
 * a yard gantry, up first (see freeYardSlot).
 */
export function yardSlots(w: World, b: Bay): { boxes: number[]; exports: number[] } {
  const boxes = (b.boxSlots ??= []);
  const exports = (b.exportSlots ??= []);
  if (boxes.length > b.boxes.length) boxes.length = b.boxes.length;
  if (exports.length > (b.outBoxes?.length ?? 0)) exports.length = b.outBoxes?.length ?? 0;
  const cap = bayCap(b);
  const used = new Set<number>();
  for (const list of [boxes, exports]) {
    list.forEach((k, i) => {
      if (k >= cap || used.has(k)) list[i] = -1;
      else used.add(k);
    });
  }
  const ready = readyList(w, b);
  for (const [list, n, out] of [
    [boxes, b.boxes.length, false],
    [exports, b.outBoxes?.length ?? 0, true],
  ] as const) {
    for (let i = 0; i < n; i++) {
      if (i < list.length && list[i] >= 0) continue;
      const k = freeYardSlot(w, b, boxes, exports, out ? undefined : ready[i]);
      list[i] = k;
      used.add(k);
    }
  }
  return { boxes, exports };
}

/**
 * Where a container goes in a yard: on the ground while there is room,
 * then on a stack whose top clears customs no sooner than it does (one
 * off the same ship, or later), so it never buries one that will be
 * ready first; failing that, the lowest free place with one under it.
 * -1 if the yard is full. `ready` is when it clears, as in boxReady.
 * With `strict`, -1 rather than a place that buries one ready sooner.
 */
export function freeYardSlot(
  w: World,
  b: Bay,
  boxes: number[],
  exports: number[],
  ready?: number,
  reach: Set<number> | undefined = workable(w, b),
  strict = false,
): number {
  const cap = bayCap(b);
  const under = new Map<number, number | undefined>();
  const list = readyList(w, b);
  boxes.forEach((k, i) => k >= 0 && under.set(k, list[i]));
  exports.forEach((k) => k >= 0 && under.set(k, undefined));
  // The place its gantry is setting one down in is kept for that.
  const kept = b.gantryTo;
  // When a container leaves, as best known: waiting on its ship to finish
  // last of all, and those from one ship alike.
  const when = (r: number | undefined) => (r === undefined ? Infinity : r < 0 ? 1e12 - r : r);
  // Under a yard gantry, which reaches every stack, it goes up first: on
  // the fullest stack topped by one off the same ship (an export on an
  // export), so a ship's containers fill stacks of their own, clear
  // customs together, and those that come later start new ones rather
  // than bury them.
  if (w.yardGantry(b)) {
    let up = -1;
    for (let k = YARD_STACKS; k < cap; k++) {
      const p = yardPlace(k);
      if (p.tier === 0 || k === kept || under.has(k) || !under.has(k - YARD_STACKS)) continue;
      if (reach && !reach.has(p.tile)) continue;
      const below = under.get(k - YARD_STACKS);
      if (below === ready && (up < 0 || p.tier > yardPlace(up).tier)) up = k;
    }
    if (up >= 0) return up;
  }
  let fallback = -1;
  for (let tier = 0; tier < YARD_TIERS; tier++) {
    for (let k = tier * YARD_STACKS; k < cap; k++) {
      const p = yardPlace(k);
      if (p.tier !== tier || k === kept || under.has(k) || (reach && !reach.has(p.tile))) {
        continue;
      }
      if (tier === 0) return k;
      if (!under.has(k - YARD_STACKS)) continue;
      const below = under.get(k - YARD_STACKS);
      if (ready === undefined || when(below) >= when(ready)) return k;
      if (fallback < 0) fallback = k;
    }
  }
  return strict ? -1 : fallback;
}

/**
 * Containers customs have cleared that a truck cannot get at, with one
 * still in customs on them: for each such stack, the container on top of
 * it, by its place in the yard's list, and the yard tile, those with the
 * fewest on top of a cleared one first.
 */
export function buried(w: World, b: Bay): { at: number; tile: number }[] {
  const slots = yardSlots(w, b);
  const ready = readyList(w, b);
  const index = new Map<number, number>();
  slots.boxes.forEach((k, i) => index.set(k, i));
  const exported = new Set(slots.exports);
  const out: { at: number; tile: number; above: number }[] = [];
  const cap = bayCap(b);
  for (let base = 0; base < cap; base += B.BOXES_PER_STORE_TILE) {
    for (let stack = 0; stack < YARD_STACKS; stack++) {
      let top = -1;
      let above = 0;
      let clearBelow = false;
      for (let tier = YARD_TIERS - 1; tier >= 0; tier--) {
        const k = base + tier * YARD_STACKS + stack;
        if (exported.has(k)) break;
        const i = index.get(k);
        if (i === undefined) continue;
        if (top < 0) top = i;
        if (isClear(w, ready[i])) {
          clearBelow = above > 0;
          break;
        }
        above++;
      }
      if (clearBelow) out.push({ at: top, tile: yardPlace(slots.boxes[top]).tile, above });
    }
  }
  return out.sort((x, y) => x.above - y.above).map(({ at, tile }) => ({ at, tile }));
}

/** How many cleared containers in a yard lie under ones still in customs. */
export function buriedCount(w: World, b: Bay): number {
  return Math.max(0, cleared(w, b) - reachable(w, b));
}

/** Where the next container set down in this yard goes. */
export function nextYardSlot(w: World, b: Bay, ready?: number, reach?: Set<number>): number {
  const { boxes, exports } = yardSlots(w, b);
  return freeYardSlot(w, b, boxes, exports, ready, reach);
}

/**
 * The container in a yard (with `exports`, the export) that can be lifted
 * off the top of its stack, highest first, of those `ok` lets through; -1
 * if none is on top. One with another on it waits until that has gone.
 */
export function yardTop(
  w: World,
  b: Bay,
  exports: boolean,
  ok: (i: number) => boolean = () => true,
  reach?: Set<number>,
): number {
  const slots = yardSlots(w, b);
  const used = new Set([...slots.boxes, ...slots.exports]);
  if (b.gantryTo !== undefined) used.add(b.gantryTo);
  const list = exports ? slots.exports : slots.boxes;
  let best = -1;
  let high = -1;
  list.forEach((k, i) => {
    const { tier, tile } = yardPlace(k);
    if (reach && !reach.has(tile)) return;
    if (tier < YARD_TIERS - 1 && used.has(k + YARD_STACKS)) return;
    if (tier > high && ok(i)) {
      best = i;
      high = tier;
    }
  });
  return best;
}

/** The cleared container on top of its stack a truck takes next from a yard, or -1. */
export function clearTop(w: World, b: Bay, reach?: Set<number>): number {
  const ready = readyList(w, b);
  return yardTop(w, b, false, (i) => isClear(w, ready[i]), reach);
}

/**
 * How many cleared containers trucks can take off a yard one after
 * another: down each stack from the top, until one waiting for customs,
 * or an export, is in the way.
 */
export function reachable(w: World, b: Bay): number {
  const slots = yardSlots(w, b);
  const ready = readyList(w, b);
  const at = new Map<number, boolean>();
  slots.boxes.forEach((k, i) => at.set(k, isClear(w, ready[i])));
  for (const k of slots.exports) at.set(k, false);
  let n = 0;
  const cap = bayCap(b);
  for (let base = 0; base < cap; base += B.BOXES_PER_STORE_TILE) {
    for (let stack = 0; stack < YARD_STACKS; stack++) {
      for (let tier = YARD_TIERS - 1; tier >= 0; tier--) {
        const clear = at.get(base + tier * YARD_STACKS + stack);
        if (clear === undefined) continue;
        if (!clear) break;
        n++;
      }
    }
  }
  return n;
}

/** How the containers waiting in a yard to go out look. */
export function exportLooks(_w: World, b: Bay): number[] {
  return (b.exportLooks = aligned(b.outBoxes ?? [], b.exportLooks, b.idx + 1));
}

/** How the containers a stacker carries look. */
export function carriedLooks(_w: World, p: Dockhand): number[] {
  return (p.cargoLooks = aligned(p.cargoFees, p.cargoLooks, p.id));
}

/** Containers customs have cleared. */
export function cleared(w: World, b: Bay): number {
  return readyList(w, b).filter((r) => isClear(w, r)).length;
}

/** Ticks since the longest-cleared container in this yard cleared customs, or 0. */
export function clearedFor(w: World, b: Bay): number {
  const since = Math.min(Infinity, ...readyList(w, b).filter((r) => isClear(w, r)));
  return Number.isFinite(since) ? w.tick - since : 0;
}

/** Containers whose ship is still being unloaded, so customs have not started on them. */
export function pending(w: World, b: Bay): number {
  return readyList(w, b).filter((r) => r < 0).length;
}

/** Ticks until the next container in this yard clears customs, or -1. */
export function nextClear(w: World, b: Bay): number {
  const next = Math.min(Infinity, ...readyList(w, b).filter((r) => r > w.tick));
  return Number.isFinite(next) ? next - w.tick : -1;
}

/** What a truck could take away from this bay now. */
export function collectable(w: World, b: Bay): number {
  return readyIn(w, b, false) + (b.yard ? reachable(w, b) : b.boxes.length);
}
