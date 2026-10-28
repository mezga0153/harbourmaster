import { Group, type Object3D } from 'three';
import { assetSize, BOX_HEIGHT, BOX_LENGTH, BOX_WIDTH, CONTAINERS, instance } from './assets';
import { coasterShip, feederShip, fishingBoat } from './craft';
import { C } from './palette';
import { box, cyl } from './parts';
import { worker, type Limbs } from './people';

// Procedural low-poly models. All face +X; the root sits on the ground at y=0.

export interface Model {
  root: Group;
  /** Crate meshes, shown one per unit of load. */
  crates: Object3D[];
  /** Parts that bob while walking. */
  body?: Object3D;
  /** People: legs and arms that swing as they walk. */
  limbs?: Limbs;
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

/** A shipping container, lying along X with its base at y=0. */
export function container(seed: number, x = 0, y = 0, z = 0): Object3D {
  const kenney = instance(CONTAINERS[seed % CONTAINERS.length]);
  const g = new Group();
  if (kenney) g.add(kenney.root);
  else g.add(box(BOX_LENGTH, BOX_HEIGHT, BOX_WIDTH, [C.funnel, C.sign, C.stripe][seed % 3]));
  g.position.set(x, y, z);
  return g;
}

/** Container slots in a grid: `xs` along the length, `zs` across. */
function deckBoxes(root: Group, xs: number[], zs: number[], y: number, layers = 1): Object3D[] {
  const out: Object3D[] = [];
  let k = 0;
  for (let layer = 0; layer < layers; layer++) {
    for (const x of xs) {
      for (const z of zs) {
        const c = container(k++, x, y + layer * BOX_HEIGHT, z);
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

/** A dock worker, built from their id so everyone looks different. */
export function person(id = 0): Model {
  const w = worker(id, (size) => crate(size));
  return { root: w.root, crates: [w.load], body: w.body, limbs: w.limbs };
}

/** A boat or ship of the given kind, in its company's colours, unique to its id. */
export function boat(variant: number, vessel = 'smack', id = 0): Model {
  const c =
    vessel === 'feeder'
      ? feederShip(id, variant, (k, x, y, z) => container(k, x, y, z))
      : vessel === 'coaster'
        ? coasterShip(id, variant, crate)
        : fishingBoat(id, variant, crate);
  return { root: c.root, crates: c.slots };
}

/** Flatbed truck: 6 crates in about 0.9 tiles, or a longer 8-crate rig. */
export function truck(variant: number, capacity: number, boxes = false): Model {
  const kenney = instance('truck');
  const size = assetSize('truck');
  if (kenney && size && boxes) {
    // Container truck: a flatbed long enough for its containers end to end.
    const root = new Group();
    const len = 0.36 + capacity * (BOX_LENGTH + 0.03);
    kenney.root.scale.x = len / size.x;
    root.add(kenney.root);
    const first = -len / 2 + BOX_LENGTH / 2 + 0.02;
    const xs = spread(first, first + (capacity - 1) * (BOX_LENGTH + 0.03), capacity);
    return { root, crates: deckBoxes(root, xs, [0], size.y * 0.42) };
  }
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
  // Crates ride on a pallet, which shows with the first of them.
  const crates: Object3D[] = [];
  for (let layer = 0; layer < 2; layer++) {
    for (const z of [-0.08, 0.08]) {
      const c = crate(0.15, 0.3, 0.1 + layer * 0.15, z);
      c.visible = false;
      body.add(c);
      crates.push(c);
    }
  }
  crates[0].add(box(0.2, 0.025, 0.34, C.wood, 0, -0.025, 0.08));
  root.add(body);
  return { root, crates, body };
}

/** A reach stacker: heavy yellow carrier with a boom that grips one container. */
export function stacker(): Model {
  const root = new Group();
  const body = new Group();
  body.add(box(0.62, 0.14, 0.32, C.forklift, -0.05, 0.08));
  body.add(box(0.2, 0.1, 0.3, C.chassis, -0.28, 0.22));
  body.add(box(0.14, 0.18, 0.2, C.window, 0.02, 0.22, -0.05));
  body.add(box(0.15, 0.04, 0.22, C.forklift, 0.02, 0.4, -0.05));
  for (const x of [-0.24, 0.16]) {
    for (const z of [-0.17, 0.17]) {
      const wheel = cyl(0.09, 0.07, C.tyre, x, 0, z, 10);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.y = 0.09;
      body.add(wheel);
    }
  }
  const boom = box(0.7, 0.07, 0.08, C.forklift, 0.12, 0.3, 0.1);
  boom.rotation.z = 0.35;
  body.add(boom);
  // The container is held across the front, the way the spreader grips it.
  const load = container(1, 0.5, 0.42, 0.04);
  load.rotation.y = Math.PI / 2;
  load.visible = false;
  body.add(load);
  root.add(body);
  return { root, crates: [load], body };
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
