// How a boat handles: gathering way and slowing, swinging round in an arc,
// casting off and coming round for the sea, going astern, and keeping its hull
// clear of the shore, the docks and other boats.

import type { World } from '../../world';
import {
  crowds,
  giveWay,
  hullOf,
  inWay,
  inWayOfHeld,
  manoeuvre,
  navigable,
  openWater,
  rulesOfTheRoad,
  seaWay,
  startSqueeze,
  stillNear,
  takeFairway,
  wideOf,
} from './traffic';
import { approachPath, boatCostFor, gateLines, intoClaimed, openAround, route } from './berthing';
import type { Boat } from '../../state';
import * as B from '../../balance';
import { clamp, wrapAngle } from '../../helpers';
import { handiness } from '../tugs';
import type { CostFn } from '../../path';
import { Build, isBuoy } from '../../types';

/**
 * Steer a boat along its path the way a boat moves: it turns at a limited
 * rate, speeds up and slows down gradually, eases off for bends and to
 * stop, and gives way to other boats. With `moor` set it comes alongside
 * at the end, crabbing sideways the last bit, lying along that heading
 * (either way round).
 */
export function sail(world: World, b: Boat, moor: number | null): 'moving' | 'arrived' | 'blocked' {
  const v = B.VESSELS[b.vessel];
  const w = world.map.w;
  const cx = (i: number) => (i % w) + 0.5;
  const cy = (i: number) => Math.floor(i / w) + 0.5;
  const accel = v.speed * B.BOAT_ACCEL;
  let speed = b.speed ?? 0;
  if (b.path.length === 0) b.path = [b.goal];
  // Waypoints already passed drop off; the last one is the goal itself.
  // A long ship also counts one close by as passed once it is beyond it,
  // heading on towards the next, rather than turning back for it.
  const passed = (p: number, q: number) => {
    if (v.length < B.CAREFUL_LENGTH || Math.hypot(cx(p) - b.x, cy(p) - b.y) >= 2) return false;
    const qx = cx(q) - cx(p);
    const qy = cy(q) - cy(p);
    const along = (Math.cos(b.dir) * qx + Math.sin(b.dir) * qy) / Math.hypot(qx, qy);
    return along > 0.7 && (b.x - cx(p)) * qx + (b.y - cy(p)) * qy > 0;
  };
  while (
    b.path.length > 1 &&
    (Math.hypot(cx(b.path[0]) - b.x, cy(b.path[0]) - b.y) < 0.9 || passed(b.path[0], b.path[1]))
  ) {
    b.path.shift();
  }
  const goal = b.path[b.path.length - 1];
  const gx = cx(goal);
  const gy = cy(goal);
  let remaining = Math.hypot(cx(b.path[0]) - b.x, cy(b.path[0]) - b.y);
  for (let k = 1; k < b.path.length; k++) {
    remaining += Math.hypot(cx(b.path[k]) - cx(b.path[k - 1]), cy(b.path[k]) - cy(b.path[k - 1]));
  }
  // Out on open water, or handling: coming alongside, lining up or
  // casting off, when others keep clear of it.
  const free = remaining > 2.5 && (b.berthing === undefined || b.berthing === 'lead') && !b.undock;
  if (free) world.handling.delete(b);
  else world.handling.add(b);

  // Final approach to a berth: line up with it and crab in sideways.
  // A big ship close by works itself in with tugs: swings into line where
  // it lies, if there is room, and slides across.
  const close =
    v.length >= B.CAREFUL_LENGTH &&
    b.berthing !== 'lead' &&
    b.berthing !== 'align' &&
    Math.hypot(gx - b.x, gy - b.y) < 3;
  if (moor !== null && (remaining < 1.6 || close)) {
    // A boat pulling out, held up with this one in its way: it backs off
    // its berth to let it by, rather than wait alongside it for good.
    if (v.length < B.CAREFUL_LENGTH && inWayOfHeld(world, b)) {
      const d = Math.hypot(b.x - gx, b.y - gy);
      const [ux, uy] =
        d > 0.05 ? [(b.x - gx) / d, (b.y - gy) / d] : [-Math.cos(b.dir), -Math.sin(b.dir)];
      const nx = b.x + ux * v.speed * 0.2;
      const ny = b.y + uy * v.speed * 0.2;
      const ships = stillNear(world, b);
      if (
        navigable(world, nx, ny, boatCostFor(world, b.draft)) &&
        clips(world, b, nx, ny, b.dir, ships) <= clips(world, b, b.x, b.y, b.dir, ships) &&
        !crowds(world, b, nx, ny)
      ) {
        b.x = nx;
        b.y = ny;
      }
      b.speed = 0;
      return 'moving';
    }
    const left = Math.min(remaining, Math.hypot(gx - b.x, gy - b.y));
    const flip = Math.abs(wrapAngle(moor - b.dir)) > Math.PI / 2 ? Math.PI : 0;
    const err = wrapAngle(moor + flip - b.dir);
    // A long ship swings into line only as far as its hull clears the
    // dock, unless it has been at it a long while.
    // Without a tug a coaster or feeder comes round and alongside slowly.
    const hand = handiness(world, b);
    const turned = b.dir + clamp(err, -v.turn * 0.6 * hand, v.turn * 0.6 * hand);
    // Every boat minds its whole hull this close to the dock.
    const ships = stillNear(world, b);
    speed = Math.min(speed, (0.03 + left * 0.1) * hand);
    let step = Math.min(left, Math.max(speed, 0.008));
    if (v.length < B.CAREFUL_LENGTH) {
      // A small boat swings into line as it comes in. Failing that, it
      // comes across onto the line of its berth and then in along it,
      // rather than cut the corner of the dock; or swings where it lies;
      // or eases back a touch to have room to swing. Always with its hull
      // no nearer the dock or another boat (short of being wedged there
      // for good).
      const now = clips(world, b, b.x, b.y, b.dir, ships);
      const stuck = (b.held ?? 0) > B.BOAT_WEDGED_AFTER;
      const alongX = Math.abs(Math.cos(moor)) > 0.5;
      const toward = (dx: number, dy: number): [number, number] => {
        const d = Math.hypot(dx, dy);
        const k = d > step ? step / d : 1;
        return [b.x + dx * k, b.y + dy * k];
      };
      const straight = toward(gx - b.x, gy - b.y);
      const across = alongX ? toward(0, gy - b.y) : toward(gx - b.x, 0);
      const along = alongX ? toward(gx - b.x, 0) : toward(0, gy - b.y);
      const back: [number, number] =
        left > 1e-6
          ? [b.x + ((b.x - gx) / left) * 0.02, b.y + ((b.y - gy) / left) * 0.02]
          : [b.x, b.y];
      const ways: [number, number, number][] = [];
      for (const [x, y] of [straight, across, along]) {
        ways.push([turned, x, y], [b.dir, x, y]);
      }
      ways.push([turned, b.x, b.y], [turned, back[0], back[1]]);
      const way = ways.find(([d, x, y]) => {
        // Getting somewhere: closer, or further round into line. The last
        // half tile in, nearly in line, or it has no room left to swing.
        const near = Math.hypot(gx - x, gy - y);
        const off = Math.abs(wrapAngle(moor + flip - d));
        const closer = near < left - 1e-4 && (near > 0.5 || off < 0.3);
        const swung = off < Math.abs(err) - 1e-4;
        if (!closer && !swung) return false;
        // Wedged there for good, it may brush the dock or a moored boat
        // getting in, but never close on a boat under way.
        return (
          (stuck || (clips(world, b, x, y, d, ships) <= now && !intoClaimed(world, b, x, y))) &&
          !crowds(world, b, x, y, d)
        );
      });
      const was = left;
      if (way) {
        b.dir = way[0];
        b.x = way[1];
        b.y = way[2];
      } else b.held = (b.held ?? 0) + 1;
      step = Math.max(0, was - Math.hypot(gx - b.x, gy - b.y));
    } else {
      const clear =
        (b.held ?? 0) > 60 ||
        clips(world, b, b.x, b.y, turned, ships) <= clips(world, b, b.x, b.y, b.dir, ships);
      const swingInto = crowds(world, b, b.x, b.y, turned) && (b.held ?? 0) <= B.BOAT_WEDGED_AFTER;
      if (clear && !swingInto) b.dir = turned;
      b.held = (b.held ?? 0) + 1;
      if (left > 1e-6) {
        const nx = b.x + ((gx - b.x) / left) * step;
        const ny = b.y + ((gy - b.y) / left) * step;
        // A long ship lines up first and comes in sideways only as its
        // hull clears the dock, nor on top of another boat passing its
        // berth, short of being wedged there for good.
        const crowded =
          crowds(world, b, nx, ny) ||
          (intoClaimed(world, b, nx, ny) && (b.held ?? 0) <= B.BOAT_WEDGED_AFTER);
        const slide =
          !crowded &&
          ((b.held ?? 0) > 150 ||
            clips(world, b, nx, ny, b.dir, ships) <= clips(world, b, b.x, b.y, b.dir, ships));
        if (slide) {
          b.x = nx;
          b.y = ny;
        } else step = 0;
      }
    }
    b.speed = speed;
    if (left - step < 0.02 && Math.abs(err) < 0.04) {
      b.x = gx;
      b.y = gy;
      b.dir = wrapAngle(moor + flip);
      b.path = [];
      return 'arrived';
    }
    return 'moving';
  }
  // Out to sea, a leaving boat just sails off the map.
  const gone = b.state === 'leaving' && remaining < 1;
  if (gone || (moor === null && remaining < 0.25 && speed < v.speed * 0.4)) {
    b.path = [];
    b.speed = 0;
    return 'arrived';
  }

  // Aim at the furthest of the next few waypoints with open water to it;
  // the ones before it are as good as passed.
  // Clear water means clear of other boats lying still, too.
  // Going round a boat met head on, all of them.
  const avoid = seaWay(world, b, (b.roundUntil ?? 0) > world.tick);
  // And no nearer a pier's corner, or a boat lying at its berth, than
  // where it is or where it aims for: it keeps the wide circle round them
  // that it planned.
  const wide = wideOf(world, b);
  const here = wide(world.tileOf(b));
  const clearTo =
    (cap: number): CostFn =>
    (i) => {
      const w = i === goal ? 0 : wide(i);
      return avoid(i) - w === 1 && w <= cap ? 1 : Infinity;
    };
  // A boat has moored across the route since it was planned: find a way
  // round it, rather than brush past its bow or stern.
  const across = b.path.slice(0, 3).some((i) => i !== goal && !Number.isFinite(avoid(i)));
  if (across && !b.berthing && !b.undock && (world.tick + b.id) % 10 === 0) {
    const round = route(world, b, world.tileOf(b), goal, avoid);
    if (round && round.length > 0) b.path = round;
  }
  let ahead = 0;
  // Coming in to a berth, keep to the approach line along the dock: never
  // cut the corner past where it starts.
  const line = moor !== null && b.berthing === 'lead' ? b.path.indexOf(b.lineup ?? -1) : -1;
  const most = line >= 0 ? Math.min(line + 1, 4) : 4;
  for (let k = 1; k < Math.min(b.path.length, most); k++) {
    // A buoy is passed, and the line between a pair crossed, not cut past.
    const at = b.path[k - 1];
    if (isBuoy(world.map.build[at]) || gateLines(world, b.state === 'leaving').has(at)) break;
    const clear = clearTo(Math.max(here, wide(b.path[k])));
    if (!openWater(world, b.x, b.y, cx(b.path[k]), cy(b.path[k]), clear, v.beam / 2 + 0.05)) {
      break;
    }
    ahead = k;
  }
  b.path.splice(0, ahead);
  const target = b.path[0];
  // Buoys are passed close by, on the boat's starboard side.
  const passBy = isBuoy(world.map.build[target]) ? B.BUOY_CLEARANCE : 0;
  const tx = cx(target) - Math.sin(b.dir) * passBy;
  const ty = cy(target) + Math.cos(b.dir) * passBy;
  const want = Math.atan2(ty - b.y, tx - b.x);
  if (b.undock && castingOff(world, b, want)) return 'moving';
  if (b.berthing === 'out' && b.lineup !== undefined && b.lineEnd !== undefined) {
    return runOut(world, b, b.lineup, b.lineEnd, goal, cx, cy);
  }
  if (b.berthing && b.lineup !== undefined && b.lineEnd !== undefined && moor !== null) {
    const sx = cx(b.lineup);
    const sy = cy(b.lineup);
    const along = Math.atan2(cy(b.lineEnd) - sy, cx(b.lineEnd) - sx);
    if (b.berthing === 'lead' && Math.hypot(sx - b.x, sy - b.y) < 1.2) {
      // Wait out there until the lane in to the berth is clear.
      if (!takeFairway(world, b)) {
        b.speed = Math.max(0, (b.speed ?? 0) - accel * 2);
        return afterMove(world, b, b.speed, true, moor, goal, cx, cy);
      }
      b.berthing = 'align';
      b.timer = 0;
    }
    if (b.berthing === 'align') {
      b.timer++;
      if (b.timer > 600) {
        // Cannot come round here after all: find another way in.
        b.berthing = undefined;
        b.stall = B.BOAT_REROUTE_AFTER - 1;
      } else if (Math.abs(wrapAngle(along - b.dir)) < 0.12) {
        b.berthing = 'line';
        b.path = b.path.slice(Math.max(0, b.path.indexOf(b.lineup) + 1));
      } else {
        // Out at the start of the line, come round to lie along it: with
        // tugs where it lies if there is room, otherwise under way.
        return lineUp(world, b, along, sx, sy, moor, goal, cx, cy);
      }
    }
  }
  const way = giveWay(world, b);
  b.stillFor = way.still ? (b.stillFor ?? 0) + 1 : 0;
  // Held up a while by a boat under way that gets nowhere either, as two
  // met head on, one backing off along its own way in front of the other:
  // it goes round it, as round a boat lying still.
  const stuckOn =
    !!way.by &&
    way.by.state !== 'moored' &&
    way.by.state !== 'anchored' &&
    way.speed < 0.2 &&
    (way.by.speed ?? 0) < B.VESSELS[way.by.vessel].speed * 0.2;
  b.headOn = stuckOn ? (b.headOn ?? 0) + 1 : 0;
  if (b.headOn > B.HEAD_ON_TICKS && !b.berthing && !b.undock) {
    b.headOn = 0;
    const round = route(world, b, world.tileOf(b), goal, seaWay(world, b, true));
    if (round && round.length > 0) {
      b.path = round;
      b.roundUntil = world.tick + B.HEAD_ON_TICKS * 2;
    }
  }
  // The rules of the road, out on open water: look ahead for boats on a
  // collision course.
  const road = free && !b.squeeze ? rulesOfTheRoad(world, b) : { bias: 0, slow: 1 };
  if (!free || b.squeeze) world.keepingClear.delete(b);
  const course = wrapAngle(want + road.bias);
  let err = wrapAngle(course - b.dir);
  // Coming round off the dock the way it planned to: the long way round if
  // need be, as there is room for that and maybe not the other.
  // Held up a good while meanwhile, it thinks again.
  if (b.comeRound) {
    if (Math.abs(err) < 0.3 || (b.held ?? 0) > B.HEAD_ON_TICKS * 2) b.comeRound = undefined;
    else if (Math.sign(err) !== b.comeRound) err += b.comeRound * 2 * Math.PI;
  }
  // A boat needs way on to turn: it never spins on the spot, it slows and
  // swings round in an arc.
  const turn = v.turn * (0.3 + (0.7 * speed) / v.speed);
  const small = v.length < B.CAREFUL_LENGTH;
  // Ease off for sharp bends, to stop at the goal, and for other boats,
  // but keep some way on through a bend so it swings round in an arc.
  const bend = (a: number) =>
    v.speed * Math.max(0.25, Math.cos(Math.min(Math.abs(a), Math.PI / 2)) ** 2);
  let desired = bend(err);
  // Looking ahead: ease off in good time for the next bend, rather than
  // braking hard on reaching it…
  if (b.path.length > 1) {
    const next = b.path[1];
    const corner = wrapAngle(
      Math.atan2(cy(next) - ty, cx(next) - tx) - Math.atan2(ty - b.y, tx - b.x),
    );
    const reach = Math.hypot(tx - b.x, ty - b.y);
    desired = Math.min(desired, Math.sqrt(bend(corner) ** 2 + 2 * accel * reach));
  }
  // …and to stop at the goal, unless it is just sailing off the map.
  if (b.state !== 'leaving') desired = Math.min(desired, Math.sqrt(2 * accel * remaining) + 0.004);
  desired *= way.speed * road.slow;
  // A ship carries its way: it brakes only a little harder than it speeds up.
  speed += clamp(desired - speed, -accel * B.BOAT_BRAKE, accel);
  speed = Math.max(0, speed);

  // A boat with right of way is waiting on this one: go astern to clear
  // its way, as long as nothing is behind. Backing and getting nowhere for
  // too long counts as wedged too.
  // Unable to back out of another's way a while, with land or boats
  // astern, it goes on its own way instead, out of the other's.
  if (way.makeWay >= 0 && (b.ownWayUntil ?? 0) <= world.tick) {
    b.yieldFor = way.makeWay;
    // Take the way off first, then go astern: no stopping dead, unless
    // it is in water a ship pulling out has claimed, where it backs at once.
    const coast = world.roomWait.has(b) ? 0 : Math.max(0, (b.speed ?? 0) - accel * 2);
    if (coast > 0) {
      const nx = b.x + Math.cos(b.dir) * coast;
      const ny = b.y + Math.sin(b.dir) * coast;
      if (navigable(world, nx, ny, boatCostFor(world, b.draft)) && !crowds(world, b, nx, ny)) {
        b.x = nx;
        b.y = ny;
        b.speed = coast;
        return 'moving';
      }
    }
    goAstern(world, b);
    b.boxedAstern = b.sternway ? 0 : (b.boxedAstern ?? 0) + 1;
    if (b.boxedAstern > B.BOXED_ASTERN) {
      b.boxedAstern = 0;
      b.ownWayUntil = world.tick + B.OWN_WAY_TICKS;
    }
    if ((b.held ?? 0) > B.BOAT_WEDGED_AFTER) {
      startSqueeze(world, b);
      b.held = 0;
      b.stall = 0;
    }
    return 'moving';
  }
  b.yieldFor = undefined;
  b.boxedAstern = 0;
  b.astern = false;
  // Small boats nip about; a long ship works itself round, ahead or
  // astern, minding its whole hull. So does a small boat boxed in against
  // a dock, until it is clear.
  if (small && !(b.plan && world.tick < b.plan.until)) {
    const made = nip(world, b, speed, clamp(err, -turn, turn), cx(target), cy(target), way.speed);
    if (made === null) return 'moving';
    if (made !== 'boxed') return afterMove(world, b, made, false, moor, goal, cx, cy);
  }
  // The whole hull keeps clear of the shore, docks and boats lying still.
  // A boat already touching something may only get clearer.
  const ships = stillNear(world, b);
  const now = clips(world, b, b.x, b.y, b.dir, ships);
  const fits = (x: number, y: number, d: number) =>
    clips(world, b, x, y, d, ships) <= now && !crowds(world, b, x, y, d);
  // Room is only needed as far as the goal: past a berth lies the dock.
  const reach = Math.min(v.length / 2 + 1, remaining);
  // Take any sternway off before going ahead again.
  if ((b.sternway ?? 0) > 0 && !b.plan?.astern) {
    const back = Math.max(0, (b.sternway ?? 0) - accel * 2);
    const sx = b.x - Math.cos(b.dir) * back;
    const sy = b.y - Math.sin(b.dir) * back;
    const moved = fits(sx, sy, b.dir);
    if (moved) {
      b.x = sx;
      b.y = sy;
    }
    b.sternway = moved ? back : 0;
    return 'moving';
  }

  // Pick a manoeuvre the whole hull has room for: ahead with the helm
  // over, or astern swinging the bow round, whichever brings it nearest
  // to heading for its next waypoint. Kept for a few ticks so it does not
  // dither between ahead and astern.
  let plan = b.plan && world.tick < b.plan.until ? b.plan : undefined;
  const step = (p: { helm: number; astern: boolean; pivot?: boolean }) => {
    if (p.pivot) {
      const swing = v.turn * 0.5 * handiness(world, b);
      const d = wrapAngle(b.dir + clamp(err, -swing, swing));
      return { d, x: b.x, y: b.y, back: 0 };
    }
    const delta =
      Math.sign(p.helm) === Math.sign(err) && !p.astern
        ? clamp(err, -Math.abs(p.helm) * turn, Math.abs(p.helm) * turn)
        : p.helm * turn * (p.astern ? 0.5 : 1);
    const d = wrapAngle(b.dir + delta);
    const back = Math.min(v.speed * 0.4, (b.sternway ?? 0) + accel);
    const dist = p.astern ? -back : speed;
    return { d, x: b.x + Math.cos(d) * dist, y: b.y + Math.sin(d) * dist, back };
  };
  if (plan && !fits(step(plan).x, step(plan).y, step(plan).d)) plan = undefined;
  // Held up for good by something lying still ahead, with where it is
  // going behind it, as at the head of a basin: nothing will move out of
  // its way and it cannot come round where it lies. It backs out, swinging
  // its bow round towards its course, until it is clear to come round. So
  // too, getting nowhere pointing away from its course, as in a basin too
  // narrow for it to turn in.
  if (plan?.out && Math.abs(err) < Math.PI / 6) plan = undefined;
  const boxedIn = way.still && (b.held ?? 0) > 30;
  const cannotTurn = Math.abs(err) > Math.PI / 2 && (b.stall ?? 0) > B.BOAT_REROUTE_AFTER;
  if (!plan && Math.abs(err) > Math.PI / 6 && (boxedIn || cannotTurn)) {
    const helm = [Math.sign(err) || 1, 0].find((h) => {
      const n = step({ helm: h, astern: true });
      return fits(n.x, n.y, n.d);
    });
    if (helm !== undefined && clearAstern(world, b)) {
      plan = { helm, astern: true, until: world.tick + 60, out: true };
      b.plan = plan;
    }
  }
  if (!plan) {
    // Aim a ship's length or so along the route, not just at the next
    // waypoint, so a manoeuvre is judged by where it leaves the ship.
    // It should get there heading the way the route goes on.
    // Where the rules of the road put it: round other boats.
    const rd = Math.hypot(tx - b.x, ty - b.y);
    let ax = b.x + Math.cos(course) * rd;
    let ay = b.y + Math.sin(course) * rd;
    let adir = course;
    let left = Math.max(2, v.length * 0.75) - Math.hypot(ax - b.x, ay - b.y);
    for (let k = 1; k < b.path.length && left > 0; k++) {
      const nx = cx(b.path[k]);
      const ny = cy(b.path[k]);
      const seg = Math.hypot(nx - ax, ny - ay);
      const t = Math.min(1, left / Math.max(seg, 1e-6));
      adir = Math.atan2(ny - ay, nx - ax);
      ax += (nx - ax) * t;
      ay += (ny - ay) * t;
      left -= seg;
    }
    if (left > 0 && moor !== null) {
      // As far as the berth itself: lie the way it will moor.
      adir = Math.abs(wrapAngle(moor - b.dir)) > Math.PI / 2 ? wrapAngle(moor + Math.PI) : moor;
    }
    if (b.berthing === 'lead' && b.lineup !== undefined && b.path.includes(b.lineup)) {
      // Heading out to the start of the approach line: just get there.
      ax = cx(b.lineup);
      ay = cy(b.lineup);
      adir = Math.atan2(ay - b.y, ax - b.x);
    }
    // Held up by a boat lying still in its way, it does not go on at it:
    // it swings round where it lies, or backs off, towards the next turn
    // of its way rather than a ship's length along it, which may lie on
    // past that boat.
    const heldStill = way.still && (b.stillFor ?? 0) > B.HELD_STILL_TICKS;
    if (heldStill && b.path[0] !== undefined) {
      ax = cx(b.path[0]);
      ay = cy(b.path[0]);
      adir = Math.atan2(ay - b.y, ax - b.x);
    }
    // The best whose very first step is clear too.
    const best = manoeuvre(world, b, ax, ay, adir, speed, ships, now, reach).find((o) => {
      if (heldStill && !o.pivot && !o.astern) return false;
      const n = step(o);
      return fits(n.x, n.y, n.d);
    });
    plan = best
      ? { helm: best.helm, astern: best.astern, pivot: best.pivot, until: world.tick + 8 }
      : undefined;
    b.plan = plan;
  }
  let backed = false;
  const next = plan ? step(plan) : null;
  if (plan && next && !fits(next.x, next.y, next.d)) {
    // The run looked clear but this step is not: think again next tick.
    b.plan = undefined;
    speed = 0;
  } else if (
    plan &&
    next &&
    // Ahead only as the way ahead lets it; but swinging round where it
    // lies, or backing off, takes it no nearer what it waits for, so it
    // may: else, held by a boat lying still off its bow, a long ship
    // that cannot turn without way on would wait there for good.
    (way.speed > 0.05 || plan.pivot || (plan.astern && clearAstern(world, b)))
  ) {
    b.dir = next.d;
    b.x = next.x;
    b.y = next.y;
    if (plan.astern || plan.pivot) {
      b.sternway = next.back;
      speed = 0;
      backed = true;
    } else b.sternway = 0;
  } else if ((b.held ?? 0) > B.BOAT_WEDGED_AFTER / 2 || (b.squeeze ?? 0) > 0) {
    // Boxed in for a long time: work along the path at a crawl, as a
    // skipper would with a bit of throttle and rudder.
    const px = cx(target) - b.x;
    const py = cy(target) - b.y;
    const d = Math.hypot(px, py);
    const crawl = Math.min(d, v.speed * 0.2);
    speed = 0;
    if (d > 1e-6 && way.speed > 0.05) {
      b.x += (px / d) * crawl;
      b.y += (py / d) * crawl;
      speed = crawl;
    }
  } else speed = 0;
  return afterMove(world, b, speed, backed, moor, goal, cx, cy);
}

