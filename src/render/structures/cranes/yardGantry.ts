import { Group, Vector3, type Object3D } from 'three';
import { YARD_GANTRY_TICKS } from '../../../sim/balance';
import { gantryYard, liftMarks } from '../../../sim/rules';
import { TICKS_PER_SECOND } from '../../../sim/types';
import { BOX_HEIGHT } from '../../assets';
import { container, paintContainer } from '../../models';
import { C } from '../../palette';
import { box } from '../../parts';
import { QUAY_Y } from '../../terrain';
import { clamp01 } from '../../util/math';
import type { TileBuild } from '../tiles';
import type { CraneSite, YardGantryParts } from './parts';

// The rail-mounted yard gantry spanning a container yard: it runs along
// its rails to the row it works and lifts containers between the stacks
// and the trucks in the lane under it.

const slotAt = new Vector3();

/** How many tiles a yard gantry's rails run either way along its yard, at most. */
const GANTRY_RUN = 12;
/** A yard gantry's lift with no running along its rails; see liftMarks. */
export const NO_RUN = [0, 0.5, 0, 0.5];

export function makeYardGantry(t: TileBuild): Object3D {
  const { m, i, g, parts } = t;
  // A rail-mounted gantry spanning the container yard beside it: legs
  // on rails along this side of the yard and its far side, a beam
  // overhead and a trolley with its spreader over the stacks. It runs
  // along the rails to whichever row of the yard it is working.
  const y = QUAY_Y;
  // The one yard it works, as the game has it: never into another
  // beside it, nor across a gap where a yard has been split in two.
  const own = gantryYard(m, i);
  const yard = own?.into;
  const inYard = (x: number, z: number) => m.inBounds(x, z) && !!own && own.area.has(m.idx(x, z));
  const [dx, dy] = yard === undefined ? [0, 1] : [m.xOf(yard) - m.xOf(i), m.yOf(yard) - m.yOf(i)];
  // Across as many yard tiles as there are, up to three.
  let span = 1;
  while (span < 3) {
    const x = m.xOf(i) + dx * (span + 1);
    const z = m.yOf(i) + dy * (span + 1);
    if (!inYard(x, z)) break;
    span++;
  }
  // Along the yard, either way, as far as its first row runs: the
  // frame's +x is (dy, -dx) on the map.
  const along = (sign: number) => {
    let k = 0;
    while (k < GANTRY_RUN) {
      const x = m.xOf(i) + dx + dy * sign * (k + 1);
      const z = m.yOf(i) + dy - dx * sign * (k + 1);
      if (!inYard(x, z)) break;
      k++;
    }
    return k * sign;
  };
  const [from, to] = yard === undefined ? [0, 0] : [along(-1), along(1)];
  const frame = new Group();
  const h = 1.15;
  const far = span + 0.35;
  for (const z of [-0.35, far]) {
    frame.add(box(to - from + 1, 0.02, 0.06, C.chassis, (from + to) / 2, y, z));
  }
  const carriage = new Group();
  for (const z of [-0.35, far]) {
    for (const x of [-0.4, 0.4]) {
      carriage.add(box(0.1, h, 0.1, C.craneYellow, x, y, z));
      carriage.add(box(0.14, 0.08, 0.24, C.chassis, x, y, z));
    }
    carriage.add(box(0.9, 0.1, 0.1, C.craneYellow, 0, y + h - 0.1, z));
  }
  for (const x of [-0.4, 0.4]) {
    carriage.add(box(0.1, 0.12, far + 0.45, C.craneYellow, x, y + h, (far - 0.35) / 2));
  }
  // The trolley with its cab, the hoist ropes and the spreader on them,
  // and the container it is lifting, if any.
  const trolley = new Group();
  trolley.position.set(0, y + h, Math.max(0.6, far / 2));
  trolley.add(box(0.6, 0.08, 0.3, C.chassis, 0, 0.12, 0));
  trolley.add(box(0.2, 0.16, 0.2, C.window, 0.18, -0.16, 0));
  const rope = box(0.012, 1, 0.012, C.chassis);
  const spreader = new Group();
  spreader.add(box(0.5, 0.04, 0.16, C.stripe, 0, -0.04, 0));
  const load = container(i, 0, -0.04 - BOX_HEIGHT, 0);
  load.visible = false;
  spreader.add(load);
  trolley.add(rope, spreader);
  carriage.add(trolley);
  frame.add(carriage);
  parts.yardGantry = {
    frame,
    carriage,
    trolley,
    rope,
    spreader,
    load,
    far,
    // Down to a truck's deck in the lane under it, set down there.
    laneDrop: h - 0.28 - BOX_HEIGHT,
    pick: null,
    laneAt: 0,
    base: 0,
    held: 0,
    slot: 0,
    work: null,
    look: 0,
    phase: 0,
    legs: NO_RUN,
    ticks: YARD_GANTRY_TICKS,
    railFrom: from,
    railTo: to,
    works: yard ?? -1,
    startX: 0,
    startZ: Math.max(0.6, far / 2),
  };
  // Laid out along +z, then turned to face the yard.
  frame.position.set(0.5, 0, 0.5);
  frame.rotation.y = Math.atan2(dx, dy);
  g.add(frame);
  return g;
}

