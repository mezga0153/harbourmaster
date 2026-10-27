import * as B from './balance';
import type { GameMap } from './map';
import { Build, Deco, Terrain, type BuildCode, type BuildKind } from './types';

export interface Buildable {
  code: BuildCode;
  label: string;
  cost: number;
  hint: string;
  /** Placed by dragging a line rather than single clicks. */
  drag: boolean;
}

export const BUILDABLES: Record<BuildKind, Buildable> = {
  road: { code: Build.Road, label: 'Road', cost: 20, hint: 'Trucks drive on roads', drag: true },
  footpath: {
    code: Build.Footpath,
    label: 'Footpath',
    cost: 5,
    hint: 'Dockhands walk faster on paths',
    drag: true,
  },
  jetty: {
    code: Build.Jetty,
    label: 'Jetty',
    cost: 100,
    hint: 'Wooden pier. Boats moor alongside',
    drag: true,
  },
  breakHut: {
    code: Build.BreakHut,
    label: 'Break hut',
    cost: 250,
    hint: `Tired dockhands rest here, ${B.HUT_SLOTS} at a time`,
    drag: false,
  },
  truckBay: {
    code: Build.TruckBay,
    label: 'Truck bay',
    cost: 300,
    hint: 'Crates are stacked here for trucks. Must touch a road',
    drag: false,
  },
};

export function kindOfCode(code: number): BuildKind | null {
  for (const [kind, def] of Object.entries(BUILDABLES)) {
    if (def.code === code) return kind as BuildKind;
  }
  return null;
}

/**
 * Static placement check. `pending` holds tiles of the same kind already
 * queued in the same drag, so a jetty can be dragged out from the shore.
 */
export function placementError(
  map: GameMap,
  kind: BuildKind,
  i: number,
  pending?: ReadonlySet<number>,
): string | null {
  if (map.build[i] !== Build.None) return 'Something is already built here';
  const t = map.terrain[i];

  if (kind === 'jetty') {
    if (t !== Terrain.Water) return 'Jetties are built on water';
    if (!map.ocean[i]) return 'This water is not connected to the sea';
    if (map.depth[i] > B.MAX_JETTY_DEPTH) return 'Too deep for a wooden jetty';
    const connected = map
      .neighbors4(i)
      .some((n) => map.isLand(n) || map.build[n] === Build.Jetty || pending?.has(n));
    return connected ? null : 'A jetty must connect to the shore or another jetty';
  }

  if (t === Terrain.Water) return 'Must be built on land';
  if (t === Terrain.Rock) return 'Rock is in the way';
  if (kind === 'truckBay' && !map.neighbors4(i).some((n) => map.build[n] === Build.Road)) {
    return 'A truck bay must touch a road';
  }
  return null;
}

export function placementCost(map: GameMap, kind: BuildKind, i: number): number {
  return BUILDABLES[kind].cost + (map.deco[i] === Deco.Tree ? B.TREE_CLEAR_COST : 0);
}

export function bulldozeError(map: GameMap, i: number): string | null {
  const empty = map.build[i] === Build.None && map.deco[i] === Deco.None;
  if (empty && map.terrain[i] !== Terrain.Rock) return 'Nothing to clear';
  if (i === map.entry) return 'The main road cannot be removed';
  return null;
}

/** Money gained (positive) or spent (negative) by bulldozing a tile. */
export function bulldozeValue(map: GameMap, i: number): number {
  const kind = kindOfCode(map.build[i]);
  if (kind) return Math.floor(BUILDABLES[kind].cost * B.BULLDOZE_REFUND);
  if (map.deco[i] === Deco.Tree) return -B.TREE_CLEAR_COST;
  return map.terrain[i] === Terrain.Rock ? -B.ROCK_CLEAR_COST : 0;
}
