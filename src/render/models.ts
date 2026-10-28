import { Group, type BufferGeometry, type Mesh, type Object3D } from 'three';
import { hash01 } from '../sim/noise';
import { BOX_HEIGHT, BOX_LENGTH, BOX_WIDTH, CONTAINERS, instance } from './assets';
import { coasterShip, feederShip, fishingBoat } from './craft';
import { C } from './palette';
import { box, cyl } from './parts';
import { worker, type Limbs } from './people';
import { truckModel } from './vehicles';

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

/**
 * Paints a container can come in, as [column, row] of a shaded swatch in
 * Kenney's colour map: 32 px columns, 128 px rows from the first colour row.
 */
const PAINTS: [number, number][] = [
  [11, 0], // red
  [13, 0], // blue
  [5, 0], // green
  [7, 0], // yellow
  [9, 0], // orange
  [15, 0], // sky blue
  [11, 1], // white
  [5, 1], // grey
  [3, 1], // charcoal
  [13, 1], // rust
  [15, 1], // brown
];
const FALLBACK_PAINTS = [C.funnel, C.sign, C.stripe, C.cabin, C.chassis];
const painted = new Map<number, BufferGeometry>();

/**
 * Kenney's red container with its body moved to another swatch of the colour
 * map. The frame and doors keep their own colour.
 */
function paintedBox(source: BufferGeometry, paint: number): BufferGeometry {
  let geo = painted.get(paint);
  if (geo) return geo;
  geo = source.clone();
  const uv = geo.getAttribute('uv');
  const [col, row] = PAINTS[paint];
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i) * 512;
    const v = uv.getY(i) * 512;
    // The body samples the red swatch, x 352–384 px of the first colour row.
    if (u >= 352 && u < 384 && v >= 256 && v < 384) {
      uv.setXY(i, (u + (col - 11) * 32) / 512, (v + row * 128) / 512);
    }
  }
  painted.set(paint, geo);
  return geo;
}

/** A shipping container, lying along X with its base at y=0, in a random paint. */
export function container(seed: number, x = 0, y = 0, z = 0): Object3D {
  const pick = hash01(seed, 7, 13);
  const kenney = instance(CONTAINERS[0]);
  const g = new Group();
  if (kenney) {
    const paint = Math.floor(pick * PAINTS.length);
    kenney.root.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) mesh.geometry = paintedBox(mesh.geometry, paint);
    });
    g.add(kenney.root);
  } else {
    const color = FALLBACK_PAINTS[Math.floor(pick * FALLBACK_PAINTS.length)];
    g.add(box(BOX_LENGTH, BOX_HEIGHT, BOX_WIDTH, color));
  }
  g.position.set(x, y, z);
  return g;
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

/** A haulier's truck in company colours, unique to its id. */
export function truck(variant: number, capacity: number, boxes = false, id = 0): Model {
  const v = truckModel(id, variant, capacity, boxes, crate, (k, x, y, z) => container(k, x, y, z));
  return { root: v.root, crates: v.slots };
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
