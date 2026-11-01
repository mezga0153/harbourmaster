// Truck bays, storage trucks load at, container yards' lanes and truck parking:
// the ways to them, queues at them, and the costs trucks drive by.

import type { World } from '../../world';
import { behind, departure, lengthOf } from './traffic';
import { Build, TICKS_PER_DAY } from '../../types';
import type { Bay, Truck } from '../../state';
import * as B from '../../balance';
import { laneRuns, loadingSpots, truckCost, truckReach } from '../../rules/truckNav';
import { gantryOf, quayHeading } from '../yardGantry';
import { gantryRails, gantryYard } from '../../rules/footprint';
import { exitRows, hasHighway } from '../../roads';
import type { CostFn } from '../../path';
import { message } from '../output';
import { needsWideSpace, parkingLots } from '../../rules/parking';
import type { ParkingLot, ParkingSpace } from '../../rules/parking';
import { takesFrom } from '../cargo/stores';
import { bayRoom, boxesAt, heldIn } from '../../helpers';
import { frontOf } from '../../rules/footprint';
import { handOn, nameBays, PREFIX } from '../../designations';

export function addBay(w: World, i: number): void {
  w.bays.set(i, {
    idx: i,
    large: w.map.build[i] === Build.LargeBay,
    boxIncoming: 0,
    cells: [],
    incoming: 0,
    nextTruckTick: 0,
    noAccess: false,
  });
  nameBays(w.bays.values());
}

/**
 * Where trucks stand to load: in a truck bay, or beside a storage area. A
 * pickup never backs into a truck bay: it pulls up on the road beside it.
 */
export function loadingDocks(w: World, bay: Bay, pickup = false): number[] {
  if (bay.tiles) return w.storeSpots(bay);
  return pickup ? roadside(w, bay) : [bay.idx];
}

/**
 * The road tiles beside a truck bay a pickup can pull up on, to be loaded
 * from its side by dockhands at the bay: the one in front of it first,
 * then those along the road at its corners, so bays round one end of a
 * road each have somewhere to load a pickup.
 */
