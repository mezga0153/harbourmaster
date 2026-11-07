// The rules of the road for trucks: keeping right, crossings and rings,
// junctions and who goes first, one-way roads and gates, backing into a
// bay, and leaving.
//
// Trucks keep to the right (see snapshot), so those going opposite ways
// pass each other, and never hold each other up, even turning across
// one another. Going the same way, each keeps its distance behind the
// one ahead. A junction is where the rules come in: a truck goes onto one
// only with room to get off it again, waits while another is driving
// across it, and gives way to traffic on a bigger road and to traffic
// coming from its right. Out of parking, it gives way to everything. Only
// moving traffic is given way to; between two trucks both standing at the
// line, one goes and the other waits, by an order that takes turns, so two
// never wait for each other. A truck held up for long enough waives the
// rules, then its room, and at the very last its distance, so the roads
// never lock up for good.

import type { World } from '../../world';
import { drive } from './trucks';
import type { Bay, Truck } from '../../state';
import { BACK_PULL, BACK_TURN, isBoxy, isTruck } from '../../helpers';
import type { Crossing, Vehicle } from '../../helpers';
import * as B from '../../balance';
import {
  greenAt,
  hasHighway,
  hasLights,
  highwayIns,
  highwayOuts,
  isExit,
  isHighway,
  laneLine,
  linked,
  nearestEnd,
  oneWay,
  wayFrom,
  waysMeet,
} from '../../roads';
import { machinesOnRoad, makeWay, standingTiles } from '../workforce/crowding';
import { findDrivePath } from '../../path';
import type { CostFn } from '../../path';
import { docked, truckCostFor } from './bays';
import { truckCost } from '../../rules/truckNav';
import { junctionAt } from '../../rules/marking';
import { Build, isBay, isPublicRoad, isTownBuilding } from '../../types';
import { dest } from '../cargo/customs';
import { BUSINESSES, HIGHWAY_X, landmarkDue, landmarkGoal } from '../../town';
import type { Business } from '../../town';
import { cargoName, cargoOf } from '../../cargo';
import { openLandmark } from '../townBusiness';
import { book, payout } from '../economy';
import { moneyAt } from '../output';
import { frontOf } from '../../rules/footprint';
import { iceTruck } from '../cargo/stores';
import { feesOn, onBoard } from '../cargo/beds';

/** Loading at the kerb, unloading in town, parked or away on the highway: off the road. */
export function onRoad(_w: World, o: Truck): boolean {
  return (
    o.state !== 'loading' &&
    o.state !== 'delivering' &&
    o.state !== 'unloading' &&
    o.state !== 'parked' &&
    !o.round
  );
}

/** On the road and moving, rather than standing in a queue or at a line. */
export function rolling(w: World, o: Vehicle): boolean {
  if (!isTruck(o)) return o.path.length > 0 && o.blocked === 0;
  return onRoad(w, o) && o.path.length > 0 && (o.held ?? 0) === 0;
}

/** Note which tile each truck and machine is on, and which it came from onto it. */
export function noteTiles(w: World): void {
  const seen = new Set<number>();
  for (const v of [...w.trucks, ...w.people]) {
    if (!isTruck(v) && !isBoxy(v)) continue;
    seen.add(v.id);
    const tile = w.tileOf(v);
    const rec = w.cameFrom.get(v.id);
    if (!rec) w.cameFrom.set(v.id, { tile, from: -1 });
    else if (rec.tile !== tile) {
      rec.from = rec.tile;
      rec.tile = tile;
    }
  }
  if (w.cameFrom.size > seen.size + 64) {
    for (const id of w.cameFrom.keys()) if (!seen.has(id)) w.cameFrom.delete(id);
  }
}

/**
 * The way a truck or machine goes across junction `i`, keeping right,
 * about the tile's middle (see laneLine): all of it coming up to it, what
 * is left of it, its tail and all, once on it. Null when not known.
 */
export function wayAcross(
  w: World,
  v: Vehicle,
  i: number,
): readonly (readonly [number, number])[] | null {
  const m = w.map;
  const here = w.tileOf(v);
  const lane = isTruck(v) ? B.TRUCK_LANE : B.MACHINE_LANE;
  let from: number;
  let to: number | undefined;
  if (here === i) {
    // Where it came onto it from; or, not seen coming, the way it faces.
    const rec = w.cameFrom.get(v.id);
    const ax = Math.cos(v.dir);
    const ay = Math.sin(v.dir);
    const [bx, by] = Math.abs(ax) >= Math.abs(ay) ? [Math.sign(ax), 0] : [0, Math.sign(ay)];
    const back = m.inBounds(m.xOf(i) - bx, m.yOf(i) - by)
      ? m.idx(m.xOf(i) - bx, m.yOf(i) - by)
      : -1;
    from = rec && rec.tile === i && rec.from >= 0 ? rec.from : back;
    if (from < 0) return null;
    to = v.path[0] === i ? v.path[1] : v.path[0];
  } else {
    const k = v.path.indexOf(i);
    if (k < 0 || k > 1) return null;
    from = k === 0 ? here : v.path[0];
    to = v.path[k + 1];
  }
  const near = m.neighbors4(i);
  if (!near.includes(from)) return null;
  const h = heading(w, from, i);
  const e = to !== undefined && near.includes(to) ? heading(w, i, to) : h;
  const way = laneLine(h, e, lane);
  if (here !== i) return way;
  const x = v.x - Math.sin(v.dir) * lane - (m.xOf(i) + 0.5);
  const y = v.y + Math.cos(v.dir) * lane - (m.yOf(i) + 0.5);
  return wayFrom(way, [x, y], vehicleLength(w, v) / 2);
}

/**
 * Whether `o`, though in front of `t`, is only crossing the junction or
 * bend just ahead of it on a way that never meets its own, as one turns
 * off a roundabout where the other comes on, or two going opposite ways
 * round a corner keep to their own sides of it: then it is not in its way.
 * Not only the first such ahead: one still rounding the corner of a
 * roundabout before the arm it turns off at is not held up by one that
 * has come on there.
 */
