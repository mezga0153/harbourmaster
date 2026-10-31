import { TICKS_PER_SECOND } from '../sim/types';
import { approach, ease } from './util/math';

// The water boats disturb: the wake each lays behind it as it goes, and the
// water stirred round a hull lying still or working its engine at low
// speed. Entities works out each boat's motion and hands it here; the
// water (water.ts) draws what wakes() and stirs() give it.

/** Most wakes drawn at once, and points along each. */
export const WAKE_MAX = 32;
export const WAKE_POINTS = 32;
/** Most boats whose hulls stir the water around them at once. */
export const STIR_MAX = 32;
/** Game seconds a patch of wake takes to settle. */
const WAKE_LIFE = 10;
/** Half the waterline length, as a share of the whole hull. */
const WATERLINE = 0.45;
/** How quickly a wake builds up and dies away, per game second. */
const WAKE_RISE = 0.45;
const WAKE_FALL = 0.3;
/** How quickly engine wash builds up and dies away, per game second. */
const WORK_RISE = 2;
const WORK_FALL = 0.6;

/** A wake barely shows while a boat is just getting under way. */
const wakeStrength = ease;

/** How much of a patch of wake is left after `age` game seconds: it holds
 * for a while, then dies away. */
function settle(age: number): number {
  const f = Math.min(1, age / WAKE_LIFE);
  return 1 - f * f;
}

interface Sample {
  x: number;
  z: number;
  /** Game time it was laid. */
  time: number;
  /** How strong the wake was there. */
  power: number;
}

/**
 * A wake laid in the water. Its first two points run along the hull from
 * the leading end to the trailing one and move with the boat; the rest stay
 * where the trailing end left them and settle with age. A wake whose boat
 * has gone, or turned to go the other way, keeps all its points where they
 * are and settles in place.
 */
export interface Track {
  beam: number;
  /** Waterline length, from the leading end to the trailing one. */
  length: number;
  /** Distance between laid points. */
  spacing: number;
  head: [Sample, Sample];
  samples: Sample[];
  /** Still moving with its boat: the head is as strong as the boat is going. */
  attached: boolean;
}

/**
 * The water a boat stirs where it lies, whatever its speed: ripples lapping
 * out from the hull, and while it works its engine at low speed (creeping
 * ahead or astern, crabbing in, swinging round) churned wash at the stern.
 */
export interface Stir {
  x: number;
  z: number;
  dir: number;
  /** Half the waterline length and half the beam. */
  half: number;
  beam: number;
  /** Engine wash, 0 to 1; negative going astern, when it is thrown forward. */
  work: number;
  /** All of it, 0 to 1: none once the boat lays a wake. */
  calm: number;
  /** Sets each boat's ripples apart. */
  phase: number;
}

/** A boat's track through the water, newest first, for the sea to churn up. */
export interface Wake {
  /** x, z, distance back from the leading end, strength. */
  points: [number, number, number, number][];
  beam: number;
  /** Waterline length: where the hull ends and the open wake begins. */
  length: number;
}

/** What a boat does to the water, kept with it from frame to frame. */
export interface Wash {
  /** The wake it is laying, and how hard it is going. */
  track?: Track;
  way?: number;
  /** Going ahead (the wake starts at the bow) or astern (at the stern). */
  ahead?: boolean;
  /** How hard it is working its engine at low speed, see Stir. */
  work?: number;
  stir?: Stir;
}

/** A hull's size and pace, as the sim's VESSELS have them. */
export interface Hull {
  length: number;
  beam: number;
  speed: number;
  turn: number;
}

export class Wakes {
  /** Wakes left behind by boats that have gone or turned about. */
  private loose: Track[] = [];
  /** Game time, in seconds, as of the last frame: wakes keep game time. */
  sim = 0;

