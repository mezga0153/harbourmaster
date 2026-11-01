import { Group, Vector3, type Object3D } from 'three';
import { VESSELS } from '../sim/balance';
import type { EntityView, HandAt } from '../protocol';
import { AHEAD_TILES } from '../protocol/views';
import type { GameMap } from '../sim/map';
import { isMachineKind } from '../sim/machines';
import { Build, TICKS_PER_SECOND } from '../sim/types';
import { place, type Entry, type Hand } from './entities/entry';
import {
  BACKED_OUT,
  bodyBlocked,
  FORK_REACH,
  forkIn,
  forkOut,
  forkPlan,
  forkRoute,
  onGrid,
  type Crate,
  type ForkPlan,
  type ForkSite,
} from './entities/forks';
import {
  CELL,
  CELL_CRATE,
  CELL_NO_WALK,
  CELL_TRUCK,
  StaffGrid,
  type CrateBox,
  type Point,
} from './entities/grid';
import { keepInside, parkIn, parkOut } from './entities/parking';
import {
  bayFrame,
  bayStand,
  clearOfTruck,
  HAND_REACH,
  inTruck,
  LEAN_MOST,
  stillTrucks,
  type TruckSite,
} from './entities/trucks';
import { disposeOwned, KeyedObjects } from './keyed';
import { CARRY_LOW, FORKS_EMPTY, FORKS_LOADED, STACKER_REACH, TRAILER_AT } from './machines';
import { modelFor } from './model';
import { alertMarker, CRATE, paintLoad, setCrateIcon, showDeck, showLoad } from './models';
import { aboutAt, driveTo, FORK_KEEP, slide, turnAbout, type About, type Pose } from './motion';
import { fidget, fidgetAt, pose, sit } from './people';
import { surfaceY } from './terrain';
import { ease, headingOf, lerpAngle, turnOf, wrapAngle } from './util/math';
import type { Trailer } from './vehicles';
import { Wakes, type Stir, type Track, type Wake } from './wakes';

export { turnOf };
export { turnAbout, type TurnAbout } from './motion';

const SNAPSHOT_MS = 100;

/** Furthest a trailer folds against its tractor, either way: 80°. */
const FOLD = (80 * Math.PI) / 180;
/** How quickly a trailer settles straight behind a truck standing still, per game second. */
const SETTLE = 3;

/** Furthest a forklift drives up to a pallet, from where it stops for it. */
const REACH_MOST = 1.3;
/** Game seconds a stacker or tractor takes to go back to driving once it has handed a container over. */
const HAND_SETTLE = 0.5;
/** How far a stacker lifts a container clear of the others as it moves it. */
const CLEAR = 0.1;

/**
 * How far through picking a crate up or setting it down a dockhand's
 * hands are down on the ground; and how quickly they go down and come
 * back up, per game second.
 */
const DOWN_BY = 0.5;
const DOWN_RATE = 4;
const UP_RATE = 3;

/** What a dockhand with nothing to do is doing, as the game has it. */
const IDLE = 'Waiting for work';
/** How near another dockhand standing about is for them to chat. */
const CHAT_NEAR = 0.7;
/** How far back from the edge of the quay a dockhand stands, toes to the edge. */
const TOES = 0.05;
/** How far off the way it is going a forklift has to face to turn about. */
const TURN_FROM = (Math.PI * 2) / 3;
/** How near right round a forklift turning about has to be to swing its tail either way. */
const FLIP_FROM = 2.2;
/** Game seconds a forklift takes to ease onto a way it turned onto part way round. */
const SLIP_TIME = 0.3;
/** Game seconds a forklift takes to back out from a load it took or set down and drive on. */
const FORK_SETTLE = 0.8;
/**
 * Forklifts kept off a truck or crates: how far right of their way, and
 * ahead along it, they may be drawn instead, the likeliest first, out to
 * the aisles round the stacks in crate storage at the tiles' edges; at
 * the last, held back short of the crates on a tile they drive into to
 * work.
 */
const SPOTS: [number, number][] = [0, -0.1, 0.1, -0.2, 0.2, -0.3, -0.4, -0.5, -0.6].flatMap((a) =>
  [0.16, 0.1, 0.05, 0, -0.05, -0.1, -0.16, 0.22, -0.22, 0.28, -0.28, 0.36, -0.36, 0.42, -0.42].map(
    (k): [number, number] => [k, a],
  ),
);
/** How quickly a forklift edges over to keep clear, tiles per game second; and holds back or catches up. */
const KEEP_RATE = 3;
const HOLD_RATE = 20;
/**
 * How far its way on may have gone, in tiles, while a forklift that has
 * backed out waits where it lined up for that way to clear the crates.
 */
const HOLD_NEAR = 1.2;
/** How far a crate in crate storage stands on its pallet. */
const ON_PALLET = 0.025;
/**
 * How far ahead along their way, in tiles, dockhands and forklifts look
 * for crates and trucks to keep clear of, and how much each look counts:
 * so they edge over to a clear lane well before they get to them.
 */
