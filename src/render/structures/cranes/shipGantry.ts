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
import { bake } from '../../town';
import { QUAY_Y } from '../../terrain';
import type { TileBuild } from '../tiles';
import type { CraneParts, CraneSite, ShipGantryParts } from './parts';

// The ship-to-shore gantry: a portal on rails along the quay, its boom out
// over the ship, that unloads the feeders onto the stack between its legs
// (or straight onto a tractor) and loads them from it. Drawn as the real
// ones are: blue legs braced on each side, red and white girders, an A-frame
// over the waterside legs holding the boom up on its stays, the machinery
// house on the backreach. With no ship alongside it its boom is raised, out
// of the way of the ships coming and going, and lowered over the next.

const slotAt = new Vector3();
const along = new Vector3(0, 0, 1);
const tieAt = new Vector3();
const tieDir = new Vector3();

const LEGS = 0x3f78c6;
const RED = 0xc9353d;
const WHITE = 0xefefea;
const WHEELS = 0x2b2e33;
/** How far the boom goes up out of the way, and how long it takes, in game seconds. */
const RAISED = (80 * Math.PI) / 180;
const LUFF_SECONDS = 2;

/** A straight run of girder along z, from z0 to z1: a truss, red chords and white lacing. */
function girder(g: Group, x: number, y: number, z0: number, z1: number): void {
  const len = z1 - z0;
  const mid = (z0 + z1) / 2;
  g.add(box(0.045, 0.03, len, RED, x, y, mid));
  g.add(box(0.045, 0.025, len, RED, x, y + 0.095, mid));
  const n = Math.max(2, Math.round(len / 0.2));
  const step = len / n;
  for (let k = 0; k <= n; k++) {
    g.add(box(0.03, 0.07, 0.022, WHITE, x, y + 0.028, z0 + k * step));
    if (k < n) {
      const [a, b] = k % 2 ? [y + 0.03, y + 0.098] : [y + 0.098, y + 0.03];
      g.add(strut([x, a, z0 + k * step], [x, b, z0 + (k + 1) * step], 0.014, WHITE));
    }
  }
  // A walkway along its outer side.
  const out = x + Math.sign(x) * 0.05;
  g.add(box(0.05, 0.008, len, C.chassis, out, y + 0.01, mid));
  g.add(box(0.005, 0.005, len, WHITE, out + Math.sign(x) * 0.024, y + 0.06, mid));
}

/** A lattice tower, from y0 up to y1, `w` square, for the lift up a leg. */
function tower(g: Group, x: number, z: number, w: number, y0: number, y1: number): void {
  for (const dx of [-w / 2, w / 2]) {
    for (const dz of [-w / 2, w / 2]) g.add(box(0.012, y1 - y0, 0.012, WHITE, x + dx, y0, z + dz));
  }
  for (let h = y0 + 0.12; h < y1; h += 0.14) g.add(box(w, 0.01, w, WHITE, x, h, z));
}

