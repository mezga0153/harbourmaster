import {
  ExtrudeGeometry,
  Group,
  Mesh,
  Shape,
  type AnimationAction,
  type AnimationMixer,
  type Object3D,
} from 'three';
import { assetSize, instance, PEOPLE } from './assets';
import { C } from './palette';
import { box, cyl, mat } from './parts';

// Procedural low-poly models. All face +X; the root sits on the ground at y=0.

export interface Model {
  root: Group;
  /** Crate meshes, shown one per unit of load. */
  crates: Object3D[];
  /** Parts that bob while walking. */
  body?: Object3D;
  /** Skinned characters: plays walk/idle animations. */
  mixer?: AnimationMixer | null;
  actions?: Map<string, AnimationAction>;
}

/** Crate slots in a grid over a deck: `cols` along X, `rows` across, `layers` high. */
function deckCrates(
  root: Group,
  size: number,
  xs: number[],
  zs: number[],
  y: number,
  layers: number,
): Object3D[] {
  const out: Object3D[] = [];
  for (let layer = 0; layer < layers; layer++) {
    for (const x of xs) {
      for (const z of zs) {
        const c = crate(size, x, y + layer * size, z);
        c.visible = false;
        root.add(c);
        out.push(c);
      }
    }
  }
  return out;
}

function spread(from: number, to: number, n: number): number[] {
  return Array.from({ length: n }, (_, k) =>
    n === 1 ? (from + to) / 2 : from + ((to - from) * k) / (n - 1),
  );
}

export function crate(size: number, x = 0, y = 0, z = 0): Group {
  const g = new Group();
  // Body and lid are stacked, not overlapping, so no faces share a plane.
  g.add(box(size, size * 0.82, size, C.crate));
  g.add(box(size * 1.04, size * 0.18, size * 1.04, C.crateLid, 0, size * 0.82));
  g.position.set(x, y, z);
  return g;
}

/** A dockhand: one of the Kenney mini characters, with a crate to carry. */
export function person(id = 0): Model {
  const kenney = instance(PEOPLE[id % PEOPLE.length]);
  if (kenney) {
    const root = new Group();
    root.add(kenney.root);
    const load = crate(0.2, 0.02, 0.44);
    load.visible = false;
    root.add(load);
    return { root, crates: [load], mixer: kenney.mixer, actions: kenney.actions };
  }
  return builtinPerson();
}