const LOOKS: [number, number][] = [
  [0.2, 1],
  [0.4, 0.7],
  [0.6, 0.45],
  [0.8, 0.25],
];
/** The lanes across their way a forklift picks between as it drives, right of the middle; the usual first. */
const FORK_LANES = [
  FORK_KEEP,
  0.1,
  0.22,
  0.05,
  0.28,
  0,
  0.36,
  -0.05,
  0.42,
  -0.1,
  -0.16,
  -0.22,
  -0.28,
  -0.36,
  -0.42,
];
/** How far right of the middle of their way people walk, so those going opposite ways pass. */
const WALK_KEEP = 0.2;
/**
 * What a forklift looks ahead for on the staff's grid: crates and trucks;
 * the edge of the ground it keeps off where it is (see bodyBlocked), as
 * its way out of its depot runs through ground it does not drive on.
 */
const AHEAD_OFF = CELL_CRATE | CELL_TRUCK;
/** What a dockhand's way keeps out of, of the staff's grid: crates, and the water. */
const WALK_OFF = CELL_CRATE | CELL_NO_WALK;
/** How far inside the edge of a cell a dockhand stands to work a crate, keeping out of the cell beside. */
const CELL_INSET = 0.06;

/** How high a forklift's forks ride as it drives about: low, a load just off the ground. */
function ride(v: EntityView): number {
  return v.load > 0 ? FORKS_LOADED : FORKS_EMPTY;
}

/** Ships, trucks and people, interpolated between sim snapshots. */
export class Entities {
  readonly group = new Group();
  private entries = new KeyedObjects<number, Entry>((e) => {
    this.group.remove(e.model.root);
    if (e.alert) this.group.remove(e.alert);
    if (e.track) this.wash.letGo(e.track);
    disposeOwned(e.model);
  });
  private prev = new Map<number, EntityView>();
  private snapTime = 0;
  /** Sim ticks between the last two snapshots, more at higher game speeds. */
  private snapTicks = 1;
  private lastTick = -1;
  private prevTick = 0;
  /** Game time, in seconds, as of the last frame. */
  private sim = 0;
  /** The wakes the boats lay and the water they stir, for the sea. */
  private wash = new Wakes();
  /**
   * Where a container lies on a crane's stack or in a yard, for a stacker
   * or tractor to hand it over there: its base, and which way its length
   * runs as a heading. Set by the renderer.
   */
  containerAt?: (at: HandAt, out: Vector3) => number | null;
  /** Whether a crate shows on the ground at x, z, `pad` round it; set by the renderer. */
  crateIn?: (x: number, z: number, pad: number) => boolean;
  /** The crates showing on the ground of a tile; set by the renderer (see Structures.cratesOn). */
  cratesOn?: (i: number) => CrateBox[];
  /**
   * The ground the staff find their way across, four by four cells a tile,
   * and what keeps dockhands and forklifts out of each; see grid.ts. For a
   * debug overlay: `staffGrid.free('dockhand' | 'forklift', cx, cz)`.
   */
  readonly staffGrid: StaffGrid;
  /** Which way the camera is from what it looks at, as a heading on the ground: who dockhands wave to. */
  viewer?: number;
  private slotAt = new Vector3();

  /** What keeping clear of the trucks asks of this; see entities/trucks.ts. */
  private trucks: TruckSite;
  /** What a forklift keeps its body clear of; see entities/forks.ts. */
  private forkSite: ForkSite;

  constructor(private map: GameMap) {
    this.trucks = {
      map,
      entries: () => this.entries.values(),
      entry: (id) => this.entries.get(id),
      containerAt: (at, out) => this.containerAt?.(at, out) ?? null,
      handSlot: (at, out) => this.handSlot(at, out),
    };
    this.staffGrid = new StaffGrid({
      map,
      crates: (i) => this.cratesOn?.(i) ?? this.cratesFelt(i),
      trucks: () => stillTrucks(this.trucks),
    });
    this.forkSite = {
      map,
      grid: this.staffGrid,
      inTruck: (x, z) => inTruck(this.trucks, x, z, undefined, 0.02),
      crateIn: (x, z, pad) =>
        this.cratesOn ? this.staffGrid.crateAt(x, z, pad) : (this.crateIn?.(x, z, pad) ?? false),
    };
  }

  /**
   * The crates on tile `i` as the cells of it they are in, felt for with
   * crateIn, where the renderer gives no list of them (as in some tests).
   */
  private cratesFelt(i: number): CrateBox[] {
    const out: CrateBox[] = [];
    const m = this.map;
    const half = 0.125 - 0.002;
    for (let k = 0; k < 16; k++) {
      const x = m.xOf(i) + ((k % 4) + 0.5) / 4;
      const z = m.yOf(i) + (Math.floor(k / 4) + 0.5) / 4;
      if (this.crateIn?.(x, z, half)) out.push({ x, z, half });
    }
    return out;
  }