export function clearAcross(w: World, t: Vehicle, o: Vehicle): boolean {
  // One broken down there is not crossing: it stands in the way of all.
  if (brokenDown(w, o)) return false;
  const junctionTiles = junctions(w);
  const j = [w.tileOf(t), t.path[0], t.path[1]].find(
    (i) =>
      i !== undefined &&
      (w.tileOf(o) === i || o.path[0] === i) &&
      (junctionTiles[i] === 1 || (wayAcross(w, t, i)?.length ?? 0) >= 3),
  );
  if (j === undefined) return false;
  const a = wayAcross(w, t, j);
  const b = a && wayAcross(w, o, j);
  return !!a && !!b && !waysMeet(a, b);
}

/** Trucks on the road and the port machines driving among them. */
export function traffic(w: World): Vehicle[] {
  return [...w.trucks.filter((o) => onRoad(w, o)), ...machinesOnRoad(w)];
}

/**
 * How far a truck may drive this tick: its speed, short of a safe gap
 * behind the one ahead. Driving by `cost`, it finds a way round one
 * standing in its way, as goRound.
 */
export function pace(w: World, t: Truck, cost?: CostFn): () => number {
  return () => {
    const still = t.path.length > 0 && t.x === t.lastX && t.y === t.lastY;
    t.held = still ? (t.held ?? 0) + 1 : 0;
    t.lastX = t.x;
    t.lastY = t.y;
    // Off the map at the end of the way, it drives on out.
    const stop = t.state !== 'leaving';
    // Up to speed on the highway, between its exits, slowing for one ahead.
    const here = w.tileOf(t);
    const fast =
      isHighway(w.map.build[here]) &&
      [here, t.path[0], t.path[1]].every(
        (i) => i === undefined || (isHighway(w.map.build[i]) && !isExit(w.map, i)),
      );
    const speed = fast ? B.HIGHWAY_SPEED : B.TRUCK_SPEED;
    if (t.held > B.TRUCK_SQUEEZE_AFTER * 4) return drive(w, t, speed, Infinity, stop);
    const gap = gapAhead(w, t) - B.TRUCK_GAP;
    const room = Math.min(gap, toStopLine(w, t), toCrossing(w, t, gap));
    if (cost && t.held === B.REROUTE_AFTER) goRound(w, t, cost);
    return drive(w, t, speed, room, stop);
  };
}

/**
 * Held up behind a truck standing at a loading spot, or a machine at
 * work, a truck finds a way round it if there is a short one, by the
 * other lane of a wide road, rather than wait there until it is done: a
 * truck loading beside a through road would otherwise hold up all behind
 * it, and the queue back up across the roads it crosses until they lock.
 */
export function goRound(w: World, t: Truck, cost: CostFn): void {
  const standing = standingTiles(w);
  const o = [...w.trucks, ...w.people].find((q) => q.id === t.blocker);
  if (!o || !standing.has(w.tileOf(o))) return;
  const path = drivePath(
    w,
    w.tileOf(t),
    behind(w, t),
    t.goal,
    // Some way along the other lane is shorter than waiting for it.
    (i, from) => cost(i, from) + (standing.has(i) ? 20 : 0),
  );
  if (path) t.path = path;
}

/**
 * How far a truck can go before its front bumper reaches the edge of a
 * tile it may not drive into yet (a junction it must give way at, or a
 * level crossing with the barriers down): a long truck stops with its
 * nose at the line, not in the junction. Infinity if none is near.
 */
export function toStopLine(w: World, t: Vehicle): number {
  if (t.path.length === 0) return Infinity;
  const m = w.map;
  const here = w.tileOf(t);
  const half = vehicleLength(w, t) / 2;
  const enter = mayEnter(w, t);
  let d = Math.hypot(m.xOf(t.path[0]) + 0.5 - t.x, m.yOf(t.path[0]) + 0.5 - t.y);
  for (let k = 0; k < t.path.length && d - 0.5 < half + 1.5; k++) {
    const i = t.path[k];
    if (i !== here && !enter(i)) return d - 0.5 - half;
    d += 1;
  }
  return Infinity;
}

/**
 * Don't block the box: how far a truck can go before its front reaches a
 * tile just ahead that another's way crosses, when the queue in front
 * would leave it standing there across that way; Infinity if none is
 * near. Where roads two wide meet there is no junction to wait at (see
 * junctions), and a queue backing up through a crossing stops the
 * traffic across it, which on a loop of roads stops the queue itself.
 */
export function toCrossing(w: World, t: Truck, room: number): number {
  if (room === Infinity || t.path.length === 0) return Infinity;
  const m = w.map;
  const crossingsNow = crossings(w);
  const here = w.tileOf(t);
  const half = lengthOf(w, t) / 2;
  let x = t.x;
  let y = t.y;
  let d = 0;
  for (const i of t.path) {
    const cx = m.xOf(i) + 0.5;
    const cy = m.yOf(i) + 0.5;
    const len = Math.hypot(cx - x, cy - y);
    d += len;
    // Up to its front, and as far as it could go anyway.
    if (d - 0.5 > room + half) break;
    // Not where it is going to stop anyway.
    if (i !== here && i !== t.goal && len > 1e-6) {
      const hx = (cx - x) / len;
      const hy = (cy - y) / len;
      const across = crossingsNow
        .get(i)
        ?.some((c) => c.id !== t.id && Math.abs(c.dx * hx + c.dy * hy) < 0.5);
      // Its nose already in it, it goes on; else it stops short unless
      // there is room to get all the way over.
      if (across && d - 0.5 >= half - 0.05 && room < d + 0.5 + half) return d - 0.5 - half;
    }
    x = cx;
    y = cy;
  }
  return Infinity;
}

