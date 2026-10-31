import { Group, Vector3, type Object3D } from 'three';
import { CRANE_LIFT_SET, CRANE_LIFT_TAKEN, HARBOUR_CRANE_TICKS } from '../../../sim/balance';
import { TICKS_PER_SECOND } from '../../../sim/types';
import { BOX_HEIGHT } from '../../assets';
import { container, paintContainer } from '../../models';
import { C } from '../../palette';
import { box, cyl, strut } from '../../parts';
import { QUAY_Y } from '../../terrain';
import { turnOf, wrapAngle } from '../../util/math';
import { landwardOffset } from '../map';
import type { TileBuild } from '../tiles';
import type { CraneParts, CraneSite, HarbourCraneParts } from './parts';

// The mobile harbour crane: a tower on the quay with a slewing deck and a
// long luffing boom, whose hook comes straight down over a container
// wherever it lies, out on the ship or on the landing stack beside it.

const slotAt = new Vector3();

/**
 * A mobile harbour crane: how high its slewing deck stands on the tower,
 * where the boom's foot is on the deck (out along +x of it, and up), how
 * long the boom is and how far it luffs, down and up.
 */
const HARBOUR_TOWER = 1.62;
const BOOM_FOOT = { x: 0.02, y: 0.3 };
const BOOM_LENGTH = 2.5;
const LUFF_LOW = 0.12;
const LUFF_HIGH = 1.48;
/** How deep a harbour crane's spreader is, under the hook. */
const SPREADER = 0.035;
/**
 * How high above the quay a harbour crane carries its hook between lifts:
 * a container on it clears four tiers on a feeder's deck and passes under
 * the slewing deck.
 */
const HOOK_UP = 1.42;

export function makeHarbourCrane(t: TileBuild): Object3D {
  const { m, i, g, parts } = t;
  // Mobile harbour crane: a wheeled undercarriage along the quay,
  // braced on four outriggers, a tall tower, and on top of it a
  // slewing deck with the machinery house, the cab and a long boom
  // luffed up and down by a ram, so the hook comes straight down over
  // a container wherever it lies, out on the ship or on the landing
  // stack beside the crane.
  const y = QUAY_Y;
  const back = landwardOffset(m, i);
  // Along the quay and in towards the land, from the middle of the tile.
  const at = (along: number, inward: number): [number, number] =>
    back.alongX ? [0.5 + along, 0.5 + back.side * inward] : [0.5 + back.side * inward, 0.5 + along];
  const lay = (
    along: number,
    inward: number,
    w: number,
    h: number,
    d: number,
    up: number,
    color: number = C.chassis,
  ) => {
    const [x, z] = at(along, inward);
    return back.alongX ? box(w, h, d, color, x, up, z) : box(d, h, w, color, x, up, z);
  };
  g.add(lay(0, 0, 0.84, 0.1, 0.32, y + 0.06));
  for (const along of [-0.34, -0.21, 0.21, 0.34]) {
    for (const inward of [-0.13, 0.13]) {
      g.add(lay(along, inward, 0.1, 0.08, 0.07, y, C.tyre));
    }
  }
  for (const sa of [-1, 1]) {
    for (const si of [-1, 1]) {
      const [x0, z0] = at(sa * 0.32, si * 0.12);
      const [x1, z1] = at(sa * 0.42, si * 0.42);
      g.add(strut([x0, y + 0.13, z0], [x1, y + 0.05, z1], 0.05, C.stripe));
      g.add(lay(sa * 0.42, si * 0.42, 0.11, 0.03, 0.11, y));
    }
  }
  g.add(cyl(0.1, HARBOUR_TOWER - 0.16, C.sign, 0.5, y + 0.16, 0.5, 8));
  // The slewing deck: boom out along its +x, the house and the
  // counterweight behind, the cab to one side of the boom's foot.
  const slew = new Group();
  slew.position.set(0.5, y + HARBOUR_TOWER, 0.5);
  slew.add(cyl(0.14, 0.05, C.chassis, 0, 0, 0, 8));
  slew.add(box(0.42, 0.2, 0.3, C.sign, -0.1, 0.05));
  slew.add(box(0.12, 0.16, 0.3, C.chassis, -0.37, 0.03));
  slew.add(box(0.15, 0.13, 0.12, C.cabin, 0.12, 0.05, 0.2));
  slew.add(box(0.02, 0.07, 0.1, C.window, 0.2, 0.09, 0.2));
  slew.add(box(0.1, 0.08, 0.18, C.chassis, BOOM_FOOT.x, 0.24));
  // The boom, laid out along +x from its foot and tapering to its
  // head, where the rope runs over the sheaves.
  const boom = new Group();
  boom.position.set(BOOM_FOOT.x, BOOM_FOOT.y, 0);
  const l = BOOM_LENGTH;
  boom.add(box(l * 0.6, 0.1, 0.12, C.craneYellow, l * 0.3, -0.05));
  boom.add(box(l * 0.4, 0.07, 0.08, C.craneYellow, l * 0.8, -0.035));
  boom.add(box(0.1, 0.08, 0.1, C.chassis, l, -0.04));
  slew.add(boom);
  const ram = box(1, 0.045, 0.045, C.chassis);
  slew.add(ram);
  // The rope from the head, the hook block on it, and under that the
  // spreader, turning to lie along the container it lifts.
  const head = new Group();
  const rope = box(0.012, 1, 0.012, C.chassis);
  const hook = new Group();
  hook.add(box(0.07, 0.06, 0.07, C.chassis));
  const spreader = new Group();
  spreader.add(box(0.62, SPREADER, 0.15, C.stripe, 0, -SPREADER));
  const load = container(i, 0, -SPREADER - BOX_HEIGHT, 0);
  load.visible = false;
  spreader.add(load);
  hook.add(spreader);
  head.add(rope, hook);
  slew.add(head);
  g.add(slew);
  // Landing stack for up to four containers on the quay beside it,
  // on the landward side, two by two.
  const stack: Object3D[] = [];
  for (let layer = 0; layer < 2; layer++) {
    for (const inward of [0.335, 0.645]) {
      const [cx, cz] = at(0, inward);
      const c = container(stack.length + 1, cx, y + layer * BOX_HEIGHT, cz);
      if (!back.alongX) c.rotation.y = Math.PI / 2;
      c.visible = false;
      g.add(c);
      stack.push(c);
    }
  }
  // Waiting with its boom out over the water.
  const sea = back.alongX ? (back.side * Math.PI) / 2 : back.side > 0 ? Math.PI : 0;
  const crane: CraneParts = {
    slew,
    rope,
    hook,
    rest: 0.45,
    reach: 0.6,
    stack,
    angle: sea,
    target: sea,
    busy: false,
    mhc: {
      idx: i,
      frame: g,
      boom,
      head,
      ram,
      spreader,
      load,
      radius: BOOM_FOOT.x + l * Math.cos(0.9),
      height: y + HOOK_UP,
      twist: Math.PI / 2,
      way: 0,
      choice: null,
      work: null,
      boat: -1,
      truck: -1,
      slot: 0,
      look: 0,
      phase: 0,
      drawn: 0,
      held: false,
      stacked: 0,
      base: 0,
      pick: 0,
      landing: null,
      leaving: null,
    },
  };
  parts.crane = crane;
  poseHarbourCrane(crane, crane.mhc!);
  return g;
}