  /**
   * The way the view has `id` going, for a debug overlay: from where it is
   * drawn by the corners it goes by, as last worked out; null if none.
   */
  plannedPath(id: number): Point[] | null {
    return this.entries.get(id)?.route ?? null;
  }

  push(views: EntityView[], now: number, tick: number): void {
    this.staffGrid.invalidate();
    this.prev = new Map([...this.entries].map(([id, e]) => [id, e.view]));
    this.snapTime = now;
    this.snapTicks = this.lastTick < 0 ? 1 : Math.max(1, tick - this.lastTick);
    this.prevTick = this.lastTick < 0 ? tick : this.lastTick;
    this.lastTick = tick;
    const byId = new Map(views.map((v) => [v.id, v]));
    this.entries.sync(byId.keys(), (id) => this.enter(byId.get(id)!));
    for (const v of views) {
      const e = this.entries.get(v.id)!;
      // Out of where it was parked: from where the game has it, not the garage.
      if (this.prev.get(v.id)?.parked && !v.parked) this.prev.set(v.id, v);
      e.view = v;
      if (v.deck) showDeck(e.model, v.deck);
      else if (v.bed) {
        // A crate truck's crates each in its place on the bed, as the game keeps it.
        const bed = v.bed;
        e.model.crates.forEach((c, k) => {
          c.visible = !!bed[k];
          if (bed[k]?.cargo) setCrateIcon(c, bed[k]!.cargo!);
        });
      } else {
        this.reorder(e);
        if (e.order) {
          const shown = new Set(e.order.slice(0, v.load));
          e.model.crates.forEach((c, k) => (c.visible = shown.has(k)));
        } else showLoad(e.model, v.load);
        if (v.looks) paintLoad(e.model, v.looks);
        // Each crate painted with what it holds, in the order they go on.
        v.cargo?.forEach((c, k) => setCrateIcon(e.model.crates[e.order?.[k] ?? k], c));
        if (v.kind === 'forklift') this.onForks(e);
      }
    }
  }

  /** A model for an entity just come into view, in the scene. */
  private enter(v: EntityView): Entry {
    const model = modelFor(v);
    this.group.add(model.root);
    // Only machines show a warning marker; boats at anchor are normal.
    const alert = isMachineKind(v.kind) ? alertMarker() : null;
    if (alert) {
      alert.visible = false;
      this.group.add(alert);
    }
    const e: Entry = { view: v, model, alert };
    if (v.kind === 'boat') {
      e.way = 0;
      e.heel = 0;
      model.root.rotation.order = 'YXZ';
    }
    return e;
  }

