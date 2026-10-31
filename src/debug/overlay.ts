import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
} from 'three';
import type { GameMap } from '../sim/map';
import { surfaceY } from '../render/terrain';
import {
  PASS_BLOCKED,
  PASS_COSTLY,
  PASS_HIDDEN,
  PASS_OK,
  type DebugGrid,
  type DebugSlots,
} from './types';

// Dev server only: the debug overlays drawn over the map. Cells of any size
// from a grid, lines (paths, the road graph, borders) and little squares
// for crate slots, each layer kept to itself and drawn on top of the port.

const PASS_COLOR: Record<number, Color> = {
  [PASS_OK]: new Color(0x3ddc68),
  [PASS_COSTLY]: new Color(0xf5c02a),
  [PASS_BLOCKED]: new Color(0xff3b30),
};
const SLOT_FREE = new Color(0x55606e);
const SLOT_USED = new Color(0x4fb3ff);
const SLOT_KEPT = new Color(0xff9f1c);
const SLOT_BOTH = new Color(0xff2bd6);

/** A point on the ground in tile space, and its colour. */
export interface DebugPoint {
  x: number;
  z: number;
}

/**
 * Lines as pairs of points, each pair one colour, `lift` over the ground
 * under it: hairlines, or with `width` flat ribbons that many tiles wide,
 * which show from further out.
 */
export class LineLayer {
  readonly lines: LineSegments | Mesh;
  constructor(
    order: number,
    opacity = 0.95,
    private readonly width = 0,
  ) {
    const material = {
      vertexColors: true,
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false,
    };
    this.lines =
      width > 0
        ? new Mesh(new BufferGeometry(), new MeshBasicMaterial({ ...material, side: DoubleSide }))
        : new LineSegments(new BufferGeometry(), new LineBasicMaterial(material));
    this.lines.renderOrder = order;
    this.lines.frustumCulled = false;
  }

  set(
    map: GameMap | null,
    segs: { a: DebugPoint; b: DebugPoint; color: Color }[],
    lift = 0.1,
  ): void {
    const per = this.width > 0 ? 6 : 2;
    const pos = new Float32Array(segs.length * per * 3);
    const col = new Float32Array(segs.length * per * 3);
    const half = this.width / 2;
    segs.forEach(({ a, b, color }, k) => {
      const ya = map ? surfaceY(map, a.x, a.z) + lift : lift;
      const yb = map ? surfaceY(map, b.x, b.z) + lift : lift;
      if (per === 2) pos.set([a.x, ya, a.z, b.x, yb, b.z], k * 6);
      else {
        const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const [ox, oz] = [(-(b.z - a.z) / len) * half, ((b.x - a.x) / len) * half];
        const [p, q, r, t] = [
          [a.x + ox, ya, a.z + oz],
          [a.x - ox, ya, a.z - oz],
          [b.x - ox, yb, b.z - oz],
          [b.x + ox, yb, b.z + oz],
        ];
        pos.set([...p, ...q, ...r, ...p, ...r, ...t], k * 18);
      }
      for (let v = 0; v < per; v++) col.set([color.r, color.g, color.b], (k * per + v) * 3);
    });
    this.lines.geometry.dispose();
    this.lines.geometry = new BufferGeometry();
    this.lines.geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
    this.lines.geometry.setAttribute('color', new Float32BufferAttribute(col, 3));
    this.lines.visible = segs.length > 0;
  }
}

/** Flat squares, each its own size and colour, laid on the ground. */
export class SquareLayer {
  mesh: InstancedMesh;
  private readonly group: Group;
  private readonly material: MeshBasicMaterial;
  private readonly plane: PlaneGeometry;
  private readonly order: number;

  constructor(group: Group, order: number, opacity: number) {
    this.group = group;
    this.order = order;
    this.plane = new PlaneGeometry(1, 1);
    this.plane.rotateX(-Math.PI / 2);
    this.material = new MeshBasicMaterial({
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = this.make(256);
  }

  private make(n: number): InstancedMesh {
    const mesh = new InstancedMesh(this.plane, this.material, n);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = this.order;
    this.group.add(mesh);
    return mesh;
  }

  /** Squares centred on x, z, `size` across, `lift` over the ground there. */
  set(
    map: GameMap | null,
    squares: { x: number; z: number; size: number; color: Color; lift?: number }[],
  ): void {
    if (squares.length > this.mesh.instanceMatrix.count) {
      this.group.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = this.make(Math.ceil(squares.length * 1.25));
    }
    const m = new Matrix4();
    squares.forEach((s, k) => {
      const y = (map ? surfaceY(map, s.x, s.z) : 0) + (s.lift ?? 0.06);
      m.makeScale(s.size, 1, s.size).setPosition(s.x, y, s.z);
      this.mesh.setMatrixAt(k, m);
      this.mesh.setColorAt(k, s.color);
    });
    this.mesh.count = squares.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  clear(): void {
    this.mesh.count = 0;
  }
}

/** The cells of a grid that show, as squares a little smaller than the cell, to see the grid by. */
export function gridSquares(grid: DebugGrid, lift = 0.06) {
  const out: { x: number; z: number; size: number; color: Color; lift: number }[] = [];
  const size = grid.cell * (grid.cell < 1 ? 0.86 : 0.92);
  for (let k = 0; k < grid.values.length; k++) {
    const v = grid.values[k];
    if (v === PASS_HIDDEN) continue;
    out.push({
      x: grid.x0 + ((k % grid.nx) + 0.5) * grid.cell,
      z: grid.y0 + (Math.floor(k / grid.nx) + 0.5) * grid.cell,
      size,
      color: PASS_COLOR[v] ?? PASS_COLOR[PASS_BLOCKED],
      lift,
    });
  }
  return out;
}

/**
 * Each slot of a bay or storage area as a little square on its tile: four
 * across (row by side) and four up the tile (layer), a large bay's second
 * layer smaller on its first; grey free (to draw fainter), blue with a crate, amber kept for
 * a load on its way, pink both (which should not happen).
 */
export function slotSquares(map: GameMap, slots: DebugSlots[]) {
  type Sq = { x: number; z: number; size: number; color: Color; lift: number };
  const free: Sq[] = [];
  const held: Sq[] = [];
  for (const b of slots) {
    if (b.cap === 0) continue;
    const used = new Set(b.used);
    const kept = new Set(b.kept);
    for (let s = 0; s < b.cap; s++) {
      const tile = b.tiles[Math.floor(s / b.perStack)];
      if (tile === undefined) continue;
      const k = s % b.perStack;
      let col: number;
      let row: number;
      let size = 0.2;
      if (b.perStack === 16) {
        // slot = row * 8 + layer * 2 + side
        col = Math.floor(k / 8) * 2 + (k % 2);
        row = Math.floor((k % 8) / 2);
      } else {
        col = k % 4;
        row = Math.floor((k % 16) / 4);
        if (k >= 16) size = 0.11;
      }
      const u = used.has(s);
      const r = kept.has(s);
      (u || r ? held : free).push({
        x: map.xOf(tile) + 0.125 + col * 0.25,
        z: map.yOf(tile) + 0.125 + row * 0.25,
        size,
        color: u && r ? SLOT_BOTH : u ? SLOT_USED : r ? SLOT_KEPT : SLOT_FREE,
        lift: 0.05 + (size < 0.2 ? 0.01 : 0),
      });
    }
  }
  return { free, held };
}
