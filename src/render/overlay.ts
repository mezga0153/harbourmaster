import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineLoop,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  type Vector3,
} from 'three';
import type { GameMap } from '../sim/map';
import { FACING } from '../sim/rules';
import { surfaceY } from './terrain';

const MAX_GHOSTS = 4096;
const OK = new Color(0x5fdc7a);
const BAD = new Color(0xff5a4f);
const ROUTE = new Color(0x4fb3ff);

/** What a tinted tile shows: ground kept for machines, a crane's reach, where trucks load. */
export type HintKind = 'zone' | 'reach' | 'spot' | 'good';
const HINT: Record<HintKind, Color> = {
  zone: new Color(0xff4a3d),
  reach: new Color(0x4fb3ff),
  spot: new Color(0xf5c02a),
  good: new Color(0x5fdc7a),
};
export type Hints = { kind: HintKind; tiles: number[] }[];

/**
 * How the port's plots of land are shown: not at all, the land it does not
 * own faintly shaded while a build tool is in hand, or with the Land tool,
 * plots for sale outlined and the rest dimmed. See setLand.
 */
export type LandView =
  | { mode: 'off' }
  | { mode: 'edge'; plots: number[] }
  | { mode: 'tool'; forSale: number[]; dim: number[]; hover: number; hoverOk: boolean };
/** Just over the tops of jetties and quays, so plots lie flat over the port. */
const LAND_Y = 0.46;

/** Hover outline, build previews and the selection ring. */
export class Overlay {
  readonly group = new Group();
  private hover: LineLoop;
  private ghosts: InstancedMesh;
  private ring: Mesh;
  private arrow: Mesh;
  private reach: InstancedMesh;
  /** Tiles tinted to explain a tool in hand or what is selected; see setHints. */
  private hints: InstancedMesh;
  private hintSets: Record<'tool' | 'selection', Hints> = { tool: [], selection: [] };
  /** The marked ways in and out, through the buoys in order. */
  private channels: LineSegments[];
  /** Where a selected boat plots it will be, and the boat it is giving way to. */
  private plots: Line[];
  /** The port's plots of land: the shade over land it does not own, plots for sale, the one pointed at. */
  private landDim: Mesh;
  private landFaint: Mesh;
  private landSale: Mesh;
  private landHover: Mesh;
  private landLines: LineSegments;

