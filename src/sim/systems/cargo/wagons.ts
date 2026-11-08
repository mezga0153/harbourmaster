// Containers on a port train's flat wagons: a cell for each place one
// stands (see PortVisit.cells), filled and emptied by reach stackers
// working from a container yard beside the siding, one container a trip,
// as they work the trucks at a yard.

import type { World } from '../../world';
import * as B from '../../balance';
import type { Bay, Crate, Dockhand } from '../../state';
import type { Source } from '../../helpers';
import { CAR_LENGTH, pointAt, type Train } from '../../railway';
import { sidings, type Siding } from '../../rules/rails';
import { handlingTicks } from '../workforce/crowding';
import { headTo, walk } from '../workforce/dockhands';
import {
  boxLooks,
  carriedLooks,
  clearTop,
  nearerMachine,
  nextYardSlot,
  putBox,
  reachable,
  reachFrom,
  stackSides,
  takeBox,
  takesExports,
  yardSlots,
  takesImports,
  workersAt,
} from './stores';
import {
  gantryTractor,
  keepGantryTo,
  liftDone,
  liftTaken,
  slotAlong,
  stackedAt,
  startLift,
} from '../yardGantry';
import { cancelJob } from './customs';
import { sidingOf } from '../trains';

type PortTrain = Train & { port: NonNullable<Train['port']> };

/** A port train's wagon cells, as many as its flat wagons carry. */
export function wagonCells(t: PortTrain): (Crate | null)[] {
  const n = t.cars.filter((c) => c !== 'loco').length * B.WAGON_BOXES;
  const cells = (t.port.cells ??= []);
  while (cells.length < n) cells.push(null);
  return cells;
}

/** Containers on board going inland (or, `out`, brought to go out on the ships). */
export function aboard(t: PortTrain, out: boolean): number {
  return wagonCells(t).filter((c) => c && !!c.out === out).length;
}

/** Where the wagon holding cell `k` stands, while the train stands in its siding. */
export function cellPoint(t: Train, k: number): { x: number; y: number } {
  // Counted from the locomotive at the buffer stop end.
  const wagon = Math.floor(k / B.WAGON_BOXES) + 1;
  const half = (k % B.WAGON_BOXES) - (B.WAGON_BOXES - 1) / 2;
  return pointAt(t.way, t.at - (wagon + 0.5 + half * 0.46) * CAR_LENGTH);
}

/** The container yards a siding's trains are worked from: any lying along it, a row or two off. */
export function yardsBeside(w: World, s: Siding): Bay[] {
  const m = w.map;
  const along = new Map(s.tiles.map((t) => [m.xOf(t), m.yOf(t)]));
  return [...w.yards.values()].filter((y) =>
    (y.tiles ?? [y.idx]).some((t) => {
      const row = along.get(m.xOf(t));
      return row !== undefined && Math.abs(m.yOf(t) - row) <= B.SIDING_REACH;
    }),
  );
}

/** Whether a container yard lies beside a siding: trains work it, if no truck does. */
export function bySiding(w: World, yard: Bay): boolean {
  return !!yard.yard && sidings(w.map).some((s) => yardsBeside(w, s).includes(yard));
}

/** A port train standing in its siding to be worked, with the siding. */
function standing(w: World): { t: PortTrain; s: Siding }[] {
  const out: { t: PortTrain; s: Siding }[] = [];
  for (const t of w.rail.trains) {
    // Container trains only: hopper wagons are filled at a loadout.
    if (t.port?.state !== 'standing' || t.port.contractId === undefined || t.port.hoppers) continue;
    const s = sidingOf(w, t);
    if (s) out.push({ t: t as PortTrain, s });
  }
  return out;
}

/** Containers a train standing in its siding still wants off the yards. */
export function stillWants(t: PortTrain): number {
  const cells = wagonCells(t);
  const free = cells.filter((c) => !c).length - (t.port.coming ?? 0);
  return Math.max(0, Math.min(free, (t.port.take ?? 0) - aboard(t, false) - (t.port.coming ?? 0)));
}

/**
 * Where a stacker may stand to work a wagon from a yard: beside the edge
 * of the stacks, by one with a cleared container on top to load it with,
 * or room for one off it; nearest the wagon first.
 */
