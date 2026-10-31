// Workers and machines in each other's way: the lanes through each tile, standing room, jams and how they clear, breaks at the hut, and the ways they take.

import type { World } from '../../world';
import { costFor, headTo } from './dockhands';
import { machineGround } from '../cargo/stores';
import { docked, gantryRailWays } from '../roads/bays';
import { clearAcross, onRoad, onWay, passRing, vehicleLength } from '../roads/traffic';
import { Build, isBay, isCrane } from '../../types';
import * as B from '../../balance';
import type { Agent, Bay, Dockhand } from '../../state';
import { findDrivePath, findPath } from '../../path';
import type { CostFn } from '../../path';
import { clamp, isBoxy, isMachine, isTruck, laneOf } from '../../helpers';
import type { Vehicle } from '../../helpers';
import { underGantry } from '../cranes';
import { traitDef } from '../../staff';
import { tipUnless } from '../output';
import { FACING } from '../../rules/footprint';
import { craneLane, laneHeading, quayHeading } from '../yardGantry';
import { WORKING } from '../../helpers';

/** How many workers fit in one lane of a tile. */
export function laneCap(w: World, i: number): number {
  const b = w.map.build[i];
  return isBay(b) || w.map.store[i] || b === Build.BreakHut || b === Build.Depot ? B.GATHER_CAP : 1;
}

export function laneFree(w: World, i: number, lane: number): boolean {
  return w.occupancy[i * 4 + lane] < laneCap(w, i);
}

/** Any lane of the tile in use at all. */
export function tileBusy(w: World, i: number): boolean {
  const o = w.occupancy;
  return o[i * 4] + o[i * 4 + 1] + o[i * 4 + 2] + o[i * 4 + 3] >= laneCap(w, i);
}

/**
 * A reach stacker or tractor held up in traffic: after a while it looks
 * for a way round whatever is standing in its way, and if it is still
 * held up long after, it squeezes on past, so nothing is stuck for good.
 */
export function resolveHold(w: World, p: Dockhand): void {
  if (p.blocked === B.REROUTE_AFTER * 2) {
    const base = w.driveCost;
    const standing = standingTiles(w);
    const cost: CostFn = (i) => base(i) + (standing.has(i) ? 8 : 0);
    const m = w.map;
    const path =
      p.kind === 'tractor'
        ? findDrivePath(m.w, m.h, w.tileOf(p), tileBehind(w, p), p.goal, cost, (i) =>
            roomToTurn(w, i),
          )
        : findPath(m.w, m.h, w.tileOf(p), p.goal, cost, true);
    if (path) p.path = path;
  } else if (p.blocked >= B.TRUCK_SQUEEZE_AFTER) p.squeeze = true;
}

/** Tiles where a truck or port machine is standing a while: loading, unloading or at work. */
export function standingTiles(w: World): Set<number> {
  const out = new Set<number>();
  for (const o of w.trucks) if (docked(w, o)) out.add(w.tileOf(o));
  for (const q of w.people) {
    if (isBoxy(q) && (q.state === 'picking' || q.state === 'dropping')) out.add(w.tileOf(q));
  }
  return out;
}

/** A machine standing idle in someone's way drives off home to park now, rather than in a while. */
export function makeWay(_w: World, o: Vehicle): void {
  if (!isTruck(o) && o.state === 'idle' && o.path.length === 0) o.timer = B.PARK_AFTER;
}

/** The port machines that drive in traffic, wherever they are other than parked at their depot. */
export function machinesOnRoad(w: World): Dockhand[] {
  return w.people.filter(
    (q) =>
      isBoxy(q) &&
      // Standing in a depot, idle, broken down or in for repair: the
      // others drive in over it.
      !((q.state === 'idle' || q.path.length === 0) && w.map.build[w.tileOf(q)] === Build.Depot),
  );
}

/**
 * Room to the back of whatever is nearest ahead of a reach stacker or
 * tractor, in its lane going its way or across it: a truck, or another
 * machine. Infinity if nothing is.
 */
export function roomAhead(w: World, p: Dockhand): number {
  passRing(w, p);
  p.blocker = undefined;
  let best = Infinity;
  const others: Vehicle[] = [
    ...w.trucks.filter((o) => onRoad(w, o) || docked(w, o)),
    ...machinesOnRoad(w),
  ];
  for (const o of others) {
    if (o === p || p.passing?.ids.includes(o.id) || clearAcross(w, p, o)) continue;
    const along = onWay(w, p, o);
    if (along < 0 || (o.path.length > 0 && o.id > p.id && onWay(w, o, p) >= 0)) continue;
    makeWay(w, o);
    const gap = along - (vehicleLength(w, p) + vehicleLength(w, o)) / 2;
    if (gap < best) {
      best = gap;
      p.blocker = o.id;
    }
  }
  return best;
}

