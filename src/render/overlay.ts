import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
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

/** Hover outline, build previews and the selection ring. */
export class Overlay {
  readonly group = new Group();
  private hover: LineLoop;
  private ghosts: InstancedMesh;
  private ring: Mesh;
  private arrow: Mesh;

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

    this.group.add(this.hover, this.ghosts, this.ring, this.arrow);
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
