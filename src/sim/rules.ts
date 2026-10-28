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
    hint: 'For dockhands on foot. Staff never walk on grass or public roads. Forklifts need a port road or quay',
    drag: true,
  },
  portRoad: {
    code: Build.PortRoad,
    label: 'Port road',
    cost: 25,
    hint: 'Paved road for forklifts and dockhands alike. Build over a port path to upgrade it',
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
    hint: `Concrete wharf on the shore or in water up to ${B.MAX_QUAY_DEPTH} m. Forklifts can drive on it. Build over a jetty, from its shore end, to upgrade it`,
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
    hint: `Houses ${B.DEPOT_SLOTS} forklifts. They refuel, get repaired and park here. The door faces a port road or quay`,
    drag: false,
  },
  office: {
    code: Build.Office,
    label: 'Harbour office',
    cost: 1500,
    hint: `Coordinates berths. Needed for more than ${B.FREE_DOCKS} jetties or any quay; each office handles ${B.DOCKS_PER_OFFICE} docks. The door faces a port path or road`,
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
  containerYard: {
    code: Build.Yard,
    label: 'Container yard',
    cost: 2500,
    hint: `Stacks up to ${B.YARD_BOXES} containers off the ships until there is room in a large truck bay. Reach stackers move them. 2×2; the gate faces a port road or quay`,
    drag: false,
  },
  largeBay: {
    code: Build.LargeBay,
    label: 'Large truck bay',
    cost: 900,
    hint: `Holds ${B.LARGE_BAY_CAPACITY} crates and takes the big 8-crate trucks. Two tiles wide; the entrance faces a public road`,
    drag: false,
  },
  truckBay: {
    code: Build.TruckBay,
    label: 'Truck bay',
    cost: 300,
    hint: 'Crates are stacked here for trucks. The entrance faces a public road',
    drag: false,
  },
};

/** Buildings with a front door, placed facing one of four ways. */
export const ROTATABLE: ReadonlySet<BuildKind> = new Set([
  'truckBay',
  'largeBay',
  'containerYard',
  'depot',
  'office',
  'breakHut',
]);

/** Marks the other tiles of a multi-tile building in `GameMap.orient`. */
export const EXTENSION = 4;
/** Which part of a multi-tile building a tile is, in `GameMap.orient` bits 4–5. */
const PART_SHIFT = 4;
/** Marks a port road or quay tile that people on foot keep off. */
export const FORKLIFT_ONLY = 8;

export function forkliftOnly(map: GameMap, i: number): boolean {
  return (map.orient[i] & FORKLIFT_ONLY) !== 0;
}

/** Only port roads and plain quay can be marked forklift-only. */
export function forkliftOnlyError(map: GameMap, i: number): string | null {
  const b = map.build[i];
  return b === Build.PortRoad || b === Build.Quay
    ? null
    : 'Only port roads and quays can be forklift-only';
}

/** Step towards the front for facing 0 (+x), 1 (+y), 2 (-x), 3 (-y). */
export const FACING: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

function step(map: GameMap, i: number, dx: number, dy: number): number {
  const x = map.xOf(i) + dx;
  const y = map.yOf(i) + dy;
  return map.inBounds(x, y) ? map.idx(x, y) : -1;
}

/** The tile a building at `i` faces. */
export function frontOf(map: GameMap, i: number, facing: number): number {
  const [dx, dy] = FACING[facing & 3];
  return step(map, i, dx, dy);
}

/**
 * Parts of multi-tile buildings, as (right, forward) steps from the main
 * tile when looking out of the front. A large truck bay is two wide along
 * the road: the truck pulls into the first tile and the cargo sits on the
 * second. A container yard is 2×2 behind its gate.
 */
const PARTS: Partial<Record<BuildKind, readonly (readonly [number, number])[]>> = {
  largeBay: [
    [0, 0],
    [1, 0],
  ],
  containerYard: [
    [0, 0],
    [1, 0],
    [0, -1],
    [1, -1],
  ],
};

function offset(map: GameMap, i: number, facing: number, right: number, fwd: number): number {
  const [dx, dy] = FACING[facing & 3];
  return step(map, i, right * dy + fwd * dx, -right * dx + fwd * dy);
}

/** Tiles a building covers, the main tile first; -1 off the map. */
export function footprint(map: GameMap, kind: BuildKind, i: number, facing: number): number[] {
  const parts = PARTS[kind];
  if (!parts) return [i];
  return parts.map(([r, f]) => offset(map, i, facing, r, f));
}

/** `GameMap.orient` for part `k` of a building facing `facing`. */
export function partOrient(facing: number, k: number): number {
  return k === 0 ? facing : facing | EXTENSION | (k << PART_SHIFT);
}

/** The main tile of the building covering `i`. */
export function anchorOf(map: GameMap, i: number): number {
  const o = map.orient[i];
  if (!(o & EXTENSION)) return i;
  const kind = kindOfCode(map.build[i]);
  const parts = kind && PARTS[kind];
  if (!parts) return i;
  // Saves from before yards marked a large bay's second tile without a part.
  const [r, f] = parts[(o >> PART_SHIFT) & 3 || 1];
  return offset(map, i, o, -r, -f);
}

/** The first way a building can face here, or 0 when none works. */
export function bestFacing(
  map: GameMap,
  kind: BuildKind,
  i: number,
  pending?: ReadonlySet<number>,
): number {
  if (!ROTATABLE.has(kind)) return 0;
  for (let f = 0; f < 4; f++) if (!placementError(map, kind, i, pending, f)) return f;
  return 0;
}

