import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineLoop,
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

/** Hover outline, build previews and the selection ring. */
export class Overlay {
  readonly group = new Group();
  private hover: LineLoop;
  private ghosts: InstancedMesh;
  private ring: Mesh;
  private arrow: Mesh;
  private reach: InstancedMesh;
  /** The marked ways in and out, through the buoys in order. */
  private channels: Line[];

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

    // Points out of a building's front while it is being placed.
    const tri = new BufferGeometry();
    tri.setAttribute(
      'position',
      new Float32BufferAttribute([-0.2, 0, 0.12, 0.2, 0, 0.12, 0, 0, 0.42], 3),
    );
    this.arrow = new Mesh(
      tri,
      new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false }),
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

    this.channels = [0x3fd06a, 0xff6a5c].map((color) => {
      const line = new Line(
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

    this.group.add(this.hover, this.ghosts, this.ring, this.arrow, this.reach, ...this.channels);
  }

  /**
   * The way in through the green buoys and the way out through the red,
   * in the order boats take them; empty lists hide them.
   */
  setChannels(map: GameMap, ways: [number[], number[]]): void {
    ways.forEach((buoys, k) => {
      const line = this.channels[k];
      line.visible = buoys.length > 1;
      if (!line.visible) return;
      const pos = buoys.flatMap((i) => [map.xOf(i) + 0.5, 0.06, map.yOf(i) + 0.5]);
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

  /** Arrow on tile `i` pointing the way a building faces (0 +x, 1 +y, …). */
  setArrow(map: GameMap, i: number | null, facing: number): void {
    this.arrow.visible = i !== null;
    if (i === null) return;
    const x = map.xOf(i);
    const y = map.yOf(i);
    this.arrow.position.set(x + 0.5, surfaceY(map, x, y) + 0.06, y + 0.5);
    // The triangle points along +z (facing 1); turn it like the buildings.
    const [dx, dy] = FACING[facing & 3];
    this.arrow.rotation.y = Math.atan2(dx, dy);
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
