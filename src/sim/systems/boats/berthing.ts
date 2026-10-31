// Boats coming and going: the fisheries' and lines' boats setting out, the way
// in by the buoys to the anchorage, berths and which boats they take, coming
// alongside, and each boat's turn.

import type { World } from '../../world';
import { fisheries } from '../economy';
import { Build, TICKS_PER_DAY, isBuoy, isDock } from '../../types';
import * as B from '../../balance';
import type { FisheryTerms } from '../../contracts';
import { buoyGates, harbourCentre } from '../../rules/harbour';
import type { Boat, Crane, Moorage, Vessel } from '../../state';
import { withCargo } from '../../cargo';
import {
  claimRoom,
  depart,
  fairwayFree,
  freeFairway,
  inSight,
  outOfSight,
  plotCourses,
  seaWay,
  takeFairway,
  waitingFor,
} from './traffic';
import { findPath } from '../../path';
import type { CostFn } from '../../path';
import { footprint } from '../../rules/footprint';
import { walkableAt } from '../../rules/placement';
import { message, nag, tip } from '../output';
import { sail } from './seamanship';
import { tugReady } from '../tugs';
import { forklifts, muster } from '../workforce/dockhands';
import { exportsComing, stillLoading } from '../cargo/exports';
import { jibStows } from '../cargo/stores';

export function spawnBoats(w: World): void {
  for (const c of fisheries(w)) {
    if (w.tick < c.nextBoatTick) continue;
    const days = c.terms.boatEvery * w.rng.range(0.7, 1.3);
    c.nextBoatTick = w.tick + Math.round(TICKS_PER_DAY * days);
    if (w.boats.length < B.MAX_BOATS) {
      spawnBoat(w, c.id, c.terms);
    } else {
      // The harbour is jammed; the fishery notices.
      c.satisfaction = Math.max(0, c.satisfaction - B.NO_ROOM_PENALTY);
    }
  }
}

/** A boat sails in from the open sea, or (`close`) from just off the anchorage. */
export function spawnBoat(w: World, contractId: number, terms: FisheryTerms, close = false): void {
  const edge = seaEdgeTiles(w);
  if (edge.length === 0) return;
  // Boats come in from out beyond the outermost pair of green buoys, if
  // any of the open sea lies out there.
  const gate = buoyGates(w.map, false).find((g) => g.b >= 0);
  const m = w.map;
  const beyond = gate
    ? edge.filter((i) => gateSide(w, gate.a, gate.b, m.xOf(i) + 0.5, m.yOf(i) + 0.5) > 0)
    : [];
  const start = w.rng.pick(beyond.length > 0 ? beyond : edge);
  const boat: Boat = {
    id: w.nextId++,
    contractId,
    company: terms.name,
    vessel: terms.vessel,
    draft:
      terms.vessel === 'feeder'
        ? B.FEEDER_DRAFT
        : terms.vessel === 'coaster'
          ? B.COASTER_DRAFT
          : B.BOAT_DRAFT,
    // Containers are all alike; a crate holds the catch.
    fee: terms.vessel === 'feeder' ? terms.fee : withCargo(terms.fee, terms.catch ?? 'fish'),
    anchorTicks: 0,
    mooredTicks: 0,
    grace: 0,
    x: w.map.xOf(start) + 0.5,
    y: w.map.yOf(start) + 0.5,
    dir: Math.PI,
    path: [],
    goal: start,
    state: 'approaching',
    crates: w.rng.int(terms.cratesMin, terms.cratesMax),
    reserved: 0,
    berth: -1,
    jetty: -1,
    timer: 0,
    variant: terms.color,
    came: w.tick,
  };
  boat.grace = B.MOORED_GRACE_TICKS + boat.crates * B.MOORED_TICKS_PER_CRATE;
  w.boats.push(boat);
  w.stats.boats++;
  // The first boat of the game is already coming in, a few tiles off the
  // jetty, and heads straight for a berth.
  if (close) {
    const row = m.yOf(m.entry);
    let x = 0;
    while (x < m.w - 1 && w.boatCost(m.idx(x, row)) !== 1) x++;
    boat.x = Math.min(x + 6, m.w - 2) + 0.5;
    boat.y = row + 0.5;
    boat.dir = Math.PI;
    boat.speed = B.VESSELS[boat.vessel].speed * 0.6;
    if (tryBerth(w, boat)) return;
  }
  // Head for a spot at the anchorage; the berth is decided on arrival.
  const spot = anchorSpot(w, boat);
  const from = w.tileOf(boat);
  const path = route(w, boat, from, spot, boatCostFor(w, boat.draft));
  if (path) {
    // Its way from the edge of the map is long on the open sea: it comes
    // into sight only the last of it out.
    const at = inSight(w, boat, path);
    if (at > 0) {
      boat.x = w.map.xOf(path[at - 1]) + 0.5;
      boat.y = w.map.yOf(path[at - 1]) + 0.5;
    }
    boat.path = path.slice(at);
    boat.goal = spot;
    boat.state = 'approaching';
    // Already under way, heading for the first waypoint.
    const next = boat.path[0] ?? spot;
    boat.dir = Math.atan2(w.map.yOf(next) + 0.5 - boat.y, w.map.xOf(next) + 0.5 - boat.x);
    boat.speed = B.VESSELS[boat.vessel].speed;
  } else {
    boat.state = 'anchored';
  }
}

/**
 * Where a boat goes by the buoys on its way from `from` to `to`, in order.
 * Coming in, the green ones between the two, furthest from the docks
 * first; going out, the red ones further out than it is, nearest first.
 * Between a pair it crosses the line joining them, in a lane of its own
 * and well clear of both; a lone buoy it passes close by.
 */
