import type { GameMap } from '../../sim/map';
import { drivable } from '../../sim/rules';
import { Build } from '../../sim/types';
import { driveTo, type Pose } from '../motion';
import { surfaceY } from '../terrain';
import { ease } from '../util/math';

// A forklift taking a load or setting one down: where it lines up, square
// on to it a little back, and how it gets there, drives in, lifts or lowers
// its forks, and backs out again. Pure sums over poses, given what is in
// the way; nothing here touches the scene.

/** How far ahead of a forklift's middle the pallet on its forks sits. */
export const FORK_REACH = 0.3;
/** How far back from where it works a forklift lines up, at most and at least. */
const STANDOFF = 0.35;
const STANDOFF_LEAST = 0.12;
/** How far the forks lift a load clear of where it lies, or ride over where it goes. */
const LIFT = 0.04;
/** How high the bottom of a crate on the forks is above them. */
export const ON_FORKS = 0.04;

/**
 * Points of a forklift's body, ahead of and to the right of its middle,
 * that keep off what is in the way: its forks are left out, as they go
 * under a load.
 */
const BODY: [number, number][] = [
  [0.18, -0.16],
  [0.18, 0],
  [0.18, 0.16],
  [-0.04, -0.16],
  [-0.04, 0.16],
  [-0.26, -0.16],
  [-0.26, 0],
  [-0.26, 0.16],
];

/** What a forklift keeps clear of. */
export interface ForkSite {
  map: GameMap;
  /** A truck standing still at x, z, with room round it. */
  inTruck(x: number, z: number): boolean;
  /** A crate showing at x, z, `pad` round it. */
  crateIn(x: number, z: number, pad: number): boolean;
}

/** Whether x, z is on ground a forklift drives on: port roads, quays, bays; not into a depot. */
function onGround(map: GameMap, x: number, z: number): boolean {
  const [tx, tz] = [Math.floor(x), Math.floor(z)];
  if (!map.inBounds(tx, tz)) return false;
  const b = map.build[map.idx(tx, tz)];
  return drivable(b) && b !== Build.Depot;
}

/** Whether a forklift stood at x, z facing `dir` is on the port's ground, clear of trucks and crates. */
export function bodyClear(site: ForkSite, x: number, z: number, dir: number): boolean {
  return bodyBlocked(site, x, z, dir) === 0;
}

/**
 * How badly a forklift stood at x, z facing `dir` is in the way of things:
 * how many points of its body are off the port's ground, those over a
 * truck or crates counting three times; 0 if it is clear.
 */
export function bodyBlocked(site: ForkSite, x: number, z: number, dir: number): number {
  const c = Math.cos(dir);
  const s = Math.sin(dir);
  let n = 0;
  for (const [f, r] of BODY) {
    const px = x + c * f - s * r;
    const pz = z + s * f + c * r;
    // Over a truck or crates is worse than just off the port's ground.
    if (site.inTruck(px, pz) || site.crateIn(px, pz, 0.01)) n += 3;
    else if (!onGround(site.map, px, pz)) n++;
  }
  return n;
}

/** A crate a forklift takes, or the place one it sets down goes: its base, and how big it is. */
export interface Crate {
  x: number;
  y: number;
  z: number;
}

/**
 * Where a forklift works a load: `goal`, its forks under it (h, their
 * height above the ground there); `line`, square on to it and back from
 * it, where it lines up before driving in; and how it faces.
 */
export interface ForkPlan {
  goal: Pose;
  line: Pose;
  /** Backing out of where it worked the last load, first: where to. */
  out?: Pose;
}

/**
 * Which way a forklift comes up to a load, square on to it, and where it
 * stands: of the four ways square to `heading`, the clear one it takes
 * least driving to get to, `prefer` saying how much less each is liked
 * (Infinity for never). `crates` are those it takes, or the places those it
 * sets down go, the last of them on top; its forks go to the row of them
 * nearest it, as high as the lowest of that row.
 */