/**
 * Another reach stacker or terminal tractor at tile `i` to pick a load up
 * there or set one down, or pulling up onto it to: the place is its, and
 * `p` waits its turn short of it.
 */
export function workingAt(w: World, i: number, p: Dockhand): Dockhand | undefined {
  return w.people.find(
    (q) =>
      q !== p &&
      isBoxy(q) &&
      w.tileOf(q) === i &&
      (q.state === 'picking' ||
        q.state === 'dropping' ||
        ((q.state === 'toPickup' || q.state === 'toDrop') && q.goal === i)),
  );
}

/** Whether another reach stacker or terminal tractor works at tile `i`, or is on its way to. */
export function spotTaken(w: World, i: number, p: Dockhand): boolean {
  return w.people.some(
    (q) =>
      q !== p &&
      isBoxy(q) &&
      (((q.state === 'picking' || q.state === 'dropping') && w.tileOf(q) === i) ||
        ((q.state === 'toPickup' || q.state === 'toDrop') && q.goal === i)),
  );
}

export function headingTo(w: World, a: Agent, i: number): number {
  return Math.atan2(w.map.yOf(i) + 0.5 - a.y, w.map.xOf(i) + 0.5 - a.x);
}

/** Resting workers sit out of the way, so they do not count. */
export function takesSpace(_w: World, p: Dockhand): boolean {
  // Resting and idle people stand aside on their tile, so others can pass.
  return p.state !== 'resting' && !(p.state === 'idle' && p.path.length === 0);
}

export function countOccupancy(w: World): void {
  w.occupancy.fill(0);
  for (const p of w.people) {
    if (takesSpace(w, p)) w.occupancy[w.tileOf(p) * 4 + laneOf(p.dir)]++;
  }
}

/**
 * Someone ahead is going the same way and has stopped (lifting a crate, or
 * queueing themselves). Wait, then try stepping aside, then a route around
 * the crowd, and finally squeeze past so nobody is stuck for good.
 */
export function resolveJam(w: World, p: Dockhand): void {
  if (p.blocked === B.SIDESTEP_AFTER) sidestep(w, p);
  else if (p.blocked === B.REROUTE_AFTER) reroute(w, p);
  else if (p.blocked >= B.SQUEEZE_AFTER) p.squeeze = true;
}