/** The tiles trucks and machines in traffic are about to drive onto, and which way; once a tick. */
export function crossings(w: World): Map<number, Crossing[]> {
  if (w.crossingCache?.tick === w.tick) return w.crossingCache.at;
  const m = w.map;
  const at = new Map<number, Crossing[]>();
  for (const o of traffic(w)) {
    let from = w.tileOf(o);
    for (const i of o.path.slice(0, 3)) {
      if (i === from) continue;
      const dx = m.xOf(i) - m.xOf(from);
      const dy = m.yOf(i) - m.yOf(from);
      const len = Math.hypot(dx, dy);
      const list = at.get(i) ?? [];
      list.push({ id: o.id, dx: dx / len, dy: dy / len });
      at.set(i, list);
      from = i;
    }
  }
  w.crossingCache = { tick: w.tick, at };
  return at;
}

/** Where a truck is on the road: on the right-hand side of it, or in the middle of a parking space. */
export function lanePos(_w: World, o: Truck): [number, number] {
  if (o.state === 'parked') return [o.x, o.y];
  return [o.x - Math.sin(o.dir) * B.TRUCK_LANE, o.y + Math.cos(o.dir) * B.TRUCK_LANE];
}

/** Room to the back of the nearest truck ahead in the same lane, going the same way; Infinity if none. */
export function gapAhead(w: World, t: Truck): number {
  passRing(w, t);
  let best = Infinity;
  t.blocker = undefined;
  for (const o of w.trucks) {
    // A truck standing at a loading spot holds up the lane like any other,
    // where it is on the way: round the corners, as one turning off short
    // of it gets by.
    if (o === t || !(onRoad(w, o) || docked(w, o))) continue;
    if (t.passing?.ids.includes(o.id)) continue;
    // Out on the highway, off the port's ground, trucks pass through each
    // other rather than ever queue: none holds up another there.
    if (isHighway(w.map.build[w.tileOf(o)])) continue;
    if (clearAcross(w, t, o)) continue;
    const along = docked(w, o) ? onWay(w, t, o) : ahead(w, t, o);
    // Two caught across each other, as one turns past the other: the newer one waits.
    if (along < 0 || (o.id > t.id && ahead(w, o, t) >= 0)) continue;
    // Bumper to bumper: half of each truck's length off the middles.
    const gap = along - (lengthOf(w, t) + lengthOf(w, o)) / 2;
    if (gap < best) {
      best = gap;
      t.blocker = o.id;
    }
  }
  // And behind a reach stacker or tractor in its way, as behind a truck.
  for (const o of machinesOnRoad(w)) {
    if (t.passing?.ids.includes(o.id) || clearAcross(w, t, o)) continue;
    const along = onWay(w, t, o);
    if (along < 0 || (o.path.length > 0 && o.id > t.id && onWay(w, o, t) >= 0)) continue;
    const gap = along - (lengthOf(w, t) + vehicleLength(w, o)) / 2;
    makeWay(w, o);
    if (gap < best) {
      best = gap;
      t.blocker = o.id;
    }
  }
  return best;
}

/**
 * Trucks and machines each waiting on the next all the way round, as
 * where a wide road crosses itself: one of them drives on through the
 * rest, minding only what else is about, until it has gone its own length
 * and is clear of where they were all caught. Not only while it is held
 * up: once it moves it no longer is, and it would stop again at once
 * behind the one it was waiting on. It goes once any of them has waited
 * long enough, not only itself: one that has just edged onto another
 * tile has its own wait start again.
 */
export function passRing(w: World, v: Vehicle): void {
  const group = heldFor(w, v) > 0 ? ring(w, v) : null;
  if (group && Math.max(...[v, ...group].map((o) => heldFor(w, o))) > B.TRUCK_RING_AFTER) {
    v.passing = { ids: group.map((o) => o.id), x: v.x, y: v.y };
  }
  const pass = v.passing;
  if (pass && Math.hypot(v.x - pass.x, v.y - pass.y) > vehicleLength(w, v) + B.TRUCK_GAP) {
    v.passing = undefined;
  }
}

/**
 * The others in a ring of trucks and machines each held up behind the
 * next, back round to this one, when this is the one of them to go; null
 * if it is in none, or another is to go. The one to go is held up by one
 * crossing its way or coming at it, not queueing behind one going its
 * way, as only going on through that undoes the knot: the lowest numbered
 * such, or of them all if none is.
 */
export function ring(w: World, t: Vehicle): Vehicle[] | null {
  if (w.vehicleCache?.tick !== w.tick) {
    const by = new Map<number, Vehicle>(w.trucks.map((o) => [o.id, o]));
    for (const q of w.people) if (isBoxy(q)) by.set(q.id, q);
    w.vehicleCache = { tick: w.tick, by };
  }
  const by = w.vehicleCache.by;
  let at: Vehicle | undefined = t;
  const ring: Vehicle[] = [t];
  // However far round: a loop of roads can fill all the way.
  while (at?.blocker !== undefined) {
    at = by.get(at.blocker);
    if (!at || heldFor(w, at) === 0 || (at !== t && ring.includes(at))) return null;
    if (at === t) {
      const across = ring.filter(
        (v) => Math.cos(goingTo(w, by.get(v.blocker!)!) - goingTo(w, v)) < 0.7,
      );
      const go = (across.length > 0 ? across : ring).reduce((a, b) => (b.id < a.id ? b : a));
      return go === t ? ring.slice(1) : null;
    }
    ring.push(at);
  }
  return null;
}

/**
 * How far ahead of truck `t` truck `o` is, in its lane and not coming the
 * other way on its own side of the road, short of where it turns off;
 * -1 if it is not.
 */
