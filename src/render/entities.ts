import { Group, Vector3, type Object3D } from 'three';
import { VESSELS } from '../sim/balance';
import type { EntityView, HandAt } from '../protocol';
import type { GameMap } from '../sim/map';
import { isMachineKind } from '../sim/machines';
import { TICKS_PER_SECOND } from '../sim/types';
import {
  alertMarker,
  boat,
  FORKS_EMPTY,
  FORKS_LOADED,
  CARRY_LOW,
  forklift,
  headingOf,
  person,
  paintLoad,
  reachTo,
  showDeck,
  showLoad,
  stacker,
  STACKER_REACH,
  tractor,
  TRAILER_AT,
  truck,
  type Model,
} from './models';
import { pose } from './people';
import { surfaceY } from './terrain';
import type { Trailer } from './vehicles';

const SNAPSHOT_MS = 100;

interface Entry {
  view: EntityView;
  model: Model;
  alert: Object3D | null;
  /** Boats: the wake they are laying, how hard they are going and how far they lean. */
  track?: Track;
  way?: number;
  /** Going ahead (the wake starts at the bow) or astern (at the stern). */
  ahead?: boolean;
  heel?: number;
  /** How hard it is working its engine at low speed, see Stir. */
  work?: number;
  stir?: Stir;
  /** Articulated trucks: where each trailer's axles and its fifth wheel were last frame. */
  links?: { axle?: [number, number]; hitch?: [number, number] }[];
  /** Forklifts' forks, or a dockhand's hands: how far down to the ground, 0 to 1. */
  down?: number;
  /** Forklifts turning about: where from, which way to, see turnAbout. */
  about?: About;
  /** Forklifts: how far off their way they were when they turned off it part way round. */
  slip?: { x: number; y: number; yaw: number; left: number };
  /** Stackers and tractors: how they stood last frame, and the container they are handing over. */
  pose?: Pose;
  hand?: Hand;
}

interface About {
  x: number;
  y: number;
  dir: number;
  path: TurnAbout;
  /** The sim tick of the snapshot it started in, so it starts once. */
  tick: number;
  done: boolean;
}

/** Furthest a trailer folds against its tractor, either way: 80°. */
const FOLD = (80 * Math.PI) / 180;
/** How quickly a trailer settles straight behind a truck standing still, per game second. */
const SETTLE = 3;

/** Where a machine stands and which way it faces; for a stacker, how high it holds a container. */
interface Pose {
  x: number;
  z: number;
  dir: number;
  h: number;
}

/** A reach stacker or tractor taking a container off where it is, or setting one down. */
interface Hand {
  stage: 'pick' | 'drop';
  /** How far through it was when first shown, and how it stood. */
  start?: number;
  from: Pose;
  /** Which way it faces to work the container. */
  face?: number;
  /** A tractor under a yard gantry: its container, on the map, which it turns about. */
  pivot?: { x: number; z: number };
  /** Game time the container changed hands, as it goes back to driving. */
  done?: number;
  /**
   * Where it works it, once known: kept for the whole of it, so it does not
   * jump when another load comes or goes there meanwhile.
   */
  goal?: Pose;
}

/** Furthest a forklift drives up to a pallet, from where it stops for it. */
const REACH_MOST = 0.8;
/** Game seconds a stacker or tractor takes to go back to driving once it has handed a container over. */
const HAND_SETTLE = 0.5;
/** How far a stacker lifts a container clear of the others as it moves it. */
const CLEAR = 0.1;

const ease = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/** Straight across from one pose to another, turning as it goes, `a` of the way. */
function slide(from: Pose, to: Pose, a: number): Omit<Pose, 'h'> {
  return {
    x: from.x + (to.x - from.x) * a,
    z: from.z + (to.z - from.z) * a,
    dir: lerpAngle(from.dir, to.dir, a),
  };
}

/**
 * Driven from one pose to another, `a` (0 to 1) of the way, as a machine
 * would: it turns to face the way it is going (or straight away from it, to
 * back there), drives straight there, then turns as it is to stand; never
 * sliding sideways. A short way it just edges across.
 */
