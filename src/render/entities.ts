import { Box3, Group, Vector3, type Object3D } from 'three';
import { VESSELS, WALK_SPEED } from '../sim/balance';
import type { EntityView, HandAt } from '../protocol';
import type { GameMap } from '../sim/map';
import { isMachineKind } from '../sim/machines';
import { Build, TICKS_PER_SECOND } from '../sim/types';
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
  setCrateIcon,
  showDeck,
  showLoad,
  stacker,
  STACKER_REACH,
  tractor,
  TRAILER_AT,
  truck,
  type Model,
} from './models';
import { fidget, fidgetAt, pose, sit } from './people';
import { surfaceY } from './terrain';
import type { Trailer } from './vehicles';

const SNAPSHOT_MS = 100;

interface Entry {
  view: EntityView;
  model: Model;
  alert: Object3D | null;
  /** Trucks: how far the body reaches each way from its middle, as it faces +x. */
  size?: Box3;
  /** Dockhands: the truck they are going round, and along which side of it. */
  round?: { truck: number; side: number };
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
  /** Boats and crate trucks: the order their crates go on, see slotOf; and where that was worked out. */
  order?: number[];
  orderAt?: 'bay' | 'quay';
  /** Dockhands: walking up to a load they handle, or back onto their way. */
  stepping?: boolean;
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
  /**
   * A dockhand kept on the quay with the crate out over the water, on a
   * boat: how much further on it is than they reach standing.
   */
  over?: number;
  /** Stood where it must be, as at a truck bay: not moved clear of the truck. */
  fixed?: boolean;
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
  /** Dockhands: how much of it they spend walking up to it. */
  walk?: number;
  /** A dockhand: where the crate they set down goes, or the one they take up lay. */
  place?: Vector3;
  /** Dockhands: how far through it they are. */
  at?: number;
  /** Setting down a crate just taken up: where it lay. */
  taken?: Vector3;
  /** Taking a crate off a boat or truck: in their hands as it changes hands, never on its way. */
  early?: boolean;
  /** Dockhands: corners of a truck they walk round on the way. */
  via?: { x: number; z: number }[];
}

/** Furthest a forklift drives up to a pallet, from where it stops for it. */
const REACH_MOST = 0.8;
/** Furthest a dockhand walks up to a crate, from where they stop for it. */
const WALK_MOST = 1.6;
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
 * Walked from one pose to another, `a` (0 to 1) of the way: turning to the
 * way there as they set off, and to stand as they are as they get there.
 */
