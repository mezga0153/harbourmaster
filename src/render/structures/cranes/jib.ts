import { Group, Vector3, type Object3D } from 'three';
import type { CraneView } from '../../../protocol';
import type { Cargo } from '../../../sim/cargo';
import { CRANE_LIFT_SET, CRANE_LIFT_TAKEN, CRANE_TICKS } from '../../../sim/balance';
import { TICKS_PER_SECOND } from '../../../sim/types';
import { crate, CRATE, setCrateIcon } from '../../models';
import { C } from '../../palette';
import { box, cyl } from '../../parts';
import { QUAY_Y } from '../../terrain';
import { lerpAngle, syncPhase } from '../../util/math';
import { landwardOffset } from '../map';
import type { TileBuild } from '../tiles';
import type { CraneParts, CraneSite, JibParts } from './parts';

// The jib crane on the quay: a slewing cab on a pedestal whose jib runs out
// and in, lifting crates off the boats' decks onto its landing stack, into
// crate storage in reach or onto the quay, and back on board.

/** Where a jib crane's jib is pivoted on its cab, and how long each of its three sections is. */
const JIB_FOOT_X = 0.1;
const JIB_FOOT_Y = 0.12;
const JIB_SECTION = 1.1;
/** How steeply a jib crane's jib stands when it can, running out further to reach further. */
const JIB_LUFF = 0.55;
/** As far through a lift as a jib crane goes before the game starts the next. */
const JIB_END = 0.999;

/** Where a crate lies from a jib crane; see jibAt. */
interface JibEnd {
  angle: number;
  out: number;
  y: number;
  yaw: number;
}

/** As lerpAngle, for something square: the least way round to lie square with `to`. */
function squareTurn(from: number, to: number, t: number): number {
  const q = Math.PI / 2;
  const d = ((((to - from) % q) + q * 1.5) % q) - q / 2;
  return from + d * t;
}

/** A pallet board under a crate of `size`, as a coaster's crates are. */
function palletUnder(c: Object3D, size: number): Object3D {
  const p = box(size * 1.1, size * 0.14, size * 1.1, C.wood, 0, -size * 0.14);
  c.add(p);
  return p;
}

export function makeJibCrane(t: TileBuild): Object3D {
  const { m, i, g, parts } = t;
  // Pedestal, then a slewing cab and jib that swings to face the boat.
  g.add(cyl(0.13, 0.5, C.craneYellow, 0.5, QUAY_Y, 0.5, 8));
  const slew = new Group();
  slew.position.set(0.5, QUAY_Y + 0.5, 0.5);
  slew.add(box(0.3, 0.2, 0.24, C.craneYellow, -0.02, 0));
  slew.add(box(0.06, 0.1, 0.2, C.window, 0.13, 0.05));
  slew.add(box(0.16, 0.14, 0.2, C.chassis, -0.2, 0.02));
  // The jib luffs up and down from its foot on the cab, and runs out
  // in two more sections, each slimmer, to reach as far as it lifts.
  const luff = new Group();
  luff.position.set(JIB_FOOT_X, JIB_FOOT_Y, 0);
  const sections = [
    [0.07, 0.08],
    [0.055, 0.065],
    [0.045, 0.05],
  ].map(([h, d]) => box(JIB_SECTION, h, d, C.craneYellow, JIB_SECTION / 2, -h / 2));
  luff.add(...sections);
  slew.add(luff);
  // Cable and hook hang from the end of the jib, and a crate on the
  // hook while it carries one.
  const tip = new Group();
  const rope = box(0.01, 1, 0.01, C.chassis);
  const hook = new Group();
  hook.add(box(0.07, 0.05, 0.07, C.chassis, 0, -0.05));
  const load = crate(1);
  const pallet = palletUnder(load, 1);
  load.visible = false;
  hook.add(load);
  tip.add(rope, hook);
  slew.add(tip);
  g.add(slew);
  // Landing stack on the landward half of the tile, on pallets when
  // they come off a coaster.
  const stack: Object3D[] = [];
  const back = landwardOffset(m, i);
  for (let layer = 0; layer < 2; layer++) {
    for (let k = 0; k < 5; k++) {
      const a = 0.14 + k * 0.18;
      const [cx, cz] = back.alongX ? [a, 0.5 + back.side * 0.32] : [0.5 + back.side * 0.32, a];
      const c = crate(CRATE, cx, QUAY_Y + layer * CRATE, cz);
      palletUnder(c, CRATE).visible = false;
      c.visible = false;
      g.add(c);
      stack.push(c);
    }
  }
  const crane: CraneParts = {
    slew,
    rope,
    hook,
    rest: 0.2,
    reach: 0.35,
    stack,
    angle: 0,
    target: 0,
    busy: false,
    jib: {
      luff,
      mid: sections[1],
      end: sections[2],
      tip,
      load,
      pallet,
      out: 1.2,
      work: null,
      boat: -1,
      slot: 0,
      place: 0,
      carriesPallet: false,
      phase: 0,
      key: '',
      start: { angle: 0, out: 1.2 },
    },
  };
  reachOut(crane.jib!, 1.2);
  parts.crane = crane;
  return g;
}

