import type { GameMap } from '../../sim/map';
import { DEPOT_BACK, DEPOT_HALF, isMachineKind, MACHINE_SIZE } from '../../sim/machines';
import { frontOf } from '../../sim/rules';
import { Build, type MachineKind } from '../../sim/types';
import { CARRY_LOW } from '../machines';
import type { Pose } from '../motion';
import { ease, lerpAngle } from '../util/math';
import { place, type Entry } from './entry';

// Machines driving into their depot and parking there, and setting off
// out of it again, through the door and never through the walls. `sim` is
// game time in seconds, as Entities keeps it.

/** Game seconds a machine takes to drive between the middle of its depot and where it parks. */
const PARK_TIME = 1.6;

/**
 * A machine standing in its depot moves from the middle of the garage,
 * where the game has it, into where it parks (x, y and dir in its view):
 * turned there first, where there is room to, then across into its place
 * square on, so it never swings round into a wall; or is drawn there,
 * seen there from the first.
 */
export function parkIn(map: GameMap, sim: number, e: Entry, was: Pose, first: boolean): void {
  const v = e.view;
  const slot: Pose = { x: v.x, z: v.y, dir: v.dir, h: CARRY_LOW };
  const d = e.dock;
  if (first) e.dock = { in: true, from: slot, to: slot, start: -Infinity };
  else if (!d?.in || d.to?.x !== slot.x || d.to.z !== slot.z || d.to.dir !== slot.dir) {
    e.dock = { in: true, from: was, to: slot, start: sim };
  }
  const { from } = e.dock!;
  const a = (sim - e.dock!.start) / PARK_TIME;
  const part = (a0: number, a1: number) => ease((a - a0) / (a1 - a0));
  // Turning about, it does so in the middle of the garage, the one place
  // there is room to.
  const spin = Math.abs(lerpAngle(from.dir, slot.dir, 1) - from.dir) > 0.3;
  const mid = spin
    ? { x: Math.floor(slot.x) + 0.5, z: Math.floor(slot.z) + 0.5 }
    : { x: from.x, z: from.z };
  const [toMid, turn, across] = spin
    ? [part(0, 0.15), part(0.15, 0.4), part(0.4, 1)]
    : [1, part(0, 0.3), part(0, 1)];
  const at = { x: from.x + (mid.x - from.x) * toMid, z: from.z + (mid.z - from.z) * toMid };
  place(map, e, {
    x: at.x + (slot.x - at.x) * across,
    z: at.z + (slot.z - at.z) * across,
    dir: lerpAngle(from.dir, slot.dir, turn),
    h: CARRY_LOW,
  });
  e.about = e.slip = e.hand = undefined;
}

/**
 * A machine setting off from where it parked moves out onto its way, as
 * the game has it: square on as it was parked while still in the garage,
 * a forklift that drove in backing out, and turning onto its way once
 * out of the door.
 */
export function parkOut(map: GameMap, sim: number, e: Entry, was: Pose): void {
  const root = e.model.root;
  const m = map;
  if (e.dock!.in) e.dock = { in: false, from: was, start: sim };
  const dock = e.dock!;
  const { from } = dock;
  const live: Pose = {
    x: root.position.x,
    z: root.position.z,
    dir: -root.rotation.y,
    h: e.pose?.h ?? CARRY_LOW,
  };
  const f = ease(Math.min(1, (sim - dock.start) / PARK_TIME));
  // How far from the back of the depot towards its door, and across from its middle.
  const [tx, ty] = [Math.floor(from.x), Math.floor(from.z)];
  const facing = m.orient[m.idx(tx, ty)] & 3;
  const [ox, oy] = [
    Math.round(Math.cos((facing * Math.PI) / 2)),
    Math.round(Math.sin((facing * Math.PI) / 2)),
  ];
  const local = (p: Pose) => {
    const [cx, cz] = [p.x - tx - 0.5, p.z - ty - 0.5];
    return { depth: cx * ox + cz * oy + 0.5, side: -cx * oy + cz * ox };
  };
  const [a, b] = [local(from), local(live)];
  const depth = a.depth + (b.depth - a.depth) * f;
  let side = a.side + (b.side - a.side) * f;
  // Square on as it was parked, and between the walls, until all of it
  // is out of the door, waiting its turn behind others if it must; then
  // round onto its way, clear of the walls as it swings.
  const size = MACHINE_SIZE[e.view.kind as MachineKind];
  const behind = Math.cos(from.dir) * ox + Math.sin(from.dir) * oy > 0 ? size.back : size.front;
  // Back in again before it was round: as it drives in.
  if (dock.out !== undefined && local({ ...live, x: e.view.x, z: e.view.y }).depth < 1) {
    e.dock = undefined;
    return;
  }
  // Gone on past the tile at its door, as the game has it, as when its way
  // runs back along beside the depot: it is out, whichever way it went.
  const [vx, vy] = [Math.floor(e.view.x), Math.floor(e.view.y)];
  const door = frontOf(m, m.idx(tx, ty), facing);
  const far = Math.hypot(e.view.x - m.xOf(door) - 0.5, e.view.y - m.yOf(door) - 0.5) > 1.2;
  const gone = far && m.inBounds(vx, vy) && m.build[m.idx(vx, vy)] !== Build.Depot;
  if (dock.out === undefined && gone) dock.out = sim;
  if (dock.out === undefined) {
    if (depth - Math.hypot(behind, size.half) > 1) dock.out = sim;
    else if (depth - behind < 1) {
      side = Math.max(-(DEPOT_HALF - size.half), Math.min(DEPOT_HALF - size.half, side));
    }
  }
  const turn = dock.out === undefined ? 0 : Math.min(1, (sim - dock.out) / (PARK_TIME / 2));
  if (f >= 1 && turn >= 1) {
    e.dock = undefined;
    return;
  }
  const d = depth - 0.5;
  place(map, e, {
    x: tx + 0.5 + ox * d - oy * side,
    z: ty + 0.5 + oy * d + ox * side,
    dir: lerpAngle(from.dir, live.dir, ease(turn)),
    h: live.h,
  });
}

