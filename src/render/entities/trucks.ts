import { Box3, Vector3, type Object3D } from 'three';
import type { EntityView, HandAt } from '../../protocol';
import type { GameMap } from '../../sim/map';
import { Build } from '../../sim/types';
import { length, type Pose } from '../motion';
import { surfaceY } from '../terrain';
import type { Entry } from './entry';
import type { StillTruck } from './grid';

// Dockhands and forklifts keeping clear of the trucks standing still: where
// they stand to load one at a truck bay, and how they walk round one in
// the way rather than through it.

/** How far in front of a dockhand the crate they pick up or set down is. */
export const HAND_REACH = 0.16;
/** Furthest a dockhand leans out over the edge to a crate. */
export const LEAN_MOST = 0.3;
/** How far in from the back of a truck bay people walk across it, out of the truck's way. */
export const BACK_LANE = 0.18;

/** What keeping clear of the trucks asks of Entities. */
export interface TruckSite {
  map: GameMap;
  /** Everything drawn, the trucks among them. */
  entries(): Iterable<Entry>;
  entry(id: number): Entry | undefined;
  /** Where a place in a truck bay's stack lies, as Structures has it (see Entities.containerAt). */
  containerAt(at: HandAt, out: Vector3): number | null;
  /** Where a crate to hand over lies; see Entities.handSlot. */
  handSlot(at: HandAt, out: Vector3): number | null;
}

/**
 * Where a dockhand or forklift stands at the truck bay it is on, to take
 * a crate off its stack or set one on it, or on the truck in it: the back
 * corner behind the stack, and the way into the bay towards the stack
 * from there. Null off a truck bay.
 */
export function bayStand(
  site: TruckSite,
  v: EntityView,
  at: HandAt,
): { x: number; z: number; ux: number; uz: number } | null {
  const m = site.map;
  const tile = m.idx(Math.floor(v.x), Math.floor(v.y));
  if (!m.inBounds(Math.floor(v.x), Math.floor(v.y)) || m.build[tile] !== Build.TruckBay) {
    return null;
  }
  // Not to a pickup, which stands on the road beside the bay, not in it.
  const truck = at.truck === undefined ? undefined : site.entry(at.truck)?.view;
  const onTruck = truck?.kind === 'truck' && !truck.pickup;
  if (at.bay !== tile && !onTruck) return null;
  const f = bayFrame(site, tile);
  if (!f) return null;
  // Behind the stack, halfway across it.
  const [x, z] = f.at(0.8, 0.42);
  return { x, z, ux: f.ux, uz: f.uz };
}

/**
 * A truck bay's own frame, from where its stack's first places lie: the
 * way in from its entrance (u) and across it (s), and where a point in
 * it, or across it to the stack's side and from its back, lies.
 */
export function bayFrame(
  site: TruckSite,
  tile: number,
): {
  ux: number;
  uz: number;
  at: (across: number, back: number) => [number, number];
  of: (x: number, z: number) => [number, number];
} | null {
  // The first place, the one across from it, and the first of the row behind.
  const [a, b, c] = [0, 1, 8].map((slot) => {
    const out = new Vector3();
    return (site.containerAt({ bay: tile, slot }, out) ?? null) === null ? null : out;
  });
  if (!a || !b || !c) return null;
  // The first place is 0.71 across and 0.89 back from the bay's corner.
  const ux = (a.x - c.x) / 0.18;
  const uz = (a.z - c.z) / 0.18;
  const sx = (b.x - a.x) / 0.18;
  const sz = (b.z - a.z) / 0.18;
  return {
    ux,
    uz,
    at: (across, back) => [
      a.x + sx * (across - 0.71) + ux * (back - 0.89),
      a.z + sz * (across - 0.71) + uz * (back - 0.89),
    ],
    of: (x, z) => [0.71 + (x - a.x) * sx + (z - a.z) * sz, 0.89 + (x - a.x) * ux + (z - a.z) * uz],
  };
}

