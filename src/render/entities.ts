import { Group, Vector3, type Object3D } from 'three';
import { VESSELS } from '../sim/balance';
import type { EntityView } from '../protocol';
import type { GameMap } from '../sim/map';
import { isMachineKind } from '../sim/machines';
import { TICKS_PER_SECOND } from '../sim/types';
import {
  alertMarker,
  boat,
  forklift,
  person,
  paintLoad,
  showLoad,
  stacker,
  tractor,
  truck,
  type Model,
} from './models';
import { pose } from './people';
import { surfaceY } from './terrain';

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
      showLoad(e.model, v.load);
      if (v.looks) paintLoad(e.model, v.looks);
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
      } else if (cur.kind === 'dockhand' || isMachineKind(cur.kind)) {
        // Keep to the right of the tile, so people going opposite ways pass.
        const keep = cur.kind === 'forklift' ? 0.16 : 0.2;
        const rx = x - Math.sin(dir) * keep;
        const ry = y + Math.cos(dir) * keep;
        root.position.set(rx, surfaceY(this.map, rx, ry), ry);
      } else {
        root.position.set(x, surfaceY(this.map, x, y), y);
      }
      if (cur.kind === 'dockhand') pose(e.model, cur.moving, cur.load > 0, time * 12 + id);
      if (e.alert) {
        e.alert.visible = cur.alert;
        e.alert.position.set(x, root.position.y + 0.75 + Math.sin(time * 4) * 0.05, y);
      }
    }
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

  /** Where a truck's container slot `k` is in the world, or null. */
  slotPosition(id: number, k: number, out: Vector3): Vector3 | null {
    const slot = this.entries.get(id)?.model.crates[k];
    return slot ? slot.getWorldPosition(out) : null;
  }

  worldPositions(): { view: EntityView; pos: Vector3 }[] {
    return [...this.entries.values()].map((e) => ({ view: e.view, pos: e.model.root.position }));
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