/** A jib crane's lift and landing stack as the game has them. */
export function setJib(c: CraneParts, j: JibParts, v: CraneView): void {
  // Pallets lift the stack by their thickness.
  const lift = v.pallets ? CRATE * 0.14 : 0;
  c.stack.forEach((o, k) => {
    o.children[2].visible = !!v.pallets;
    o.position.y = QUAY_Y + lift + (k < 5 ? 0 : CRATE + lift);
  });
  j.work = v.working === 'load' || v.working === 'unload' ? v.working : null;
  j.boat = v.workBoat ?? -1;
  j.slot = v.workSlot ?? 0;
  j.store = v.workStore;
  j.pile = v.workPile;
  j.place = v.workPlace ?? 0;
  j.carriesPallet = !!v.workPallet;
  // A new lift is taken up where the game has it, swinging round from
  // where the jib is; the same one is kept in step without jumping for a
  // small difference.
  const key = [v.working, v.workBoat, v.workSlot, v.workStore, v.workPile, v.workPlace].join();
  if (key !== j.key) j.start = { angle: c.angle, out: j.out };
  if (v.workPhase !== undefined) {
    j.phase = key !== j.key ? v.workPhase : syncPhase(j.phase, v.workPhase, { most: JIB_END });
  }
  j.key = key;
}

/**
 * Run a jib crane's jib out or in, luffing it up or down, so its hook
 * hangs `out` from the pedestal: standing at JIB_LUFF while it can, and
 * steeper close in once it has run all the way in.
 */
export function reachOut(j: JibParts, out: number): void {
  const r = Math.max(0, out - JIB_FOOT_X);
  const len = Math.max(JIB_SECTION, Math.min(3 * JIB_SECTION - 0.2, r / Math.cos(JIB_LUFF)));
  const up = Math.acos(Math.max(Math.cos(1.45), Math.min(1, r / len)));
  j.luff.rotation.z = up;
  j.end.position.x = len - JIB_SECTION / 2;
  j.mid.position.x = Math.max(JIB_SECTION, (len + JIB_SECTION) / 2 + 0.05) - JIB_SECTION / 2;
  j.tip.position.set(JIB_FOOT_X + len * Math.cos(up), JIB_FOOT_Y + len * Math.sin(up) - 0.03, 0);
  j.out = out;
}

/** The crate in the place a jib crane sets a crate into or takes one from, off the boat. */
function jibPlace(site: CraneSite, c: CraneParts, j: JibParts): Object3D | undefined {
  if (j.pile === undefined && j.store === undefined) return c.stack[j.place];
  return site.crateIn(j.store, j.pile, j.place);
}

/**
 * Where a crate lies for a jib crane to lift, from its pedestal: which
 * way and how far, how high its foot is and which way it is turned
 * (every crate is CRATE big).
 */
function jibAt(c: CraneParts, o: Object3D): JibEnd {
  const frame = c.slew.parent!;
  const at = frame.worldToLocal(o.getWorldPosition(new Vector3()));
  const ax = frame.worldToLocal(o.localToWorld(new Vector3(1, 0, 0))).sub(at);
  const dx = at.x - c.slew.position.x;
  const dz = at.z - c.slew.position.z;
  return {
    angle: Math.atan2(-dz, dx),
    out: Math.hypot(dx, dz),
    y: at.y - c.slew.position.y,
    yaw: Math.atan2(-ax.z, ax.x),
  };
}