/**
 * A long ship leaving runs straight out along the dock, ahead or astern,
 * keeping its heading, to the open water at `end`; there it is free to
 * turn for the sea.
 */
export function runOut(
  w: World,
  b: Boat,
  end: number,
  start: number,
  goal: number,
  cx: (i: number) => number,
  cy: (i: number) => number,
): 'moving' | 'blocked' {
  const v = B.VESSELS[b.vessel];
  const ex = cx(end);
  const ey = cy(end);
  const len = Math.hypot(ex - cx(start), ey - cy(start));
  const ux = (ex - cx(start)) / len;
  const uy = (ey - cy(start)) / len;
  const gone = (b.x - cx(start)) * ux + (b.y - cy(start)) * uy;
  if (gone >= len - 0.2) {
    // Out in open water: on its way to sea.
    b.lineup = b.lineEnd = b.berthing = undefined;
    const from = w.tileOf(b);
    b.path = route(w, b, from, goal, seaWay(w, b)) ?? [goal];
    b.best = Infinity;
    b.stall = 0;
    return 'moving';
  }
  const fwd = Math.cos(b.dir) * ux + Math.sin(b.dir) * uy >= 0;
  const ships = stillNear(w, b);
  const now = clips(w, b, b.x, b.y, b.dir, ships);
  const way = giveWay(w, b);
  const accel = v.speed * B.BOAT_ACCEL;
  const top = (fwd ? 0.75 : 0.5) * v.speed * way.speed * (0.4 + 0.6 * handiness(w, b));
  const speed = clamp(
    (b.speed ?? 0) + accel,
    0,
    Math.min(top, Math.sqrt(2 * accel * (len - gone)) + 0.004),
  );
  // Along the line, easing back onto it if it has drifted.
  const side = -(b.x - cx(start)) * uy + (b.y - cy(start)) * ux;
  const x = b.x + ux * speed - -uy * side * 0.05;
  const y = b.y + uy * speed - ux * side * 0.05;
  if (speed > 0 && clips(w, b, x, y, b.dir, ships) <= now) {
    b.x = x;
    b.y = y;
    b.speed = fwd ? speed : 0;
    b.sternway = fwd ? 0 : speed;
    b.astern = !fwd;
    return afterMove(w, b, speed, true, null, goal, cx, cy);
  }
  b.speed = 0;
  b.sternway = 0;
  return afterMove(w, b, 0, false, null, goal, cx, cy);
}