export function buoyStops(w: World, b: Boat, from: number, to: number, cost: CostFn): number[] {
  const m = w.map;
  const c = harbourCentre(m);
  const d = (i: number) => Math.hypot(m.xOf(i) + 0.5 - c.x, m.yOf(i) + 0.5 - c.y);
  const out = b.state === 'leaving';
  const here = d(from);
  const there = to >= 0 ? d(to) : 0;
  const stops: number[] = [];
  let at = from;
  for (const g of buoyGates(m, out)) {
    const far = g.b < 0 ? d(g.a) : (d(g.a) + d(g.b)) / 2;
    if (out ? far <= here + 0.5 : far >= here - 0.5 || far <= there + 0.5) continue;
    // A pair is crossed one way only, in from the sea or out to it. A
    // boat already on the far side has nothing to cross, rather than
    // going all the way round to come at it the right way.
    const side = g.b < 0 ? 0 : gateSide(w, g.a, g.b, m.xOf(at) + 0.5, m.yOf(at) + 0.5);
    if (out ? side > 0 : side < 0) continue;
    const way = g.b < 0 ? [g.a] : crossing(w, b, g.a, g.b, out, cost);
    stops.push(...way);
    at = way.at(-1) ?? at;
  }
  return stops;
}

/**
 * Which side of the line between buoys `a` and `b` x, y lies on: above
 * zero on the side away from the docks, below on the side towards them.
 */
export function gateSide(w: World, a: number, b: number, x: number, y: number): number {
  const m = w.map;
  const c = harbourCentre(m);
  const ax = m.xOf(a) + 0.5;
  const ay = m.yOf(a) + 0.5;
  const ux = m.xOf(b) + 0.5 - ax;
  const uy = m.yOf(b) + 0.5 - ay;
  const side = (px: number, py: number) => -uy * (px - ax) + ux * (py - ay);
  const docks = side(c.x, c.y);
  return docks === 0 ? 0 : -Math.sign(docks) * side(x, y);
}

/**
 * Where a boat crosses between buoys `a` and `b`: a tile short of the
 * line, one on it and one beyond, so it comes square across rather than
 * running along the line. None if there is no room.
 */
export function crossing(
  w: World,
  boat: Boat,
  a: number,
  b: number,
  out: boolean,
  cost: CostFn,
): number[] {
  const m = w.map;
  const ax = m.xOf(a) + 0.5;
  const ay = m.yOf(a) + 0.5;
  const len = Math.hypot(m.xOf(b) + 0.5 - ax, m.yOf(b) + 0.5 - ay);
  const ux = (m.xOf(b) + 0.5 - ax) / len;
  const uy = (m.yOf(b) + 0.5 - ay) / len;
  const room = B.GATE_CLEARANCE + B.VESSELS[boat.vessel].beam / 2 + 0.5;
  if (len < room * 2) return [];
  // Across the line, the way the boat is going: out from the docks or in.
  const c = harbourCentre(m);
  const outwards = -uy * (ax - c.x) + ux * (ay - c.y) > 0 ? 1 : -1;
  const nx = -uy * outwards * (out ? 1 : -1);
  const ny = ux * outwards * (out ? 1 : -1);
  const tile = (t: number, n: number) =>
    m.idx(Math.floor(ax + ux * t + nx * n), Math.floor(ay + uy * t + ny * n));
  // Each boat has a lane of its own across the middle of the gap.
  const lane = ((boat.id * 7) % 9) / 8 - 0.5;
  const want = len / 2 + lane * (len - room * 2) * 0.8;
  // The nearest place along the line to there that the boat can sail across.
  for (let off = 0; off <= len; off += 0.5) {
    for (const t of [want - off, want + off]) {
      if (t < room || t > len - room) continue;
      const way = [tile(t, -1.5), tile(t, 0), tile(t, 1.5)];
      if (way.every((i) => cost(i) === 1)) return way;
    }
  }
  return [];
}

/** Tiles within two of a buoy, which routes keep off. Not saved. */
export function nearBuoy(w: World): Uint8Array {
  if (w.buoyCache) return w.buoyCache;
  const m = w.map;
  const near = new Uint8Array(m.build.length);
  for (let i = 0; i < m.build.length; i++) {
    if (!isBuoy(m.build[i])) continue;
    const x = m.xOf(i);
    const y = m.yOf(i);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (m.inBounds(x + dx, y + dy)) near[m.idx(x + dx, y + dy)] = 1;
      }
    }
  }
  w.buoyCache = near;
  return near;
}

/**
 * Tiles on the lines between pairs of buoys, the green ones or the red,
 * which boats coming in or going out must not cut past. Not saved.
 */
export function gateLines(w: World, out: boolean): Set<number> {
  if (w.gateCache) return w.gateCache[out ? 1 : 0];
  const m = w.map;
  const lines = [false, true].map((out) => {
    const tiles = new Set<number>();
    for (const g of buoyGates(m, out)) {
      if (g.b < 0) continue;
      const ax = m.xOf(g.a) + 0.5;
      const ay = m.yOf(g.a) + 0.5;
      const ux = m.xOf(g.b) + 0.5 - ax;
      const uy = m.yOf(g.b) + 0.5 - ay;
      const n = Math.ceil(Math.hypot(ux, uy) * 4);
      for (let k = 1; k < n; k++) {
        const i = m.idx(Math.floor(ax + (ux * k) / n), Math.floor(ay + (uy * k) / n));
        if (!isBuoy(m.build[i])) tiles.add(i);
      }
    }
    return tiles;
  });
  w.gateCache = lines;
  return lines[out ? 1 : 0];
}

/** A route through each of `stops` in turn; any it cannot reach it leaves out. */
export function via(
  w: World,
  from: number,
  stops: number[],
  to: number,
  cost: CostFn,
): number[] | null {
  const m = w.map;
  const path: number[] = [];
  let at = from;
  for (const s of stops) {
    const leg = findPath(m.w, m.h, at, s, cost, true);
    if (!leg) continue;
    path.push(...leg);
    at = s;
  }
  const last = findPath(m.w, m.h, at, to, cost, true);
  if (last) return [...path, ...last];
  return stops.length > 0 ? findPath(m.w, m.h, from, to, cost, true) : null;
}

