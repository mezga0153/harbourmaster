// Containers moved between yards for the trains. A train takes away only
// what customs have cleared in the yards beside its loading track, and
// unloads only into those, so a reach stacker with nothing more pressing
// to do brings cleared containers over from the other yards while a train
// is due or standing there, and moves exports a train will need room for
// out of them to other yards for cargo going out, from where they go on
// to the ships as any others. Wherever the yards by the quay and the rail
// terminal lie, the trains get their loads.

import type { World } from '../../world';
import * as B from '../../balance';
import type { Bay, Dockhand } from '../../state';
import type { Siding } from '../../rules/rails';
import { bayIncoming, bayRoom } from '../../helpers';
import { handlingTicks } from '../workforce/crowding';
import { headTo, walk } from '../workforce/dockhands';
import { nextTrain, portTrains, sidingOf } from '../trains';
import { stackedAt } from '../yardGantry';
import { aboard, stillWants, yardsBeside } from './wagons';
import {
  boxesIn,
  boxLooks,
  carriedLooks,
  clearTop,
  dropAt,
  exportLooks,
  isClear,
  nearerMachine,
  putBox,
  reachable,
  reachFrom,
  readyList,
  stackSide,
  takeBox,
  takesExports,
  takesImports,
  workersAt,
  yardTop,
} from './stores';
import { message } from '../output';

/** What the trains due at a siding, or standing in it, want of the yards beside its loading track. */
export interface RailNeed {
  s: Siding;
  /** The yards beside it for containers coming in, and going out. */
  ins: Bay[];
  outs: Bay[];
  /** Containers they still take away, and still bring to unload. */
  take: number;
  bring: number;
  /** A train stands there now. */
  standing: boolean;
}

/**
 * For each siding with a container train due, coming in or standing in
 * it, or a rail line's next train due there soon: what its trains take
 * and bring.
 */
export function railNeeds(w: World): RailNeed[] {
  const out = new Map<number, RailNeed>();
  const need = (s: Siding): RailNeed => {
    let n = out.get(s.switch);
    if (!n) {
      const yards = yardsBeside(w, s);
      n = {
        s,
        ins: yards.filter((y) => takesImports(w, y)),
        outs: yards.filter((y) => takesExports(w, y)),
        take: 0,
        bring: 0,
        standing: false,
      };
      out.set(s.switch, n);
    }
    return n;
  };
  const trains = portTrains(w);
  for (const t of trains) {
    const state = t.port.state;
    if (t.port.contractId === undefined || t.port.hoppers) continue;
    if (state !== 'due' && state !== 'in' && state !== 'standing') continue;
    const s = sidingOf(w, t);
    if (!s) continue;
    const n = need(s);
    if (state === 'standing') {
      n.standing = true;
      n.take += stillWants(t);
      n.bring += Math.max(0, aboard(t, true) - (t.port.taking ?? 0));
    } else {
      n.take += t.port.take ?? 0;
      n.bring += aboard(t, true);
    }
  }
  // The next train of a line with none out, soon due.
  for (const c of w.contracts) {
    if (c.terms.kind !== 'rail' || c.terms.bulk) continue;
    if (c.nextBoatTick - w.tick > B.RAIL_SHIFT_AHEAD) continue;
    if (trains.some((t) => t.port.contractId === c.id && t.port.state !== 'away')) continue;
    const plan = nextTrain(w, c);
    if (!plan) continue;
    const n = need(plan.s);
    n.take += plan.take;
    n.bring += Math.min(c.terms.bring, plan.wagons * B.WAGON_BOXES);
  }
  return [...out.values()];
}

/** Stackers on their way to bring a container into this yard for the trains, or to take an export out of it. */
function shifting(w: World, b: Bay, into: boolean): number {
  return w.people.filter((p) =>
    into
      ? p.shift && !p.shift.out && p.bayIdx === b.idx
      : p.shift?.out && !p.shift.picked && p.shift.from === b.idx,
  ).length;
}

/** Containers coming in that the trains at a siding want and its yards have not got, nor are getting. */
export function importsShort(w: World, n: RailNeed): number {
  const have = n.ins.reduce((k, b) => k + boxesIn(b).length + shifting(w, b, true), 0);
  return n.take - have;
}

/** Exports the trains at a siding bring that there is no room for beside it, nor is being made. */
export function roomShort(w: World, n: RailNeed): number {
  const room = n.outs.reduce(
    (k, b) => k + Math.max(0, bayRoom(b, true)) + shifting(w, b, false),
    0,
  );
  return n.bring - room;
}

/**
 * Send a reach stacker with nothing more pressing to move a container for
 * the trains: a cleared one from another yard into a yard beside the
 * loading track, or an export out of one there to another yard for
 * exports. Trains standing there first, then the nearest work.
 */
export function takeShiftJob(w: World, p: Dockhand, here: number): boolean {
  if (p.kind !== 'stacker') return false;
  const needs = railNeeds(w).sort((a, b) => Number(b.standing) - Number(a.standing));
  const near = (from: number) => (a: Bay, b: Bay) => w.distTo(from, a) - w.distTo(from, b);
  for (const n of needs) {
    const beside = new Set([...n.ins, ...n.outs].map((y) => y.idx));
    const others = [...w.yards.values()].filter((y) => !!y.tiles && !beside.has(y.idx));
    if (importsShort(w, n) > 0) {
      const into = n.ins.filter((b) => bayRoom(b, true) > 0);
      const from = others
        .filter((b) => takesImports(w, b) && reachable(w, b) - (b.truckReserved ?? 0) > 0)
        .sort(near(here));
      if (into.length > 0 && begin(w, p, here, from, into, false)) return true;
    }
    if (roomShort(w, n) > 0) {
      const from = n.outs
        .filter((b) => boxesIn(b, true).length - (b.outReserved ?? 0) > 0)
        .sort(near(here));
      const into = others.filter((b) => takesExports(w, b) && bayRoom(b, true) > 0);
      if (into.length > 0 && begin(w, p, here, from, into, true)) return true;
    }
  }
  return false;
}

