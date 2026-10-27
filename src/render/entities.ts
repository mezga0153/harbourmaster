import { Group, Vector3 } from 'three';
import type { EntityView } from '../protocol';
import type { GameMap } from '../sim/map';
import { boat, person, showLoad, truck, type Model } from './models';
import { surfaceY } from './terrain';

const SNAPSHOT_MS = 100;

interface Entry {
  view: EntityView;
  model: Model;
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
            ? person()
            : v.kind === 'boat'
              ? boat(v.variant)
              : truck(v.variant, v.capacity);
        this.group.add(model.root);
        e = { view: v, model };
        this.entries.set(v.id, e);
      }
      e.view = v;
      showLoad(e.model, v.load);
    }
    for (const [id, e] of this.entries) {
      if (!seen.has(id)) {
        this.group.remove(e.model.root);
        this.entries.delete(id);
      }
    }
  }

  update(now: number, time: number): void {
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
      } else {
        root.position.set(x, surfaceY(this.map, x, y), y);
      }
      if (e.model.body) {
        e.model.body.position.y = cur.moving ? Math.abs(Math.sin(time * 14 + id)) * 0.03 : 0;
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