export function forkPlan(
  site: ForkSite,
  crates: Crate[],
  heading: number,
  prefer: (face: number) => number,
  from: Pose,
): ForkPlan | null {
  if (crates.length === 0) return null;
  const top = crates[crates.length - 1];
  let best: ForkPlan | null = null;
  let least = Infinity;
  for (let k = 0; k < 4; k++) {
    const face = heading + (k * Math.PI) / 2;
    const dislike = prefer(face);
    if (!Number.isFinite(dislike)) continue;
    const ux = Math.cos(face);
    const uz = Math.sin(face);
    // The row the top one is in, across its way in.
    const along = (c: Crate) => c.x * ux + c.z * uz;
    const row = crates.filter((c) => Math.abs(along(c) - along(top)) < 0.06);
    const px = row.reduce((a, c) => a + c.x, 0) / row.length;
    const pz = row.reduce((a, c) => a + c.z, 0) / row.length;
    const py = Math.min(...row.map((c) => c.y));
    // Forks under it, backed off as far as it takes to keep its body clear.
    let back = 0;
    const at = (d: number) => [px - ux * (FORK_REACH + d), pz - uz * (FORK_REACH + d)];
    while (back < 0.4 && !bodyClear(site, ...(at(back) as [number, number]), face)) back += 0.02;
    let cost = dislike + back * 3;
    if (back >= 0.4) cost += 10;
    const [gx, gz] = at(back);
    // Lined up as far back as it can be, up to the most.
    let stand = STANDOFF;
    const clear = (d: number) =>
      bodyClear(site, gx - ux * d, gz - uz * d, face) &&
      bodyClear(site, gx - (ux * d) / 2, gz - (uz * d) / 2, face);
    while (stand > STANDOFF_LEAST && !clear(stand)) stand -= 0.04;
    if (!clear(stand)) cost += 5;
    const lx = gx - ux * stand;
    const lz = gz - uz * stand;
    cost += 0.5 * Math.hypot(lx - from.x, lz - from.z) + 0.3 * (1 - Math.cos(face - from.dir));
    if (cost >= least) continue;
    least = cost;
    const h = Math.max(0, py - surfaceY(site.map, gx, gz) - ON_FORKS);
    best = {
      goal: { x: gx, z: gz, dir: face, h },
      line: { x: lx, z: lz, dir: face, h },
    };
  }
  return best;
}

/** Straight back or forward from one pose to another as it faces, `a` of the way. */
function straight(from: Pose, to: Pose, a: number): Omit<Pose, 'h'> {
  const t = ease(Math.max(0, Math.min(1, a)));
  return { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t, dir: to.dir };
}

/** How far through coming up to a load a forklift is in, and once up to it. */
const LINED = 0.45;
const IN = 0.8;

/**
 * A forklift coming up to a load, `a` (0 to 1) of the way through taking
 * it (`pick`) or setting it down: backed out of where it worked the last,
 * if it has to, it drives round to line up, lifting its forks to the load's
 * height as it gets there (a loaded one just above where it goes), drives
 * straight in, and stands, forks under the load as it changes hands, or
 * lowering it onto where it goes.
 */
export function forkIn(plan: ForkPlan, from: Pose, a: number, pick: boolean): Pose {
  const { goal, line, out } = plan;
  const high = pick ? goal.h : goal.h + LIFT;
  const start = out ? 0.15 : 0;
  // Forks up from how they ride over the last part of lining up.
  const lift = (b: number) => from.h + (high - from.h) * ease((b - (LINED - 0.2)) / 0.2);
  if (out && a < start) return { ...straight(from, out, a / start), h: from.h };
  if (a < LINED) {
    const b = (a - start) / (LINED - start);
    return { ...driveTo(out ?? from, line, b), h: lift(a) };
  }
  if (a < IN) return { ...straight(line, goal, (a - LINED) / (IN - LINED)), h: high };
  const h = pick ? high : high + (goal.h - high) * ease((a - IN) / (1 - IN - 0.05));
  return { x: goal.x, z: goal.z, dir: goal.dir, h };
}

/** How far through leaving a forklift has backed out to where it lined up. */
const OUT = 0.4;

/**
 * A forklift leaving where it took a load or set one down, `s` (0 to 1)
 * of the way: it lifts the load clear, or lowers its forks out from under
 * what it left, backs straight out, lowers them to how they ride (`ride`),
 * and drives on to `drive`.
 */
export function forkOut(plan: ForkPlan, drive: Pose, s: number, ride: number, pick: boolean): Pose {
  const { goal, line } = plan;
  const free = Math.max(0, pick ? goal.h + LIFT : goal.h - LIFT / 2);
  if (s < 0.1) return { ...goal, h: goal.h + (free - goal.h) * ease(s / 0.1) };
  if (s < OUT) {
    const b = (s - 0.1) / (OUT - 0.1);
    return { ...straight(goal, line, b), h: free + (ride - free) * ease((b - 0.5) / 0.5) };
  }
  return { ...driveTo(line, drive, (s - OUT) / (1 - OUT)), h: ride };
}
