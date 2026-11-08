import { Group, type Object3D } from 'three';
import { Rng } from '../sim/rng';
import type { Model } from './model';
import { CRATE } from './models';
import { box, cyl } from './parts';
import { clamp01 } from './util/math';

// Procedural dock workers. Each is built from a seed: skin, hair, build,
// work clothes and headgear vary, so a crew is a crowd of individuals.
// Faces +X, feet at y=0, about 0.42 tiles tall.

export interface Limbs {
  legL: Object3D;
  legR: Object3D;
  armL: Object3D;
  armR: Object3D;
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
/** Where a crate is held out in front, and where it is set down. */
const HELD = { x: 0.11, y: 0.17 };
const SET_DOWN = { x: 0.16, y: 0 };
/** Height of the hips, and how far forward someone bends to the ground. */
const HIP = 0.15;
const BEND = 1;
/** Leaning out further, per tile: how much more they bend, and reach forward with their arms. */
const LEAN_BEND = 1.1;
/**
 * Arms from straight down, setting a crate down: by the sides of it on the
 * ground, out level at waist height, and how much higher per tile above.
 */
const HANDS_DOWN = 0.36;
const HANDS_OUT = 1.35;
const HANDS_UP = 3;
const LEAN_ARMS = 3;

/** A dock worker: `body` is everything above the feet, bobbed while walking; the one crate they carry is held out in front. */
export function worker(seed: number, crate: (size: number) => Object3D): Model {
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

  // Round the side of the break hut, now and then: hidden but for that.
  const stream = new Group();
  const arc = box(0.1, 0.01, 0.01, 0xf2d33a, 0.05, 0, 0);
  arc.rotation.z = -0.9;
  stream.add(arc);
  stream.position.set(0.05, 0.13, 0);
  stream.visible = false;
  body.add(stream);
  // Nodding off on the bench: a little Z rising over their head.
  const snore = new Group();
  const ink = 0xf4f4f0;
  snore.add(box(0.004, 0.008, 0.05, ink, 0, 0.04, 0));
  snore.add(box(0.004, 0.008, 0.05, ink, 0, 0, 0));
  const slash = box(0.004, 0.008, 0.06, ink, 0, 0.02, 0);
  slash.rotation.x = -0.68;
  snore.add(slash);
  snore.position.set(0, 0.5, 0.06);
  snore.visible = false;
  body.add(snore);

  // As big as every other crate, however tall or short they are.
  const load = crate(CRATE);
  load.scale.setScalar(1 / root.scale.x);
  load.position.set(HELD.x, HELD.y, 0);
  load.visible = false;
  body.add(load);
  return { root, crates: [load], body, limbs: { legL, legR, armL, armR }, stream, snore };
}

/** Harbourmasters' beards, mostly grey or white with years at sea. */
const BEARD = [0x9a9a9a, 0xd8d8d0, 0xd8d8d0, 0x5a3a22, 0xa0412d];
const COAT = 0x2a4f9e;
const BRASS = 0xd9b84a;

/**
 * A harbourmaster: a long blue coat with brass buttons, a full beard and a
 * peaked cap; built from their id like a dock worker, see worker().
 */
export function harbourmaster(seed: number): Model {
  const rng = new Rng(seed * 2654435761 + 29);
  const skin = rng.pick(SKIN);
  const beard = rng.pick(BEARD);
  const broad = rng.range(1, 1.15);

  const root = new Group();
  const body = new Group();
  root.add(body);
  root.scale.setScalar(rng.range(0.98, 1.08));

  const leg = (z: number) => {
    const hip = new Group();
    hip.position.set(0, 0.15, z);
    hip.add(box(0.055, 0.12, 0.05, 0x1f2a44, 0, -0.12, 0));
    hip.add(box(0.07, 0.035, 0.055, 0x1a1a1a, 0.008, -0.15, 0));
    body.add(hip);
    return hip;
  };
  const legL = leg(-0.034 * broad);
  const legR = leg(0.034 * broad);

  // The coat, down over the tops of the legs, with two rows of buttons
  // and the white shirt collar showing at the neck. Boxes stand on their y.
  const tw = 0.135 * broad;
  body.add(box(0.095, 0.22, tw, COAT, 0, 0.08, 0));
  body.add(box(0.01, 0.035, 0.035, 0xf4f4f0, 0.048, 0.262, 0));
  for (const y of [0.235, 0.195, 0.155]) {
    for (const z of [-0.025, 0.025]) body.add(box(0.01, 0.014, 0.014, BRASS, 0.048, y, z));
  }

  const arm = (z: number) => {
    const shoulder = new Group();
    shoulder.position.set(0, 0.285, z);
    shoulder.add(box(0.05, 0.11, 0.045, COAT, 0, -0.1, 0));
    shoulder.add(box(0.04, 0.035, 0.038, skin, 0, -0.13, 0));
    body.add(shoulder);
    return shoulder;
  };
  const armL = arm(-(tw / 2 + 0.024));
  const armR = arm(tw / 2 + 0.024);

  // Head, a full beard and moustache, and a peaked cap with its badge.
  body.add(box(0.03, 0.02, 0.03, skin, 0, 0.295, 0));
  body.add(box(0.085, 0.09, 0.085, skin, 0, 0.31, 0));
  for (const z of [-0.018, 0.018]) body.add(box(0.006, 0.012, 0.01, 0x1a1a1a, 0.043, 0.36, z));
  body.add(box(0.025, 0.06, 0.092, beard, 0.034, 0.285, 0));
  body.add(box(0.07, 0.045, 0.094, beard, -0.004, 0.3, 0));
  body.add(box(0.012, 0.012, 0.05, beard, 0.047, 0.338, 0));
  body.add(box(0.04, 0.04, 0.09, beard, -0.026, 0.35, 0));
  body.add(box(0.092, 0.03, 0.092, 0x1f2a44, 0, 0.395, 0));
  body.add(box(0.105, 0.022, 0.105, 0xf4f4f0, -0.004, 0.425, 0));
  body.add(box(0.05, 0.008, 0.085, 0x1a1a1a, 0.06, 0.395, 0));
  body.add(box(0.008, 0.016, 0.02, BRASS, 0.047, 0.402, 0));

  return { root, crates: [], body, limbs: { legL, legR, armL, armR } };
}

/**
 * A harbourmaster pointing out a boat ahead of them with their right arm,
 * a jab now and then, and in between a hand up shading their eyes to look.
 */
export function pointOut(w: { body?: Object3D; limbs?: Limbs }, id: number, t: number): void {
  const l = w.limbs;
  if (!l || !w.body) return;
  const k = (t + id * 1.3) % 7;
  const ease = (a: number) => {
    const f = clamp01(a);
    return f * f * (3 - 2 * f);
  };
  if (k < 4) {
    const f = ease(Math.min(k, 4 - k) / 0.4);
    l.armR.rotation.z = (1.75 + Math.max(0, Math.sin(t * 5)) * 0.15) * f;
    w.body.rotation.z += 0.05 * f;
  } else {
    const f = ease(Math.min(k - 4, 7 - k) / 0.4);
    l.armL.rotation.z = 2.5 * f;
    l.armL.rotation.x = 0.35 * f;
    w.body.rotation.y = Math.sin(t * 0.8) * 0.3 * f;
  }
}

const UNIFORM = 0x2e3138;
const GOLD = 0xd9b84a;

/**
 * A customs officer: a dark uniform jacket over a white shirt and black
 * tie, a black peaked cap with a gold band, and a clipboard in their left
 * hand; built from their id like a dock worker, see worker().
 */
export function customsOfficer(seed: number): Model {
  const rng = new Rng(seed * 2654435761 + 41);
  const skin = rng.pick(SKIN);
  const hair = rng.pick(HAIR);
  const broad = rng.range(0.92, 1.08);

  const root = new Group();
  const body = new Group();
  root.add(body);
  root.scale.setScalar(rng.range(0.94, 1.06));

  const leg = (z: number) => {
    const hip = new Group();
    hip.position.set(0, 0.15, z);
    hip.add(box(0.055, 0.12, 0.05, UNIFORM, 0, -0.12, 0));
    hip.add(box(0.07, 0.035, 0.055, 0x111111, 0.008, -0.15, 0));
    body.add(hip);
    return hip;
  };
  const legL = leg(-0.034 * broad);
  const legR = leg(0.034 * broad);

  // The jacket, the shirt and tie at the neck, and a badge on the chest.
  const tw = 0.13 * broad;
  body.add(box(0.09, 0.17, tw, UNIFORM, 0, 0.125, 0));
  body.add(box(0.01, 0.05, 0.035, 0xf4f4f0, 0.046, 0.245, 0));
  body.add(box(0.012, 0.045, 0.012, 0x111111, 0.048, 0.24, 0));
  body.add(box(0.01, 0.016, 0.016, GOLD, 0.046, 0.22, -0.035));

  const arm = (z: number) => {
    const shoulder = new Group();
    shoulder.position.set(0, 0.285, z);
    shoulder.add(box(0.045, 0.1, 0.04, UNIFORM, 0, -0.1, 0));
    shoulder.add(box(0.04, 0.035, 0.038, skin, 0, -0.13, 0));
    body.add(shoulder);
    return shoulder;
  };
  const armL = arm(-(tw / 2 + 0.022));
  const armR = arm(tw / 2 + 0.022);
  // The clipboard, along the hand: hanging by their side as they walk, flat
  // in front of them held out to write on.
  armL.add(box(0.008, 0.075, 0.06, 0x8a5a2b, 0.02, -0.185, 0));
  armL.add(box(0.004, 0.06, 0.048, 0xf4f4f0, 0.025, -0.178, 0));

  // Head, hair, and the cap.
  body.add(box(0.03, 0.02, 0.03, skin, 0, 0.295, 0));
  body.add(box(0.085, 0.09, 0.085, skin, 0, 0.31, 0));
  for (const z of [-0.018, 0.018]) body.add(box(0.006, 0.012, 0.01, 0x1a1a1a, 0.043, 0.36, z));
  body.add(box(0.05, 0.05, 0.09, hair, -0.022, 0.35, 0));
  body.add(box(0.092, 0.022, 0.092, GOLD, 0, 0.395, 0));
  body.add(box(0.102, 0.03, 0.102, 0x111111, -0.004, 0.417, 0));
  body.add(box(0.05, 0.008, 0.085, 0x111111, 0.06, 0.395, 0));
  body.add(box(0.008, 0.016, 0.02, 0xf4f4f0, 0.047, 0.42, 0));

  return { root, crates: [], body, limbs: { legL, legR, armL, armR } };
}

/**
 * A customs officer going through a ship's papers: the clipboard held out
 * in front, writing on it bent over a little, and every few seconds looking
 * up at the ship.
 */
export function checkPapers(w: { body?: Object3D; limbs?: Limbs }, id: number, t: number): void {
  const l = w.limbs;
  if (!l || !w.body) return;
  const k = (t + id * 0.9) % 6;
  const up = clamp01(Math.min(k - 4.5, 6 - k) / 0.3);
  l.armL.rotation.z = 1.2 - 0.3 * up;
  l.armL.rotation.x = -0.5;
  l.armR.rotation.z = 1.0 - 0.5 * up + Math.sin(t * 11) * 0.05 * (1 - up);
  l.armR.rotation.x = 0.35;
  w.body.rotation.z += -0.12 * (1 - up) + 0.08 * up;
}

/**
 * A berthing master: an orange hi-vis jacket over navy, a white hard hat,
 * a radio clipped to their chest and binoculars in their right hand; built
 * from their id like a dock worker, see worker().
 */
export function berthingMaster(seed: number): Model {
  const rng = new Rng(seed * 2654435761 + 53);
  const skin = rng.pick(SKIN);
  const hair = rng.pick(HAIR);
  const broad = rng.range(0.95, 1.1);

  const root = new Group();
  const body = new Group();
  root.add(body);
  root.scale.setScalar(rng.range(0.94, 1.06));

  const leg = (z: number) => {
    const hip = new Group();
    hip.position.set(0, 0.15, z);
    hip.add(box(0.055, 0.12, 0.05, 0x1f2a44, 0, -0.12, 0));
    hip.add(box(0.07, 0.035, 0.055, BOOTS, 0.008, -0.15, 0));
    body.add(hip);
    return hip;
  };
  const legL = leg(-0.034 * broad);
  const legR = leg(0.034 * broad);

  // The hi-vis jacket with its bands, and the radio on the chest.
  const tw = 0.135 * broad;
  const jacket = 0xff8a1f;
  body.add(box(0.095, 0.17, tw, jacket, 0, 0.125, 0));
  for (const y of [0.17, 0.225]) body.add(box(0.097, 0.012, tw + 0.004, REFLECT, 0, y, 0));
  body.add(box(0.015, 0.04, 0.022, 0x1a1a1a, 0.052, 0.235, -0.03));
  body.add(box(0.004, 0.03, 0.004, 0x1a1a1a, 0.052, 0.275, -0.038));

  const arm = (z: number) => {
    const shoulder = new Group();
    shoulder.position.set(0, 0.285, z);
    shoulder.add(box(0.045, 0.1, 0.04, jacket, 0, -0.1, 0));
    shoulder.add(box(0.047, 0.01, 0.042, REFLECT, 0, -0.07, 0));
    shoulder.add(box(0.04, 0.035, 0.038, skin, 0, -0.13, 0));
    body.add(shoulder);
    return shoulder;
  };
  const armL = arm(-(tw / 2 + 0.022));
  const armR = arm(tw / 2 + 0.022);
  // Binoculars, in the hand: up to their eyes when they look through them.
  armR.add(box(0.03, 0.045, 0.05, 0x1a1a1a, 0.02, -0.17, -0.02));

  // Head, hair, and the hard hat.
  body.add(box(0.03, 0.02, 0.03, skin, 0, 0.295, 0));
  body.add(box(0.085, 0.09, 0.085, skin, 0, 0.31, 0));
  for (const z of [-0.018, 0.018]) body.add(box(0.006, 0.012, 0.01, 0x1a1a1a, 0.043, 0.36, z));
  body.add(box(0.05, 0.05, 0.09, hair, -0.022, 0.35, 0));
  body.add(cyl(0.055, 0.04, C_WHITE, 0, 0.395, 0, 8));
  body.add(box(0.13, 0.008, 0.11, C_WHITE, 0.01, 0.395, 0));

  return { root, crates: [], body, limbs: { legL, legR, armL, armR } };
}

/**
 * A berthing master waving a ship in alongside: both arms up, beckoning it
 * on over and over, as a marshaller would.
 */
export function waveIn(w: { body?: Object3D; limbs?: Limbs }, t: number): void {
  const l = w.limbs;
  if (!l || !w.body) return;
  const k = Math.sin(t * 4);
  l.armL.rotation.x = 2.5;
  l.armR.rotation.x = -2.5;
  l.armL.rotation.z = 0.2 + k * 0.45;
  l.armR.rotation.z = 0.2 + k * 0.45;
  w.body.rotation.z += 0.05;
}

/** A berthing master watching a ship through their binoculars, turning slowly to follow it. */
export function binoculars(w: { body?: Object3D; limbs?: Limbs }, t: number): void {
  const l = w.limbs;
  if (!l || !w.body) return;
  l.armR.rotation.z = 2.25;
  l.armR.rotation.x = -0.3;
  l.armL.rotation.z = 2.25;
  l.armL.rotation.x = 0.3;
  w.body.rotation.z += 0.06;
  w.body.rotation.y = Math.sin(t * 0.4) * 0.12;
}

/** Hips above the feet sat on the break hut's bench, and the legs out from it. */
const SEAT = 0.09;
const KNEES = 0.95;

/**
 * Sat on the bench outside the break hut: hips down on it, legs out in
 * front to the ground, hands in the lap, rocking a little as they talk.
 */
export function sit(w: { body?: Object3D; limbs?: Limbs }, phase: number): void {
  const l = w.limbs;
  if (!l || !w.body) return;
  l.legL.rotation.z = l.legR.rotation.z = KNEES;
  l.armL.rotation.z = l.armR.rotation.z = 0.55;
  l.armL.rotation.x = l.armR.rotation.x = 0;
  const sway = Math.sin(phase * 0.1) * 0.04;
  w.body.rotation.z = -sway;
  w.body.rotation.y = 0;
  w.body.position.set(0, SEAT - HIP, 0);
}

/**
 * What a dockhand on a break at the hut does, now and then other than sit
 * and chat: nod off, leaning back against the hut, or slip round the side
 * of it to relieve themselves.
 */
export type Break = 'sit' | 'doze' | 'pee';

/** Seconds each break-time turn lasts. */
const BREAK_TIME = 30;

/** What dockhand `id` is doing on the bench at time `t` (seconds): mostly sitting. */
export function breakAt(id: number, t: number): Break {
  const k = Math.floor(t / BREAK_TIME + id * 0.61);
  const roll = Math.abs((k * 2654435761 + id * 97) | 0) % 24;
  return roll === 0 ? 'pee' : roll <= 3 ? 'doze' : 'sit';
}

/** Dozing on the bench: sat back against the hut, arms limp, breathing slow. */
export function doze(w: { body?: Object3D; limbs?: Limbs; snore?: Object3D }, phase: number): void {
  sit(w, 0);
  const l = w.limbs;
  if (!l || !w.body) return;
  l.armL.rotation.z = l.armR.rotation.z = 0.15;
  w.body.rotation.z = 0.42 + Math.sin(phase * 0.05) * 0.02;
  if (w.snore) {
    // Rising and fading over and over, upright whatever the lean.
    const f = (phase * 0.02) % 1;
    w.snore.visible = true;
    w.snore.position.set(0.02 + f * 0.04, 0.46 + f * 0.12, 0.06);
    w.snore.rotation.z = -w.body.rotation.z;
    w.snore.scale.setScalar(0.6 + f * 0.6);
  }
}

/** Stood facing the side of the hut, hands in front, with the stream showing. */
export function pee(w: { body?: Object3D; limbs?: Limbs; stream?: Object3D }, phase: number): void {
  pose(w, false, false, phase, 0);
  const l = w.limbs;
  if (!l || !w.body) return;
  l.armL.rotation.z = l.armR.rotation.z = 0.7;
  l.armL.rotation.x = -0.25;
  l.armR.rotation.x = 0.25;
  if (w.stream) {
    w.stream.visible = true;
    w.stream.scale.x = 0.9 + Math.sin(phase * 0.8) * 0.1;
  }
}

/** Things a dockhand does standing about with nothing to do. */
export type Fidget =
  | 'look'
  | 'scratch'
  | 'watch'
  | 'tap'
  | 'chat'
  | 'still'
  | 'jog'
  | 'sit'
  | 'peer'
  | 'dance'
  | 'flex'
  | 'wave'
  | 'hop'
  | 'spin'
  | 'windmill';
/** Mostly the quiet ones, now and then a daft one. */
const FIDGETS: Fidget[] = [
  'look',
  'wave',
  'scratch',
  'watch',
  'tap',
  'look',
  'still',
  'sit',
  'peer',
  'jog',
  'tap',
  'sit',
  'peer',
  'wave',
  'look',
  'dance',
  'flex',
  'hop',
  'spin',
  'windmill',
];
/** Seconds each lasts, and how long they take to go into one and out of it. */
const FIDGET_TIME = 5;
const FIDGET_EASE = 0.6;

/**
 * What dockhand `id` is doing standing about at time `t` (seconds): one
 * thing after another, each their own, chatting when someone stands by;
 * and how far into it they are, 0 to 1, easing in and out.
 */
export function fidgetAt(id: number, t: number, company: boolean): [Fidget, number] {
  const k = Math.floor(t / FIDGET_TIME + id * 0.37);
  const into = t - (k - id * 0.37) * FIDGET_TIME;
  const pick = FIDGETS[Math.abs((k * 2654435761 + id * 40503) | 0) % FIDGETS.length];
  const what = company && k % 2 === 0 ? 'chat' : pick;
  const e = Math.min(1, into / FIDGET_EASE, (FIDGET_TIME - into) / FIDGET_EASE);
  const f = Math.max(0, e);
  return [what, f * f * (3 - 2 * f)];
}

/**
 * Standing about, on top of how pose() has them stand: looking round,
 * waving, scratching their head, checking the time, tapping a foot or
 * waving a hand about as they chat; `f` of the way into it.
 */
export function fidget(
  w: { body?: Object3D; limbs?: Limbs },
  what: Fidget,
  t: number,
  f: number,
): void {
  const l = w.limbs;
  const body = w.body;
  if (!l || !body || f <= 0) return;
  const to = (o: Object3D, z: number) => (o.rotation.z += (z - o.rotation.z) * f);
  switch (what) {
    case 'look':
      // Turning from the waist one way and the other.
      body.rotation.y = Math.sin(t * 0.9) * 0.6 * f;
      break;
    case 'scratch':
      to(l.armR, 2.6 + Math.sin(t * 9) * 0.12);
      body.rotation.y = 0.15 * f;
      break;
    case 'watch':
      // The left wrist up in front, looking down at it.
      to(l.armL, 1.5);
      body.rotation.z += -0.1 * f;
      break;
    case 'tap':
      to(l.legR, Math.max(0, Math.sin(t * 7)) * 0.25);
      to(l.armL, -0.15);
      to(l.armR, -0.15);
      break;
    case 'chat':
      to(l.armR, 1.0 + Math.sin(t * 3.1) * 0.45);
      to(l.armL, 0.3 + Math.sin(t * 2.3 + 1) * 0.2);
      body.rotation.y = Math.sin(t * 1.3) * 0.15 * f;
      break;
    case 'jog': {
      // Running on the spot, knees and elbows pumping.
      const k = Math.sin(t * 14);
      to(l.legL, k * 0.7);
      to(l.legR, -k * 0.7);
      to(l.armL, -k * 0.8 + 0.4);
      to(l.armR, k * 0.8 + 0.4);
      body.position.y += Math.abs(Math.cos(t * 14)) * 0.025 * f;
      break;
    }
    case 'sit':
      // Sat down on the ground, legs out in front, leaning back on their hands.
      to(l.legL, 1.45);
      to(l.legR, 1.45);
      to(l.armL, -0.7);
      to(l.armR, -0.7);
      body.position.y += (0.035 - HIP) * f;
      body.rotation.z += 0.15 * f;
      break;
    case 'peer': {
      // Bent over something on the ground, pointing at it.
      const bend = 0.9 * f;
      body.rotation.z -= bend;
      body.position.x += -HIP * Math.sin(bend);
      body.position.y += HIP - HIP * Math.cos(bend);
      to(l.legL, bend);
      to(l.legR, bend);
      to(l.armR, bend + 0.9 + Math.sin(t * 5) * 0.08);
      to(l.armL, bend + 0.2);
      body.rotation.y = Math.sin(t * 0.7) * 0.2 * f;
      break;
    }
    case 'dance': {
      // Arms waving up either side, hips swaying, stepping from foot to foot.
      const k = Math.sin(t * 6);
      l.armL.rotation.x = (1.6 + k * 0.9) * f;
      l.armR.rotation.x = -(1.6 - k * 0.9) * f;
      to(l.legL, Math.max(0, k) * 0.4);
      to(l.legR, Math.max(0, -k) * 0.4);
      body.rotation.y = Math.sin(t * 3) * 0.5 * f;
      body.position.y += Math.abs(k) * 0.02 * f;
      break;
    }
    case 'flex':
      // Showing off: arms up and out either side, leaning back proudly.
      l.armL.rotation.x = 1.5 * f;
      l.armR.rotation.x = -1.5 * f;
      to(l.armL, 0.6 + Math.sin(t * 8) * 0.15);
      to(l.armR, 0.6 - Math.sin(t * 8) * 0.15);
      body.rotation.z += 0.12 * f;
      break;
    case 'wave':
      // Waving up at whoever is watching, see Entities.standAbout.
      l.armR.rotation.x = -(2.6 + Math.sin(t * 10) * 0.35) * f;
      body.rotation.z += 0.08 * f;
      break;
    case 'hop':
      // Hopping on the spot, feet tucked up under them.
      body.position.y += Math.abs(Math.sin(t * 5)) * 0.09 * f;
      to(l.legL, -0.3);
      to(l.legR, -0.3);
      to(l.armL, 0.9);
      to(l.armR, 0.9);
      break;
    case 'spin':
      // Twirling round one way and back, arms out.
      body.rotation.y = Math.sin(t * 2.5) * Math.PI * f;
      l.armL.rotation.x = 1.4 * f;
      l.armR.rotation.x = -1.4 * f;
      break;
    case 'windmill':
      // Arms whirling up and over like a windmill.
      to(l.armL, 1.5 + Math.sin(t * 7) * 1.6);
      to(l.armR, 1.5 - Math.sin(t * 7) * 1.6);
      break;
    case 'still':
      break;
  }
}

/**
 * Walk cycle: legs and arms swing in opposite pairs. Someone carrying a
 * crate holds both arms out in front instead. Stooping (0 to 1), they go to
 * take hold of a crate, or set one down, `drop` above their feet: on the
 * ground they bend forward from the hips with their arms down; the higher
 * it is the less they bend, to a truck's bed at about waist height with
 * their arms out level, and onto a stack above that reaching up with it.
 * Leaning `over` tiles further out, to a crate on a boat from the edge of
 * the quay, they bend further and reach out for it.
 */
export function pose(
  w: { body?: Object3D; limbs?: Limbs; crates?: Object3D[] },
  moving: boolean,
  carrying: boolean,
  phase: number,
  stoop = 0,
  over = 0,
  drop = 0,
): void {
  const l = w.limbs;
  if (!l) return;
  const lean = Math.max(0, over) * stoop;
  const lift = Math.max(-0.3, Math.min(0.45, drop));
  // How far down it is: 1 on the ground (or below, off the edge), 0 at the height they carry it.
  const low = clamp01((HELD.y - lift) / HELD.y);
  const bend = BEND * low * stoop + LEAN_BEND * lean;
  const swing = moving ? Math.sin(phase) * 0.65 : 0;
  // The legs stay upright as the body bends over them.
  l.legL.rotation.z = swing * (1 - stoop) + bend;
  l.legR.rotation.z = -swing * (1 - stoop) + bend;
  // Out to the side only standing about, see fidget().
  l.armL.rotation.x = l.armR.rotation.x = 0;
  // Hands down by the sides of a crate on the ground, out level to one at
  // waist height, up to one above.
  const level = HANDS_DOWN + (HANDS_OUT - HANDS_DOWN) * (1 - low);
  const reach = bend + level + Math.max(0, lift - HELD.y) * HANDS_UP + LEAN_ARMS * lean;
  if (carrying) {
    l.armL.rotation.z = l.armR.rotation.z = 1.25 + (reach - 1.25) * stoop;
  } else {
    const idle = moving ? 0 : Math.sin(phase * 0.15) * 0.05;
    l.armL.rotation.z = (-swing * 0.8 + idle) * (1 - stoop) + reach * stoop;
    l.armR.rotation.z = (swing * 0.8 + idle) * (1 - stoop) + reach * stoop;
  }
  const body = w.body;
  if (!body) return;
  // Bent from the hips, which stay where they are.
  const sin = Math.sin(bend);
  const cos = Math.cos(bend);
  const bob = moving ? Math.abs(Math.sin(phase)) * 0.015 * (1 - stoop) : 0;
  const bx = -HIP * sin;
  const by = HIP - HIP * cos;
  body.rotation.z = -bend;
  body.rotation.y = 0;
  body.position.set(bx, by + bob, 0);
  // The crate goes down with the hands, level, to the ground in front.
  const load = w.crates?.[0];
  if (load) {
    const x = HELD.x + (SET_DOWN.x - HELD.x) * stoop + lean - bx;
    const y = HELD.y + (SET_DOWN.y + lift - HELD.y) * stoop - by;
    load.position.set(x * cos - y * sin, x * sin + y * cos, 0);
    load.rotation.z = bend;
  }
}
