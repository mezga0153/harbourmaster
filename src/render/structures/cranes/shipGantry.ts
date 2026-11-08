import { Group, Vector3, type Object3D } from 'three';
import {
  CRANE_LIFT_SET,
  CRANE_LIFT_TAKEN,
  GANTRY_RAILS,
  GANTRY_STACK,
  GANTRY_TICKS,
} from '../../../sim/balance';
import { TICKS_PER_SECOND } from '../../../sim/types';
import { BOX_HEIGHT } from '../../assets';
import { container, paintContainer } from '../../models';
import { C } from '../../palette';
import { lamp, LIGHT, pool } from '../../lights';
import { box, strut } from '../../parts';
import { QUAY_Y } from '../../terrain';
import type { TileBuild } from '../tiles';
import type { CraneParts, CraneSite, ShipGantryParts } from './parts';

// The ship-to-shore gantry: a portal on rails along the quay, its boom out
// over the ship, that unloads the feeders onto the stack between its legs
// (or straight onto a tractor) and loads them from it.

const slotAt = new Vector3();

export function makeShipGantry(t: TileBuild): Object3D {
  const { i, g, parts } = t;
  // Ship-to-shore gantry over 2×2 of quay: x 0..2 along the edge, the
  // water off the front (+z), z -1..1. A slender portal on four legs
  // runs on rails along the quay, its boom reaching out across the
  // whole ship and back over the bay between its back legs, where it
  // sets the containers down.
  const y = QUAY_Y;
  const top = y + 1.55;
  // The rails run along the quay the length of a ship, centred on it,
  // kept clear for it when it was built.
  const left = GANTRY_RAILS / 2 - 1;
  const right = GANTRY_RAILS / 2 - 1;
  for (const z of [-0.85, 0.85]) {
    g.add(box(2 + left + right, 0.02, 0.05, C.chassis, 1 + (right - left) / 2, y, z));
  }
  const carriage = new Group();
  carriage.position.x = 1;
  const half = 0.38;
  const leg = 0.06;
  for (const x of [-half, half]) {
    for (const z of [-0.85, 0.85]) {
      carriage.add(box(0.1, 0.07, 0.2, C.chassis, x, y, z));
      carriage.add(box(leg, top - y, leg, C.sign, x, y + 0.07, z));
    }
    // A tie along each side, high enough for the stacks to pass under.
    carriage.add(box(0.04, 0.05, 1.7, C.sign, x, top - 0.45, 0));
  }
  // The portal beams across, front and back.
  for (const z of [-0.85, 0.85]) {
    carriage.add(box(half * 2 + leg, 0.07, 0.07, C.sign, 0, top - 0.07, z));
  }
  // The boom: twin girders out across the ship's beam and back over
  // the landside, a lighter tip, and a walkway between.
  const reach = 2.75;
  const tail = -1.55;
  for (const x of [-0.13, 0.13]) {
    carriage.add(box(0.04, 0.07, reach - tail, C.craneYellow, x, top, (reach + tail) / 2));
  }
  carriage.add(box(0.3, 0.02, reach - tail, C.chassis, 0, top - 0.01, (reach + tail) / 2));
  // An apex frame over the back legs, stays out to the tip and back to
  // the tail, and the machinery house on the backreach.
  const apex = top + 0.62;
  for (const x of [-0.13, 0.13]) {
    carriage.add(strut([x, top, -1.05], [0, apex, -0.85], 0.035, C.sign));
    carriage.add(strut([x, top, -0.65], [0, apex, -0.85], 0.035, C.sign));
    carriage.add(strut([0, apex, -0.85], [x, top + 0.07, reach - 0.15], 0.014, C.chassis));
    carriage.add(strut([0, apex, -0.85], [x, top + 0.07, tail + 0.1], 0.014, C.chassis));
  }
  carriage.add(box(0.3, 0.16, 0.36, C.cabin, 0, top + 0.07, tail + 0.3));
  // Red lights on the apex and the boom's tip, and floodlights under the
  // portal and the boom lighting the quay and the ship at night.
  carriage.add(lamp(LIGHT.warning, 0.05, 0, apex + 0.03, -0.85));
  carriage.add(lamp(LIGHT.warning, 0.04, 0, top + 0.1, reach));
  carriage.add(pool(0.7, 1.05, 0, y + 0.004, 0));
  carriage.add(pool(0.6, 0.9, 0, 0.012, 1.7, 0.24));
  // The trolley with the driver's cab under it, the hoist and spreader.
  const trolley = new Group();
  trolley.position.set(0, top, -0.3);
  trolley.add(box(0.32, 0.05, 0.22, C.chassis, 0, 0.06, 0));
  trolley.add(box(0.14, 0.12, 0.14, C.window, 0.1, -0.14, 0.04));
  const rope = box(0.012, 1, 0.012, C.chassis);
  const hook = new Group();
  hook.add(box(0.62, 0.035, 0.15, C.stripe, 0, -0.035));
  const load = container(i, 0, -0.035 - BOX_HEIGHT, 0);
  load.visible = false;
  hook.add(load);
  trolley.add(rope, hook);
  carriage.add(trolley);
  g.add(carriage);
  // Its stack along the quay at the shipside, the length of its rails,
  // two deep and two high, clear of the front legs: landward of it the
  // rest of the quay under it is left for the stackers and tractors.
  // Painted out on the quay as a container yard is: the machines keep
  // off it and work it from behind.
  const [x0, x1, z0, z1] = [-left + 0.05, 2 + right - 0.05, 0.06, 0.74];
  for (const z of [z0, z1]) g.add(box(x1 - x0, 0.006, 0.04, C.stripe, (x0 + x1) / 2, y, z));
  for (const x of [x0, x1]) g.add(box(0.04, 0.006, z1 - z0, C.stripe, x, y, (z0 + z1) / 2));
  const stack: Object3D[] = [];
  const cols = GANTRY_RAILS;
  for (let layer = 0; layer < GANTRY_STACK / (cols * 2); layer++) {
    for (const z of [0.55, 0.25]) {
      for (let a = 0; a < cols; a++) {
        const x = a - (GANTRY_RAILS / 2 - 1) + 0.5;
        const c = container(i * 5 + stack.length, x, y + layer * BOX_HEIGHT, z);
        c.visible = false;
        g.add(c);
        stack.push(c);
      }
    }
  }
  parts.crane = {
    slew: trolley,
    rope,
    hook,
    rest: 0.25,
    reach: 1.0,
    stack,
    angle: 0,
    target: 0,
    busy: false,
    fixed: true,
    sts: {
      idx: i,
      frame: g,
      carriage,
      from: 1 - left - 0.6,
      to: 1 + right + 0.6,
      load,
      work: null,
      boat: -1,
      truck: -1,
      slot: 0,
      look: 0,
      phase: 0,
      stacked: 0,
      base: 0,
    },
  };
  return g;
}

