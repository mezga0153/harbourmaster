import { clamp01, ease, lerpAngle } from './util/math';

// How a drawn thing gets from one pose to another between the places the
// sim gives it: slid, walked or driven, and the way a forklift turns about
// rather than spin on the spot. Pure sums over poses; nothing here touches
// the scene.

/** Where a machine stands and which way it faces; for a stacker, how high it holds a container. */
export interface Pose {
  x: number;
  z: number;
  dir: number;
  h: number;
  /**
   * A dockhand kept on the quay with the crate out over the water, on a
   * boat: how much further on it is than they reach standing.
   */
  over?: number;
  /** Stood where it must be, as at a truck bay: not moved clear of the truck. */
  fixed?: boolean;
}

/** Straight across from one pose to another, turning as it goes, `a` of the way. */
export function slide(from: Pose, to: Pose, a: number): Omit<Pose, 'h'> {
  return {
    x: from.x + (to.x - from.x) * a,
    z: from.z + (to.z - from.z) * a,
    dir: lerpAngle(from.dir, to.dir, a),
  };
}

/**
 * Walked from one pose to another, `a` (0 to 1) of the way: turning to the
 * way there as they set off, and to stand as they are as they get there.
 */
export function walkTo(from: Pose, to: Pose, a: number): Omit<Pose, 'h'> {
  const c = clamp01(a);
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.hypot(dx, dz) < 0.05) return slide(from, to, ease(c));
  const way = Math.atan2(dz, dx);
  const t = ease(c);
  return {
    x: from.x + dx * t,
    z: from.z + dz * t,
    dir:
      c < 0.7
        ? lerpAngle(from.dir, way, ease(c / 0.3))
        : lerpAngle(way, to.dir, ease((c - 0.7) / 0.3)),
  };
}

/** How long a way through these points is. */
export function length(points: { x: number; z: number }[]): number {
  let d = 0;
  for (let k = 1; k < points.length; k++) {
    d += Math.hypot(points[k].x - points[k - 1].x, points[k].z - points[k - 1].z);
  }
  return d;
}

/** As walkTo, by way of the points `via`, round whatever is in the way. */
export function walkVia(
  from: Pose,
  via: { x: number; z: number }[],
  to: Pose,
  a: number,
): Omit<Pose, 'h'> {
  if (via.length === 0) return walkTo(from, to, a);
  const c = clamp01(a);
  const points = [from, ...via, to];
  let left = length(points) * ease(c);
  for (let k = 1; k < points.length; k++) {
    const p = points[k - 1];
    const q = points[k];
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (left > d && k < points.length - 1) {
      left -= d;
      continue;
    }
    const f = d > 0 ? Math.min(1, left / d) : 1;
    const way = Math.atan2(q.z - p.z, q.x - p.x);
    return {
      x: p.x + (q.x - p.x) * f,
      z: p.z + (q.z - p.z) * f,
      dir:
        c < 0.15
          ? lerpAngle(from.dir, way, ease(c / 0.15))
          : c > 0.85
            ? lerpAngle(way, to.dir, ease((c - 0.85) / 0.15))
            : way,
    };
  }
  return { x: to.x, z: to.z, dir: to.dir };
}

/**
 * Driven from one pose to another, `a` (0 to 1) of the way, as a machine
 * would: it turns to face the way it is going (or straight away from it, to
 * back there), drives straight there, then turns as it is to stand; never
 * sliding sideways. A short way it just edges across.
 */
export function driveTo(from: Pose, to: Pose, a: number): Omit<Pose, 'h'> {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.08) return slide(from, to, ease(a));
  let way = Math.atan2(dz, dx);
  // Backing is less turning if the way is behind it.
  if (Math.cos(way - from.dir) < 0) way += Math.PI;
  if (a < 0.25) return { x: from.x, z: from.z, dir: lerpAngle(from.dir, way, ease(a / 0.25)) };
  if (a < 0.75) {
    const t = ease((a - 0.25) / 0.5);
    return { x: from.x + dx * t, z: from.z + dz * t, dir: way };
  }
  return { x: to.x, z: to.z, dir: lerpAngle(way, to.dir, ease((a - 0.75) / 0.25)) };
}

