// Boats among boats: giving way, squeezing past, plotting courses, open water
// and fairways, pulling out of a berth, departing and coming into sight.

import type { World } from '../../world';
import { boatCostFor, buoyStops, byDocks, docks, planRunOut, seaEdgeTiles, via } from './berthing';
import type { Boat } from '../../state';
import * as B from '../../balance';
import { clamp, hullGap, wrapAngle } from '../../helpers';
import { clips } from './seamanship';
import { tugged } from '../tugs';
import type { CostFn } from '../../path';
import { Build, isBuoy, isDock } from '../../types';
import { judgeVisit } from '../economy';
import { departTips } from '../output';
import { shipUnloaded } from '../cranes';

/** Moving to x, y heading `dir` would bring the hull up against another boat's. */
export function crowds(world: World, b: Boat, x: number, y: number, dir = b.dir): boolean {
  const v = B.VESSELS[b.vessel];
  // Squeezing past as a last resort, through the boats it is wedged
  // against, but no nearer any other.
  return world.boats.some((o) => {
    const w = B.VESSELS[o.vessel];
    if (o === b || Math.hypot(o.x - x, o.y - y) > (v.length + w.length) / 2 + 1) return false;
    if (squeezingPast(world, b, o)) return false;
    const before = hullGap(b.x, b.y, b.dir, v, o.x, o.y, o.dir, w);
    const after = hullGap(x, y, dir, v, o.x, o.y, o.dir, w);
    return after < 0.1 && after < before;
  });
}

/**
 * Another boat with right of way over this one, under way but held up a
 * while, with this one in the water it would go on into.
 */
export function inWayOfHeld(w: World, b: Boat): Boat | undefined {
  const me = hullOf(w, b);
  return w.boats.find((o) => {
    if (o === b || o.state === 'moored' || o.state === 'anchored') return false;
    if ((o.held ?? 0) <= 20 || !outranks(w, o, b)) return false;
    if (Math.hypot(o.x - b.x, o.y - b.y) > 6) return false;
    const ov = B.VESSELS[o.vessel];
    const look = ov.length / 2 + 0.6 + ov.speed / (2 * B.BOAT_ACCEL);
    return inWay(w, wakeOf(w, o), me, look) !== null;
  });
}

/**
 * Wedged in for good: squeeze past the boats it is wedged against, for a
 * while, as a last resort so the harbour never locks up. Only those: it
 * keeps clear of any other that comes near meanwhile.
 */
export function startSqueeze(w: World, b: Boat): void {
  const v = B.VESSELS[b.vessel];
  b.squeeze = 200;
  // Never over a boat lying still, moored or at anchor.
  b.squeezePast = w.boats
    .filter(
      (o) =>
        o !== b &&
        o.state !== 'moored' &&
        o.state !== 'anchored' &&
        hullGap(b.x, b.y, b.dir, v, o.x, o.y, o.dir, B.VESSELS[o.vessel]) < B.WEDGED_GAP,
    )
    .map((o) => o.id);
}

/** Squeezing past this boat, one it was wedged against; see startSqueeze. */
export function squeezingPast(_w: World, b: Boat, o: Boat): boolean {
  return (b.squeeze ?? 0) > 0 && !!b.squeezePast?.includes(o.id);
}

/** Boats lying still near this one, that its hull must keep clear of. */
export function stillNear(w: World, b: Boat): Boat[] {
  const v = B.VESSELS[b.vessel];
  return w.boats.filter(
    (o) =>
      o !== b &&
      o.state === 'moored' &&
      Math.hypot(o.x - b.x, o.y - b.y) < v.length + B.VESSELS[o.vessel].length / 2 + 2,
  );
}

/**
 * The rules of the road, roughly as at sea. Every boat under way plots
 * where it will be over the next while, and keeps a lookout for any other
 * boat whose plot comes too close to its own. Then whoever has to keep
 * clear (see burden) eases off, as far as it takes for the other to pass
 * ahead of it; meeting head on, both alter to starboard, so they pass
 * port to port. A boat with right of way holds its course and speed, but
 * acts too when a collision is close and the other has not. Returns a
 * turn to add (starboard positive) and a share of speed to keep.
 */
export function rulesOfTheRoad(w: World, b: Boat): { bias: number; slow: number } {
  const mine = plot(w, b, 1);
  let bias = 0;
  /** Plots of the boats to keep clear of, and the first of those boats. */
  const clearOf: [Boat, Float64Array][] = [];
  let first: { of: number; at: number } | undefined;
  for (const [o, theirs] of w.plots) {
    if (o === b || !underWay(w, theirs)) continue;
    const meet = meeting(w, b, mine, o, theirs);
    if (!meet) continue;
    const ticks = meet.at * B.PLOT_STEP;
    const duty = burden(w, b, o);
    const close = ticks <= B.STAND_ON_TICKS;
    if (duty === 'both') {
      // Head on: alter to starboard, the more the sooner they would meet.
      const urgency = clamp(1.3 - ticks / B.LOOKOUT_TICKS, 0, 1) * (meet.gap < 0 ? 1 : 0.6);
      bias += 1.2 * urgency;
    }
    if (duty === 'give' || close) {
      clearOf.push([o, theirs]);
      if (!first || meet.at < first.at) first = { of: o.id, at: meet.at };
    }
  }
  bias = clamp(bias, -0.9, 0.9);
  if (!first) {
    w.keepingClear.delete(b);
    return { bias, slow: 1 };
  }
  // The most way it can keep and still let every one of them by; failing
  // that, whatever puts off meeting the longest.
  let best = { pace: 1, at: -1 };
  for (const pace of [1, 0.75, 0.5, 0.3, 0.15, 0]) {
    const course = pace === 1 ? mine : plot(w, b, pace);
    let at = Infinity;
    for (const [o, theirs] of clearOf) {
      at = Math.min(at, meeting(w, b, course, o, theirs)?.at ?? Infinity);
    }
    if (at > best.at) best = { pace, at };
    if (at === Infinity) break;
  }
  w.keepingClear.set(b, { pace: best.pace, of: first.of });
  return { bias, slow: best.pace };
}

