import type { Cargo } from '../sim/cargo';
import {
  BoxGeometry,
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type Material,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Object3D,
} from 'three';
import { hash01 } from '../sim/noise';
import { BOX_HEIGHT, BOX_LENGTH, BOX_WIDTH, CONTAINERS, instance } from './assets';
import { coasterShip, feederShip, fishingBoat, tugBoat } from './craft';
import { C } from './palette';
import { box, cyl, mat } from './parts';
import { worker, type Limbs } from './people';
import { truckModel, type Trailer } from './vehicles';

// Procedural low-poly models. All face +X; the root sits on the ground at y=0.

export interface Model {
  root: Group;
  /** Crate meshes, shown one per unit of load. */
  crates: Object3D[];
  /** Parts that bob while walking. */
  body?: Object3D;
  /** People: legs and arms that swing as they walk. */
  limbs?: Limbs;
  /** Articulated trucks: the trailer, swinging behind the tractor. */
  trailer?: Trailer;
  /** Forklifts: the carriage that runs up and down the mast, with the forks and the load. */
  forks?: Object3D;
  /** Reach stackers: the boom and spreader, see reachTo. */
  reach?: Reach;
}

/** A reach stacker's boom, worked to hold its spreader where it should be. */
export interface Reach {
  /** Luffs up and down about its foot at the back. */
  boom: Object3D;
  /** The inner section, run out of the boom to reach the spreader. */
  jib: Object3D;
  /** The lift ram from the chassis up to the boom. */
  ram: Object3D;
  /** Hangs level from the boom's head, with the container under it. */
  spreader: Object3D;
}

/** How far ahead of a reach stacker's middle its spreader holds a container. */
export const STACKER_REACH = 0.5;
/** How high above the ground a reach stacker carries a container as it drives. */
export const CARRY_LOW = 0.05;
/** Where on a terminal tractor's trailer its container sits, ahead of its middle. */
export const TRAILER_AT = -0.14;
/** The boom's foot, at the back of the stacker, and where the ram meets it. */
const BOOM_FOOT = { x: -0.3, y: 0.34 };
const RAM_FOOT = { x: 0, y: 0.2 };
const RAM_AT = 0.32;
/** The boom's inner section, and how far below the boom's head the container's base is. */
const JIB = 0.5;
const HEAD = BOX_HEIGHT + 0.07;

/**
 * Work a reach stacker's boom so the container on its spreader has its
 * base `h` above the ground: luffed up to it and run out to keep the
 * spreader the same way ahead.
 */
export function reachTo(r: Reach, h: number): void {
  const dx = STACKER_REACH - BOOM_FOOT.x;
  const dy = h + HEAD - BOOM_FOOT.y;
  const angle = Math.atan2(dy, dx);
  r.boom.rotation.z = angle;
  r.jib.position.x = Math.max(0, Math.hypot(dx, dy) - JIB);
  r.spreader.position.set(STACKER_REACH, h, 0);
  // From the chassis up to its point on the boom.
  const rx = BOOM_FOOT.x + Math.cos(angle) * RAM_AT - RAM_FOOT.x;
  const ry = BOOM_FOOT.y + Math.sin(angle) * RAM_AT - RAM_FOOT.y;
  r.ram.rotation.z = Math.atan2(ry, rx);
  r.ram.scale.x = Math.hypot(rx, ry);
}

const turned = new Quaternion();
const lengthwise = new Vector3();

/** Which way a container's length runs in the world, as a heading on the map. */
export function headingOf(o: Object3D): number {
  o.getWorldQuaternion(turned);
  lengthwise.set(1, 0, 0).applyQuaternion(turned);
  return Math.atan2(lengthwise.z, lengthwise.x);
}

/** The crates on a pallet, as a forklift carries them and storage keeps them, two by two. */
export const PALLET_CRATE = 0.15;

/** Forklifts: how high the forks ride empty and with a load, above the ground. */
export const FORKS_EMPTY = 0.05;
export const FORKS_LOADED = 0.12;

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
      if (!mesh.isMesh) return;
      // Kept to repaint it by (see paintContainer).
      mesh.userData.base = mesh.geometry;
      mesh.geometry = paintedBox(mesh.geometry, paint);
    });
    g.add(kenney.root);
  } else {
    const color = FALLBACK_PAINTS[Math.floor(pick * FALLBACK_PAINTS.length)];
    g.add(box(BOX_LENGTH, BOX_HEIGHT, BOX_WIDTH, color));
  }
  g.position.set(x, y, z);
  return g;
}

/**
 * Repaint a container for how it looks (the sim's boxLook), so it keeps its
 * colours as it goes from ship to crane, stacker, yard and truck.
 */