/**
 * A long ship at the start of its approach line comes round to lie along
 * it, heading for the berth: swung by tugs where it lies when there is room
 * for the whole hull, otherwise worked round under way.
 */
export function lineUp(
  w: World,
  b: Boat,
  along: number,
  sx: number,
  sy: number,
  moor: number,
  goal: number,
  cx: (i: number) => number,
  cy: (i: number) => number,
): 'moving' | 'blocked' {
  const v = B.VESSELS[b.vessel];
  const ships = stillNear(w, b);
  const now = clips(w, b, b.x, b.y, b.dir, ships);
  const hand = handiness(w, b);
  const swung = wrapAngle(b.dir + clamp(wrapAngle(along - b.dir), -v.turn * hand, v.turn * hand));
  if (clips(w, b, b.x, b.y, swung, ships) <= now) {
    b.dir = swung;
    b.speed = 0;
    return afterMove(w, b, 0, true, moor, goal, cx, cy);
  }
  // No room to swing here: manoeuvre towards a point along the line.
  const options = manoeuvre(
    w,
    b,
    sx + Math.cos(along) * 2,
    sy + Math.sin(along) * 2,
    along,
    v.speed * 0.25,
    ships,
    now,
    v.length / 2 + 1,
  );
  for (const plan of options) {
    if (plan.pivot) continue;
    const step = plan.astern ? -v.speed * 0.25 : v.speed * 0.25;
    const d = wrapAngle(b.dir + plan.helm * v.turn * (plan.astern ? 0.25 : 0.5));
    const x = b.x + Math.cos(d) * step;
    const y = b.y + Math.sin(d) * step;
    if (clips(w, b, x, y, d, ships) > now) continue;
    b.dir = d;
    b.x = x;
    b.y = y;
    b.speed = Math.max(0, step);
    return afterMove(w, b, b.speed, plan.astern, moor, goal, cx, cy);
  }
  return afterMove(w, b, 0, false, moor, goal, cx, cy);
}