/**
 * Whether a plot goes anywhere. A boat lying stopped, waiting or keeping
 * clear, is a boat in the way like any other (see giveWay), not one to
 * plan round: planning round boats that are waiting on each other would
 * leave them all waiting.
 */
export function underWay(_w: World, plot: Float64Array): boolean {
  const end = plot.length - 3;
  return Math.hypot(plot[end] - plot[0], plot[end + 1] - plot[1]) > 0.5;
}

/**
 * Draw every boat under way's plot for this tick, at the pace it keeps,
 * before the first of them moves.
 */
export function plotCourses(w: World): void {
  if (w.plotsAt === w.tick) return;
  w.plotsAt = w.tick;
  w.plots.clear();
  for (const b of w.boats) {
    if (b.state === 'moored' || b.state === 'anchored') continue;
    // A boat that has lain still a while, waiting or swinging round where
    // it lies, or backing out of another's way, is plotted lying there
    // until it gets going ahead again: it is not coming on along its way.
    const v = B.VESSELS[b.vessel];
    const moving = (b.speed ?? 0) > v.speed * 0.1 && !b.astern;
    const still = moving ? 0 : (w.stillFor.get(b) ?? 0) + 1;
    w.stillFor.set(b, still);
    w.plots.set(b, plot(w, b, still > 10 ? 0 : (w.keepingClear.get(b)?.pace ?? 1)));
  }
}

/**
 * Where a boat under way will be, every PLOT_STEP ticks for LOOKOUT_TICKS,
 * as x, y, heading: along its route as it sails it (see sail), gathering
 * and taking off way, slowing for bends and to stop at its goal, and
 * swinging round no faster than it can turn. `pace` is the share of its
 * speed it keeps to. Running out along the dock, it goes straight out
 * keeping its heading and stops to turn at the end; casting off, it is
 * taken to lie where it is.
 */
export function plot(world: World, b: Boat, pace: number): Float64Array {
  const v = B.VESSELS[b.vessel];
  const n = Math.floor(B.LOOKOUT_TICKS / B.PLOT_STEP) + 1;
  const out = new Float64Array(n * 3);
  const w = world.map.w;
  const xs = [b.x];
  const ys = [b.y];
  const runOut = b.berthing === 'out' && b.lineup !== undefined;
  const route = b.undock ? [] : runOut ? [b.lineup!] : b.path;
  for (const i of route) {
    xs.push((i % w) + 0.5);
    ys.push(Math.floor(i / w) + 0.5);
  }
  const accel = v.speed * B.BOAT_ACCEL;
  const bend = (a: number) =>
    v.speed * Math.max(0.25, Math.cos(Math.min(Math.abs(a), Math.PI / 2)) ** 2);
  const stops = b.state !== 'leaving' || runOut;
  let x = b.x;
  let y = b.y;
  let d = b.dir;
  let speed = Math.max(0, (b.speed ?? 0) - (b.sternway ?? 0));
  let leg = 1;
  let left = 0;
  for (let k = 1; k < xs.length; k++) left += Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]);
  for (let t = 0; t < n * B.PLOT_STEP; t++) {
    if (t % B.PLOT_STEP === 0) {
      const s = (t / B.PLOT_STEP) * 3;
      out[s] = x;
      out[s + 1] = y;
      out[s + 2] = d;
    }
    if (leg >= xs.length) continue;
    const lx = xs[leg] - x;
    const ly = ys[leg] - y;
    const reach = Math.hypot(lx, ly);
    const along = Math.atan2(ly, lx);
    let desired = v.speed * (runOut ? 0.75 : 1);
    if (!runOut) {
      // Swings round onto the leg as it goes, slowing to turn.
      const err = wrapAngle(along - d);
      const turn = v.turn * (0.3 + (0.7 * speed) / v.speed);
      d = wrapAngle(d + clamp(err, -turn, turn));
      desired = bend(err);
      if (leg + 1 < xs.length) {
        const corner = wrapAngle(Math.atan2(ys[leg + 1] - ys[leg], xs[leg + 1] - xs[leg]) - along);
        desired = Math.min(desired, Math.sqrt(bend(corner) ** 2 + 2 * accel * reach));
      }
    }
    if (stops) desired = Math.min(desired, Math.sqrt(2 * accel * left) + 0.004);
    speed += clamp(desired * pace - speed, -accel * B.BOAT_BRAKE, accel);
    speed = Math.max(0, speed);
    // Along the route, leg after leg.
    let go = Math.min(speed, left);
    left -= go;
    while (go > 0 && leg < xs.length) {
      const rx = xs[leg] - x;
      const ry = ys[leg] - y;
      const r = Math.hypot(rx, ry);
      if (r <= go) {
        x = xs[leg];
        y = ys[leg];
        go -= r;
        leg++;
      } else {
        x += (rx / r) * go;
        y += (ry / r) * go;
        go = 0;
      }
    }
  }
  return out;
}

