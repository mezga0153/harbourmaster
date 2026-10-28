import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  type Object3D,
} from 'three';
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
  /** Boats: the foam they leave behind, and how far they lean in a turn. */
  wake?: Mesh;
  heel?: number;
}

const wakeMaterial = new MeshBasicMaterial({
  color: 0xffffff,
  vertexColors: true,
  transparent: true,
  depthWrite: false,
  side: DoubleSide,
});

/**
 * Foam around a hull: a bow wave either side of the stem and a widening
 * wake behind the stern, fading out. Faces +X like the boats.
 */
function wakeMesh(length: number, beam: number): Mesh {
  const bow = length / 2;
  const stern = -length / 2;
  const tail = stern - length * 1.1;
  const spread = beam * 1.2;
  const v = (x: number, z: number) => [x, 0, z];
  const pos = [
    // Bow wave: two thin wedges along the bow.
    ...v(bow, 0),
    ...v(bow - 0.35, beam * 0.62),
    ...v(bow - 0.25, beam * 0.5),
    ...v(bow, 0),
    ...v(bow - 0.25, -beam * 0.5),
    ...v(bow - 0.35, -beam * 0.62),
    // Wake: a fan behind the stern.
    ...v(stern, beam * 0.45),
    ...v(tail, spread),
    ...v(tail, -spread),
    ...v(stern, beam * 0.45),
    ...v(tail, -spread),
    ...v(stern, -beam * 0.45),
  ];
  const a = (x: number) => (x === tail ? 0 : x <= stern ? 0.32 : x === bow ? 0.7 : 0.2);
  const col: number[] = [];
  for (let k = 0; k < pos.length; k += 3) col.push(1, 1, 1, a(pos[k]));
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new Float32BufferAttribute(col, 4));
  const m = new Mesh(geo, wakeMaterial.clone());
  m.position.y = 0.01;
  m.renderOrder = 1;
  return m;
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
          const hull = VESSELS[(v.vessel ?? 'smack') as keyof typeof VESSELS];
          e.wake = wakeMesh(hull.length, hull.beam);
          e.heel = 0;
          model.root.add(e.wake);
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
        const way = Math.min(1, Math.hypot(cur.x - prev.x, cur.y - prev.y) / hull.speed);
        const turn = lerpAngle(prev.dir, cur.dir, 1) - prev.dir;
        const lean = Math.max(-0.12, Math.min(0.12, -turn * 3 * way));
        e.heel = (e.heel ?? 0) + (lean - (e.heel ?? 0)) * 0.08;
        root.position.set(x, Math.sin(time * 1.6 + id) * 0.025, y);
        root.rotation.x = e.heel + Math.sin(time * 0.9 + id * 2) * 0.02;
        root.rotation.z = Math.sin(time * 1.1 + id) * 0.02 + way * 0.025;
        if (e.wake) {
          const mat = e.wake.material as MeshBasicMaterial;
          mat.opacity += (way - mat.opacity) * 0.1;
          e.wake.visible = mat.opacity > 0.02;
        }
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