function besideWagon(w: World, yard: Bay, at: { x: number; y: number }, load: boolean): number[] {
  const m = w.map;
  const near = (i: number) => Math.hypot(m.xOf(i) + 0.5 - at.x, m.yOf(i) + 0.5 - at.y);
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

/** The cell nearest `x, y` that is free (`free`) or holds an export. */
function nearestCell(t: PortTrain, x: number, y: number, free: boolean): number {
  let best = -1;
  let bestD = Infinity;
  wagonCells(t).forEach((c, k) => {
    if (free ? c : !c?.out) return;
    const p = cellPoint(t, k);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  });
  return best;
}

/** Trains standing in their sidings, for reach stackers to load from the yards beside them or unload into them. */
export function wagonSources(w: World, sources: Source[]): void {
  for (const { t, s } of standing(w)) {
    const yards = yardsBeside(w, s);
    const wants = stillWants(t);
    const exports = aboard(t, true) - (t.port.taking ?? 0);
    for (const yard of yards) {
      // A gantry over the siding works the train from this yard itself.
      if (gantryOverSiding(w, yard, s)) continue;
      if (wants > 0 && takesImports(w, yard)) {
        const avail = Math.min(wants, reachable(w, yard) - (yard.truckReserved ?? 0));
        if (avail > 0) {
          const k = Math.max(0, nearestCell(t, w.map.xOf(yard.idx), w.map.yOf(yard.idx), true));
          for (const tile of besideWagon(w, yard, cellPoint(t, k), true)) {
            sources.push({ tile, avail, train: t, yard, load: true, rank: -1 });
          }
        }
      }
      if (exports > 0 && takesExports(w, yard)) {
        const k = Math.max(0, nearestCell(t, w.map.xOf(yard.idx), w.map.yOf(yard.idx), false));
        for (const tile of besideWagon(w, yard, cellPoint(t, k), false)) {
          sources.push({ tile, avail: exports, train: t, yard, load: false, rank: -1 });
        }
      }
    }
  }
}

/** Send a stacker to load a wagon from a yard, or unload one into it: one container a trip. */
export function takeWagonJob(w: World, p: Dockhand, src: Source): boolean {
  const t = src.train as PortTrain | undefined;
  const yard = src.yard;
  if (!t?.port || !yard || workersAt(w, src.tile) > 0 || nearerMachine(w, p, src.tile))
    return false;
  if (!headTo(w, p, src.tile)) return false;
  if (src.load) {
    yard.truckReserved = (yard.truckReserved ?? 0) + 1;
    t.port.coming = (t.port.coming ?? 0) + 1;
  } else t.port.taking = (t.port.taking ?? 0) + 1;
  p.trainId = t.id;
  p.trainLoad = !!src.load;
  p.bayIdx = yard.idx;
  p.planned = 1;
  p.boatId = -1;
  p.craneIdx = -1;
  p.stockIdx = -1;
  p.state = 'toPickup';
  return true;
}

/** The train a stacker's job is for, while it stands in its siding. */
function jobTrain(w: World, p: Dockhand): PortTrain | undefined {
  const t = w.rail.trains.find((q) => q.id === p.trainId);
  return t?.port?.state === 'standing' ? (t as PortTrain) : undefined;
}

/**
 * A stacker moving a container between a yard and a wagon: off the stack
 * onto the wagon, or off the wagon onto the stack. True while it is at it.
 */
export function wagonJob(w: World, p: Dockhand): boolean {
  const t = jobTrain(w, p);
  const yard = w.yards.get(p.bayIdx);
  const live = !!t && !!yard;
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
      let box: Crate | undefined;
      if (p.trainLoad) {
        yard.truckReserved = Math.max(0, (yard.truckReserved ?? 0) - 1);
        // Only what customs have cleared.
        const at = clearTop(w, yard, reachFrom(w, yard, p.goal));
        if (at >= 0) {
          boxLooks(w, yard);
          box = takeBox(w, yard, at);
        } else t.port.coming = Math.max(0, (t.port.coming ?? 0) - 1);
      } else {
        t.port.taking = Math.max(0, (t.port.taking ?? 0) - 1);
        const k = nearestCell(t, p.x, p.y, false);
        if (k >= 0) {
          const cells = wagonCells(t);
          box = cells[k]!;
          cells[k] = null;
        }
      }
      if (!box) {
        endWagonJob(w, p);
        return true;
      }
      p.carrying = 1;
      p.load = [box];
      p.state = 'dropping';
      p.timer = handlingTicks(w, p, B.DROP_TICKS);
      return true;
    }
    case 'dropping': {
      if (--p.timer > 0) return true;
      landWagonLoad(w, p, t, yard);
      endWagonJob(w, p);
      return true;
    }
  }
  return false;
}

