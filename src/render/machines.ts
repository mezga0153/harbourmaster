import { Group, type Object3D } from 'three';
import { BOX_HEIGHT, BOX_LENGTH } from './assets';
import type { Model } from './model';
import { container, crate, CRATE } from './models';
import { C } from './palette';
import { lamp, LIGHT, pool } from './lights';
import { box, cyl } from './parts';
import { sit, worker } from './people';

// The port's own machines: forklifts, reach stackers and terminal
// tractors, the same every time but for a forklift's driver. All face +X
// with their wheels on y=0.

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

/** Forklifts: how high the forks ride empty and with a load, above the ground. */
export const FORKS_EMPTY = 0.05;
export const FORKS_LOADED = 0.12;

/** How big a forklift's driver is beside the dockhands on foot, to fit under its guard. */
const DRIVER_SCALE = 0.8;
/** Where they sit: their hips on the seat at the top of the body. */
const DRIVER_SEAT = { x: -0.07, y: 0.2 - 0.09 * DRIVER_SCALE };

/**
 * A counterbalance forklift with its driver, a dockhand built from `seed`
 * sat at the wheel. Forks face +X.
 */
export function forklift(seed = 0): Model {
  const root = new Group();
  const body = new Group();
  // The body ends where the counterweight begins: were they to overlap, their
  // sides would lie in the same plane and flicker as it drives.
  body.add(box(0.28, 0.14, 0.3, C.forklift, 0, 0.06));
  body.add(box(0.12, 0.16, 0.3, C.chassis, -0.2, 0.06));
  for (const x of [-0.14, 0.1]) {
    for (const z of [-0.15, 0.15]) {
      const wheel = cyl(0.06, 0.05, C.tyre, x, 0, z, 8);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.y = 0.06;
      body.add(wheel);
    }
  }
  // The driver under the overhead guard, sat with their hands on the wheel.
  const driver = worker(seed, (size) => crate(size));
  sit(driver, 0);
  driver.limbs!.armL.rotation.z = driver.limbs!.armR.rotation.z = 1.05;
  const seat = new Group();
  seat.position.set(DRIVER_SEAT.x, DRIVER_SEAT.y, 0);
  seat.scale.setScalar(DRIVER_SCALE);
  seat.add(driver.root);
  body.add(seat);
  for (const x of [-0.16, 0.06]) {
    for (const z of [-0.13, 0.13]) body.add(box(0.02, 0.26, 0.02, C.chassis, x, 0.2, z));
  }
  body.add(box(0.26, 0.02, 0.3, C.chassis, -0.05, 0.46));
  // An amber beacon on the guard, and work lights on the mast lighting
  // the ground ahead of the forks at night.
  body.add(lamp(LIGHT.beacon, 0.03, -0.13, 0.48, 0));
  body.add(lamp(LIGHT.white, 0.025, 0.16, 0.44, 0));
  body.add(pool(0.3, 0.22, 0.42, 0.006, 0));
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
      const c = crate(CRATE, 0.3, 0.04 + layer * CRATE, z);
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
  body.add(lamp(LIGHT.beacon, 0.035, 0.02, 0.46, -0.1));
  body.add(pool(0.45, 0.3, 0.45, 0.006, 0));
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
  body.add(lamp(LIGHT.beacon, 0.035, 0.32, 0.37, -0.02));
  body.add(pool(0.3, 0.2, 0.68, 0.006, 0));
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
