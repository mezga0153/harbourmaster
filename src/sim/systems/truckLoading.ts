// Loading and unloading trucks by hand and by machine: which crates a truck may
// take, the dockhands' and forklifts' jobs to and from the trucks, ice coming
// in, and the stackers at the container yards.

import type { World } from '../world';
import { handlingTicks } from './workforce/crowding';
import { headTo, walk } from './workforce/dockhands';
import {
  boxLooks,
  carriedLooks,
  clearTop,
  exportLooks,
  nearerMachine,
  nextYardSlot,
  reachFrom,
  reachable,
  readyList,
  stackSides,
  workersAt,
  yardSlots,
} from './cargo/stores';
import { cancelJob, dest, readyIn, startHolds, takeReady, waitMask } from './cargo/customs';
import type { Bay, Dockhand, Truck } from '../state';
import { onPallet, palletTile, stackedAt, takenFrom } from './yardGantry';
import * as B from '../balance';
import { boxLookOf, isBoxy, isMachine, loadTicks } from '../helpers';
import type { Source } from '../helpers';
import { cargoOf } from '../cargo';
import type { Cargo } from '../cargo';
import { BUSINESSES } from '../town';
import { tip } from './output';

/** Ticks a truck takes to load or unload one at a bay or yard: a yard gantry lifts at its own pace. */
export function truckTicks(w: World, t: Truck, bay: Bay): number {
  return t.boxes && bay.yard && w.yardGantry(bay) ? B.YARD_GANTRY_TICKS : loadTicks(bay);
}

/** A container truck at a yard with no gantry, which reach stackers load or unload. */
export function byStacker(w: World, t: Truck, bay: Bay): boolean {
  return t.boxes && !!bay.yard && !w.yardGantry(bay);
}

/**
 * A crate truck at a truck bay or crate storage, which only dockhands and
 * forklifts load: it has no crew of its own.
 */
export function byHand(_w: World, t: Truck, bay: Bay): boolean {
  return !t.boxes && !bay.yard && !bay.pile;
}

/**
 * A crate truck loading at the truck bay a dockhand or forklift brings
 * crates to, with room for them all: they go straight onto it.
 */
export function straightOnto(w: World, p: Dockhand, bay: Bay): Truck | undefined {
  if (isBoxy(p) || p.outbound || p.truckId !== undefined || bay.tiles || p.carrying <= 0) {
    return undefined;
  }
  // Only onto a truck that may take that kind of crate.
  return w.trucks.find(
    (t) =>
      t.state === 'loading' &&
      t.bayIdx === bay.idx &&
      p.cargoFees.every(fitsTruck(w, t)) &&
      byHand(w, t, bay) &&
      t.cargo + (t.coming ?? 0) + p.carrying <= t.capacity,
  );
}

/**
 * Whether someone else is at work at this truck bay, setting crates down
 * on its stack or loading the truck in it: only one at a time works one.
 */
export function bayTaken(w: World, p: Dockhand, bay: Bay): boolean {
  if (bay.tiles || bay.yard || bay.pile) return false;
  return w.people.some(
    (q) =>
      q !== p &&
      ((q.state === 'dropping' && q.bayIdx === bay.idx) ||
        (q.truckId !== undefined && q.stockIdx === bay.idx && q.state === 'picking')),
  );
}

/**
 * Crate trucks waiting to be loaded, for dockhands and forklifts; and
 * shippers' trucks waiting to be unloaded, their crates set down in the
 * outgoing storage beside them, or an ice works' ice on its truck bay's
 * stack for the fishing boats.
 */
