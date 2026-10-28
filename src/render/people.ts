import { Group, type Object3D } from 'three';
import { Rng } from '../sim/rng';
import { box, cyl } from './parts';

// Procedural dock workers. Each is built from a seed: skin, hair, build,
// work clothes and headgear vary, so a crew is a crowd of individuals.
// Faces +X, feet at y=0, about 0.42 tiles tall.

export interface Limbs {
  legL: Object3D;
  legR: Object3D;
  armL: Object3D;
  armR: Object3D;
}

export interface Worker {
  root: Group;
  /** Everything above the feet, bobbed while walking. */
  body: Group;
  limbs: Limbs;
  /** The crate they carry, held out in front. */
  load: Object3D;
}

const SKIN = [0xf6d5b8, 0xf1c59b, 0xe0ac7e, 0xc68642, 0x8d5524, 0x5c3a21];
const HAIR = [0x2b1d14, 0x5a3a22, 0x9a6b3c, 0xd9b26a, 0x8a8a8a, 0x1a1a1a, 0xa0412d];
/** Hi-vis vests, mostly orange and yellow, the odd red one. */
const VEST = [0xff8a1f, 0xff8a1f, 0xd9ef3a, 0xd9ef3a, 0xff5a3c];
const SHIRT = [0x2f6fd0, 0x3b3f46, 0xe3e1d8, 0x2e7d4f, 0x8a2f2f];
const TROUSERS = [0x2d4a7a, 0x3b3f46, 0x4a5d3a, 0x2f3b55, 0x6b5a45];
const HARD_HAT = [0xf5c02a, 0xf4f4f0, 0xff8a1f, 0x2f6fd0, 0xd6453d];
const KNIT = [0xb33a32, 0x24324a, 0x3fa34d, 0x6b3a7a, 0xd9822b];
const BOOTS = 0x3a2a1e;
const REFLECT = 0xdfe6ea;
const C_WHITE = 0xf4f4f0;

export function worker(seed: number, crate: (size: number) => Object3D): Worker {
  const rng = new Rng(seed * 2654435761 + 17);
  const skin = rng.pick(SKIN);
  const hair = rng.pick(HAIR);
  const vest = rng.pick(VEST);
  const shirt = rng.pick(SHIRT);
  const trousers = rng.pick(TROUSERS);
  // Build: a little taller or shorter, broader or slighter.
  const broad = rng.range(0.9, 1.15);

  const root = new Group();
  const body = new Group();
  root.add(body);
  root.scale.setScalar(rng.range(0.92, 1.08));

  // Legs swing from the hip.
  const leg = (z: number) => {
    const hip = new Group();
    hip.position.set(0, 0.15, z);
    hip.add(box(0.055, 0.12, 0.05, trousers, 0, -0.12, 0));
    hip.add(box(0.07, 0.035, 0.055, BOOTS, 0.008, -0.15, 0));
    body.add(hip);
    return hip;
  };
  const legL = leg(-0.034 * broad);
  const legR = leg(0.034 * broad);

  // Torso: shirt with a hi-vis vest over it and two reflective bands.
  const tw = 0.13 * broad;
  body.add(box(0.085, 0.15, tw, shirt, 0, 0.145, 0));
  body.add(box(0.09, 0.12, tw + 0.006, vest, 0, 0.165, 0));
  for (const y of [0.19, 0.235]) body.add(box(0.092, 0.012, tw + 0.008, REFLECT, 0, y, 0));

  // Arms hang from the shoulders, sleeves in the shirt colour.
  const arm = (z: number) => {
    const shoulder = new Group();
    shoulder.position.set(0, 0.285, z);
    shoulder.add(box(0.045, 0.1, 0.04, shirt, 0, -0.1, 0));
    shoulder.add(box(0.04, 0.035, 0.038, skin, 0, -0.13, 0));
    body.add(shoulder);
    return shoulder;
  };
  const armL = arm(-(tw / 2 + 0.022));
  const armR = arm(tw / 2 + 0.022);

  // Head, eyes, hair.
  body.add(box(0.03, 0.02, 0.03, skin, 0, 0.295, 0));
  body.add(box(0.085, 0.09, 0.085, skin, 0, 0.31, 0));
  for (const z of [-0.018, 0.018]) body.add(box(0.006, 0.012, 0.01, 0x1a1a1a, 0.043, 0.355, z));
  body.add(box(0.06, 0.05, 0.09, hair, -0.02, 0.35, 0));
  if (rng.next() < 0.3) {
    // A beard.
    body.add(box(0.02, 0.035, 0.07, hair, 0.04, 0.31, 0));
  }
  const hat = rng.pick(['hardhat', 'hardhat', 'beanie', 'cap', 'none'] as const);
  if (hat === 'hardhat') {
    const c = rng.pick(HARD_HAT);
    body.add(cyl(0.055, 0.04, c, 0, 0.395, 0, 8));
    body.add(box(0.13, 0.008, 0.11, c, 0.01, 0.395, 0));
  } else if (hat === 'beanie') {
    body.add(box(0.092, 0.04, 0.092, rng.pick(KNIT), 0, 0.39, 0));
    body.add(box(0.03, 0.02, 0.03, C_WHITE, 0, 0.43, 0));
  } else if (hat === 'cap') {
    const c = rng.pick(KNIT);
    body.add(box(0.09, 0.03, 0.09, c, 0, 0.395, 0));
    body.add(box(0.05, 0.008, 0.08, c, 0.06, 0.395, 0));
  } else {
    body.add(box(0.09, 0.025, 0.092, hair, -0.004, 0.395, 0));
  }

  const load = crate(0.15);
  load.position.set(0.11, 0.17, 0);
  load.visible = false;
  body.add(load);
  return { root, body, limbs: { legL, legR, armL, armR }, load };
}

/**
 * Walk cycle: legs and arms swing in opposite pairs. Someone carrying a
 * crate holds both arms out in front instead.
 */
export function pose(
  w: { body?: Object3D; limbs?: Limbs },
  moving: boolean,
  carrying: boolean,
  phase: number,
): void {
  const l = w.limbs;
  if (!l) return;
  const swing = moving ? Math.sin(phase) * 0.65 : 0;
  l.legL.rotation.z = swing;
  l.legR.rotation.z = -swing;
  if (carrying) {
    l.armL.rotation.z = l.armR.rotation.z = 1.25;
  } else {
    const idle = moving ? 0 : Math.sin(phase * 0.15) * 0.05;
    l.armL.rotation.z = -swing * 0.8 + idle;
    l.armR.rotation.z = swing * 0.8 + idle;
  }
  if (w.body) w.body.position.y = moving ? Math.abs(Math.sin(phase)) * 0.015 : 0;
}
