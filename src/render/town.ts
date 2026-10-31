import {
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Build } from '../sim/types';
import { C } from './palette';
import { box, cyl, mat } from './parts';

// The town's buildings, from a fisher's cottage to a tower block. Each is
// drawn on a 1×1 tile facing +z, onto its street, and turned into place by
// Structures. `v` in [0, 1) picks the paint and the details.

const WALLS = [0xf4efe4, 0xf1e2c0, 0xd9e6ee, 0xf2d7c9, 0xe9e4a8, 0xcfe0c8];
const ROOFS = [0xb5533c, 0x5d6670, 0x8c3b30, 0x6b4f3f];
const BRICK = [0xb8674a, 0xc98f5e, 0xa9a39a, 0xd4c3a3];
const GLASS = [0x5f7f99, 0x6c8ea6, 0x4f6d84];
const AWNINGS = [0xd6453d, 0x2f6fd0, 0x3fa34d, 0xf2c230];
const DOOR = 0x5a3d2b;
const PAVING = 0xc9c4ba;
const KERB = 0xb0aaa0;

/** A gable roof: a prism one unit long (x), deep (z) and high, its base at y=0. */
const gableGeo = new CylinderGeometry(1, 1, 1, 3);
gableGeo.rotateZ(Math.PI / 2);
gableGeo.rotateX(-Math.PI / 2);
gableGeo.translate(0, 0.5, 0);
gableGeo.scale(1, 1 / 1.5, 1 / Math.sqrt(3));
const spireGeo = new ConeGeometry(1, 1, 4);
spireGeo.translate(0, 0.5, 0);
const treeGeo = new ConeGeometry(1, 1, 6);
treeGeo.translate(0, 0.5, 0);
const canopyGeo = new ConeGeometry(1, 1, 8);
canopyGeo.translate(0, 0.5, 0);

function pick<T>(items: readonly T[], v: number, salt = 0): T {
  return items[Math.floor(((v * 7919 + salt * 0.618) % 1) * items.length)];
}