/**
 * The first point at which two plots bring the hulls closer than they
 * should pass (or, already that close, closer still), and the least
 * clear water between them; null when they keep clear.
 */
export function meeting(
  _world: World,
  b: Boat,
  mine: Float64Array,
  o: Boat,
  theirs: Float64Array,
): { at: number; gap: number } | null {
  const v = B.VESSELS[b.vessel];
  const w = B.VESSELS[o.vessel];
  const n = mine.length / 3;
  // Too far apart to meet within the lookout at all.
  const span = (v.speed + w.speed) * B.LOOKOUT_TICKS + (v.length + w.length) / 2 + 1;
  if (Math.hypot(theirs[0] - mine[0], theirs[1] - mine[1]) > span) return null;
  const reach = (v.length + w.length) / 2 + B.PASSING_GAP;
  let limit = B.PASSING_GAP;
  let at = -1;
  let least = Infinity;
  for (let k = 0; k < n; k++) {
    const s = k * 3;
    if (Math.hypot(theirs[s] - mine[s], theirs[s + 1] - mine[s + 1]) > reach) continue;
    const gap = hullGap(
      mine[s],
      mine[s + 1],
      mine[s + 2],
      v,
      theirs[s],
      theirs[s + 1],
      theirs[s + 2],
      w,
    );
    if (k === 0) {
      limit = Math.min(B.PASSING_GAP, gap - 0.05);
      continue;
    }
    least = Math.min(least, gap);
    if (gap < limit && at < 0) at = k;
  }
  return at < 0 ? null : { at, gap: least };
}

/**
 * Which of two boats under way keeps clear, as at sea: of `b`, whether it
 * gives way to `o`, stands on, or (meeting head on) both alter to
 * starboard. A boat handling, coming alongside or pulling out, goes
 * first, then the bigger ship. Between boats of a size the one
 * overtaking keeps clear, and of two crossing the one with the other on
 * its starboard side. Anything else goes by right of way (see outranks).
 */
export function burden(w: World, b: Boat, o: Boat): 'give' | 'stand' | 'both' {
  const handling = (q: Boat) => w.handling.has(q) || pullingOut(w, q);
  if (handling(b) !== handling(o)) return handling(b) ? 'stand' : 'give';
  if (handling(b)) return outranks(w, o, b) ? 'give' : 'stand';
  const lb = B.VESSELS[b.vessel].length;
  const lo = B.VESSELS[o.vessel].length;
  if (lb > lo * 1.3) return 'stand';
  if (lo > lb * 1.3) return 'give';
  // Where each sees the other, starboard positive.
  const seen = wrapAngle(Math.atan2(o.y - b.y, o.x - b.x) - b.dir);
  const seenBy = wrapAngle(Math.atan2(b.y - o.y, b.x - o.x) - o.dir);
  // More than two points abaft the beam: coming up from astern.
  const abaft = Math.PI * 0.625;
  if (Math.abs(seenBy) > abaft && Math.abs(seen) < abaft) return 'give';
  if (Math.abs(seen) > abaft && Math.abs(seenBy) < abaft) return 'stand';
  if (Math.abs(wrapAngle(o.dir - b.dir)) > 2.6 && Math.abs(seen) < 0.5 && Math.abs(seenBy) < 0.5) {
    return 'both';
  }
  if (seen > 0 && seenBy < 0) return 'give';
  if (seen < 0 && seenBy > 0) return 'stand';
  return outranks(w, o, b) ? 'give' : 'stand';
}

/**
 * The best manoeuvre for a long ship from where it lies: ahead or astern,
 * helm hard over either way, half or amidships. Each is tried out over a
 * short run (ahead as far as `reach`, astern a tile and a half) and must
 * keep the hull clear all the way. Best first: ending nearest the target
 * and pointing at it. Empty when nothing has room.
 */
