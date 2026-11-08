import { ConeGeometry, Group, Mesh, type Object3D } from 'three';
import type { GameMap } from '../../sim/map';
import { crossingClosed, moving, type Train } from '../../sim/railway';
import { GATE_IN, GATE_OUT, greenAt } from '../../sim/roads';
import { TOWN } from '../../sim/town';
import { Build } from '../../sim/types';
import { C } from '../palette';
import { box, cyl, mat } from '../parts';
import { pavements } from '../town';
import { LAMP_GREEN, LAMP_RED, LIGHT, STEEL } from './paints';
import { QUAY_Y } from '../terrain';
import { gateFence } from './fences';
import { paving, roadArrow, type TileBuild, type TileParts } from './tiles';

// The port's furniture that moves on its own: gates lifting their barrier
// for a truck, traffic lights changing, level crossings closing for the
// train and buoys bobbing on the swell. Each is built with its tile and
// animated every frame by animateFurniture.

/** The pointed top of a green buoy. */
const coneGeo = new ConeGeometry(0.08, 0.14, 8);
coneGeo.translate(0, 0.07, 0);

export interface GateParts {
  /** The barrier arm, pivoting up about its post. */
  boom: Object3D;
  open: boolean;
  angle: number;
}

/** A junction's traffic lights: the red and green lamps facing each way. */
export interface LightParts {
  ns: { red: Object3D; green: Object3D }[];
  ew: { red: Object3D; green: Object3D }[];
}

/** A siding's signal at its switch; see `signal` in tiles.ts. */
export interface SignalParts {
  red: Object3D;
  green: Object3D;
  /** The main line's tile its switch is on. */
  switch: number;
}

export interface CrossingParts {
  /** Barrier arms, each lifting about its post; `sign` is which way is up. */
  arms: { arm: Object3D; sign: number }[];
  /** Red lamps, flashing in turn while the barriers are down. */
  lamps: Object3D[];
  x: number;
  y: number;
  angle: number;
}

/** The furniture on the tiles, by tile, for animateFurniture. */
export interface Furniture {
  lights: Map<number, LightParts>;
  crossings: Map<number, CrossingParts>;
  signals: Map<number, SignalParts>;
  buoys: Map<number, Object3D>;
  gates: Map<number, GateParts>;
}

/** Per-frame animation: lights change, barriers lift and fall, buoys bob. */
export function animateFurniture(
  f: Furniture,
  dt: number,
  time: number,
  tick: number,
  trains: readonly Train[],
): void {
  for (const [i, l] of f.lights) {
    const green = greenAt(i, tick);
    for (const way of ['ns', 'ew'] as const) {
      for (const lamp of l[way]) {
        lamp.green.visible = green === way;
        lamp.red.visible = green !== way;
      }
    }
  }
  // Green while the siding's own train has the road, in or out; red else.
  for (const s of f.signals.values()) {
    const clear = trains.some((t) => moving(t) && t.port?.switch === s.switch);
    s.green.visible = clear;
    s.red.visible = !clear;
  }
  for (const c of f.crossings.values()) {
    const closed = crossingClosed(trains, c.x, c.y);
    c.angle += ((closed ? 0 : 1.45) - c.angle) * Math.min(1, dt * 3);
    for (const { arm, sign } of c.arms) arm.rotation.x = sign * c.angle;
    const blink = Math.floor(time * 3) % 2;
    c.lamps.forEach((l, k) => (l.visible = closed && k % 2 === blink));
  }
  for (const [i, buoy] of f.buoys) {
    buoy.position.y = Math.sin(time * 1.7 + i * 0.37) * 0.025;
    buoy.rotation.z = Math.sin(time * 1.3 + i) * 0.08;
    buoy.rotation.x = Math.cos(time * 1.1 + i * 0.7) * 0.08;
  }
  for (const g of f.gates.values()) {
    g.angle += ((g.open ? 1.4 : 0) - g.angle) * Math.min(1, dt * 5);
    g.boom.rotation.z = -g.angle;
  }
}

export function gate(t: TileBuild): Object3D {
  const { m, i, g, parts } = t;
  // Port paving with a gatehouse to one side and a striped barrier
  // across the lane, the public road in front (+z).
  paving(t);
  const y = QUAY_Y;
  gateFence(g, y, parts.owned);
  g.add(box(0.6, 0.006, 0.04, C.marking, 0.42, y, 0.8));
  g.add(box(0.2, 0.26, 0.3, C.cabin, 0.88, y, 0.42));
  g.add(box(0.205, 0.08, 0.305, C.window, 0.88, y + 0.13, 0.42));
  g.add(box(0.26, 0.03, 0.36, C.sign, 0.88, y + 0.26, 0.42));
  g.add(box(0.06, 0.12, 0.06, C.chassis, 0.74, y, 0.68));
  g.add(box(0.035, 0.08, 0.035, C.chassis, 0.08, y, 0.68));
  const boom = new Group();
  boom.position.set(0.74, y + 0.11, 0.68);
  for (let k = 0; k < 6; k++) {
    boom.add(box(0.11, 0.03, 0.03, k % 2 ? C.marking : C.funnel, -0.06 - k * 0.11, -0.015, 0));
  }
  g.add(boom);
  parts.gate = { boom, open: false, angle: 0 };
  // A one-way gate: an arrow in through it from the road (-z), or out to it.
  const o = m.orient[i];
  if (o & (GATE_IN | GATE_OUT)) roadArrow(g, y, o & GATE_IN ? 3 : 1);
  return g;
}