/**
 * A small boat's step: swing towards its course by up to `turn` and go
 * ahead, as far round as its whole hull stays clear of the shore and the
 * docks (or at least no less clear than it is). Otherwise it works along
 * the path at a crawl, as a skipper would with a bit of throttle and
 * rudder, still minding the hull. Returns the speed made good, null
 * while it is still taking sternway off, or 'boxed' when there is no
 * room for any of that.
 */
export function nip(
  w: World,
  b: Boat,
  speed: number,
  turn: number,
  tx: number,
  ty: number,
  way: number,
): number | null | 'boxed' {
  const v = B.VESSELS[b.vessel];
  const cost = boatCostFor(w, b.draft);
  const ships = stillNear(w, b);
  const now = clips(w, b, b.x, b.y, b.dir, ships);
  // Squeezing past as a last resort, it may brush the dock too. Else its
  // hull comes no nearer another boat's, under way or not, once close.
  const fits = (x: number, y: number, d: number) =>
    ((b.squeeze ?? 0) > 0 || (navigable(w, x, y, cost) && clips(w, b, x, y, d, ships) <= now)) &&
    !crowds(w, b, x, y, d);
  // Take any sternway off before going ahead again.
  if ((b.sternway ?? 0) > 0) {
    const back = Math.max(0, (b.sternway ?? 0) - v.speed * B.BOAT_ACCEL * 2);
    const sx = b.x - Math.cos(b.dir) * back;
    const sy = b.y - Math.sin(b.dir) * back;
    const moved = fits(sx, sy, b.dir);
    if (moved) {
      b.x = sx;
      b.y = sy;
    }
    b.sternway = moved ? back : 0;
    return null;
  }
  for (const share of [1, 0.5, 0]) {
    const d = wrapAngle(b.dir + turn * share);
    const nx = b.x + Math.cos(d) * speed;
    const ny = b.y + Math.sin(d) * speed;
    if (navigable(w, nx + Math.cos(d) * 0.3, ny + Math.sin(d) * 0.3, cost) && fits(nx, ny, d)) {
      b.dir = d;
      b.x = nx;
      b.y = ny;
      return speed;
    }
  }
  const px = tx - b.x;
  const py = ty - b.y;
  const d = Math.hypot(px, py);
  const step = Math.min(d, v.speed * 0.2);
  if (d <= 1e-6 || way <= 0.05) return 0;
  const turned = wrapAngle(b.dir + turn);
  for (const dir of [turned, b.dir]) {
    const nx = b.x + (px / d) * step;
    const ny = b.y + (py / d) * step;
    if (!fits(nx, ny, dir)) continue;
    b.dir = dir;
    b.x = nx;
    b.y = ny;
    return step;
  }
  return 'boxed';
}