/** A route for this boat from `from` to `to`, by way of the buoys it should pass. */
export function route(w: World, b: Boat, from: number, to: number, cost: CostFn): number[] | null {
  return via(w, from, buoyStops(w, b, from, to, cost), to, byDocks(w, cost, from, to));
}

/**
 * Routes keep out of the water in front of other docks, where boats come
 * alongside and pull out: past them further out, not across it. The docks
 * at either end of the route are free to use.
 */
export function byDocks(w: World, cost: CostFn, from: number, to: number): CostFn {
  const front = dockFront(w);
  const own = [front[from], front[to]];
  return (i) => (front[i] >= 0 && !own.includes(front[i]) ? cost(i) * B.DOCK_FRONT_COST : cost(i));
}

/**
 * For water within a few tiles of a jetty or quay, the dock it lies off
 * (its key, see dockKey); -1 elsewhere. Not saved.
 */
export function dockFront(w: World): Int32Array {
  if (w.frontCache) return w.frontCache;
  docks(w);
  const m = w.map;
  const front = new Int32Array(m.build.length).fill(-1);
  const near = new Float32Array(m.build.length).fill(Infinity);
  const r = B.DOCK_FRONT_RANGE;
  for (const [i, key] of w.dockKey) {
    const x = m.xOf(i);
    const y = m.yOf(i);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > r || !m.inBounds(x + dx, y + dy)) continue;
        const j = m.idx(x + dx, y + dy);
        if (m.ocean[j] && d < near[j]) {
          near[j] = d;
          front[j] = key;
        }
      }
    }
  }
  w.frontCache = front;
  return front;
}

/**
 * Open water offshore and off to one side of the harbour mouth, where boats
 * wait for a berth without blocking the way in and out. Derived from the
 * map, so it is not saved.
 */
export function anchorage(w: World): number {
  if (w.anchorageTile >= 0) return w.anchorageTile;
  const m = w.map;
  const row = m.yOf(m.entry);
  let x = 0;
  while (x < m.w - 1 && w.boatCost(m.idx(x, row)) !== 1) x++;
  x += 9;
  // Out beyond the water off the furthest dock, too.
  for (let i = 0; i < m.build.length; i++) {
    if (isDock(m.build[i])) x = Math.max(x, m.xOf(i) + B.DOCK_FRONT_RANGE + 2);
  }
  x = Math.min(x, m.w - 8);
  // North or south of the fairway, whichever side has more open sea.
  const open = (cy: number) => {
    let n = 0;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const tx = x + dx;
        const ty = cy + dy;
        if (m.inBounds(tx, ty) && boatCostFor(w, B.FEEDER_DRAFT)(m.idx(tx, ty)) === 1) n++;
      }
    }
    return n;
  };
  const north = Math.max(4, row - 10);
  const south = Math.min(m.limit - 5, row + 10);
  w.anchorageTile = m.idx(x, open(north) >= open(south) ? north : south);
  return w.anchorageTile;
}

/**
 * Whether a long ship coming in is pointing away from where its way goes
 * on, still a ship's length or more off its berth, not just waiting on
 * others. A small boat turns on the spot.
 */
export function cannotTurn(w: World, b: Boat): boolean {
  const m = w.map;
  if (B.VESSELS[b.vessel].length < B.CAREFUL_LENGTH) return false;
  const next = b.path[0];
  if (next === undefined || w.roomWait.has(b) || b.yieldFor !== undefined) return false;
  // Lining up alongside, swinging round slowly, is not being stuck.
  if (b.berthing === 'align' || b.berthing === 'line' || b.berthing === 'out') return false;
  const far =
    Math.hypot(m.xOf(b.berth) + 0.5 - b.x, m.yOf(b.berth) + 0.5 - b.y) > B.VESSELS[b.vessel].length;
  const course = Math.atan2(m.yOf(next) + 0.5 - b.y, m.xOf(next) + 0.5 - b.x);
  return far && Math.cos(course - b.dir) < 0;
}

/**
 * A boat coming in that has given up its berth sails back out to the
 * anchorage, to wait its turn again: it keeps the time it has waited, so
 * it is called in first.
 */
export function backToSea(w: World, b: Boat): void {
  freeFairway(w, b);
  b.berth = b.jetty = -1;
  b.lineup = b.lineEnd = b.berthing = undefined;
  b.plan = undefined;
  b.waitingOn = undefined;
  b.waitedFor = 0;
  b.stall = 0;
  b.held = 0;
  b.best = Infinity;
  const spot = anchorSpot(w, b);
  const path = route(w, b, w.tileOf(b), spot, boatCostFor(w, b.draft));
  if (!path) {
    b.state = 'anchored';
    b.speed = 0;
    return;
  }
  b.path = path;
  b.goal = spot;
  b.state = 'approaching';
}

/** A free spot at the anchorage, clear of other waiting boats. */
export function anchorSpot(w: World, boat: Boat): number {
  const m = w.map;
  const centre = anchorage(w);
  const cx = m.xOf(centre);
  const cy = m.yOf(centre);
  const row = m.yOf(m.entry);
  // Room to swing at anchor: big ships need more of it.
  const taken = w.boats
    .filter((b) => b !== boat && (b.state === 'approaching' || b.state === 'anchored'))
    .map((b) => ({
      at: b.goal,
      room: (B.VESSELS[b.vessel].length + B.VESSELS[boat.vessel].length) / 2 + 1.5,
    }));
  const front = dockFront(w);
  // A long ship needs open water to come round in when it is called in,
  // so it anchors out to sea of the anchorage, furthest out first, never
  // in towards the docks.
  const seaward = B.VESSELS[boat.vessel].length >= B.CAREFUL_LENGTH;
  for (let r = 0; r < 14; r++) {
    const ring: [number, number][] = [];
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = seaward ? -1 : -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r) ring.push([cx + dx * 2, cy + dy]);
      }
    }
    if (seaward) ring.sort((p, q) => q[0] - p[0]);
    for (const [x, y] of ring) {
      if (!m.inBounds(x, y)) continue;
      // Stay out of the fairway in front of the harbour, and out of the
      // water off the docks that ships manoeuvre in.
      if (Math.abs(y - row) < 6) continue;
      const i = m.idx(x, y);
      if (boatCostFor(w, boat.draft)(i) !== 1 || front[i] >= 0) continue;
      const clear = taken.every((t) => Math.hypot(m.xOf(t.at) - x, m.yOf(t.at) - y) > t.room);
      if (clear && swingRoom(w, boat, x + 0.5, y + 0.5)) return i;
    }
  }
  return centre;
}

