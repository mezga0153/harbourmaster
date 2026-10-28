import { Group, Vector3, type Object3D } from 'three';
import { VESSELS } from '../sim/balance';
import type { EntityView } from '../protocol';
import type { GameMap } from '../sim/map';
import {
  alertMarker,
  boat,
  forklift,
  person,
  showLoad,
  stacker,
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
  /** Boats: where they have been, how hard they are going and how far they lean. */
  trail?: WakePoint[];
  way?: number;
  lead?: [number, number];
  /** The other end of the hull at the waterline, which the wake runs along to. */
  tail?: [number, number];
  /** Going ahead (the wake starts at the bow) or astern (at the stern). */
  ahead?: boolean;
  /** The wake left behind before the boat last changed direction, settling. */
  ghost?: { lead: [number, number]; trail: WakePoint[]; way: number; time: number };
  heel?: number;
}

/** Most boats whose wakes are drawn, and points kept along each wake. */
export const WAKE_BOATS = 12;
export const WAKE_POINTS = 16;
/** Seconds a wake takes to settle once the boat stops. */
const WAKE_LIFE = 6;
/** Half the waterline length, as a share of the whole hull. */
const WATERLINE = 0.45;
/** How quickly a wake builds up and dies away, per second. */
const WAKE_RISE = 0.45;
const WAKE_FALL = 0.3;

/** A wake barely shows while a boat is just getting under way. */
function wakeStrength(way: number): number {
  const w = Math.min(1, Math.max(0, way));
  return w * w * (3 - 2 * w);
}

interface WakePoint {
  x: number;
  z: number;
  /** How hard the boat was going when it passed here. */
  way: number;
  time: number;
}

/** A boat's track through the water, newest first, for the sea to churn up. */
export interface Wake {
  /** x, z, distance back from the leading end, strength. */
  points: [number, number, number, number][];
  beam: number;
  length: number;
  /** How far back the wake reaches, longer the faster the boat goes. */
  reach: number;
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
  private lastTime = 0;

  constructor(private map: GameMap) {}

  push(views: EntityView[], now: number, tick: number): void {
    this.prev = new Map([...this.entries].map(([id, e]) => [id, e.view]));
    this.snapTime = now;
    this.snapTicks = this.lastTick < 0 ? 1 : Math.max(1, tick - this.lastTick);
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
                : v.kind === 'boat'
                  ? boat(v.variant, v.vessel, v.id)
                  : truck(v.variant, v.capacity, v.boxes, v.id);
        this.group.add(model.root);
        // Only machines show a warning marker; boats at anchor are normal.
        const alert = v.kind === 'forklift' || v.kind === 'stacker' ? alertMarker() : null;
        if (alert) {
          alert.visible = false;
          this.group.add(alert);
        }
        e = { view: v, model, alert };
        if (v.kind === 'boat') {
          e.trail = [];
          e.way = 0;
          e.heel = 0;
          model.root.rotation.order = 'YXZ';
        }
        this.entries.set(v.id, e);
      }
      e.view = v;
      showLoad(e.model, v.load);
    }
    for (const [id, e] of this.entries) {
      if (!seen.has(id)) {
        this.group.remove(e.model.root);
        if (e.alert) this.group.remove(e.alert);
        this.entries.delete(id);
      }
    }
  }

  update(now: number, time: number): void {
    const t = Math.min(1, (now - this.snapTime) / SNAPSHOT_MS);
    const dt = Math.min(0.1, time - this.lastTime);
    this.lastTime = time;
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
        // The wake builds up slowly as the boat gathers way, over a few
        // seconds whatever the game speed, and lingers a while longer still
        // once it stops.
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
        if (ahead !== (e.ahead ?? true) && e.lead) {
          e.ghost = { lead: e.lead, trail: e.trail!, way: e.way, time };
          e.trail = [];
          // It has only just started back the other way.
          e.way = Math.min(e.way, way);
        }
        e.ahead = ahead;
        // From the stem where it meets the water, a little behind the tip of
        // the deck, along the hull to the other end.
        const reach = (ahead ? 1 : -1) * hull.length * WATERLINE;
        const lx = x + Math.cos(dir) * reach;
        const lz = y + Math.sin(dir) * reach;
        e.lead = [lx, lz];
        e.tail = [x - Math.cos(dir) * reach, y - Math.sin(dir) * reach];
        const trail = e.trail!;
        const spacing = (hull.length + 3.5) / (WAKE_POINTS - 2);
        const last = trail[0];
        if (!last || Math.hypot(lx - last.x, lz - last.z) > spacing) {
          if (e.way > 0.05 || last) trail.unshift({ x: lx, z: lz, way: e.way, time });
          if (trail.length > WAKE_POINTS - 1) trail.pop();
        }
        while (trail.length && time - trail[trail.length - 1].time > WAKE_LIFE * 4) trail.pop();
      } else if (cur.kind === 'dockhand' || cur.kind === 'forklift' || cur.kind === 'stacker') {
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

  /** Wakes of the boats under way, strongest first, for the water to draw. */
  wakes(time: number): Wake[] {
    const out: Wake[] = [];
    const settle = (t: number) => Math.max(0, 1 - (time - t) / WAKE_LIFE);
    for (const e of this.entries.values()) {
      if (!e.trail || !e.lead) continue;
      const hull = VESSELS[(e.view.vessel ?? 'smack') as keyof typeof VESSELS];
      const add = (
        lead: [number, number],
        trail: WakePoint[],
        way: number,
        head: number,
        tail?: [number, number],
      ) => {
        const points: Wake['points'] = [[lead[0], lead[1], 0, head]];
        let s = 0;
        // Alongside the hull the wake follows the hull itself, turning with
        // it, rather than the chord back to where the bow was a while ago.
        let along = trail;
        if (tail) {
          s = Math.hypot(tail[0] - lead[0], tail[1] - lead[1]);
          points.push([tail[0], tail[1], s, head]);
          along = trail.filter((p) => Math.hypot(p.x - lead[0], p.z - lead[1]) > s);
        }
        for (const p of along) {
          const [px, pz] = points[points.length - 1];
          s += Math.hypot(p.x - px, p.z - pz);
          points.push([p.x, p.z, s, wakeStrength(p.way) * settle(p.time)]);
        }
        if (points.length < 2 || points.every((p) => p[3] < 0.02)) return false;
        // Always past the stern, so the wake grows out from behind the boat
        // as it picks up speed rather than popping out from under the hull.
        const reach = hull.length + (hull.length * 0.5 + 3) * wakeStrength(way);
        out.push({ points, beam: hull.beam, length: hull.length, reach });
        return true;
      };
      add(e.lead, e.trail, e.way ?? 0, wakeStrength(e.way ?? 0), e.tail);
      const g = e.ghost;
      if (g && !add(g.lead, g.trail, g.way, wakeStrength(g.way) * settle(g.time))) {
        e.ghost = undefined;
      }
    }
    const strength = (w: Wake) => w.points.reduce((a, p) => a + p[3], 0);
    return out.sort((a, b) => strength(b) - strength(a)).slice(0, WAKE_BOATS);
  }

  /** Current world position, for the selection ring and info panel. */
  positionOf(id: number, out: Vector3): Vector3 | null {
    const e = this.entries.get(id);
    return e ? out.copy(e.model.root.position) : null;
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