/** Book-keeping after a step: held up, wedged, getting nowhere. */
export function afterMove(
  w: World,
  b: Boat,
  speed: number,
  backed: boolean,
  moor: number | null,
  goal: number,
  cx: (i: number) => number,
  cy: (i: number) => number,
): 'moving' | 'blocked' {
  const v = B.VESSELS[b.vessel];
  b.speed = speed;

  // Waiting for a ship to pull out is not being wedged in.
  const waiting = w.roomWait.has(b);
  b.held = speed < v.speed * 0.1 && !backed && !waiting ? (b.held ?? 0) + 1 : 0;
  // Wedged in for most of a day: squeeze past for a while, as a last
  // resort so the harbour never locks up for good.
  if (b.squeeze) b.squeeze--;
  else if (b.held > B.BOAT_WEDGED_AFTER || (b.stall ?? 0) > B.BOAT_WEDGED_AFTER * 2) {
    startSqueeze(w, b);
    b.held = 0;
    b.stall = 0;
  }
  // Getting no closer, held up or going round in circles: find another way,
  // round every other boat this time. Coming in to a berth, closer means
  // closer to the start of the approach line until the boat is on it.
  const aim = b.lineup !== undefined && b.path.includes(b.lineup) ? b.lineup : goal;
  const straight = Math.hypot(cx(aim) - b.x, cy(aim) - b.y);
  if (straight < (b.best ?? Infinity) - 0.05) {
    b.best = straight;
    b.stall = 0;
  } else b.stall = (b.stall ?? 0) + 1;
  const steady = b.berthing === 'align' || b.berthing === 'line' || b.berthing === 'out';
  if (!steady && b.stall > B.BOAT_REROUTE_AFTER && b.stall % B.BOAT_REROUTE_AFTER === 0) {
    const from = w.tileOf(b);
    const path =
      (moor !== null && b.state === 'arriving' && v.length >= B.LINE_UP_LENGTH
        ? approachPath(w, b, from, b.berth, b.jetty)
        : null) ??
      route(w, b, from, goal, seaWay(w, b, true)) ??
      route(w, b, from, goal, seaWay(w, b));
    if (path) b.path = path.length > 0 ? path : [goal];
    else if (b.stall > B.BOAT_REROUTE_AFTER * 8) return 'blocked';
  }
  return 'moving';
}