/**
 * A machine driving into or out of a depot, or turning in front of its
 * door on its way, kept inside the garage's walls: between them as long
 * as any of it is in the doorway, and short of the back wall, rather
 * than poke through them.
 */
export function keepInside(map: GameMap, e: Entry): void {
  const v = e.view;
  if (!isMachineKind(v.kind) || v.parked || v.handStage || e.hand) return;
  const root = e.model.root;
  const m = map;
  const tile = (x: number, z: number) =>
    m.inBounds(Math.floor(x), Math.floor(z)) ? m.idx(Math.floor(x), Math.floor(z)) : -1;
  const here = tile(root.position.x, root.position.z);
  if (here < 0) return;
  const size = MACHINE_SIZE[v.kind];
  const dir = -root.rotation.y;
  // The depot it is in, as drawn or as the game has it, or the one whose
  // door it is in front of, coming or going.
  for (const depot of new Set([here, tile(v.x, v.y), ...m.neighbors4(here)])) {
    if (depot < 0 || m.build[depot] !== Build.Depot) continue;
    const facing = m.orient[depot] & 3;
    if (depot !== here && frontOf(m, depot, facing) !== here) continue;
    const [ox, oy] = [
      Math.round(Math.cos((facing * Math.PI) / 2)),
      Math.round(Math.sin((facing * Math.PI) / 2)),
    ];
    // In the depot's terms: from the back of it towards the door, and
    // across from its middle; the machine's corners from its middle.
    const [cx, cz] = [root.position.x - m.xOf(depot) - 0.5, root.position.z - m.yOf(depot) - 0.5];
    let depth = cx * ox + cz * oy + 0.5;
    let side = -cx * oy + cz * ox;
    const [c, s] = [Math.cos(dir), Math.sin(dir)];
    const [hd, hs, nd, ns] = [c * ox + s * oy, -c * oy + s * ox, -s * ox + c * oy, s * oy + c * ox];
    const deep: number[] = [];
    const across: number[] = [];
    for (const f of [-size.back, size.front]) {
      for (const g of [-size.half, size.half]) {
        deep.push(f * hd + g * nd);
        across.push(f * hs + g * ns);
      }
    }
    const [d0, s0, s1] = [Math.min(...deep), Math.min(...across), Math.max(...across)];
    if (depth + d0 >= 1) continue;
    depth = Math.max(depth, DEPOT_BACK - d0);
    if (s1 - s0 <= DEPOT_HALF * 2) {
      side = Math.max(-DEPOT_HALF - s0, Math.min(DEPOT_HALF - s1, side));
    }
    const x = m.xOf(depot) + 0.5 + ox * (depth - 0.5) - oy * side;
    const z = m.yOf(depot) + 0.5 + oy * (depth - 0.5) + ox * side;
    if (x !== root.position.x || z !== root.position.z) {
      place(map, e, { x, z, dir, h: e.pose?.h ?? CARRY_LOW });
    }
    return;
  }
}