export function makeShipGantry(t: TileBuild): Object3D {
  const { i, g, parts } = t;
  // Ship-to-shore gantry over 2×2 of quay: x 0..2 along the edge, the
  // water off the front (+z), z -1..1. A portal on four legs runs on rails
  // along the quay, its girders reaching out across the whole ship (the
  // boom, hinged at the waterside legs) and back over the bay between its
  // back legs, where it sets the containers down.
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
  const frame = new Group();
  const half = 0.38;
  const leg = 0.075;
  const sill = top - 0.42;
  for (const x of [-half, half]) {
    for (const z of [-0.85, 0.85]) {
      // A bogie of wheels under each leg, a knee and the leg up to the girders.
      frame.add(box(0.3, 0.04, 0.09, LEGS, x, y + 0.035, z));
      for (const dx of [-0.09, 0.09]) frame.add(box(0.08, 0.04, 0.1, WHEELS, x + dx, y, z));
      frame.add(box(0.11, 0.1, 0.11, LEGS, x, y + 0.075, z));
      frame.add(box(leg, top + 0.12 - (y + 0.075), leg, LEGS, x, y + 0.075, z));
      // Brackets in from the leg that the girders rest on, leaving the
      // middle open for the hoist ropes to pass.
      frame.add(box(0.27, 0.07, 0.08, LEGS, Math.sign(x) * 0.245, top - 0.07, z));
    }
    // Each side braced: a sill high enough for the stacks and tractors to
    // pass under, a beam along the top and a diagonal between.
    frame.add(box(0.06, 0.07, 1.7, LEGS, x, sill, 0));
    frame.add(box(0.065, 0.09, 1.7, LEGS, x, top - 0.02, 0));
    frame.add(strut([x, sill + 0.07, -0.8], [x, top - 0.02, 0.8], 0.045, LEGS));
  }
  // The lift tower beside a landside leg.
  tower(frame, half, -0.85 - 0.09, 0.075, y, top + 0.07);
  // The A-frame over the waterside legs: a post up from each and a strut
  // back to the landside ones, tied across above the trolley's way.
  const apex = top + 0.95;
  const az = 0.62;
  const at = (x: number): [number, number, number] => [x * 0.8, apex, az];
  for (const x of [-half, half]) {
    frame.add(strut([x, top + 0.1, 0.85], at(x), 0.055, RED));
    frame.add(strut([x, top + 0.1, -0.85], [x * 0.8, apex - 0.03, az - 0.05], 0.045, WHITE));
    // A tie between them part way up.
    const h = 0.4;
    const back = -0.85 + (az - 0.05 + 0.85) * ((h - 0.1) / (apex - 0.03 - top - 0.1));
    const front = 0.85 + (az - 0.85) * ((h - 0.1) / (apex - top - 0.1));
    frame.add(strut([x, top + h, back], [x * 0.95, top + h, front], 0.03, RED));
    // Backstays from the apex to the end of the backreach.
    frame.add(strut(at(x), [Math.sign(x) * 0.13, top + 0.12, -1.42], 0.022, RED));
  }
  frame.add(box(half * 1.6 + 0.08, 0.07, 0.09, RED, 0, apex - 0.05, az));
  frame.add(box(half * 1.6 + 0.04, 0.03, 0.18, WHITE, 0, apex + 0.02, az));
  frame.add(box(half * 1.85, 0.04, 0.05, WHITE, 0, top + 0.4, 0.8));
  // The girders over the landside, from the backreach to the boom's hinge,
  // tied at the tail, and the machinery house on the backreach.
  const tail = -1.55;
  const hinge = 0.88;
  for (const x of [-0.13, 0.13]) girder(frame, x, top, tail, hinge);
  frame.add(box(0.32, 0.12, 0.05, RED, 0, top, tail));
  frame.add(box(0.44, 0.22, 0.44, WHITE, 0, top + 0.12, tail + 0.29));
  frame.add(box(0.46, 0.025, 0.46, RED, 0, top + 0.34, tail + 0.29));
  frame.add(box(0.12, 0.08, 0.1, C.chassis, 0.1, top + 0.365, tail + 0.2));
  frame.add(box(0.06, 0.1, 0.005, C.window, -0.12, top + 0.16, tail + 0.512));
  carriage.add(bake(frame, parts.owned));
  // The boom, hinged at the waterside legs and luffed up about it.
  const boom = new Group();
  boom.position.set(0, top, hinge);
  const arm = new Group();
  const length = 2.85 - hinge;
  for (const x of [-0.13, 0.13]) {
    girder(arm, x, 0, 0, length);
    // Lugs at the hinge.
    arm.add(box(0.06, 0.13, 0.08, LEGS, x, -0.02, 0.02));
  }
  // The end frame and the platform at the tip.
  arm.add(box(0.32, 0.12, 0.05, RED, 0, 0, length));
  arm.add(box(0.36, 0.01, 0.12, C.chassis, 0, 0.12, length - 0.04));
  arm.add(box(0.36, 0.035, 0.005, WHITE, 0, 0.13, length + 0.02));
  boom.add(bake(arm, parts.owned));
  boom.add(lamp(LIGHT.warning, 0.04, 0, 0.17, length));
  boom.rotation.x = -RAISED;
  carriage.add(boom);
  // The stays from the apex to the boom, a bar each side to half way and
  // the luffing ropes to near the tip, drawn afresh as the boom goes up.
  const ties: ShipGantryParts['ties'] = [];
  for (const x of [-0.13, 0.13]) {
    const from = new Vector3(...at(Math.sign(x) * half));
    ties.push({ bar: box(0.026, 0.026, 1, RED), from, on: new Vector3(x, 0.12, 0.95) });
    ties.push({ bar: box(0.01, 0.01, 1, C.chassis), from, on: new Vector3(x, 0.12, 1.75) });
  }
  for (const tie of ties) carriage.add(tie.bar);
  // Red lights on the apex and the boom's tip, and floodlights under the
  // portal and the boom lighting the quay and the ship at night.
  carriage.add(lamp(LIGHT.warning, 0.05, 0, apex + 0.09, az));
  carriage.add(pool(0.7, 1.05, 0, y + 0.004, 0));
  const shipLight = pool(0.6, 0.9, 0, 0.012, 1.7, 0.24);
  shipLight.visible = false;
  carriage.add(shipLight);
  // The trolley on the girders' top chords, its sheaves down between them,
  // with the driver's cab hung under it to one side; the hoist and spreader.
  const trolley = new Group();
  trolley.position.set(0, top, -0.3);
  trolley.add(box(0.34, 0.05, 0.22, C.chassis, 0, 0.12, 0));
  trolley.add(box(0.36, 0.015, 0.24, WHITE, 0, 0.17, 0));
  trolley.add(box(0.1, 0.12, 0.08, C.chassis, 0, 0, 0));
  trolley.add(box(0.03, 0.12, 0.03, C.chassis, 0.16, -0.06, 0.06));
  trolley.add(box(0.15, 0.13, 0.15, WHITE, 0.17, -0.19, 0.08));
  trolley.add(box(0.155, 0.055, 0.155, C.window, 0.17, -0.15, 0.08));
  const rope = box(0.012, 1, 0.012, C.chassis);
  const hook = new Group();
  hook.add(box(0.62, 0.035, 0.15, C.stripe, 0, -0.035));
  hook.add(box(0.1, 0.03, 0.08, C.chassis, 0, 0));
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
      boom,
      ties,
      shipLight,
      hinge,
      raised: 1,
      alongside: false,
    },
  };
  placeTies(parts.crane.sts!);
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
  // The boom comes down for a ship alongside, or one it is lifting to or
  // from, and goes back up once the trolley is in off it.
  const down = g.alongside || g.work === 'load' || g.work === 'unload';
  const luff = (dt * site.speed()) / LUFF_SECONDS;
  if (down) g.raised = Math.max(0, g.raised - luff);
  else if (trolley.position.z < g.hinge - 0.15) g.raised = Math.min(1, g.raised + luff);
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
  // The trolley's along the boom from the carriage; never out past the
  // hinge onto it until it is right down.
  if (g.raised > 0) z = Math.min(z, g.hinge - 0.2);
  trolley.position.z += (z - trolley.position.z) * follow;
  trolley.position.x = 0;
  c.rope.scale.y = drop;
  c.rope.position.y = -drop / 2;
  c.hook.position.y = -drop;
  g.load.visible = carry;
  if (carry) paintContainer(g.load, g.look);
  placeTies(g);
}

/** The boom luffed as far up as it is, its stays drawn from the apex to it, and the ship's floodlight on only with it down. */
export function placeTies(g: ShipGantryParts): void {
  const r = g.raised;
  g.boom.rotation.x = -RAISED * r * r * (3 - 2 * r);
  g.boom.updateMatrix();
  for (const tie of g.ties) {
    tieAt.copy(tie.on).applyMatrix4(g.boom.matrix);
    tieDir.subVectors(tieAt, tie.from);
    const len = tieDir.length();
    tie.bar.position.copy(tie.from).add(tieAt).multiplyScalar(0.5);
    tie.bar.quaternion.setFromUnitVectors(along, tieDir.divideScalar(len));
    tie.bar.scale.z = len;
  }
  g.shipLight.visible = r === 0;
}