/**
 * Leaving a berth like a boat: ease sideways off the dock first, then, if
 * the way out lies astern, back out, swinging the bow round, until there
 * is room to turn under way. Returns true while still casting off.
 */
export function castingOff(w: World, b: Boat, want: number): boolean {
  const m = w.map;
  const v = B.VESSELS[b.vessel];
  const cost = boatCostFor(w, b.draft);
  if (b.castOff === undefined || b.castDock === undefined) {
    b.undock = undefined;
    b.backOut = undefined;
    b.comeRound = undefined;
    return false;
  }
  const bx = m.xOf(b.castOff) + 0.5;
  const by = m.yOf(b.castOff) + 0.5;
  // Unit step away from the dock.
  const ax = m.xOf(b.castOff) - m.xOf(b.castDock);
  const ay = m.yOf(b.castOff) - m.yOf(b.castDock);
  if (b.undock === 1) {
    const off = (b.x - bx) * ax + (b.y - by) * ay;
    const step = v.speed * 0.2 * handiness(w, b);
    // A long ship gets a tile out, or with no run out along the dock, out
    // as far as it takes to have room to swing; a small boat far enough
    // that its stern swings clear of the dock as it turns.
    const runAlong = b.berthing === 'out' && b.lineEnd === b.castOff;
    const clear = runAlong
      ? 0.3
      : b.berthing === 'out'
        ? 1
        : v.length < B.CAREFUL_LENGTH
          ? v.length / 2 - 0.3
          : openAround(w, b.x, b.y, v.length / 2)
            ? 1
            : 4;
    const ships = stillNear(w, b);
    const sx = b.x + ax * step;
    const sy = b.y + ay * step;
    const room =
      navigable(w, sx, sy, cost) &&
      clips(w, b, sx, sy, b.dir, ships) <= clips(w, b, b.x, b.y, b.dir, ships) &&
      !crowds(w, b, sx, sy);
    if (off < clear && room) {
      b.x += ax * step;
      b.y += ay * step;
      b.speed = 0;
      return true;
    }
    b.undock = 2;
  }
  // Running out along the dock: no swinging round yet.
  if (b.berthing === 'out') {
    b.undock = undefined;
    return false;
  }
  const err = wrapAngle(want - b.dir);
  // Off the dock, a small boat's skipper looks where there is room to come
  // round: here beside the dock, or out in the open water astern, backing
  // out straight along the dock to it. Coming round in the narrows is how a
  // boat gets stuck there. A long ship works itself round as sail() has it.
  if (b.backOut === undefined) {
    const plan =
      v.length >= B.CAREFUL_LENGTH || Math.abs(err) < 0.2 ? null : roomToComeRound(w, b, want);
    b.backOut = v.length >= B.CAREFUL_LENGTH ? -1 : Math.abs(err) < 0.2 ? 0 : (plan?.back ?? -1);
    b.comeRound = plan?.side;
  }
  if (b.backOut > 0.02) {
    const back = Math.min(v.speed * 0.5, (b.sternway ?? 0) + v.speed * B.BOAT_ACCEL, b.backOut);
    const sx = b.x - Math.cos(b.dir) * back;
    const sy = b.y - Math.sin(b.dir) * back;
    const ships = stillNear(w, b);
    const clear =
      navigable(w, sx, sy, cost) &&
      clips(w, b, sx, sy, b.dir, ships) <= clips(w, b, b.x, b.y, b.dir, ships) &&
      !crowds(w, b, sx, sy) &&
      clearAstern(w, b);
    if (clear) {
      b.x = sx;
      b.y = sy;
      b.speed = 0;
      b.sternway = back;
      b.astern = true;
      b.backOut -= back;
      b.held = 0;
      return true;
    }
    // Something has come up astern: wait for it to pass, a while.
    b.sternway = 0;
    b.held = (b.held ?? 0) + 1;
    if (b.held < B.HEAD_ON_TICKS * 3) return true;
  }
  const backed = Math.hypot(b.x - bx, b.y - by);
  if (b.backOut < 0 && Math.abs(err) > 1.75 && backed < 2.5) {
    // Gathering sternway gradually, like any other way.
    const back = Math.min(v.speed * 0.5, (b.sternway ?? 0) + v.speed * B.BOAT_ACCEL);
    const sx = b.x - Math.cos(b.dir) * back;
    const sy = b.y - Math.sin(b.dir) * back;
    const stern = { ...hullOf(w, b), hx: -Math.cos(b.dir), hy: -Math.sin(b.dir) };
    // Going astern the stern swings one way and the bow the other.
    const swing = v.turn * 0.4 * handiness(w, b);
    const swung = wrapAngle(b.dir + clamp(err, -swing, swing));
    const ships = stillNear(w, b);
    const roomAstern =
      clips(w, b, sx, sy, swung, ships) <= clips(w, b, b.x, b.y, b.dir, ships) &&
      !crowds(w, b, sx, sy, swung);
    const clear =
      roomAstern &&
      w.boats.every((o) => o === b || inWay(w, stern, hullOf(w, o), stern.half + 0.3) === null);
    if (clear) {
      b.x = sx;
      b.y = sy;
      b.dir = swung;
      b.speed = 0;
      b.sternway = back;
      b.astern = true;
      return true;
    }
  }
  // Any sternway left comes off gradually in sail().
  b.undock = undefined;
  b.backOut = undefined;
  b.astern = false;
  return false;
}