export function manoeuvre(
  w: World,
  b: Boat,
  tx: number,
  ty: number,
  tdir: number,
  speed: number,
  ships: Boat[],
  now: number,
  reach: number,
): { helm: number; astern: boolean; pivot?: boolean }[] {
  const v = B.VESSELS[b.vessel];
  // Slow, a ship turns tighter for the distance it covers.
  const s = Math.max(speed, v.speed * 0.25);
  const curve = (v.turn * (0.3 + (0.7 * s) / v.speed)) / s;
  const step = 0.25;
  const options: { helm: number; astern: boolean; pivot?: boolean; score: number }[] = [];
  // Last of all, with tugs, swing round where it lies, if there is room.
  const want = Math.hypot(tx - b.x, ty - b.y) > 1.5 ? Math.atan2(ty - b.y, tx - b.x) : tdir;
  // Judged by where the swing leaves it, as far round as it has room for.
  const swing = wrapAngle(want - b.dir);
  if (Math.abs(swing) > 0.05) {
    const n = Math.ceil(Math.abs(swing) / 0.15);
    let ok = true;
    for (let k = 1; k <= n && ok; k++) {
      ok = clips(w, b, b.x, b.y, b.dir + (swing * k) / n, ships) <= now;
    }
    if (ok) {
      const off = Math.abs(wrapAngle(want - b.dir - swing));
      // Tugs are a last resort, less so the further it has to come round.
      options.push({
        helm: Math.sign(swing),
        astern: false,
        pivot: true,
        score:
          Math.hypot(tx - b.x, ty - b.y) +
          off * 1.5 +
          (tugged(w, b) ? 0.5 : 2.5) * (1 - Math.abs(swing) / Math.PI),
      });
    }
  }
  for (const astern of [false, true]) {
    const run = astern ? 1.5 : Math.max(step, reach);
    for (const helm of [0, -0.5, 0.5, -1, 1]) {
      let x = b.x;
      let y = b.y;
      let d = b.dir;
      let ok = true;
      // Judged at its best moment along the run: nearest the target and
      // pointing at it, before it sails past.
      let score = Infinity;
      for (let t = step; t <= run + 1e-6; t += step) {
        // Astern the rudder bites less.
        d = wrapAngle(d + helm * curve * step * (astern ? 0.5 : 1));
        x += Math.cos(d) * step * (astern ? -1 : 1);
        y += Math.sin(d) * step * (astern ? -1 : 1);
        if (clips(w, b, x, y, d, ships) > now) {
          ok = false;
          break;
        }
        // Far off, point at the target; close to it, lie the way the
        // route goes on from there.
        const near = Math.hypot(tx - x, ty - y);
        const aim = near > 1.5 ? Math.atan2(ty - y, tx - x) : tdir;
        score = Math.min(score, near + Math.abs(wrapAngle(aim - d)) * 1.5);
      }
      // Astern costs a little, and so does changing between ahead and
      // astern, so it does not dither.
      const change = b.plan && !b.plan.pivot && b.plan.astern !== astern ? 0.75 : 0;
      if (ok) options.push({ helm, astern, score: score + (astern ? 1 : 0) + change });
    }
  }
  return options.sort((p, q) => p.score - q.score);
}

export function navigable(w: World, x: number, y: number, cost: CostFn): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  return !w.map.inBounds(tx, ty) || Number.isFinite(cost(w.map.idx(tx, ty)));
}

/**
 * Open water all along a straight line, so the boat can cut the corner;
 * with `half` set, clear of the shore and docks that far either side of
 * it too, so the hull does not clip the corner of a dock on the way.
 */
export function openWater(
  w: World,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cost: CostFn,
  half = 0,
): boolean {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.ceil(len / 0.25);
  const ox = len > 0 ? (-(y1 - y0) / len) * half : 0;
  const oy = len > 0 ? ((x1 - x0) / len) * half : 0;
  const m = w.map;
  const shore: CostFn = (i) =>
    m.isLand(i) || (m.build[i] !== Build.None && !isBuoy(m.build[i])) ? Infinity : 1;
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    if (!navigable(w, x, y, cost)) return false;
    if (half > 0 && !(navigable(w, x + ox, y + oy, shore) && navigable(w, x - ox, y - oy, shore))) {
      return false;
    }
  }
  return true;
}

/** Where a boat's hull lies: centre, unit heading and half extents. */
export function hullOf(
  _w: World,
  b: Boat,
): {
  x: number;
  y: number;
  hx: number;
  hy: number;
  half: number;
  beam: number;
} {
  const v = B.VESSELS[b.vessel];
  return {
    x: b.x,
    y: b.y,
    hx: Math.cos(b.dir),
    hy: Math.sin(b.dir),
    half: v.length / 2,
    beam: v.beam / 2,
  };
}

/**
 * Right of way: a boat pulling out of its berth goes first, then boats
 * leaving, boats coming in to a berth and those heading for the
 * anchorage; going the same way, the bigger ship, then the one that came
 * first. Boats lying still never move for anyone.
 */
export function outranks(w: World, a: Boat, b: Boat): boolean {
  const state = (q: Boat) =>
    q.state === 'leaving' ? 3 : q.state === 'arriving' ? 2 : q.state === 'approaching' ? 1 : 0;
  const rank = (q: Boat) => [pullingOut(w, q) ? 1 : 0, state(q), B.VESSELS[q.vessel].length];
  const ra = rank(a);
  const rb = rank(b);
  for (let k = 0; k < ra.length; k++) if (ra[k] !== rb[k]) return ra[k] > rb[k];
  return a.id < b.id;
}

/** The hull pointing the way the boat is going, astern included. */
export function wakeOf(w: World, b: Boat): ReturnType<typeof hullOf> {
  const h = hullOf(w, b);
  return b.astern ? { ...h, hx: -h.hx, hy: -h.hy } : h;
}

/**
 * Rules of the road. A boat stops for anything lying still in its way (and
 * finds a way round it, see sail) and gives way to boats that outrank it.
 * With right of way it carries on, stopping short only of a collision,
 * while the other one gets out of the way, going astern if need be
 * (`makeWay`). There is always one boat with right of way, so they do not
 * sail through each other; one that is wedged in all the same squeezes
 * past in the end rather than lock up the harbour.
 */