/** Open water, nothing built, all within `r` tiles of x, y. */
export function openAround(w: World, x: number, y: number, r: number): boolean {
  const m = w.map;
  for (let ty = Math.floor(y - r); ty <= Math.floor(y + r); ty++) {
    for (let tx = Math.floor(x - r); tx <= Math.floor(x + r); tx++) {
      if (Math.hypot(tx + 0.5 - x, ty + 0.5 - y) > r + 0.5 || !m.inBounds(tx, ty)) continue;
      const i = m.idx(tx, ty);
      if (m.isLand(i) || (m.build[i] !== Build.None && !isBuoy(m.build[i]))) return false;
    }
  }
  return true;
}

/**
 * Whether a boat can lie at anchor here and swing round it: a small boat
 * clear of the shore; a long ship coming round under way to head off
 * anywhere too, so open water all round, a whole ship's length each way,
 * clear of moored boats.
 */
export function swingRoom(w: World, boat: Boat, x: number, y: number): boolean {
  const v = B.VESSELS[boat.vessel];
  // A small boat swings round on its anchor clear of the shore.
  if (v.length < B.CAREFUL_LENGTH) return openAround(w, x, y, v.length / 2 + 0.5);
  const r = v.length;
  if (!openAround(w, x, y, r)) return false;
  return w.boats.every(
    (o) =>
      o === boat ||
      o.state !== 'moored' ||
      Math.hypot(o.x - x, o.y - y) > r + B.VESSELS[o.vessel].length / 2,
  );
}

/** Anchored boats get berths in the order they arrived. */
export function nextInQueue(w: World): Boat | undefined {
  let first: Boat | undefined;
  for (const b of w.boats) {
    if (b.state === 'anchored' && (!first || b.anchorTicks > first.anchorTicks)) first = b;
  }
  return first;
}

export function seaEdgeTiles(w: World): number[] {
  const out: number[] = [];
  const x = w.map.w - 1;
  // Off the port's own coast, not the country's past it.
  for (let y = 1; y < w.map.limit - 1; y++) {
    const i = w.map.idx(x, y);
    if (w.boatCost(i) === 1) out.push(i);
  }
  return out;
}

/** Open sea at least `draft` metres deep. */
export function boatCostFor(w: World, draft: number): CostFn {
  let fn = w.boatCosts.get(draft);
  if (!fn) {
    // Boats give buoys a wide berth, unless making for one.
    fn = (i) =>
      !w.map.ocean[i] || w.map.depth[i] < draft
        ? Infinity
        : w.map.build[i] === Build.None
          ? nearBuoy(w)[i]
            ? B.BUOY_DETOUR / 2
            : 1
          : isBuoy(w.map.build[i])
            ? B.BUOY_DETOUR
            : Infinity;
    w.boatCosts.set(draft, fn);
  }
  return fn;
}

/**
 * Tiles a moored boat covers: its berth plus one tile either way along the
 * jetty, since boats are about two tiles long. Null if it would hit land.
 */
export function mooredTiles(w: World, berth: number, jetty: number, half = 1): number[] | null {
  const m = w.map;
  const x = m.xOf(berth);
  const y = m.yOf(berth);
  const alongX = m.yOf(jetty) !== y;
  const ends: number[][] = [];
  for (let k = 1; k <= half; k++) {
    ends.push(
      ...(alongX
        ? [
            [x - k, y],
            [x + k, y],
          ]
        : [
            [x, y - k],
            [x, y + k],
          ]),
    );
  }
  const out = [berth];
  for (const [ex, ey] of ends) {
    if (!m.inBounds(ex, ey)) return null;
    const i = m.idx(ex, ey);
    if (m.isLand(i) || m.build[i] !== Build.None) return null;
    out.push(i);
  }
  return out;
}

/**
 * Two boats moored at these berths would lie too close: each hull keeps
 * BERTH_END_GAP of clear water off its bow and its stern, so boats lying
 * end to end in one lane have room between them.
 */
export function berthsClash(w: World, a: Moorage, b: Moorage): boolean {
  const m = w.map;
  const extent = (q: Moorage) => {
    const v = B.VESSELS[q.vessel];
    const along = v.length / 2 + B.BERTH_END_GAP / 2;
    // Lying along the dock: along x when the jetty is in another row.
    return m.yOf(q.jetty) !== m.yOf(q.berth) ? [along, v.beam / 2] : [v.beam / 2, along];
  };
  const [ax, ay] = extent(a);
  const [bx, by] = extent(b);
  return (
    Math.abs(m.xOf(a.berth) - m.xOf(b.berth)) < ax + bx - 1e-6 &&
    Math.abs(m.yOf(a.berth) - m.yOf(b.berth)) < ay + by - 1e-6
  );
}

/** The vessel berths are counted and handed out for. */
export function vesselFor(_w: World, wide: boolean, needCrane: boolean): Vessel {
  return needCrane ? 'feeder' : wide ? 'coaster' : 'smack';
}