export function ahead(w: World, t: Truck, o: Truck): number {
  const m = w.map;
  let reach = 3 + lengthOf(w, t);
  // The way it is about to go, which for one setting off from where it
  // stood may not be the way it faces yet.
  const dir = goingTo(w, t);
  const hx = Math.cos(dir);
  const hy = Math.sin(dir);
  // Only as far as the tile where its way turns: what is straight on past
  // that is off its way, as one in the lane beside it it turns away from.
  let along0 = 0;
  for (const i of t.path) {
    const dx = m.xOf(i) + 0.5 - t.x;
    const dy = m.yOf(i) + 0.5 - t.y;
    if (Math.abs(dy * hx - dx * hy) > 0.05) {
      reach = Math.min(reach, along0 + 0.5);
      break;
    }
    along0 = dx * hx + dy * hy;
    if (along0 > reach) break;
  }
  const tx = t.x - hy * B.TRUCK_LANE;
  const ty = t.y + hx * B.TRUCK_LANE;
  const [ox, oy] = lanePos(w, o);
  const dx = ox - tx;
  const dy = oy - ty;
  const along = dx * hx + dy * hy;
  if (along < 0 || along > reach) return -1;
  // Going the other way, by where it is headed rather than how it faces,
  // it passes: the two never hold each other up.
  if (Math.abs(dy * hx - dx * hy) > 0.45 || Math.cos(goingTo(w, o) - dir) < -0.2) return -1;
  return along;
}

/**
 * How far along its way truck or machine `t` comes up to truck or
 * machine `o`: round its corners and across its diagonals, in its lane
 * and not coming the other way on its own side of the road, a little
 * past the end of its way; -1 if it does not.
 */
export function onWay(w: World, t: Vehicle, o: Vehicle): number {
  const m = w.map;
  const reach = 3 + vehicleLength(w, t);
  const lane = isTruck(t) ? B.TRUCK_LANE : B.MACHINE_LANE;
  const [ox, oy] = roadPos(w, o);
  let x = t.x;
  let y = t.y;
  let dir = t.dir;
  let run = 0;
  for (let k = 0; k <= t.path.length && run < reach; k++) {
    // Past the end of its way, only as far as its own front reaches.
    const last = k === t.path.length;
    const on = last ? vehicleLength(w, t) / 2 + B.TRUCK_GAP : 0;
    const nx = last ? x + Math.cos(dir) * on : m.xOf(t.path[k]) + 0.5;
    const ny = last ? y + Math.sin(dir) * on : m.yOf(t.path[k]) + 0.5;
    const len = Math.hypot(nx - x, ny - y);
    if (len < 1e-6) continue;
    const hx = (nx - x) / len;
    const hy = (ny - y) / len;
    dir = Math.atan2(hy, hx);
    const dx = ox - (x - hy * lane);
    const dy = oy - (y + hx * lane);
    const along = dx * hx + dy * hy;
    const across = Math.abs(dy * hx - dx * hy);
    // Clear of each other side by side; round a corner, what is just
    // short of it only if it has turned that way already.
    // Facing its way counts as much as going it: one stopped to turn
    // about still fills the lane it stands in.
    const facing = Math.max(Math.cos(goingTo(w, o) - dir), Math.cos(o.dir - dir));
    const from = k > 0 && facing > 0.7 ? -0.3 : 0;
    // One broken down fills the road as far as it reaches across it,
    // whichever way it faces.
    const broken = brokenDown(w, o);
    const wide = broken ? (Math.abs(Math.sin(o.dir - dir)) * vehicleLength(w, o)) / 2 : 0;
    if (along >= from && along <= len && across <= 0.3 + wide && (broken || facing >= -0.2)) {
      return run + Math.max(0, along);
    }
    run += len;
    x = nx;
    y = ny;
  }
  return -1;
}

/** A machine broken down where it stands, waiting for its repair: nothing gets past it. */
export function brokenDown(_w: World, o: Vehicle): boolean {
  return !isTruck(o) && o.state === 'broken';
}

/** Where a truck or machine is on the road: on the right-hand side of it, as each is shown. */
export function roadPos(w: World, o: Vehicle): [number, number] {
  if (isTruck(o)) return lanePos(w, o);
  const lane = B.MACHINE_LANE;
  return [o.x - Math.sin(o.dir) * lane, o.y + Math.cos(o.dir) * lane];
}

/** How long a truck or machine is, in tiles. */
export function vehicleLength(w: World, o: Vehicle): number {
  return isTruck(o) ? lengthOf(w, o) : B.MACHINE_LENGTH[o.kind as 'stacker' | 'tractor'];
}

/** How long a truck or machine has been held up, in ticks. */
export function heldFor(_w: World, o: Vehicle): number {
  return isTruck(o) ? (o.held ?? 0) : o.blocked;
}

/** Which way a truck or machine is going: towards the next tile on its way, or the way it faces. */
export function goingTo(w: World, t: Vehicle): number {
  const next = t.path[0];
  if (next === undefined) return t.dir;
  const dx = w.map.xOf(next) + 0.5 - t.x;
  const dy = w.map.yOf(next) + 0.5 - t.y;
  return Math.hypot(dx, dy) > 1e-3 ? Math.atan2(dy, dx) : t.dir;
}

/** How long a truck is, in tiles. */
export function lengthOf(_w: World, t: Truck): number {
  return B.truckLength(t.capacity, t.boxes);
}

/**
 * Where three or more roads meet, for the trucks. Not inside a stretch of
 * port road two or more wide all round, where trucks drive as they find
 * room. Cleared when the port changes.
 */
export function junctions(w: World): Uint8Array {
  if (w.junctionCache) return w.junctionCache;
  const m = w.map;
  const road = truckCost(m);
  const out = new Uint8Array(m.build.length);
  for (let i = 0; i < m.build.length; i++) if (junctionAt(m, i, road)) out[i] = 1;
  w.junctionCache = out;
  return out;
}

/**
 * Where a truck has room to come round and go back the way it came: a
 * junction, where it can back into the side road; a block of road two
 * wide each way; a truck bay or business it drives into; and the highway
 * off the edge of the map. Nowhere else does it turn about on the spot.
 * Cleared when the port changes.
 */