export function paintContainer(box: Object3D, look: number): void {
  if (box.userData.look === look) return;
  box.userData.look = look;
  const pick = hash01(look, 7, 13);
  box.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    if (mesh.userData.base) {
      mesh.geometry = paintedBox(mesh.userData.base, Math.floor(pick * PAINTS.length));
    } else {
      mesh.material = mat(FALLBACK_PAINTS[Math.floor(pick * FALLBACK_PAINTS.length)]);
    }
  });
}

/** Repaint the containers a model carries, in load order. */
export function paintLoad(model: Model, looks: number[]): void {
  model.crates.forEach((c, k) => {
    if (k < looks.length) paintContainer(c, looks[k]);
  });
}

/**
 * What a crate holds, as painted on its sides; goods as yet a plain crate,
 * each kind to have its own picture.
 */
const CRATE_ICONS: Cargo[] = ['fish', 'ice', 'lobster'];
/** Per picture, the materials of a box's six faces: on the four sides, none top and bottom. */
let iconMats: Partial<Record<Cargo, Material[]>> | null | undefined;
const iconBand = new BoxGeometry(1, 1, 1);
const none = new MeshBasicMaterial({ visible: false });

/** A little picture of each, drawn once; none where there is nothing to draw on, as in tests. */
function iconMaterials(): Partial<Record<Cargo, Material[]>> | null {
  if (iconMats !== undefined) return iconMats;
  if (typeof document === 'undefined') return (iconMats = null);
  iconMats = {};
  for (const name of CRATE_ICONS) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    drawIcon(cv.getContext('2d')!, name);
    const tex = new CanvasTexture(cv);
    tex.colorSpace = SRGBColorSpace;
    const side = new MeshLambertMaterial({ map: tex, transparent: true, alphaTest: 0.4 });
    iconMats[name] = [side, side, none, none, side, side];
  }
  return iconMats;
}