  update(now: number, time: number): void {
    const t = Math.min(1, (now - this.snapTime) / SNAPSHOT_MS);
    // Wakes keep game time: they hold still while paused and settle over
    // the same stretch of water whatever the game speed.
    const sim = (this.prevTick + (this.lastTick - this.prevTick) * t) / TICKS_PER_SECOND;
    const dt = Math.max(0, Math.min(1, sim - this.sim));
    this.sim = sim;
    this.wash.sim = sim;
    for (const [id, e] of this.entries) {
      const cur = e.view;
      const prev = this.prev.get(id) ?? cur;
      const x = prev.x + (cur.x - prev.x) * t;
      const y = prev.y + (cur.y - prev.y) * t;
      const dir = lerpAngle(prev.dir, cur.dir, t);
      const root = e.model.root;
      // As it was last drawn, for a machine to drive on from.
      const was: Pose = {
        x: root.position.x,
        z: root.position.z,
        dir: -root.rotation.y,
        h: e.pose?.h ?? CARRY_LOW,
      };
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
        const along =
          ((cur.x - prev.x) * Math.cos(dir) + (cur.y - prev.y) * Math.sin(dir)) /
          (hull.speed * this.snapTicks);
        const swing = Math.min(1, Math.abs(turn) / (hull.turn * this.snapTicks));
        this.wash.wash(e, id, hull, x, y, dir, way, along, swing, dt);
      } else if (isMachineKind(cur.kind) && cur.parked) {
        parkIn(this.map, this.sim, e, was, !this.prev.has(id));
      } else if (
        cur.kind === 'stacker' ||
        cur.kind === 'tractor' ||
        ((cur.kind === 'forklift' || cur.kind === 'dockhand') && (cur.handAt || e.hand))
      ) {
        // A forklift lines up to the crates it takes or sets down and
        // drives in, and a dockhand walks up to the crate.
        this.handle(e, x, y, dir, t, dt);
      } else if (cur.kind === 'dockhand' || isMachineKind(cur.kind)) {
        // Keep to the right of the tile, so people going opposite ways pass;
        // sat on a bench, just where their seat is.
        const seated = cur.sitting && !cur.moving;
        const going = e.about && !e.about.done ? e.about : null;
        const about = cur.kind === 'forklift' ? this.turningAbout(e, prev, x, y) : null;
        // Once round, it faces the way it is going, not part way between.
        const way = about ? about.dir : dir;
        let [rx, ry] =
          cur.kind === 'forklift'
            ? this.forkSpot(e, x, y, way, dt)
            : seated
              ? [x, y]
              : cur.kind === 'dockhand'
                ? [x, y]
                : [x - Math.sin(way) * WALK_KEEP, y + Math.cos(way) * WALK_KEEP];
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
        e.pose = { x: rx, z: ry, dir: yaw, h: cur.kind === 'forklift' ? ride(cur) : 0 };
      } else {
        root.position.set(x, surfaceY(this.map, x, y), y);
        if (e.model.trailer) this.trail(e, e.model.trailer, x, y, dir, cur.moving, dt);
      }
      // Straight to work from the depot's door: it is where it works.
      if (e.dock && !cur.parked && (cur.handStage || e.hand)) e.dock = undefined;
      if (e.dock && !cur.parked) parkOut(this.map, this.sim, e, was);
      keepInside(this.map, e);
      if (cur.kind === 'forklift') {
        // At work, as high as it works the load; otherwise low.
        e.model.forks!.position.y = e.hand && e.pose ? e.pose.h : ride(cur);
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
      const about = (f: number): About => {
        const a: About = {
          x: prev.x,
          y: prev.y,
          dir: cur.dir,
          path: turnAbout(f),
          tick: this.lastTick,
          done: false,
        };
        // From where it is drawn, as clear of a truck or crates.
        const [sx, sy] = aboutAt(a, prev.x, prev.y);
        if (e.pose) a.off = [e.pose.x - sx, e.pose.z - sy];
        return a;
      };
      e.about = about(face);
      // Turned right round, it swings its tail whichever way is clear of
      // trucks and crates, as backing out of a truck bay past the truck.
      if (Math.abs(face) > FLIP_FROM) {
        // The other way round: turnAbout swings it the other way for a face
        // just short of right round to the left.
        const back = Math.PI - 0.011;
        const turnsLeft = face > 0 && face < Math.PI - 0.01;
        const other = about(turnsLeft || Math.abs(face) < back ? -face : back);
        if (this.aboutBlocked(other) < this.aboutBlocked(e.about)) e.about = other;
      }
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

  /** How badly a forklift is in the way of things all the way round `about`; see bodyBlocked. */
  private aboutBlocked(about: About): number {
    let n = 0;
    const ux = Math.cos(about.dir);
    const uz = Math.sin(about.dir);
    for (let k = 0; k <= 8; k++) {
      const s = (about.path.reach * k) / 8;
      const [x, z, dir] = aboutAt(about, about.x + ux * s, about.y + uz * s);
      n += bodyBlocked(this.forkSite, x, z, dir);
    }
    return n;
  }

  /**
   * A dockhand's hands go down to the ground over the first part of
   * picking a crate up or setting it down, so they are there by the time
   * it leaves where it was and shows in them, or leaves them and shows
   * where it is set down; then they come back up. Returns how far
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
      goal = ease(p / DOWN_BY);
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
    const [dx, dz] =
      v.kind === 'forklift'
        ? this.forkSpot(e, x, y, dir, dt)
        : v.kind === 'dockhand'
          ? [x, y]
          : [x - Math.sin(dir) * 0.2, y + Math.cos(dir) * 0.2];
    const drive: Pose = {
      x: dx,
      z: dz,
      dir,
      h: CARRY_LOW,
    };
    if (v.kind === 'forklift') {
      this.fork(e, drive, t);
      return;
    }
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
      // Where the game has them stand to work it, just there; else as near it as they may.
      w.goal ??=
        (v.stand
          ? this.workPose(v, w, drive)
          : clearOfTruck(this.trucks, v, this.workPose(v, w, drive), w.from)) ?? undefined;
      // A dockhand the game has too far from the crate to walk up to it
      // works it from where they are, though they go as far as the edge of
      // a jetty off the corner a boat lies at. They are shown a snapshot
      // behind the game, so that is measured from where the game has them.
      // With nowhere the game has them stand to work it, they work it from
      // where they are, facing it.
      if (w.goal && !v.stand && v.kind === 'dockhand') {
        w.goal = { ...w.from, dir: w.goal.dir, h: w.goal.h, over: w.goal.over };
      }
      // Nowhere known to work it: where they are, but out of any crates there.
      w.goal ??= v.kind === 'dockhand' ? this.outOfCrates({ ...drive, h: 0 }) : undefined;
      const goal = w.goal ?? { ...drive, h: 0 };
      if (v.kind === 'dockhand') {
        // Where the game has them, as it has them: they bend to it there.
        e.stepping = false;
        w.at = phase;
        e.route = [goal];
        place(this.map, e, { ...goal, x: drive.x, z: drive.z });
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
        // Done: on from where the game has them, which is where they worked
        // it, the crate going from where it lay into their hands as they
        // straighten up.
        if ((e.down ?? 0) <= 0.02) e.hand = undefined;
        e.stepping = false;
        pose = { ...drive, h: 0 };
      } else if (s >= 1) e.hand = undefined;
      else {
        const a = ease(s);
        pose = {
          ...driveTo(w.from, drive, s),
          h: w.from.h + (drive.h - w.from.h) * a + CLEAR * Math.sin(Math.PI * s),
        };
      }
    }
    place(this.map, e, pose);
  }

  /**
   * Where a forklift at x, y going `way` is drawn: to the right of the
   * middle of its way as usual, unless that has it over a truck standing
   * there or crates, as in a truck bay or past pallets in storage; then
   * the nearest spot to that, across or along its way, clear of them, as
   * far clear as it can be where none is; edging over to it.
   */
  private forkSpot(e: Entry, x: number, y: number, way: number, dt: number): [number, number] {
    const fx = Math.cos(way);
    const fz = Math.sin(way);
    const at = ([k, a]: [number, number]): [number, number] => [
      x - fz * k + fx * a,
      y + fx * k + fz * a,
    ];
    const blocked = (o: [number, number]) => bodyBlocked(this.forkSite, ...at(o), way);
    // Driving cell by cell, it goes just where the game has it, round the
    // crates; tile by tile, to the right of the middle of its way.
    const usual = e.view.cells ? 0 : FORK_KEEP;
    let want: [number, number] = [usual, 0];
    const [k0, a0] = e.keep ?? want;
    // Crates or a truck on its way ahead: it picks the lane past them as
    // it comes up to them, the clearest nearest the one it is in.
    const looks = this.lookAhead(e.view, x, y);
    const grid = this.staffGrid;
    const ahead = (k: number) =>
      looks.reduce(
        (n, p) =>
          n +
          p.w *
            onGrid(grid, p.x - Math.sin(p.dir) * k, p.z + Math.cos(p.dir) * k, p.dir, AHEAD_OFF),
        0,
      );
    if (looks.length > 0 && ahead(usual) > 0) {
      const score = (k: number) => ahead(k) + 0.4 * Math.abs(k - k0) + 0.2 * Math.abs(k - usual);
      const lanes = FORK_LANES.map((k) => [k, score(k)] as const).sort((p, q) => p[1] - q[1]);
      const lane = lanes.find(([k]) => blocked([k, 0]) === 0);
      if (lane) want = [lane[0], 0];
    }
    e.route = [
      { x: e.pose?.x ?? x, z: e.pose?.z ?? y },
      ...looks.map((p) => ({
        x: p.x - Math.sin(p.dir) * want[0],
        z: p.z + Math.cos(p.dir) * want[0],
      })),
    ];
    // Driving through a depot, as along a row of them to its own, all of it
    // is off the ground it drives on: it keeps to its lane, through the doors.
    const [tx, tz] = [Math.floor(x), Math.floor(y)];
    const inDepot =
      this.map.inBounds(tx, tz) && this.map.build[this.map.idx(tx, tz)] === Build.Depot;
    if (!inDepot && blocked(want) > 0) {
      // The clear spot nearest where it is drawn, so it never cuts across
      // crates to get to another: held back as it drives in, it stays back.
      const near = (o: [number, number]) => Math.hypot(o[0] - k0, o[1] - a0);
      let least = Infinity;
      for (const o of [...SPOTS].sort((p, q) => near(p) - near(q))) {
        const n = blocked(o);
        if (n < least) [want, least] = [o, n];
        if (n === 0) break;
      }
      // Held back, it stands right up to them.
      while (least === 0 && want[1] < 0 && blocked([want[0], want[1] + 0.02]) === 0) {
        want = [want[0], want[1] + 0.02];
      }
    }
    const [wk, wa] = want;
    const toward = (v: number, goal: number, rate: number) =>
      v + Math.max(-dt * rate, Math.min(dt * rate, goal - v));
    // It stops short at once, rather than drive on into them.
    e.keep = [toward(k0, wk, KEEP_RATE), wa < a0 ? wa : toward(a0, wa, HOLD_RATE)];
    if (blocked(e.keep) > 0 && blocked(want) === 0) e.keep = want;
    return at(e.keep);
  }

  /**
   * A forklift at work: it lines up square on to the load it takes or the
   * place it sets one down, a little back, drives straight in with its
   * forks at the height of it, and is there as the load changes hands;
   * then it backs straight out and drives on. See forks.ts.
   */
  private fork(e: Entry, drive: Pose, t: number): void {
    const v = e.view;
    const low = { ...drive, h: ride(v) };
    if (v.handStage) {
      if (e.hand?.stage !== v.handStage || e.hand.done !== undefined) {
        // Straight on from the last load, as off a truck bay's stack onto the truck.
        const last = e.hand?.done === undefined ? e.hand?.plan : undefined;
        e.hand = { stage: v.handStage, from: e.pose ?? low, last };
      }
      const w = e.hand;
      const now = Math.min(
        1,
        (v.handPhase ?? 0) + (t * this.snapTicks) / Math.max(1, v.handTicks ?? 1),
      );
      w.start ??= now;
      const phase = w.start < 1 ? Math.max(0, (now - w.start) / (1 - w.start)) : 1;
      if (!w.plan && v.stand) {
        // Where the game has it stand, square on to the load: its forks up
        // to the height of it, and in under it.
        const own = this.forkPlanFor(v, w.from);
        const h = own?.goal.h ?? ride(v);
        const { x, y: z, dir, reach } = v.stand;
        const line = { x, z, dir, h };
        const d = Math.max(0, reach - FORK_REACH);
        // Its forks right under the load as it draws it, coming at it the
        // same way: in from where it stands, straightening onto it.
        const square = own && Math.cos(own.goal.dir - dir) > 0.9;
        const goal = square
          ? { ...own.goal, dir }
          : { ...line, x: x + Math.cos(dir) * d, z: z + Math.sin(dir) * d };
        w.plan = { line, goal, away: [], stood: true };
        e.route = [w.from, line, w.plan.goal];
      }
      if (!w.plan) {
        const plan = this.forkPlanFor(v, w.from);
        // Too far from it, as the game has it, to drive up to it: it works
        // it from where it is.
        if (plan && Math.hypot(plan.goal.x - v.x, plan.goal.z - v.y) > REACH_MOST + 0.3) {
          const goal = { ...w.from, dir: plan.goal.dir, h: plan.goal.h };
          w.plan = { goal, line: goal };
        } else w.plan = plan ?? undefined;
        if (w.plan && w.last) w.plan.out = w.last.line;
        // Round crates in the way to line up, not through them.
        if (w.plan) w.plan.via = forkRoute(this.forkSite, w.plan.out ?? w.from, w.plan.line);
        const p = w.plan;
        e.route = p && [w.from, ...(p.out ? [p.out] : []), ...(p.via ?? []), p.line, p.goal];
      }
      place(this.map, e, w.plan ? forkIn(w.plan, w.from, phase, w.stage === 'pick') : low);
      return;
    }
    const w = e.hand!;
    if (w.done === undefined) {
      w.done = this.sim;
      w.from = e.pose ?? low;
    }
    let s = (this.sim - w.done) / FORK_SETTLE;
    // Where the game has it stand: backed out to there as the game has it
    // back out, then on as the game has it.
    if (w.plan?.stood && s >= BACKED_OUT) {
      e.hand = undefined;
      place(this.map, e, low);
      return;
    }
    if (w.plan && s > BACKED_OUT) {
      // Backed out, it waits where it lined up while its way on still runs
      // through crates, as off the tile it worked, then drives round them.
      const near = Math.hypot(low.x - w.plan.line.x, low.z - w.plan.line.z) < HOLD_NEAR;
      if (!w.plan.away && near && bodyBlocked(this.forkSite, low.x, low.z, low.dir) >= 3) {
        w.done = this.sim - BACKED_OUT * FORK_SETTLE;
        s = BACKED_OUT;
      } else w.plan.away ??= forkRoute(this.forkSite, w.plan.line, low);
      e.route = [w.plan.goal, w.plan.line, ...(w.plan.away ?? []), low];
    }
    if (s >= 1 || !w.plan) {
      e.hand = undefined;
      place(this.map, e, low);
      return;
    }
    place(this.map, e, forkOut(w.plan, low, s, low.h, w.stage === 'pick'));
  }

  /**
   * Where a forklift lines up for the load it works, and drives in to:
   * the crates it takes, the top of them last, or the places those it
   * sets down go; square on to them, to a truck from its side or tail, to
   * a truck bay's stack from behind it, to a pallet in storage the way
   * its forks go in.
   */
  private forkPlanFor(v: EntityView, from: Pose): ForkPlan | null {
    const at = v.handAt;
    if (!at) return null;
    const p = this.slotAt;
    const crates: Crate[] = [];
    let heading: number | null = null;
    let prefer = (_face: number) => 0;
    if (at.store !== undefined && at.place !== undefined) {
      heading = this.containerAt?.(at, p) ?? null;
      if (heading === null) return null;
      // Set down on a half pallet there, a layer up.
      const up = at.slot !== undefined && at.slot % 4 >= 2 ? CRATE : 0;
      crates.push({ x: p.x, y: p.y + ON_PALLET + up, z: p.z });
      // The forks go in only the way the pallets lie, from either end of
      // the stack: from its sides they would be under the other row. From
      // the end its row faces, the near half of the tile, rather than
      // through the other row, which may be filled meanwhile.
      const along = heading;
      const [ox, oz] = [p.x - Math.floor(p.x) - 0.5, p.z - Math.floor(p.z) - 0.5];
      prefer = (face) => {
        if (Math.abs(Math.cos(face - along)) <= 0.5) return Infinity;
        return ox * Math.cos(face) + oz * Math.sin(face) < 0 ? 0 : 3;
      };
    } else {
      const k = at.slot ?? 0;
      const pick = v.handStage === 'pick';
      const n = pick ? Math.min(v.handCount ?? v.capacity, k + 1) : Math.max(1, v.load);
      const first = pick ? k - n + 1 : k;
      // Onto a truck's bed, the places its whole load goes.
      const places = at.slots ?? Array.from({ length: n }, (_, j) => first + j);
      for (const s of places) {
        const turn = this.handSlot({ ...at, slot: s }, p);
        if (turn === null) continue;
        heading ??= turn;
        crates.push({ x: p.x, y: p.y, z: p.z });
      }
      if (heading === null) return null;
      const truck = at.truck === undefined ? undefined : this.entries.get(at.truck);
      const bay = at.bay === undefined ? null : bayFrame(this.trucks, at.bay);
      const along = heading;
      if (truck?.view.kind === 'truck') {
        // Side on, from whichever side the places are on: never at its
        // tail, nor through its cab.
        const side = this.sideOf(truck, crates);
        const facing = -truck.model.root.rotation.y;
        prefer = (face) => {
          if (Math.abs(Math.cos(face - along)) >= 0.5) return Infinity;
          // From the side the places are on, where there is ground to
          // stand on; else reaching over from the other.
          return side * Math.sin(face - facing) > 0 ? 0 : 1;
        };
      } else if (bay) {
        const way = Math.atan2(bay.uz, bay.ux);
        prefer = (face) => (Math.cos(face - way) > 0.9 ? 0 : 0.5);
      }
    }
    return forkPlan(this.forkSite, crates, heading, prefer, from);
  }

  /**
   * Points ahead of x, y on a dockhand's or forklift's way, as the game
   * has it go from the middle of one tile to the next, at LOOKS along it:
   * where each is and which way the way runs there. Only up to the edge
   * of the tile it is going to, as there it works out its own way in.
   */
  private lookAhead(
    v: EntityView,
    x: number,
    y: number,
  ): { x: number; z: number; dir: number; w: number }[] {
    const tiles = v.moving ? v.ahead : undefined;
    if (!tiles || tiles.length === 0) return [];
    const m = this.map;
    const cells = v.cells;
    // A forklift driving cell by cell: by the corners the game has it go by, to where it stops.
    const pts: Point[] = cells
      ? [
          { x, z: y },
          ...Array.from({ length: cells.length / 2 }, (_, k) => ({
            x: cells[2 * k],
            z: cells[2 * k + 1],
          })),
        ]
      : [{ x, z: y }, ...tiles.map((t) => ({ x: m.xOf(t) + 0.5, z: m.yOf(t) + 0.5 }))];
    if (!cells && tiles.length < AHEAD_TILES) {
      const [a, b] = pts.slice(-2);
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d > 0.5)
        pts[pts.length - 1] = {
          x: b.x - ((b.x - a.x) / d) * 0.5,
          z: b.z - ((b.z - a.z) / d) * 0.5,
        };
      else pts.pop();
    }
    const out: { x: number; z: number; dir: number; w: number }[] = [];
    let k = 0;
    let along = 0;
    const len = (i: number) => Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    for (const [s, w] of LOOKS) {
      while (k < pts.length - 1 && along + len(k) < s) along += len(k++);
      if (k >= pts.length - 1) break;
      const [a, b] = [pts[k], pts[k + 1]];
      const t = (s - along) / len(k);
      out.push({
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        dir: Math.atan2(b.z - a.z, b.x - a.x),
        w,
      });
    }
    return out;
  }

  /** Where a dockhand at `pose` stands instead, clear of crates: the nearest clear spot of the staff's grid. */
  private outOfCrates(pose: Pose): Pose {
    const free = this.staffGrid.nearestFree('dockhand', pose.x, pose.z, 0.75, WALK_OFF);
    return free ? { ...pose, x: free.x, z: free.z } : pose;
  }

  /**
   * Where a dockhand stands to work a crate at `p` on the ground, as in
   * crate storage: in the gap beside the stack, never in it, the nearest
   * clear cell of the staff's grid it can reach the crate from, by how
   * far they lean and how far they walk from `from`; null if none is.
   */
  private standBy(p: Point, from: Point): Point | null {
    const grid = this.staffGrid;
    const [cx, cz] = grid.cellOf(p.x, p.z);
    let best: Point | null = null;
    let least = Infinity;
    const lie = (a: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, a));
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const [nx, nz] = [cx + dx, cz + dz];
        if (!grid.free('dockhand', nx, nz)) continue;
        const x = lie(p.x, nx * CELL + CELL_INSET, (nx + 1) * CELL - CELL_INSET);
        const z = lie(p.z, nz * CELL + CELL_INSET, (nz + 1) * CELL - CELL_INSET);
        const reach = Math.hypot(x - p.x, z - p.z);
        if (reach > HAND_REACH + LEAN_MOST) continue;
        const cost = 2 * reach + 0.3 * Math.hypot(x - from.x, z - from.z);
        if (cost < least) [best, least] = [{ x, z }, cost];
      }
    }
    return best;
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

  /** Where a stacker or tractor stands to hand a container over, or null if it is not known. */
  private workPose(v: EntityView, w: Hand, drive: Pose): Pose | null {
    const at = v.handAt;
    if (!at) return null;
    const stacker = v.kind === 'stacker';
    // How far ahead of its middle it holds a load.
    const hold = stacker ? STACKER_REACH : v.kind === 'dockhand' ? HAND_REACH : TRAILER_AT;
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
    // Where the game has it stand to work it, facing it: just there,
    // leaning to it as far as it must.
    if (v.stand && (v.kind === 'dockhand' || v.kind === 'forklift')) {
      const { x, y: z, dir } = v.stand;
      const over =
        v.kind === 'dockhand'
          ? Math.min(LEAN_MOST, Math.max(0, Math.hypot(p.x - x, p.z - z) - hold))
          : undefined;
      return { x, z, dir, h: p.y - surfaceY(this.map, x, z), over, fixed: true };
    }
    // At a truck bay, to its stack or the truck in it, from the back corner
    // behind the stack, clear of the truck.
    const corner = v.kind === 'dockhand' && bayStand(this.trucks, v, at);
    if (corner) {
      // On a clear cell of the bay's grid, off its crates and the half its truck stands in.
      const clear = this.staffGrid.nearestFree(
        'dockhand',
        corner.x,
        corner.z,
        0.5,
        WALK_OFF | CELL_TRUCK,
      );
      const { x, z } = clear ?? corner;
      const dir = Math.atan2(p.z - z, p.x - x);
      const over =
        v.kind === 'dockhand'
          ? Math.min(LEAN_MOST, Math.max(0, Math.hypot(p.x - x, p.z - z) - hold))
          : undefined;
      return { x, z, dir, h: p.y - surfaceY(this.map, x, z), over, fixed: true };
    }
    // A dockhand works a crate in crate storage from the gap beside its stack.
    const gap = v.kind === 'dockhand' && at.store !== undefined ? this.standBy(p, drive) : null;
    if (gap) {
      const reach = Math.hypot(p.x - gap.x, p.z - gap.z);
      return {
        x: gap.x,
        z: gap.z,
        dir: Math.atan2(p.z - gap.z, p.x - gap.x),
        h: p.y - surfaceY(this.map, gap.x, gap.z),
        over: Math.min(LEAN_MOST, Math.max(0, reach - hold)),
      };
    }
    // A stacker takes a container side on; a tractor's trailer lies along
    // it; a dockhand comes straight up to the crate.
    const straight = v.kind === 'dockhand' && at.place === undefined;
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
    const clear = (d: number) =>
      !inTruck(this.trucks, drive.x + ux * d, drive.z + uz * d, v.handAt?.truck);
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

  /**
   * How a forklift carries its load, in the shape it goes down in: two by
   * two, or, onto the last column of a truck's bed with an odd number, one
   * crate on the other.
   */
  private onForks(e: Entry): void {
    const v = e.view;
    const at = v.handAt;
    const truck = at?.truck === undefined ? undefined : this.entries.get(at.truck)?.view;
    const per = truck?.bed ? truck.capacity : 0;
    const cols = new Set((at?.slots ?? []).map((s) => Math.floor((s % per) / 2)));
    const upright =
      per > 0 && v.handStage === 'drop' && (at?.slots?.length ?? 0) > 1 && cols.size === 1;
    e.model.crates.forEach((c, k) => {
      if (upright) c.position.set(0.3, 0.04 + k * CRATE, 0);
      else c.position.set(0.3, 0.04 + Math.floor(k / 2) * CRATE, k % 2 ? 0.08 : -0.08);
    });
  }

  /**
   * Which side of a truck these places on its bed are: 1 for its left as
   * it faces (its -z), the side a forklift going in towards +z comes from;
   * -1 for its right.
   */
  private sideOf(truck: Entry, crates: { x: number; z: number }[]): number {
    const r = truck.model.root;
    const dir = -r.rotation.y;
    const across =
      crates.reduce(
        (n, c) => n - (c.x - r.position.x) * Math.sin(dir) + (c.z - r.position.z) * Math.cos(dir),
        0,
      ) / Math.max(1, crates.length);
    return across < 0 ? 1 : -1;
  }

  /** Wakes still showing, strongest first, for the water to draw. */
  wakes(): Wake[] {
    const laid: Track[] = [];
    for (const e of this.entries.values()) if (e.track) laid.push(e.track);
    return this.wash.wakes(laid);
  }

  /** Every boat stirring the water around it, for the sea to draw. */
  stirs(): Stir[] {
    const out: Stir[] = [];
    for (const e of this.entries.values()) if (e.stir) out.push(e.stir);
    return this.wash.stirs(out);
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
    // On a crate truck's bed, `k` is the place itself.
    if (e?.view.bed) return e.model.crates[k];
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
    if (v.deck || v.bed || (v.kind !== 'boat' && (v.kind !== 'truck' || v.boxes))) return;
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
          ? bayFrame(this.trucks, m.idx(tx, tz))
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
