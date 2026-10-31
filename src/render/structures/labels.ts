import {
  CanvasTexture,
  Group,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  type Object3D,
} from 'three';
import type { BayView, ParkingView, YardView } from '../../protocol';
import type { GameMap } from '../../sim/map';
import { Build, isPublicRoad } from '../../sim/types';
import { KeyedObjects } from '../keyed';
import { C } from '../palette';
import { landTop, QUAY_Y } from '../terrain';

// Each place's designation (see sim/designations.ts): on a truck bay's sign,
// and painted on the ground of a storage area, container yard or parking
// lot like a road marking, along its edge facing the road, outside where
// the goods are stacked. Each string's texture is drawn once and shared.

/** How each kind of place's designation is painted. */
type Style = 'sign' | 'dark' | 'white' | 'blue';

const plane = new PlaneGeometry(1, 1);
const looks = new Map<string, { mat: MeshLambertMaterial; aspect: number }>();

/** The material with `text` painted in `style`, made the first time it is asked for. */
function look(text: string, style: Style): { mat: MeshLambertMaterial; aspect: number } | null {
  const key = `${style}:${text}`;
  const had = looks.get(key);
  if (had) return had;
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  const g = cv.getContext('2d');
  if (!g) return null;
  const font = 'bold 52px "Arial Narrow", Arial, sans-serif';
  g.font = font;
  const wide = Math.ceil(g.measureText(text).width);
  if (style === 'sign') {
    // White on the sign's blue, filling its face.
    cv.width = 88;
    cv.height = 64;
    g.fillStyle = `#${C.sign.toString(16).padStart(6, '0')}`;
    g.fillRect(0, 0, cv.width, cv.height);
    g.strokeStyle = '#e8eef8';
    g.lineWidth = 3;
    g.strokeRect(4, 4, cv.width - 8, cv.height - 8);
    g.font = font;
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const fit = Math.min(1, (cv.width - 16) / wide);
    g.setTransform(fit, 0, 0, 1, cv.width / 2, cv.height / 2 + 3);
    g.fillText(text, 0, 0);
  } else {
    // Paint on the ground, a little worn.
    cv.width = wide + 8;
    cv.height = 56;
    g.font = font;
    const paint = { dark: 0x3b4148, white: C.marking, blue: C.sign }[style];
    g.fillStyle = `#${paint.toString(16).padStart(6, '0')}`;
    g.globalAlpha = 0.85;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, cv.width / 2, cv.height / 2 + 3);
  }
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new MeshLambertMaterial({
    map: tex,
    transparent: style !== 'sign',
    depthWrite: style === 'sign',
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const made = { mat, aspect: cv.width / cv.height };
  looks.set(key, made);
  return made;
}

/** A place painted on the ground: where, which way it reads, and in what. */
interface Spot {
  text: string;
  style: Style;
  tile: number;
  /** The way out of the area across the edge it is painted along. */
  dx: number;
  dy: number;
  y: number;
  /** Letter height, and how far in from the edge their middle is. */
  size: number;
  inset: number;
}

/**
 * How big the letters are and how far in from the edge: in the strip a
 * crate storage tile's pallets leave along its long sides, the narrower
 * one beside a yard's containers, and across a parking lot's end.
 */
const FIT = {
  crates: { size: 0.2, inset: 0.115 },
  boxes: { size: 0.15, inset: 0.095 },
  parking: { size: 0.2, inset: 0.15 },
};

const ROADS = new Set<number>([Build.PortRoad, Build.Gate]);

export class Designations {
  readonly group = new Group();
  private painted = new KeyedObjects<string, { key: string; mesh: Mesh }>((p) =>
    this.group.remove(p.mesh),
  );

  /** Each truck bay tile's sign, found once per drawing of the tile. */
  private signs = new WeakMap<Object3D, Object3D>();

  constructor(
    private map: GameMap,
    private tileObject: (i: number) => Object3D | undefined,
  ) {}

  /** Bring the signs and markings up to date with the snapshot; cheap when nothing changed. */
  set(bays: BayView[], yards: YardView[], parking: ParkingView[]): void {
    const spots = new Map<string, Spot>();
    for (const b of bays) {
      if (!b.name) continue;
      if (!b.tiles) {
        this.sign(b.idx, b.name);
        continue;
      }
      this.edge(b.tiles, b.name, b.outgoing ? 'blue' : 'dark', 'crates').forEach((spot, k) =>
        spots.set(`s${b.idx}:${k}`, spot),
      );
    }
    for (const y of yards) {
      if (!y.name) continue;
      this.edge(y.tiles, y.name, y.outgoing ? 'blue' : 'dark', 'boxes').forEach((spot, k) =>
        spots.set(`y${y.idx}:${k}`, spot),
      );
    }
    for (const lot of parking) {
      if (!lot.name) continue;
      this.edge(lot.tiles, lot.name, lot.outside ? 'white' : 'dark', 'parking').forEach(
        (spot, k) => {
          // On asphalt outside the port, as tiles.ts lays it.
          if (lot.outside) spot.y = landTop(this.map.terrain[spot.tile]) + 0.05;
          spots.set(`p${lot.tiles[0]}:${k}`, spot);
        },
      );
    }
    for (const k of [...this.painted.keys()]) if (!spots.has(k)) this.painted.delete(k);
    for (const [k, s] of spots) {
      const key = `${s.text}|${s.style}|${s.tile}|${s.dx}|${s.dy}|${s.y}`;
      if (this.painted.get(k)?.key === key) continue;
      const mesh = this.paint(s);
      if (mesh) this.painted.set(k, { key, mesh });
      else this.painted.delete(k);
    }
  }

  /** A truck bay's designation on both faces of its sign, again when the tile is redrawn. */
  private sign(idx: number, name: string): void {
    const obj = this.tileObject(idx);
    if (!obj) return;
    let sign = this.signs.get(obj);
    if (!sign) {
      obj.traverse((o) => {
        if (o.userData.baySign) sign = o;
      });
      if (!sign) return;
      this.signs.set(obj, sign);
    }
    if (sign.userData.label === name) return;
    const made = look(name, 'sign');
    if (!made) return;
    sign.clear();
    // The sign is a unit box scaled: its faces are at ±0.5 across x.
    for (const side of [1, -1]) {
      const face = new Mesh(plane, made.mat);
      face.position.x = side * 0.56;
      face.rotation.y = (side * Math.PI) / 2;
      face.scale.set(0.92, 0.9, 1);
      sign.add(face);
    }
    sign.userData.label = name;
  }

  /**
   * Where to paint an area's designation: on the edge of the corner-most
   * tile facing a road, along the area's long side where the goods leave
   * a strip clear, or any outer edge if no road is beside it; and again
   * straight across on the far side, so one shows past the stacks
   * whichever way the view is turned.
   */
  private edge(tiles: number[], text: string, style: Style, kind: keyof typeof FIT): Spot[] {
    const store = kind !== 'parking';
    const m = this.map;
    if (tiles.length === 0) return [];
    const own = new Set(tiles);
    const xs = tiles.map((t) => m.xOf(t));
    const ys = tiles.map((t) => m.yOf(t));
    // As the goods are laid out: along x if it is at least as long that way.
    const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
    let best: { tile: number; dx: number; dy: number; score: number } | null = null;
    for (const t of tiles) {
      for (const [dx, dy] of [
        [0, 1],
        [1, 0],
        [0, -1],
        [-1, 0],
      ]) {
        const x = m.xOf(t) + dx;
        const y = m.yOf(t) + dy;
        const n = m.inBounds(x, y) ? m.idx(x, y) : -1;
        if (n >= 0 && own.has(n)) continue;
        const b = n >= 0 ? m.build[n] : Build.None;
        const road = n >= 0 && !m.store[n] && (ROADS.has(b) || isPublicRoad(b));
        const quay = n >= 0 && !m.store[n] && b === Build.Quay;
        // Storage: along the long side, by a road. Parking: across an end,
        // off the roads trucks drive in and out by.
        const long = alongX ? dy !== 0 : dx !== 0;
        const score = store
          ? (road ? 0 : quay ? 2 : 4) + (long || tiles.length === 1 ? 0 : 1)
          : (road ? 2 : 0) + (long ? 1 : 0);
        if (!best || score < best.score || (score === best.score && t < best.tile)) {
          best = { tile: t, dx, dy, score };
        }
      }
    }
    if (!best) return [];
    const { dx, dy } = best;
    let far = best.tile;
    for (;;) {
      const x = m.xOf(far) - dx;
      const y = m.yOf(far) - dy;
      if (!m.inBounds(x, y) || !own.has(m.idx(x, y))) break;
      far = m.idx(x, y);
    }
    const spot = (tile: number, dx: number, dy: number): Spot => ({
      text,
      style,
      tile,
      dx,
      dy,
      y: QUAY_Y,
      ...FIT[kind],
    });
    return [spot(best.tile, dx, dy), spot(far, -dx, -dy)];
  }

  private paint(s: Spot): Mesh | null {
    const made = look(s.text, s.style);
    if (!made) return null;
    const m = this.map;
    const mesh = new Mesh(plane, made.mat);
    mesh.receiveShadow = true;
    mesh.scale.set(s.size * made.aspect, s.size, 1);
    // Flat on the ground, the tops of the letters away from the road.
    mesh.rotation.order = 'YXZ';
    mesh.rotation.set(-Math.PI / 2, Math.atan2(s.dx, s.dy), 0);
    const off = 0.5 - s.inset;
    mesh.position.set(
      m.xOf(s.tile) + 0.5 + s.dx * off,
      s.y + 0.009,
      m.yOf(s.tile) + 0.5 + s.dy * off,
    );
    this.group.add(mesh);
    return mesh;
  }
}