function builtinPerson(): Model {
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

function hullGeometry(length: number, beam: number, depth: number, bow: number) {
  const back = -length / 2;
  const shoulder = length / 2 - bow;
  const shape = new Shape();
  shape.moveTo(back, -beam / 2);
  shape.lineTo(shoulder, -beam / 2);
  shape.lineTo(length / 2, 0);
  shape.lineTo(shoulder, beam / 2);
  shape.lineTo(back, beam / 2);
  shape.closePath();
  const geo = new ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

const coasterHull = hullGeometry(2.7, 0.84, 0.4, 0.55);
const coasterDeck = hullGeometry(2.6, 0.76, 0.02, 0.5);

/** A small cargo coaster from a shipping line, about three tiles long. */
function coaster(variant: number): Model {
  const root = new Group();
  const hull = new Mesh(coasterHull, mat(C.hulls[variant % C.hulls.length]));
  hull.position.y = -0.15;
  hull.castShadow = hull.receiveShadow = true;
  const band = new Mesh(coasterHull, mat(C.funnel));
  band.scale.set(1.005, 0.2, 1.02);
  band.position.y = -0.12;
  const deck = new Mesh(coasterDeck, mat(C.quayTop));
  deck.position.y = 0.25;
  deck.receiveShadow = true;
  root.add(hull, band, deck);

  // Bridge aft, two decks high, with a funnel.
  root.add(box(0.46, 0.26, 0.66, C.cabin, -1.0, 0.27));
  root.add(box(0.36, 0.2, 0.56, C.cabin, -1.02, 0.53));
  root.add(box(0.37, 0.06, 0.57, C.window, -1.02, 0.63));
  root.add(cyl(0.07, 0.24, C.funnel, -1.14, 0.73));
  // Hatch coamings and a cargo derrick forward.
  root.add(box(1.5, 0.05, 0.62, C.quayWall, 0.05, 0.27));
  root.add(cyl(0.025, 0.75, C.chassis, 0.95, 0.27));

  // Slots fill the hold bottom layer first; a full coaster carries 24.
  const crates: Object3D[] = [];
  for (let layer = 0; layer < 2; layer++) {
    for (const x of [-0.55, -0.32, -0.09, 0.14, 0.37, 0.6]) {
      for (const z of [-0.2, 0.0, 0.2]) {
        const c = crate(0.19, x, 0.32 + layer * 0.2, z);
        c.visible = false;
        root.add(c);
        crates.push(c);
      }
    }
  }
  return { root, crates };
}

/** Small fishing boat, about two tiles long, or a coaster for shipping lines. */
export function boat(variant: number, vessel = 'smack'): Model {
  const name = vessel === 'coaster' ? 'coaster' : 'smack';
  const kenney = instance(name);
  const size = assetSize(name);
  if (kenney && size) {
    const root = new Group();
    // Sit a little low so the hull is in the water.
    kenney.root.position.y = -size.y * 0.18;
    root.add(kenney.root);
    const crates =
      vessel === 'coaster'
        ? // 24 crates over the open cargo deck, two layers.
          deckCrates(root, 0.2, spread(-0.75, 0.55, 6), [-0.21, 0, 0.21], size.y * 0.18, 2)
        : // 16 on the fishing boat's foredeck, two layers.
          deckCrates(root, 0.17, spread(0.05, 0.62, 4), [-0.11, 0.11], size.y * 0.12, 2);
    return { root, crates };
  }
  if (vessel === 'coaster') return coaster(variant);
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
  const kenney = instance('truck');
  const size = assetSize('truck');
  if (kenney && size) {
    const root = new Group();
    // Longer chassis for the 8-crate rigs.
    const stretch = capacity > 6 ? 1.3 : 1;
    kenney.root.scale.x = stretch;
    root.add(kenney.root);
    const len = size.x * stretch;
    const cols = Math.ceil(capacity / 2);
    const crates = deckCrates(
      root,
      0.17,
      spread(-len / 2 + 0.12, -len / 2 + 0.12 + (cols - 1) * 0.18, cols),
      [-0.09, 0.09],
      size.y * 0.42,
      1,
    );
    return { root, crates };
  }
  return builtinTruck(variant, capacity);
}

function builtinTruck(variant: number, capacity: number): Model {
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

/** A counterbalance forklift with its driver. Forks face +X. */
export function forklift(): Model {
  const root = new Group();
  const body = new Group();
  body.add(box(0.36, 0.14, 0.3, C.forklift, -0.04, 0.06));
  body.add(box(0.12, 0.16, 0.3, C.chassis, -0.2, 0.06));
  for (const x of [-0.14, 0.1]) {
    for (const z of [-0.15, 0.15]) {
      const wheel = cyl(0.06, 0.05, C.tyre, x, 0, z, 8);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.y = 0.06;
      body.add(wheel);
    }
  }
  // Driver under the overhead guard.
  body.add(box(0.1, 0.1, 0.12, C.vest, -0.06, 0.2));
  body.add(box(0.08, 0.08, 0.08, C.skin, -0.06, 0.3));
  for (const x of [-0.16, 0.06]) {
    for (const z of [-0.13, 0.13]) body.add(box(0.02, 0.26, 0.02, C.chassis, x, 0.2, z));
  }
  body.add(box(0.26, 0.02, 0.3, C.chassis, -0.05, 0.46));
  // Mast and forks.
  body.add(box(0.03, 0.42, 0.03, C.chassis, 0.16, 0.06, -0.09));
  body.add(box(0.03, 0.42, 0.03, C.chassis, 0.16, 0.06, 0.09));
  body.add(box(0.26, 0.015, 0.04, C.chassis, 0.29, 0.06, -0.07));
  body.add(box(0.26, 0.015, 0.04, C.chassis, 0.29, 0.06, 0.07));
  const crates: Object3D[] = [];
  for (let layer = 0; layer < 2; layer++) {
    for (const z of [-0.08, 0.08]) {
      const c = crate(0.15, 0.3, 0.08 + layer * 0.15, z);
      c.visible = false;
      body.add(c);
      crates.push(c);
    }
  }
  root.add(body);
  return { root, crates, body };
}

/** Floating warning marker for things that need the player's attention. */
export function alertMarker(): Object3D {
  const g = new Group();
  g.add(box(0.06, 0.16, 0.06, C.funnel, 0, 0.1));
  g.add(box(0.06, 0.06, 0.06, C.funnel, 0, 0));
  return g;
}

export function showLoad(model: Model, load: number): void {
  model.crates.forEach((c, k) => (c.visible = k < load));
}