export function turnable(w: World, i: number): boolean {
  if (!w.turnCache) {
    const m = w.map;
    const road = truckCost(m);
    const ok = (x: number, y: number) =>
      m.inBounds(x, y) && Number.isFinite(road(m.idx(x, y))) && !isHighway(m.build[m.idx(x, y)]);
    const out = new Uint8Array(m.build.length);
    const junctionTiles = junctions(w);
    // No coming round on the highway, nor anywhere on a one-way road.
    const highway = hasHighway(m);
    for (let k = 0; k < m.build.length; k++) {
      const b = m.build[k];
      if (isHighway(b) || oneWay(m, k) >= 0) continue;
      const end = !highway && (k === m.entry || k === w.town?.gate);
      if (end || isBay(b) || isTownBuilding(b)) {
        out[k] = 1;
        continue;
      }
      if (!Number.isFinite(road(k))) continue;
      const ways = m
        .neighbors4(k)
        .filter((n) => Number.isFinite(road(n)) && linked(m, k, n)).length;
      const x = m.xOf(k);
      const y = m.yOf(k);
      const open = [-1, 1].some((dx) =>
        [-1, 1].some((dy) => ok(x + dx, y) && ok(x, y + dy) && ok(x + dx, y + dy)),
      );
      if (junctionTiles[k] || ways >= 3 || open) out[k] = 1;
    }
    w.turnCache = out;
  }
  return w.turnCache[i] === 1;
}

/** A truck's way from `from`, having come from `cameFrom` (-1: either way), never turning about where it cannot. */
export function drivePath(
  w: World,
  from: number,
  cameFrom: number,
  goal: number,
  cost: CostFn,
): number[] | null {
  const m = w.map;
  return findDrivePath(m.w, m.h, from, cameFrom, goal, cost, (i) => turnable(w, i));
}

/** A truck's new way to its goal when the old one is blocked: never turning about where it cannot. */
export function truckReroute(w: World, t: Truck): (cost: CostFn) => number[] | null {
  return (cost) => w.drivePath(w.tileOf(t), behind(w, t), t.goal, cost);
}

/** The tile a truck has just come from, by the way it faces. */
export function behind(w: World, t: Truck): number {
  const m = w.map;
  const here = w.tileOf(t);
  const dx = Math.round(Math.cos(t.dir));
  const dy = Math.round(Math.sin(t.dir));
  if (Math.abs(dx) + Math.abs(dy) !== 1) return -1;
  const x = m.xOf(here) - dx;
  const y = m.yOf(here) - dy;
  return m.inBounds(x, y) ? m.idx(x, y) : -1;
}

/**
 * How much a road's traffic has priority: the highway over public road,
 * public road over port road, all over parking.
 */
export function roadRank(w: World, i: number): number {
  const b = w.map.build[i];
  return isHighway(b) ? 3 : isPublicRoad(b) ? 2 : b === Build.Parking ? 0 : 1;
}

/**
 * Where a truck coming in for `goal` comes onto the map: off the end of
 * the highway nearer it, heading in; on a map without one, at the end of
 * the main road.
 */
export function arrival(w: World, goal: number): { tile: number; dir: number } {
  const m = w.map;
  if (!hasHighway(m)) return { tile: m.entry, dir: 0 };
  const ins = highwayIns(m);
  const tile = nearestEnd(
    m,
    ins.map((s) => s.tile),
    m.yOf(goal),
  );
  return ins.find((s) => s.tile === tile)!;
}

/** Where a truck at `from` leaves the map: the end of the highway nearer it. */
export function departure(w: World, from: number): number {
  const m = w.map;
  return hasHighway(m) ? nearestEnd(m, highwayOuts(m), m.yOf(from)) : m.entry;
}

/** Unit heading from tile `a` to the neighbouring tile `b`. */
export function heading(w: World, a: number, b: number): [number, number] {
  const m = w.map;
  return [m.xOf(b) - m.xOf(a), m.yOf(b) - m.yOf(a)];
}

/** Whether a truck or machine about to drive onto junction `i` has room to drive off it again. */
export function roomPast(w: World, t: Vehicle, i: number): boolean {
  const exit = t.path[1];
  if (exit === undefined) return true;
  const [ex, ey] = heading(w, i, exit);
  for (const o of traffic(w)) {
    if (o === t || rolling(w, o)) continue;
    const tile = w.tileOf(o);
    if (tile !== exit && tile !== i) continue;
    // Standing just past it in the lane we want, or still on it going our way.
    if (Math.cos(o.dir) * ex + Math.sin(o.dir) * ey > 0.7) return false;
  }
  return true;
}

/**
 * Of two trucks both standing at a junction, which goes first: a strict
 * order at any moment, so that one of them does, which turns over every
 * few seconds so that both get to.
 */
export function goesFirst(w: World, a: Vehicle, b: Vehicle, i: number): boolean {
  const turn = Math.floor(w.tick / B.TRUCK_TAKE_TURNS) + i;
  return (turn & 1) === 0 ? a.id < b.id : a.id > b.id;
}

/**
 * Whether a truck, or a port machine in traffic, may drive on into tile
 * `i`: the level crossing is open, and at a junction, or coming out of
 * parking, the rules of the road let it.
 */