export function crateTruckSources(w: World, sources: Source[]): void {
  for (const t of w.trucks) {
    if (t.state === 'delivering') {
      const bay = dest(w, t.bayIdx);
      const avail = t.cargo - (t.taking ?? 0);
      if (bay && byHand(w, t, bay) && avail > 0) {
        sources.push({ tile: crateTruckSpot(w, bay, t), avail, truck: t, load: false, rank: 1 });
      }
      continue;
    }
    if (t.state !== 'loading') continue;
    const bay = dest(w, t.bayIdx);
    if (!bay || !byHand(w, t, bay)) continue;
    // Loaded from the stack till it is full or the stack is gone; crates
    // brought meanwhile go straight on while there is room on it.
    const avail = Math.min(t.capacity - t.cargo - (t.coming ?? 0), cratesFor(w, t, bay));
    if (avail <= 0) continue;
    // Once the boats are seen to, nearest first, as crates in storage are.
    sources.push({ tile: crateTruckSpot(w, bay, t), avail, truck: t, load: true, rank: 1 });
  }
}

/**
 * A shipper's crate truck standing to be unloaded with no dockhand or
 * forklift on the way to it or at it.
 */
export function unloadWaiting(w: World, t: Truck): boolean {
  if (t.state !== 'delivering' || t.cargo <= 0 || (t.taking ?? 0) > 0) return false;
  const bay = dest(w, t.bayIdx);
  return !!bay && byHand(w, t, bay) && !w.people.some((p) => p.truckId === t.id);
}

/** Whether a business in town still takes crates of this kind today. */
export function wantedToday(w: World, c: Cargo): boolean {
  const wants = w.town?.wants ?? {};
  for (const [code, n] of Object.entries(wants)) {
    if ((n ?? 0) >= 1 && BUSINESSES[Number(code)]?.takes.includes(c)) return true;
  }
  return false;
}

/**
 * Which crates a crate truck may take on: only those of its kind, so
 * whatever it brings the town is all for one business; but any, once
 * the town takes no more of its kind or theirs today, as then they all go
 * out by road.
 */
export function fitsTruck(w: World, t: Truck): (fee: number) => boolean {
  const kind = t.kind;
  if (!kind) return () => true;
  const mine = wantedToday(w, kind);
  const wanted = new Map<Cargo, boolean>();
  return (fee) => {
    const c = cargoOf(fee);
    if (c === kind) return true;
    if (mine) return false;
    if (!wanted.has(c)) wanted.set(c, wantedToday(w, c));
    return !wanted.get(c);
  };
}

/**
 * Crates at a bay a crate truck could still have, of the kind it takes,
 * that no dockhand or forklift is already going for.
 */
export function cratesFor(w: World, t: Truck, bay: Bay): number {
  // Crates still in customs wait: no truck may have them yet.
  const free = readyIn(w, bay, false) - (bay.reserved ?? 0);
  if (!t.kind || free <= 0) return free;
  const fits = fitsTruck(w, t);
  const wait = waitMask(w, bay, false);
  let n = 0;
  bay.crates.forEach((f, i) => {
    if (!wait[i] && fits(f)) n++;
  });
  return Math.min(free, n);
}

/**
 * Up to `n` crates off a bay for a crate truck: those from `at` on, as
 * long as it may take them all; else the first it may take. The first it
 * ever takes sets its kind.
 */
export function cratesOff(w: World, t: Truck, bay: Bay, at: number, n: number): number[] {
  if (n <= 0 || bay.crates.length === 0) return [];
  // Never one still in customs: the top one that is not, if those are.
  const wait = waitMask(w, bay, false);
  if (at < 0 || at >= bay.crates.length || wait[at]) at = wait.lastIndexOf(false);
  if (at < 0) return [];
  t.kind ??= cargoOf(bay.crates[at]);
  return takeReady(w, bay, false, at, n, fitsTruck(w, t));
}

/**
 * Where a dockhand or forklift loading a crate truck takes the crates
 * from: the truck bay it stands in, or the tile of the crate storage
 * beside where it stands, nearest it.
 */
export function crateTruckSpot(w: World, bay: Bay, t: Truck): number {
  if (!bay.tiles) return bay.idx;
  const at = w.tileOf(t);
  const m = w.map;
  return [...bay.tiles].sort(
    (a, b) =>
      Math.hypot(m.xOf(a) - m.xOf(at), m.yOf(a) - m.yOf(at)) -
      Math.hypot(m.xOf(b) - m.xOf(at), m.yOf(b) - m.yOf(at)),
  )[0];
}

