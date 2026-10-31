import type { EntityView, ProblemView, Snapshot } from '../protocol';
import type { GameMap } from '../sim/map';
import { anchorOf } from '../sim/rules';
import { ownedByTown } from '../sim/town';
import { Build, isTownBuilding } from '../sim/types';
import type { Selection } from '../ui/store';

/** What the renderer found under the pointer, ahead of the tile itself. */
export interface Picked {
  /** A red mark over something wrong. */
  problem: ProblemView | null;
  /** A boat, truck, machine or dockhand. */
  entity: EntityView | null;
}

/**
 * What a click on tile `at` selects: the problem's mark first, to say what
 * is wrong, then whoever is there, then the building or area on the tile,
 * the town's ground or the railway; or nothing.
 */
export function selectionAt(
  map: GameMap | null,
  s: Snapshot | null,
  at: number | null,
  picked: Picked,
): Selection | null {
  const i = at !== null && map ? anchorOf(map, at) : at;
  if (picked.problem) return { type: picked.problem.type, idx: picked.problem.idx };
  if (picked.entity) return { type: 'entity', id: picked.entity.id };
  // A storage area is picked from any of its tiles.
  const store =
    i === null
      ? undefined
      : (s?.bays.find((b) => b.tiles?.includes(i)) ?? s?.yards.find((y) => y.tiles.includes(i)));
  if (store) return { type: 'warehouse' in store ? 'bay' : 'yard', idx: store.idx };
  if (i === null) return null;
  if (s?.bays.some((b) => b.idx === i)) return { type: 'bay', idx: i };
  if (s?.cranes.some((c) => c.idx === i)) return { type: 'crane', idx: i };
  if (s?.depots.some((d) => d.idx === i)) return { type: 'depot', idx: i };
  if (map?.build[i] === Build.Office || map?.build[i] === Build.HarbourHut) {
    return { type: 'office', idx: i, hut: map.build[i] === Build.HarbourHut };
  }
  if (map?.build[i] === Build.Parking) return { type: 'parking', idx: i };
  if (map?.build[i] === Build.YardGantry) return { type: 'yardGantry', idx: i };
  if (s?.yards.some((y) => y.idx === i)) return { type: 'yard', idx: i };
  if (map && (ownedByTown(map, i) || isTownBuilding(map.build[i]))) return { type: 'town' };
  if (map && (map.build[i] === Build.Rail || map.build[i] === Build.Crossing)) {
    return { type: 'railway' };
  }
  return null;
}
