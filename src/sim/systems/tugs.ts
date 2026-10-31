// Harbour tugs: which ships need them, buying one, and how they lie at their berth, go out to a ship, keep station alongside and come back.

import type { World } from '../world';

const TUG_NAMES = ['Hercules', 'Samson', 'Goliath', 'Titan', 'Atlas', 'Bulldog', 'Ajax', 'Brutus'];
import type { Boat, Tug } from '../state';
import * as B from '../balance';
import { message, moneyAt } from './output';
import { TIERS } from '../tiers';
import { Build, isDock } from '../types';
import { book } from './economy';
import { clamp, wrapAngle } from '../helpers';
import { findPath } from '../path';
import type { CostFn } from '../path';
import { hullOf, inWay, navigable, openWater, pullingOut, seaWayFor } from './boats/traffic';
import { boatCostFor } from './boats/berthing';

/** Coasters and feeders, which tugs work in and out. */
export function needsTugs(_w: World, b: Boat): boolean {
  return b.vessel === 'coaster' || b.vessel === 'feeder';
}

/**
 * A ship wanting a tug now: coming in the last stretch to its berth,
 * nearly unloaded (so the tug is there when it casts off), or pulling out.
 */
export function wantsTug(w: World, b: Boat): boolean {
  if (!needsTugs(w, b)) return false;
  const m = w.map;
  if (b.state === 'arriving') {
    return Math.hypot(m.xOf(b.berth) + 0.5 - b.x, m.yOf(b.berth) + 0.5 - b.y) < B.TUG_MEET;
  }
  const soon = b.state === 'moored' && b.crates + b.reserved <= B.TUG_CALL_LOAD;
  return soon || pullingOut(w, b);
}

/**
 * Ready to cast off: unless its tug is just about to come alongside, when
 * it waits that moment for it, or it has waited long enough.
 */
export function tugReady(w: World, b: Boat): boolean {
  const tug = w.tugs.find((t) => t.ship === b.id);
  if (!tug || tug.state !== 'out') return true;
  const close = Math.hypot(tug.x - b.x, tug.y - b.y) < B.VESSELS[b.vessel].length / 2 + 3;
  return !close || b.timer > 30 + B.TUG_WAIT;
}

/** A tug alongside, working this ship. */
export function tugged(w: World, b: Boat): boolean {
  return w.tugs.some((t) => t.ship === b.id && t.state === 'assist');
}

/**
 * How handy a ship is swinging round, crabbing in alongside and easing
 * off the dock: fully with a tug alongside (and a small boat always), much
 * less on its own.
 */
export function handiness(w: World, b: Boat): number {
  return !needsTugs(w, b) || tugged(w, b) ? 1 : B.UNTUGGED_HANDLING;
}

/** Buy a tug at a tug berth: the one at `tile`, or any without its tug. */
export function buyTug(w: World, tile?: number): void {
  if (w.tier < B.TUG_TIER) {
    return message(w, `Tugs unlock at the ${TIERS[B.TUG_TIER].name}.`, 'bad');
  }
  const m = w.map;
  const free = (i: number) => m.build[i] === Build.TugBerth && !w.tugs.some((t) => t.home === i);
  let home = tile ?? -1;
  if (tile === undefined) {
    for (let i = 0; i < m.build.length && home < 0; i++) if (free(i)) home = i;
    if (home < 0) {
      return message(w, 'Build a tug berth first, in the water beside a jetty or quay.', 'bad');
    }
  } else if (tile < 0 || tile >= m.build.length || m.build[tile] !== Build.TugBerth) {
    return message(w, 'Click a tug berth to buy a tug there', 'bad');
  } else if (!free(tile)) {
    return message(w, 'That berth has its tug already. Each takes one.', 'bad');
  }
  if (w.cash < B.TUG_PRICE) return message(w, 'Not enough money', 'bad');
  book(w, 'construction', -B.TUG_PRICE);
  const name = `Tug ${TUG_NAMES[w.tugs.length % TUG_NAMES.length]}`;
  w.tugs.push({
    id: w.nextId++,
    name,
    home,
    ...tugBerthPose(w, home),
    goal: home,
    speed: 0,
    state: 'idle',
    ship: -1,
    path: [],
    plan: 0,
  });
  moneyAt(w, -B.TUG_PRICE, home);
  message(w, `${name} is ready at its berth.`, 'good');
}