export function mayEnter(w: World, t: Vehicle): (i: number) => boolean {
  return (i) => {
    const m = w.map;
    // Its nose already over the line: it is committed, and goes on
    // rather than stop across the junction.
    const d = Math.hypot(m.xOf(i) + 0.5 - t.x, m.yOf(i) + 0.5 - t.y);
    if (d - 0.5 < vehicleLength(w, t) / 2 - 0.05 && i === t.path[0]) return true;
    // Onto and along the highway nobody gives way: they pass through each other there.
    if (isHighway(m.build[i])) return true;
    if (!w.level(i)) return false;
    const here = w.tileOf(t);
    const fromParking = m.build[here] === Build.Parking && m.build[i] !== Build.Parking;
    if (!junctions(w)[i] && !fromParking) return true;
    const held = heldFor(w, t);
    if (held > B.TRUCK_SQUEEZE_AFTER * 2) return true;
    if (!roomPast(w, t, i)) return false;
    const [hx, hy] = heading(w, here, i);
    const exit = t.path[1];
    const [ex, ey] = exit === undefined ? [hx, hy] : heading(w, i, exit);
    // Only those whose way across the junction meets ours hold us up:
    // not one turning off where we turn on, or into a side road as we
    // turn out of it, in the other lane.
    const mine = wayAcross(w, t, i);
    const meets = (o: Vehicle) => {
      const theirs = mine && wayAcross(w, o, i);
      return !mine || !theirs || waysMeet(mine, theirs);
    };
    // Traffic lights: only on green, then minding what is still across it.
    if (hasLights(m, i)) {
      const green = greenAt(i, w.tick);
      if (green !== (hx !== 0 ? 'ew' : 'ns')) return false;
      for (const o of traffic(w)) {
        if (o === t || w.tileOf(o) !== i || !rolling(w, o)) continue;
        const ox = Math.cos(o.dir);
        const oy = Math.sin(o.dir);
        if (ox * ex + oy * ey > 0.7 || !meets(o)) continue;
        return false;
      }
      return true;
    }
    if (held > B.TRUCK_SQUEEZE_AFTER) return true;

    const rank = fromParking ? 0 : roadRank(w, here) + onOneWay(w, here, i);
    const cx = m.xOf(i) + 0.5;
    const cy = m.yOf(i) + 0.5;
    for (const o of traffic(w)) {
      if (o === t || o.path.length === 0) continue;
      const ox = Math.cos(o.dir);
      const oy = Math.sin(o.dir);
      const there = w.tileOf(o);
      if (there === i) {
        // Driving across it now, other than on our way out of it, or
        // on a way that never meets ours.
        if (!rolling(w, o)) continue;
        if (ox * ex + oy * ey > 0.7 || !meets(o)) continue;
        return false;
      }
      // Coming up to it, from another road.
      if (o.path[0] !== i && !(o.path[1] === i && rolling(w, o))) continue;
      const dx = o.x - cx;
      const dy = o.y - cy;
      if (Math.hypot(dx, dy) > 1.8) continue;
      const along = ox * hx + oy * hy;
      // Behind us, our way; or coming the other way, which never holds
      // us up, even turning across it; or going a way that never meets ours.
      if (along > 0.7 || along < -0.7 || !meets(o)) continue;
      const theirRank =
        m.build[there] === Build.Parking && m.build[i] !== Build.Parking
          ? 0
          : roadRank(w, there) + onOneWay(w, there, i);
      const fromRight = dx * -hy + dy * hx > 0.5;
      const yields = theirRank > rank || (theirRank === rank && fromRight);
      if (!yields) continue;
      if (rolling(w, o)) return false;
      // Both standing: take turns, unless it is only queueing to get on.
      if (roomPast(w, o, i) && goesFirst(w, o, t, i)) return false;
    }
    return true;
  };
}

/**
 * Traffic already on a one-way road, going on along it through a
 * junction, has the right of way over traffic joining it: round a
 * roundabout, and down a one-way street.
 */
export function onOneWay(w: World, from: number, junction: number): number {
  const m = w.map;
  const f = oneWay(m, junction);
  return !isHighway(m.build[junction]) && f >= 0 && oneWay(m, from) >= 0 ? 0.5 : 0;
}

/** Nobody standing at the end of the highway (or road) where a new truck comes in. */
export function entryClear(w: World, tile = w.map.entry): boolean {
  const m = w.map;
  // Trucks on the highway pass through each other.
  if (isHighway(m.build[tile])) return true;
  const cx = m.xOf(tile) + 0.5;
  const cy = m.yOf(tile) + 0.5;
  return w.trucks.every(
    (o) => !onRoad(w, o) || Math.hypot(o.x - cx, o.y - cy) > lengthOf(w, o) + B.TRUCK_GAP + 0.2,
  );
}

export function truckLeave(w: World, t: Truck): void {
  const bay = dest(w, t.bayIdx);
  if (bay) bay.nextTruckTick = w.tick + 30;
  // Off on its round: its haulier cannot send it again until it is back.
  const haulier = w.contracts.find((c) => c.id === t.contractId);
  if (haulier && !t.away) (haulier.returns ??= []).push(w.tick + B.TRUCK_ROUND_TRIP);
  t.away = true;
  if (t.cargo > 0) {
    if (w.town) {
      w.town.today += t.boxes ? t.cargo * B.CONTAINER_GOODS : t.cargo;
      // By kind, towards what the town's businesses take.
      const sent = (w.town.sent ??= {});
      if (t.boxes) sent.container = (sent.container ?? 0) + t.cargo;
      else for (const f of feesOn(w, t)) sent[cargoOf(f)] = (sent[cargoOf(f)] ?? 0) + 1;
    }
    // Towards the town's next landmark, crates of what it wants sent out.
    const goal = w.town && landmarkGoal(w.town, w.tier)?.goal;
    if (goal && !goal.aboard && !t.boxes && w.town) {
      w.town.goal += feesOn(w, t).filter((f) => cargoOf(f) === goal.cargo).length;
      openLandmark(w, landmarkDue(w.town, false, w.tier));
    }
    const income = payout(w, t.value);
    book(w, t.boxes ? 'containers' : 'cargo', income);
    w.stats.earned += income;
    w.stats.trucks++;
    for (const mark of [
      ...(t.boxes ? ['containerDelivery'] : ['crateDelivery']),
      ...(!t.boxes && onBoard(w, t).some((c) => c.coaster) ? ['coasterDelivery'] : []),
    ]) {
      if (!w.learning.marks.includes(mark)) w.learning.marks.push(mark);
    }
    moneyAt(w, income, w.tileOf(t));
    if (deliverInTown(w, t)) return;
  }
  w.headOut(t);
}

/** What a crate truck is taking to town, in words: "crates of fish", or just "crates". */
export function cratesOf(w: World, t: Truck): string {
  const def = BUSINESSES[w.map.build[t.drop ?? -1]];
  return def?.takes.length === 1 ? `crates of ${cargoName(def.takes[0])}` : 'crates';
}