function drawIcon(g: CanvasRenderingContext2D, name: Cargo): void {
  g.lineJoin = 'round';
  g.lineCap = 'round';
  switch (name) {
    case 'fish': {
      // A round, friendly fish: a fat body, a forked tail, a fin on top,
      // a big eye and a little smile, outlined dark to read from afar.
      const ink = '#1d3557';
      g.lineWidth = 4;
      g.strokeStyle = ink;
      // Tail.
      g.fillStyle = '#f4a259';
      g.beginPath();
      g.moveTo(20, 32);
      g.lineTo(5, 17);
      g.quadraticCurveTo(10, 32, 5, 47);
      g.closePath();
      g.fill();
      g.stroke();
      // Fin on top.
      g.beginPath();
      g.moveTo(26, 18);
      g.quadraticCurveTo(36, 6, 46, 18);
      g.closePath();
      g.fill();
      g.stroke();
      // Body.
      g.fillStyle = '#4ea8de';
      g.beginPath();
      g.ellipse(36, 33, 22, 16, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      // Pale belly.
      g.fillStyle = '#a9def9';
      g.beginPath();
      g.ellipse(38, 39, 14, 7, 0, 0, Math.PI * 2);
      g.fill();
      // Big eye with a shine.
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(46, 28, 6.5, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 2;
      g.stroke();
      g.fillStyle = ink;
      g.beginPath();
      g.arc(47.5, 28.5, 3.5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(48.5, 27, 1.3, 0, Math.PI * 2);
      g.fill();
      // Smile.
      g.lineWidth = 2.5;
      g.beginPath();
      g.arc(51, 36, 4, Math.PI * 0.1, Math.PI * 0.8);
      g.stroke();
      // A rosy cheek.
      g.fillStyle = '#f7a1b5';
      g.beginPath();
      g.arc(42, 37, 2.5, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'ice': {
      // Two chunky ice cubes, one leaning on the other, with a shine and a
      // little happy face on the front one.
      const ink = '#1d3557';
      const cube = (x: number, y: number, w: number, turn: number) => {
        g.save();
        g.translate(x, y);
        g.rotate(turn);
        g.fillStyle = '#dff4ff';
        g.strokeStyle = ink;
        g.lineWidth = 4;
        g.beginPath();
        g.roundRect(-w / 2, -w / 2, w, w, 6);
        g.fill();
        g.stroke();
        g.fillStyle = '#9fd8f5';
        g.beginPath();
        g.roundRect(-w / 2 + 4, w / 2 - 12, w - 8, 8, 3);
        g.fill();
        g.fillStyle = '#fff';
        g.beginPath();
        g.roundRect(-w / 2 + 5, -w / 2 + 5, 6, 12, 3);
        g.fill();
        g.restore();
      };
      cube(22, 26, 24, -0.25);
      cube(40, 38, 30, 0.12);
      // Its face.
      g.fillStyle = ink;
      for (const x of [35, 46]) {
        g.beginPath();
        g.arc(x, 35, 2.4, 0, Math.PI * 2);
        g.fill();
      }
      g.strokeStyle = ink;
      g.lineWidth = 2.5;
      g.beginPath();
      g.arc(40.5, 39, 4, Math.PI * 0.15, Math.PI * 0.85);
      g.stroke();
      g.fillStyle = '#f7a1b5';
      for (const x of [31, 50]) {
        g.beginPath();
        g.arc(x, 40, 2.2, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    case 'lobster': {
      // A plump red lobster seen from above: two big claws up front,
      // feelers, a segmented tail fanning out behind, and big eyes.
      const ink = '#5a1414';
      g.strokeStyle = ink;
      g.lineWidth = 3;
      // Feelers.
      g.beginPath();
      g.moveTo(28, 20);
      g.quadraticCurveTo(20, 6, 8, 6);
      g.moveTo(36, 20);
      g.quadraticCurveTo(44, 6, 56, 6);
      g.stroke();
      g.fillStyle = '#e63946';
      g.lineWidth = 3.5;
      // Claws.
      for (const s of [-1, 1]) {
        g.beginPath();
        g.ellipse(32 + s * 17, 22, 8, 10, s * 0.4, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        // The pincer's notch.
        g.beginPath();
        g.moveTo(32 + s * 17, 13);
        g.lineTo(32 + s * 17, 20);
        g.stroke();
      }
      // Tail, three segments and a fan.
      g.beginPath();
      g.moveTo(24, 56);
      g.lineTo(40, 56);
      g.lineTo(36, 50);
      g.lineTo(28, 50);
      g.closePath();
      g.fill();
      g.stroke();
      for (const [y, w] of [
        [44, 12],
        [38, 14],
      ]) {
        g.beginPath();
        g.roundRect(32 - w / 2, y, w, 7, 3);
        g.fill();
        g.stroke();
      }
      // Body.
      g.beginPath();
      g.ellipse(32, 30, 10, 11, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      // Eyes.
      for (const x of [28, 36]) {
        g.fillStyle = '#fff';
        g.beginPath();
        g.arc(x, 26, 3.6, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#222';
        g.beginPath();
        g.arc(x + 0.6, 26.5, 1.9, 0, Math.PI * 2);
        g.fill();
      }
      g.strokeStyle = ink;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(32, 31, 3, Math.PI * 0.15, Math.PI * 0.85);
      g.stroke();
      break;
    }
    case 'goods':
      break;
  }
}

/** Paint crate `c` as holding `k`: its picture on its sides, or none. */
export function setCrateIcon(c: Object3D | undefined, k: Cargo | undefined): void {
  if (!c || k === undefined || c.userData.icon === k) return;
  c.userData.icon = k;
  const mats = iconMaterials();
  if (!mats) return;
  for (const d of c.children) {
    if (!d.userData.decal) continue;
    const m = mats[k];
    d.visible = !!m;
    if (m) (d as Mesh).material = m;
  }
}

/** Paint each of `crates` as holding what `cargo` says, in order, as far as it says. */
export function paintCargo(crates: Object3D[], cargo: Cargo[] | undefined): void {
  if (!cargo) return;
  crates.forEach((c, k) => {
    if (k < cargo.length) setCrateIcon(c, cargo[k]);
  });
}

export function crate(size: number, x = 0, y = 0, z = 0): Group {
  const g = new Group();
  // Body and lid are stacked, not overlapping, so no faces share a plane.
  g.add(box(size, size * 0.82, size, C.crate));
  g.add(box(size * 1.04, size * 0.18, size * 1.04, C.crateLid, 0, size * 0.82));
  // What it holds, painted on its four sides: fish until told otherwise.
  const k: Cargo = 'fish';
  g.userData.icon = k;
  const mats = iconMaterials();
  if (mats) {
    const d = new Mesh(iconBand, mats[k]!);
    d.userData.decal = true;
    d.scale.set(size + 0.004, size * 0.62, size + 0.004);
    d.position.y = size * 0.41;
    g.add(d);
  }
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
    vessel === 'tug'
      ? tugBoat(id)
      : vessel === 'feeder'
        ? feederShip(id, variant, (k, x, y, z) => container(k, x, y, z))
        : vessel === 'coaster'
          ? coasterShip(id, variant, crate)
          : fishingBoat(id, variant, crate);
  return { root: c.root, crates: c.slots };
}

/** A haulier's truck in company colours, unique to its id. */
export function truck(variant: number, capacity: number, boxes = false, id = 0): Model {
  const v = truckModel(id, variant, capacity, boxes, crate, (k, x, y, z) => container(k, x, y, z));
  return { root: v.root, crates: v.slots, trailer: v.trailer };
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
  // The mast, and the carriage that runs up and down it with the forks:
  // down on the ground to go under a pallet, up a little to drive with it.
  body.add(box(0.03, 0.47, 0.03, C.chassis, 0.16, 0.01, -0.09));
  body.add(box(0.03, 0.47, 0.03, C.chassis, 0.16, 0.01, 0.09));
  const forks = new Group();
  forks.position.set(0, FORKS_EMPTY, 0);
  forks.add(box(0.02, 0.1, 0.22, C.chassis, 0.185, 0));
  forks.add(box(0.26, 0.015, 0.04, C.chassis, 0.29, 0, -0.07));
  forks.add(box(0.26, 0.015, 0.04, C.chassis, 0.29, 0, 0.07));
  // Crates ride on a pallet, which shows with the first of them.
  const crates: Object3D[] = [];
  for (let layer = 0; layer < 2; layer++) {
    for (const z of [-0.08, 0.08]) {
      const c = crate(PALLET_CRATE, 0.3, 0.04 + layer * PALLET_CRATE, z);
      c.visible = false;
      forks.add(c);
      crates.push(c);
    }
  }
  crates[0].add(box(0.2, 0.025, 0.34, C.wood, 0, -0.025, 0.08));
  body.add(forks);
  root.add(body);
  return { root, crates, body, forks };
}

/**
 * A reach stacker: heavy yellow carrier with its cab to one side and a
 * telescopic boom down the middle, luffed by a ram, with a spreader on its
 * head that grips one container across the front.
 */
export function stacker(): Model {
  const root = new Group();
  const body = new Group();
  body.add(box(0.62, 0.14, 0.32, C.forklift, -0.05, 0.08));
  // Counterweight at the back, carrying the boom's foot.
  body.add(box(0.16, 0.12, 0.3, C.chassis, -0.28, 0.22));
  body.add(box(0.14, 0.18, 0.12, C.window, 0.02, 0.22, -0.1));
  body.add(box(0.15, 0.04, 0.14, C.forklift, 0.02, 0.4, -0.1));
  for (const x of [-0.24, 0.16]) {
    for (const z of [-0.17, 0.17]) {
      const wheel = cyl(0.09, 0.07, C.tyre, x, 0, z, 10);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.y = 0.09;
      body.add(wheel);
    }
  }
  const boom = new Group();
  boom.position.set(BOOM_FOOT.x, BOOM_FOOT.y, 0.06);
  boom.add(box(0.62, 0.08, 0.09, C.forklift, 0.31, -0.04));
  const jib = new Group();
  jib.add(box(JIB, 0.06, 0.07, C.chassis, JIB / 2, -0.03));
  boom.add(jib);
  body.add(boom);
  const ram = new Group();
  ram.position.set(RAM_FOOT.x, RAM_FOOT.y, 0.06);
  ram.add(box(1, 0.035, 0.035, C.chassis, 0.5, -0.0175));
  body.add(ram);
  // The spreader across the front, the container held under it.
  const spreader = new Group();
  spreader.add(box(0.07, 0.04, BOX_LENGTH * 0.96, C.chassis, 0, BOX_HEIGHT + 0.005));
  spreader.add(box(0.09, 0.06, 0.1, C.forklift, 0, HEAD - 0.03, 0.06));
  const load = container(1);
  load.rotation.y = Math.PI / 2;
  load.visible = false;
  spreader.add(load);
  body.add(spreader);
  root.add(body);
  const reach = { boom, jib, ram, spreader };
  reachTo(reach, CARRY_LOW);
  return { root, crates: [load], body, reach };
}

/**
 * A terminal tractor: a low cab up front pulling a flat trailer that one
 * container sits on, lifted on and off by a crane.
 */
export function tractor(): Model {
  const root = new Group();
  const body = new Group();
  // The cab, with its window, and the trailer's deck behind it.
  body.add(box(0.2, 0.12, 0.26, C.forklift, 0.3, 0.08));
  body.add(box(0.12, 0.12, 0.2, C.window, 0.32, 0.2, -0.02));
  body.add(box(0.13, 0.03, 0.22, C.forklift, 0.32, 0.32, -0.02));
  body.add(box(0.66, 0.04, 0.28, C.chassis, -0.14, 0.1));
  for (const x of [0.3, -0.04, -0.34]) {
    for (const z of [-0.13, 0.13]) {
      const wheel = cyl(0.07, 0.06, C.tyre, x, 0, z, 10);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.y = 0.07;
      body.add(wheel);
    }
  }
  const load = container(1, TRAILER_AT, 0.14, 0);
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

/** Show just the containers in these slots on a ship's deck, each looking as given. */
export function showDeck(model: Model, slots: number[], looks: number[]): void {
  const shown = new Set(slots);
  model.crates.forEach((c, k) => (c.visible = shown.has(k)));
  slots.forEach((k, j) => {
    const c = model.crates[k];
    if (c && j < looks.length) paintContainer(c, looks[j]);
  });
}

export function showLoad(model: Model, load: number): void {
  model.crates.forEach((c, k) => (c.visible = k < load));
}
