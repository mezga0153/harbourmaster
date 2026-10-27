import { Group, Vector3, type Object3D } from 'three';
import type { EntityView } from '../protocol';
import type { GameMap } from '../sim/map';
import { alertMarker, boat, forklift, person, showLoad, truck, type Model } from './models';
import { surfaceY } from './terrain';

const SNAPSHOT_MS = 100;

interface Entry {
  view: EntityView;
  model: Model;
  alert: Object3D | null;
}

/** Ships, trucks and people, interpolated between sim snapshots. */
export class Entities {
  readonly group = new Group();
  private entries = new Map<number, Entry>();
  private prev = new Map<number, EntityView>();
  private snapTime = 0;

  constructor(private map: GameMap) {}

  push(views: EntityView[], now: number): void {
    this.prev = new Map([...this.entries].map(([id, e]) => [id, e.view]));
    this.snapTime = now;
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
              : v.kind === 'boat'
                ? boat(v.variant, v.vessel)
                : truck(v.variant, v.capacity);
        this.group.add(model.root);
        // Only machines show a warning marker; boats at anchor are normal.
        const alert = v.kind === 'forklift' ? alertMarker() : null;
        if (alert) {
          alert.visible = false;
          this.group.add(alert);
        }
        e = { view: v, model, alert };
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

  private dt = 0;
  private lastTime = 0;

  /** Cross-fade between walking and standing. */
  private animate(model: Model, moving: boolean): void {
    const want = moving ? 'walk' : 'idle';
    const current = model.root.userData.anim as string | undefined;
    if (current === want) return;
    const next = model.actions?.get(want);
    if (!next) return;
    const prev = current ? model.actions?.get(current) : undefined;
    next.reset().play();
    if (prev) next.crossFadeFrom(prev, 0.2, false);
    model.root.userData.anim = want;
  }

  update(now: number, time: number): void {
    this.dt = this.lastTime ? Math.min(0.1, time - this.lastTime) : 0;
    this.lastTime = time;
    const t = Math.min(1, (now - this.snapTime) / SNAPSHOT_MS);
    for (const [id, e] of this.entries) {
      const cur = e.view;
      const prev = this.prev.get(id) ?? cur;
      const x = prev.x + (cur.x - prev.x) * t;
      const y = prev.y + (cur.y - prev.y) * t;
      const dir = lerpAngle(prev.dir, cur.dir, t);
      const root = e.model.root;
      root.rotation.y = -dir;

      if (cur.kind === 'boat') {
        root.position.set(x, Math.sin(time * 1.6 + id) * 0.025, y);
        root.rotation.z = Math.sin(time * 1.1 + id) * 0.025;
      } else if (cur.kind === 'dockhand' || cur.kind === 'forklift') {
        // Keep to the right of the tile, so people going opposite ways pass.
        const keep = cur.kind === 'forklift' ? 0.16 : 0.2;
        const rx = x - Math.sin(dir) * keep;
        const ry = y + Math.cos(dir) * keep;
        root.position.set(rx, surfaceY(this.map, rx, ry), ry);
      } else {
        root.position.set(x, surfaceY(this.map, x, y), y);
      }
      if (e.model.body && cur.kind === 'dockhand') {
        e.model.body.position.y = cur.moving ? Math.abs(Math.sin(time * 14 + id)) * 0.03 : 0;
      }
      if (e.model.mixer) {
        this.animate(e.model, cur.moving);
        e.model.mixer.update(this.dt);
      }
      if (e.alert) {
        e.alert.visible = cur.alert;
        e.alert.position.set(x, root.position.y + 0.75 + Math.sin(time * 4) * 0.05, y);
      }
    }
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