/** Berth tiles either side of the middle: feeders are long ships. */
export function boatHalf(_w: World, feeder: boolean): number {
  return feeder ? B.FEEDER_HALF_BERTH : 1;
}

/** How many boats of this draft could moor at once, ignoring current traffic. */
/**
 * Docks (connected jetty or quay structures) and whether the harbour
 * office coordinates each. Without an office only the first FREE_DOCKS
 * jetties, nearest the truck bay, are used; quays always need one.
 */
export function docks(w: World): { tiles: number[]; quay: boolean; coordinated: boolean }[] {
  if (w.dockCache) return w.dockCache;
  const m = w.map;
  const seen = new Uint8Array(m.build.length);
  const groups: { tiles: number[]; quay: boolean; coordinated: boolean; d: number }[] = [];
  const home = muster(w);
  for (let i = 0; i < m.build.length; i++) {
    if (seen[i] || !isDock(m.build[i])) continue;
    const tiles: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length > 0) {
      const t = stack.pop()!;
      tiles.push(t);
      for (const n of m.neighbors4(t)) {
        if (!seen[n] && isDock(m.build[n])) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    const quay = tiles.some((t) => m.build[t] !== Build.Jetty);
    const d = Math.min(...tiles.map((t) => w.dist(t, home)));
    groups.push({ tiles, quay, coordinated: false, d });
  }
  groups.sort((a, b) => a.d - b.d || a.tiles[0] - b.tiles[0]);
  let offices = 0;
  let huts = 0;
  for (const b of m.build) {
    if (b === Build.Office) offices++;
    else if (b === Build.HarbourHut) huts++;
  }
  groups.slice(0, offices * B.DOCKS_PER_OFFICE).forEach((g) => (g.coordinated = true));
  // Jetties the offices leave: a few run on their own while there is no
  // office, and each harbourmaster's hut looks after a few more.
  groups
    .filter((g) => !g.quay && !g.coordinated)
    .slice(0, huts * B.JETTIES_PER_HUT + (offices > 0 ? 0 : B.FREE_DOCKS))
    .forEach((g) => (g.coordinated = true));
  w.dockCache = groups;
  w.coordinated = new Set(groups.filter((g) => g.coordinated).flatMap((g) => g.tiles));
  w.dockKey = new Map(
    groups.flatMap((g) => {
      const key = Math.min(...g.tiles);
      return g.tiles.map((t) => [t, key] as [number, number]);
    }),
  );
  return groups;
}

/** Dock tiles boats may use; see docks(). */
export function dockInUse(w: World, i: number): boolean {
  docks(w);
  return w.coordinated.has(i);
}

/**
 * Big ships moor only against a quay at least two tiles wide: the dock tile
 * beside the berth and the one behind it, away from the water.
 */
export function wideQuay(w: World, j: number, berth: number): boolean {
  const m = w.map;
  const behind = m.idx(2 * m.xOf(j) - m.xOf(berth), 2 * m.yOf(j) - m.yOf(berth));
  const quay = (i: number) => isDock(m.build[i]) && m.build[i] !== Build.Jetty;
  return (
    quay(j) && m.inBounds(2 * m.xOf(j) - m.xOf(berth), 2 * m.yOf(j) - m.yOf(berth)) && quay(behind)
  );
}

/** A jib crane stands over this berth. */
export function jibAt(w: World, berth: number): boolean {
  const m = w.map;
  return [...w.cranes.values()].some(
    (c) =>
      c.kind === 'jib' &&
      Math.max(Math.abs(m.xOf(c.idx) - m.xOf(berth)), Math.abs(m.yOf(c.idx) - m.yOf(berth))) <= 1,
  );
}

/** A harbour or gantry crane stands over this berth. */
export function harbourCraneReaches(w: World, berth: number): boolean {
  for (const c of w.cranes.values()) {
    if (c.kind !== 'jib' && craneFront(w, c).some((t) => near(w, t, berth))) return true;
  }
  return false;
}

/** Whether a container crane stands at this dock tile, at the quay edge a ship lies against. */
export function craneAgainst(w: World, j: number): boolean {
  for (const c of w.cranes.values()) {
    if (c.kind !== 'jib' && craneFront(w, c).includes(j)) return true;
  }
  return false;
}

/** Within a tile of each other, diagonals too. */
export function near(w: World, a: number, b: number): boolean {
  const m = w.map;
  return Math.max(Math.abs(m.xOf(a) - m.xOf(b)), Math.abs(m.yOf(a) - m.yOf(b))) <= 1;
}

/** The quay-edge tiles a crane reaches out over the water from. */
export function craneFront(w: World, c: Crane): number[] {
  if (c.kind !== 'gantry') return [c.idx];
  return footprint(w.map, 'gantryCrane', c.idx, w.map.orient[c.idx]).slice(0, 2);
}

/**
 * Where a load is collected from a crane: its landing stack, or for a
 * gantry the bay between its back legs.
 */
export function pickTile(w: World, c: Crane): number {
  if (c.kind !== 'gantry') return c.idx;
  return footprint(w.map, 'gantryCrane', c.idx, w.map.orient[c.idx])[2];
}

export function berthCount(w: World, draft: number, wide = false, needCrane = false): number {
  const m = w.map;
  const water = boatCostFor(w, draft);
  const vessel = vesselFor(w, wide, needCrane);
  const chosen: Moorage[] = [];
  for (let j = 0; j < m.build.length; j++) {
    if (!dockInUse(w, j)) continue;
    for (const n of m.neighbors4(j)) {
      if (water(n) !== 1) continue;
      if (wide && !wideQuay(w, j, n)) continue;
      if (needCrane !== harbourCraneReaches(w, n)) continue;
      if (!needCrane && !walkableAt(m, j) && !jibAt(w, n)) continue;
      const here = { berth: n, jetty: j, vessel };
      if (!mooredTiles(w, n, j, boatHalf(w, needCrane))) continue;
      if (!chosen.some((c) => berthsClash(w, here, c))) chosen.push(here);
    }
  }
  return chosen.length;
}

/** Water tiles beside a jetty where a boat can moor, nearest first. */
export function freeBerths(
  w: World,
  from: number,
  draft: number,
  wide: boolean,
  needCrane = false,
): { berth: number; jetty: number }[] {
  const water = boatCostFor(w, draft);
  const m = w.map;
  const vessel = vesselFor(w, wide, needCrane);
  const taken = w.boats.filter((b) => b.berth >= 0);
  const out: { berth: number; jetty: number; d: number; craned: boolean }[] = [];
  // With nobody to unload by hand, boats wait for a berth under a jib crane.
  let cranes = false;
  const forks = forklifts(w);
  for (let j = 0; j < m.build.length; j++) {
    if (!dockInUse(w, j)) continue;
    for (const n of m.neighbors4(j)) {
      if (water(n) !== 1) continue;
      if (wide && !wideQuay(w, j, n)) continue;
      // Berths under a harbour crane are kept for container ships, which
      // lie square in front of the crane, centred on it.
      if (needCrane ? !craneAgainst(w, j) : harbourCraneReaches(w, n)) continue;
      if (!mooredTiles(w, n, j, boatHalf(w, needCrane))) continue;
      const nx = m.xOf(n);
      const ny = m.yOf(n);
      // A crane is only any use with forklifts to take what it lands, or
      // storage it can swing it into: dockhands keep away from cranes.
      // Lying square under the jib crane, centred on it.
      const jib = w.cranes.get(j);
      const craned = !!jib && jib.kind === 'jib' && (forks || jibStows(w, jib));
      cranes ||= craned;
      // Nobody could unload it by hand next to a crane, or off machines-only quay.
      if (!needCrane && !craned && !walkableAt(m, j)) continue;
      const here = { berth: n, jetty: j, vessel };
      if (taken.some((t) => berthsClash(w, here, t))) continue;
      // Not while another boat is still pulling out of it.
      const bx = m.xOf(n) + 0.5;
      const by = m.yOf(n) + 0.5;
      const busy = w.boats.some(
        (b) => b.state === 'leaving' && Math.hypot(b.x - bx, b.y - by) < 2.5,
      );
      if (busy) continue;
      // The harbour master sends boats to the best-equipped free berth:
      // under a crane first, then a quay forklifts can reach; a container
      // ship under a gantry crane rather than a slower harbour crane.
      const bonus = needCrane
        ? w.gantryReaches(n)
          ? 200
          : 0
        : craned
          ? 200
          : m.build[j] === Build.Jetty
            ? 0
            : 100;
      const d = Math.abs(nx - m.xOf(from)) + Math.abs(ny - m.yOf(from)) - bonus;
      out.push({ berth: n, jetty: j, d, craned });
    }
  }
  const hands = needCrane || w.people.some((q) => q.kind === 'dockhand');
  if (!hands && cranes && out.some((b) => !b.craned)) tip(w, 'noHands');
  return out
    .filter((b) => hands || !cranes || b.craned)
    .sort((a, b) => a.d - b.d || a.berth - b.berth);
}

export function tryBerth(w: World, boat: Boat): boolean {
  const from = w.tileOf(boat);
  const feeder = boat.vessel === 'feeder';
  // One boat at a time comes alongside or pulls out in each lane; the rest
  // wait at the anchorage, out of the way. Of the berths with a clear lane,
  // the best few that can be reached.
  const berths = freeBerths(w, from, boat.draft, boat.vessel !== 'smack', feeder)
    .filter((c) => fairwayFree(w, boat, c.jetty, c.berth))
    .slice(0, 6);
  for (const c of berths) {
    const path =
      (B.VESSELS[boat.vessel].length >= B.LINE_UP_LENGTH
        ? approachPath(w, boat, from, c.berth, c.jetty)
        : null) ?? route(w, boat, from, c.berth, seaWay(w, boat));
    if (!path) continue;
    boat.berth = c.berth;
    boat.jetty = c.jetty;
    // A big ship lining up out at sea takes the lane only once it is there.
    if (boat.berthing !== 'lead') takeFairway(w, boat);
    boat.best = Infinity;
    boat.path = path;
    boat.goal = c.berth;
    boat.state = 'arriving';
    return true;
  }
  boat.state = 'anchored';
  return false;
}

/**
 * The way in to a berth: out to a line a tile off it, along that line, so
 * the ship comes up parallel to the dock, then sideways in. The longer the
 * ship, the further out it lines up: half as far again as its length, or
 * as much of that as there is open water for. Null when there is no clear
 * line either way along.
 */
export function approachPath(
  w: World,
  boat: Boat,
  from: number,
  berth: number,
  jetty: number,
): number[] | null {
  const m = w.map;
  const ox = m.xOf(berth) - m.xOf(jetty);
  const oy = m.yOf(berth) - m.yOf(jetty);
  const ax = oy !== 0 ? 1 : 0;
  const ay = oy !== 0 ? 0 : 1;
  const length = B.VESSELS[boat.vessel].length;
  const sea = seaWay(w, boat);
  let best: number[] | null = null;
  boat.lineup = boat.lineEnd = boat.berthing = undefined;
  for (const s of [1, -1]) {
    const run = openAlong(w, boat, berth, jetty, s, length / 2);
    if (run < 0) continue;
    const line: number[] = [];
    for (let k = run; k >= 0; k--) {
      line.push(m.idx(m.xOf(berth) + ox + ax * s * k, m.yOf(berth) + oy + ay * s * k));
    }
    const lead = route(w, boat, from, line[0], sea);
    if (!lead) continue;
    const path = [...lead, ...line.slice(1), berth];
    if (!best || path.length < best.length) {
      best = path;
      boat.lineup = line[0];
      boat.lineEnd = line[line.length - 1];
      boat.berthing = 'lead';
    }
  }
  return best;
}

/**
 * A long ship leaving its berth runs out along the dock, a tile off it,
 * to open water before it turns: bow first if there is room that way,
 * otherwise astern. Sets it up as berthing 'out'.
 */
export function planRunOut(w: World, b: Boat): void {
  b.lineup = b.lineEnd = b.berthing = undefined;
  const v = B.VESSELS[b.vessel];
  if (v.length < B.RUN_OUT_LENGTH) return;
  const m = w.map;
  const ox = m.xOf(b.berth) - m.xOf(b.jetty);
  const oy = m.yOf(b.berth) - m.yOf(b.jetty);
  const ax = oy !== 0 ? 1 : 0;
  const ay = oy !== 0 ? 0 : 1;
  // Bow first: the way along the dock the ship is pointing.
  const ahead = Math.cos(b.dir) * ax + Math.sin(b.dir) * ay >= 0 ? 1 : -1;
  // A tile off the dock, with plenty of room to swing if it can be had,
  // at least just enough; or where the water off the berth is too
  // shallow, straight along the dock from the berth itself.
  for (const [s, r, off] of [
    [ahead, v.length / 2 + 0.5, 1],
    [-ahead, v.length / 2 + 0.5, 1],
    [ahead, v.length / 2, 1],
    [-ahead, v.length / 2, 1],
    [ahead, v.length / 2, 0],
    [-ahead, v.length / 2, 0],
  ]) {
    const run = openAlong(w, b, b.berth, b.jetty, s, r, off);
    if (run < 0) continue;
    const x = m.xOf(b.berth) + ox * off;
    const y = m.yOf(b.berth) + oy * off;
    b.lineEnd = m.idx(x, y);
    b.lineup = m.idx(x + ax * s * run, y + ay * s * run);
    b.berthing = 'out';
    return;
  }
}

/**
 * How many tiles along the dock, going `s` way (1 or -1) on the line
 * `off` tiles out from the berth, a long ship has to go to find open water `r` tiles
 * all round to turn in: between half its length and half as long again,
 * and -1 when there is none.
 */
export function openAlong(
  w: World,
  boat: Boat,
  berth: number,
  jetty: number,
  s: number,
  r: number,
  off = 1,
): number {
  const m = w.map;
  const water = boatCostFor(w, boat.draft);
  const ax = m.yOf(berth) !== m.yOf(jetty) ? 1 : 0;
  const ay = 1 - ax;
  const ox = (m.xOf(berth) - m.xOf(jetty)) * off;
  const oy = (m.yOf(berth) - m.yOf(jetty)) * off;
  const length = B.VESSELS[boat.vessel].length;
  const least = Math.ceil(length / 2) + 1;
  const most = Math.ceil(length * 1.5) + 1;
  const at = (k: number) => [m.xOf(berth) + ox + ax * s * k, m.yOf(berth) + oy + ay * s * k];
  const [x0, y0] = at(0);
  if (!m.inBounds(x0, y0) || water(m.idx(x0, y0)) !== 1) return -1;
  // As far out along the dock as the water stays open...
  let run = 0;
  while (run < most) {
    const [x, y] = at(run + 1);
    if (!m.inBounds(x, y) || water(m.idx(x, y)) !== 1) break;
    run++;
  }
  // ...and back to where there is room to swing round.
  while (run >= least) {
    const [x, y] = at(run);
    if (openAround(w, x + 0.5, y + 0.5, r)) return run;
    run--;
  }
  return -1;
}

/**
 * Coming alongside, moving to x, y would take a boat further into water a
 * ship pulling out has claimed, other than water round its own berth.
 */
export function intoClaimed(w: World, b: Boat, x: number, y: number): boolean {
  const m = w.map;
  const bx = m.xOf(b.berth) + 0.5;
  const by = m.yOf(b.berth) + 0.5;
  return w.boats.some((o) => {
    if (o === b || !o.room) return false;
    const spots = o.room.spots;
    if (spots.some(([sx, sy, r]) => Math.hypot(bx - sx, by - sy) < r + 1)) return false;
    return spots.some(
      ([sx, sy, r]) =>
        Math.hypot(x - sx, y - sy) < r &&
        Math.hypot(x - sx, y - sy) < Math.hypot(b.x - sx, b.y - sy),
    );
  });
}

/** Lying in the water a ship pulling out has claimed: it waits to cast off. */
export function boxedIn(w: World, b: Boat): boolean {
  return w.boats.some((o) =>
    o.room?.spots.some(([x, y, r]) => Math.hypot(b.x - x, b.y - y) < r + 0.5),
  );
}

/**
 * A ship that claims water to turn in as it pulls out lets a boat in that
 * water go first if it has been ready to leave longer: first ready, first
 * out, so no boat waits out one ship after another.
 * One that is itself waiting on the fairway, its tug or room to turn is
 * not waited for: the rest go on round it.
 */
export function letsGoFirst(w: World, b: Boat): boolean {
  const v = B.VESSELS[b.vessel];
  if (v.length < B.RUN_OUT_LENGTH) return false;
  // As far as its run out along the dock and the water it turns in reach.
  const reach = v.length * 2 + B.ROOM_MARGIN;
  return w.boats.some(
    (o) =>
      o !== b &&
      o.state === 'moored' &&
      o.crates === 0 &&
      o.reserved === 0 &&
      o.timer > b.timer &&
      // Not one that cannot go anyway, held up by something else.
      (o.holdUp === undefined || o.holdUp === 'others') &&
      Math.hypot(o.x - b.x, o.y - b.y) < reach,
  );
}

export function updateBoat(w: World, b: Boat): void {
  plotCourses(w);
  if (b.state === 'anchored' || b.state === 'moored') {
    // A container ship takes long to work, and allows for that.
    const patience = B.BOAT_GIVE_UP_TICKS + (b.vessel === 'feeder' ? b.grace : 0);
    if (b.anchorTicks + b.mooredTicks > patience && b.crates > 0) {
      // The claim message in judgeVisit explains what happened.
      if (b.state === 'anchored' || !boxedIn(w, b)) return depart(w, b, true);
    }
  }
  switch (b.state) {
    case 'approaching':
      if (sail(w, b, null) !== 'moving') {
        b.state = 'anchored';
        b.speed = 0;
        const queue = w.boats.filter((q) => q.state === 'anchored').length;
        if (!tryBerth(w, b) && queue === 1) {
          nag(w, 'queue', 'Boats are queueing at the anchorage. Every berth is taken.', 'info');
        }
      }
      return;
    case 'anchored':
      b.anchorTicks++;
      // The harbour master calls in whoever has waited longest and fits a
      // free berth: a ship waiting for a crane berth does not hold up the
      // boats behind it.
      if (w.tick % 10 === 0 && nextInQueue(w) === b) {
        const queue = w.boats
          .filter((q) => q.state === 'anchored')
          .sort((p, q) => q.anchorTicks - p.anchorTicks);
        for (const q of queue) if (tryBerth(w, q)) break;
      }
      return;
    case 'arriving': {
      // Unable to come round for a good while, still far off its berth, as
      // a long ship pointing the wrong way in a basin: it gives the berth
      // up and heads back out to sea, to be called in again from the
      // anchorage with room to come in properly.
      if ((b.stall ?? 0) > B.BOAT_WEDGED_AFTER && cannotTurn(w, b)) return backToSea(w, b);
      // Come alongside: lie along the berth, parallel to the dock edge.
      const alongX = w.map.yOf(b.jetty) !== w.map.yOf(b.berth);
      // Something has been built where its hull would lie: another berth.
      const gone = !mooredTiles(w, b.berth, b.jetty, boatHalf(w, b.vessel === 'feeder'));
      const r = gone ? 'blocked' : sail(w, b, alongX ? 0 : Math.PI / 2);
      if (r === 'blocked') {
        freeFairway(w, b);
        b.berth = b.jetty = -1;
        b.state = 'anchored';
        b.speed = 0;
      } else if (r === 'arrived') {
        freeFairway(w, b);
        b.state = 'moored';
        b.speed = 0;
        // Alongside, it is no longer wedged in anywhere.
        b.squeeze = 0;
        b.held = 0;
        b.lineup = b.lineEnd = b.berthing = undefined;
        b.timer = 0;
        b.mooredAt = w.tick;
        const what =
          b.vessel === 'feeder' ? 'feeder ship' : b.vessel === 'coaster' ? 'coaster' : 'boat';
        const cargo =
          b.vessel === 'feeder'
            ? 'containers'
            : b.vessel === 'coaster'
              ? 'crates on pallets'
              : 'crates';
        // Only a new line's first boat is news; the rest are routine.
        if (w.firstBoat.delete(b.company)) {
          message(w, `A ${b.company} ${what} has moored with ${b.crates} ${cargo}.`, 'info');
        }
        if (b.vessel === 'coaster') tip(w, 'pallets');
        if (b.vessel === 'coaster' && !w.people.some((p) => p.kind === 'forklift')) {
          nag(
            w,
            'pallets',
            'Pallets wait on the quay until a forklift takes them on. Buy one at a depot.',
            'bad',
          );
        }
      }
      return;
    }
    case 'moored': {
      if (b.crates === 0 && b.reserved === 0) b.unloadedAt ??= w.tick;
      // Unloaded, a coaster or feeder takes exports on board before it goes.
      const loading = b.crates === 0 && b.reserved === 0 && stillLoading(w, b);
      // Unloading and loading count against us; waiting for the fairway does not.
      if (b.crates > 0 || b.reserved > 0 || loading) b.mooredTicks++;
      if (loading) {
        // Kept loading long past its time, it sails with what it has.
        if (b.mooredTicks > b.grace + B.LOAD_OVERRUN_TICKS) b.loadQuota = b.out ?? 0;
        // Lying in the way of a ship coming in, it takes on what is on its
        // way to it, and no more.
        if (waitingFor(w, b)) {
          b.loadQuota = Math.min(b.loadQuota ?? Infinity, (b.out ?? 0) + exportsComing(w, b));
        }
        b.timer = 0;
        return;
      }
      if (b.crates === 0 && b.reserved === 0) {
        // Done loading for this visit: it takes on nothing more while it waits to sail.
        b.loadQuota = b.out ?? 0;
        b.loadedAt ??= w.tick;
        if (++b.timer <= 30) return;
        b.holdUp = boxedIn(w, b)
          ? 'room'
          : letsGoFirst(w, b)
            ? 'others'
            : !tugReady(w, b)
              ? 'tug'
              : takeFairway(w, b, true)
                ? undefined
                : 'fairway';
        if (!b.holdUp) depart(w, b, false);
      }
      return;
    }
    case 'leaving':
      claimRoom(w, b);
      // Clear of the dock: the next boat may use its fairway.
      if (b.fairway !== undefined && b.castOff !== undefined && b.berthing !== 'out') {
        const m = w.map;
        if (Math.hypot(b.x - m.xOf(b.castOff) - 0.5, b.y - m.yOf(b.castOff) - 0.5) > 3) {
          freeFairway(w, b);
        }
      }
      const [x, y] = [b.x, b.y];
      const r = sail(w, b, null);
      // Out of sight, out on the open sea: it is gone. By how far it has
      // sailed, not where it is on its way, as that is planned anew
      // whenever it finds another way out.
      b.sailed = (b.sailed ?? 0) + Math.hypot(b.x - x, b.y - y);
      if (r !== 'moving' || (b.sailed >= B.SAIL_IN_TILES && outOfSight(w, b))) {
        freeFairway(w, b);
        w.boats = w.boats.filter((q) => q !== b);
      }
      return;
  }
}