/**
 * Set down what a stacker took: onto the wagon nearest if the train still
 * stands there, else back on the stack; exports off a wagon onto the stack.
 */
function landWagonLoad(
  w: World,
  p: Dockhand,
  t: PortTrain | undefined,
  yard: Bay | undefined,
): void {
  const box = p.load[0];
  if (!box) return;
  carriedLooks(w, p);
  if (p.trainLoad) {
    if (t) t.port.coming = Math.max(0, (t.port.coming ?? 0) - 1);
    const k = t ? nearestCell(t, p.x, p.y, true) : -1;
    if (t && k >= 0) {
      box.at = w.tick;
      delete box.out;
      wagonCells(t)[k] = box;
    } else if (yard) putBox(w, yard, { ...box, ready: 0 }, false);
  } else if (yard) {
    putBox(w, yard, box, true, stackedAt(w, p, yard));
  }
}

/** Give back what a wagon job promised, setting down anything in hand. */
export function releaseWagonJob(w: World, p: Dockhand): void {
  if (p.trainId === undefined) return;
  const t = jobTrain(w, p);
  const yard = w.yards.get(p.bayIdx);
  if (p.carrying > 0) landWagonLoad(w, p, undefined, yard);
  else if (p.trainLoad) {
    if (yard) yard.truckReserved = Math.max(0, (yard.truckReserved ?? 0) - 1);
    if (t) t.port.coming = Math.max(0, (t.port.coming ?? 0) - 1);
  } else if (t) t.port.taking = Math.max(0, (t.port.taking ?? 0) - 1);
  endWagonJob(w, p);
}

export function endWagonJob(_w: World, p: Dockhand): void {
  p.trainId = undefined;
  p.trainLoad = undefined;
  p.carrying = 0;
  p.load = [];
  p.planned = 0;
  p.bayIdx = -1;
  p.stockIdx = -1;
  p.state = 'idle';
}

/** Whether a yard's gantry stands over the siding, its rails along the track, to load the trains on it. */
export function gantryOverSiding(w: World, yard: Bay, s: Siding): boolean {
  const lane = w.gantryLane(yard);
  return !!lane && s.tiles.some((t) => lane.has(t));
}

/** Where a wagon's cell stands along a yard gantry's rails, or null off them. */
function cellAlong(w: World, yard: Bay, t: Train, k: number): number | null {
  const p = cellPoint(t, k);
  const m = w.map;
  const tile = m.idx(Math.floor(p.x), Math.floor(p.y));
  return w.gantryLane(yard)?.get(tile) ?? null;
}

/**
 * The cell of a train in reach of a yard's gantry, free (`free`) or with
 * an export on it, nearest where the gantry stands; -1 if none.
 */
function gantryCell(w: World, yard: Bay, t: PortTrain, free: boolean): number {
  let best = -1;
  let bestD = Infinity;
  wagonCells(t).forEach((c, k) => {
    if (free ? c : !c?.out) return;
    const along = cellAlong(w, yard, t, k);
    if (along === null) return;
    const d = Math.abs(along - (yard.gantryAt ?? 0));
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  });
  return best;
}

/**
 * Yard gantries standing over a siding unload and load the train in it,
 * a container a lift, as they do the trucks: what it brought off first,
 * then what it takes on. Trucks and tractors under them go first.
 */