export function giveWay(
  w: World,
  b: Boat,
  /** Going astern: looking out over the stern, not the bow. */
  astern = false,
): { speed: number; makeWay: number; still?: boolean; by?: Boat } {
  const hull = hullOf(w, b);
  const me = astern ? { ...hull, hx: -hull.hx, hy: -hull.hy } : hull;
  const v = B.VESSELS[b.vessel];
  // Looks out as far as it takes to stop gently from full speed, so it
  // eases off early rather than pulling up short.
  const accel = v.speed * B.BOAT_ACCEL;
  const stopping = (v.speed * v.speed) / (2 * accel);
  const look = me.half + 0.6 + stopping;
  let speed = 1;
  /** Id of the boat to back out of the way of, or -1. */
  let makeWay = -1;
  /** Brought up short by a boat lying still. */
  let stopped = false;
  /** The moored ship it stopped for, if one did. */
  let stoppedBy: Boat | undefined;
  /** The boat that holds it back most. */
  let by: Boat | undefined;
  // Held up a while beside the clear water off moored boats' ends, it goes
  // on past them minding only their hulls, until it is clear of them all:
  // counted however it creeps meanwhile, so it does not stop again at
  // every nudge forward.
  const patient = (b.keptFor ?? 0) < B.KEEP_CLEAR_PATIENCE;
  /** Beside such water still, and held up by it alone. */
  let byEnds = false;
  let heldByEnds = false;
  // Wedged in for most of a day: a last resort so the harbour never locks
  // up for good. It squeezes past.
  const wedged = (b.squeeze ?? 0) > 0;
  const m = w.map;
  // A long ship whose way goes on behind it is coming round: one lying
  // still off its bow is not in its way, as it swings away from it, its
  // whole hull minding that one as it goes (see sail).
  const next = b.path[0];
  const comingRound =
    v.length >= B.CAREFUL_LENGTH &&
    next !== undefined &&
    Math.cos(Math.atan2(m.yOf(next) + 0.5 - b.y, m.xOf(next) + 0.5 - b.x) - b.dir) < 0;
  w.roomWait.delete(b);
  for (const o of w.boats) {
    if (o === b) continue;
    const other = hullOf(w, o);
    const still = o.state === 'moored' || o.state === 'anchored';
    // Squeezing past the boats under way it is wedged against, never over
    // one lying still, nor into one only coming its way.
    if (wedged && !still && squeezingPast(w, b, o)) continue;
    if (comingRound && still) continue;
    // Keep out of the water a ship pulling out of its berth has claimed,
    // stopping short of it; already inside and heading further in, back
    // out. A boat coming in to a berth inside it has to pass through.
    const bound =
      o.room &&
      b.state === 'arriving' &&
      b.berth >= 0 &&
      o.room.spots.some(
        ([x, y, r]) => Math.hypot(m.xOf(b.berth) + 0.5 - x, m.yOf(b.berth) + 0.5 - y) < r + 1,
      );
    if (o.room && !bound && outranks(w, o, b)) {
      // Running out along the dock it may be going astern: look that way.
      const into = intoRoom(w, b.berthing === 'out' ? wakeOf(w, b) : me, o.room.spots, look);
      if (into !== null) {
        w.roomWait.add(b);
        if (into < 0) {
          if (makeWay < 0) makeWay = o.id;
          speed = 0;
        } else {
          speed = Math.min(
            speed,
            clamp(Math.sqrt(2 * accel * Math.max(0, into - 0.3)) / v.speed, 0, 1),
          );
        }
      }
    }
    // Off a moored boat's bow and stern lies clear water it keeps to
    // itself; a boat already in it, casting off beside it, need only
    // keep clear of the hull.
    // Held up by that alone a while, it goes on past, clear of the hull.
    // Running out along the dock it passes the berths beside it like
    // one casting off, minding only their hulls.
    const ends =
      still && b.berthing !== 'out'
        ? inWay(w, me, { ...other, half: other.half + B.BERTH_END_GAP }, look)
        : null;
    if (ends !== null) byEnds = true;
    const kept = patient ? ends : null;
    const ahead = kept !== null && kept > 0 ? kept : inWay(w, me, other, look);
    if (ahead !== null) {
      const gap = ahead - me.half;
      // Stop for anything lying still or with right of way; otherwise only
      // short of touching, while the other one gets out of the way.
      const yields = still || outranks(w, o, b);
      const room = yields ? 0.3 : 0.08;
      if (yields) {
        // As fast as still lets it stop in time, braking at its ordinary
        // rate, plus however fast the other is drawing away.
        const away = still
          ? 0
          : Math.max(0, ((o.speed ?? 0) - (o.sternway ?? 0)) * Math.cos(o.dir - b.dir));
        const safe = away + Math.sqrt(2 * accel * Math.max(0, gap - room));
        const slow = clamp(safe / v.speed, 0, 1);
        if (slow < speed) by = o;
        speed = Math.min(speed, slow);
        if (still && speed <= 0.05) {
          stopped = true;
          if (o.state === 'moored') stoppedBy = o;
        }
        if (kept !== null && kept > 0 && speed <= 0.1) {
          heldByEnds = true;
          // Held off the clear water at its end: waiting on it all the same.
          if (o.state === 'moored') stoppedBy ??= o;
        }
      } else {
        const slow = clamp((gap - room) / 0.5, 0, 1);
        if (slow < speed) by = o;
        speed = Math.min(speed, slow);
      }
    }
    // Something with right of way is held up, and this boat is in its way;
    // or a boat backing out of the way of one that outranks this one needs
    // this one to back too. The boat at the head of a chain always
    // outranks the rest, so no ring of boats ends up all waiting astern.
    // Backing out of that one's way already, it keeps on a little while
    // after, as the other creeps on meanwhile, rather than stop and start.
    const backing = b.yieldFor === o.id && w.tick < (b.yieldUntil ?? 0);
    if (makeWay >= 0 || still || ((o.held ?? 0) <= 20 && !backing)) continue;
    const head = outranks(w, o, b) ? o.id : o.astern && o.yieldFor !== undefined ? o.yieldFor : -1;
    const lead = head === o.id ? o : w.boats.find((q) => q.id === head);
    if (!lead || lead === b || !outranks(w, lead, b)) continue;
    // As far ahead as that one looks out: out of its way, not just off its bow.
    const ov = B.VESSELS[o.vessel];
    const theirs = other.half + 0.6 + (ov.speed * ov.speed) / (2 * ov.speed * B.BOAT_ACCEL);
    if (inWay(w, wakeOf(w, o), me, Math.max(other.half + 0.8, theirs)) !== null) {
      makeWay = head;
    }
  }
  if (b.keptTick !== w.tick) {
    b.keptTick = w.tick;
    const past = (b.keptFor ?? 0) >= B.KEEP_CLEAR_PATIENCE;
    b.keptFor = heldByEnds || (past && byEnds) ? (b.keptFor ?? 0) + 1 : 0;
  }
  const held = stopped && speed <= 0.05;
  if (b.waitedAt !== w.tick) {
    b.waitedAt = w.tick;
    countWait(w, b, b.state === 'arriving' && speed <= 0.1 ? stoppedBy : undefined);
  }
  return { speed, makeWay, still: held, by };
}

