import { Group, Vector3, type Object3D } from 'three';
import type { RailGantryView } from '../../../protocol/views';
import { SIDING_REACH } from '../../../sim/balance';
import { loadingTrack, sidingAt } from '../../../sim/rules';
import { TICKS_PER_SECOND } from '../../../sim/types';
import { BOX_HEIGHT } from '../../assets';
import { container, paintContainer } from '../../models';
import { C } from '../../palette';
import { lamp, LIGHT, pool } from '../../lights';
import { box } from '../../parts';
import { QUAY_Y } from '../../terrain';
import { clamp01 } from '../../util/math';
import type { TileBuild } from '../tiles';
import type { CraneSite } from './parts';

// A rail-mounted gantry over loading track: legs on rails either side,
// out past the rows of container yards beside the track, a pair of
// girders across with the trolley and its cab running along them, and
// the whole of it running along its rails the length of the loading track.
// It lifts containers between the wagons of the train under it and the
// stacks either side, as the game has it (systems/railGantry.ts).

const LEGS = 0x3f78c6;
const GIRDER = 0xefefea;
const RED = 0xc9353d;
/** Height of the girders over the quay. */
const H = 1.35;
/** Where the legs stand either side of the track, from its middle. */
const SPAN = SIDING_REACH + 0.5;
/** The spreader hangs this far under the girders, raised, between lifts. */
const RAISED = 0.25;

export interface RailGantryParts {
  /** At the middle of the gantry's tile: +x along the track as the map runs, +z across it. */
  frame: Object3D;
  /** Legs, girders and trolley, running along x. */
  carriage: Object3D;
  /** Along the girders, across the track (z). */
  trolley: Object3D;
  rope: Object3D;
  spreader: Object3D;
  load: Object3D;
  /** The middle of its tile on the map, to put the game's positions in the frame's terms. */
  cx: number;
  cy: number;
  /** Its rails' ends along x, in the frame. */
  from: number;
  to: number;
  /** Where it stands, as the game last said, between lifts. */
  idle: { x: number; z: number };
  /** The lift it is at, as the game said, and how far into it it is, in ticks. */
  lift: RailGantryView['lift'] | null;
  ticks: number;
  /** Where its carriage and trolley were as the lift began. */
  start: { x: number; z: number };
}

export function makeRailGantry(t: TileBuild): Object3D {
  const { m, i, g, parts } = t;
  const y = QUAY_Y;
  // Its rails the length of the loading track it stands on.
  const s = sidingAt(m, i);
  const xs = s ? loadingTrack(m, s).map((q) => m.xOf(q)) : [m.xOf(i)];
  const from = Math.min(...xs) - m.xOf(i) - 0.5;
  const to = Math.max(...xs) + 1 - m.xOf(i) - 0.5;
  const frame = new Group();
  for (const z of [-SPAN, SPAN]) {
    frame.add(box(to - from, 0.02, 0.07, C.chassis, (from + to) / 2, y, z));
  }
  const carriage = new Group();
  for (const z of [-SPAN, SPAN]) {
    // A leg frame each side: two legs on bogies, a sill across their tops,
    // and a brace between them.
    for (const x of [-0.42, 0.42]) {
      carriage.add(box(0.1, H, 0.1, LEGS, x, y, z));
      carriage.add(box(0.22, 0.09, 0.16, C.chassis, x, y, z));
    }
    carriage.add(box(0.96, 0.12, 0.12, LEGS, 0, y + H - 0.12, z));
    const brace = box(0.05, 1.2, 0.05, LEGS, 0, y + 0.12, z);
    brace.rotation.z = Math.atan2(0.84, H - 0.2);
    carriage.add(brace);
  }
  // The girders across, white with a red stripe, and a walkway.
  for (const x of [-0.3, 0.3]) {
    carriage.add(box(0.1, 0.16, SPAN * 2 + 0.3, GIRDER, x, y + H, 0));
    carriage.add(box(0.101, 0.035, SPAN * 2 + 0.3, RED, x, y + H + 0.06, 0));
  }
  // A grating between them, down inside, so the trolley's way shows.
  carriage.add(box(0.48, 0.012, SPAN * 2 + 0.1, 0x8d939a, 0, y + H + 0.03, 0));
  // The machinery house over one leg frame.
  carriage.add(box(0.62, 0.2, 0.36, GIRDER, 0, y + H + 0.17, SPAN - 0.1));
  carriage.add(box(0.63, 0.05, 0.37, LEGS, 0, y + H + 0.37, SPAN - 0.1));
  for (const z of [-SPAN, SPAN]) carriage.add(lamp(LIGHT.warning, 0.035, 0.45, y + H + 0.2, z));
  carriage.add(pool(0.7, SPAN * 2, 0, y + 0.004, 0, 0.22));
  // The trolley with its cab, the hoist ropes and the spreader on them,
  // and the container it is lifting, if any.
  const trolley = new Group();
  trolley.position.set(0, y + H, 0);
  trolley.add(box(0.72, 0.12, 0.36, GIRDER, 0, 0.16, 0));
  trolley.add(box(0.73, 0.03, 0.37, LEGS, 0, 0.28, 0));
  trolley.add(box(0.22, 0.2, 0.22, C.window, 0.36, -0.18, 0.06));
  const rope = box(0.012, 1, 0.012, C.chassis);
  const spreader = new Group();
  spreader.add(box(0.55, 0.04, 0.17, C.stripe, 0, -0.04, 0));
  const load = container(i, 0, -0.04 - BOX_HEIGHT, 0);
  load.visible = false;
  spreader.add(load);
  trolley.add(rope, spreader);
  carriage.add(trolley);
  frame.add(carriage);
  frame.position.set(0.5, 0, 0.5);
  g.add(frame);
  parts.railGantry = {
    frame,
    carriage,
    trolley,
    rope,
    spreader,
    load,
    cx: m.xOf(i) + 0.5,
    cy: m.yOf(i) + 0.5,
    from,
    to,
    idle: { x: 0, z: 0 },
    lift: null,
    ticks: 0,
    start: { x: 0, z: 0 },
  };
  return g;
}

