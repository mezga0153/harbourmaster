import * as B from './balance';
import type { GameMap } from './map';
import { Build, Deco, isBay, isDock, Terrain, type BuildCode, type BuildKind } from './types';

export interface Buildable {
  code: BuildCode;
  label: string;
  cost: number;
  hint: string;
  /** Placed by dragging a line rather than single clicks. */
  drag: boolean;
}

export const BUILDABLES: Record<BuildKind, Buildable> = {
  road: {
    code: Build.Road,
    label: 'Public road',
    cost: 20,
    hint: 'For the hauliers’ trucks. Port staff never use public roads',
    drag: true,
  },
  footpath: {
    code: Build.Footpath,
    label: 'Port path',
    cost: 5,
    hint: 'Dockhands and forklifts move on port paths, never on grass or public roads',
    drag: true,
  },
  forkliftLane: {
    code: Build.ForkliftLane,
    label: 'Forklift lane',
    cost: 10,
    hint: 'A port path for forklifts only, so they do not queue behind people on foot',
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
  depot: {
    code: Build.Depot,
    label: 'Forklift depot',
    cost: 1200,
    hint: `Houses ${B.DEPOT_SLOTS} forklifts. They refuel, get repaired and park here. Must touch a road, path or quay`,
    drag: false,
  },
  office: {
    code: Build.Office,
    label: 'Harbour office',
    cost: 1500,
    hint: `Coordinates berths. Needed for more than ${B.FREE_DOCKS} jetties or any quay; each office handles ${B.DOCKS_PER_OFFICE} docks. Must touch a port path or road`,
    drag: false,
  },
  harbourCrane: {
    code: Build.HarbourCrane,
    label: 'Harbour crane',
    cost: 9000,
    hint: `Lifts containers off feeder ships. Goes on a quay edge with quay behind it (2 wide). $${B.HARBOUR_CRANE_RUNNING_COST}/day to run`,
    drag: false,
  },
  breakHut: {
    code: Build.BreakHut,
    label: 'Break hut',
    cost: 250,
    hint: `Tired dockhands rest here, ${B.HUT_SLOTS} at a time`,
    drag: false,
  },
  largeBay: {
    code: Build.LargeBay,
    label: 'Large truck bay',
    cost: 900,
    hint: `Holds ${B.LARGE_BAY_CAPACITY} crates and takes the big 8-crate trucks. Must touch a public road`,
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
  if (kind === 'harbourCrane') {
    if (map.build[i] !== Build.Quay) return 'A harbour crane goes on a quay';
    const water = map.neighbors4(i).find((n) => map.ocean[n] === 1 && map.build[n] === Build.None);
    if (water === undefined) return 'Put the crane at the quay edge, next to open water';
    const bx = 2 * map.xOf(i) - map.xOf(water);
    const by = 2 * map.yOf(i) - map.yOf(water);
    const behind = map.inBounds(bx, by) ? map.build[map.idx(bx, by)] : Build.None;
    const quay = isDock(behind) && behind !== Build.Jetty;
    return quay ? null : 'A harbour crane needs quay behind it too (2 wide)';
  }
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
  if (
    (kind === 'truckBay' || kind === 'largeBay') &&
    !map.neighbors4(i).some((n) => map.build[n] === Build.Road)
  ) {
    return 'A truck bay must touch a public road';
  }
  if (kind === 'depot' && !map.neighbors4(i).some((n) => drivable(map.build[n]))) {
    return 'A forklift depot must touch a port path, forklift lane or quay';
  }
  if (
    kind === 'office' &&
    !map.neighbors4(i).some((n) => walkable(map.build[n]) || map.build[n] === Build.Road)
  ) {
    return 'A harbour office must touch a port path or road';
  }
  if (kind === 'breakHut' && !map.neighbors4(i).some((n) => walkable(map.build[n]))) {
    return 'A break hut must touch a port path, quay or truck bay';
  }
  return null;
}

/** Hard surfaces a forklift can drive on. */
/**
 * Port surfaces forklifts can drive on. Not public roads (those are for the
 * hauliers) and not wooden jetties (they cannot take the weight).
 */
export function drivable(code: number): boolean {
  return (
    code === Build.Footpath ||
    code === Build.ForkliftLane ||
    code === Build.Quay ||
    code === Build.JibCrane ||
    code === Build.HarbourCrane ||
    isBay(code) ||
    code === Build.Depot
  );
}

/** Port surfaces dockhands walk on. Never grass, beach or public roads. */
export function walkable(code: number): boolean {
  return (
    code === Build.Footpath ||
    code === Build.Jetty ||
    code === Build.Quay ||
    code === Build.JibCrane ||
    code === Build.HarbourCrane ||
    isBay(code) ||
    code === Build.BreakHut ||
    code === Build.Depot
  );
}

/** Forklifts are bought at, and live in, a forklift depot. */
export function machinePlacementError(map: GameMap, i: number): string | null {
  return map.build[i] === Build.Depot ? null : 'Click a forklift depot to buy a forklift there';
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