/**
 * Where a boat just off the dock has room to come round to `want`, and
 * which way (`side`, -1 or 1, the short way round if both will do): `back`
 * 0 where it lies, or how far it must back out straight first, a quarter
 * of a tile at a time up to a few tiles, to open water where it has; null
 * if nowhere. Coming round is reckoned as sail() and nip() do it, gathering
 * way and swinging in an arc, its whole hull keeping clear of the shore,
 * the docks and boats lying still (boats under way will have moved on).
 */
export function roomToComeRound(
  w: World,
  b: Boat,
  want: number,
): { back: number; side: number } | null {
  const v = B.VESSELS[b.vessel];
  const cost = boatCostFor(w, b.draft);
  const ships = stillNear(w, b);
  const now = clips(w, b, b.x, b.y, b.dir, ships);
  const cos = Math.cos(b.dir);
  const sin = Math.sin(b.dir);
  // Swinging to `side` (-1 or 1) all the way round, the long way if need be.
  const comesRound = (x0: number, y0: number, side: number): boolean => {
    const base = clips(w, b, x0, y0, b.dir, ships);
    let [x, y, d, speed] = [x0, y0, b.dir, 0];
    for (let t = 0; t < 400; t++) {
      let err = wrapAngle(want - d);
      if (Math.abs(err) < 0.2) return true;
      if (Math.sign(err) !== side) err += side * 2 * Math.PI;
      const desired = v.speed * Math.max(0.25, Math.cos(Math.min(Math.abs(err), Math.PI / 2)) ** 2);
      speed += clamp(
        desired - speed,
        -v.speed * B.BOAT_ACCEL * B.BOAT_BRAKE,
        v.speed * B.BOAT_ACCEL,
      );
      const turn = v.turn * (0.3 + (0.7 * speed) / v.speed);
      d = wrapAngle(d + clamp(err, -turn, turn));
      x += Math.cos(d) * speed;
      y += Math.sin(d) * speed;
      const ok =
        navigable(w, x + Math.cos(d) * 0.3, y + Math.sin(d) * 0.3, cost) &&
        navigable(w, x, y, cost) &&
        clips(w, b, x, y, d, ships) <= base;
      if (!ok) return false;
    }
    return false;
  };
  // The short way round first.
  const short = Math.sign(wrapAngle(want - b.dir)) || 1;
  const sides = [short, -short];
  for (let back = 0; back <= B.BACK_OUT_TILES; back += 0.25) {
    const x = b.x - cos * back;
    const y = b.y - sin * back;
    // Backing out straight as far as that, no nearer anything than now.
    if (back > 0 && (!navigable(w, x, y, cost) || clips(w, b, x, y, b.dir, ships) > now))
      return null;
    for (const side of sides) if (comesRound(x, y, side)) return { back, side };
  }
  return null;
}