function driveTo(from: Pose, to: Pose, a: number): Omit<Pose, 'h'> {
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

/** Most wakes drawn at once, and points along each. */
export const WAKE_MAX = 32;
export const WAKE_POINTS = 32;
/** Game seconds a patch of wake takes to settle. */
const WAKE_LIFE = 10;
/** Half the waterline length, as a share of the whole hull. */
const WATERLINE = 0.45;
/** How quickly a wake builds up and dies away, per game second. */
const WAKE_RISE = 0.45;
const WAKE_FALL = 0.3;

/**
 * How far through picking a load up or setting it down the forks, or a
 * dockhand's hands, are down on the ground; and how quickly they go down
 * and come back up, per game second.
 */
const DOWN_BY = 0.5;
const DOWN_RATE = 4;
const UP_RATE = 3;

/** A wake barely shows while a boat is just getting under way. */
function wakeStrength(way: number): number {
  const w = Math.min(1, Math.max(0, way));
  return w * w * (3 - 2 * w);
}

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
interface Track {
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

/** Most boats whose hulls stir the water around them at once. */
export const STIR_MAX = 32;
/** How quickly engine wash builds up and dies away, per game second. */
const WORK_RISE = 2;
const WORK_FALL = 0.6;

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

/** Forklifts: how far to the right of the middle of the way they keep. */
const FORK_KEEP = 0.16;
/** How far in front of a dockhand the crate they pick up or set down is. */
const HAND_REACH = 0.16;
/** How far ahead of a forklift's middle the pallet on its forks sits. */
const FORK_REACH = 0.3;
/** Forklifts turning about: the tighter of the two arcs they go round. */
const TIGHT_ARC = 0.15;
/** How far off the way it is going a forklift has to face to turn about. */
const TURN_FROM = (Math.PI * 2) / 3;
/**
 * How far it drives on straight after, catching up with where it would be
 * had it not had to go round: it goes not much faster than usual.
 */
const RUN_OUT = 0.8;

/** Game seconds a forklift takes to ease onto a way it turned onto part way round. */
const SLIP_TIME = 0.3;

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

/** Ships, trucks and people, interpolated between sim snapshots. */
export class Entities {
  readonly group = new Group();
  private entries = new Map<number, Entry>();
  private prev = new Map<number, EntityView>();
  private snapTime = 0;
  /** Sim ticks between the last two snapshots, more at higher game speeds. */
  private snapTicks = 1;
  private lastTick = -1;
  private prevTick = 0;
  /** Game time, in seconds, as of the last frame. */
  private sim = 0;
  /** Wakes left behind by boats that have gone or turned about. */
  private loose: Track[] = [];
  /**
   * Where a container lies on a crane's stack or in a yard, for a stacker
   * or tractor to hand it over there: its base, and which way its length
   * runs as a heading. Set by the renderer.
   */
  containerAt?: (at: HandAt, out: Vector3) => number | null;
  private slotAt = new Vector3();

  constructor(private map: GameMap) {}

  push(views: EntityView[], now: number, tick: number): void {
    this.prev = new Map([...this.entries].map(([id, e]) => [id, e.view]));
    this.snapTime = now;
    this.snapTicks = this.lastTick < 0 ? 1 : Math.max(1, tick - this.lastTick);
    this.prevTick = this.lastTick < 0 ? tick : this.lastTick;
    this.lastTick = tick;
    const seen = new Set<number>();
    for (const v of views) {
      seen.add(v.id);
      let e = this.entries.get(v.id);
      if (!e) {
        const model =
          v.kind === 'dockhand'
            ? person(v.id)
            : v.kind === 'forklift'
              ? forklift()
              : v.kind === 'stacker'
                ? stacker()
                : v.kind === 'tractor'
                  ? tractor()
                  : v.kind === 'boat'
                    ? boat(v.variant, v.vessel, v.id)
                    : truck(v.variant, v.capacity, v.boxes, v.id);
        this.group.add(model.root);
        // Only machines show a warning marker; boats at anchor are normal.
        const alert = isMachineKind(v.kind) ? alertMarker() : null;
        if (alert) {
          alert.visible = false;
          this.group.add(alert);
        }
        e = { view: v, model, alert };
        if (v.kind === 'boat') {
          e.way = 0;
          e.heel = 0;
          model.root.rotation.order = 'YXZ';
        }
        this.entries.set(v.id, e);
      }
      e.view = v;
      if (v.deck) showDeck(e.model, v.deck, v.looks ?? []);
      else {
        showLoad(e.model, v.load);
        if (v.looks) paintLoad(e.model, v.looks);
      }
    }
    for (const [id, e] of this.entries) {
      if (!seen.has(id)) {
        this.group.remove(e.model.root);
        if (e.alert) this.group.remove(e.alert);
        if (e.track) this.letGo(e.track);
        this.entries.delete(id);
      }
    }
  }

  update(now: number, time: number): void {
    const t = Math.min(1, (now - this.snapTime) / SNAPSHOT_MS);
    // Wakes keep game time: they hold still while paused and settle over
    // the same stretch of water whatever the game speed.
    const sim = (this.prevTick + (this.lastTick - this.prevTick) * t) / TICKS_PER_SECOND;
    const dt = Math.max(0, Math.min(1, sim - this.sim));
    this.sim = sim;
    for (const [id, e] of this.entries) {
      const cur = e.view;
      const prev = this.prev.get(id) ?? cur;
      const x = prev.x + (cur.x - prev.x) * t;
      const y = prev.y + (cur.y - prev.y) * t;
      const dir = lerpAngle(prev.dir, cur.dir, t);
      const root = e.model.root;
      root.rotation.y = -dir;

      if (cur.kind === 'boat') {
        // Way on, from how far it moved since the last snapshot; boats lean
        // out of a turn, lift their bow a touch under way and leave a wake.
        const hull = VESSELS[(cur.vessel ?? 'smack') as keyof typeof VESSELS];
        const way = Math.min(
          1,
          Math.hypot(cur.x - prev.x, cur.y - prev.y) / (hull.speed * this.snapTicks),
        );
        const turn = lerpAngle(prev.dir, cur.dir, 1) - prev.dir;
        const lean = Math.max(-0.12, Math.min(0.12, -turn * 3 * way));
        e.heel = (e.heel ?? 0) + (lean - (e.heel ?? 0)) * 0.08;
        root.position.set(x, Math.sin(time * 1.6 + id) * 0.025, y);
        root.rotation.x = e.heel + Math.sin(time * 0.9 + id * 2) * 0.02;
        root.rotation.z = Math.sin(time * 1.1 + id) * 0.02 + way * 0.025;
        // The wake builds up slowly as the boat gathers way and lingers a
        // while once it stops.
        const rate = way > (e.way ?? 0) ? WAKE_RISE : WAKE_FALL;
        e.way = (e.way ?? 0) + (way - (e.way ?? 0)) * (1 - Math.exp(-dt * rate));
        // The wake starts at whichever end is leading: the bow, or the
        // stern while going astern. Only a clear move the other way counts,
        // not a pause or a nudge sideways. The old wake is left to settle
        // where it lies and a new one starts from the other end.
        const along =
          ((cur.x - prev.x) * Math.cos(dir) + (cur.y - prev.y) * Math.sin(dir)) /
          (hull.speed * this.snapTicks);
        const ahead = along > 0.03 ? true : along < -0.03 ? false : (e.ahead ?? true);
        if (ahead !== (e.ahead ?? true) && e.track) {
          this.letGo(e.track);
          e.track = undefined;
          // It has only just started back the other way.
          e.way = Math.min(e.way, way);
        }
        e.ahead = ahead;
        // From the stem where it meets the water, a little behind the tip of
        // the deck, along the hull to the other end, then on along the way
        // the trailing end came.
        const half = (ahead ? 1 : -1) * hull.length * WATERLINE;
        const power = wakeStrength(e.way);
        const lead: Sample = {
          x: x + Math.cos(dir) * half,
          z: y + Math.sin(dir) * half,
          time: sim,
          power,
        };
        const tail: Sample = {
          x: x - Math.cos(dir) * half,
          z: y - Math.sin(dir) * half,
          time: sim,
          power,
        };
        // Working the engine at low speed: creeping or crabbing along, or
        // swinging round, ahead or astern. Once it has way enough to lay a
        // wake, the wake takes over and the water round the hull is left be.
        const calm = Math.max(0, 1 - power * 3);
        const swing = Math.min(1, Math.abs(turn) / (hull.turn * this.snapTicks));
        const busy = Math.min(1, Math.max(swing, way * 3));
        const wr = busy > (e.work ?? 0) ? WORK_RISE : WORK_FALL;
        e.work = (e.work ?? 0) + (busy - (e.work ?? 0)) * (1 - Math.exp(-dt * wr));
        e.stir = {
          x,
          z: y,
          dir,
          half: hull.length * WATERLINE,
          beam: hull.beam / 2,
          work: ahead ? e.work : -e.work,
          calm,
          phase: (id * 2.39) % 6.28,
        };
        const track = (e.track ??= {
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
      } else if (
        cur.kind === 'stacker' ||
        cur.kind === 'tractor' ||
        ((cur.kind === 'forklift' || cur.kind === 'dockhand') && (cur.handAt || e.hand))
      ) {
        // A forklift drives up to the crates it takes or sets down like
        // this too, and a dockhand walks up to the crate.
        this.handle(e, x, y, dir, t);
      } else if (cur.kind === 'dockhand' || isMachineKind(cur.kind)) {
        // Keep to the right of the tile, so people going opposite ways pass.
        const keep = cur.kind === 'forklift' ? FORK_KEEP : 0.2;
        const going = e.about && !e.about.done ? e.about : null;
        const about = cur.kind === 'forklift' ? this.turningAbout(e, prev, x, y) : null;
        // Once round, it faces the way it is going, not part way between.
        const way = about ? about.dir : dir;
        let rx = x - Math.sin(way) * keep;
        let ry = y + Math.cos(way) * keep;
        let yaw = way;
        if (about && !about.done) {
          [rx, ry, yaw] = aboutAt(about, x, y);
        } else if (going) {
          // It turned off its way before it was round: it eases from where
          // it had got to onto its own side of the new way.
          const [ax, ay, ayaw] = aboutAt(going, x, y);
          e.slip = { x: ax - rx, y: ay - ry, yaw: lerpAngle(yaw, ayaw, 1) - yaw, left: 1 };
        }
        if (e.slip) {
          const f = e.slip.left * e.slip.left;
          rx += e.slip.x * f;
          ry += e.slip.y * f;
          yaw += e.slip.yaw * f;
          e.slip.left -= dt / SLIP_TIME;
          if (e.slip.left <= 0) e.slip = undefined;
        }
        root.rotation.y = -yaw;
        root.position.set(rx, surfaceY(this.map, rx, ry), ry);
        // Where it is, for it to drive up to a pallet from when it gets to one.
        e.pose = { x: rx, z: ry, dir: yaw, h: 0 };
      } else {
        root.position.set(x, surfaceY(this.map, x, y), y);
        if (e.model.trailer) this.trail(e, e.model.trailer, x, y, dir, cur.moving, dt);
      }
      if (cur.kind === 'forklift') {
        const down = this.lower(e, prev, t, dt);
        e.model.forks!.position.y = (cur.load > 0 ? FORKS_LOADED : FORKS_EMPTY) * (1 - down);
      }
      if (cur.kind === 'dockhand') {
        const down = this.lower(e, prev, t, dt);
        pose(e.model, cur.moving, cur.load > 0, time * 12 + id, down);
      }
      if (e.alert) {
        e.alert.visible = cur.alert;
        e.alert.position.set(x, root.position.y + 0.75 + Math.sin(time * 4) * 0.05, y);
      }
    }
  }

  /**
   * Swing an articulated truck's trailer behind its tractor, at x, y heading
   * `dir`. The trailer turns about its axles towards wherever the fifth
   * wheel has gone, so going ahead it follows the tractor round a corner,
   * cutting inside it, and lines up behind it again on the straight. Pushed
   * back it would only fold further, so then it is eased straight, as a
   * driver backing up would keep it; and it settles straight behind once
   * the truck stands still, as the sim has it parked or loading.
   */
  private trail(
    e: Entry,
    t: Trailer,
    x: number,
    y: number,
    dir: number,
    moving: boolean,
    dt: number,
    k = 0,
  ): void {
    const link = ((e.links ??= [])[k] ??= {});
    const fx = Math.cos(dir);
    const fy = Math.sin(dir);
    const hx = x + fx * t.hitch;
    const hy = y + fy * t.hitch;
    const [px, py] = link.hitch ?? [hx, hy];
    const dx = hx - px;
    const dy = hy - py;
    // Just come into view, or jumped a long way (the tab was in the
    // background): straight behind.
    let bend = 0;
    if (link.axle && Math.hypot(dx, dy) < 2) {
      const [ax, ay] = link.axle;
      const along = dx * fx + dy * fy;
      bend =
        along >= 0
          ? wrapAngle(dir - Math.atan2(hy - ay, hx - ax))
          : wrapAngle(dir - Math.atan2(py - ay, px - ax)) * Math.exp(along / t.length);
      if (!moving) bend *= Math.exp(-dt * SETTLE);
      bend = Math.max(-FOLD, Math.min(FOLD, bend));
    }
    const a = dir - bend;
    link.axle = [hx - Math.cos(a) * t.length, hy - Math.sin(a) * t.length];
    link.hitch = [hx, hy];
    t.root.rotation.y = bend;
    // A trailer coupled behind swings the same way behind this one, from
    // its kingpin, as this one does behind the tractor.
    if (t.next) this.trail(e, t.next, hx, hy, a, moving, dt, k + 1);
  }

  /**
   * A forklift setting off back the way it faces turns about (see
   * turnAbout) until it has gone far enough along its way, or turns off it;
   * returns where it started and which way it is going, or null. One that
   * is round before the next snapshot comes is returned until then, done.
   */
  private turningAbout(e: Entry, prev: EntityView, x: number, y: number): About | null {
    const cur = e.view;
    const face = lerpAngle(cur.dir, prev.dir, 1) - cur.dir;
    const moved = cur.x !== prev.x || cur.y !== prev.y;
    if (Math.abs(face) > TURN_FROM && moved && e.about?.tick !== this.lastTick) {
      const path = turnAbout(face);
      e.about = { x: prev.x, y: prev.y, dir: cur.dir, path, tick: this.lastTick, done: false };
    }
    const about = e.about;
    if (!about) return null;
    if (about.done) return about.tick === this.lastTick ? about : null;
    const along = (x - about.x) * Math.cos(about.dir) + (y - about.y) * Math.sin(about.dir);
    // Round, or turning off its way before it is: it goes on as usual.
    if (along >= about.path.reach || Math.abs(lerpAngle(about.dir, cur.dir, 1) - about.dir) > 0.1) {
      about.done = true;
    }
    return about;
  }

  /**
   * Forks, or a dockhand's hands, go down to the ground over the first part
   * of picking a load up or setting it down, so they are there by the time
   * the load leaves where it was and shows on them, or leaves them and
   * shows where it is set down; then they come back up. Returns how far
   * down they are, 0 to 1.
   */
  private lower(e: Entry, prev: EntityView, t: number, dt: number): number {
    const cur = e.view;
    let goal = 0;
    if (cur.handling !== undefined) {
      const from = prev.handling;
      const p =
        from !== undefined && from <= cur.handling
          ? from + (cur.handling - from) * t
          : cur.handling;
      const f = Math.min(1, p / DOWN_BY);
      goal = f * f * (3 - 2 * f);
    }
    const was = e.down ?? 0;
    const step = dt * (goal > was ? DOWN_RATE : UP_RATE);
    e.down = was + Math.max(-step, Math.min(step, goal - was));
    return e.down;
  }

  /**
   * A reach stacker or terminal tractor drives keeping to the right of the
   * tile. At work it pulls up to the container it takes or sets down: a
   * stacker side on to it, its spreader brought down onto it by the end;
   * a tractor with its trailer under it, or under a yard gantry turned to
   * stand along the lane. It is there as the container changes hands,
   * then goes back to driving.
   */
  private handle(e: Entry, x: number, y: number, dir: number, t: number): void {
    const v = e.view;
    const keep = v.kind === 'forklift' ? FORK_KEEP : 0.2;
    const drive: Pose = {
      x: x - Math.sin(dir) * keep,
      z: y + Math.cos(dir) * keep,
      dir,
      h: CARRY_LOW,
    };
    let pose = drive;
    if (v.handStage) {
      if (e.hand?.stage !== v.handStage || e.hand.done !== undefined) {
        e.hand = { stage: v.handStage, from: e.pose ?? drive };
      }
      const w = e.hand;
      // Ahead of the last snapshot as the game is, so it gets there just as
      // the container changes hands.
      const now = Math.min(
        1,
        (v.handPhase ?? 0) + (t * this.snapTicks) / Math.max(1, v.handTicks ?? 1),
      );
      // Seen part way through, at speed, it does the rest in what is left.
      w.start ??= now;
      const phase = w.start < 1 ? Math.max(0, (now - w.start) / (1 - w.start)) : 1;
      w.goal ??= this.workPose(v, w, drive) ?? undefined;
      // A forklift the game has too far from its pallet to drive up to it
      // works it from where it is. It is shown a snapshot behind the game,
      // so that is measured from where the game has it, not where it shows.
      const far = w.goal && Math.hypot(w.goal.x - v.x, w.goal.z - v.y) > REACH_MOST;
      if (w.goal && far && (v.kind === 'forklift' || v.kind === 'dockhand')) {
        w.goal = { ...w.from, dir: w.goal.dir, h: w.goal.h };
      }
      const goal = w.goal ?? { ...drive, h: 0 };
      // Under a gantry, a tractor is lined up before the spreader comes down;
      // otherwise it drives up to where it works it.
      const a = phase / (w.pivot ? 0.08 : 0.4);
      const clear = Math.max(w.from.h, goal.h) + CLEAR;
      const at = w.pivot ? slide(w.from, goal, ease(a)) : driveTo(w.from, goal, a);
      pose = {
        ...at,
        h:
          phase < 0.4
            ? w.from.h + (clear - w.from.h) * ease(phase / 0.4)
            : clear + (goal.h - clear) * ease((phase - 0.4) / 0.3),
      };
    } else if (e.hand) {
      const w = e.hand;
      if (w.done === undefined) {
        w.done = this.sim;
        w.from = e.pose ?? drive;
      }
      const s = (this.sim - w.done) / HAND_SETTLE;
      if (s >= 1) e.hand = undefined;
      else {
        const a = ease(s);
        pose = {
          ...driveTo(w.from, drive, s),
          h: w.from.h + (drive.h - w.from.h) * a + CLEAR * Math.sin(Math.PI * s),
        };
      }
    }
    e.pose = pose;
    const root = e.model.root;
    root.position.set(pose.x, surfaceY(this.map, pose.x, pose.z), pose.z);
    root.rotation.y = -pose.dir;
    if (e.model.reach) reachTo(e.model.reach, pose.h);
  }

  /** Where a stacker or tractor stands to hand a container over, or null if it is not known. */
  private workPose(v: EntityView, w: Hand, drive: Pose): Pose | null {
    const at = v.handAt;
    if (!at) return null;
    const stacker = v.kind === 'stacker';
    // How far ahead of its middle it holds a load: a forklift's on its forks.
    const hold = stacker
      ? STACKER_REACH
      : v.kind === 'forklift'
        ? FORK_REACH
        : v.kind === 'dockhand'
          ? HAND_REACH
          : TRAILER_AT;
    const ahead = (face: number, d: number) => [Math.cos(face) * d, Math.sin(face) * d];
    if (at.along !== undefined) {
      // Turned about its container, which the gantry's spreader is over.
      const [dx, dz] = ahead(w.from.dir, hold);
      w.pivot ??= { x: w.from.x + dx, z: w.from.z + dz };
      w.face ??= Math.cos(at.along - w.from.dir) >= 0 ? at.along : at.along + Math.PI;
      const [fx, fz] = ahead(w.face, hold);
      return { x: w.pivot.x - fx, z: w.pivot.z - fz, dir: w.face, h: CARRY_LOW };
    }
    const p = this.slotAt;
    const heading = this.handSlot(at, p);
    if (heading === null) return null;
    // A stacker takes a container side on; a tractor's trailer lies along
    // it; a forklift's forks go into a pallet in storage the way it lies,
    // and otherwise it, or a dockhand, comes straight up to the crate.
    const straight = (v.kind === 'dockhand' || v.kind === 'forklift') && at.place === undefined;
    const lie = stacker
      ? heading + Math.PI / 2
      : straight
        ? Math.atan2(p.z - drive.z, p.x - drive.x)
        : heading;
    // From whichever side is nearer, sooner than turn right round.
    const cost = (face: number) => {
      const [dx, dz] = ahead(face, hold);
      return (
        Math.hypot(p.x - dx - drive.x, p.z - dz - drive.z) + 0.4 * (1 - Math.cos(face - drive.dir))
      );
    };
    w.face ??= straight || cost(lie) <= cost(lie + Math.PI) ? lie : lie + Math.PI;
    const [dx, dz] = ahead(w.face, hold);
    const x = p.x - dx;
    const z = p.z - dz;
    return { x, z, dir: w.face, h: p.y - surfaceY(this.map, x, z) };
  }

  /** Where a container to hand over lies, as containerAt; on a truck, its slot there. */
  private handSlot(at: HandAt, out: Vector3): number | null {
    if (at.truck === undefined) return this.containerAt?.(at, out) ?? null;
    const slot = this.entries.get(at.truck)?.model.crates[at.slot ?? 0];
    if (!slot) return null;
    slot.getWorldPosition(out);
    return headingOf(slot);
  }

  /** Leave a wake to settle where it lies. */
  private letGo(track: Track): void {
    track.attached = false;
    for (const p of track.head) p.time = this.sim;
    this.loose.push(track);
  }

  /** Wakes still showing, strongest first, for the water to draw. */
  wakes(): Wake[] {
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
    for (const e of this.entries.values()) if (e.track) draw(e.track);
    this.loose = this.loose.filter(draw);
    return out
      .sort((a, b) => b.strength - a.strength)
      .slice(0, WAKE_MAX)
      .map((w) => w.wake);
  }

  /** Every boat stirring the water around it, for the sea to draw. */
  stirs(): Stir[] {
    const out: Stir[] = [];
    for (const e of this.entries.values()) if (e.stir) out.push(e.stir);
    return out.slice(0, STIR_MAX);
  }

  /** Current world position, for the selection ring and info panel. */
  positionOf(id: number, out: Vector3): Vector3 | null {
    const e = this.entries.get(id);
    return e ? out.copy(e.model.root.position) : null;
  }

  /** Whether a truck's, tractor's or ship's container slot `k` shows a container. */
  slotShown(id: number, k: number): boolean {
    return !!this.entries.get(id)?.model.crates[k]?.visible;
  }

  /** The crate or container in slot `k` of a boat or vehicle, shown or not. */
  slotObject(id: number, k: number): Object3D | undefined {
    return this.entries.get(id)?.model.crates[k];
  }

  /** Where a truck's container slot `k` is in the world, or null. */
  slotPosition(id: number, k: number, out: Vector3): Vector3 | null {
    const slot = this.entries.get(id)?.model.crates[k];
    return slot ? slot.getWorldPosition(out) : null;
  }

  /** Which way a truck's, tractor's or ship's container slot `k` lies, as a turn about y. */
  slotTurn(id: number, k: number): number | null {
    const slot = this.entries.get(id)?.model.crates[k];
    return slot ? turnOf(slot) : null;
  }

  worldPositions(): { view: EntityView; pos: Vector3 }[] {
    return [...this.entries.values()].map((e) => ({ view: e.view, pos: e.model.root.position }));
  }
}

/** Where a forklift turning about is, at a point of the way, and which way it faces. */
function aboutAt(about: About, x: number, y: number): [number, number, number] {
  const ux = Math.cos(about.dir);
  const uy = Math.sin(about.dir);
  const at = about.path.at((x - about.x) * ux + (y - about.y) * uy);
  return [
    x + ux * at.ahead - uy * at.right,
    y + uy * at.ahead + ux * at.right,
    about.dir + at.face,
  ];
}

function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

/** An angle brought into -π to π. */
function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Which way an object's +x points in the world, as a turn about y. */
export function turnOf(o: Object3D): number {
  o.updateWorldMatrix(true, false);
  const e = o.matrixWorld.elements;
  return Math.atan2(-e[2], e[0]);
}