/**
 * A mobile harbour crane at work slews and luffs its boom to bring the
 * hook straight over the container it is lifting, lowers the spreader
 * onto it, lifts it, slews round over its landing stack and sets it down
 * in the next place there; loading, from the export on the stack out to
 * its slot on the ship. The hook keeps its height as the boom luffs, and
 * the spreader turns to lie along the container. Idle, it waits where it
 * is with the hook up.
 */
export function runHarbourCrane(
  site: CraneSite,
  c: CraneParts,
  h: HarbourCraneParts,
  dt: number,
): void {
  const cycle = HARBOUR_CRANE_TICKS / TICKS_PER_SECOND;
  const was = h.drawn;
  // Stopping for a frame where it takes hold of a container or lets go
  // of one, so it is right on it then however fast the game is going,
  // even when it has just been brought into step with the game.
  let next = h.held ? h.phase : h.phase + (dt * site.speed()) / cycle;
  h.held = false;
  for (const at of [CRANE_LIFT_TAKEN, CRANE_LIFT_SET]) if (was < at && next > at) next = at;
  h.phase = h.work ? next % 1 : 0;
  if (h.phase < was || !h.work) {
    h.base = site.kept(-1 - h.idx, h.look);
    h.choice = null;
  }
  const order = site.order(-1 - h.idx);
  const kept = (look: number) => site.kept(-1 - h.idx, look);
  // Shown set down or lifted until the game has it so too.
  for (const s of [h.landing, h.leaving]) if (s) s.age += dt * site.speed();
  if (h.landing && (kept(h.landing.look) > h.landing.base || h.landing.age > cycle)) {
    h.landing = null;
  }
  if (h.leaving && (kept(h.leaving.look) < h.leaving.base || h.leaving.age > cycle)) {
    h.leaving = null;
  }
  const up = QUAY_Y + HOOK_UP;
  let angle = c.angle;
  let radius = h.radius;
  let height = up;
  let twist = h.twist;
  let carry = false;
  // Its stack as the game has it, each container in its place: it then
  // shows them set down and taken itself.
  const placed = site.placed(h.idx);
  // Its other end: a slot on the ship's deck, or a tractor beside it.
  const tractor = h.work === 'give' || h.work === 'take';
  const direct = (h.work === 'unload' || h.work === 'load') && h.truck >= 0;
  const [far, at] = tractor ? [h.truck, 0] : [h.boat, h.slot];
  const ship = h.work ? site.truckSlot(far, at, slotAt) : null;
  if (h.work && ship) {
    const frame = turnOf(h.frame);
    const lie = (site.slotTurn(far, at) ?? frame) - frame;
    const deck = hookOver(c, h.frame.worldToLocal(ship), lie);
    // The next free place on the stack, past one just set down there, or
    // wherever the container it moves is on it.
    const there = order.lastIndexOf(h.look);
    if (h.work === 'unload') {
      h.pick =
        h.landing?.look === h.look
          ? h.stacked
          : there >= 0
            ? there
            : h.stacked + (h.landing ? 1 : 0);
    } else if (there >= 0) h.pick = there;
    if (placed && h.place !== undefined && h.place >= 0) h.pick = h.place;
    const slot = c.stack[Math.max(0, Math.min(c.stack.length - 1, h.pick))];
    const onto = direct ? site.truckSlot(h.truck, 0, new Vector3()) : null;
    const pile = onto
      ? hookOver(
          c,
          h.frame.worldToLocal(onto),
          (site.slotTurn(h.truck, 0) ?? turnOf(h.frame)) - turnOf(h.frame),
        )
      : hookOver(c, slot.position, slot.rotation.y);
    const inward = h.work === 'unload' || h.work === 'take';
    const [from, to] = inward ? [deck, pile] : [pile, deck];
    if (!h.choice) {
      const round = swing(deck.angle, pile.angle);
      if (!h.way || Math.abs(round) < Math.PI * 0.8) h.way = Math.sign(round) || 1;
      // A container lies the same either way round: the spreader turns
      // the least it can, and swings round with the boom between.
      const head = alike(from.turn - from.angle, h.twist);
      h.choice = {
        angle: c.angle,
        radius: h.radius,
        twist: h.twist,
        from: head,
        to: alike(to.turn - to.angle, head),
      };
    }
    // Out from the ship to the stack one way round, and back the other.
    const way = inward ? h.way : -h.way;
    const lift = { ...from, twist: alike(from.turn - from.angle, h.choice.from) };
    const land = { ...to, twist: alike(to.turn - to.angle, h.choice.to) };
    // High enough to clear what it passes over, carrying a container.
    const high = Math.max(up, from.height + 0.15, to.height + 0.15);
    // The ship's deck, or a tractor beside it; and a tractor it sets one
    // straight onto off the ship.
    const onDeck = () => !!site.slotShown(far, at);
    const onTractor = () => !!site.slotShown(h.truck, 0);
    // On the ship's deck or a tractor it waits for the game to hand the
    // container over, a moment at most, before it lifts it or lets go.
    if (inward && h.phase >= CRANE_LIFT_TAKEN && h.phase < CRANE_LIFT_SET) {
      if (onDeck()) [h.phase, h.held] = [CRANE_LIFT_TAKEN, true];
    }
    if (h.phase >= CRANE_LIFT_SET && (inward ? direct && !onTractor() : !onDeck())) {
      [h.phase, h.held] = [CRANE_LIFT_SET, true];
    }
    const p = h.phase;
    const ease = (t: number) => t * t * (3 - 2 * t);
    const dip = (t: number, depth: number) => high + (depth - high) * Math.sin(t * Math.PI);
    const take = CRANE_LIFT_TAKEN;
    const set = CRANE_LIFT_SET;
    // Over to the container, down and up with it at `take`, round to
    // where it goes, down and up again having let go at `set`.
    const a = take - 0.15;
    const b = take + 0.15;
    const d = set - 0.15;
    // Handed over, it is on the spreader from when it leaves the ship's
    // deck until it is set down on the stack, or from when it is lifted
    // off the stack until it shows on the deck: never on neither, nor on
    // both. The stack shows it there from when it is let go, and gone
    // from when it is taken, without waiting for the game to catch up.
    if (p < a) {
      const t = ease(p / a);
      const was = h.choice;
      angle = was.angle + swing(was.angle, lift.angle, -way) * t;
      radius = was.radius + (lift.radius - was.radius) * t;
      twist = was.twist + (lift.twist - was.twist) * t;
    } else if (p < b) {
      ({ angle, radius, twist } = lift);
      height = dip((p - a) / (b - a), lift.height);
      carry = inward ? !onDeck() : p >= take;
    } else if (p < d) {
      const t = ease((p - b) / (d - b));
      angle = lift.angle + swing(lift.angle, land.angle, way) * t;
      radius = lift.radius + (land.radius - lift.radius) * t;
      twist = lift.twist + (land.twist - lift.twist) * t;
      height = high;
      carry = true;
    } else {
      ({ angle, radius, twist } = land);
      height = dip((p - d) / (1 - d), land.height);
      carry = inward ? (direct ? !onTractor() : p < set) : !onDeck();
    }
    if (!inward && p >= take && h.leaving?.look !== h.look) {
      if (there >= 0 && kept(h.look) >= h.base)
        h.leaving = { look: h.look, base: h.base, age: 0, place: h.pick };
    }
    if (inward && !direct && p >= set && h.landing?.look !== h.look) {
      if (placed ? kept(h.look) <= h.base : there < 0) {
        h.landing = { look: h.look, base: h.base, age: 0, place: h.pick };
      }
    }
  }
  const follow = site.follow(dt);
  c.angle += swing(c.angle, angle) * follow;
  h.radius += (radius - h.radius) * follow;
  h.height += (height - h.height) * follow;
  h.twist += (twist - h.twist) * follow;
  h.load.visible = carry;
  if (carry) paintContainer(h.load, h.look);
  h.drawn = h.phase;
  // The stack as the game has it, with what was just set down on it or
  // lifted off it; in places, as setCranes has drawn it, and those.
  if (placed) {
    const landing = h.landing && c.stack[h.landing.place ?? -1];
    if (h.landing && landing) {
      landing.visible = true;
      paintContainer(landing, h.landing.look);
    }
    const leaving = h.leaving && c.stack[h.leaving.place ?? -1];
    if (leaving) leaving.visible = false;
    poseHarbourCrane(c, h);
    return;
  }
  c.stack.forEach((o, k) => (o.visible = k < h.stacked));
  const landing = h.landing && c.stack[h.stacked];
  if (h.landing && landing) {
    landing.visible = true;
    paintContainer(landing, h.landing.look);
  }
  const leaving = h.leaving ? order.lastIndexOf(h.leaving.look) : -1;
  if (leaving >= 0 && leaving < c.stack.length) c.stack[leaving].visible = false;
  poseHarbourCrane(c, h);
}