  constructor() {
    const square = new BufferGeometry();
    square.setAttribute(
      'position',
      new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], 3),
    );
    this.hover = new LineLoop(
      square,
      new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
    );
    this.hover.visible = false;

    const plane = new PlaneGeometry(0.94, 0.94);
    plane.rotateX(-Math.PI / 2);
    plane.translate(0.5, 0, 0.5);
    this.ghosts = new InstancedMesh(
      plane,
      new MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false }),
      MAX_GHOSTS,
    );
    this.ghosts.count = 0;
    this.ghosts.frustumCulled = false;

    const ring = new RingGeometry(0.32, 0.4, 24);
    ring.rotateX(-Math.PI / 2);
    this.ring = new Mesh(
      ring,
      new MeshBasicMaterial({
        color: 0xffd23f,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      }),
    );
    this.ring.renderOrder = 10;
    this.ring.visible = false;

    // Points out of a building's front while it is being placed: a shaft
    // from just inside the front edge (z = 0) and a head beyond it, along +z.
    // Drawn from both sides, so it shows whichever way its faces wind.
    const arrow = new BufferGeometry();
    const [w, h, back, neck, tip] = [0.08, 0.24, -0.3, 0.18, 0.55];
    arrow.setAttribute(
      'position',
      new Float32BufferAttribute(
        [
          ...[-w, 0, back, w, 0, neck, w, 0, back],
          ...[-w, 0, back, -w, 0, neck, w, 0, neck],
          ...[-h, 0, neck, 0, 0, tip, h, 0, neck],
        ],
        3,
      ),
    );
    this.arrow = new Mesh(
      arrow,
      new MeshBasicMaterial({
        color: 0xffd23f,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        side: DoubleSide,
      }),
    );
    this.arrow.renderOrder = 10;
    this.arrow.visible = false;

    this.reach = new InstancedMesh(
      plane,
      new MeshBasicMaterial({ transparent: true, opacity: 0.4, depthWrite: false }),
      MAX_GHOSTS,
    );
    this.reach.count = 0;
    this.reach.frustumCulled = false;

    this.hints = new InstancedMesh(
      plane,
      new MeshBasicMaterial({ transparent: true, opacity: 0.32, depthWrite: false }),
      MAX_GHOSTS,
    );
    this.hints.count = 0;
    this.hints.frustumCulled = false;

    this.channels = [0x3fd06a, 0xff6a5c].map((color) => {
      const line = new LineSegments(
        new BufferGeometry(),
        new LineDashedMaterial({
          color,
          dashSize: 0.4,
          gapSize: 0.25,
          transparent: true,
          opacity: 0.9,
        }),
      );
      line.visible = false;
      line.frustumCulled = false;
      return line;
    });

    this.plots = [0xffd23f, 0xff8a3d].map((color) => {
      const line = new Line(
        new BufferGeometry(),
        new LineDashedMaterial({
          color,
          dashSize: 0.3,
          gapSize: 0.2,
          transparent: true,
          opacity: 0.95,
          depthTest: false,
        }),
      );
      line.renderOrder = 10;
      line.visible = false;
      line.frustumCulled = false;
      return line;
    });

    const flat = (color: number, opacity: number) => {
      const mesh = new Mesh(
        new BufferGeometry(),
        new MeshBasicMaterial({
          color,
          transparent: true,
          opacity,
          depthTest: false,
          depthWrite: false,
          side: DoubleSide,
        }),
      );
      mesh.renderOrder = 5;
      mesh.frustumCulled = false;
      mesh.visible = false;
      return mesh;
    };
    this.landDim = flat(0x0b1220, 0.42);
    this.landFaint = flat(0x0b1220, 0.16);
    this.landSale = flat(0xffd23f, 0.08);
    this.landHover = flat(0xffd23f, 0.22);
    this.landLines = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.landLines.renderOrder = 6;
    this.landLines.frustumCulled = false;
    this.landLines.visible = false;

    this.group.add(
      this.landDim,
      this.landFaint,
      this.landSale,
      this.landHover,
      this.landLines,
      this.hover,
      this.ghosts,
      this.ring,
      this.arrow,
      this.reach,
      this.hints,
      ...this.channels,
      ...this.plots,
    );
  }

  /**
   * The course a selected boat plots, as x, y pairs, and that of the boat it
   * is giving way to; null hides one.
   */
  setPlots(plots: [number[] | null, number[] | null]): void {
    plots.forEach((plot, k) => {
      const line = this.plots[k];
      line.visible = !!plot && plot.length >= 4;
      if (!plot || !line.visible) return;
      const pos: number[] = [];
      for (let j = 0; j + 1 < plot.length; j += 2) pos.push(plot[j], 0.08, plot[j + 1]);
      line.geometry.dispose();
      line.geometry = new BufferGeometry();
      line.geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
      line.computeLineDistances();
    });
  }

  /**
   * The lines boats cross on the way in, between pairs of green buoys, and
   * on the way out, between pairs of red; empty lists hide them.
   */
  setChannels(map: GameMap, ways: [[number, number][], [number, number][]]): void {
    ways.forEach((gates, k) => {
      const line = this.channels[k];
      line.visible = gates.length > 0;
      if (!line.visible) return;
      const pos = gates.flat().flatMap((i) => [map.xOf(i) + 0.5, 0.06, map.yOf(i) + 0.5]);
      line.geometry.dispose();
      line.geometry = new BufferGeometry();
      line.geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
      line.computeLineDistances();
    });
  }

  /**
   * Where a selected machine can drive: its roads in blue, the truck bays it
   * reaches in green and those it cannot in red.
   */
  setReach(map: GameMap, route: number[], bays: number[], cutOff: number[]): void {
    const m = new Matrix4();
    let k = 0;
    const put = (tiles: number[], color: Color) => {
      for (const i of tiles) {
        if (k >= MAX_GHOSTS) return;
        const x = map.xOf(i);
        const y = map.yOf(i);
        m.makeTranslation(x, surfaceY(map, x, y) + 0.05, y);
        this.reach.setMatrixAt(k, m);
        this.reach.setColorAt(k++, color);
      }
    };
    put(route, ROUTE);
    put(bays, OK);
    put(cutOff, BAD);
    this.reach.count = k;
    this.reach.instanceMatrix.needsUpdate = true;
    if (this.reach.instanceColor) this.reach.instanceColor.needsUpdate = true;
  }

  /**
   * Tint tiles to explain how things work: for the tool in hand (a crane's
   * machines-only ground and reach, where trucks would load beside storage)
   * or for what is selected. Each source keeps its own set.
   */
  setHints(map: GameMap, source: 'tool' | 'selection', hints: Hints): void {
    this.hintSets[source] = hints;
    const m = new Matrix4();
    let k = 0;
    for (const { kind, tiles } of [...this.hintSets.tool, ...this.hintSets.selection]) {
      for (const i of tiles) {
        if (k >= MAX_GHOSTS) break;
        const x = map.xOf(i);
        const y = map.yOf(i);
        m.makeTranslation(x, surfaceY(map, x, y) + 0.035, y);
        this.hints.setMatrixAt(k, m);
        this.hints.setColorAt(k++, HINT[kind]);
      }
    }
    this.hints.count = k;
    this.hints.instanceMatrix.needsUpdate = true;
    if (this.hints.instanceColor) this.hints.instanceColor.needsUpdate = true;
  }

  /**
   * Arrow out of the front of a building being placed on tile `i`, the way
   * it faces (0 +x, 1 +y, …): from the middle of the front edge of its
   * `tiles` (just `i` for a one-tile building).
   */
  setArrow(map: GameMap, i: number | null, facing: number, tiles: number[] = []): void {
    this.arrow.visible = i !== null;
    if (i === null) return;
    const all = tiles.length > 0 ? tiles : [i];
    const [dx, dy] = FACING[facing & 3];
    let cx = 0;
    let cy = 0;
    for (const t of all) {
      cx += map.xOf(t) + 0.5;
      cy += map.yOf(t) + 0.5;
    }
    cx /= all.length;
    cy /= all.length;
    // How far the front edge lies from the middle, along the facing.
    let front = 0;
    for (const t of all) {
      front = Math.max(front, (map.xOf(t) + 0.5 - cx) * dx + (map.yOf(t) + 0.5 - cy) * dy + 0.5);
    }
    const x = cx + dx * front;
    const y = cy + dy * front;
    const top = Math.max(...all.map((t) => surfaceY(map, map.xOf(t), map.yOf(t))));
    this.arrow.position.set(x, top + 0.08, y);
    // The arrow points along +z (facing 1); turn it like the buildings.
    this.arrow.rotation.y = Math.atan2(dx, dy);
  }

  /**
   * The port's plots of land, laid flat over the map: see LandView. Plots
   * are given by their number, row by row, `size` tiles square.
   */
  setLand(map: GameMap, view: LandView, size: number): void {
    const corners = (p: number) => {
      const x0 = (p % map.plotsWide) * size;
      const y0 = Math.floor(p / map.plotsWide) * size;
      return [x0, y0, Math.min(map.w, x0 + size), Math.min(map.limit, y0 + size)];
    };
    const fill = (mesh: Mesh, plots: number[]) => {
      mesh.visible = plots.length > 0;
      mesh.geometry.dispose();
      mesh.geometry = new BufferGeometry();
      if (!mesh.visible) return;
      const pos: number[] = [];
      for (const p of plots) {
        const [x0, y0, x1, y1] = corners(p);
        pos.push(x0, LAND_Y, y0, x0, LAND_Y, y1, x1, LAND_Y, y1);
        pos.push(x0, LAND_Y, y0, x1, LAND_Y, y1, x1, LAND_Y, y0);
      }
      mesh.geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
    };
    const tool = view.mode === 'tool' ? view : null;
    fill(this.landDim, tool ? tool.dim : []);
    fill(this.landFaint, view.mode === 'edge' ? view.plots : []);
    fill(this.landSale, tool ? tool.forSale.filter((p) => p !== tool.hover) : []);
    fill(this.landHover, tool && tool.hover >= 0 ? [tool.hover] : []);
    (this.landHover.material as MeshBasicMaterial).color.set(tool?.hoverOk ? 0xffd23f : 0xff5a4f);
    // Plots for sale outlined, each edge once.
    const lines = this.landLines;
    lines.visible = !!tool && tool.forSale.length > 0;
    lines.geometry.dispose();
    lines.geometry = new BufferGeometry();
    if (!tool || !lines.visible) return;
    const edges = new Set<string>();
    const pos: number[] = [];
    const edge = (ax: number, ay: number, bx: number, by: number) => {
      const key = `${ax},${ay},${bx},${by}`;
      if (edges.has(key)) return;
      edges.add(key);
      pos.push(ax, LAND_Y + 0.01, ay, bx, LAND_Y + 0.01, by);
    };
    for (const p of tool.forSale) {
      const [x0, y0, x1, y1] = corners(p);
      edge(x0, y0, x1, y0);
      edge(x0, y1, x1, y1);
      edge(x0, y0, x0, y1);
      edge(x1, y0, x1, y1);
    }
    lines.geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  }

  setHover(map: GameMap, i: number | null): void {
    this.hover.visible = i !== null;
    if (i === null) return;
    const x = map.xOf(i);
    const y = map.yOf(i);
    this.hover.position.set(x, surfaceY(map, x, y) + 0.03, y);
  }

  setGhosts(map: GameMap, tiles: number[], ok: boolean[]): void {
    const m = new Matrix4();
    const n = Math.min(tiles.length, MAX_GHOSTS);
    for (let k = 0; k < n; k++) {
      const x = map.xOf(tiles[k]);
      const y = map.yOf(tiles[k]);
      m.makeTranslation(x, surfaceY(map, x, y) + 0.04, y);
      this.ghosts.setMatrixAt(k, m);
      this.ghosts.setColorAt(k, ok[k] ? OK : BAD);
    }
    this.ghosts.count = n;
    this.ghosts.instanceMatrix.needsUpdate = true;
    if (this.ghosts.instanceColor) this.ghosts.instanceColor.needsUpdate = true;
  }

  setRing(pos: Vector3 | null, scale = 1): void {
    this.ring.visible = pos !== null;
    if (!pos) return;
    this.ring.position.set(pos.x, pos.y + 0.03, pos.z);
    this.ring.scale.setScalar(scale);
  }
}