export function kindOfCode(code: number): BuildKind | null {
  for (const [kind, def] of Object.entries(BUILDABLES)) {
    if (def.code === code) return kind as BuildKind;
  }
  return null;
}

/**
 * Static placement check. `pending` holds tiles of the same kind already
 * queued in the same drag, so a jetty can be dragged out from the shore.
 * Buildings face `facing`; left out, any way that works will do.
 */
export function placementError(
  map: GameMap,
  kind: BuildKind,
  i: number,
  pending?: ReadonlySet<number>,
  facing: number = bestFacing(map, kind, i, pending),
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
  // A jetty can be paved over into a quay and a port path into a port road;
  // nothing else is built over.
  const upgrade =
    (kind === 'quay' && map.build[i] === Build.Jetty) ||
    (kind === 'portRoad' && map.build[i] === Build.Footpath);
  if (map.build[i] !== Build.None && !upgrade) return 'Something is already built here';

  if (kind === 'quay') {
    const nearWater = map.neighbors4(i).some((n) => map.ocean[n] === 1);
    if (t === Terrain.Sand || t === Terrain.Grass) {
      return nearWater ? null : 'On land, a quay goes along the water’s edge';
    }
    if (t !== Terrain.Water) return 'Rock is in the way';
    if (!map.ocean[i]) return 'This water is not connected to the sea';
    if (map.depth[i] > B.MAX_QUAY_DEPTH)
      return `Too deep, even for a quay (max ${B.MAX_QUAY_DEPTH} m)`;
    // Concrete grows out from the shore: never off the end of a wooden jetty,
    // so a jetty is upgraded starting where it meets the land.
    const connected = map
      .neighbors4(i)
      .some(
        (n) =>
          pending?.has(n) ||
          (map.build[n] !== Build.Jetty && (map.isLand(n) || isDock(map.build[n]))),
      );
    if (connected) return null;
    return upgrade
      ? 'Upgrade a jetty to quay from its shore end first'
      : 'A quay must connect to the shore or another quay, not a jetty';
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
  const clear = (n: number) =>
    n >= 0 &&
    map.build[n] === Build.None &&
    map.terrain[n] !== Terrain.Water &&
    map.terrain[n] !== Terrain.Rock &&
    !pending?.has(n);
  if (!footprint(map, kind, i, facing).slice(1).every(clear)) {
    return kind === 'largeBay'
      ? 'A large truck bay is two tiles wide: clear the tile beside it'
      : 'A container yard needs 2×2 clear tiles behind its gate';
  }
  if (!ROTATABLE.has(kind)) return null;
  const front = frontOf(map, i, facing);
  const f = front >= 0 ? map.build[front] : Build.None;
  if (kind === 'truckBay' || kind === 'largeBay') {
    return f === Build.Road ? null : 'The entrance must face a public road';
  }
  if (kind === 'depot') {
    return drivable(f) ? null : 'The garage door must face a port road or quay';
  }
  if (kind === 'containerYard') {
    return drivable(f) ? null : 'The gate must face a port road or quay';
  }
  if (kind === 'office') {
    const ok = walkableAt(map, front) || f === Build.Road;
    return ok ? null : 'The door must face a port path or road';
  }
  return walkableAt(map, front) ? null : 'The door must face a port path, quay or truck bay';
}

/**
 * Port surfaces forklifts can drive on: port roads and quays, including
 * those marked forklift-only. Not port paths
 * (those are for people on foot), public roads (for the hauliers) or wooden
 * jetties (they cannot take the weight).
 */
export function drivable(code: number): boolean {
  return (
    code === Build.PortRoad ||
    code === Build.Quay ||
    code === Build.JibCrane ||
    code === Build.HarbourCrane ||
    isBay(code) ||
    code === Build.Depot ||
    code === Build.Yard
  );
}

/** Walkable here, and not marked forklift-only. */
export function walkableAt(map: GameMap, i: number): boolean {
  return i >= 0 && walkable(map.build[i]) && !forkliftOnly(map, i);
}

/** Every tile a machine at `start` can drive to. */
export function driveNetwork(map: GameMap, start: number): Set<number> {
  const seen = new Set<number>([start]);
  const queue = [start];
  while (queue.length > 0) {
    for (const n of map.neighbors4(queue.pop()!)) {
      if (seen.has(n) || !drivable(map.build[n])) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}

/** Port surfaces dockhands walk on. Never grass, beach or public roads. */
export function walkable(code: number): boolean {
  return (
    code === Build.Footpath ||
    code === Build.PortRoad ||
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
  // Upgrading: what is there already is worth what bulldozing it would pay.
  const old = kindOfCode(map.build[i]);
  const credit =
    (kind === 'quay' && old === 'jetty') || (kind === 'portRoad' && old === 'footpath')
      ? Math.floor(BUILDABLES[old].cost * B.BULLDOZE_REFUND)
      : 0;
  return base - credit + (map.deco[i] === Deco.Tree ? B.TREE_CLEAR_COST : 0);
}

/** Tiles cleared by bulldozing `i`: the whole building it is part of. */
export function bulldozeTiles(map: GameMap, i: number): number[] {
  const kind = kindOfCode(map.build[i]);
  if (!kind || !ROTATABLE.has(kind)) return [i];
  const a = anchorOf(map, i);
  return footprint(map, kind, a, map.orient[a]);
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
