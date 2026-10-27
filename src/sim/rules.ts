import * as B from './balance';
import type { GameMap } from './map';
import { Build, Deco, isDock, Terrain, type BuildCode, type BuildKind } from './types';

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
  quay: {
    code: Build.Quay,
    label: 'Quay',
    cost: B.QUAY_COST_LAND,
    hint: `Concrete wharf on the shore or in water up to ${B.MAX_QUAY_DEPTH} m. Forklifts can drive on it`,
    drag: true,
  },
  jibCrane: {
    code: Build.JibCrane,
    label: 'Jib crane',
    cost: 2500,
    hint: `Goes on a quay. Lifts crates off moored boats onto the quay. $${B.CRANE_RUNNING_COST}/day to run`,
    drag: false,
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
  const t = map.terrain[i];
  if (kind === 'jibCrane') {
    if (map.build[i] !== Build.Quay) return 'A jib crane goes on a quay';
    const atWater = map
      .neighbors4(i)
      .some((n) => map.ocean[n] === 1 && map.build[n] === Build.None);
    return atWater ? null : 'Put the crane at the quay edge, next to open water';
  }
  if (map.build[i] !== Build.None) return 'Something is already built here';

  if (kind === 'quay') {
    const nearWater = map.neighbors4(i).some((n) => map.ocean[n] === 1);
    if (t === Terrain.Sand || t === Terrain.Grass) {
      return nearWater ? null : 'On land, a quay goes along the water’s edge';
    }
    if (t !== Terrain.Water) return 'Rock is in the way';
    if (!map.ocean[i]) return 'This water is not connected to the sea';
    if (map.depth[i] > B.MAX_QUAY_DEPTH)
      return `Too deep, even for a quay (max ${B.MAX_QUAY_DEPTH} m)`;
    const connected = map
      .neighbors4(i)
      .some((n) => map.isLand(n) || isDock(map.build[n]) || pending?.has(n));
    return connected ? null : 'A quay must connect to the shore or another quay';
  }

  if (kind === 'jetty') {
    // On the beach, right at the water's edge, boats can moor alongside.
    if (t === Terrain.Sand) {
      const atWater = map.neighbors4(i).some((n) => map.ocean[n] === 1);
      return atWater ? null : 'On land, jetties go on the beach at the water’s edge';
    }
    if (t !== Terrain.Water) return 'Jetties are built on water or at the edge of the beach';
    if (!map.ocean[i]) return 'This water is not connected to the sea';
    if (map.depth[i] > B.MAX_JETTY_DEPTH) return 'Too deep for a wooden jetty';
    const connected = map
      .neighbors4(i)
      .some((n) => map.isLand(n) || isDock(map.build[n]) || pending?.has(n));
    return connected ? null : 'A jetty must connect to the shore or another jetty';
  }

  if (t === Terrain.Water) return 'Must be built on land';
  if (t === Terrain.Rock) return 'Rock is in the way';
  if (kind === 'truckBay' && !map.neighbors4(i).some((n) => map.build[n] === Build.Road)) {
    return 'A truck bay must touch a road';
  }
  return null;
}

/** Forklifts are put down on the hard surfaces they can drive on. */
export function machinePlacementError(map: GameMap, i: number): string | null {
  const b = map.build[i];
  const paved =
    b === Build.Footpath ||
    b === Build.Quay ||
    b === Build.JibCrane ||
    b === Build.Road ||
    b === Build.TruckBay;
  return paved ? null : 'Put a forklift on a quay, path, road or truck bay';
}

export function placementCost(map: GameMap, kind: BuildKind, i: number): number {
  const base = kind === 'quay' && !map.isLand(i) ? B.QUAY_COST_WATER : BUILDABLES[kind].cost;
  return base + (map.deco[i] === Deco.Tree ? B.TREE_CLEAR_COST : 0);
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
  if (kind === 'quay') return Math.floor(placementCost(map, 'quay', i) * B.BULLDOZE_REFUND);
  if (kind) return Math.floor(BUILDABLES[kind].cost * B.BULLDOZE_REFUND);
  if (map.deco[i] === Deco.Tree) return -B.TREE_CLEAR_COST;
  return map.terrain[i] === Terrain.Rock ? -B.ROCK_CLEAR_COST : 0;
}