/** The game's word on a rail gantry: where it stands, and the lift it is at, `tick` the game's tick now. */
export function setRailGantry(p: RailGantryParts, v: RailGantryView, tick: number): void {
  p.idle = { x: v.x - p.cx, z: v.y - p.cy };
  const l = v.lift;
  if (!l) {
    p.lift = null;
    return;
  }
  if (p.lift?.start !== l.start) {
    // A new lift: from wherever it stands now.
    p.start = { x: p.carriage.position.x, z: p.trolley.position.z };
    p.ticks = tick - l.start;
  } else if (Math.abs(p.ticks - (tick - l.start)) > 3) {
    p.ticks += (tick - l.start - p.ticks) * 0.5;
  }
  p.lift = l;
}

const at = new Vector3();

export function runRailGantry(
  site: CraneSite,
  p: RailGantryParts,
  dt: number,
  yardSlot: (yard: number, slot: number, out: Vector3) => Vector3 | null,
): void {
  let x = p.idle.x;
  let z = p.idle.z;
  let drop = RAISED;
  let carry = false;
  const l = p.lift;
  if (l) {
    p.ticks += dt * TICKS_PER_SECOND * site.speed();
    const [run, up, along, down] = l.legs;
    const total = run + up + along + down;
    const k = Math.min(p.ticks, total);
    // Over the wagon's slot or the yard's, as drawn; else where the game has it.
    const spot = (wagon: boolean, s: { x: number; y: number }) => {
      const found = wagon
        ? site.truckSlot(-l.train, l.cell, at)
        : yardSlot(l.relay ? l.relay.yard : l.yard, l.relay ? l.relay.slot : l.slot, at);
      if (found) {
        p.frame.updateWorldMatrix(true, false);
        p.frame.worldToLocal(found);
        const depth = p.trolley.position.y - (found.y + BOX_HEIGHT + 0.04);
        return { x: found.x, z: found.z, drop: Math.max(RAISED, depth) };
      }
      return { x: s.x - p.cx, z: s.y - p.cy, drop: H - 0.2 };
    };
    const a = l.relay ? spotFrom(l, p, yardSlot, site) : spot(!l.load, l.from);
    const b = spot(l.load && !l.relay, l.to);
    const ease = (t: number) => t * t * (3 - 2 * t);
    const dip = (t: number, depth: number) => RAISED + (depth - RAISED) * Math.sin(t * Math.PI);
    const share = (from: number, len: number) => (len > 0 ? clamp01((k - from) / len) : 1);
    if (k < run) {
      const t = ease(share(0, run));
      x = p.start.x + (a.x - p.start.x) * t;
      z = p.start.z + (a.z - p.start.z) * t;
    } else if (k < run + up) {
      x = a.x;
      z = a.z;
      drop = dip(share(run, up), a.drop);
      carry = k >= run + up / 2;
    } else if (k < run + up + along) {
      const t = ease(share(run + up, along));
      x = a.x + (b.x - a.x) * t;
      z = a.z + (b.z - a.z) * t;
      carry = true;
    } else {
      x = b.x;
      z = b.z;
      drop = k < total ? dip(share(run + up + along, down), b.drop) : RAISED;
      carry = k < total;
    }
    if (carry) paintContainer(p.load, l.look);
  }
  const follow = site.follow(dt);
  // Never off the ends of its rails, whatever the spreader reaches for.
  x = Math.min(p.to - 0.5, Math.max(p.from + 0.5, x));
  p.carriage.position.x += (x - p.carriage.position.x) * follow;
  p.trolley.position.z += (z - p.trolley.position.z) * follow;
  p.rope.scale.y = drop;
  p.rope.position.y = -drop / 2;
  p.spreader.position.y = -drop;
  p.load.visible = carry;
}

/** Where a relay lift takes its container up: the yard place it came from. */
function spotFrom(
  l: NonNullable<RailGantryView['lift']>,
  p: RailGantryParts,
  yardSlot: (yard: number, slot: number, out: Vector3) => Vector3 | null,
  _site: CraneSite,
): { x: number; z: number; drop: number } {
  const found = yardSlot(l.yard, l.slot, at);
  if (found) {
    p.frame.updateWorldMatrix(true, false);
    p.frame.worldToLocal(found);
    return {
      x: found.x,
      z: found.z,
      drop: Math.max(RAISED, p.trolley.position.y - (found.y + BOX_HEIGHT + 0.04)),
    };
  }
  return { x: l.from.x - p.cx, z: l.from.y - p.cy, drop: H - 0.2 };
}