export function buoy(t: TileBuild): Object3D {
  const { g, parts, code } = t;
  // A lateral mark: green with a cone on top for the way in, red with
  // a flat can top for the way out, a white band and a light.
  const green = code === Build.BuoyIn;
  const paint = green ? C.buoyGreen : C.buoyRed;
  const buoy = new Group();
  buoy.position.set(0.5, 0, 0.5);
  buoy.scale.setScalar(1.3);
  buoy.add(cyl(0.13, 0.12, paint, 0, -0.06, 0, 10));
  buoy.add(cyl(0.07, 0.2, paint, 0, 0.06, 0, 8));
  buoy.add(cyl(0.072, 0.04, C.cabin, 0, 0.14, 0, 8));
  if (green) {
    const cone = new Mesh(coneGeo, mat(paint));
    cone.position.y = 0.26;
    cone.castShadow = true;
    buoy.add(cone);
  } else buoy.add(cyl(0.085, 0.1, paint, 0, 0.26, 0, 8));
  buoy.add(cyl(0.025, 0.05, LIGHT, 0, green ? 0.4 : 0.36, 0, 6));
  g.add(buoy);
  parts.buoy = buoy;
  return g;
}

/**
 * A road over the line on the level: the road runs along x and the rails
 * along z, with a barrier and flashing lamps on each side of the line.
 */
export function crossing(m: GameMap, g: Group, i: number, top: number, parts: TileParts): void {
  g.add(box(1, 0.05, 1, C.asphalt, 0.5, top, 0.5));
  g.add(box(0.44, 0.012, 1, C.quayWall, 0.5, top + 0.05, 0.5));
  for (const x of [0.35, 0.65]) g.add(box(0.03, 0.02, 1, STEEL, x, top + 0.05, 0.5));
  const town = (m.orient[i] & TOWN) !== 0;
  if (town) pavements(g, top, [true, true, false, false], false);
  const arms: CrossingParts['arms'] = [];
  const lamps: Object3D[] = [];
  // One barrier each side of the line, across the lane coming towards it.
  for (const [px, pz, sign] of [
    [0.1, 0.9, 1],
    [0.9, 0.1, -1],
  ] as const) {
    g.add(box(0.05, 0.3, 0.05, C.cabin, px, top + 0.05, pz));
    const cross = [0.785, -0.785].map((a) => {
      const b = box(0.012, 0.012, 0.14, C.funnel, px, top + 0.3, pz);
      b.rotation.x = a;
      return b;
    });
    g.add(...cross);
    for (const dz of [-0.045, 0.045]) {
      const lamp = box(
        0.035,
        0.035,
        0.035,
        LAMP_RED,
        px + (px < 0.5 ? -0.03 : 0.03),
        top + 0.22,
        pz + dz,
      );
      lamp.visible = false;
      g.add(lamp);
      lamps.push(lamp);
    }
    const arm = new Group();
    arm.position.set(px + (px < 0.5 ? 0.04 : -0.04), top + 0.14, pz);
    // Red and white along its length, pointing across the road.
    for (let k = 0; k < 6; k++) {
      arm.add(
        box(0.02, 0.025, 0.12, k % 2 ? C.marking : C.funnel, 0, -0.0125, -sign * (0.06 + k * 0.12)),
      );
    }
    g.add(arm);
    arms.push({ arm, sign });
  }
  parts.crossing = { arms, lamps, x: m.xOf(i), y: m.yOf(i), angle: 1.45 };
}

/**
 * Traffic lights on a junction: a post at each corner, by the lane
 * coming in on its right, its lamps red or green as the game has them.
 */
export function trafficLights(g: Group, top: number, parts: TileParts): void {
  const lights: LightParts = { ns: [], ew: [] };
  // Corner, and which traffic it faces: in on the right-hand side of the road.
  for (const [px, pz, way] of [
    [0.08, 0.92, 'ew'],
    [0.92, 0.08, 'ew'],
    [0.92, 0.92, 'ns'],
    [0.08, 0.08, 'ns'],
  ] as const) {
    g.add(cyl(0.018, 0.34, C.chassis, px, top, pz));
    g.add(box(0.06, 0.13, 0.06, C.funnel, px, top + 0.3, pz));
    const red = box(0.065, 0.04, 0.065, LAMP_RED, px, top + 0.38, pz);
    const green = box(0.065, 0.04, 0.065, LAMP_GREEN, px, top + 0.31, pz);
    green.visible = false;
    g.add(red, green);
    lights[way].push({ red, green });
  }
  parts.lights = lights;
}