/** Send a dockhand or forklift to load a crate truck: as many as it carries a trip. */
export function takeCrateTruckJob(w: World, p: Dockhand, src: Source): boolean {
  const t = src.truck!;
  const bay = dest(w, t.bayIdx);
  // One at a time loads a truck bay's trucks, however many stand about
  // there waiting to set crates down.
  if (!bay) return false;
  if (bay.tiles && workersAt(w, src.tile) >= B.WORKERS_PER_SPOT) return false;
  if (
    !bay.tiles &&
    w.people.some((q) => q !== p && q.truckId !== undefined && q.stockIdx === bay.idx)
  ) {
    return false;
  }
  if (isMachine(p) && nearerMachine(w, p, src.tile)) return false;
  // Off a shipper's truck into storage, or ice onto the bay's stack: as
  // many as it carries.
  const unload = !src.load;
  const room = unload
    ? t.cargo - (t.taking ?? 0)
    : Math.min(t.capacity - t.cargo - (t.coming ?? 0), cratesFor(w, t, bay));
  const n = Math.min(p.capacity, src.avail, room);
  if (n <= 0) return false;
  if (!headTo(w, p, src.tile)) return false;
  if (unload) t.taking = (t.taking ?? 0) + n;
  else {
    bay.reserved = (bay.reserved ?? 0) + n;
    t.coming = (t.coming ?? 0) + n;
  }
  p.truckId = t.id;
  p.truckLoad = !unload;
  p.bayIdx = bay.idx;
  p.stockIdx = bay.idx;
  p.planned = n;
  p.boatId = -1;
  p.craneIdx = -1;
  p.state = 'toPickup';
  return true;
}

/**
 * A dockhand or forklift loading a crate truck: to the crates, picks them
 * up, and sets them on the truck beside it. True while it is at it.
 */
export function crateTruckJob(w: World, p: Dockhand): boolean {
  const t = w.trucks.find((q) => q.id === p.truckId);
  const bay = dest(w, p.bayIdx);
  const unload = !p.truckLoad;
  const live =
    !!t && !!bay && t.bayIdx === bay.idx && t.state === (unload ? 'delivering' : 'loading');
  if (unload) return unloadTruckJob(w, p, t, bay, live);
  switch (p.state) {
    case 'toPickup': {
      if (!live) {
        cancelJob(w, p);
        return true;
      }
      const r = walk(w, p);
      if (r === 'blocked') cancelJob(w, p);
      else if (r === 'arrived' && !bayTaken(w, p, bay)) {
        p.state = 'picking';
        p.timer = handlingTicks(w, p, B.PICK_TICKS);
      }
      return true;
    }
    case 'picking': {
      if (--p.timer > 0) return true;
      if (!live) {
        cancelJob(w, p);
        return true;
      }
      bay.reserved = Math.max(0, (bay.reserved ?? 0) - p.planned);
      const n = Math.min(p.planned, bay.crates.length, onPallet(w, p, bay));
      const fees = cratesOff(
        w,
        t,
        bay,
        bay.tiles ? takenFrom(w, p, bay, n) : bay.crates.length - n,
        n,
      );
      // Fewer than it went for: the truck waits for none of the rest.
      t.coming = Math.max(0, (t.coming ?? 0) - (p.planned - fees.length));
      if (fees.length === 0) {
        endTruckJob(w, p);
        return true;
      }
      p.planned = fees.length;
      p.carrying = fees.length;
      p.cargoFees = fees;
      // The truck is right beside it.
      p.state = 'dropping';
      p.timer = handlingTicks(w, p, B.DROP_TICKS);
      return true;
    }
    case 'dropping': {
      if (--p.timer > 0) return true;
      landCrates(w, p, t, bay, live);
      endTruckJob(w, p);
      return true;
    }
  }
  return false;
}