export function sidestep(w: World, p: Dockhand): void {
  const cost = costFor(w, p);
  const m = w.map;
  const here = w.tileOf(p);
  const ahead = p.path[0];
  // Only step sideways: never onto the tile ahead or back the way we came.
  const dx = Math.sign(m.xOf(ahead) - m.xOf(here));
  const dy = Math.sign(m.yOf(ahead) - m.yOf(here));
  const behind = m.inBounds(m.xOf(here) - dx, m.yOf(here) - dy)
    ? m.idx(m.xOf(here) - dx, m.yOf(here) - dy)
    : -1;
  let best = -1;
  let bestD = Infinity;
  for (const n of m.neighbors4(here)) {
    if (n === ahead || n === behind || !Number.isFinite(cost(n))) continue;
    if (!laneFree(w, n, laneOf(headingTo(w, p, n)))) continue;
    const d = w.dist(n, p.goal);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  if (best < 0) return;
  const onward = w.pathFor(p, best, p.goal);
  if (!onward) return;
  p.path = [best, ...onward];
}

export function reroute(w: World, p: Dockhand): void {
  const base = costFor(w, p);
  const crowded: CostFn = (i) => base(i) + (tileBusy(w, i) ? 6 : 0);
  const path = findPath(w.map.w, w.map.h, w.tileOf(p), p.goal, crowded, true);
  if (path) p.path = path;
}

export function handlingTicks(w: World, p: Dockhand, base: number): number {
  if (p.kind === 'tractor') {
    // At a yard its gantry lifts it; under a gantry crane it waits for the
    // crane to (see serveTractor); a harbour crane sets it straight on.
    const yard = w.yards.get(p.state === 'picking' ? p.stockIdx : p.bayIdx);
    if (yard) return B.YARD_GANTRY_TICKS * Math.max(1, p.planned);
    if (underGantry(w, p)) return B.TRACTOR_WAIT_TICKS;
    return base;
  }
  if (p.kind === 'stacker') return Math.round(base * 2.5);
  if (p.kind === 'forklift') return Math.round(base * 1.5);
  return Math.max(1, Math.round(base * traitDef(p.trait).handling));
}

/** How far through picking a load up or setting one down a worker is, 0 to 1. */
export function handlingPhase(w: World, p: Dockhand): number | undefined {
  if (p.state !== 'picking' && p.state !== 'dropping') return undefined;
  const total = handlingTicks(w, p, p.state === 'picking' ? B.PICK_TICKS : B.DROP_TICKS);
  return clamp(1 - p.timer / total, 0, 1);
}

export function changeMorale(_w: World, p: Dockhand, delta: number): void {
  if (isMachine(p)) return;
  const scaled = delta < 0 ? delta * traitDef(p.trait).moraleLoss : delta;
  p.morale = Math.max(0, Math.min(100, p.morale + scaled));
}

/** Energy use; returns true if the dockhand should head off for a break now. */
export function tire(w: World, p: Dockhand): boolean {
  if (isMachine(p)) return false;
  if (p.state === 'resting' || p.state === 'toBreak') return false;
  const drain = WORKING.has(p.state) ? B.WORK_DRAIN * traitDef(p.trait).drain : B.IDLE_DRAIN;
  const before = p.energy;
  p.energy = Math.max(0, p.energy - drain);
  if (before > 0 && p.energy === 0) changeMorale(w, p, B.MORALE_EXHAUSTED);
  // Only stop between jobs, never with a crate in hand.
  return p.energy < B.TIRED_ENERGY && (p.state === 'idle' || p.state === 'wander');
}

export function hutOccupancy(w: World, hut: number): number {
  return w.people.filter((q) => q.hutIdx === hut).length;
}

export function goOnBreak(w: World, p: Dockhand): void {
  p.path = [];
  if (!w.tipsSeen.has('hut')) tipUnless(w, 'hut', w.map.build.includes(Build.BreakHut));
  const here = w.tileOf(p);
  const huts: number[] = [];
  for (let i = 0; i < w.map.build.length; i++) {
    if (w.map.build[i] === Build.BreakHut && hutOccupancy(w, i) < B.HUT_SLOTS) huts.push(i);
  }
  huts.sort((a, b) => w.dist(here, a) - w.dist(here, b));
  for (const hut of huts) {
    if (headTo(w, p, hut)) {
      p.hutIdx = hut;
      p.state = 'toBreak';
      return;
    }
  }
  // Nowhere to go: sit down on the spot. Slow, and bad for morale.
  p.hutIdx = -1;
  p.state = 'resting';
  changeMorale(w, p, B.MORALE_FLOOR_BREAK);
}

/** Spread people resting at a hut along its front. */
export function seatAtHut(w: World, p: Dockhand): void {
  const seat = w.people.filter((q) => q.hutIdx === p.hutIdx && q !== p).length;
  // Along the bench in front, as the hut stands turned on its tile:
  // drawn facing +y, turned to face its way (see turn in structures.ts).
  const lx = -0.25 + (seat % B.HUT_SLOTS) * 0.25;
  const ly = 0.32;
  const [fx, fy] = FACING[w.map.orient[p.hutIdx] & 3];
  p.x = w.map.xOf(p.hutIdx) + 0.5 + lx * fy + ly * fx;
  p.y = w.map.yOf(p.hutIdx) + 0.5 - lx * fx + ly * fy;
  p.dir = Math.atan2(fy, fx);
}

export function pathFor(w: World, p: Dockhand, from: number, goal: number): number[] | null {
  const m = w.map;
  if (p.kind !== 'tractor') return findPath(m.w, m.h, from, goal, costFor(w, p), true);
  // A tractor and its trailer drive like a truck: square round corners,
  // and turning about only where there is room to come round.
  const back = from === w.tileOf(p) ? tileBehind(w, p) : -1;
  const turn = (i: number) => roomToTurn(w, i);
  const cost = costFor(w, p);
  // Where a crane lifts onto it, it pulls in along the way the crane
  // works for its last tile, so it stands lined up rather than across.
  const along = from === goal ? null : lineUpAt(w, goal);
  if (along) {
    let best: number[] | null = null;
    for (const sign of [1, -1]) {
      const x = m.xOf(goal) - along[0] * sign;
      const y = m.yOf(goal) - along[1] * sign;
      if (!m.inBounds(x, y)) continue;
      const before = m.idx(x, y);
      if (!Number.isFinite(cost(before))) continue;
      const keepOff: CostFn = (i, f) => (i === goal ? Infinity : cost(i, f));
      const way = before === from ? [] : findDrivePath(m.w, m.h, from, back, before, keepOff, turn);
      if (way && (!best || way.length + 1 < best.length)) best = [...way, goal];
    }
    if (best) return best;
  }
  return findDrivePath(m.w, m.h, from, back, goal, cost, turn);
}

/**
 * Which way a tractor stands to be lifted onto or off at `goal`, as a
 * step on the grid: along the quay under a gantry crane or beside a
 * harbour crane, along the lane under a yard gantry; null elsewhere.
 */
export function lineUpAt(w: World, goal: number): [number, number] | null {
  if (!w.lineUpCache) {
    const m = w.map;
    const out = new Map<number, [number, number]>();
    const put = (tiles: Iterable<number>, a: number | undefined) => {
      if (a === undefined) return;
      const step: [number, number] = [Math.round(Math.cos(a)), Math.round(Math.sin(a))];
      if (Math.abs(step[0]) + Math.abs(step[1]) !== 1) return;
      for (const t of tiles) if (!out.has(t)) out.set(t, step);
    };
    for (const c of w.cranes.values()) {
      if (c.kind === 'gantry') put(craneLane(w, c), quayHeading(w, c));
      else if (c.kind === 'harbour') {
        const x = m.xOf(c.idx);
        const y = m.yOf(c.idx);
        const round: number[] = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (m.inBounds(x + dx, y + dy)) round.push(m.idx(x + dx, y + dy));
          }
        }
        put(round, quayHeading(w, c));
      }
    }
    for (const y of w.yards.values()) {
      const lane = w.gantryLane(y);
      if (lane) put(lane.keys(), laneHeading(w, y));
    }
    w.lineUpCache = out;
  }
  return w.lineUpCache.get(goal) ?? null;
}