/**
 * A jib crane at work slews round to the crate on the boat's deck, runs
 * its jib out or in over it, lowers the hook onto it and lifts it, then
 * slews round to its landing stack or the crate storage in reach and
 * lowers it there; loading, from storage or the quay onto the boat. Idle,
 * it waits where it last worked with the hook up.
 */
export function runJib(site: CraneSite, c: CraneParts, j: JibParts, dt: number): void {
  const cycle = CRANE_TICKS / TICKS_PER_SECOND;
  // A lift ends when the game has the crate where it was set down, so the
  // next starts: it waits at the end of this one until then.
  j.phase = j.work ? Math.min(JIB_END, j.phase + (dt * site.speed()) / cycle) : 0;
  const deck = j.work ? site.slotObject(j.boat, j.slot) : undefined;
  const yard = j.work ? jibPlace(site, c, j) : undefined;
  let angle = c.busy ? c.target : c.angle;
  let out = j.out;
  let carry = false;
  let yaw = c.angle + j.load.rotation.y;
  // How far down the hook goes, onto the top of a crate, and how far there it is.
  let lower: { at: JibEnd; t: number } | null = null;
  if (deck && yard) {
    const [src, dst] = j.work === 'unload' ? [deck, yard] : [yard, deck];
    const from = jibAt(c, src);
    const to = jibAt(c, dst);
    const p = j.phase;
    const ease = (t: number) => t * t * (3 - 2 * t);
    const take = CRANE_LIFT_TAKEN;
    const set = CRANE_LIFT_SET;
    // Round to the crate, down and up with it at `take`, round to where
    // it goes, down and up again having let go at `set`.
    const a = take - 0.15;
    const b = take + 0.15;
    const d = set - 0.15;
    // Handed over, it is on the hook from when it leaves where it was
    // until it shows where it is set down, never on neither. The game
    // moves it at the end of the lift, and its view a tick or so after
    // the hook takes it or lets go: here it goes as the hook does.
    if (p >= take) src.visible = false;
    if (p >= set) dst.visible = true;
    // The crate on the hook is the one it took, with what it holds painted
    // on it, not the fish every crate starts out showing.
    if (p < take) setCrateIcon(j.load, src.userData.icon as Cargo | undefined);
    if (p < a) {
      const t = ease(p / a);
      angle = lerpAngle(j.start.angle, from.angle, t);
      out = j.start.out + (from.out - j.start.out) * t;
    } else if (p < b) {
      angle = from.angle;
      out = from.out;
      lower = { at: from, t: (p - a) / (b - a) };
      carry = p >= take || !src.visible;
      yaw = from.yaw;
    } else if (p < d) {
      const t = ease((p - b) / (d - b));
      angle = lerpAngle(from.angle, to.angle, t);
      out = from.out + (to.out - from.out) * t;
      carry = true;
      yaw = squareTurn(from.yaw, to.yaw, t);
    } else {
      angle = to.angle;
      out = to.out;
      lower = { at: to, t: (p - d) / (1 - d) };
      carry = p < set;
      yaw = squareTurn(from.yaw, to.yaw, 1);
    }
  }
  const follow = site.follow(dt);
  c.angle = lerpAngle(c.angle, angle, follow);
  c.slew.rotation.y = c.angle;
  reachOut(j, j.out + (out - j.out) * follow);
  // The hook comes down onto the top of the crate, which hangs below it.
  const depth = lower ? j.tip.position.y - (lower.at.y + CRATE + 0.05) : c.rest;
  const drop = lower ? c.rest + (depth - c.rest) * Math.sin(lower.t * Math.PI) : c.rest;
  c.rope.scale.y = drop;
  c.rope.position.y = -drop / 2;
  c.hook.position.y = -drop;
  j.load.visible = carry;
  j.load.scale.setScalar(CRATE);
  j.load.position.y = -0.05 - CRATE;
  j.load.rotation.y = yaw - c.angle;
  j.pallet.visible = j.carriesPallet;
}