/** Back off slowly to clear the way for another boat, if nothing is astern. */
/** Nothing under way or lying still just astern of a boat, for it to back into. */
export function clearAstern(w: World, b: Boat): boolean {
  const astern = { ...hullOf(w, b), hx: -Math.cos(b.dir), hy: -Math.sin(b.dir) };
  return w.boats.every(
    (o) => o === b || inWay(w, astern, hullOf(w, o), astern.half + 0.3) === null,
  );
}

export function goAstern(w: World, b: Boat): void {
  const v = B.VESSELS[b.vessel];
  const cost = boatCostFor(w, b.draft);
  const back = Math.min(v.speed * 0.3, (b.sternway ?? 0) + v.speed * B.BOAT_ACCEL);
  const sx = b.x - Math.cos(b.dir) * back;
  const sy = b.y - Math.sin(b.dir) * back;
  const sternX = sx - Math.cos(b.dir) * 0.3;
  const sternY = sy - Math.sin(b.dir) * 0.3;
  const moved =
    clearAstern(w, b) &&
    navigable(w, sx, sy, cost) &&
    navigable(w, sternX, sternY, cost) &&
    !crowds(w, b, sx, sy);
  if (moved) {
    b.x = sx;
    b.y = sy;
  }
  b.speed = 0;
  b.sternway = moved ? back : 0;
  b.astern = true;
  b.held = (b.held ?? 0) + 1;
}

/** Open water here; past the map edge is open sea, where boats come and go. */
/**
 * How many points of the hull, lying at x, y heading dir, are over land
 * or a dock, or inside one of `ships`. Points along the keel from stern
 * to bow and along both sides. (Depth is the route's business: a hull's
 * ends may hang over the shallows, as at a berth.)
 */
export function clips(
  world: World,
  b: Boat,
  x: number,
  y: number,
  dir: number,
  ships: Boat[],
): number {
  const v = B.VESSELS[b.vessel];
  const m = world.map;
  const cost: CostFn = (i) =>
    m.isLand(i) || (m.build[i] !== Build.None && !isBuoy(m.build[i])) ? Infinity : 1;
  const hx = Math.cos(dir);
  const hy = Math.sin(dir);
  const side = (v.beam / 2) * 0.9;
  const n = Math.max(2, Math.ceil(v.length / 0.45));
  let hits = 0;
  const at = (px: number, py: number) => {
    if (!navigable(world, px, py, cost)) return hits++;
    for (const o of ships) {
      const w = B.VESSELS[o.vessel];
      const ox = Math.cos(o.dir);
      const oy = Math.sin(o.dir);
      const rx = px - o.x;
      const ry = py - o.y;
      const along = Math.abs(rx * ox + ry * oy);
      const across = Math.abs(-rx * oy + ry * ox);
      if (along < w.length / 2 + 0.05 && across < w.beam / 2 + 0.05) return hits++;
    }
  };
  for (let k = 0; k <= n; k++) {
    const t = -v.length / 2 + (v.length * k) / n;
    const px = x + hx * t;
    const py = y + hy * t;
    at(px, py);
    // The ends taper to a point.
    if (k > 0 && k < n) {
      at(px - hy * side, py + hx * side);
      at(px + hy * side, py - hx * side);
    }
  }
  return hits;
}