/** Forklifts: how far to the right of the middle of the way they keep. */
export const FORK_KEEP = 0.16;
/** Forklifts turning about: the tighter of the two arcs they go round. */
const TIGHT_ARC = 0.15;
/**
 * How far it drives on straight after, catching up with where it would be
 * had it not had to go round: it goes not much faster than usual.
 */
const RUN_OUT = 0.8;

/** Where a forklift turning about is and which way it faces; see turnAbout. */
export interface TurnAbout {
  /** How far along its way it goes while it turns about. */
  reach: number;
  /**
   * Given how far along the way it has gone from where it stood: how far
   * ahead of that point and to the right of the middle of the way it is,
   * and which way it faces, against the way it is going.
   */
  at(s: number): { ahead: number; right: number; face: number };
}

/**
 * A forklift that sets off the way its tail points, as when it drives away
 * from a load it has just picked up or set down, does not spin round on the
 * spot: it backs out with its tail swinging round until it is side on to
 * its way, then pulls forward round onto it, keeping to its own side, and
 * drives on a little to catch up. It starts facing `face` against the way
 * it is going (more than a right angle off), on its own side of where it
 * faced, and ends facing ahead. Whichever way it turns, the arc it backs out
 * on or the one it pulls forward round is wide enough to cross from one side
 * of the way to the other.
 */
export function turnAbout(face: number): TurnAbout {
  const quarter = Math.PI / 2;
  // Worked out turning left, from a face between straight back and side on
  // to the left; the other way round is the same, mirrored.
  const mirror = face > 0 && face < Math.PI - 0.01;
  const f0 = mirror ? -face : face > 0 ? face - Math.PI * 2 : face;
  const keep = mirror ? -FORK_KEEP : FORK_KEEP;
  const c = Math.max(0.05, -Math.cos(f0));
  const back = keep > 0 ? (keep * (1 + c) + TIGHT_ARC) / c : TIGHT_ARC;
  const pull = keep > 0 ? TIGHT_ARC : back * c - keep * (1 + c);
  const x0 = -keep * Math.sin(f0);
  const y0 = keep * Math.cos(f0);
  const x1 = x0 + back * (Math.sin(f0) + 1);
  const y1 = y0 - back * Math.cos(f0);
  const backLength = back * (-quarter - f0);
  const turned = backLength + pull * quarter;
  const length = turned + RUN_OUT;
  const reach = x1 + pull + RUN_OUT;
  return {
    reach,
    at(s: number) {
      const d = Math.max(0, Math.min(reach, s));
      const l = (d / reach) * length;
      let x: number;
      let y: number;
      let f: number;
      if (l < backLength) {
        f = f0 + l / back;
        x = x0 + back * (Math.sin(f0) - Math.sin(f));
        y = y0 + back * (Math.cos(f) - Math.cos(f0));
      } else if (l < turned) {
        f = -quarter + (l - backLength) / pull;
        x = x1 + pull * (1 + Math.sin(f));
        y = y1 - pull * Math.cos(f);
      } else {
        f = 0;
        x = x1 + pull + (l - turned);
        y = y1 - pull;
      }
      return { ahead: x - d, right: mirror ? -y : y, face: mirror ? -f : f };
    },
  };
}

/** A forklift turning about: where from, which way to, see turnAbout. */
export interface About {
  x: number;
  y: number;
  dir: number;
  path: TurnAbout;
  /** The sim tick of the snapshot it started in, so it starts once. */
  tick: number;
  done: boolean;
  /** How far over from where the way has it it is all the way round, as it was drawn clear of a truck when it started. */
  off?: [number, number];
}

/** Where a forklift turning about is, at a point of the way, and which way it faces. */
export function aboutAt(about: About, x: number, y: number): [number, number, number] {
  const ux = Math.cos(about.dir);
  const uy = Math.sin(about.dir);
  const at = about.path.at((x - about.x) * ux + (y - about.y) * uy);
  const [ox, oy] = about.off ?? [0, 0];
  return [
    x + ux * at.ahead - uy * at.right + ox,
    y + uy * at.ahead + ux * at.right + oy,
    about.dir + at.face,
  ];
}