  /**
   * A boat at x, z heading `dir` this frame disturbs the water: `way` is
   * how hard it is going (0 to 1 of its full speed), `along` how far it
   * moved along its heading since the last snapshot as a share of a full
   * speed snapshot's run (negative astern), `swing` how hard it is
   * turning (0 to 1), `dt` the game seconds since the last frame. The wake
   * builds up slowly as the boat gathers way and lingers a while once it
   * stops.
   */
  wash(
    w: Wash,
    id: number,
    hull: Hull,
    x: number,
    z: number,
    dir: number,
    way: number,
    along: number,
    swing: number,
    dt: number,
  ): void {
    const rate = way > (w.way ?? 0) ? WAKE_RISE : WAKE_FALL;
    w.way = approach(w.way ?? 0, way, dt, rate);
    // The wake starts at whichever end is leading: the bow, or the stern
    // while going astern. Only a clear move the other way counts, not a
    // pause or a nudge sideways. The old wake is left to settle where it
    // lies and a new one starts from the other end.
    const ahead = along > 0.03 ? true : along < -0.03 ? false : (w.ahead ?? true);
    if (ahead !== (w.ahead ?? true) && w.track) {
      this.letGo(w.track);
      w.track = undefined;
      // It has only just started back the other way.
      w.way = Math.min(w.way, way);
    }
    w.ahead = ahead;
    // From the stem where it meets the water, a little behind the tip of
    // the deck, along the hull to the other end, then on along the way the
    // trailing end came.
    const half = (ahead ? 1 : -1) * hull.length * WATERLINE;
    const power = wakeStrength(w.way);
    const sim = this.sim;
    const lead: Sample = {
      x: x + Math.cos(dir) * half,
      z: z + Math.sin(dir) * half,
      time: sim,
      power,
    };
    const tail: Sample = {
      x: x - Math.cos(dir) * half,
      z: z - Math.sin(dir) * half,
      time: sim,
      power,
    };
    // Working the engine at low speed: creeping or crabbing along, or
    // swinging round, ahead or astern. Once it has way enough to lay a
    // wake, the wake takes over and the water round the hull is left be.
    const calm = Math.max(0, 1 - power * 3);
    const busy = Math.min(1, Math.max(swing, way * 3));
    const wr = busy > (w.work ?? 0) ? WORK_RISE : WORK_FALL;
    w.work = approach(w.work ?? 0, busy, dt, wr);
    w.stir = {
      x,
      z,
      dir,
      half: hull.length * WATERLINE,
      beam: hull.beam / 2,
      work: ahead ? w.work : -w.work,
      calm,
      phase: (id * 2.39) % 6.28,
    };
    const track = (w.track ??= {
      beam: hull.beam,
      length: hull.length * WATERLINE * 2,
      // Enough points to reach back as far as the wake lasts at full speed.
      spacing: Math.max(0.3, (hull.speed * TICKS_PER_SECOND * WAKE_LIFE) / (WAKE_POINTS - 4)),
      head: [lead, tail],
      samples: [],
      attached: true,
    });
    track.head = [lead, tail];
    const last = track.samples[0];
    if (last ? Math.hypot(tail.x - last.x, tail.z - last.z) > track.spacing : power > 0.01) {
      track.samples.unshift(tail);
      if (track.samples.length > WAKE_POINTS - 2) track.samples.pop();
    }
  }

  /** Leave a wake to settle where it lies. */
  letGo(track: Track): void {
    track.attached = false;
    for (const p of track.head) p.time = this.sim;
    this.loose.push(track);
  }

  /** Wakes still showing, strongest first, for the water to draw: those the boats are laying, and those let go. */
  wakes(attached: Iterable<Track>): Wake[] {
    const out: { wake: Wake; strength: number }[] = [];
    const draw = (track: Track): boolean => {
      while (track.samples.length && this.sim - track.samples.at(-1)!.time > WAKE_LIFE) {
        track.samples.pop();
      }
      const points: Wake['points'] = [];
      let s = 0;
      let strength = 0;
      for (const p of [...track.head, ...track.samples]) {
        const prev = points.at(-1);
        if (prev) s += Math.hypot(p.x - prev[0], p.z - prev[1]);
        const head = track.attached && points.length < 2;
        const a = p.power * (head ? 1 : settle(this.sim - p.time));
        points.push([p.x, p.z, s, a]);
        strength += a;
      }
      if (strength < 0.02) return false;
      out.push({ wake: { points, beam: track.beam, length: track.length }, strength });
      return true;
    };
    for (const track of attached) draw(track);
    this.loose = this.loose.filter(draw);
    return out
      .sort((a, b) => b.strength - a.strength)
      .slice(0, WAKE_MAX)
      .map((w) => w.wake);
  }

  /** The boats stirring the water around them, as many as the sea draws. */
  stirs(all: Iterable<Stir>): Stir[] {
    return [...all].slice(0, STIR_MAX);
  }
}