/**
 * Count how long a ship coming in has been held up by moored ship `by`:
 * all the while it gets no further on, however it creeps or is let past
 * the clear water off that one's end a moment and stopped again; and from
 * nothing again once it is well on its way, the other has sailed, or it
 * is held up by another.
 */
export function countWait(w: World, b: Boat, by: Boat | undefined): void {
  const waiting = b.waitingOn !== undefined && w.boats.find((q) => q.id === b.waitingOn);
  const from = b.waitedFrom;
  const moved = from ? Math.hypot(b.x - from[0], b.y - from[1]) : Infinity;
  const still =
    !!waiting && waiting.state === 'moored' && b.state === 'arriving' && moved < B.WAIT_CREEP;
  if (by && by.id !== b.waitingOn) {
    b.waitingOn = by.id;
    b.waitedFor = 0;
    b.waitedFrom = [b.x, b.y];
  } else if (by || still) {
    b.waitedFor = (b.waitedFor ?? 0) + 1;
  } else {
    b.waitingOn = undefined;
    b.waitedFor = 0;
    b.waitedFrom = undefined;
  }
}

/**
 * A ship coming in that has waited a while for moored ship `b` to sail
 * out of its way, or undefined.
 */
export function waitingFor(w: World, b: Boat): Boat | undefined {
  return w.boats.find(
    (o) =>
      o.state === 'arriving' && o.waitingOn === b.id && (o.waitedFor ?? 0) > B.BERTH_BLOCKED_TICKS,
  );
}

/**
 * How far `me` can go ahead before its hull enters a room made of `spots`,
 * within `look` tiles; -1 when it is inside already and heading further
 * in, null when it is not heading into it.
 */
export function intoRoom(
  _w: World,
  me: ReturnType<typeof hullOf>,
  spots: [number, number, number][],
  look: number,
): number | null {
  let into: number | null = null;
  for (const [x, y, radius] of spots) {
    const rx = x - me.x;
    const ry = y - me.y;
    const fwd = rx * me.hx + ry * me.hy;
    if (fwd <= 0) continue;
    const side = Math.abs(-rx * me.hy + ry * me.hx);
    const r = radius + me.beam;
    if (side >= r) continue;
    if (Math.hypot(rx, ry) < radius + me.half) return -1;
    const at = fwd - Math.sqrt(r * r - side * side) - me.half;
    if (at <= look) into = Math.min(into ?? Infinity, Math.max(0, at));
  }
  return into;
}

/**
 * How far ahead `other` lies in the path of `me`, within `look` tiles of
 * my centre, or null when it is not in the way.
 */
export function inWay(
  _w: World,
  me: ReturnType<typeof hullOf>,
  other: ReturnType<typeof hullOf>,
  look: number,
): number | null {
  const rx = other.x - me.x;
  const ry = other.y - me.y;
  const fwd = rx * me.hx + ry * me.hy;
  const side = -rx * me.hy + ry * me.hx;
  // The other hull's reach along my heading and across it.
  const along = Math.abs(other.hx * me.hx + other.hy * me.hy);
  const across = Math.abs(-other.hx * me.hy + other.hy * me.hx);
  const reachFwd = along * other.half + across * other.beam;
  const reachSide = across * other.half + along * other.beam;
  const near = fwd - reachFwd;
  if (fwd <= 0 || near > look) return null;
  if (Math.abs(side) > me.beam + reachSide + 0.12) return null;
  return Math.max(0, near);
}

/** Open water, with a wide berth given to boats lying still. */
export function seaWay(w: World, b: Boat, strict = false): CostFn {
  return seaWayFor(w, b.draft, b.goal, b, strict);
}

/** Open water for a hull of this draft heading for `goal`; see seaWay. */
export function seaWayFor(
  w: World,
  draft: number,
  goal: number,
  self: Boat | null,
  strict = false,
): CostFn {
  const base = boatCostFor(w, draft);
  // Strict: every other hull is off limits, moving ones included.
  const still = w.boats
    .filter((o) => o !== self && (strict || o.state === 'moored' || o.state === 'anchored'))
    .map((o) => hullOf(w, o));
  const wide = wideOf(w, self);
  return (i) => {
    const c = base(i);
    if (!Number.isFinite(c)) return c;
    const x = (i % w.map.w) + 0.5;
    const y = Math.floor(i / w.map.w) + 0.5;
    for (const h of still) {
      const rx = x - h.x;
      const ry = y - h.y;
      const fwd = Math.abs(rx * h.hx + ry * h.hy);
      const side = Math.abs(-rx * h.hy + ry * h.hx);
      if (fwd < h.half + 0.6 && side < h.beam + 0.8) return i === goal ? c + 25 : Infinity;
    }
    return i === goal ? c : c + wide(i);
  };
}