/** Gable roof with the ridge along x (or z), base at y. */
function gable(
  w: number,
  h: number,
  d: number,
  color: number,
  x: number,
  y: number,
  z: number,
  alongZ = false,
) {
  const m = new Mesh(gableGeo, mat(color));
  m.scale.set(w, h, d);
  if (alongZ) {
    m.rotation.y = Math.PI / 2;
    m.scale.set(d, h, w);
  }
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function cone(
  r: number,
  h: number,
  color: number,
  x: number,
  y: number,
  z: number,
  geo = spireGeo,
) {
  const m = new Mesh(geo, mat(color));
  m.scale.set(r, h, r);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/** Windows across the front (z = `z`), `n` of them, on one floor. */
function windows(g: Group, n: number, w: number, y: number, z: number, glass = C.window) {
  for (let k = 0; k < n; k++) {
    const x = 0.5 + (k - (n - 1) / 2) * (w / n);
    g.add(box(0.07, 0.07, 0.012, glass, x, y, z));
  }
}

function tree(g: Group, x: number, y: number, z: number, s: number, v: number) {
  g.add(cyl(0.025 * s, 0.1 * s, C.trunk, x, y, z));
  g.add(cone(0.12 * s, 0.3 * s, pick(C.leaves, v, x + z), x, y + 0.08 * s, z, treeGeo));
}

function cottage(g: Group, y: number, v: number) {
  const wall = pick(WALLS, v);
  g.add(box(0.5, 0.22, 0.36, wall, 0.5, y, 0.45));
  g.add(gable(0.58, 0.18, 0.44, pick(ROOFS, v, 1), 0.5, y + 0.22, 0.45));
  g.add(box(0.08, 0.13, 0.012, DOOR, 0.36, y, 0.635));
  windows(g, 1, 0.2, y + 0.08, 0.635);
  g.add(box(0.06, 0.12, 0.06, BRICK[0], 0.66, y + 0.28, 0.4));
  // A net drying on poles, or a dinghy turned over in the garden.
  if (v < 0.5) {
    g.add(cyl(0.012, 0.16, C.woodDark, 0.12, y, 0.2));
    g.add(cyl(0.012, 0.16, C.woodDark, 0.12, y, 0.75));
    g.add(box(0.01, 0.1, 0.5, 0x6d7f74, 0.12, y + 0.05, 0.47));
  } else {
    g.add(box(0.14, 0.05, 0.3, pick(C.hulls, v, 2), 0.88, y, 0.42));
  }
}

function house(g: Group, y: number, v: number) {
  const wall = pick(WALLS, v);
  g.add(box(0.6, 0.38, 0.46, wall, 0.5, y, 0.45));
  g.add(gable(0.68, 0.2, 0.54, pick(ROOFS, v, 1), 0.5, y + 0.38, 0.45));
  g.add(box(0.09, 0.15, 0.012, DOOR, 0.5, y, 0.685));
  windows(g, 2, 0.4, y + 0.06, 0.685);
  windows(g, 3, 0.48, y + 0.24, 0.685);
  g.add(box(0.07, 0.14, 0.07, BRICK[1], 0.28, y + 0.42, 0.38));
  // Front garden hedge.
  g.add(box(0.3, 0.06, 0.06, C.leaves[0], 0.24, y, 0.9));
  g.add(box(0.3, 0.06, 0.06, C.leaves[0], 0.76, y, 0.9));
}

function shop(g: Group, y: number, v: number) {
  const wall = pick(BRICK, v);
  const floors = v < 0.5 ? 2 : 3;
  const h = 0.2 + floors * 0.17;
  g.add(box(0.84, h, 0.66, wall, 0.5, y, 0.45));
  // Shopfront with an awning, and flats above.
  g.add(box(0.7, 0.13, 0.012, pick(GLASS, v), 0.5, y + 0.02, 0.785));
  const awning = box(0.76, 0.02, 0.14, pick(AWNINGS, v, 3), 0.5, y + 0.17, 0.83);
  awning.rotation.x = 0.35;
  g.add(awning);
  for (let f = 0; f < floors; f++) {
    const fy = y + 0.26 + f * 0.17;
    windows(g, 4, 0.72, fy, 0.785);
    windows(g, 4, 0.72, fy, 0.115);
    if (f === 0) windows(g, 4, 0.72, y + 0.05, 0.115);
  }
  g.add(box(0.88, 0.04, 0.7, C.concrete, 0.5, y + h, 0.45));
  g.add(box(0.5, 0.05, 0.012, C.cabin, 0.5, y + h - 0.08, 0.786));
}

function flats(g: Group, y: number, v: number) {
  const floors = 5 + Math.floor(v * 3);
  const h = 0.1 + floors * 0.16;
  const wall = pick([0xe6e1d6, 0xd8d2c4, 0xc9cfd4, 0xe8d9c4], v);
  g.add(box(0.78, h, 0.7, wall, 0.5, y, 0.5));
  // A band of windows round every floor, and balconies on the front.
  for (let f = 0; f < floors; f++) {
    const fy = y + 0.12 + f * 0.16;
    g.add(box(0.79, 0.06, 0.71, pick(GLASS, v), 0.5, fy, 0.5));
    if (f > 0) g.add(box(0.5, 0.025, 0.06, C.concrete, 0.5, fy - 0.03, 0.87));
  }
  g.add(box(0.2, 0.1, 0.012, DOOR, 0.5, y, 0.855));
  g.add(box(0.82, 0.03, 0.74, C.quayWall, 0.5, y + h, 0.5));
  g.add(box(0.2, 0.1, 0.2, C.chassis, 0.32, y + h + 0.03, 0.4));
}

function tower(g: Group, y: number, v: number) {
  const floors = 12 + Math.floor(v * 8);
  const h = floors * 0.16;
  const glass = pick(GLASS, v);
  g.add(box(0.7, h, 0.7, glass, 0.5, y, 0.5));
  // Concrete floor plates every other storey and a crown on top.
  for (let f = 2; f < floors; f += 2)
    g.add(box(0.72, 0.03, 0.72, C.concrete, 0.5, y + f * 0.16, 0.5));
  for (const [x, z] of [
    [0.15, 0.15],
    [0.85, 0.15],
    [0.15, 0.85],
    [0.85, 0.85],
  ]) {
    g.add(box(0.06, h + 0.04, 0.06, C.concrete, x, y, z));
  }
  g.add(box(0.86, 0.12, 0.86, C.concrete, 0.5, y, 0.5));
  g.add(box(0.5, 0.14, 0.5, C.quayWall, 0.5, y + h, 0.5));
  if (v > 0.4) g.add(cyl(0.012, 0.4, C.chassis, 0.5, y + h + 0.14, 0.5));
}

function chapel(g: Group, y: number) {
  g.add(box(0.38, 0.3, 0.56, 0xf6f3ec, 0.5, y, 0.42));
  g.add(gable(0.46, 0.22, 0.64, 0x5d6670, 0.5, y + 0.3, 0.42, true));
  // Bell tower and spire at the front, onto the square.
  g.add(box(0.2, 0.46, 0.2, 0xf6f3ec, 0.5, y, 0.76));
  g.add(cone(0.15, 0.36, 0x5d6670, 0.5, y + 0.46, 0.76));
  g.add(box(0.08, 0.12, 0.012, DOOR, 0.5, y, 0.865));
  g.add(box(0.012, 0.1, 0.06, 0x7a8ea6, 0.305, y + 0.12, 0.3));
  g.add(box(0.012, 0.1, 0.06, 0x7a8ea6, 0.695, y + 0.12, 0.3));
}

function fishShed(g: Group, y: number, v: number) {
  g.add(box(0.46, 0.22, 0.34, C.woodDark, 0.5, y, 0.32));
  g.add(gable(0.52, 0.12, 0.4, 0x5d6670, 0.5, y + 0.22, 0.32));
  g.add(box(0.16, 0.16, 0.012, C.wood, 0.5, y, 0.495));
  g.add(cyl(0.05, 0.09, C.wood, 0.2, y, 0.6, 8));
  g.add(cyl(0.05, 0.09, C.wood, 0.3, y, 0.66, 8));
  // A rowing boat drawn up on the beach, bow to the sea.
  const hull = pick(C.hulls, v);
  g.add(box(0.16, 0.06, 0.34, hull, 0.74, y, 0.72));
  g.add(box(0.12, 0.012, 0.26, C.wood, 0.74, y + 0.06, 0.72));
  const bow = box(0.11, 0.06, 0.11, hull, 0.74, y, 0.89);
  bow.rotation.y = Math.PI / 4;
  g.add(bow);
}

function park(g: Group, y: number, v: number) {
  g.add(box(0.96, 0.02, 0.96, C.verge, 0.5, y, 0.5));
  g.add(box(0.96, 0.025, 0.14, C.flagstone, 0.5, y, 0.5));
  g.add(box(0.14, 0.025, 0.96, C.flagstone, 0.5, y, 0.5));
  // A fountain or a bandstand where the paths meet, trees in the corners.
  if (v < 0.5) {
    g.add(cyl(0.16, 0.05, C.concrete, 0.5, y, 0.5, 12));
    g.add(cyl(0.12, 0.052, C.waterShallow, 0.5, y, 0.5, 12));
    g.add(cyl(0.025, 0.14, C.concrete, 0.5, y, 0.5, 6));
  } else {
    g.add(cyl(0.17, 0.04, C.cabin, 0.5, y, 0.5, 8));
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      g.add(cyl(0.01, 0.18, C.cabin, 0.5 + Math.cos(a) * 0.13, y + 0.04, 0.5 + Math.sin(a) * 0.13));
    }
    g.add(cone(0.2, 0.1, C.funnel, 0.5, y + 0.22, 0.5, canopyGeo));
  }
  for (const [x, z] of [
    [0.2, 0.2],
    [0.8, 0.2],
    [0.2, 0.8],
    [0.8, 0.8],
  ]) {
    tree(g, x, y, z, 1 + ((v * 13 + x + z) % 0.4), v);
  }
}

function fishMarket(g: Group, y: number) {
  // An open market hall: a striped canopy on posts over the fish stalls.
  g.add(box(0.86, 0.03, 0.7, PAVING, 0.5, y, 0.5));
  for (const [x, z] of [
    [0.12, 0.2],
    [0.88, 0.2],
    [0.12, 0.8],
    [0.88, 0.8],
  ]) {
    g.add(cyl(0.025, 0.3, C.cabin, x, y, z));
  }
  for (let k = 0; k < 4; k++) {
    g.add(gable(0.2, 0.12, 0.72, k % 2 ? C.cabin : C.sign, 0.2 + k * 0.2, y + 0.3, 0.5, true));
  }
  for (const z of [0.36, 0.64]) {
    g.add(box(0.6, 0.1, 0.12, C.wood, 0.5, y + 0.03, z));
    for (let k = 0; k < 5; k++)
      g.add(box(0.07, 0.025, 0.04, 0xb9c8d4, 0.26 + k * 0.12, y + 0.13, z));
  }
  g.add(box(0.12, 0.08, 0.12, C.crate, 0.2, y + 0.03, 0.9));
  g.add(box(0.12, 0.08, 0.12, C.crateLid, 0.34, y + 0.03, 0.9));
  g.add(box(0.36, 0.08, 0.012, C.sign, 0.5, y + 0.34, 0.86));
}

function iceHouse(g: Group, y: number) {
  // A squat white store with thick walls, a low blue roof and a frosty door,
  // a block of ice and an ice cart out front.
  g.add(box(0.72, 0.26, 0.6, 0xe9f1f5, 0.5, y, 0.42));
  g.add(gable(0.8, 0.14, 0.68, 0x5b8fb9, 0.5, y + 0.26, 0.42));
  g.add(box(0.18, 0.2, 0.02, 0xbfe3f2, 0.5, y, 0.73));
  g.add(box(0.5, 0.05, 0.02, 0x2f6fd0, 0.5, y + 0.2, 0.735));
  for (const x of [0.2, 0.32]) g.add(box(0.1, 0.1, 0.1, 0xcdeefb, x, y, 0.86));
  g.add(box(0.16, 0.06, 0.1, C.wood, 0.75, y + 0.04, 0.86));
  for (const x of [0.69, 0.81]) g.add(cyl(0.03, 0.02, 0x333333, x, y, 0.86));
}

function restaurant(g: Group, y: number) {
  // A white seafood restaurant: a red roof, a striped awning over tables
  // outside, and a big red lobster on the sign.
  g.add(box(0.74, 0.3, 0.5, 0xf4f1ea, 0.5, y, 0.36));
  g.add(gable(0.82, 0.16, 0.58, 0xc0392b, 0.5, y + 0.3, 0.36));
  for (let k = 0; k < 5; k++) {
    g.add(box(0.15, 0.02, 0.18, k % 2 ? 0xffffff : 0xc0392b, 0.2 + k * 0.15, y + 0.24, 0.68));
  }
  for (const x of [0.28, 0.72]) {
    g.add(cyl(0.07, 0.015, 0xffffff, x, y + 0.1, 0.84));
    g.add(cyl(0.012, 0.1, 0x555555, x, y, 0.84));
  }
  g.add(box(0.22, 0.12, 0.02, 0xffffff, 0.5, y + 0.34, 0.62));
  g.add(box(0.12, 0.06, 0.025, 0xd8452f, 0.5, y + 0.37, 0.62));
  for (const x of [0.42, 0.58]) g.add(box(0.04, 0.04, 0.025, 0xd8452f, x, y + 0.4, 0.62));
}

function cannery(g: Group, y: number) {
  // A brick works with a sawtooth roof, a tall chimney and its loading door.
  g.add(box(0.86, 0.36, 0.7, BRICK[0], 0.5, y, 0.45));
  for (let k = 0; k < 3; k++) {
    const r = box(0.29, 0.14, 0.7, k % 2 ? 0x8d939b : 0x9aa1a8, 0.21 + k * 0.29, y + 0.36, 0.45);
    r.rotation.z = 0.35;
    g.add(r);
    g.add(box(0.012, 0.1, 0.68, C.window, 0.32 + k * 0.29, y + 0.37, 0.45));
  }
  g.add(cyl(0.06, 0.95, BRICK[2], 0.82, y, 0.18, 8));
  g.add(cyl(0.065, 0.06, C.funnel, 0.82, y + 0.8, 0.18, 8));
  g.add(box(0.26, 0.22, 0.012, C.chassis, 0.35, y, 0.805));
  g.add(box(0.5, 0.07, 0.012, C.cabin, 0.5, y + 0.27, 0.805));
  g.add(cyl(0.09, 0.22, 0xc9ced3, 0.82, y, 0.86, 10));
}

/** A cylinder lying along x (or z), its middle at x, y, z. */
function log(
  r: number,
  len: number,
  color: number,
  x: number,
  y: number,
  z: number,
  alongZ = false,
) {
  const m = cyl(r, len, color, 0, 0, 0, 8);
  m.position.set(x, y, z);
  if (alongZ) m.rotation.x = Math.PI / 2;
  else m.rotation.z = Math.PI / 2;
  return m;
}

/** A round face looking out along +z, as a clock: its middle at x, y, z. */
function clock(g: Group, r: number, x: number, y: number, z: number) {
  g.add(log(r + 0.012, 0.01, C.chassis, x, y, z - 0.004, true));
  g.add(log(r, 0.012, 0xfaf6e8, x, y, z, true));
  // Hands at three o'clock.
  g.add(box(0.008, r * 0.8, 0.006, C.chassis, x, y - 0.004, z + 0.006));
  g.add(box(r * 0.55, 0.008, 0.006, C.chassis, x + r * 0.27, y - 0.004, z + 0.006));
}

function buildersYard(g: Group, y: number) {
  // A fenced yard of packed earth: a timber shed at the back, stacks of
  // planks and a pile of logs, a hoist for lifting them and a handcart by
  // the open gate onto the street.
  g.add(box(0.92, 0.02, 0.92, C.dirt, 0.5, y, 0.5));
  const fy = y + 0.02;
  // Fence of boards round three sides and the front either side of the gate.
  for (const x of [0.05, 0.95]) g.add(box(0.025, 0.1, 0.9, C.wood, x, fy, 0.5));
  g.add(box(0.9, 0.1, 0.025, C.wood, 0.5, fy, 0.05));
  for (const x of [0.17, 0.83]) g.add(box(0.26, 0.1, 0.025, C.wood, x, fy, 0.95));
  for (const x of [0.05, 0.3, 0.7, 0.95]) {
    for (const z of [0.05, 0.95]) g.add(box(0.04, 0.13, 0.04, C.woodDark, x, fy, z));
  }
  // The shed: dark boards, a slate roof and its wide doors open.
  g.add(box(0.46, 0.26, 0.28, C.woodDark, 0.33, fy, 0.24));
  g.add(gable(0.52, 0.12, 0.34, 0x5d6670, 0.33, fy + 0.26, 0.24));
  g.add(box(0.2, 0.19, 0.012, 0x3a2a1c, 0.3, fy, 0.385));
  g.add(box(0.3, 0.05, 0.012, C.cabin, 0.33, fy + 0.2, 0.386));
  // Stacks of sawn planks, battens between the layers.
  const plank = 0xd9b07a;
  for (const [x, z, n] of [
    [0.24, 0.62, 4],
    [0.24, 0.8, 3],
  ] as const) {
    for (let k = 0; k < n; k++) {
      g.add(box(0.34, 0.035, 0.13, k % 2 ? plank : 0xcfa36b, x, fy + k * 0.045, z));
      g.add(box(0.03, 0.01, 0.14, C.woodDark, x - 0.12, fy + k * 0.045 + 0.035, z));
      g.add(box(0.03, 0.01, 0.14, C.woodDark, x + 0.12, fy + k * 0.045 + 0.035, z));
    }
  }
  // A pile of logs, three and two, along z.
  for (let k = 0; k < 3; k++)
    g.add(log(0.035, 0.36, C.wood, 0.66 + k * 0.07, fy + 0.035, 0.66, true));
  for (let k = 0; k < 2; k++)
    g.add(log(0.035, 0.36, C.wood, 0.695 + k * 0.07, fy + 0.095, 0.66, true));
  // A hoist: a post and a jib, its rope down to the logs.
  g.add(box(0.04, 0.5, 0.04, C.woodDark, 0.84, fy, 0.3));
  g.add(box(0.3, 0.035, 0.035, C.woodDark, 0.74, fy + 0.46, 0.3));
  const brace = box(0.02, 0.18, 0.02, C.woodDark, 0.79, fy + 0.3, 0.3);
  brace.rotation.z = 0.8;
  g.add(brace);
  g.add(cyl(0.004, 0.26, C.chassis, 0.62, fy + 0.2, 0.3, 4));
  g.add(box(0.05, 0.03, 0.05, C.chassis, 0.62, fy + 0.18, 0.3));
  // A handcart with a load of planks.
  g.add(box(0.12, 0.03, 0.2, C.wood, 0.5, fy + 0.04, 0.78));
  g.add(box(0.1, 0.03, 0.22, plank, 0.5, fy + 0.07, 0.78));
  for (const x of [0.43, 0.57]) g.add(log(0.035, 0.015, C.tyre, x, fy + 0.035, 0.74));
  // The builder's sign over the gate.
  for (const x of [0.32, 0.68]) g.add(cyl(0.012, 0.28, C.woodDark, x, fy, 0.95));
  g.add(box(0.4, 0.07, 0.015, C.stripe, 0.5, fy + 0.24, 0.95));
}

function school(g: Group, y: number, v: number) {
  // A two-storey brick school: tall windows, a gabled middle bay with a
  // clock and a bell turret on the ridge, and a playground out front with a
  // swing and a slide behind railings.
  const brick = pick([0xa95a3f, 0xb8674a], v);
  const stone = 0xe8e0cc;
  g.add(box(0.84, 0.44, 0.38, brick, 0.5, y, 0.3));
  g.add(box(0.86, 0.025, 0.4, stone, 0.5, y + 0.22, 0.3));
  g.add(gable(0.9, 0.18, 0.46, 0x5d6670, 0.5, y + 0.44, 0.3));
  // The middle bay stands forward, with its own gable to the street.
  g.add(box(0.24, 0.5, 0.08, brick, 0.5, y, 0.51));
  g.add(gable(0.28, 0.14, 0.1, 0x5d6670, 0.5, y + 0.5, 0.51, true));
  g.add(box(0.26, 0.025, 0.09, stone, 0.5, y + 0.5, 0.51));
  clock(g, 0.045, 0.5, y + 0.4, 0.556);
  g.add(box(0.1, 0.16, 0.012, DOOR, 0.5, y, 0.556));
  g.add(box(0.12, 0.025, 0.02, stone, 0.5, y + 0.16, 0.556));
  // Tall windows on both floors, front and back.
  for (const x of [0.15, 0.27, 0.73, 0.85]) {
    for (const wy of [0.04, 0.26]) {
      g.add(box(0.07, 0.15, 0.012, C.window, x, y + wy, 0.495));
      g.add(box(0.08, 0.02, 0.016, stone, x, y + wy - 0.01, 0.495));
      g.add(box(0.07, 0.15, 0.012, C.window, x, y + wy, 0.105));
    }
  }
  // The bell turret: white posts, the bell and a little spire.
  g.add(box(0.1, 0.03, 0.1, stone, 0.5, y + 0.6, 0.3));
  for (const [dx, dz] of [
    [-0.04, -0.04],
    [0.04, -0.04],
    [-0.04, 0.04],
    [0.04, 0.04],
  ]) {
    g.add(box(0.015, 0.09, 0.015, C.cabin, 0.5 + dx, y + 0.63, 0.3 + dz));
  }
  g.add(cone(0.03, 0.045, 0xc9a23a, 0.5, y + 0.65, 0.3, canopyGeo));
  g.add(cone(0.08, 0.12, 0x5d6670, 0.5, y + 0.72, 0.3));
  // Playground: tarmac with hopscotch, a swing, a slide, railings.
  g.add(box(0.92, 0.015, 0.36, C.asphalt, 0.5, y, 0.76));
  for (let k = 0; k < 4; k++)
    g.add(box(0.05, 0.004, 0.05, C.marking, 0.5, y + 0.015, 0.62 + k * 0.065));
  for (const x of [0.12, 0.32]) {
    const leg = box(0.015, 0.2, 0.015, 0xd6453d, x, y, 0.76);
    g.add(leg);
  }
  g.add(box(0.22, 0.015, 0.015, 0xd6453d, 0.22, y + 0.2, 0.76));
  for (const x of [0.18, 0.26]) {
    g.add(box(0.003, 0.13, 0.003, C.chassis, x, y + 0.07, 0.76));
    g.add(box(0.05, 0.01, 0.03, C.wood, x, y + 0.065, 0.76));
  }
  g.add(box(0.04, 0.16, 0.04, 0x2f6fd0, 0.82, y, 0.66));
  const slide = box(0.06, 0.012, 0.24, 0xf2c230, 0.82, y + 0.06, 0.78);
  slide.rotation.x = 0.6;
  g.add(slide);
  for (const x of [0.06, 0.94]) {
    g.add(box(0.012, 0.012, 0.36, C.chassis, x, y + 0.07, 0.76));
    for (const z of [0.6, 0.76, 0.93]) g.add(box(0.012, 0.07, 0.012, C.chassis, x, y, z));
  }
  for (const x of [0.25, 0.75]) {
    g.add(box(0.38, 0.012, 0.012, C.chassis, x, y + 0.07, 0.94));
    for (const dx of [-0.12, 0, 0.12]) g.add(box(0.012, 0.07, 0.012, C.chassis, x + dx, y, 0.94));
  }
}

function townHall(g: Group, y: number) {
  // The grandest building in town: pale stone on a stepped plinth, a
  // portico of columns under a pediment, a clock tower with a copper dome
  // and the town's flag flying on top.
  const stone = 0xece4d0;
  const shade = 0xd8ceb6;
  const copper = 0x5fa38a;
  g.add(box(0.9, 0.04, 0.6, shade, 0.5, y, 0.36));
  const by = y + 0.04;
  g.add(box(0.84, 0.4, 0.5, stone, 0.5, by, 0.34));
  g.add(box(0.88, 0.04, 0.54, shade, 0.5, by + 0.4, 0.34));
  g.add(box(0.8, 0.06, 0.46, 0x5d6670, 0.5, by + 0.44, 0.34));
  // Windows in the wings, two floors.
  for (const x of [0.13, 0.24, 0.76, 0.87]) {
    for (const wy of [0.05, 0.23]) {
      g.add(box(0.06, 0.13, 0.012, C.window, x, by + wy, 0.595));
      g.add(box(0.075, 0.02, 0.016, shade, x, by + wy + 0.13, 0.595));
      g.add(box(0.06, 0.13, 0.012, C.window, x, by + wy, 0.085));
    }
  }
  // The portico: steps, six columns and a pediment over them.
  g.add(box(0.48, 0.025, 0.2, shade, 0.5, y, 0.72));
  g.add(box(0.44, 0.025, 0.16, shade, 0.5, y + 0.025, 0.7));
  for (let k = 0; k < 6; k++) {
    const x = 0.3 + k * 0.08;
    g.add(cyl(0.022, 0.33, stone, x, by + 0.01, 0.74, 8));
    g.add(box(0.05, 0.02, 0.05, shade, x, by + 0.33, 0.74));
  }
  g.add(box(0.48, 0.06, 0.18, stone, 0.5, by + 0.35, 0.69));
  g.add(gable(0.52, 0.12, 0.2, stone, 0.5, by + 0.41, 0.69, true));
  g.add(box(0.12, 0.2, 0.012, DOOR, 0.5, by, 0.595));
  g.add(box(0.34, 0.035, 0.012, 0xc9a23a, 0.5, by + 0.37, 0.781));
  // The clock tower, rising from the roof behind the portico.
  const ty = by + 0.5;
  g.add(box(0.2, 0.42, 0.2, stone, 0.5, ty - 0.05, 0.32));
  g.add(box(0.23, 0.03, 0.23, shade, 0.5, ty + 0.37, 0.32));
  clock(g, 0.06, 0.5, ty + 0.24, 0.425);
  for (const x of [0.43, 0.57]) g.add(box(0.03, 0.1, 0.012, C.window, x, ty + 0.04, 0.425));
  // Belfry of four posts, then the dome and the flagpole.
  for (const [dx, dz] of [
    [-0.08, -0.08],
    [0.08, -0.08],
    [-0.08, 0.08],
    [0.08, 0.08],
  ]) {
    g.add(box(0.03, 0.12, 0.03, stone, 0.5 + dx, ty + 0.4, 0.32 + dz));
  }
  g.add(box(0.22, 0.03, 0.22, shade, 0.5, ty + 0.52, 0.32));
  g.add(cone(0.12, 0.16, copper, 0.5, ty + 0.55, 0.32, canopyGeo));
  g.add(cyl(0.008, 0.3, C.chassis, 0.5, ty + 0.68, 0.32, 4));
  g.add(box(0.012, 0.08, 0.13, C.funnel, 0.5, ty + 0.88, 0.385));
  g.add(box(0.014, 0.025, 0.13, C.cabin, 0.5, ty + 0.907, 0.385));
  // Box hedges and lamps either side of the steps.
  for (const x of [0.16, 0.84]) {
    g.add(box(0.2, 0.06, 0.08, C.leaves[0], x, y, 0.72));
    g.add(cyl(0.01, 0.26, C.chassis, x === 0.16 ? 0.24 : 0.76, y, 0.88));
    g.add(box(0.05, 0.05, 0.05, 0xfff2b0, x === 0.16 ? 0.24 : 0.76, y + 0.26, 0.88));
  }
}

function store(g: Group, y: number, v: number) {
  // A department store: a glass ground floor, two storeys of windows, its name on the roof.
  const wall = pick([0xe8d9c4, 0xd9e6ee, 0xf2d7c9], v);
  g.add(box(0.9, 0.62, 0.78, wall, 0.5, y, 0.47));
  g.add(box(0.84, 0.17, 0.012, pick(GLASS, v), 0.5, y + 0.02, 0.865));
  g.add(box(0.9, 0.04, 0.12, pick(AWNINGS, v, 4), 0.5, y + 0.2, 0.9));
  for (const f of [0, 1]) {
    g.add(box(0.91, 0.08, 0.79, pick(GLASS, v, 1), 0.5, y + 0.3 + f * 0.15, 0.47));
  }
  g.add(box(0.94, 0.04, 0.82, C.concrete, 0.5, y + 0.62, 0.47));
  g.add(box(0.5, 0.12, 0.03, pick(AWNINGS, v, 5), 0.5, y + 0.66, 0.6));
  g.add(cyl(0.012, 0.06, C.chassis, 0.32, y + 0.62, 0.6));
  g.add(cyl(0.012, 0.06, C.chassis, 0.68, y + 0.62, 0.6));
}

function factory(g: Group, y: number, v: number) {
  // A big clad shed, two chimneys, a roller door onto the street and a yard of containers.
  g.add(box(0.92, 0.03, 0.92, C.quayTop, 0.5, y, 0.5));
  g.add(box(0.62, 0.46, 0.78, 0xb8c2cc, 0.36, y, 0.45));
  g.add(box(0.66, 0.04, 0.82, pick([C.sign, C.depotRoof, 0x2e7d4f], v), 0.36, y + 0.46, 0.45));
  for (let k = 0; k < 5; k++) g.add(box(0.012, 0.46, 0.8, C.shedTrim, 0.08 + k * 0.14, y, 0.45));
  g.add(box(0.3, 0.3, 0.012, C.chassis, 0.36, y, 0.845));
  for (const z of [0.2, 0.42]) {
    g.add(cyl(0.05, 1.05, 0x9aa1a8, 0.58, y + 0.46, z, 8));
    g.add(cyl(0.055, 0.05, C.funnel, 0.58, y + 1.36, z, 8));
  }
  const paints = [C.funnel, C.sign, C.stripe, 0x3fa34d];
  for (let k = 0; k < 3; k++) {
    g.add(
      box(0.15, 0.13, 0.36, paints[(k + Math.floor(v * 4)) % 4], 0.84, y + 0.03, 0.22 + k * 0.28),
    );
  }
}

/**
 * Merge a model's parts into one mesh per colour. A city is thousands of
 * little boxes; drawn one by one they would bring the frame rate down.
 * The merged geometry is new and must be disposed of when the model goes:
 * it is pushed onto `owned` for whoever keeps it.
 */
export function bake(g: Group, owned?: BufferGeometry[]): Group {
  g.updateMatrixWorld(true);
  const parts = new Map<Material, BufferGeometry[]>();
  g.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const geo = (o.geometry as BufferGeometry).clone().applyMatrix4(o.matrixWorld);
    const flat = geo.index ? geo.toNonIndexed() : geo;
    const m = o.material as Material;
    parts.set(m, [...(parts.get(m) ?? []), flat]);
  });
  const out = new Group();
  for (const [m, geos] of parts) {
    const merged = mergeGeometries(geos);
    if (!merged) continue;
    owned?.push(merged);
    const mesh = new Mesh(merged, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.add(mesh);
  }
  return out;
}