/**
 * A ship-to-shore gantry at work runs along its rails to the bay of the
 * ship it is working, runs its trolley out over the row, lowers the
 * spreader onto the container and lifts it, then runs back over the bay
 * between its legs and sets it down on the stack there; loading, the other
 * way round. Idle, it waits where it is with the spreader up.
 */
export function runShipGantry(
  site: CraneSite,
  c: CraneParts,
  g: ShipGantryParts,
  dt: number,
): void {
  const cycle = GANTRY_TICKS / TICKS_PER_SECOND;
  const was = g.phase;
  g.phase = g.work ? (g.phase + (dt * site.speed()) / cycle) % 1 : 0;
  if (g.phase < was || !g.work) g.base = site.kept(-1 - g.idx, g.look);
  const trolley = c.slew;
  let x = g.carriage.position.x;
  let z = -0.3;
  let drop = c.rest;
  let carry = false;
  // Its other end: a slot on the ship's deck, or on a tractor under it.
  const tractor = g.work === 'give' || g.work === 'take';
  // Off the ship straight onto a tractor under it, or off one straight
  // on board, rather than by way of its stack.
  const direct = (g.work === 'unload' || g.work === 'load') && g.truck >= 0;
  const ship = !g.work
    ? null
    : tractor
      ? site.truckSlot(g.truck, 0, slotAt)
      : site.truckSlot(g.boat, g.slot, slotAt);
  const onto = direct ? site.truckSlot(g.truck, 0, new Vector3()) : null;
  if (g.work && ship) {
    g.frame.updateWorldMatrix(true, false);
    g.frame.worldToLocal(ship);
    const deck = {
      x: ship.x,
      z: ship.z,
      drop: trolley.position.y - (ship.y + BOX_HEIGHT + 0.04),
    };
    // The next free place on the stack, the export on top of it, or the
    // container it gives a tractor.
    const order = site.order(-1 - g.idx);
    const k =
      g.place !== undefined && g.place >= 0
        ? g.place
        : g.work === 'give'
          ? Math.max(0, order.indexOf(g.look))
          : Math.max(0, Math.min(c.stack.length - 1, g.stacked - (g.work === 'load' ? 1 : 0)));
    const slot = c.stack[Math.min(c.stack.length - 1, k)];
    if (onto) g.frame.worldToLocal(onto);
    const pile = onto
      ? { x: onto.x, z: onto.z, drop: trolley.position.y - (onto.y + BOX_HEIGHT + 0.04) }
      : {
          x: slot.position.x,
          z: slot.position.z,
          drop: trolley.position.y - (slot.position.y + BOX_HEIGHT + 0.04),
        };
    let [from, to] = g.work === 'unload' || g.work === 'take' ? [deck, pile] : [pile, deck];
    // Taken off a tractor, it goes on from where it took it, whether the
    // tractor stays or drives off.
    const offTractor = g.work === 'take' || (g.work === 'load' && direct);
    if (offTractor && g.phase > CRANE_LIFT_TAKEN && g.offAt) from = g.offAt;
    else if (offTractor) g.offAt = { ...from };
    else g.offAt = undefined;
    const ease = (t: number) => t * t * (3 - 2 * t);
    const dip = (t: number, depth: number) => c.rest + (depth - c.rest) * Math.sin(t * Math.PI);
    const take = CRANE_LIFT_TAKEN;
    const set = CRANE_LIFT_SET;
    // Over to the container, down and up with it at `take`, across to
    // where it goes, down and up again having let go at `set`.
    const a = take - 0.15;
    const b = take + 0.15;
    const d = set - 0.15;
    // Handed over, it is on the spreader from when it leaves the ship's
    // deck or the stack until it shows where it is set down, never on
    // neither.
    const onDeck = () =>
      tractor ? !!site.slotShown(g.truck, 0) : !!site.slotShown(g.boat, g.slot);
    // Where it is set down: the tractor, for one straight off the ship.
    const onStack = () =>
      direct ? (site.slotShown(g.truck, 0) ? g.base + 1 : g.base) : site.kept(-1 - g.idx, g.look);
    const onTruck = () => !!site.slotShown(g.truck, 0);
    const [gone, there] = direct
      ? g.work === 'unload'
        ? [() => !onDeck(), onTruck]
        : [() => !onTruck(), onDeck]
      : g.work === 'unload' || g.work === 'take'
        ? [() => !onDeck(), () => onStack() > g.base]
        : [() => onStack() < g.base, onDeck];
    // Nor does it lift one while it still shows where it was, or come up
    // again before it shows where it is set down: ahead of the game, the
    // spreader waits down on it.
    g.holding = false;
    if (was <= take && g.phase > take && !gone()) [g.phase, g.holding] = [take, true];
    if (was <= set && g.phase > set && !there()) [g.phase, g.holding] = [set, true];
    const p = g.phase;
    if (p < a) {
      const t = ease(p / a);
      x = g.carriage.position.x + (from.x - g.carriage.position.x) * t;
      z = trolley.position.z + (from.z - trolley.position.z) * t;
    } else if (p < b) {
      x = from.x;
      z = from.z;
      drop = dip((p - a) / (b - a), from.drop);
      // Only once it has left where it was: never on both at once.
      carry = gone();
    } else if (p < d) {
      const t = ease((p - b) / (d - b));
      x = from.x + (to.x - from.x) * t;
      z = from.z + (to.z - from.z) * t;
      carry = true;
    } else {
      x = to.x;
      z = to.z;
      drop = dip((p - d) / (1 - d), to.drop);
      carry = p < set || !there();
    }
  }
  x = Math.max(g.from, Math.min(g.to, x));
  const follow = site.follow(dt);
  g.carriage.position.x += (x - g.carriage.position.x) * follow;
  // The trolley's along the boom from the carriage.
  trolley.position.z += (z - trolley.position.z) * follow;
  trolley.position.x = 0;
  c.rope.scale.y = drop;
  c.rope.position.y = -drop / 2;
  c.hook.position.y = -drop;
  g.load.visible = carry;
  if (carry) paintContainer(g.load, g.look);
}