/**
 * A dockhand or forklift unloading a shipper's truck: to the truck, takes
 * crates off the top of its bed, and carries them to the next free place
 * in the storage beside it, where their export papers start; or an ice
 * works' ice onto its truck bay's stack for the fishing boats. True while
 * it is at it.
 */
export function unloadTruckJob(
  w: World,
  p: Dockhand,
  t: Truck | undefined,
  bay: Bay | undefined,
  live: boolean,
): boolean {
  switch (p.state) {
    case 'toPickup': {
      if (!live) {
        releaseTruckJob(w, p);
        return true;
      }
      const r = walk(w, p);
      if (r === 'blocked') releaseTruckJob(w, p);
      else if (r === 'arrived' && !bayTaken(w, p, bay!)) {
        p.state = 'picking';
        p.timer = handlingTicks(w, p, B.PICK_TICKS);
      }
      return true;
    }
    case 'picking': {
      if (--p.timer > 0) return true;
      if (!live) {
        releaseTruckJob(w, p);
        return true;
      }
      const n = Math.min(p.planned, t!.cargo);
      t!.taking = Math.max(0, (t!.taking ?? 0) - p.planned);
      t!.cargo -= n;
      if (n === 0) {
        endTruckJob(w, p);
        return true;
      }
      p.planned = n;
      p.carrying = n;
      p.cargoFees = Array(n).fill(t!.value);
      p.cargoLooks = Array.from({ length: n }, (_, k) => boxLookOf(t!.id, t!.cargo + k));
      // On to the place in storage they go, unless it is right here; a
      // truck bay's stack is right beside the truck.
      const tile = bay?.tiles ? palletTile(w, bay, false, false) : -1;
      if (tile >= 0 && tile !== w.tileOf(p) && headTo(w, p, tile)) {
        p.state = 'toDrop';
        return true;
      }
      p.state = 'dropping';
      p.timer = handlingTicks(w, p, B.DROP_TICKS);
      return true;
    }
    case 'toDrop': {
      // Set down where it is if it cannot get there.
      const r = walk(w, p);
      if (r !== 'arrived' && r !== 'blocked') return true;
      p.state = 'dropping';
      p.timer = handlingTicks(w, p, B.DROP_TICKS);
      return true;
    }
    case 'dropping': {
      if (--p.timer > 0) return true;
      landUnloaded(w, p, bay);
      endTruckJob(w, p);
      return true;
    }
  }
  return false;
}

/**
 * Crates a dockhand or forklift has off a shipper's truck: into its
 * outgoing storage, where canned fish waits for its export papers; ice
 * onto the truck bay's stack, for the boats.
 */
export function landUnloaded(w: World, p: Dockhand, bay: Bay | undefined): void {
  if (p.carrying <= 0 || !bay) return;
  exportLooks(w, bay).push(...carriedLooks(w, p));
  (bay.exports ??= []).push(...p.cargoFees);
  startHolds(w, bay, p.cargoFees, true);
  bay.exportIncoming = Math.max(0, (bay.exportIncoming ?? 0) - p.carrying);
  tip(w, 'exports');
}

/** Crates a dockhand or forklift has for a truck: on it if it is still loading, else back where they came from. */
export function landCrates(
  _w: World,
  p: Dockhand,
  t: Truck | undefined,
  bay: Bay | undefined,
  live: boolean,
): void {
  if (p.carrying <= 0) return;
  if (t) t.coming = Math.max(0, (t.coming ?? 0) - p.carrying);
  if (live && t) {
    t.cargo += p.carrying;
    t.value += p.cargoFees.reduce((n, f) => n + f, 0);
    (t.fees ??= []).push(...p.cargoFees);
    t.idle = 0;
  } else if (bay) bay.crates.push(...p.cargoFees);
}

