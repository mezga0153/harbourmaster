import * as B from '../sim/balance';
import type { GameMap } from '../sim/map';
import {
  forkliftOnly,
  forkliftOnlyError,
  loadingSpots,
  machinesOnly,
  STORE_COST,
  storeError,
  truckReach,
  unmarkable,
  unmarkRefund,
} from '../sim/rules';
import { STORE_CODE } from '../sim/types';
import { STORE_TOOLS, type StoreTool } from '../ui/tools';
import { landNote } from './shared';
import type { PreviewResult } from './types';

// Marks on the port's roads and quays: storage areas, machines-only ground,
// and clearing marks.

/**
 * A drag that starts on an unmarked tile marks it machines only; one that
 * starts on a marked tile clears the mark.
 */
export function markingOn(map: GameMap, start: number): boolean {
  return !forkliftOnly(map, start);
}

/**
 * A drag that starts on a tile already marked out as this storage clears
 * it; any other marks it out.
 */
export function storingOn(map: GameMap, t: StoreTool, start: number): boolean {
  return map.store[start] !== STORE_CODE[STORE_TOOLS[t]];
}

/** Marking `tiles` machines only, or clearing them, as the drag from `start` says. */
export function previewMarking(map: GameMap, tiles: number[], start: number): PreviewResult {
  const on = markingOn(map, start);
  const ok = tiles.map((t) => !forkliftOnlyError(map, t));
  const changed = tiles.filter((t, k) => ok[k] && forkliftOnly(map, t) !== on).length;
  return {
    ghosts: { tiles, ok },
    arrow: null,
    hints: [],
    preview: {
      count: changed,
      rotatable: false,
      value: -changed * B.FORKLIFT_ONLY_COST,
      error: ok.some(Boolean) ? null : forkliftOnlyError(map, tiles[0]),
      note: ok.some(Boolean) ? landNote(map, tiles, ok) : undefined,
    },
  };
}

/** What a drag of the Unmark tool would clear, and give back. */
export function previewUnmark(map: GameMap, tiles: number[]): PreviewResult {
  const ok = tiles.map((t) => {
    const what = unmarkable(map, t);
    return what.store || what.machines || what.road || what.parking;
  });
  const count = ok.filter(Boolean).length;
  const near = tiles.some((t) => machinesOnly(map, t) && !forkliftOnly(map, t));
  return {
    ghosts: { tiles, ok },
    arrow: null,
    hints: [],
    preview: {
      count,
      rotatable: false,
      value: tiles.reduce((n, t, k) => n + (ok[k] ? unmarkRefund(map, t) : 0), 0),
      error:
        count > 0
          ? null
          : near
            ? 'The ground round a crane is always kept for port machines'
            : 'Nothing marked out here',
    },
  };
}

/** Marking `tiles` out as storage, or clearing them, as the drag from `start` says. */
export function previewStore(
  map: GameMap,
  t: StoreTool,
  tiles: number[],
  start: number,
): PreviewResult {
  const kind = STORE_TOOLS[t];
  const on = storingOn(map, t, start);
  const ok = tiles.map((i) => !storeError(map, i, kind, on));
  const count = ok.filter(Boolean).length;
  const each = on ? -STORE_COST[kind] : Math.floor(STORE_COST[kind] * B.BULLDOZE_REFUND);
  // Where trucks would stand to load, beside what is being marked out.
  const marked = tiles.filter((_, k) => ok[k]);
  const spots = on && count > 0 ? loadingSpots(map, marked, truckReach(map)) : [];
  const note =
    !on || count === 0
      ? undefined
      : spots.length > 0
        ? 'Trucks load from the yellow tiles beside it'
        : kind === 'crates'
          ? 'Trucks cannot get beside it: forklifts will take its crates on. Trucks load from a port road or quay beside it, through a port gate'
          : 'Trucks cannot get beside it: they load from a port road or quay beside it, through a port gate, off machines-only ground';
  return {
    ghosts: { tiles, ok },
    arrow: null,
    hints: [{ kind: 'spot', tiles: spots }],
    preview: {
      count,
      rotatable: false,
      value: count * each,
      error: count > 0 ? null : storeError(map, tiles[0], kind, on),
      note: count > 0 ? (landNote(map, tiles, ok) ?? note) : note,
    },
  };
}