/**
 * What a route pays over open water to pass this close to the corner of
 * a pier, quay or the shore, or to a boat lying at its berth (other than
 * `self`): boats come round them in a wide circle, wider still where a
 * boat lies off the corner, rather than shave them.
 */
export function wideOf(world: World, self: Boat | null): CostFn {
  const ring = cornerRing(world);
  const moored = world.boats
    .filter((o) => o !== self && o.state === 'moored')
    .map((o) => hullOf(world, o));
  const w = world.map.w;
  return (i) => {
    const x = (i % w) + 0.5;
    const y = Math.floor(i / w) + 0.5;
    for (const h of moored) {
      const rx = x - h.x;
      const ry = y - h.y;
      const fwd = Math.abs(rx * h.hx + ry * h.hy);
      const side = Math.abs(-rx * h.hy + ry * h.hx);
      if (fwd < h.half + 0.6 + B.MOORED_CLEAR && side < h.beam + 0.8 + B.MOORED_CLEAR) {
        return ring[i] + B.MOORED_CLEAR_COST;
      }
    }
    return ring[i];
  };
}

/**
 * For each tile of water, what a route pays over open water for passing
 * this close to the corner of a jetty or quay: its end, say, with water
 * on two sides of it that meet; or this close to the bare shore, which
 * boats keep a tile or two off rather than brush along. Not the water
 * along a dock, nor in a corner between two. Derived from the map, so
 * not saved.
 */
export function cornerRing(w: World): Float32Array {
  if (w.ringCache) return w.ringCache;
  const m = w.map;
  const out = new Float32Array(m.build.length);
  const hard = (x: number, y: number) => {
    if (!m.inBounds(x, y)) return false;
    const i = m.idx(x, y);
    return m.isLand(i) || (m.build[i] !== Build.None && !isBuoy(m.build[i]));
  };
  const water = (x: number, y: number) => m.inBounds(x, y) && m.ocean[m.idx(x, y)] && !hard(x, y);
  const r = Math.ceil(B.CORNER_CLOSE);
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const b = m.build[m.idx(x, y)];
      if (b === Build.None || isBuoy(b)) continue;
      const wx = water(x - 1, y) || water(x + 1, y);
      const wy = water(x, y - 1) || water(x, y + 1);
      if (!wx || !wy) continue;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (!water(x + dx, y + dy)) continue;
          const d = Math.hypot(dx, dy);
          const c =
            d < B.CORNER_NEAR ? B.CORNER_NEAR_COST : d < B.CORNER_CLOSE ? B.CORNER_CLOSE_COST : 0;
          const j = m.idx(x + dx, y + dy);
          out[j] = Math.max(out[j], c);
        }
      }
    }
  }
  // Off the bare shore: land with no dock on it, by how near its edge is.
  const shore = (x: number, y: number) => {
    if (!m.inBounds(x, y)) return false;
    const i = m.idx(x, y);
    return m.isLand(i) && !isDock(m.build[i]);
  };
  const reach = Math.ceil(B.SHORE_CLOSE);
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (!water(x, y)) continue;
      let d = Infinity;
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          if (!shore(x + dx, y + dy)) continue;
          // From the middle of this tile to the nearest edge of that one.
          d = Math.min(
            d,
            Math.hypot(Math.max(0, Math.abs(dx) - 0.5), Math.max(0, Math.abs(dy) - 0.5)),
          );
        }
      }
      const c = d < B.SHORE_NEAR ? B.SHORE_NEAR_COST : d < B.SHORE_CLOSE ? B.SHORE_CLOSE_COST : 0;
      const j = m.idx(x, y);
      out[j] = Math.max(out[j], c);
    }
  }
  return (w.ringCache = out);
}

/**
 * The lane of water a boat comes alongside along: the row of a berth on
 * the long side of a jetty, or the column of one off its end. One boat at
 * a time moves in each lane, so boats in different lanes, even at the same
 * dock, do not wait for each other.
 */
export function fairwayOf(w: World, jetty: number, berth: number): number | undefined {
  docks(w);
  if (!w.dockKey.has(jetty)) return undefined;
  const m = w.map;
  // Berth beside the jetty tile (east or west): a lane down that column.
  return m.yOf(berth) === m.yOf(jetty) ? 2 * m.xOf(berth) + 1 : 2 * m.yOf(berth);
}

/**
 * No other boat holds the fairway to this berth. Pulling out, a boat goes
 * ahead of one that holds it but is still well out from its berth: it is
 * clear of the lane before the other gets there.
 */
export function fairwayFree(
  w: World,
  b: Boat,
  jetty: number,
  berth: number,
  leaving = false,
): boolean {
  const key = fairwayOf(w, jetty, berth);
  const m = w.map;
  const far = (o: Boat) =>
    o.state === 'arriving' &&
    Math.hypot(m.xOf(o.berth) + 0.5 - o.x, m.yOf(o.berth) + 0.5 - o.y) > B.FAIRWAY_FAR;
  return (
    key === undefined || !w.boats.some((o) => o !== b && o.fairway === key && !(leaving && far(o)))
  );
}