/** Where a tug lies at its berth: in the middle, alongside the dock. */
export function tugBerthPose(w: World, home: number): { x: number; y: number; dir: number } {
  const m = w.map;
  const dock = m.neighbors4(home).find((n) => isDock(m.build[n])) ?? home;
  const out = Math.atan2(m.yOf(home) - m.yOf(dock), m.xOf(home) - m.xOf(dock));
  return { x: m.xOf(home) + 0.5, y: m.yOf(home) + 0.5, dir: wrapAngle(out + Math.PI / 2) };
}

export function updateTugs(w: World): void {
  // A tug whose berth has gone lies up at another free one, or is sold.
  for (const t of [...w.tugs]) {
    if (w.map.build[t.home] === Build.TugBerth) continue;
    const other = w.map.build.findIndex(
      (c, i) => c === Build.TugBerth && !w.tugs.some((q) => q.home === i),
    );
    if (other >= 0) {
      t.home = other;
      if (t.state === 'idle') t.state = 'back';
      t.path = [];
      t.plan = 0;
      continue;
    }
    w.tugs = w.tugs.filter((q) => q !== t);
    book(w, 'construction', B.TUG_PRICE / 2);
    message(
      w,
      `With its berth gone, ${t.name} was sold for $${(B.TUG_PRICE / 2).toLocaleString('en-US')}.`,
      'info',
    );
  }
  // Each ship wanting one gets the nearest free tug.
  for (const b of w.boats) {
    if (!wantsTug(w, b) || w.tugs.some((t) => t.ship === b.id)) continue;
    let best: Tug | undefined;
    for (const t of w.tugs) {
      if (t.ship >= 0) continue;
      if (!best || Math.hypot(t.x - b.x, t.y - b.y) < Math.hypot(best.x - b.x, best.y - b.y)) {
        best = t;
      }
    }
    if (!best) break;
    best.ship = b.id;
    best.state = 'out';
    best.path = [];
    best.plan = 0;
  }
  for (const t of w.tugs) updateTug(w, t);
}

export function updateTug(w: World, t: Tug): void {
  const ship = t.ship >= 0 ? w.boats.find((b) => b.id === t.ship) : undefined;
  // Done, or no longer wanted: back to its berth.
  if (t.ship >= 0 && (!ship || !wantsTug(w, ship))) {
    t.ship = -1;
    t.state = 'back';
    t.path = [];
    t.plan = 0;
  }
  if (t.state === 'idle') return;
  if (t.state === 'back' || !ship) {
    const home = tugBerthPose(w, t.home);
    if (steerTug(w, t, home.x, home.y, t.home, true) < 0.08 && t.speed < 0.02) {
      Object.assign(t, home);
      t.speed = 0;
      t.state = 'idle';
      t.path = [];
    }
    return;
  }
  const spot = tugSpot(w, ship);
  if (t.state === 'out') {
    if (Math.hypot(spot.x - t.x, spot.y - t.y) > 0.9) {
      const goal = w.map.idx(
        clamp(Math.floor(spot.x), 0, w.map.w - 1),
        clamp(Math.floor(spot.y), 0, w.map.h - 1),
      );
      steerTug(w, t, spot.x, spot.y, goal, false);
      return;
    }
    t.state = 'assist';
  }
  // Alongside: keep station on the ship, swinging round with it.
  const dx = spot.x - t.x;
  const dy = spot.y - t.y;
  const d = Math.hypot(dx, dy);
  const step = Math.min(d, 0.2);
  if (d > 1e-6) {
    t.x += (dx / d) * step;
    t.y += (dy / d) * step;
  }
  t.dir = wrapAngle(t.dir + clamp(wrapAngle(spot.dir - t.dir), -0.12, 0.12));
  t.speed = ship.speed ?? 0;
}

/**
 * Where a tug works a ship: alongside, forward of midships, on the side
 * away from the dock it is coming alongside or leaving.
 */
export function tugSpot(w: World, b: Boat): { x: number; y: number; dir: number } {
  const m = w.map;
  const v = B.VESSELS[b.vessel];
  const fx = Math.cos(b.dir);
  const fy = Math.sin(b.dir);
  let px = -fy;
  let py = fx;
  const berth = b.state === 'leaving' ? b.castOff : b.berth;
  const dock = b.state === 'leaving' ? b.castDock : b.jetty;
  if (berth !== undefined && dock !== undefined && berth >= 0 && dock >= 0) {
    const ax = m.xOf(berth) - m.xOf(dock);
    const ay = m.yOf(berth) - m.yOf(dock);
    if (px * ax + py * ay < 0) {
      px = -px;
      py = -py;
    }
  }
  const along = v.length * 0.2;
  const off = v.beam / 2 + B.VESSELS.tug.beam / 2 + 0.05;
  return { x: b.x + fx * along + px * off, y: b.y + fy * along + py * off, dir: b.dir };
}