/** Off to the nearest of `from` it can lift one off, to take it to the nearest of `into` it can set it down in. */
function begin(
  w: World,
  p: Dockhand,
  here: number,
  from: Bay[],
  into: Bay[],
  out: boolean,
): boolean {
  for (const src of from) {
    const ready = readyList(w, src);
    const stand = out
      ? stackSide(w, p, src, here, 'pick', true)
      : stackSide(w, p, src, here, 'pick', false, (i) => isClear(w, ready[i]));
    if (stand < 0 || workersAt(w, stand) > 0 || nearerMachine(w, p, stand)) continue;
    const to = [...into]
      .sort((a, b) => w.distTo(stand, a) - w.distTo(stand, b))
      .find((b) => dropAt(w, p, b, stand) >= 0);
    if (!to || !headTo(w, p, stand)) continue;
    if (out) src.outReserved = (src.outReserved ?? 0) + 1;
    else src.truckReserved = (src.truckReserved ?? 0) + 1;
    bayIncoming(to, true, 1);
    p.shift = { from: src.idx, out };
    p.bayIdx = to.idx;
    p.planned = 1;
    p.boatId = -1;
    p.craneIdx = -1;
    p.stockIdx = -1;
    p.outbound = false;
    p.state = 'toPickup';
    return true;
  }
  return false;
}

/**
 * A stacker moving a container between yards for the trains: to the
 * stack, the container off it, over to the other yard and down on a
 * stack there it reaches. True while it is at it.
 */
export function shiftJob(w: World, p: Dockhand): boolean {
  const job = p.shift!;
  const from = w.yards.get(job.from);
  const to = w.yards.get(p.bayIdx);
  switch (p.state) {
    case 'toPickup': {
      if (!from || !to) {
        releaseShift(w, p);
        return true;
      }
      const r = walk(w, p);
      if (r === 'blocked') releaseShift(w, p);
      else if (r === 'arrived') {
        p.state = 'picking';
        p.timer = handlingTicks(w, p, B.PICK_TICKS);
      }
      return true;
    }
    case 'picking': {
      if (--p.timer > 0) return true;
      unreserve(w, p);
      job.picked = true;
      const reach = from ? reachFrom(w, from, p.goal) : undefined;
      const at = !from
        ? -1
        : job.out
          ? yardTop(w, from, true, undefined, reach)
          : clearTop(w, from, reach);
      if (!from || !to || at < 0) {
        releaseShift(w, p);
        return true;
      }
      if (job.out) exportLooks(w, from);
      else boxLooks(w, from);
      p.load = [takeBox(w, from, at, job.out)];
      p.carrying = 1;
      const goal = dropAt(w, p, to, p.goal);
      if (goal >= 0 && headTo(w, p, goal)) p.state = 'toDrop';
      else releaseShift(w, p);
      return true;
    }
    case 'toDrop': {
      const r = walk(w, p);
      if (r === 'arrived') {
        p.state = 'dropping';
        p.timer = handlingTicks(w, p, B.DROP_TICKS);
      } else if (r === 'blocked' || !to) {
        // Another way there, or it sets it down where it can.
        const goal = to ? dropAt(w, p, to, w.tileOf(p)) : -1;
        if (goal < 0 || !headTo(w, p, goal)) releaseShift(w, p);
      }
      return true;
    }
    case 'dropping': {
      if (--p.timer > 0) return true;
      releaseShift(w, p);
      return true;
    }
  }
  return false;
}

/** Hand back the container it was to lift, if it has not yet. */
function unreserve(w: World, p: Dockhand): void {
  const job = p.shift;
  if (!job || job.picked) return;
  const from = w.yards.get(job.from);
  if (!from) return;
  if (job.out) from.outReserved = Math.max(0, (from.outReserved ?? 0) - 1);
  else from.truckReserved = Math.max(0, (from.truckReserved ?? 0) - 1);
}

/**
 * Done moving a container, or given up: what it carries set down in the
 * yard it was going to, or back in the one it came from, and what was
 * kept for it given back.
 */
export function releaseShift(w: World, p: Dockhand): void {
  const job = p.shift;
  if (!job) return;
  unreserve(w, p);
  const to = w.yards.get(p.bayIdx);
  if (to) bayIncoming(to, true, -1);
  const box = p.load[0];
  if (box) {
    carriedLooks(w, p);
    const from = w.yards.get(job.from);
    const room = (b: Bay | undefined) => !!b && bayRoom(b, true) > 0;
    const yard = to && (room(to) || !room(from)) ? to : from;
    if (yard) {
      putBox(w, yard, box, job.out, stackedAt(w, p, yard, job.out ? undefined : (box.ready ?? 0)));
    } else {
      message(w, `${p.name} had nowhere to set a container down, and left it.`, 'bad');
    }
  }
  p.shift = undefined;
  p.carrying = 0;
  p.load = [];
  p.planned = 0;
  p.bayIdx = -1;
  p.path = [];
  p.state = 'idle';
}