/**
 * Where a harbour crane's hook is to be to lift or set down a container
 * at `at`, in its tile's model, lying turned `lie` about y: which way it
 * slews, how far out and how high the hook is, and which way the
 * spreader turns.
 */
function hookOver(
  c: CraneParts,
  at: Vector3,
  lie: number,
): { angle: number; radius: number; height: number; turn: number } {
  const dx = at.x - c.slew.position.x;
  const dz = at.z - c.slew.position.z;
  return {
    angle: Math.atan2(-dz, dx),
    radius: Math.hypot(dx, dz),
    height: at.y + BOX_HEIGHT + SPREADER,
    turn: lie,
  };
}

/** Slew, luff the boom and play out the rope to put a harbour crane's hook where it is. */
export function poseHarbourCrane(c: CraneParts, h: HarbourCraneParts): void {
  c.slew.rotation.y = c.angle;
  const out = (h.radius - BOOM_FOOT.x) / BOOM_LENGTH;
  const luff = Math.max(LUFF_LOW, Math.min(LUFF_HIGH, Math.acos(Math.max(-1, Math.min(1, out)))));
  const cos = Math.cos(luff);
  const sin = Math.sin(luff);
  h.boom.rotation.z = luff;
  h.head.position.set(BOOM_FOOT.x + BOOM_LENGTH * cos, BOOM_FOOT.y + BOOM_LENGTH * sin - 0.08, 0);
  const drop = Math.max(0.05, c.slew.position.y + h.head.position.y - h.height);
  c.rope.scale.y = drop;
  c.rope.position.y = -drop / 2;
  c.hook.position.y = -drop;
  h.spreader.rotation.y = h.twist;
  // The ram, from low on the front of the deck to under the boom.
  const [x0, y0] = [0.17, 0.06];
  const x1 = BOOM_FOOT.x + 0.8 * cos + 0.05 * sin;
  const y1 = BOOM_FOOT.y + 0.8 * sin - 0.05 * cos;
  h.ram.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0);
  h.ram.scale.x = Math.hypot(x1 - x0, y1 - y0);
  h.ram.rotation.z = Math.atan2(y1 - y0, x1 - x0);
}

/**
 * How far to slew from `from` to `to`: the short way round, or when that is
 * over a quarter of a turn, the way `way` says (1 or -1), so that a ship
 * rolling a little cannot send a crane swinging round the other way.
 */
function swing(from: number, to: number, way = 0): number {
  let d = wrapAngle(to - from);
  if (way * d < 0 && Math.abs(d) > Math.PI / 2) d += Math.PI * 2 * way;
  return d;
}

/** The turn a container lying turned `turn` is at, the same as or half a turn from it, nearest `near`. */
function alike(turn: number, near: number): number {
  return turn + Math.PI * Math.round((near - turn) / Math.PI);
}