function walkTo(from: Pose, to: Pose, a: number): Omit<Pose, 'h'> {
  const c = Math.min(1, Math.max(0, a));
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
function length(points: { x: number; z: number }[]): number {
  let d = 0;
  for (let k = 1; k < points.length; k++) {
    d += Math.hypot(points[k].x - points[k - 1].x, points[k].z - points[k - 1].z);
  }
  return d;
}

/** As walkTo, by way of the points `via`, round whatever is in the way. */
function walkVia(
  from: Pose,
  via: { x: number; z: number }[],
  to: Pose,
  a: number,
): Omit<Pose, 'h'> {
  if (via.length === 0) return walkTo(from, to, a);
  const c = Math.min(1, Math.max(0, a));
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
/** Fastest a dockhand closes on where they should be, tiles per game second: a brisk walk. */
const CATCH_UP = WALK_SPEED * TICKS_PER_SECOND * 1.5;
/** What a dockhand with nothing to do is doing, as the game has it. */
const IDLE = 'Waiting for work';
/** How near another dockhand standing about is for them to chat. */
const CHAT_NEAR = 0.7;
/** How far apart dockhands standing about keep. */
const ROOM = 0.36;
/** How quickly a dockhand turns to the way they step, per game second. */
const TURN_RATE = 12;
/** How far in front of a dockhand the crate they pick up or set down is. */
const HAND_REACH = 0.16;
/** How far back from the edge of the quay a dockhand stands, toes to the edge. */
const TOES = 0.05;
/** Furthest a dockhand leans out over the edge to a crate. */
const LEAN_MOST = 0.3;
/** How far in from the back of a truck bay people walk across it, out of the truck's way. */
const BACK_LANE = 0.18;
/** How much further back than a dockhand a forklift stands at a truck bay, for its forks. */
const FORK_BACK = 0.2;
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
  /** Which way the camera is from what it looks at, as a heading on the ground: who dockhands wave to. */
  viewer?: number;
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
                    ? boat(v.variant, v.vessel, v.id, v.catch === 'lobster')
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
        this.reorder(e);
        if (e.order) {
          const shown = new Set(e.order.slice(0, v.load));
          e.model.crates.forEach((c, k) => (c.visible = shown.has(k)));
        } else showLoad(e.model, v.load);
        if (v.looks) paintLoad(e.model, v.looks);
        // Each crate painted with what it holds, in the order they go on.
        v.cargo?.forEach((c, k) => setCrateIcon(e.model.crates[e.order?.[k] ?? k], c));
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
        this.handle(e, x, y, dir, t, dt);
      } else if (cur.kind === 'dockhand' || isMachineKind(cur.kind)) {
        // Keep to the right of the tile, so people going opposite ways pass;
        // sat on a bench, just where their seat is.
        const seated = cur.sitting && !cur.moving;
        const keep = cur.kind === 'forklift' ? FORK_KEEP : seated ? 0 : 0.2;
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
        if (cur.kind === 'dockhand') {
          // Across a truck bay along its back, out of the truck's way.
          if (!seated) [rx, ry] = this.byBack(rx, ry);
          // Standing about, they keep a step apart rather than stand in each other.
          if (!cur.moving && !seated) [rx, ry] = this.spread(e, rx, ry);
          // Onto the other side of the way as they turn about, at a walk.
          const to = this.catchUp(e, rx, ry, yaw, dt);
          [rx, ry, yaw] = [to.x, to.z, Math.hypot(to.x - rx, to.z - ry) > 0.03 ? to.dir : yaw];
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
        const stepping = !!e.hand && !!e.stepping;
        const down = this.lower(e, prev, t, dt, stepping);
        const goal = e.hand?.goal;
        const walking = cur.moving || stepping;
        if (cur.sitting && !cur.moving) sit(e.model, time * 12 + id);
        else pose(e.model, walking, cur.load > 0, time * 12 + id, down, goal?.over, goal?.h);
        if (!walking && !e.hand && !cur.sitting && cur.load === 0 && cur.activity === IDLE) {
          this.standAbout(e, time);
        }
        this.toPlace(e, down);
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
  private lower(e: Entry, prev: EntityView, t: number, dt: number, stepping = false): number {
    const cur = e.view;
    let goal = 0;
    // A dockhand bends to it once there, not on the way.
    if (cur.handling !== undefined && !stepping) {
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
  private handle(e: Entry, x: number, y: number, dir: number, t: number, dt: number): void {
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
        // Straight from taking a crate up to setting it down: from where it lay.
        const was =
          e.hand?.done === undefined && e.hand?.stage === 'pick' ? e.hand.place : undefined;
        e.hand = { stage: v.handStage, from: e.pose ?? drive, taken: was };
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
      w.goal ??= this.clearOfTruck(v, this.workPose(v, w, drive), w.from) ?? undefined;
      // A forklift the game has too far from its pallet to drive up to it
      // works it from where it is. It is shown a snapshot behind the game,
      // so that is measured from where the game has it, not where it shows.
      // A dockhand walks further, as to the edge of a jetty off the corner
      // a boat lies at.
      const most = v.kind === 'dockhand' ? WALK_MOST : REACH_MOST;
      const far = w.goal && Math.hypot(w.goal.x - v.x, w.goal.z - v.y) > most;
      if (w.goal && far && (v.kind === 'forklift' || v.kind === 'dockhand')) {
        w.goal = { ...w.from, dir: w.goal.dir, h: w.goal.h, over: w.goal.over };
      }
      const goal = w.goal ?? { ...drive, h: 0 };
      if (v.kind === 'dockhand') {
        // Walked up to at their own pace, in what is left of it, before they
        // bend to it.
        const left = Math.max(1, (v.handTicks ?? 1) * (1 - w.start));
        // Round a truck in the way, not through it.
        w.via ??= this.aroundTrucks(w.from, goal);
        const d = length([w.from, ...w.via, goal]);
        w.walk ??= Math.min(0.7, Math.max(0.1, d / (WALK_SPEED * left)));
        e.stepping = phase < w.walk;
        w.at = phase;
        pose = { ...walkVia(w.from, w.via, goal, phase / w.walk), h: 0 };
        this.place(e, pose);
        return;
      }
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
      if (v.kind === 'dockhand') {
        // Walks back onto their way, catching up with it, or a step clear of
        // the others there if they stand about.
        const [bx, bz] = this.byBack(drive.x, drive.z);
        const [gx, gz] = v.moving ? [bx, bz] : this.spread(e, bx, bz);
        pose = { ...this.catchUp(e, gx, gz, drive.dir, dt, v.moving), h: 0 };
        e.stepping = true;
        const there = Math.hypot(pose.x - gx, pose.z - gz) < 0.02;
        if (there || s >= 4) e.hand = undefined;
      } else if (s >= 1) e.hand = undefined;
      else {
        const a = ease(s);
        pose = {
          ...driveTo(w.from, drive, s),
          h: w.from.h + (drive.h - w.from.h) * a + CLEAR * Math.sin(Math.PI * s),
        };
      }
    }
    this.place(e, pose);
  }

  /**
   * A dockhand with nothing to do passes the time: looks round, stretches,
   * checks the time, taps a foot, or turns to chat with someone standing
   * about beside them.
   */
  private standAbout(e: Entry, time: number): void {
    const root = e.model.root;
    let mate: Entry | undefined;
    for (const o of this.entries.values()) {
      if (o === e || o.view.kind !== 'dockhand' || o.view.activity !== IDLE || o.view.moving) {
        continue;
      }
      const d = o.model.root.position.distanceTo(root.position);
      if (d < CHAT_NEAR && (!mate || d < mate.model.root.position.distanceTo(root.position))) {
        mate = o;
      }
    }
    const [what, f] = fidgetAt(e.view.id, time, !!mate);
    fidget(e.model, what, time, f);
    if (what === 'chat' && mate) {
      // Turned to whoever they talk to.
      const p = mate.model.root.position;
      const face = Math.atan2(p.z - root.position.z, p.x - root.position.x);
      root.rotation.y = -lerpAngle(-root.rotation.y, face, f);
    } else if (what === 'wave' && this.viewer !== undefined) {
      // Turned to wave up at whoever is watching.
      root.rotation.y = -lerpAngle(-root.rotation.y, this.viewer, f);
    }
  }

  /**
   * Where a dockhand standing about at x, z stands, a step clear of any
   * other dockhand nearby, and still on the quay.
   */
  private spread(e: Entry, x: number, z: number): [number, number] {
    let px = 0;
    let pz = 0;
    // By where the game has them, which holds still while they stand: each
    // steps half the room aside, and they stay put once apart.
    const me = e.view;
    for (const o of this.entries.values()) {
      if (o === e || o.view.kind !== 'dockhand' || o.view.moving) continue;
      const dx = me.x - o.view.x;
      const dz = me.y - o.view.y;
      const d = Math.hypot(dx, dz);
      if (d >= ROOM) continue;
      // Right on top of each other: apart, opposite ways, whichever way their ids say.
      const pair = Math.min(e.view.id, o.view.id) * 2.39996 + (e.view.id < o.view.id ? 0 : Math.PI);
      const a = d < 1e-3 ? pair : Math.atan2(dz, dx);
      px += (Math.cos(a) * (ROOM - d)) / 2;
      pz += (Math.sin(a) * (ROOM - d)) / 2;
    }
    // Off the edge that way: as far round from it as it takes to stay on the quay.
    for (const turn of [0, 0.8, -0.8, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      const nx = x + px * c - pz * s;
      const nz = z + px * s + pz * c;
      if (surfaceY(this.map, nx, nz) > 0) return [nx, nz];
    }
    return [x, z];
  }

  /**
   * A dockhand's way onto x, z: no faster than a brisk walk, so they never
   * jump there, facing the way they step and otherwise `dir`.
   */
  private catchUp(
    e: Entry,
    x: number,
    z: number,
    dir: number,
    dt: number,
    leaving = false,
  ): Omit<Pose, 'h'> {
    // Just come into view, or a long way on (the tab was in the background).
    if (!e.pose || Math.hypot(x - e.pose.x, z - e.pose.z) > 2) return { x, z, dir };
    // Going on from a truck they loaded, where the game has them walk
    // through it: they make for where they come out the other side, round it.
    for (let k = 0; leaving && k < 30 && this.inTruck(x, z); k++) {
      x += Math.cos(dir) * 0.05;
      z += Math.sin(dir) * 0.05;
    }
    [x, z] = this.offTrucks(e, x, z);
    // Round a truck in the way, by its nearer corner.
    const via = e.pose && this.aroundTrucks(e.pose, { x, z })[0];
    if (via) [x, z] = [via.x, via.z];
    const at = e.pose;
    const d = Math.hypot(x - at.x, z - at.z);
    const step = Math.min(d, CATCH_UP * dt);
    const nx = d > 0 ? at.x + ((x - at.x) / d) * step : x;
    const nz = d > 0 ? at.z + ((z - at.z) / d) * step : z;
    const way = d - step > 0.03 ? Math.atan2(z - at.z, x - at.x) : dir;
    return { x: nx, z: nz, dir: lerpAngle(at.dir, way, Math.min(1, dt * TURN_RATE)) };
  }

  private place(e: Entry, pose: Pose): void {
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
    // At a truck bay, to its stack or the truck in it, from the back corner
    // behind the stack, clear of the truck.
    const corner = (v.kind === 'dockhand' || v.kind === 'forklift') && this.bayStand(v, at);
    if (corner) {
      const back = v.kind === 'forklift' ? FORK_BACK : 0;
      const x = corner.x - corner.ux * back;
      const z = corner.z - corner.uz * back;
      const dir = Math.atan2(p.z - z, p.x - x);
      const over =
        v.kind === 'dockhand'
          ? Math.min(LEAN_MOST, Math.max(0, Math.hypot(p.x - x, p.z - z) - hold))
          : undefined;
      return { x, z, dir, h: p.y - surfaceY(this.map, x, z), over, fixed: true };
    }
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
    let x = p.x - dx;
    let z = p.z - dz;
    if (v.kind !== 'dockhand') return { x, z, dir: w.face, h: p.y - surfaceY(this.map, x, z) };
    // A dockhand goes no further than the edge of the quay, and leans out
    // from there to a crate on a boat rather than step aboard.
    const way = Math.hypot(x - drive.x, z - drive.z);
    const [ux, uz] = ahead(w.face, 1);
    let dry = 0;
    while (dry < way + TOES && surfaceY(this.map, drive.x + ux * dry, drive.z + uz * dry) > 0) {
      dry += 0.02;
    }
    let stand = Math.max(0, Math.min(way, dry - TOES));
    // Nor where a truck stands, other than the one they load: on to the
    // crate's side of it, or else back from it.
    const clear = (d: number) => !this.inTruck(drive.x + ux * d, drive.z + uz * d, v.handAt?.truck);
    if (!clear(stand)) {
      let k = 0.02;
      while (k < 0.8 && !clear(stand + k) && !clear(stand - k)) k += 0.02;
      if (clear(stand + k)) stand += k;
      else if (clear(stand - k)) stand -= k;
    }
    x = drive.x + ux * stand;
    z = drive.z + uz * stand;
    const over = Math.min(LEAN_MOST, Math.max(0, way - stand));
    return { x, z, dir: w.face, h: p.y - surfaceY(this.map, x, z), over };
  }

  /**
   * Where a dockhand or forklift stands at the truck bay it is on, to take
   * a crate off its stack or set one on it, or on the truck in it: the back
   * corner behind the stack, and the way into the bay towards the stack
   * from there. Null off a truck bay.
   */
  private bayStand(
    v: EntityView,
    at: HandAt,
  ): { x: number; z: number; ux: number; uz: number } | null {
    const m = this.map;
    const tile = m.idx(Math.floor(v.x), Math.floor(v.y));
    if (!m.inBounds(Math.floor(v.x), Math.floor(v.y)) || m.build[tile] !== Build.TruckBay) {
      return null;
    }
    const onTruck = at.truck !== undefined && this.entries.get(at.truck)?.view.kind === 'truck';
    if (at.bay !== tile && !onTruck) return null;
    const f = this.bayFrame(tile);
    if (!f) return null;
    // Behind the stack, halfway across it.
    const [x, z] = f.at(0.8, 0.42);
    return { x, z, ux: f.ux, uz: f.uz };
  }

  /**
   * A truck bay's own frame, from where its stack's first places lie: the
   * way in from its entrance (u) and across it (s), and where a point in
   * it, or across it to the stack's side and from its back, lies.
   */
  private bayFrame(tile: number): {
    ux: number;
    uz: number;
    at: (across: number, back: number) => [number, number];
    of: (x: number, z: number) => [number, number];
  } | null {
    // The first place, the one across from it, and the first of the row behind.
    const [a, b, c] = [0, 1, 8].map((slot) => {
      const out = new Vector3();
      return (this.containerAt?.({ bay: tile, slot }, out) ?? null) === null ? null : out;
    });
    if (!a || !b || !c) return null;
    // The first place is 0.71 across and 0.89 back from the bay's corner.
    const ux = (a.x - c.x) / 0.18;
    const uz = (a.z - c.z) / 0.18;
    const sx = (b.x - a.x) / 0.18;
    const sz = (b.z - a.z) / 0.18;
    return {
      ux,
      uz,
      at: (across, back) => [
        a.x + sx * (across - 0.71) + ux * (back - 0.89),
        a.z + sz * (across - 0.71) + uz * (back - 0.89),
      ],
      of: (x, z) => [
        0.71 + (x - a.x) * sx + (z - a.z) * sz,
        0.89 + (x - a.x) * ux + (z - a.z) * uz,
      ],
    };
  }

  /** On a truck bay, people keep to its back, out of the way of the truck: where x, z goes. */
  private byBack(x: number, z: number): [number, number] {
    const m = this.map;
    const [tx, tz] = [Math.floor(x), Math.floor(z)];
    if (!m.inBounds(tx, tz) || m.build[m.idx(tx, tz)] !== Build.TruckBay) return [x, z];
    const f = this.bayFrame(m.idx(tx, tz));
    if (!f) return [x, z];
    const [across, back] = f.of(x, z);
    return back > BACK_LANE ? f.at(across, BACK_LANE) : [x, z];
  }

  /** Whether x, z is where a truck stands still, other than `but`, with a step's room round it. */
  private inTruck(x: number, z: number, but?: number): boolean {
    for (const truck of this.entries.values()) {
      if (truck.view.kind !== 'truck' || truck.view.moving || truck.view.id === but) continue;
      const root = truck.model.root;
      const dx = x - root.position.x;
      const dz = z - root.position.z;
      if (dx * dx + dz * dz > 2.5) continue;
      const box = (truck.size ??= sizeOf(root));
      const c = Math.cos(-root.rotation.y);
      const s = Math.sin(-root.rotation.y);
      const along = dx * c + dz * s;
      const across = -dx * s + dz * c;
      const pad = 0.07;
      if (
        along > box.min.x - pad &&
        along < box.max.x + pad &&
        across > box.min.z - pad &&
        across < box.max.z + pad
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * A dockhand or forklift loading a truck stands clear of it. A dockhand
   * stands at its side or tail, whichever of them beside the crate's place
   * on its bed is nearest, and leans over to it; a forklift backs off as
   * far as it takes, its forks reaching in over the side.
   */
  private clearOfTruck(v: EntityView, at: Pose | null, from: Pose): Pose | null {
    const id = v.handAt?.truck;
    const truck = id === undefined ? undefined : this.entries.get(id);
    if (!at || at.fixed || !truck || truck.view.kind !== 'truck') return at;
    if (v.kind !== 'dockhand' && v.kind !== 'forklift') return at;
    const box = (truck.size ??= sizeOf(truck.model.root));
    const root = truck.model.root;
    const c = Math.cos(-root.rotation.y);
    const s = Math.sin(-root.rotation.y);
    if (v.kind === 'dockhand') {
      const p = new Vector3();
      if (this.handSlot(v.handAt!, p) === null) return at;
      const ox = root.position.x;
      const oz = root.position.z;
      const along = (p.x - ox) * c + (p.z - oz) * s;
      const across = -(p.x - ox) * s + (p.z - oz) * c;
      const lie = (a: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, a));
      const gap = 0.1;
      // Either side, abreast of the crate's place, or at the tail; never the cab.
      const spots: [number, number][] = [
        [lie(along, box.min.x, box.max.x), box.min.z - gap],
        [lie(along, box.min.x, box.max.x), box.max.z + gap],
        [box.min.x - gap, lie(across, box.min.z, box.max.z)],
      ];
      let best: [number, number] | undefined;
      let least = Infinity;
      for (const [a, b] of spots) {
        const x = ox + a * c - b * s;
        const z = oz + a * s + b * c;
        if (surfaceY(this.map, x, z) <= 0 || this.inTruck(x, z, id)) continue;
        const cost = Math.hypot(x - from.x, z - from.z);
        if (cost < least) [best, least] = [[x, z], cost];
      }
      if (!best) return at;
      const [x, z] = best;
      return {
        x,
        z,
        dir: Math.atan2(p.z - z, p.x - x),
        h: p.y - surfaceY(this.map, x, z),
        over: Math.min(LEAN_MOST, Math.max(0, Math.hypot(p.x - x, p.z - z) - HAND_REACH)),
      };
    }
    // Points of the body that must keep off it, ahead of and to the right of its middle.
    const body: [number, number][] = [
      [0.18, -0.16],
      [0.18, 0.16],
      [-0.26, -0.16],
      [-0.26, 0.16],
    ];
    const pad = 0.02;
    const inside = (x: number, z: number) =>
      body.some(([f, r]) => {
        const px = x + Math.cos(at.dir) * f - Math.sin(at.dir) * r - root.position.x;
        const pz = z + Math.sin(at.dir) * f + Math.cos(at.dir) * r - root.position.z;
        const along = px * c + pz * s;
        const across = -px * s + pz * c;
        return (
          along > box.min.x - pad &&
          along < box.max.x + pad &&
          across > box.min.z - pad &&
          across < box.max.z + pad
        );
      });
    let back = 0;
    while (back < 0.6 && inside(at.x - Math.cos(at.dir) * back, at.z - Math.sin(at.dir) * back)) {
      back += 0.02;
    }
    if (back === 0) return at;
    const x = at.x - Math.cos(at.dir) * back;
    const z = at.z - Math.sin(at.dir) * back;
    return { ...at, x, z, h: at.h + surfaceY(this.map, at.x, at.z) - surfaceY(this.map, x, z) };
  }

  /**
   * Where a dockhand walking to x, z goes instead, round a truck standing
   * still rather than through it: to the edge of it on the side they are
   * on, and along that side, until the way is clear of it.
   */
  private offTrucks(e: Entry, x: number, z: number): [number, number] {
    const me = e.pose;
    if (!me) return [x, z];
    for (const truck of this.entries.values()) {
      if (truck.view.kind !== 'truck' || truck.view.moving) continue;
      const at = truck.model.root;
      const dx = x - at.position.x;
      const dz = z - at.position.z;
      if (dx * dx + dz * dz > 2.5) continue;
      const box = (truck.size ??= sizeOf(at));
      const c = Math.cos(-at.rotation.y);
      const s = Math.sin(-at.rotation.y);
      const pad = 0.07;
      // How far beyond each side of it, back, front, left and right, a point is.
      const beyond = (px: number, pz: number) => {
        const along = (px - at.position.x) * c + (pz - at.position.z) * s;
        const across = -(px - at.position.x) * s + (pz - at.position.z) * c;
        return [
          box.min.x - pad - along,
          along - box.max.x - pad,
          box.min.z - pad - across,
          across - box.max.z - pad,
        ];
      };
      const to = beyond(x, z);
      if (Math.max(...to) >= 0) {
        if (e.round?.truck === truck.view.id) e.round = undefined;
        continue;
      }
      // Kept to the side they are on, so they go round, never across; at
      // one loading, to its left, the side its crates are on.
      const from = beyond(me.x, me.z);
      const side = /^Loading/.test(truck.view.activity ?? '')
        ? 2
        : e.round?.truck === truck.view.id
          ? e.round.side
          : from.indexOf(Math.max(...from));
      e.round = { truck: truck.view.id, side };
      let a = dx * c + dz * s;
      let b = -dx * s + dz * c;
      if (side === 0) a = box.min.x - pad;
      else if (side === 1) a = box.max.x + pad;
      else if (side === 2) b = box.min.z - pad;
      else b = box.max.z + pad;
      x = at.position.x + a * c - b * s;
      z = at.position.z + a * s + b * c;
    }
    return [x, z];
  }

  /**
   * Corners to walk by from one point to another round a truck standing
   * still in the way, the shorter way round it; none if nothing is in the
   * way.
   */
  private aroundTrucks(
    from: { x: number; z: number },
    to: { x: number; z: number },
  ): { x: number; z: number }[] {
    for (const truck of this.entries.values()) {
      if (truck.view.kind !== 'truck' || truck.view.moving) continue;
      const at = truck.model.root;
      const mx = (from.x + to.x) / 2 - at.position.x;
      const mz = (from.z + to.z) / 2 - at.position.z;
      if (mx * mx + mz * mz > 4) continue;
      const box = (truck.size ??= sizeOf(at));
      const c = Math.cos(-at.rotation.y);
      const s = Math.sin(-at.rotation.y);
      const local = (p: { x: number; z: number }): [number, number] => {
        const dx = p.x - at.position.x;
        const dz = p.z - at.position.z;
        return [dx * c + dz * s, -dx * s + dz * c];
      };
      const [fa, fb] = local(from);
      const [ta, tb] = local(to);
      // Whether a way crosses it (Liang-Barsky), kept a body's width off.
      const pad = 0.06;
      const crosses = ([fa, fb]: number[], [ta, tb]: number[]) => {
        let lo = 0;
        let hi = 1;
        const clip = (p: number, q: number) => {
          if (p === 0) return q > 0;
          const r = q / p;
          if (p < 0) lo = Math.max(lo, r);
          else hi = Math.min(hi, r);
          return lo < hi;
        };
        return (
          clip(-(ta - fa), fa - (box.min.x - pad)) &&
          clip(ta - fa, box.max.x + pad - fa) &&
          clip(-(tb - fb), fb - (box.min.z - pad)) &&
          clip(tb - fb, box.max.z + pad - fb) &&
          hi - lo > 1e-3
        );
      };
      if (!crosses([fa, fb], [ta, tb])) continue;
      const out = pad + 0.05;
      const corners: [number, number][] = [
        [box.min.x - out, box.min.z - out],
        [box.max.x + out, box.min.z - out],
        [box.max.x + out, box.max.z + out],
        [box.min.x - out, box.max.z + out],
      ];
      const near = (a: number, b: number) =>
        corners.reduce((k, p, i) => {
          const q = corners[k];
          return Math.hypot(p[0] - a, p[1] - b) < Math.hypot(q[0] - a, q[1] - b) ? i : k;
        }, 0);
      const i = near(fa, fb);
      const j = near(ta, tb);
      const ways = [1, 3].map((step) => {
        const path = [i];
        while (path[path.length - 1] !== j) path.push((path[path.length - 1] + step) % 4);
        return path;
      });
      const long = (path: number[]) =>
        length([
          { x: fa, z: fb },
          ...path.map((k) => ({ x: corners[k][0], z: corners[k][1] })),
          { x: ta, z: tb },
        ]);
      const best = long(ways[0]) <= long(ways[1]) ? ways[0] : ways[1];
      // Only the corners it has to go by.
      while (best.length > 1 && !crosses(corners[best[best.length - 2]], [ta, tb])) best.pop();
      while (best.length > 1 && !crosses([fa, fb], corners[best[1]])) best.shift();
      return best.map((k) => {
        const [a, b] = corners[k];
        return { x: at.position.x + a * c - b * s, z: at.position.z + a * s + b * c };
      });
    }
    return [];
  }

  /**
   * A dockhand sets a crate down in its very place, on a stack, a truck's
   * bed or a boat's deck: as they bend to it, the crate in their hands goes
   * the rest of the way there, and lies in it as it changes hands. Picking
   * one up, they take it from where it lay, and it comes up with their
   * hands; off a boat or truck, it comes away to their hands as they bend
   * to it, before the game has it change hands.
   */
  private toPlace(e: Entry, down: number): void {
    const w = e.hand;
    const at = e.view.handAt;
    if (w && at && e.view.handStage === w.stage) {
      if (this.handSlot(at, this.slotAt) !== null) w.place = this.slotAt.clone();
    }
    const load = e.model.crates[0];
    if (!w?.place || !load?.parent) return;
    load.parent.updateWorldMatrix(true, false);
    const off = at?.truck !== undefined && this.slotOf(at.truck, at.slot ?? 0);
    // Off a boat or truck, it stays where it lies while they bend to it, and
    // is in their hands as it changes hands, as they straighten up with it.
    if (w.stage === 'pick' && off) w.early = true;
    if (w.stage === 'pick' && w.early) return;
    if (!load.visible || down <= 0) return;
    // Setting one down straight after taking it up, as off a stack onto a
    // truck beside it, it goes over from one to the other as they go on.
    const on = w.stage === 'drop' ? ease((w.at ?? 1) / 0.6) : 1;
    const to = w.taken ? w.taken.clone().lerp(w.place, on) : w.place;
    const from = load.getWorldPosition(new Vector3()).lerp(to, w.taken ? down : down * on);
    load.position.copy(load.parent.worldToLocal(from));
  }

  /** Where a container to hand over lies, as containerAt; on a truck, its slot there. */
  private handSlot(at: HandAt, out: Vector3): number | null {
    if (at.truck === undefined) return this.containerAt?.(at, out) ?? null;
    const slot = this.slotOf(at.truck, at.slot ?? 0);
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
    return !!this.slotOf(id, k)?.visible;
  }

  /** The crate or container in slot `k` of a boat or vehicle, shown or not. */
  slotObject(id: number, k: number): Object3D | undefined {
    return this.slotOf(id, k);
  }

  /** Where a truck's container slot `k` is in the world, or null. */
  slotPosition(id: number, k: number, out: Vector3): Vector3 | null {
    const slot = this.slotOf(id, k);
    return slot ? slot.getWorldPosition(out) : null;
  }

  /** Which way a truck's, tractor's or ship's container slot `k` lies, as a turn about y. */
  slotTurn(id: number, k: number): number | null {
    const slot = this.slotOf(id, k);
    return slot ? turnOf(slot) : null;
  }

  /**
   * Crate `k` of a boat or crate truck, in the order they are loaded: the
   * far side from those who load it first, so the near side is unloaded
   * first, the last on being the first off.
   */
  private slotOf(id: number, k: number): Object3D | undefined {
    const e = this.entries.get(id);
    return e?.model.crates[e.order?.[k] ?? k];
  }

  /**
   * Which way round a boat's or crate truck's crates go on (see slotOf):
   * a truck's from its cab back towards its tail, or from the far side of
   * where it stands at a truck bay; a boat's from the side away from the
   * quay it lies at, worked out as it comes to lie still there.
   */
  private reorder(e: Entry): void {
    const v = e.view;
    if (v.deck || (v.kind !== 'boat' && (v.kind !== 'truck' || v.boxes))) return;
    const root = e.model.root;
    const slots = e.model.crates;
    if (slots.length < 2) return;
    root.updateMatrixWorld(true);
    const at = slots.map((c) => c.getWorldPosition(new Vector3()));
    if (v.kind === 'truck') {
      const m = this.map;
      const [tx, tz] = [Math.floor(v.x), Math.floor(v.y)];
      const bay =
        !v.moving && m.inBounds(tx, tz) && m.build[m.idx(tx, tz)] === Build.TruckBay
          ? this.bayFrame(m.idx(tx, tz))
          : null;
      if (bay && e.orderAt !== 'bay') {
        // In a truck bay: from where those who load it stand. Where its
        // places are as the game has it stand there, which it may not quite
        // show yet, a snapshot behind; any crates on it already first.
        const [sx, sz] = bay.at(0.8, 0.42);
        const [c, s] = [Math.cos(v.dir), Math.sin(v.dir)];
        const dist = at.map((p) => {
          const l = root.worldToLocal(p.clone());
          const x = v.x + l.x * c - l.z * s;
          const z = v.y + l.x * s + l.z * c;
          return Math.hypot(x - sx, z - sz);
        });
        const byFar = (a: number, b: number) => dist[b] - dist[a];
        const keys = slots.map((_, k) => k);
        const on = keys.filter((k) => slots[k].visible);
        e.order = [...on.sort(byFar), ...keys.filter((k) => !slots[k].visible).sort(byFar)];
        e.orderAt = 'bay';
      } else if (!e.order) {
        // Cab first, the cab ahead (+x) of its middle.
        const local = at.map((p) => root.worldToLocal(p.clone()));
        e.order = slots.map((_, k) => k).sort((a, b) => local[b].x - local[a].x);
      }
      return;
    }
    // A boat lying still beside the quay: the side the land is.
    if (v.moving) {
      e.orderAt = undefined;
      return;
    }
    if (e.orderAt === 'quay') return;
    // How far each crate is from the nearest dock or quay, any way round.
    const ashore = (p: Vector3) => {
      for (let d = 0.05; d < 1.6; d += 0.05) {
        for (let a = 0; a < 16; a++) {
          const t = (a / 16) * Math.PI * 2;
          if (surfaceY(this.map, p.x + Math.cos(t) * d, p.z + Math.sin(t) * d) > 0) return d;
        }
      }
      return Infinity;
    };
    const dist = at.map(ashore);
    if (dist.every((d) => d === Infinity)) return;
    // Those on board stay where they are, the near side of them first off;
    // any put on board go on the far side of the places left first.
    const byFar = (a: number, b: number) => dist[b] - dist[a];
    const keys = slots.map((_, k) => k);
    const on = keys.filter((k) => slots[k].visible).sort(byFar);
    e.order = [...on, ...keys.filter((k) => !slots[k].visible).sort(byFar)];
    e.orderAt = 'quay';
  }

  worldPositions(): { view: EntityView; pos: Vector3 }[] {
    return [...this.entries.values()].map((e) => ({ view: e.view, pos: e.model.root.position }));
  }
}

/** How far a model reaches each way from its middle, unturned. */
function sizeOf(root: Object3D): Box3 {
  const at = root.position.clone();
  const turn = root.rotation.y;
  root.position.set(0, 0, 0);
  root.rotation.y = 0;
  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(root);
  root.position.copy(at);
  root.rotation.y = turn;
  root.updateMatrixWorld(true);
  return box;
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
