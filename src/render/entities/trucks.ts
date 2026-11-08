import { Box3, Vector3, type Object3D } from 'three';
import type { HandAt } from '../../protocol';
import type { GameMap } from '../../sim/map';
import type { Entry } from './entry';
import type { StillTruck } from './grid';
import { solidBounds } from '../util/mesh';

// The trucks standing still, for the dockhands and forklifts drawn about
// them: a truck bay's frame, whether a point is in a truck, and how big each
// truck is drawn.

/** How far in front of a dockhand the crate they pick up or set down is. */
export const HAND_REACH = 0.16;
/** Furthest a dockhand leans out over the edge to a crate. */
export const LEAN_MOST = 0.3;

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

/** How far ahead of a truck standing still people keep out of, going round by its back instead. */
export const FRONT_CLEAR = 0.5;

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
  const box = solidBounds(root);
  root.position.copy(at);
  root.rotation.y = turn;
  root.updateMatrixWorld(true);
  return box;
}