export function roadside(w: World, bay: Bay): number[] {
  const m = w.map;
  const reach = truckReaches(w);
  const front = frontOf(m, bay.idx, m.orient[bay.idx] & 3);
  const [x, y] = [m.xOf(bay.idx), m.yOf(bay.idx)];
  const out: number[] = [];
  for (const [dx, dy] of [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    if (!m.inBounds(x + dx, y + dy)) continue;
    const n = m.idx(x + dx, y + dy);
    if (reach[n] >= 0 && m.build[n] !== Build.Parking) out.push(n);
  }
  return out.sort((a, b) => (b === front ? 1 : 0) - (a === front ? 1 : 0));
}

/**
 * Another truck bay whose trucks back in from this road tile, a pickup
 * standing on it would be in their way: the bay, or undefined.
 */
export function frontFor(w: World, tile: number, but: Bay): Bay | undefined {
  const m = w.map;
  for (const n of m.neighbors4(tile)) {
    const b = w.bays.get(n);
    if (!b || b === but || b.tiles) continue;
    if (frontOf(m, n, m.orient[n] & 3) === tile) return b;
  }
  return undefined;
}

/**
 * Tiles beside a storage area trucks can reach and stand on to load: public
 * roads, or port roads and quays behind a port gate. One truck loads at a
 * time for every STORE_TILES_PER_TRUCK tiles of it, at the spots nearest
 * the highway.
 */
export function storeSpots(w: World, a: Bay): number[] {
  const cached = w.spotCache.get(a.idx);
  if (cached) return cached;
  const most = Math.max(1, Math.floor(a.tiles!.length / B.STORE_TILES_PER_TRUCK));
  const spots = loadingSpots(w.map, a.tiles!, truckReaches(w));
  // At a yard with a gantry, trucks load anywhere in the lane its rails
  // run along, beside the yard: under it, and all the way along the yard
  // either way from it. Where trucks cannot get to that lane, they load
  // where they can.
  const rails = a.yard ? w.gantryLane(a) : null;
  const lane = rails
    ? spots
        .filter((s) => rails.has(s))
        .sort((p, q) => Math.abs(rails.get(p)!) - Math.abs(rails.get(q)!))
    : [];
  const out = lane.length > 0 ? lane : spots.slice(0, most);
  w.spotCache.set(a.idx, out);
  return out;
}

/**
 * The lane a yard's gantry runs along on its rails, beside the yard: each
 * tile with how far it is from the gantry (along the frame's +x, which is
 * (dy, -dx) on the map, for the gantry's own offset (dx, dy) into the
 * yard), as far as the yard runs either way. Null without a gantry.
 */
export function gantryLane(w: World, a: Bay): Map<number, number> | null {
  const cached = w.laneOfCache.get(a.idx);
  if (cached !== undefined) return cached;
  const lane = findGantryLane(w, a);
  w.laneOfCache.set(a.idx, lane);
  return lane;
}

export function findGantryLane(w: World, a: Bay): Map<number, number> | null {
  const m = w.map;
  const area = new Set(a.tiles ?? [a.idx]);
  const g = gantryOf(w, a);
  if (g < 0) return null;
  const into = gantryYard(m, g)?.into;
  if (into === undefined || !area.has(into)) return null;
  const dx = m.xOf(into) - m.xOf(g);
  const dy = m.yOf(into) - m.yOf(g);
  const lane = new Map<number, number>([[g, 0]]);
  for (const sign of [1, -1]) {
    for (let k = 1; ; k++) {
      const x = m.xOf(g) + dy * k * sign;
      const y = m.yOf(g) - dx * k * sign;
      if (!m.inBounds(x + dx, y + dy) || !area.has(m.idx(x + dx, y + dy))) break;
      lane.set(m.idx(x, y), k * sign);
    }
  }
  return lane;
}

/**
 * How far trucks drive from the highway to each tile they can get to, or
 * -1: public roads, and port roads and quays through a port gate.
 */
export function truckReaches(w: World): Int32Array {
  w.reachCache ??= truckReach(w.map);
  return w.reachCache;
}

/** Tiles trucks drive from the highway to load at a bay, or Infinity. */
export function roadTo(w: World, bay: Bay): number {
  const reach = truckReaches(w);
  const ends = bay.tiles
    ? w.storeSpots(bay).map((s) => reach[s])
    : w.map
        .neighbors4(bay.idx)
        .filter((n) => reach[n] >= 0)
        .map((n) => reach[n] + 1);
  if (ends.length === 0) return Infinity;
  // The way along the highway goes twice as fast as on other roads: as
  // so much shorter a drive.
  return Math.min(...ends) - highwayLeg(w) * (1 - B.TRUCK_SPEED / B.HIGHWAY_SPEED);
}

/** Tiles along the highway from its nearer end to the nearest exit, or 0 without one. */
export function highwayLeg(w: World): number {
  const m = w.map;
  if (!hasHighway(m)) return 0;
  let best = Infinity;
  for (const y of exitRows(m)) best = Math.min(best, y, m.h - 1 - y);
  return Number.isFinite(best) ? best : 0;
}

/** Standing at a loading spot, loading or unloading. */
export function docked(_w: World, o: Truck): boolean {
  return o.state === 'loading' || o.state === 'delivering';
}

/**
 * A free loading spot at this bay or storage, and the way there by `route`,
 * that does not drive up the lane through a truck already standing at a
 * spot: one beyond it waits until there is a way past, rather than going
 * through it. The furthest along such a lane first. Null when there is none.
 * Only this bay's own trucks count for the order along its lane: one
 * driving on past another's, as a road on through a yard's loading lane,
 * gets by those at it in traffic. At a yard gantry's one-way lane trucks
 * queue instead; see joinQueue.
 */
export function dockFor(
  w: World,
  bay: Bay,
  route: (dock: number, avoid: ReadonlySet<number>) => number[] | null,
  len = 1,
  pickup = false,
): { dock: number; path: number[] } | null {
  if (oneWayLane(w, bay)) return joinQueue(w, bay, route, len);
  const m = w.map;
  const standing = w.trucks.filter((o) => docked(w, o) && o.bayIdx === bay.idx);
  // Trucks on their way in to a loading spot: where each will stand, and
  // how far the nearest of them still has to go to each tile of its way
  // there, where this one would stop in its way.
  const coming = w.trucks.filter((o) => o.state === 'toBay' && o.path.length > 0);
  const willStand = new Set(coming.filter((o) => o.bayIdx === bay.idx).map((o) => o.goal));
  const onTheirWay = new Map<number, number>();
  for (const o of coming) {
    o.path.slice(0, -1).forEach((i, k) => {
      if ((onTheirWay.get(i) ?? Infinity) > k) onTheirWay.set(i, k);
    });
  }
  const open = w.freeDockSet(bay, len, pickup);
  const free = w.loadingDocks(bay, pickup).filter((d) => open.has(d));
  w.dockRouted = false;
  // The furthest in first, so those that come after stop short of it
  // rather than having to get past.
  let best: { dock: number; path: number[] } | null = null;
  w.dockTurn = false;
  // Its way there keeps off the spots the others stand at or are going to
  // where it can, by the lane beside them, rather than up the lane behind
  // them all.
  const taken = new Set([...standing.map((o) => w.tileOf(o)), ...willStand]);
  for (const dock of free) {
    const path = route(dock, taken);
    if (!path) continue;
    // It has to be able to drive away again, never backing out.
    const came = path.length >= 2 ? path[path.length - 2] : -1;
    const away = departure(w, dock);
    const out = w.drivePath(dock, came, away, truckCostFor(w, away, bay.idx));
    if (!out) {
      w.dockTurn = true;
      continue;
    }
    w.dockRouted = true;
    const through = path.some((i, k) => {
      const prev = k > 0 ? path[k - 1] : -1;
      if (prev < 0) return false;
      const dx = m.xOf(i) - m.xOf(prev);
      const dy = m.yOf(i) - m.yOf(prev);
      // In its lane: on its tile, going the way it faces.
      return standing.some(
        (o) => w.tileOf(o) === i && Math.cos(o.dir) * dx + Math.sin(o.dir) * dy > 0.5,
      );
    });
    // Nor drive in past where one coming in will stand, nor stop where
    // one coming in has yet to get past by the time it gets there: so the
    // first in go deepest and the rest stop short of them, and none
    // blocks the lane behind it. One coming in ahead of it, as all on
    // the same road in are, gets past first.
    const past = path.slice(0, -1).some((i) => willStand.has(i));
    const toPass = onTheirWay.get(dock);
    const inTheWay = toPass !== undefined && toPass + 2 >= path.length;
    if (!through && !past && !inTheWay && (!best || path.length > best.path.length)) {
      best = { dock, path };
    }
  }
  return best;
}

/**
 * Trucks at a yard gantry reserve no spot: they join its queue, while
 * there is room in it, a few longer than the spots along the lane, and
 * head for the far end of the lane; there each takes the deepest spot
 * free as it comes along, or waits behind the one in front (see
 * alongLane). The way to the far end, or null with the queue full or no
 * way in and out again.
 */
export function joinQueue(
  w: World,
  bay: Bay,
  route: (dock: number, avoid: ReadonlySet<number>) => number[] | null,
  len: number,
): { dock: number; path: number[] } | null {
  const m = w.map;
  const ways = w.laneWays();
  w.dockRouted = false;
  w.dockTurn = false;
  const docks = w.loadingDocks(bay).filter((d) => ways.has(d));
  if (docks.length === 0) return null;
  const [dx, dy] = ways.get(docks[0])!;
  const deep = (d: number) => m.xOf(d) * dx + m.yOf(d) * dy;
  docks.sort((a, b) => deep(b) - deep(a));
  const full = !queueRoom(w, bay, len);
  for (const dock of docks) {
    const path = route(dock, new Set());
    if (!path) continue;
    const came = path.length >= 2 ? path[path.length - 2] : -1;
    const away = departure(w, dock);
    if (!w.drivePath(dock, came, away, truckCostFor(w, away, bay.idx))) {
      w.dockTurn = true;
      continue;
    }
    w.dockRouted = true;
    return full ? null : { dock, path };
  }
  return null;
}

/** Trucks loading at a yard gantry, or on their way in to its queue. */
export function queued(w: World, bay: Bay): Truck[] {
  return w.trucks.filter((o) => o.bayIdx === bay.idx && (o.state === 'toBay' || docked(w, o)));
}

/** How many trucks are loading at a yard gantry or on their way in to its queue. */
export function inQueue(w: World, bay: Bay): number {
  return queued(w, bay).length;
}

/**
 * Whether a yard gantry's queue has room for another truck `len` long:
 * as long, bumper to bumper, as its lane and a little more, back along
 * the way in. Long trucks take more of it than short ones.
 */
export function queueRoom(w: World, bay: Bay, len = 1): boolean {
  const used = queued(w, bay).reduce((n, o) => n + lengthOf(w, o) + B.TRUCK_GAP, 0);
  return used + len <= w.loadingDocks(bay).length + B.GANTRY_QUEUE_EXTRA;
}

/**
 * A truck on its way in to a spot beside a storage area goes on to one
 * further along the lane that has come free since it set off, so the
 * lane fills from the far end: one stopping short, near where trucks come
 * in, keeps all the rest from being sent in past it.
 */
export function goDeeper(w: World, t: Truck, bay: Bay): void {
  if (oneWayLane(w, bay)) return alongLane(w, t, bay);
  // Where it could stop were it not already on its way to one.
  t.state = 'parked';
  const to = dockFor(
    w,
    bay,
    (d, avoid) => w.routeFrom(t, d, avoiding(w, truckCostFor(w, bay.idx, -1, t), avoid)),
    lengthOf(w, t),
  );
  t.state = 'toBay';
  // Further along the lane: the same way it is going, straight on past the
  // spot it was going to; never round another way, nor back round to one.
  if (!to || to.dock === t.goal || !t.path.every((i, k) => to.path[k] === i)) return;
  if (to.path.length - t.path.length > w.dist(t.goal, to.dock)) return;
  t.goal = to.dock;
  t.path = to.path;
}

/**
 * On its way in along a yard gantry's one-way lane, a truck takes the
 * deepest free spot on its way that no truck stands short of: on to one
 * further along that has come free since it set off, or short of one
 * standing between it and the spot it was going to, so that it unloads
 * now rather than waiting behind, and the lane fills from the far end.
 * With none, it waits in the lane behind the one in its way.
 */
export function alongLane(w: World, t: Truck, bay: Bay): void {
  const standing = new Set(
    w.trucks.filter((o) => o !== t && docked(w, o) && o.bayIdx === bay.idx).map((o) => w.tileOf(o)),
  );
  for (const p of w.people) {
    if (p.kind !== 'tractor') continue;
    if (
      (p.state === 'picking' && p.stockIdx === bay.idx) ||
      (p.state === 'dropping' && p.bayIdx === bay.idx)
    ) {
      standing.add(w.tileOf(p));
    }
  }
  // The spots free were it not on its way to one itself.
  t.state = 'parked';
  const open = w.freeDockSet(bay, lengthOf(w, t));
  t.state = 'toBay';
  // Its way, and on along the lane past the end of it.
  const m = w.map;
  const lane = w.gantryLane(bay);
  const way = w.laneWays().get(t.goal);
  const ahead = [...t.path];
  if (lane && way && t.path.length > 0) {
    for (;;) {
      const last = ahead[ahead.length - 1];
      const x = m.xOf(last) + way[0];
      const y = m.yOf(last) + way[1];
      if (!m.inBounds(x, y) || !lane.has(m.idx(x, y))) break;
      ahead.push(m.idx(x, y));
    }
  }
  let best = -1;
  for (let k = 0; k < ahead.length; k++) {
    if (standing.has(ahead[k])) break;
    if (open.has(ahead[k])) best = k;
  }
  if (best < 0 || ahead[best] === t.goal) return;
  const dock = ahead[best];
  // It has to be able to drive away from there too.
  const came = best > 0 ? ahead[best - 1] : w.tileOf(t);
  const away = departure(w, dock);
  if (!w.drivePath(dock, came, away, truckCostFor(w, away, bay.idx))) return;
  t.goal = dock;
  t.path = ahead.slice(0, best + 1);
}

/** A truck's way by `cost`, keeping off tiles in `avoid` where there is a short way round. */
export function avoiding(_w: World, cost: CostFn, avoid: ReadonlySet<number>): CostFn {
  return avoid.size === 0 ? cost : (i, from) => cost(i, from) + (avoid.has(i) ? 20 : 0);
}

/**
 * The loading spots at a bay no truck is at or on its way to, nor so close
 * along the lane to one that is that a truck `len` long would not fit
 * between: a long truck at a spot reaches over the next.
 */
export function freeDockSet(w: World, bay: Bay, len = 1, pickup = false): Set<number> {
  const m = w.map;
  // At a yard gantry, those on their way in to its queue hold no spot.
  const queue = oneWayLane(w, bay);
  const at = w.trucks.filter(
    (t) => docked(w, t) || (t.state === 'toBay' && !(queue && t.bayIdx === bay.idx)),
  );
  const taken = new Set(at.filter((t) => t.bayIdx === bay.idx).map((t) => t.goal));
  // Along a yard gantry's lane, the tractors it lifts for stand where the
  // trucks load: each takes its tile, and the next either way from a long truck.
  const lane = bay.yard ? w.gantryLane(bay) : null;
  const tractors = lane ? tractorsIn(w, bay) : [];
  const crowds = (d: number) =>
    tractors.some((g) => Math.abs(lane!.get(d)! - lane!.get(g)!) < (len + 1) / 2 - 0.05) ||
    at.some((o) => {
      if (o.goal === d) return o.bayIdx !== bay.idx;
      // Which way it lies there: as it stands, or as it will come in.
      const prev = o.path.length >= 2 ? o.path[o.path.length - 2] : behind(w, o);
      const dir = docked(w, o)
        ? o.dir
        : prev >= 0
          ? Math.atan2(m.yOf(o.goal) - m.yOf(prev), m.xOf(o.goal) - m.xOf(prev))
          : o.dir;
      const dx = m.xOf(d) - m.xOf(o.goal);
      const dy = m.yOf(d) - m.yOf(o.goal);
      const along = Math.abs(dx * Math.cos(dir) + dy * Math.sin(dir));
      const across = Math.abs(dy * Math.cos(dir) - dx * Math.sin(dir));
      return across < 0.5 && along < (len + lengthOf(w, o)) / 2 - 0.05;
    });
  // Nor, for a pickup, in front of another bay a truck is on its way to or at.
  const theirs = (d: number) => {
    const o = pickup ? frontFor(w, d, bay) : undefined;
    return (
      !!o &&
      w.trucks.some((t) => t.bayIdx === o.idx && !t.pickup && (t.state === 'toBay' || docked(w, t)))
    );
  };
  return new Set(
    w.loadingDocks(bay, pickup).filter((d) => !taken.has(d) && !crowds(d) && !theirs(d)),
  );
}

/** The lane tiles of a yard its terminal tractors stand at for the gantry, or are on their way to. */
export function tractorsIn(w: World, yard: Bay): number[] {
  const lane = w.gantryLane(yard);
  if (!lane) return [];
  return w.people
    .filter(
      (p) =>
        p.kind === 'tractor' &&
        (((p.state === 'picking' || p.state === 'toPickup') && p.stockIdx === yard.idx) ||
          ((p.state === 'dropping' || p.state === 'toDrop') && p.bayIdx === yard.idx)),
    )
    .map((p) => (p.state === 'picking' || p.state === 'dropping' ? w.tileOf(p) : p.goal))
    .filter((i) => lane.has(i));
}

export function freeDock(w: World, bay: Bay, pickup = false): number {
  const taken = new Set(
    w.trucks
      .filter(
        (t) =>
          t.bayIdx === bay.idx &&
          (t.state === 'toBay' || t.state === 'loading' || t.state === 'delivering'),
      )
      .map((t) => t.goal),
  );
  return w.loadingDocks(bay, pickup).find((d) => !taken.has(d)) ?? -1;
}

export function removeBay(w: World, i: number): void {
  const bay = w.bays.get(i);
  if (bay && heldIn(bay) + boxesAt(bay) > 0) {
    message(
      w,
      `${heldIn(bay)} crates and ${boxesAt(bay)} containers were lost with the truck bay.`,
      'bad',
    );
  }
  w.bays.delete(i);
}

/**
 * Trucks drive on public roads, and on port roads once they are through a
 * port gate: never straight from one to the other. A truck bay is only
 * enterable as the destination, or the one being left, from any side of it
 * that touches a road. Storage areas they load beside, never drive into.
 */
/** How trucks drive; through only the parking space `t` is in, or going into or out of. */
export function truckCostFor(w: World, target: number, home = -1, t?: Truck): CostFn {
  w.runsCache ??= laneRuns(w.map);
  return parkCost(
    w,
    t,
    throughCost(
      w,
      laneCost(w, truckCost(w.map, target, home, t?.lot && new Set(t.lot), w.runsCache)),
      target,
      home,
    ),
  );
}

/**
 * How a truck with a parking space of its own drives by `base`: into it
 * only off the road on its lot's in side, coming the way the lot runs or
 * straight at it, never round a hairpin; out of it only onto the road on
 * the far side, going on that way. However it finds its way, the first
 * time or held up on the way.
 */
export function parkCost(w: World, t: Truck | undefined, base: CostFn): CostFn {
  const lot = t?.lot;
  if (!lot) return base;
  const space = spaceAt(w, lot[0]);
  const flow = space && lotOf(w, lot[0])?.flow;
  if (!space || !flow) return base;
  const m = w.map;
  const own = new Set(space.tiles);
  const inEnd = space.ends[flow.in];
  const outEnd = space.ends[1 - flow.in];
  const step = (i: number, s: number) =>
    m.idx(m.xOf(i) + flow.along[0] * s, m.yOf(i) + flow.along[1] * s);
  const hairpinIn = step(inEnd, 1);
  const hairpinOut = step(outEnd, -1);
  // On its way in, the way in; in the space or just out of it, the way out.
  const goingIn = t!.state === 'toPark';
  const here = w.tileOf(t!);
  const goingOut = own.has(here) || here === outEnd;
  // Gone on its way, it keeps out of the space it had, as of any other.
  if (!goingIn && !goingOut) return (i, from) => (own.has(i) ? Infinity : base(i, from));
  return (i, from) => {
    if (from !== undefined && from >= 0) {
      if (goingIn && own.has(i) && !own.has(from) && from !== inEnd) return Infinity;
      if (goingIn && i === inEnd && from === hairpinIn) return Infinity;
      if (goingOut && own.has(from) && !own.has(i) && i !== outEnd) return Infinity;
      if (goingOut && from === outEnd && i === hairpinOut) return Infinity;
    }
    return base(i, from);
  };
}

/** How trucks drive by `base`, and only one way along a yard gantry's lane. */
export function laneCost(w: World, base: CostFn): CostFn {
  const lanes = w.laneWays();
  const rails = gantryRailWays(w);
  if (lanes.size === 0 && rails.size === 0) return base;
  const m = w.map;
  return (i, from) => {
    if (from !== undefined && from >= 0) {
      const dx = m.xOf(i) - m.xOf(from);
      const dy = m.yOf(i) - m.yOf(from);
      // Never across a yard gantry's rails: into its lane and out again
      // only at the ends, along it.
      if (crossesRails(w, from, i)) return Infinity;
      const way = lanes.get(i) ?? lanes.get(from);
      if (way && dx * way[0] + dy * way[1] < 0) return Infinity;
    }
    return base(i, from);
  };
}

/**
 * Whether a step from tile `a` to its neighbour `b`, straight or across a
 * corner, crosses a yard gantry's rails: onto or off its lane other than
 * along it.
 */
export function crossesRails(w: World, a: number, b: number): boolean {
  const rails = w.railCache ?? gantryRailWays(w);
  if (rails.size === 0) return false;
  const ra = rails.get(a);
  const rb = rails.get(b);
  if (!ra && !rb) return false;
  const m = w.map;
  const dx = m.xOf(b) - m.xOf(a);
  const dy = m.yOf(b) - m.yOf(a);
  const across = (r: [number, number] | undefined) => !!r && dx * r[1] - dy * r[0] !== 0;
  return across(ra) || across(rb);
}

/**
 * The tiles of each yard gantry's lane, under it along the yard, and of
 * each gantry crane's rails along the quay, with the way the rails run
 * along them: trucks and machines drive along them, never across.
 */
export function gantryRailWays(w: World): Map<number, [number, number]> {
  if (w.railCache) return w.railCache;
  const m = w.map;
  const out = new Map<number, [number, number]>();
  w.railYard.clear();
  for (const y of w.yards.values()) {
    const lane = w.gantryLane(y);
    if (!lane) continue;
    const g = [...lane].find(([, k]) => k === 0)?.[0];
    if (g === undefined) continue;
    const area = new Set(y.tiles ?? [y.idx]);
    const into = m.neighbors4(g).find((n) => area.has(n));
    if (into === undefined) continue;
    // The rails run square to the way the gantry reaches into the yard.
    const ix = m.xOf(into) - m.xOf(g);
    const iy = m.yOf(into) - m.yOf(g);
    for (const t of lane.keys()) {
      out.set(t, [iy, -ix]);
      w.railYard.set(t, y.idx);
    }
  }
  // And a gantry crane's: its two rows along the quay, the stack's and
  // the one behind it where tractors line up and stackers work, the
  // length of its rails. Along them, never across.
  for (const c of w.cranes.values()) {
    if (c.kind !== 'gantry') continue;
    const a = quayHeading(w, c);
    const way: [number, number] = [Math.round(Math.cos(a)), Math.round(Math.sin(a))];
    if (Math.abs(way[0]) + Math.abs(way[1]) !== 1) continue;
    for (const t of gantryRails(m, c.idx, m.orient[c.idx] & 3)) {
      if (t >= 0 && !out.has(t)) out.set(t, way);
    }
  }
  return (w.railCache = out);
}

/**
 * How trucks drive by `base`, keeping out from under a yard gantry
 * unless it is the yard they are bound for or leaving: the long way
 * round, if it is not much longer, rather than through its lane, where
 * the trucks it loads queue and it lifts over them.
 */
export function throughCost(w: World, base: CostFn, target: number, home: number): CostFn {
  const rails = gantryRailWays(w);
  if (rails.size === 0) return base;
  return (i, from) => {
    const c = base(i, from);
    const yard = w.railYard.get(i);
    if (yard === undefined || !Number.isFinite(c) || yard === target || yard === home) return c;
    return c + B.GANTRY_LANE_DETOUR;
  };
}

/**
 * The lane along a yard gantry's rails is one way for trucks, where a
 * truck can drive off either end of it and away to the highway: in at the
 * end the shorter way from the highway, out at the other, so that those
 * queueing along it to load never meet one leaving head on, and each goes
 * on out past the spots beyond it. Each lane tile with the way along it.
 * A lane with a way out at one end only is driven in and back out again.
 */
export function laneWays(w: World): Map<number, [number, number]> {
  if (w.laneCache) return w.laneCache;
  const m = w.map;
  const base = truckCost(m);
  const out = new Map<number, [number, number]>();
  for (const y of w.yards.values()) {
    const lane = w.gantryLane(y);
    if (!lane || lane.size < 2) continue;
    const tiles = [...lane.entries()].sort((a, b) => a[1] - b[1]).map(([t]) => t);
    const first = tiles[0];
    const last = tiles[tiles.length - 1];
    const dx = Math.sign(m.xOf(last) - m.xOf(first));
    const dy = Math.sign(m.yOf(last) - m.yOf(first));
    // Tiles from the road off this end of the lane to the highway, not
    // back through the lane; Infinity with no way.
    const off: CostFn = (i, from) => (lane.has(i) ? Infinity : base(i, from));
    const away = (end: number, s: number) => {
      const x = m.xOf(end) + dx * s;
      const yy = m.yOf(end) + dy * s;
      if (!m.inBounds(x, yy)) return Infinity;
      const road = m.idx(x, yy);
      const path = w.drivePath(road, end, departure(w, road), off);
      return path ? path.length : Infinity;
    };
    const ra = away(first, -1);
    const rb = away(last, 1);
    if (!Number.isFinite(ra) || !Number.isFinite(rb)) continue;
    const way: [number, number] = ra <= rb ? [dx, dy] : [0 - dx, 0 - dy];
    for (const t of tiles) out.set(t, way);
  }
  return (w.laneCache = out);
}

/** Whether trucks load at this storage along a one-way lane, under a yard gantry. */
export function oneWayLane(w: World, bay: Bay): boolean {
  return !!bay.yard && w.loadingDocks(bay).some((d) => w.laneWays().has(d));
}

export function lots(w: World): ParkingLot[] {
  if (!w.lotsCache) {
    w.lotsCache = parkingLots(w.map);
    nameLots(w, w.lotsCache);
  }
  return w.lotsCache;
}

/**
 * Give each parking lot its designation: the one most of its tiles' lot
 * had, the larger lot keeping it when one is split, or a new one.
 */
function nameLots(w: World, all: ParkingLot[]): void {
  handOn(
    all,
    () => PREFIX.parking,
    w.lotNames,
    (lot, name) => (lot.name = name),
  );
  w.lotNames.clear();
  for (const lot of all) for (const t of lot.tiles) w.lotNames.set(t, lot.name!);
}

/** The lot of parking tile `i` is in, if any. */
export function lotOf(w: World, i: number): ParkingLot | undefined {
  return lots(w).find((l) => l.tiles.includes(i));
}

/**
 * Why a lot is no use to the trucks: badly laid out, or out of their
 * reach; null when it works.
 */
export function lotTrouble(w: World, lot: ParkingLot): string | null {
  if (lot.why) return lot.why;
  if ((w.noWayIn.get(lot.tiles[0]) ?? -1) > w.tick) return NO_WAY_IN;
  const reach = truckReaches(w);
  return lot.spaces.some((s) => reach[s.ends[0]] >= 0 && reach[s.ends[1]] >= 0)
    ? null
    : lot.outside
      ? 'Trucks cannot get to the roads beside it from the highway'
      : 'Trucks cannot get to the port roads beside it: they come in through a port gate';
}

/** How long a lot no truck could drive into is left out before trucks try it again: a day. */
const NO_WAY_IN_TICKS = TICKS_PER_DAY;

const NO_WAY_IN =
  'Trucks cannot drive into it the way its arrows show: they never turn about on a road one tile wide. Turn it round with the one-way tool, or carry the road on so they can come at it from the other end';

/**
 * No truck could find its way into the lot `space` is in the way it runs:
 * say so once, and leave it out of the parking trucks are sent to a while.
 */
export function noWayIn(w: World, space: ParkingSpace): void {
  const lot = lots(w).find((l) => l.spaces.includes(space));
  if (!lot) return;
  const was = w.noWayIn.get(lot.tiles[0]);
  w.noWayIn.set(lot.tiles[0], w.tick + NO_WAY_IN_TICKS);
  if (was === undefined) {
    const name = lot.name ? `Parking ${lot.name}` : 'This parking';
    message(w, `${name} is no use: ${NO_WAY_IN[0].toLowerCase()}${NO_WAY_IN.slice(1)}.`, 'bad');
  }
}

/**
 * A free parking space for a truck bound for `bay`, nearest it: outside
 * the port only when `outside`, two tiles wide for the big trucks; null
 * when there is none.
 */
export function freeParking(
  w: World,
  bay: Bay | null,
  outside = false,
  wide = false,
): ParkingSpace | null {
  const reach = truckReaches(w);
  const taken = new Set(w.trucks.map((t) => t.park ?? -1));
  let best: ParkingSpace | null = null;
  let bestD = Infinity;
  for (const lot of lots(w)) {
    if (lot.why || (outside && !lot.outside) || (wide && !lot.wide)) continue;
    if ((w.noWayIn.get(lot.tiles[0]) ?? -1) > w.tick) continue;
    for (const space of lot.spaces) {
      const [a, b] = space.ends;
      // In from one road and out onto the other: both must lead somewhere.
      if (!space.ok || taken.has(space.tiles[0]) || reach[a] < 0 || reach[b] < 0) continue;
      const d = bay ? w.distTo(space.tiles[0], bay) : Math.min(reach[a], reach[b]);
      if (d < bestD) {
        bestD = d;
        best = space;
      }
    }
  }
  return best;
}

/**
 * The way from `from` into a parking space: to the road on whichever side
 * is nearer, then onto the space's tile on that side. Null if neither can
 * be reached.
 */
export function intoSpace(
  w: World,
  from: number,
  space: ParkingSpace,
  target: number,
): { path: number[]; via: number } | null {
  const m = w.map;
  const base = truckCost(m, target, -1, new Set(space.tiles));
  const flow = lotOf(w, space.tiles[0])?.flow;
  if (!flow) return null;
  // In off the road on the lot's in side only, coming the way it runs or
  // straight at it: never round a hairpin into a space leaning the other way.
  const end = space.ends[flow.in];
  const wrong = m.idx(m.xOf(end) + flow.along[0], m.yOf(end) + flow.along[1]);
  // Up to it by the road, never through the space itself the wrong way.
  const own = new Set(space.tiles);
  const cost: CostFn = (i, f) => (own.has(i) || (i === end && f === wrong) ? Infinity : base(i, f));
  const way = w.drivePath(from, -1, end, cost);
  if (!way) return null;
  const first = flow.in === 0 ? space.tiles[0] : space.tiles[space.tiles.length - 1];
  return { path: [...way, first], via: end };
}

/** Parked: stand across the middle of the space, at an angle, nose to the far side. */
export function parkUp(w: World, t: Truck): void {
  const m = w.map;
  const tiles = t.lot ?? [w.tileOf(t)];
  t.x = tiles.reduce((n, i) => n + m.xOf(i) + 0.5, 0) / tiles.length;
  t.y = tiles.reduce((n, i) => n + m.yOf(i) + 0.5, 0) / tiles.length;
  // Leaning the way its lot runs, as its spaces are painted.
  const flow = lotOf(w, tiles[0])?.flow;
  if (flow) {
    t.dir = Math.atan2(flow.along[1] + flow.across[1], flow.along[0] + flow.across[0]);
    return;
  }
  const from = t.parkFrom ?? w.tileOf(t);
  const ahead = Math.atan2(t.y - (m.yOf(from) + 0.5), t.x - (m.xOf(from) + 0.5));
  t.dir = ahead + Math.PI / 4;
}

/** Whether a shipper's truck like `t` is parked near this storage, with its paperwork done, waiting for a spot. */
export function stagedFor(w: World, store: Bay, t: Truck): boolean {
  return w.trucks.some(
    (o) =>
      o.staged === store.idx &&
      o.state === 'parked' &&
      o.boxes === t.boxes &&
      w.tick >= (o.papers ?? Infinity),
  );
}

/** The parking space whose first tile is `park`, if any. */
export function spaceAt(w: World, park: number | undefined): ParkingSpace | undefined {
  if (park === undefined) return undefined;
  return lots(w)
    .flatMap((l) => l.spaces)
    .find((s) => s.tiles[0] === park);
}

/**
 * A shipper's truck with its paperwork done, waiting for a spot at the
 * outgoing storage, moves on to a parking space much nearer it, inside the
 * port where there is one: there it is at the spot moments after it comes
 * free, rather than a long drive away, with the spot standing empty all
 * the while. Only as many wait there for each storage as it has spots.
 */
export function stageNearer(w: World, t: Truck): void {
  const to = stagingSpace(w, t);
  if (!to) return;
  const { store, space, into } = to;
  t.lot = [...space.tiles, ...(t.lot ?? [])];
  t.park = space.tiles[0];
  t.parkFrom = into.via;
  t.path = into.path;
  t.goal = into.path[into.path.length - 1];
  t.state = 'toPark';
  t.staged = store.idx;
}

/** The parking space a shipper's truck would move nearer the outgoing storage to, and the way there; see stageNearer. */
export function stagingSpace(
  w: World,
  t: Truck,
): { store: Bay; space: ParkingSpace; into: { path: number[]; via: number } } | null {
  const here = w.tileOf(t);
  const stores = [...(t.boxes ? w.yards : w.bays).values()]
    .filter((b) => takesFrom(w, b, t) && bayRoom(b, t.boxes) >= t.cargo)
    .sort((a, b) => w.distTo(here, a) - w.distTo(here, b));
  const wide = needsWideSpace(t.capacity, t.boxes);
  for (const store of stores) {
    const staged = w.trucks.filter(
      (o) => o.staged === store.idx && (o.state === 'toPark' || o.state === 'parked'),
    ).length;
    if (staged >= w.loadingDocks(store).length) continue;
    const space = w.freeParking(store, false, wide);
    if (!space) continue;
    if (w.distTo(space.tiles[0], store) + B.STAGE_NEARER_BY > w.distTo(here, store)) {
      continue;
    }
    // Out of its space, and in by whichever side of the new one is nearer:
    // through its own space and the new one only.
    const cost = laneCost(w, truckCost(w.map, -1, -1, new Set([...(t.lot ?? []), ...space.tiles])));
    let into: { path: number[]; via: number } | null = null;
    for (const [k, end] of space.ends.entries()) {
      const way = w.routeFrom(t, end, cost);
      if (!way || (into && way.length >= into.path.length - 1)) continue;
      const first = k === 0 ? space.tiles[0] : space.tiles[space.tiles.length - 1];
      into = { path: [...way, first], via: end };
    }
    if (into) return { store, space, into };
  }
  return null;
}

/**
 * The way out from where a truck is to `goal`: from a parking space,
 * always forwards, on across it and out onto the road on the far side.
 */
export function routeFrom(w: World, t: Truck, goal: number, cost: CostFn): number[] | null {
  const here = w.tileOf(t);
  let from = here;
  let prefix: number[] = [];
  const lot = t.lot;
  if (lot?.includes(here) && t.parkFrom !== undefined) {
    const space = lots(w)
      .flatMap((l) => l.spaces)
      .find((s) => s.tiles[0] === lot[0]);
    if (space) {
      const fromA = t.parkFrom === space.ends[0];
      const order = fromA ? space.tiles : [...space.tiles].reverse();
      const exit = fromA ? space.ends[1] : space.ends[0];
      prefix = [...order.slice(order.indexOf(here) + 1), exit];
      from = exit;
      // Out onto the road going on the way the lot runs, never back round.
      const flow = lotOf(w, lot[0])?.flow;
      if (flow) {
        const m = w.map;
        const back = m.idx(m.xOf(exit) - flow.along[0], m.yOf(exit) - flow.along[1]);
        const base = cost;
        cost = (i, f) => (f === exit && i === back ? Infinity : base(i, f));
      }
    }
  }
  if (from === goal) return prefix;
  const came =
    prefix.length >= 2 ? prefix[prefix.length - 2] : prefix.length === 1 ? here : behind(w, t);
  const rest = w.drivePath(from, came, goal, cost);
  return rest ? [...prefix, ...rest] : null;
}

/** Trucks parked, or on their way to park, waiting to load at this bay. */
export function queuedAt(w: World, bay: Bay): number {
  return w.trucks.filter(
    (t) => !t.exports && t.bayIdx === bay.idx && (t.state === 'toPark' || t.state === 'parked'),
  ).length;
}