/**
 * Steer a tug towards x, y (in tile `goal`) the way a boat moves, nimbly:
 * along a route clear of hulls lying still, stopping for anything in its
 * way, and with `stop` set, coming to rest there. Returns how far it has
 * still to go.
 */
export function steerTug(
  w: World,
  t: Tug,
  gx: number,
  gy: number,
  goal: number,
  stop: boolean,
): number {
  const v = B.VESSELS.tug;
  const m = w.map;
  const way = seaWayFor(w, B.TUG_DRAFT, goal, null);
  const cost: CostFn = (i) => (i === t.home || i === goal ? 1 : way(i));
  const left = Math.hypot(gx - t.x, gy - t.y);
  // Plan the way there now and then: what it is meeting moves.
  if (--t.plan <= 0) {
    t.path = findPath(m.w, m.h, w.tileOf(t), goal, cost, true) ?? [];
    t.plan = 25;
  }
  const cx = (i: number) => (i % m.w) + 0.5;
  const cy = (i: number) => Math.floor(i / m.w) + 0.5;
  while (t.path.length > 1 && Math.hypot(cx(t.path[0]) - t.x, cy(t.path[0]) - t.y) < 0.7) {
    t.path.shift();
  }
  // The furthest of the next few waypoints with open water to it; the
  // last is the point itself.
  let ahead = 0;
  for (let k = 1; k < Math.min(t.path.length - 1, 4); k++) {
    if (!openWater(w, t.x, t.y, cx(t.path[k]), cy(t.path[k]), cost, v.beam / 2 + 0.05)) break;
    ahead = k;
  }
  t.path.splice(0, ahead);
  const [tx, ty] = t.path.length > 1 ? [cx(t.path[0]), cy(t.path[0])] : [gx, gy];
  const err = wrapAngle(Math.atan2(ty - t.y, tx - t.x) - t.dir);
  const turn = v.turn * (0.4 + (0.6 * t.speed) / v.speed);
  t.dir = wrapAngle(t.dir + clamp(err, -turn, turn));
  const accel = v.speed * B.BOAT_ACCEL * 2;
  let desired = v.speed * Math.max(0.2, Math.cos(Math.min(Math.abs(err), Math.PI / 2)) ** 2);
  // Easing off to stop there, or to come up alongside a ship under way.
  desired = Math.min(desired, stop ? Math.sqrt(2 * accel * left) + 0.003 : 0.03 + left * 0.1);
  // Stopping for boats moving in its way, but not the ship it is out to;
  // its route already keeps clear of those lying still.
  const me = {
    x: t.x,
    y: t.y,
    hx: Math.cos(t.dir),
    hy: Math.sin(t.dir),
    half: v.length / 2,
    beam: v.beam / 2,
  };
  const look = me.half + 0.4 + (t.speed * t.speed) / (2 * accel);
  // Held up a while, it noses on past for a spell.
  const held = w.tugHeld.get(t) ?? 0;
  const moving = (o: Boat) => (o.speed ?? 0) + (o.sternway ?? 0) > 0.01;
  const hulls =
    held < 0
      ? []
      : [
          ...w.boats.filter((o) => o.id !== t.ship && moving(o)).map((o) => hullOf(w, o)),
          ...w.tugs
            .filter((o) => o !== t && o.state !== 'idle')
            .map((o) => ({
              x: o.x,
              y: o.y,
              hx: Math.cos(o.dir),
              hy: Math.sin(o.dir),
              half: v.length / 2,
              beam: v.beam / 2,
            })),
        ];
  for (const h of hulls) {
    const gap = inWay(w, me, h, look);
    if (gap !== null) desired = Math.min(desired, Math.max(0, (gap - me.half - 0.15) * 0.2));
  }
  t.speed = clamp(t.speed + clamp(desired - t.speed, -accel * 1.5, accel), 0, v.speed);
  // Counting up while held, then down (below zero) while it noses past.
  const stuck = t.speed < 0.01 && left > 0.3;
  w.tugHeld.set(t, held < 0 ? held + 1 : stuck ? (held >= 40 ? -30 : held + 1) : 0);
  const nx = t.x + Math.cos(t.dir) * t.speed;
  const ny = t.y + Math.sin(t.dir) * t.speed;
  // Afloat in deep enough water; the margin round hulls is for routes.
  const water = boatCostFor(w, B.TUG_DRAFT);
  const afloat: CostFn = (i) => (i === t.home || i === goal ? 1 : water(i));
  if (navigable(w, nx, ny, afloat)) {
    t.x = nx;
    t.y = ny;
  } else t.speed = 0;
  return left;
}