/** A town building, facing +z; null for codes that are not one. */
export function townBuilding(
  code: number,
  top: number,
  v: number,
  owned?: BufferGeometry[],
): Group | null {
  const g = new Group();
  switch (code) {
    case Build.Cottage:
      cottage(g, top, v);
      break;
    case Build.House:
      house(g, top, v);
      break;
    case Build.Shop:
      shop(g, top, v);
      break;
    case Build.Flats:
      flats(g, top, v);
      break;
    case Build.Tower:
      tower(g, top, v);
      break;
    case Build.Chapel:
      chapel(g, top);
      break;
    case Build.FishShed:
      fishShed(g, top, v);
      break;
    case Build.Park:
      park(g, top, v);
      break;
    case Build.FishMarket:
      fishMarket(g, top);
      break;
    case Build.Cannery:
      cannery(g, top);
      break;
    case Build.IceHouse:
      iceHouse(g, top);
      break;
    case Build.Restaurant:
      restaurant(g, top);
      break;
    case Build.BuildersYard:
      buildersYard(g, top);
      break;
    case Build.School:
      school(g, top, v);
      break;
    case Build.TownHall:
      townHall(g, top);
      break;
    case Build.Store:
      store(g, top, v);
      break;
    case Build.Factory:
      factory(g, top, v);
      break;
    default:
      return null;
  }
  return bake(g, owned);
}