/** Take the fairway to this boat's berth if no other boat holds it. */
export function takeFairway(w: World, b: Boat, leaving = false): boolean {
  if (!fairwayFree(w, b, b.jetty, b.berth, leaving)) return false;
  b.fairway = fairwayOf(w, b.jetty, b.berth);
  return true;
}

export function freeFairway(_w: World, b: Boat): void {
  b.fairway = undefined;
  b.castOff = undefined;
  b.castDock = undefined;
}

/** Pulling out of its berth: casting off, running out along the dock or turning for sea. */
export function pullingOut(_w: World, b: Boat): boolean {
  return b.state === 'leaving' && (b.undock !== undefined || b.berthing === 'out' || !!b.room);
}

/**
 * A ship pulling out of its berth claims the water it needs: the lane
 * ahead of it along the dock as it runs out, and the water all round
 * where it turns for sea, keeping that until it has come round onto its
 * course.
 */
export function claimRoom(w: World, b: Boat): void {
  const v = B.VESSELS[b.vessel];
  const m = w.map;
  if (b.turned || v.length < B.RUN_OUT_LENGTH) return;
  if (b.room && w.tick > b.room.until) {
    b.room = undefined;
    b.turned = true;
    return;
  }
  const turn = v.length / 2 + B.ROOM_MARGIN;
  const until = b.room?.until ?? w.tick + B.ROOM_TICKS;
  if (b.berthing === 'out' && b.lineup !== undefined) {
    const ex = m.xOf(b.lineup) + 0.5;
    const ey = m.yOf(b.lineup) + 0.5;
    const n = Math.ceil(Math.hypot(ex - b.x, ey - b.y) / 0.5);
    const lane = v.beam / 2 + 0.5;
    const spots: [number, number, number][] = [];
    for (let k = 0; k < n; k++) {
      spots.push([b.x + ((ex - b.x) * k) / n, b.y + ((ey - b.y) * k) / n, lane]);
    }
    spots.push([ex, ey, turn]);
    b.room = { spots, until };
    return;
  }
  if (b.room?.turning) {
    const target = b.path[0] ?? b.goal;
    const course = Math.atan2(m.yOf(target) + 0.5 - b.y, m.xOf(target) + 0.5 - b.x);
    const [x, y, r] = b.room.spots[0];
    const round = Math.abs(wrapAngle(course - b.dir)) < 0.3;
    const out = Math.hypot(b.x - x, b.y - y) > r;
    if (round || out) {
      b.room = undefined;
      b.turned = true;
    }
    return;
  }
  // Off the berth, or at the end of its run out: room to turn.
  if (b.castOff !== undefined && b.undock === undefined) {
    b.room = { spots: [[b.x, b.y, turn]], until, turning: true };
  }
}

export function depart(w: World, b: Boat, gaveUp: boolean): void {
  judgeVisit(w, b, gaveUp);
  departTips(w);
  // Leaving with containers still on board: customs start on those it landed.
  if (b.vessel === 'feeder') shipUnloaded(w, b);
  if (b.state === 'moored') {
    b.castOff = b.berth;
    b.castDock = b.jetty;
    b.undock = 1;
    planRunOut(w, b);
  } else freeFairway(w, b);
  b.state = 'leaving';
  b.berth = b.jetty = -1;
  const edge = seaEdgeTiles(w);
  const from = w.tileOf(b);
  // Out past the red buoys, then off the map level with the last of them.
  const stops = buoyStops(w, b, from, -1, seaWay(w, b));
  const last = stops.at(-1) ?? from;
  // Each boat keeps to a lane of its own out at sea, a few rows either
  // side, so departures do not all converge on one point. Crossing
  // between a pair of buoys it is in its lane already.
  const crossed = stops.length > 0 && !isBuoy(w.map.build[last]);
  const lane = w.map.yOf(last) + (crossed ? 0 : (((b.id * 7) % 9) - 4) * B.EXIT_LANES);
  const exit = edge.reduce(
    (best, i) => (Math.abs(w.map.yOf(i) - lane) < Math.abs(w.map.yOf(best) - lane) ? i : best),
    edge[0],
  );
  b.goal = exit;
  b.path = via(w, from, stops, exit, byDocks(w, seaWay(w, b), from, exit)) ?? [];
  b.sailed = 0;
  b.best = Infinity;
}

/** Not where another boat is, so none goes out of sight beside one. */
export function outOfSight(w: World, b: Boat): boolean {
  return w.boats.every(
    (o) => o === b || Math.hypot(o.x - b.x, o.y - b.y) > B.VESSELS[o.vessel].length + 2,
  );
}

/**
 * How many tiles from the start of a way in from sea a boat comes into
 * sight, B.SAIL_IN_TILES of it from the end. Not where another boat is,
 * so none comes into sight on top of one.
 */
export function inSight(w: World, b: Boat, path: number[]): number {
  const m = w.map;
  let left = 0;
  for (let k = path.length - 1; k > 0; k--) {
    left += Math.hypot(m.xOf(path[k]) - m.xOf(path[k - 1]), m.yOf(path[k]) - m.yOf(path[k - 1]));
    if (left < B.SAIL_IN_TILES) continue;
    const x = m.xOf(path[k - 1]) + 0.5;
    const y = m.yOf(path[k - 1]) + 0.5;
    if (
      w.boats.every((o) => o === b || Math.hypot(o.x - x, o.y - y) > B.VESSELS[o.vessel].length + 2)
    ) {
      return k;
    }
  }
  return 0;
}