/** Trucks waiting at yards with no gantry, for reach stackers to load or unload. */
export function truckSources(w: World, sources: Source[]): void {
  for (const t of w.trucks) {
    const load = t.state === 'loading';
    if (!load && t.state !== 'delivering') continue;
    const yard = w.yards.get(t.bayIdx);
    if (!yard || !byStacker(w, t, yard)) continue;
    const avail = load
      ? Math.min(
          t.capacity - t.cargo - (t.coming ?? 0),
          reachable(w, yard) - (yard.truckReserved ?? 0),
        )
      : t.cargo - (t.taking ?? 0);
    if (avail <= 0) continue;
    // A truck was only sent in because a stacker was free for it: it comes first.
    for (const tile of besideTruck(w, yard, t, load)) {
      sources.push({ tile, avail, truck: t, load, rank: -1 });
    }
  }
}

/**
 * Where a stacker may stand to work a truck at a yard: beside the edge
 * of the stacks, by a stack with a cleared container on top to load it
 * with, or room for one off it; nearest the truck first.
 */
export function besideTruck(w: World, yard: Bay, t: Truck, load: boolean): number[] {
  const m = w.map;
  const near = (i: number) => Math.hypot(m.xOf(i) + 0.5 - t.x, m.yOf(i) + 0.5 - t.y);
  const spots = new Set<number>();
  (yard.tiles ?? [yard.idx]).forEach((tile, n) => {
    const reach = new Set([n]);
    const fits = load
      ? clearTop(w, yard, reach) >= 0
      : nextYardSlot(w, yard, undefined, reach) >= 0;
    if (!fits) return;
    for (const s of stackSides(w, yard, tile)) spots.add(s);
  });
  return [...spots].sort((a, b) => near(a) - near(b)).slice(0, 4);
}

/** Send a stacker to load a truck at a yard, or unload one: one container a trip. */
export function takeTruckJob(w: World, p: Dockhand, src: Source): boolean {
  const t = src.truck!;
  const yard = w.yards.get(t.bayIdx);
  // One stacker at a time works a truck; a nearer free one takes it.
  if (!yard || workersAt(w, src.tile) > 0 || nearerMachine(w, p, src.tile)) return false;
  if (!headTo(w, p, src.tile)) return false;
  if (src.load) {
    yard.truckReserved = (yard.truckReserved ?? 0) + 1;
    t.coming = (t.coming ?? 0) + 1;
  } else t.taking = (t.taking ?? 0) + 1;
  p.truckId = t.id;
  p.truckLoad = !!src.load;
  p.bayIdx = yard.idx;
  p.planned = 1;
  p.boatId = -1;
  p.craneIdx = -1;
  p.stockIdx = -1;
  p.state = 'toPickup';
  return true;
}

/**
 * A stacker moving a container between a yard and the truck beside it:
 * off the stack onto the truck, or off a shipper's truck onto the stack.
 * True while it is at it.
 */
export function truckJob(w: World, p: Dockhand): boolean {
  const t = w.trucks.find((q) => q.id === p.truckId);
  const yard = w.yards.get(p.bayIdx);
  const live =
    !!t && !!yard && t.bayIdx === yard.idx && t.state === (p.truckLoad ? 'loading' : 'delivering');
  switch (p.state) {
    case 'toPickup': {
      if (!live) {
        cancelJob(w, p);
        return true;
      }
      const r = walk(w, p);
      if (r === 'blocked') cancelJob(w, p);
      else if (r === 'arrived') {
        p.state = 'picking';
        p.timer = handlingTicks(w, p, B.PICK_TICKS);
      }
      return true;
    }
    case 'picking': {
      if (--p.timer > 0) return true;
      if (!live) {
        cancelJob(w, p);
        return true;
      }
      let fee: number | undefined;
      if (p.truckLoad) {
        yard.truckReserved = Math.max(0, (yard.truckReserved ?? 0) - 1);
        // Only what customs have cleared, whichever that is.
        const ready = readyList(w, yard);
        const at = clearTop(w, yard, reachFrom(w, yard, p.goal));
        if (at >= 0) {
          yardSlots(w, yard).boxes.splice(at, 1);
          ready.splice(at, 1);
          p.cargoLooks = boxLooks(w, yard).splice(at, 1);
          fee = yard.boxes.splice(at, 1)[0];
        } else t.coming = Math.max(0, (t.coming ?? 0) - 1);
      } else {
        t.taking = Math.max(0, (t.taking ?? 0) - 1);
        if (t.cargo > 0) {
          t.cargo--;
          fee = t.value;
          p.cargoLooks = [boxLookOf(t.id, t.cargo)];
        }
      }
      if (fee === undefined) {
        endTruckJob(w, p);
        return true;
      }
      p.carrying = 1;
      p.cargoFees = [fee];
      // The truck is right there: straight on, or straight down.
      p.state = 'dropping';
      p.timer = handlingTicks(w, p, B.DROP_TICKS);
      return true;
    }
    case 'dropping': {
      if (--p.timer > 0) return true;
      landTruckLoad(w, p, t, yard, live);
      endTruckJob(w, p);
      return true;
    }
  }
  return false;
}