export function gantryWagons(w: World): void {
  for (const yard of w.yards.values()) if ((yard.gantryOn ?? 0) < 0) runWagonLift(w, yard);
  for (const { t, s } of standing(w)) {
    for (const yard of yardsBeside(w, s)) {
      if (yard.gantryOn !== undefined || yard.gantryHeld || !gantryOverSiding(w, yard, s)) continue;
      if (w.gantryTruck(yard) || gantryTractor(w, yard)) continue;
      startWagonLift(w, yard, t);
    }
  }
}

function startWagonLift(w: World, yard: Bay, t: PortTrain): void {
  const out = aboard(t, true) - (t.port.taking ?? 0) > 0 && takesExports(w, yard);
  const k = out ? gantryCell(w, yard, t, false) : -1;
  if (k >= 0) {
    const to = nextYardSlot(w, yard);
    if (to < 0) return;
    const at = cellAlong(w, yard, t, k)!;
    keepGantryTo(w, yard, to);
    yard.gantryOn = -t.id;
    yard.gantryWagon = { cell: k, at, load: false, look: wagonCells(t)[k]!.look ?? 0 };
    t.port.taking = (t.port.taking ?? 0) + 1;
    startLift(w, yard, at, slotAlong(w, yard, to));
    return;
  }
  if (stillWants(t) <= 0 || !takesImports(w, yard)) return;
  const top = clearTop(w, yard);
  const cell = top >= 0 ? gantryCell(w, yard, t, true) : -1;
  if (cell < 0) return;
  const at = cellAlong(w, yard, t, cell)!;
  yard.gantryOn = -t.id;
  yard.gantryWagon = { cell, at, load: true, look: boxLooks(w, yard)[top] };
  t.port.coming = (t.port.coming ?? 0) + 1;
  startLift(w, yard, slotAlong(w, yard, yardSlots(w, yard).boxes[top]), at);
}

/** A yard gantry's lift for a wagon: taken up half way through, set down at the end. */
function runWagonLift(w: World, yard: Bay): void {
  const lift = yard.gantryWagon;
  const t = w.rail.trains.find((q) => q.id === -(yard.gantryOn ?? 0));
  const live = t?.port?.state === 'standing' ? (t as PortTrain) : undefined;
  if (!lift || !live) return endWagonLift(w, yard, undefined, true);
  const cells = wagonCells(live);
  if (!lift.box && liftTaken(w, yard)) {
    if (lift.load) {
      // The one it went for, whatever customs cleared meanwhile, else any cleared on top.
      const looks = boxLooks(w, yard);
      const was = looks.indexOf(lift.look);
      const at = was >= 0 ? was : clearTop(w, yard);
      if (at >= 0) lift.box = takeBox(w, yard, at);
    } else {
      const box = cells[lift.cell];
      if (box?.out) {
        lift.box = box;
        cells[lift.cell] = null;
      }
    }
    if (!lift.box) return endWagonLift(w, yard, live, false);
  }
  if (!liftDone(w, yard)) return;
  if (lift.box) {
    if (lift.load) {
      const k = cells[lift.cell] ? gantryCell(w, yard, live, true) : lift.cell;
      if (k >= 0) {
        lift.box.at = w.tick;
        delete lift.box.out;
        cells[k] = lift.box;
      } else putBox(w, yard, { ...lift.box, ready: 0 }, false);
    } else putBox(w, yard, lift.box, true, yard.gantryTo);
    lift.box = undefined;
  }
  endWagonLift(w, yard, live, false);
}

/** A wagon lift over, done or cut short: anything on the spreader set back down in the yard. */
function endWagonLift(w: World, yard: Bay, t: PortTrain | undefined, gone: boolean): void {
  const lift = yard.gantryWagon;
  if (lift?.box) putBox(w, yard, lift.load ? { ...lift.box, ready: 0 } : lift.box, !lift.load);
  if (t && lift && !gone) {
    if (lift.load) t.port.coming = Math.max(0, (t.port.coming ?? 0) - 1);
    else t.port.taking = Math.max(0, (t.port.taking ?? 0) - 1);
  }
  yard.gantryWagon = undefined;
  yard.gantryOn = yard.gantryTo = undefined;
  // It stands where it set the container down, for the next.
  if (yard.gantryLift) yard.gantryAt = yard.gantryLift.to;
  yard.gantryLift = undefined;
}