export function runYardGantry(site: CraneSite, g: YardGantryParts, dt: number): void {
  // One lift a cycle, as long as this one takes in the game: the further
  // it runs along its rails, the longer.
  const cycle = g.ticks / TICKS_PER_SECOND;
  const was = g.phase;
  // To the end of this lift and no further: the next one starts when the
  // game says it does, from where this one left it.
  g.phase = g.work ? Math.min(1, g.phase + (dt * site.speed()) / cycle) : 0;
  if (!g.work) {
    g.base = site.kept(g.yard ?? -1, g.look);
    g.held = site.shownOn(g.truck);
    liftFrom(g);
  }
  // Idle, it stays where it last worked.
  let x = g.carriage.position.x;
  let z = Math.max(0.6, g.far / 2);
  let drop = 0.2;
  let carry = false;
  if (g.work) {
    // Between the container in the yard and the truck in the lane under
    // the gantry, where it reaches out over the edge of the yard.
    const yard = g.pick ?? { x: 0, z: Math.max(0.8, g.far * 0.6), drop: g.laneDrop };
    // Over the very container slot on the truck, front or back of a long one.
    const at = g.truck !== undefined ? site.truckSlot(g.truck, g.slot, slotAt) : null;
    if (at) g.frame.worldToLocal(at);
    const over = at
      ? { x: at.x, z: at.z, drop: g.trolley.position.y - (at.y + BOX_HEIGHT + 0.04) }
      : { x: g.laneAt, z: 0, drop: g.laneDrop };
    // Taken off one, it goes on from where it took it, whether that one
    // stays or drives off.
    const off = g.work === 'unload' && g.phase > liftMarks(g.legs).taken;
    if (!off || !g.offAt) g.offAt = over;
    const lane = off ? g.offAt : over;
    const [from, to] = g.work === 'load' ? [yard, lane] : [lane, yard];
    const ease = (t: number) => t * t * (3 - 2 * t);
    const dip = (t: number, depth: number) => 0.2 + (depth - 0.2) * Math.sin(t * Math.PI);
    // Handed over, it is on the spreader from when it leaves the yard or
    // the truck until it shows where it is set down, never on neither.
    const inYard = () => site.kept(g.yard ?? -1, g.look);
    const onTruck = () => g.truck !== undefined && !!site.slotShown(g.truck, g.slot);
    const [gone, there] =
      g.work === 'load'
        ? [() => inYard() < g.base, onTruck]
        : [() => site.shownOn(g.truck) < g.held, () => inYard() > g.base];
    // Run on into another lift before the game has said whether there is
    // one, it has nothing to carry until there was one there to take: a
    // tractor's single container is lifted off already.
    const had = g.work === 'load' ? g.base > 0 : g.held > 0;
    // Nor does it lift one off while it still shows where it was, or let
    // go of one before it shows where it is set down: ahead of the game,
    // as it is at speed, the spreader waits on it.
    const { taken, set } = liftMarks(g.legs);
    if (had && was <= taken && g.phase > taken && !gone()) g.phase = taken;
    if (had && was <= set && g.phase > set && !there()) g.phase = set;
    const p = g.phase;
    // Run along the rails to it, take it up, carry it along, set it down:
    // and there it stays, for the next.
    const [run, up, along] = g.legs;
    const share = (from: number, len: number) => (len > 0 ? clamp01((p - from) / len) : 1);
    if (p < run) {
      const t = ease(share(0, run));
      x = g.startX + (from.x - g.startX) * t;
      z = g.startZ + (from.z - g.startZ) * t;
    } else if (p < run + up) {
      x = from.x;
      z = from.z;
      drop = dip(share(run, up), from.drop);
      carry = p > taken || gone();
    } else if (p < run + up + along) {
      const t = ease(share(run + up, along));
      x = from.x + (to.x - from.x) * t;
      z = from.z + (to.z - from.z) * t;
      carry = true;
    } else {
      x = to.x;
      z = to.z;
      drop = dip(share(run + up + along, 1 - run - up - along), to.drop);
      carry = p < set || !there();
    }
    carry &&= had;
  }
  const follow = site.follow(dt);
  g.carriage.position.x += (x - g.carriage.position.x) * follow;
  g.trolley.position.z += (z - g.trolley.position.z) * follow;
  g.rope.scale.y = drop;
  g.rope.position.y = -drop / 2;
  g.spreader.position.y = -drop;
  g.load.visible = carry;
  if (carry) paintContainer(g.load, g.look);
}

/** A yard gantry setting off on a lift: from where its carriage and trolley stand now. */
export function liftFrom(g: YardGantryParts): void {
  g.startX = g.carriage.position.x;
  g.startZ = g.trolley.position.z;
}

/**
 * Where on its beam a yard gantry reaches for a container slot: along the
 * beam, across it, and how far down the spreader comes onto its top (the
 * container hangs below it). Null for no slot.
 */
export function pickOf(g: YardGantryParts, slot: Object3D | undefined): YardGantryParts['pick'] {
  if (!slot) return null;
  g.frame.updateWorldMatrix(true, false);
  slot.updateWorldMatrix(true, false);
  const at = g.frame.worldToLocal(slot.getWorldPosition(new Vector3()));
  const drop = g.trolley.position.y - (at.y + BOX_HEIGHT + 0.04);
  return { x: at.x, z: at.z, drop };
}
