import { ExtrudeGeometry, Group, Mesh, Shape, type Object3D } from 'three';
import { C } from './palette';
import { box, cyl, mat } from './parts';

// Procedural low-poly models. All face +X; the root sits on the ground at y=0.

export interface Model {
  root: Group;
  /** Crate meshes, shown one per unit of load. */
  crates: Object3D[];
  /** Parts that bob while walking. */
  body?: Object3D;
}

export function crate(size: number, x = 0, y = 0, z = 0): Group {
  const g = new Group();
  // Body and lid are stacked, not overlapping, so no faces share a plane.
  g.add(box(size, size * 0.82, size, C.crate));
  g.add(box(size * 1.04, size * 0.18, size * 1.04, C.crateLid, 0, size * 0.82));
  g.position.set(x, y, z);
  return g;
}

export function person(): Model {
  const root = new Group();
  const body = new Group();
  body.add(box(0.07, 0.15, 0.06, C.trousers, 0, 0, -0.04));
  body.add(box(0.07, 0.15, 0.06, C.trousers, 0, 0, 0.04));
  body.add(box(0.13, 0.17, 0.17, C.vest, 0, 0.14));
  body.add(box(0.11, 0.11, 0.11, C.skin, 0, 0.31));
  body.add(box(0.14, 0.04, 0.14, C.hat, 0, 0.41));
  const load = crate(0.2, 0, 0.45);
  load.visible = false;
  body.add(load);
  root.add(body);
  return { root, crates: [load], body };
}

const hullShape = new Shape();
hullShape.moveTo(-0.95, -0.32);
hullShape.lineTo(0.5, -0.32);
hullShape.lineTo(0.98, 0);
hullShape.lineTo(0.5, 0.32);
hullShape.lineTo(-0.95, 0.32);
hullShape.closePath();
const hullGeo = new ExtrudeGeometry(hullShape, { depth: 0.32, bevelEnabled: false });
hullGeo.rotateX(-Math.PI / 2);
const deckShape = new Shape();
deckShape.moveTo(-0.9, -0.27);
deckShape.lineTo(0.48, -0.27);
deckShape.lineTo(0.88, 0);
deckShape.lineTo(0.48, 0.27);
deckShape.lineTo(-0.9, 0.27);
deckShape.closePath();
const deckGeo = new ExtrudeGeometry(deckShape, { depth: 0.02, bevelEnabled: false });
deckGeo.rotateX(-Math.PI / 2);

/** Small coaster / fishing boat, about two tiles long. */
export function boat(variant: number): Model {
  const root = new Group();
  const hull = new Mesh(hullGeo, mat(C.hulls[variant % C.hulls.length]));
  hull.position.y = -0.12;
  hull.castShadow = hull.receiveShadow = true;
  const deck = new Mesh(deckGeo, mat(C.path));
  deck.position.y = 0.2;
  deck.receiveShadow = true;
  root.add(hull, deck);

  root.add(box(0.34, 0.26, 0.44, C.cabin, -0.62, 0.22));
  root.add(box(0.35, 0.06, 0.45, C.window, -0.62, 0.38));
  root.add(box(0.38, 0.03, 0.48, C.cabin, -0.62, 0.48));
  root.add(cyl(0.05, 0.16, C.funnel, -0.72, 0.51));
  root.add(cyl(0.02, 0.55, C.woodDark, 0.62, 0.22));

  const crates: Object3D[] = [];
  for (let layer = 0; layer < 2; layer++) {
    for (const x of [-0.28, -0.04, 0.2, 0.44]) {
      for (const z of [-0.12, 0.12]) {
        const c = crate(0.21, x, 0.22 + layer * 0.22, z);
        c.visible = false;
        root.add(c);
        crates.push(c);
      }
    }
  }
  return { root, crates };
}

/** Flatbed truck: 6 crates in about 0.9 tiles, or a longer 8-crate rig. */
export function truck(variant: number, capacity: number): Model {
  const root = new Group();
  const paint = C.trucks[variant % C.trucks.length];
  const columns = Math.ceil(capacity / 2);
  const rear = 0.06 - (columns - 1) * 0.21 - 0.12;
  const bed = 0.15 - rear;
  root.add(box(0.43 - rear, 0.06, 0.34, C.chassis, (0.43 + rear) / 2, 0.07));
  root.add(box(0.28, 0.27, 0.38, paint, 0.29, 0.1));
  root.add(box(0.04, 0.12, 0.34, C.window, 0.43, 0.22));
  root.add(box(bed, 0.04, 0.4, paint, 0.15 - bed / 2, 0.13));
  const axles = columns > 3 ? [rear + 0.12, rear + 0.3, 0.28] : [-0.3, 0.28];
  for (const x of axles) {
    for (const z of [-0.18, 0.18]) {
      const wheel = cyl(0.075, 0.07, C.tyre, x, 0, z, 8);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.y = 0.075;
      root.add(wheel);
    }
  }
  const crates: Object3D[] = [];
  for (let k = 0; k < columns; k++) {
    for (const z of [-0.1, 0.1]) {
      const c = crate(0.18, 0.06 - k * 0.21, 0.17, z);
      c.visible = false;
      root.add(c);
      crates.push(c);
    }
  }
  return { root, crates };
}

export function showLoad(model: Model, load: number): void {
  model.crates.forEach((c, k) => (c.visible = k < load));
}