/**
 * Where a truck delivering in town goes after the stop it is on its way
 * to, in words: ", then timber at the builders' yard, then goods at the
 * department store"; or nothing.
 */
export function laterStops(_w: World, t: Truck): string {
  return (t.stops ?? [])
    .map(({ code }) => {
      const def = BUSINESSES[code];
      const what = def?.takes.length === 1 ? cargoName(def.takes[0]) : 'crates';
      return `, then ${what} at the ${def?.label ?? 'town'}`;
    })
    .join('');
}

/** How many of a truck's crates (or containers) a business takes. */
export function takenBy(w: World, t: Truck, def: Business): number {
  if (def.boxes !== t.boxes) return 0;
  if (t.boxes) return t.cargo;
  return feesOn(w, t).filter((f) => def.takes.includes(cargoOf(f))).length;
}

/**
 * Which businesses in town a loaded truck stops at, and how many of its
 * crates (or containers) each: as many as each takes of what it carries
 * and still wants today, no crate counted for two.
 */
export function townStops(w: World, t: Truck): { code: number; count: number }[] {
  const town = w.town;
  if (!town) return [];
  // What it has of each kind, given out as businesses take them.
  const left = new Map<string, number>();
  if (t.boxes) left.set('box', t.cargo);
  else for (const f of feesOn(w, t)) left.set(cargoOf(f), (left.get(cargoOf(f)) ?? 0) + 1);
  const out: { code: number; count: number }[] = [];
  for (const code of new Set(w.map.build)) {
    const def = BUSINESSES[code];
    if (!def || def.boxes !== t.boxes) continue;
    let want = Math.floor(town.wants[code] ?? 0);
    let count = 0;
    for (const kind of t.boxes ? ['box'] : def.takes) {
      const n = Math.min(want, left.get(kind) ?? 0);
      if (n <= 0) continue;
      left.set(kind, (left.get(kind) ?? 0) - n);
      want -= n;
      count += n;
    }
    if (count > 0) out.push({ code, count });
  }
  return out;
}

/**
 * Send a loaded truck by way of the town, when businesses there take what
 * it carries and still want some today, and the trucks can get there: to
 * each in turn, the nearest next, dropping there what that one takes; the
 * rest go on out by road. What each takes is kept for it as it sets off.
 */
export function deliverInTown(w: World, t: Truck): boolean {
  const town = w.town;
  if (!town) return false;
  const stops = townStops(w, t);
  if (stops.length === 0) return false;
  for (const { code, count } of stops) town.wants[code] = (town.wants[code] ?? 0) - count;
  t.stops = stops;
  return nextStop(w, t);
}

/**
 * On to the nearest of the businesses in town a truck still has crates
 * for; false, giving back what those it cannot get to wanted, if none.
 */
export function nextStop(w: World, t: Truck): boolean {
  const town = w.town;
  const stops = t.stops ?? [];
  t.stops = undefined;
  t.drop = undefined;
  t.dropCount = undefined;
  if (!town || stops.length === 0) return false;
  const m = w.map;
  const codes = new Set(stops.map((s) => s.code));
  const here = w.tileOf(t);
  // Out to the highway and round to the town's road, unless the roads join up on the map.
  const inTown = m.yOf(here) > m.limit;
  const out =
    town.gate >= 0 && !inTown
      ? w.drivePath(here, behind(w, t), m.entry, truckCostFor(w, m.entry, t.bayIdx))
      : null;
  const round = Math.abs(m.yOf(town.gate) - m.yOf(m.entry)) + 2 * Math.abs(HIGHWAY_X);
  let best: { path: number[]; then?: number[]; len: number } | null = null;
  let drop = -1;
  for (let i = 0; i < m.build.length; i++) {
    if (!codes.has(m.build[i])) continue;
    // Delivered at the kerb, on the street the business faces.
    const front = frontOf(m, i, m.orient[i] & 3);
    if (front < 0 || !isPublicRoad(m.build[front])) continue;
    const cost = truckCostFor(w, front, t.bayIdx);
    const direct = w.drivePath(here, behind(w, t), front, cost);
    if (direct && (!best || direct.length < best.len)) {
      best = { path: direct, len: direct.length };
      drop = i;
    }
    const inn = out && w.drivePath(town.gate, -1, front, cost);
    const len = out && inn ? out.length + round + inn.length : Infinity;
    if (out && inn && (!best || len < best.len)) {
      best = { path: out, then: inn, len };
      drop = i;
    }
  }
  if (!best) {
    // None it can get to: what they wanted is theirs again.
    for (const { code, count } of stops) town.wants[code] = (town.wants[code] ?? 0) + count;
    return false;
  }
  const code = m.build[drop];
  const stop = stops.find((s) => s.code === code)!;
  const rest = stops.filter((s) => s !== stop);
  t.state = 'toTown';
  t.path = best.path;
  t.then = best.then;
  t.goal = best.path.length > 0 ? best.path[best.path.length - 1] : here;
  t.drop = drop;
  t.dropCount = stop.count;
  t.stops = rest.length > 0 ? rest : undefined;
  return true;
}

/** Along the highway past the edge of the map, from the port's road round to the town's. */
export function driveRound(_w: World, t: Truck): boolean {
  const r = t.round!;
  let budget = B.TRUCK_SPEED;
  while (budget > 1e-6 && r.length > 0) {
    const dx = r[0] - t.x;
    const dy = r[1] - t.y;
    const d = Math.hypot(dx, dy);
    if (d > 1e-6) t.dir = Math.atan2(dy, dx);
    if (d <= budget) {
      t.x = r[0];
      t.y = r[1];
      r.splice(0, 2);
      budget -= d;
    } else {
      t.x += (dx / d) * budget;
      t.y += (dy / d) * budget;
      budget = 0;
    }
  }
  return r.length === 0;
}

/**
 * A truck turning off the road into a truck bay goes on past the
 * entrance and backs in, to stand facing out on the side of the bay away
 * from its crates, its bed to them; coming at the bay straight on, it
 * swings its nose round across the entrance and backs in from there.
 */