/**
 * Set down what a stacker took from a yard or a truck: on the truck if it
 * is still there to load, else back on the stack; exports onto the stack.
 */
export function landTruckLoad(
  w: World,
  p: Dockhand,
  t: Truck | undefined,
  yard: Bay | undefined,
  live: boolean,
): void {
  const fee = p.cargoFees[0];
  if (fee === undefined) return;
  if (p.truckLoad) {
    if (t) t.coming = Math.max(0, (t.coming ?? 0) - 1);
    if (live && t) {
      t.cargo++;
      t.value += fee;
      (t.looks ??= []).push(...carriedLooks(w, p));
      t.idle = 0;
    } else if (yard) {
      readyList(w, yard).push(0);
      boxLooks(w, yard).push(...carriedLooks(w, p));
      yard.boxes.push(fee);
    }
  } else if (yard) {
    // On a stack it reaches from where it stands, if it can.
    const slots = yardSlots(w, yard);
    const at = stackedAt(w, p, yard);
    if (at >= 0) slots.exports.push(at);
    exportLooks(w, yard).push(...carriedLooks(w, p));
    (yard.exports ??= []).push(fee);
    yard.exportIncoming = Math.max(0, (yard.exportIncoming ?? 0) - 1);
  }
}

/** Give back what a truck job promised, setting down anything in hand. */
export function releaseTruckJob(w: World, p: Dockhand): void {
  if (p.truckId === undefined) return;
  const t = w.trucks.find((q) => q.id === p.truckId);
  if (!isBoxy(p) && !p.truckLoad) {
    // Crates or ice off a truck: set down anyway, or the promise given back.
    if (p.carrying > 0) landUnloaded(w, p, dest(w, p.bayIdx));
    else if (t) t.taking = Math.max(0, (t.taking ?? 0) - p.planned);
    return endTruckJob(w, p);
  }
  if (!isBoxy(p)) {
    // Crates for a truck: back where they came from, or the promise given back.
    const bay = dest(w, p.bayIdx);
    if (p.carrying > 0) landCrates(w, p, t, bay, false);
    else {
      if (bay) bay.reserved = Math.max(0, (bay.reserved ?? 0) - p.planned);
      if (t) t.coming = Math.max(0, (t.coming ?? 0) - p.planned);
    }
    return endTruckJob(w, p);
  }
  const yard = w.yards.get(p.bayIdx);
  if (p.carrying > 0) landTruckLoad(w, p, t, yard, false);
  else if (p.truckLoad) {
    if (yard) yard.truckReserved = Math.max(0, (yard.truckReserved ?? 0) - 1);
    if (t) t.coming = Math.max(0, (t.coming ?? 0) - 1);
  } else if (t) t.taking = Math.max(0, (t.taking ?? 0) - 1);
  endTruckJob(w, p);
}

export function endTruckJob(_w: World, p: Dockhand): void {
  p.truckId = undefined;
  p.truckLoad = undefined;
  p.carrying = 0;
  p.cargoFees = [];
  p.planned = 0;
  p.bayIdx = -1;
  p.stockIdx = -1;
  p.state = 'idle';
}