/** On a truck bay, people keep to its back, out of the way of the truck: where x, z goes. */
export function byBack(site: TruckSite, x: number, z: number): [number, number] {
  const m = site.map;
  const [tx, tz] = [Math.floor(x), Math.floor(z)];
  if (!m.inBounds(tx, tz) || m.build[m.idx(tx, tz)] !== Build.TruckBay) return [x, z];
  const f = bayFrame(site, m.idx(tx, tz));
  if (!f) return [x, z];
  const [across, back] = f.of(x, z);
  return back > BACK_LANE ? f.at(across, BACK_LANE) : [x, z];
}

/** Whether x, z is where a truck stands still, other than `but`, with a step's room (`pad`) round it. */
export function inTruck(site: TruckSite, x: number, z: number, but?: number, pad = 0.07): boolean {
  for (const truck of site.entries()) {
    if (truck.view.kind !== 'truck' || truck.view.moving || truck.view.id === but) continue;
    const root = truck.model.root;
    const dx = x - root.position.x;
    const dz = z - root.position.z;
    if (dx * dx + dz * dz > 2.5) continue;
    const box = (truck.size ??= sizeOf(root));
    const c = Math.cos(-root.rotation.y);
    const s = Math.sin(-root.rotation.y);
    const along = dx * c + dz * s;
    const across = -dx * s + dz * c;
    if (
      along > box.min.x - pad &&
      along < box.max.x + pad &&
      across > box.min.z - pad &&
      across < box.max.z + pad
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A dockhand loading a truck stands clear of it, at its side or tail,
 * whichever of them beside the crate's place on its bed is nearest, and
 * leans over to it. (A forklift lines up to it; see forks.ts.)
 */
export function clearOfTruck(
  site: TruckSite,
  v: EntityView,
  at: Pose | null,
  from: Pose,
): Pose | null {
  const id = v.handAt?.truck;
  const truck = id === undefined ? undefined : site.entry(id);
  if (!at || at.fixed || !truck || truck.view.kind !== 'truck') return at;
  if (v.kind !== 'dockhand') return at;
  const box = (truck.size ??= sizeOf(truck.model.root));
  const root = truck.model.root;
  const c = Math.cos(-root.rotation.y);
  const s = Math.sin(-root.rotation.y);
  const p = new Vector3();
  if (site.handSlot(v.handAt!, p) === null) return at;
  const ox = root.position.x;
  const oz = root.position.z;
  const along = (p.x - ox) * c + (p.z - oz) * s;
  const across = -(p.x - ox) * s + (p.z - oz) * c;
  const lie = (a: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, a));
  const gap = 0.1;
  // At its side, abreast of the crate's place, on the side that is on if
  // they can stand there, round its back to it if need be; never at the
  // tail or the cab.
  const mine = across < 0 ? box.min.z - gap : box.max.z + gap;
  const other = across < 0 ? box.max.z + gap : box.min.z - gap;
  const abreast = lie(along, box.min.x, box.max.x);
  const ok = (b: number) => {
    const x = ox + abreast * c - b * s;
    const z = oz + abreast * s + b * c;
    return surfaceY(site.map, x, z) > 0 && !inTruck(site, x, z, id);
  };
  const spots: [number, number][] = [[abreast, ok(mine) ? mine : other]];
  let best: [number, number] | undefined;
  let least = Infinity;
  for (const [a, b] of spots) {
    const x = ox + a * c - b * s;
    const z = oz + a * s + b * c;
    if (surfaceY(site.map, x, z) <= 0 || inTruck(site, x, z, id)) continue;
    const cost = Math.hypot(x - from.x, z - from.z);
    if (cost < least) [best, least] = [[x, z], cost];
  }
  if (!best) return at;
  const [x, z] = best;
  return {
    x,
    z,
    dir: Math.atan2(p.z - z, p.x - x),
    h: p.y - surfaceY(site.map, x, z),
    over: Math.min(LEAN_MOST, Math.max(0, Math.hypot(p.x - x, p.z - z) - HAND_REACH)),
  };
}

/**
 * Where a dockhand walking to x, z goes instead, round a truck standing
 * still rather than through it: to the edge of it on the side they are
 * on, and along that side, until the way is clear of it.
 */
export function offTrucks(site: TruckSite, e: Entry, x: number, z: number): [number, number] {
  const me = e.pose;
  if (!me) return [x, z];
  for (const truck of site.entries()) {
    if (truck.view.kind !== 'truck' || truck.view.moving) continue;
    const at = truck.model.root;
    const dx = x - at.position.x;
    const dz = z - at.position.z;
    if (dx * dx + dz * dz > 2.5) continue;
    const box = (truck.size ??= sizeOf(at));
    const c = Math.cos(-at.rotation.y);
    const s = Math.sin(-at.rotation.y);
    const pad = 0.07;
    // How far beyond each side of it, back, front, left and right, a point is.
    const beyond = (px: number, pz: number) => {
      const along = (px - at.position.x) * c + (pz - at.position.z) * s;
      const across = -(px - at.position.x) * s + (pz - at.position.z) * c;
      return [
        box.min.x - pad - along,
        along - box.max.x - pad,
        box.min.z - pad - across,
        across - box.max.z - pad,
      ];
    };
    const to = beyond(x, z);
    if (Math.max(...to) >= 0) {
      if (e.round?.truck === truck.view.id) e.round = undefined;
      continue;
    }
    // Kept to the side they are on, so they go round, never across; at
    // one loading, to its left, the side its crates are on. Never along
    // its front: from there, to whichever side is nearer.
    const from = beyond(me.x, me.z);
    const side = /^Loading/.test(truck.view.activity ?? '')
      ? 2
      : e.round?.truck === truck.view.id
        ? e.round.side
        : [2, 3, 0].reduce((k, n) => (from[n] > from[k] ? n : k));
    e.round = { truck: truck.view.id, side };
    let a = dx * c + dz * s;
    let b = -dx * s + dz * c;
    if (side === 0) a = box.min.x - pad;
    else if (side === 1) a = box.max.x + pad;
    else if (side === 2) b = box.min.z - pad;
    else b = box.max.z + pad;
    x = at.position.x + a * c - b * s;
    z = at.position.z + a * s + b * c;
  }
  return [x, z];
}

/** How far ahead of a truck standing still people keep out of, going round by its back instead. */
export const FRONT_CLEAR = 0.5;

/**
 * Corners to walk by from one point to another round a truck standing
 * still in the way, or across the ground just ahead of its cab: always
 * round its back, never past its front, unless both ends are ahead of it.
 * None if nothing is in the way.
 */
export function aroundTrucks(
  site: TruckSite,
  from: { x: number; z: number },
  to: { x: number; z: number },
): { x: number; z: number }[] {
  for (const truck of site.entries()) {
    if (truck.view.kind !== 'truck' || truck.view.moving) continue;
    const at = truck.model.root;
    const mx = (from.x + to.x) / 2 - at.position.x;
    const mz = (from.z + to.z) / 2 - at.position.z;
    if (mx * mx + mz * mz > 4) continue;
    const box = (truck.size ??= sizeOf(at));
    const c = Math.cos(-at.rotation.y);
    const s = Math.sin(-at.rotation.y);
    const local = (p: { x: number; z: number }): [number, number] => {
      const dx = p.x - at.position.x;
      const dz = p.z - at.position.z;
      return [dx * c + dz * s, -dx * s + dz * c];
    };
    const [fa, fb] = local(from);
    const [ta, tb] = local(to);
    // Whether a way crosses it (Liang-Barsky), kept a body's width off.
    const pad = 0.06;
    const through = ([fa, fb]: number[], [ta, tb]: number[], a0: number, a1: number) => {
      let lo = 0;
      let hi = 1;
      const clip = (p: number, q: number) => {
        if (p === 0) return q > 0;
        const r = q / p;
        if (p < 0) lo = Math.max(lo, r);
        else hi = Math.min(hi, r);
        return lo < hi;
      };
      return (
        clip(-(ta - fa), fa - a0) &&
        clip(ta - fa, a1 - fa) &&
        clip(-(tb - fb), fb - (box.min.z - pad)) &&
        clip(tb - fb, box.max.z + pad - fb) &&
        hi - lo > 1e-3
      );
    };
    // Through it, or across the ground ahead of its cab; but people walk
    // past the front of a pickup standing at the roadside to load.
    const front = box.max.x + pad;
    const clear = truck.view.pickup ? 0 : FRONT_CLEAR;
    const ahead = (a: number, b: number) =>
      a > front && a < front + clear && b > box.min.z - pad && b < box.max.z + pad;
    const crosses = (f: number[], t: number[]) =>
      through(f, t, box.min.x - pad, front) ||
      (clear > 0 &&
        !(ahead(f[0], f[1]) && ahead(t[0], t[1])) &&
        through(f, t, front, front + clear));
    if (!crosses([fa, fb], [ta, tb])) continue;
    const out = pad + 0.05;
    const corners: [number, number][] = [
      [box.min.x - out, box.min.z - out],
      [box.max.x + out, box.min.z - out],
      [box.max.x + out, box.max.z + out],
      [box.min.x - out, box.max.z + out],
    ];
    const near = (a: number, b: number) =>
      corners.reduce((k, p, i) => {
        const q = corners[k];
        return Math.hypot(p[0] - a, p[1] - b) < Math.hypot(q[0] - a, q[1] - b) ? i : k;
      }, 0);
    const i = near(fa, fb);
    const j = near(ta, tb);
    const ways = [1, 3].map((step) => {
      const path = [i];
      while (path[path.length - 1] !== j) path.push((path[path.length - 1] + step) % 4);
      return path;
    });
    const long = (path: number[]) =>
      length([
        { x: fa, z: fb },
        ...path.map((k) => ({ x: corners[k][0], z: corners[k][1] })),
        { x: ta, z: tb },
      ]);
    // Never from one front corner to the other, past the cab.
    const pastFront = (path: number[]) =>
      !truck.view.pickup &&
      path.some((k, n) => n > 0 && k + path[n - 1] === 3 && k !== 0 && k !== 3);
    const [p, q] = ways;
    const best =
      pastFront(p) !== pastFront(q) ? (pastFront(p) ? q : p) : long(p) <= long(q) ? p : q;
    // Only the corners it has to go by.
    while (best.length > 1 && !crosses(corners[best[best.length - 2]], [ta, tb])) best.pop();
    while (best.length > 1 && !crosses([fa, fb], corners[best[1]])) best.shift();
    return best.map((k) => {
      const [a, b] = corners[k];
      return { x: at.position.x + a * c - b * s, z: at.position.z + a * s + b * c };
    });
  }
  return [];
}

/** The trucks standing still, as the staff's grid keeps people and forklifts off them; see grid.ts. */
export function stillTrucks(site: TruckSite): StillTruck[] {
  const out: StillTruck[] = [];
  for (const truck of site.entries()) {
    if (truck.view.kind !== 'truck' || truck.view.moving) continue;
    const root = truck.model.root;
    const box = (truck.size ??= sizeOf(root));
    out.push({
      x: root.position.x,
      z: root.position.z,
      dir: -root.rotation.y,
      back: box.min.x,
      front: box.max.x,
      left: box.min.z,
      right: box.max.z,
      pickup: !!truck.view.pickup,
    });
  }
  return out;
}

/** How far a model reaches each way from its middle, unturned. */
export function sizeOf(root: Object3D): Box3 {
  const at = root.position.clone();
  const turn = root.rotation.y;
  root.position.set(0, 0, 0);
  root.rotation.y = 0;
  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(root);
  root.position.copy(at);
  root.rotation.y = turn;
  root.updateMatrixWorld(true);
  return box;
}