export function startBacking(w: World, t: Truck, bay: Bay): void {
  if (bay.tiles || (t.exports && !iceTruck(w, t)) || t.path.length !== 1 || t.path[0] !== bay.idx) {
    return;
  }
  const from = t.trail?.[1];
  if (from === undefined || from < 0 || from === bay.idx) return;
  const m = w.map;
  const [fx, fy] = [m.xOf(from) + 0.5, m.yOf(from) + 0.5];
  const before = t.trail?.[0] ?? -1;
  const road = before >= 0 ? Math.atan2(fy - m.yOf(before) - 0.5, fx - m.xOf(before) - 0.5) : t.dir;
  t.backing = { x: fx, y: fy, dir: road, k: 0, v: Math.min(t.v ?? 0, 0.2) };
}

/** Backs a truck on into its bay; true once it stands there, facing out. */
export function backIn(w: World, t: Truck, bay: Bay): boolean {
  const b = t.backing!;
  // Slowing from the speed it came at.
  b.v = Math.max(B.TRUCK_BACK_SPEED, b.v * 0.8);
  b.k = Math.min(BACK_TURN, b.k + b.v);
  const cx = w.map.xOf(bay.idx) + 0.5;
  const cy = w.map.yOf(bay.idx) + 0.5;
  const f = b.k / BACK_TURN;
  // Where the game has it, for the trucks round it: on its way in.
  t.x = b.x + (cx - b.x) * f;
  t.y = b.y + (cy - b.y) * f;
  t.v = 0;
  if (f < 1) return false;
  t.dir = Math.atan2(b.y - cy, b.x - cx);
  t.path = [];
  t.backing = undefined;
  return true;
}

/**
 * Where a truck backing into its bay shows, and which way it faces: on
 * past the entrance, swinging its nose away from the bay, then backing
 * round into it, as backIn has it so far through.
 */
export function backingPose(w: World, t: Truck): { x: number; y: number; dir: number } {
  const b = t.backing!;
  const bay = t.bayIdx;
  const m = w.map;
  const lane = B.TRUCK_LANE;
  const rx = Math.cos(b.dir);
  const ry = Math.sin(b.dir);
  const into = Math.atan2(m.yOf(bay) + 0.5 - b.y, m.xOf(bay) + 0.5 - b.x);
  const ix = Math.cos(into);
  const iy = Math.sin(into);
  // Set off from its lane, facing along the road...
  const p0 = { x: b.x - ry * lane, y: b.y + rx * lane };
  // ...on past the entrance, turning its nose away from the bay; or,
  // coming at it straight on, round to the left across the entrance...
  const ahead = Math.cos(b.dir - into) > 0.5;
  const nx = ahead ? ry : rx - ix * 0.7;
  const ny = ahead ? -rx : ry - iy * 0.7;
  const ql = Math.hypot(nx, ny);
  const qx = nx / ql;
  const qy = ny / ql;
  const q = ahead
    ? { x: b.x + ix * 0.3 + qx * 0.4, y: b.y + iy * 0.3 + qy * 0.4 }
    : { x: p0.x + rx * 0.65 - ix * 0.1, y: p0.y + ry * 0.65 - iy * 0.1 };
  // ...and back into the bay, to stand facing out on the right of it.
  const e = { x: b.x + ix + iy * lane, y: b.y + iy - ix * lane };
  const f = b.k / BACK_TURN;
  const bez = (
    a: { x: number; y: number },
    c1: { x: number; y: number },
    c2: { x: number; y: number },
    d: { x: number; y: number },
    u: number,
  ) => {
    const v = 1 - u;
    const at = (k: 'x' | 'y') =>
      v * v * v * a[k] + 3 * v * v * u * c1[k] + 3 * v * u * u * c2[k] + u * u * u * d[k];
    const to = (k: 'x' | 'y') =>
      3 * v * v * (c1[k] - a[k]) + 6 * v * u * (c2[k] - c1[k]) + 3 * u * u * (d[k] - c2[k]);
    return { x: at('x'), y: at('y'), tx: to('x'), ty: to('y') };
  };
  if (f < BACK_PULL) {
    const p = bez(
      p0,
      { x: p0.x + rx * 0.3, y: p0.y + ry * 0.3 },
      { x: q.x - qx * 0.3, y: q.y - qy * 0.3 },
      q,
      f / BACK_PULL,
    );
    return { x: p.x, y: p.y, dir: Math.atan2(p.ty, p.tx) };
  }
  const p = bez(
    q,
    { x: q.x - qx * 0.4, y: q.y - qy * 0.4 },
    { x: e.x - ix * 0.55, y: e.y - iy * 0.55 },
    e,
    (f - BACK_PULL) / (1 - BACK_PULL),
  );
  return { x: p.x, y: p.y, dir: Math.atan2(-p.ty, -p.tx) };
}

/** Off to the highway and away: from town, by the town's own road. */
export function headOut(w: World, t: Truck): void {
  const m = w.map;
  const here = w.tileOf(t);
  const gate = w.town?.gate ?? -1;
  // Off the highway at the nearer end, or the other if that is no way out.
  const exits = hasHighway(m)
    ? [departure(w, here), ...highwayOuts(m).filter((e) => e !== departure(w, here))]
    : gate >= 0 && m.yOf(here) > m.limit
      ? [gate, m.entry]
      : [m.entry];
  for (const exit of exits) {
    const path = w.routeFrom(t, exit, truckCostFor(w, exit, t.bayIdx, t));
    if (!path) continue;
    t.state = 'leaving';
    t.goal = exit;
    t.path = path;
    return;
  }
  removeTruck(w, t);
}

/** A parked truck gives up waiting and drives off. */
export function leavePark(w: World, t: Truck): void {
  w.truckLeave(t);
  t.park = undefined;
}

export function removeTruck(w: World, t: Truck): void {
  w.trucks = w.trucks.filter((q) => q !== t);
}
