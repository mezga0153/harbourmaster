import { CircleGeometry, Mesh } from 'three';
import { box } from './parts';
import { glowAtNight, nightLight } from './util/mesh';

// The lights the port's ships, cranes and vehicles carry, lit at night
// (see daylight.ts): ships' navigation lights, red warning lights on the
// cranes, amber beacons on the machines, and the pools of light that
// floodlights and headlamps throw on the ground. Each colour here is used
// for nothing else, as everything drawn in it glows.

export const LIGHT = {
  /** A ship's sidelights: red to port (its left, -z), green to starboard. */
  port: 0xe8322a,
  starboard: 0x2ccf5c,
  /** Masthead and stern lights, and floodlights. */
  white: 0xfffaf0,
  /** On top of a crane, blinking slowly. */
  warning: 0xff2d20,
  /** On top of a port machine, flashing as it goes. */
  beacon: 0xffa51f,
  /** Vehicles' rear lamps. */
  tail: 0xd8261e,
} as const;

glowAtNight(LIGHT.port, 0xff3a2a, 2);
glowAtNight(LIGHT.starboard, 0x3aff6a, 2);
glowAtNight(LIGHT.white, 0xfff2d0, 1.8);
glowAtNight(LIGHT.warning, 0xff2a1a, 2.2, 0.5);
glowAtNight(LIGHT.beacon, 0xffa51f, 2.2, 1.6);
glowAtNight(LIGHT.tail, 0xff2a1a, 1.6);

/** The warm light floodlights and headlamps throw. */
const THROWN = 0xffd690;
const disc = new CircleGeometry(1, 24).rotateX(-Math.PI / 2);

/** A small lamp of `color`, `size` across, centred at x, y, z. */
export function lamp(color: number, size: number, x: number, y: number, z: number): Mesh {
  const m = box(size, size, size, color, x, y - size / 2, z);
  m.castShadow = false;
  return m;
}

/**
 * A pool of light on the ground at x, y, z, `rx` by `rz` across its middle,
 * as a floodlight or headlamps throw it: seen only at night.
 */
export function pool(
  rx: number,
  rz: number,
  x: number,
  y: number,
  z: number,
  strength = 0.25,
): Mesh {
  const m = new Mesh(disc, nightLight(THROWN, strength));
  m.scale.set(rx, 1, rz);
  m.position.set(x, y, z);
  m.renderOrder = 1;
  // Not part of what throws it: see solidBounds.
  m.userData.thrown = true;
  return m;
}