/**
 * The tile behind a machine: the one it drove in from, so that one part
 * way round a corner cannot turn back that way; else the way it mostly
 * faces, as one parked at an angle.
 */
export function tileBehind(w: World, p: Dockhand): number {
  const m = w.map;
  const here = w.tileOf(p);
  if (p.came !== undefined && m.neighbors4(here).includes(p.came)) return p.came;
  const c = Math.cos(p.dir);
  const s = Math.sin(p.dir);
  const dx = Math.abs(c) >= Math.abs(s) ? Math.sign(c) : 0;
  const dy = Math.abs(c) >= Math.abs(s) ? 0 : Math.sign(s);
  if (Math.abs(dx) + Math.abs(dy) !== 1) return -1;
  const x = m.xOf(w.tileOf(p)) - dx;
  const y = m.yOf(w.tileOf(p)) - dy;
  return m.inBounds(x, y) ? m.idx(x, y) : -1;
}

/**
 * Where a tractor may turn about: never on a road, a tractor and its
 * trailer being too long to come round on one, nor in the lane under a
 * yard gantry, but at a depot, and under a crane, where it pulls in to be
 * lifted onto or off and has room to manoeuvre: anywhere along a gantry
 * crane's rails, which it may only drive along. Anywhere else it goes on
 * round the roads.
 */
export function roomToTurn(w: World, i: number): boolean {
  const m = w.map;
  if (m.build[i] === Build.Depot || isCrane(m.build[i])) return true;
  if (yardLaneTiles(w).has(i)) return false;
  return lineUpAt(w, i) !== null || gantryRailWays(w).has(i);
}

/** Every tile of the lanes under the yard gantries. Cleared when the port changes. */
export function yardLaneTiles(w: World): Set<number> {
  if (w.yardLaneCache) return w.yardLaneCache;
  const out = new Set<number>();
  for (const y of w.yards.values()) for (const t of w.gantryLane(y)?.keys() ?? []) out.add(t);
  return (w.yardLaneCache = out);
}

/**
 * Whether a tractor can work a yard gantry's lane: never turning about
 * in it, it drives in at one end and out at the other, so the lane must
 * lead on onto the machines' ground at both.
 */
export function laneThrough(w: World, y: Bay): boolean {
  const lane = w.gantryLane(y);
  const a = laneHeading(w, y);
  if (!lane || lane.size === 0 || a === undefined) return false;
  const m = w.map;
  const dx = Math.round(Math.cos(a));
  const dy = Math.round(Math.sin(a));
  const along = (t: number) => m.xOf(t) * dx + m.yOf(t) * dy;
  const tiles = [...lane.keys()].sort((p, q) => along(p) - along(q));
  const ground = machineGround(w);
  const beyond = (t: number, s: number) => {
    const x = m.xOf(t) + dx * s;
    const yy = m.yOf(t) + dy * s;
    return m.inBounds(x, yy) && ground.has(m.idx(x, yy));
  };
  return beyond(tiles[0], -1) && beyond(tiles[tiles.length - 1], 1);
}