/**
 * Pavements down the sides of a town street with no street beyond, and now
 * and then a street lamp. `open` holds which sides (+x, -x, +z, -z) carry on.
 */
export function pavements(
  g: Group,
  top: number,
  open: readonly boolean[],
  lamp: boolean,
): Object3D {
  const y = top + 0.05;
  const sides = [
    [0.93, 0.5, 0.14, 1],
    [0.07, 0.5, 0.14, 1],
    [0.5, 0.93, 1, 0.14],
    [0.5, 0.07, 1, 0.14],
  ] as const;
  sides.forEach(([x, z, w, d], k) => {
    if (open[k]) return;
    g.add(box(w, 0.025, d, PAVING, x, y, z));
    // Kerb on the road side.
    const kx = w < 1 ? (x > 0.5 ? x - 0.07 : x + 0.07) : x;
    const kz = d < 1 ? (z > 0.5 ? z - 0.07 : z + 0.07) : z;
    g.add(box(w < 1 ? 0.02 : 1, 0.03, d < 1 ? 0.02 : 1, KERB, kx, y, kz));
  });
  if (lamp) {
    const side = sides.findIndex((_, k) => !open[k]);
    if (side >= 0) {
      const [x, z] = sides[side];
      g.add(cyl(0.012, 0.36, C.chassis, x, y, z));
      g.add(box(0.06, 0.03, 0.06, 0xfff2b0, x, y + 0.36, z));
    }
  }
  return g;
}
