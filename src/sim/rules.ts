import * as B from './balance';
import type { GameMap } from './map';
import type { CostFn } from './path';
import {
  canBeOneWay,
  flowOk,
  HIGHWAY_COLUMNS,
  LIGHTS,
  linked,
  ONE_WAY,
  GATE_IN,
  GATE_OUT,
  hasHighway,
  highwayIns,
  isExit,
  isHighway,
  oneWay,
} from './roads';
import { ownedByTown } from './town';
import {
  Build,
  Deco,
  isBay,
  isBuoy,
  isCrane,
  isDock,
  isPublicRoad,
  isTownBuilding,
  STORE_CODE,
  storesBoxes,
  Terrain,
  type BuildCode,
  type BuildKind,
  type StoreKind,
} from './types';

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
    hint: `Goes on a quay edge. Lifts crates off moored boats, straight into crate storage up to ${B.JIB_REACH} tiles away, or else onto the quay for forklifts and dockhands. Boats would rather berth under one, and wait for one when there are no dockhands. The 3×3 round a crane is for port machines only: no dockhands, no hauliers' trucks. $${B.CRANE_RUNNING_COST}/day to run`,
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
    hint: `Lifts containers off feeder ships. Goes on a quay edge with quay behind it (2 wide). The 3×3 round it is for port machines only. $${B.HARBOUR_CRANE_RUNNING_COST}/day to run`,
    drag: false,
  },
  gantryCrane: {
    code: Build.Gantry,
    label: 'Gantry crane',
    cost: B.GANTRY_COST,
    hint: `Ship-to-shore crane: lifts containers off feeder ships three times as fast as a harbour crane and sets them down along the quay at the shipside, the length of its rails, ${B.GANTRY_STACK} at most, where reach stackers collect them from behind and it lifts them onto terminal tractors under it, never the hauliers' trucks. 2×2 on quay, two tiles along the quay edge facing open water. It runs on rails along the quay to each bay of the ship in turn, so it needs ${B.GANTRY_RAILS} tiles of clear quay edge, the length of a ship, kept for its rails, and the ground a tile round them is for port machines only. Put two side by side along one berth and they share the rails and the ship out between them, working it twice as fast. $${B.GANTRY_RUNNING_COST}/day to run`,
    drag: false,
  },
  tugBerth: {
    code: Build.TugBerth,
    label: 'Tug berth',
    cost: B.TUG_BERTH_COST,
    hint: `A berth in the water beside a jetty or quay, where one harbour tug lies; buy the tug from the Machines tab. Without a tug, coasters and feeders swing round, come alongside and pull out slowly. A tug sails out to meet them and works them in and out`,
    drag: false,
  },
  yardGantry: {
    code: Build.YardGantry,
    label: 'Yard gantry',
    cost: B.YARD_GANTRY_COST,
    hint: `Spans a container yard from a port road or quay tile beside it, and loads and unloads the trucks there itself; they drive in under it. Without one, reach stackers must lift every container on and off the trucks too, one at a time. $${B.YARD_GANTRY_RUNNING_COST}/day to run`,
    drag: false,
  },
  breakHut: {
    code: Build.BreakHut,
    label: 'Break hut',
    cost: 250,
    hint: `Tired dockhands rest here, ${B.HUT_SLOTS} at a time`,
    drag: false,
  },
  parking: {
    code: Build.Parking,
    label: 'Truck parking',
    cost: B.PARKING_COST,
    hint: 'Marked out on a road you have built: drag over a strip of it one or two tiles wide, with road left all along both its long sides. Trucks drive in off one side, park at an angle across the strip, one to each space along it, and drive out the other side: always forwards. Big trucks need two tiles. On public road it is outside the port: shippers\u2019 trucks wait there for their paperwork. On port road it is inside, behind a port gate: trucks queue there for a free loading spot. Unmark it to have the road back',
    drag: true,
  },
  portGate: {
    code: Build.Gate,
    label: 'Port gate',
    cost: 400,
    hint: 'Lets the hauliers’ trucks into the port: they turn in off the public road at the front and drive on port roads to truck bays and container yards inside. Staff never leave through it',
    drag: false,
  },
  buoyIn: {
    code: Build.BuoyIn,
    label: 'Buoy: way in',
    cost: B.BUOY_COST,
    hint: 'Green buoys mark the way into the port. Place them in pairs: boats come in from the sea beyond the outermost pair and cross between each pair in turn, towards the docks, well clear of the buoys. An odd one out they sail close past',
    drag: true,
  },
  buoyOut: {
    code: Build.BuoyOut,
    label: 'Buoy: way out',
    cost: B.BUOY_COST,
    hint: 'Red buoys mark the way out to sea. Place them in pairs: boats leaving cross between each pair in turn, away from the docks, well clear of the buoys, so they keep clear of boats coming in. An odd one out they sail close past',
    drag: true,
  },
  largeBay: {
    code: Build.LargeBay,
    label: 'Large truck bay',
    cost: 900,
    hint: `Holds ${B.LARGE_BAY_CAPACITY} crates, loads trucks quicker than a truck bay and takes the big 8-crate trucks. Two tiles wide; the entrance faces a public road, or a port road behind a port gate`,
    drag: false,
  },
  truckBay: {
    code: Build.TruckBay,
    label: 'Truck bay',
    cost: 300,
    hint: `Holds ${B.BAY_CAPACITY} crates, loaded onto trucks by hand, one truck at a time. The entrance faces a public road, or a port road behind a port gate`,
    drag: false,
  },
};

/** Buildings with a front door, placed facing one of four ways. */
export const ROTATABLE: ReadonlySet<BuildKind> = new Set([
  'truckBay',
  'largeBay',
  'portGate',
  'depot',
  'office',
  'breakHut',
  'gantryCrane',
]);

/** Marks the other tiles of a multi-tile building in `GameMap.orient`. */
export const EXTENSION = 4;
/** Which part of a multi-tile building a tile is, in `GameMap.orient` bits 4–5. */
const PART_SHIFT = 4;
/**
 * Marks a port road or quay tile for port machines only: people on foot and
 * the hauliers' trucks keep off.
 */
export const FORKLIFT_ONLY = 8;
/** Marks a building tile standing on a quay, which it leaves behind. */
export const ON_QUAY = 64;

export function forkliftOnly(map: GameMap, i: number): boolean {
  return (map.orient[i] & FORKLIFT_ONLY) !== 0;
}

/** Shown for the country past the port's land. */
export const OUTSIDE = 'Beyond the port’s land';

/** Only port roads and plain quay can be marked for port machines only. */
export function forkliftOnlyError(map: GameMap, i: number): string | null {
  if (!map.buildable(i)) return OUTSIDE;
  if (forkliftOnly(map, i) && gantryOver(map, i, true) >= 0) {
    return 'Kept for port machines round a gantry crane’s rails';
  }
  const b = map.build[i];
  return b === Build.PortRoad || b === Build.Quay
    ? null
    : 'Only port roads and quays can be marked for port machines only';
}

/**
 * Kept for the port's machines: marked so, or round a crane. People on foot
 * and the hauliers' trucks keep off.
 */
export function machinesOnly(map: GameMap, i: number): boolean {
  const b = map.build[i];
  const paved = b === Build.PortRoad || b === Build.Quay || isCrane(b);
  return paved && (forkliftOnly(map, i) || nearCrane(map, i));
}

/** What marking out storage costs a tile. */
export const STORE_COST: Record<StoreKind, number> = {
  crates: B.CRATE_STORE_COST,
  boxes: B.BOX_STORE_COST,
  cratesOut: B.CRATE_STORE_COST,
  boxesOut: B.BOX_STORE_COST,
};

export const STORE_TIER: Record<StoreKind, number> = {
  crates: B.CRATE_STORE_TIER,
  boxes: B.BOX_STORE_TIER,
  cratesOut: B.CRATE_STORE_TIER,
  boxesOut: B.BOX_STORE_TIER,
};

export const STORE_LABEL: Record<StoreKind, string> = {
  crates: 'Crate storage, in',
  boxes: 'Container yard, in',
  cratesOut: 'Crate storage, out',
  boxesOut: 'Container yard, out',
};

export function storeKindAt(map: GameMap, i: number): StoreKind | null {
  const s = map.store[i];
  for (const [kind, code] of Object.entries(STORE_CODE)) if (code === s) return kind as StoreKind;
  return null;
}

/** Whether a tile can be marked out as storage, or cleared of it, with `on` false. */
export function storeError(map: GameMap, i: number, kind: StoreKind, on: boolean): string | null {
  if (!map.buildable(i)) return OUTSIDE;
  const code = STORE_CODE[kind];
  if (!on)
    return map.store[i] === code ? null : `Not marked out as ${STORE_LABEL[kind].toLowerCase()}`;
  if (map.store[i] === code) return 'Already marked out';
  if (map.store[i]) return 'Marked out for other storage: clear that first';
  if (gantryOver(map, i) >= 0) return 'Kept clear for a gantry crane’s rails';
  const b = map.build[i];
  return b === Build.PortRoad || b === Build.Quay
    ? null
    : 'Storage is marked out on port roads and quays';
}

/**
 * What the Unmark tool takes off a tile: its storage, and its mark for port
 * machines only, but never the ground kept for machines round a crane or a
 * gantry crane's rails. With what clearing the storage gives back.
 */
export function unmarkable(
  map: GameMap,
  i: number,
): { store: boolean; machines: boolean; road: boolean; parking: boolean } {
  if (!map.buildable(i)) return { store: false, machines: false, road: false, parking: false };
  return {
    store: map.store[i] !== 0,
    machines: forkliftOnly(map, i) && gantryOver(map, i, true) < 0,
    // One way, or traffic lights: back to a plain road.
    road: canBeOneWay(map.build[i]) && (map.orient[i] & (ONE_WAY | LIGHTS)) !== 0,
    // Parking marked out on a road: the road again.
    parking: map.build[i] === Build.Parking,
  };
}

/** On a parking tile, in `GameMap.orient`: it is marked out on port road, not public road. */
export const ON_PORT_ROAD = 16;

/**
 * The road a parking tile is marked out on, which it is again once
 * unmarked: as it was marked; for parking laid before it was marked out on
 * roads, port road inside the port, public road outside.
 */
export function roadUnderParking(map: GameMap, i: number): BuildCode {
  if (map.orient[i] & ON_PORT_ROAD) return Build.PortRoad;
  const near = map.neighbors4(i).map((n) => map.build[n]);
  const port = near.some((b) => b === Build.PortRoad || b === Build.Quay);
  return port && !near.some((b) => isPublicRoad(b)) ? Build.PortRoad : Build.Road;
}

/** Why truck parking cannot be marked out on tile `i`, or null. */
function parkingError(map: GameMap, i: number): string | null {
  const b = map.build[i];
  if (b === Build.Parking) return 'This is marked out for parking already';
  if (b !== Build.Road && b !== Build.PortRoad)
    return 'Parking is marked out on a public road or port road: build the road first';
  if (map.store[i]) return 'Clear the storage marked out here first';
  if (forkliftOnly(map, i)) return 'Kept for port machines: clear the mark first';
  if (nearCrane(map, i)) return 'The ground round a crane is kept for port machines';
  return null;
}

/** Why tile `i` cannot be made one way, or null. */
export function oneWayError(map: GameMap, i: number): string | null {
  if (!map.buildable(i)) return OUTSIDE;
  const b = map.build[i];
  if (isHighway(b)) return 'The highway is one way each side already';
  if (!canBeOneWay(b)) return 'Only public roads and port roads can be made one way';
  if (ownedByTown(map, i)) return 'This belongs to the town';
  return null;
}

/**
 * Whether trucks meet other traffic at tile `i`, given how they drive
 * (`road`): three or four ways off it, other than inside a block of road
 * two wide, which is open ground.
 */
export function junctionAt(map: GameMap, i: number, road: CostFn = truckCost(map)): boolean {
  if (!Number.isFinite(road(i))) return false;
  const ways = map.neighbors4(i).filter((n) => Number.isFinite(road(n)) && linked(map, i, n));
  if (ways.length < 3) return false;
  const ok = (x: number, y: number) =>
    map.inBounds(x, y) &&
    Number.isFinite(road(map.idx(x, y))) &&
    !isHighway(map.build[map.idx(x, y)]);
  const x = map.xOf(i);
  const y = map.yOf(i);
  return ![-1, 1].some((dx) =>
    [-1, 1].some((dy) => ok(x + dx, y) && ok(x, y + dy) && ok(x + dx, y + dy)),
  );
}

/** Why traffic lights cannot go up (or come down) at tile `i`, or null. */
export function lightsError(map: GameMap, i: number): string | null {
  if (!map.buildable(i)) return OUTSIDE;
  if (isHighway(map.build[i]))
    return 'Nobody waits on the highway: trucks out there pass through each other';
  if (!canBeOneWay(map.build[i])) return 'Traffic lights go at a road junction';
  if (ownedByTown(map, i)) return 'This belongs to the town';
  if (!junctionAt(map, i)) return 'Traffic lights go where three or four roads meet';
  return null;
}

/**
 * A roundabout's ring round its island, as steps from the island, each
 * with the way traffic goes on it: anticlockwise, keeping right, so the
 * island is always on the left.
 */
export const ROUNDABOUT_RING: readonly (readonly [number, number, number])[] = [
  [1, 1, 3],
  [1, 0, 3],
  [1, -1, 2],
  [0, -1, 2],
  [-1, -1, 1],
  [-1, 0, 1],
  [-1, 1, 0],
  [0, 1, 0],
];

/** Why a roundabout cannot go round an island at `c`, or null. */
export function roundaboutError(map: GameMap, c: number): string | null {
  const cx = map.xOf(c);
  const cy = map.yOf(c);
  const tiles = [[0, 0], ...ROUNDABOUT_RING].map(([dx, dy]) => [cx + dx, cy + dy]);
  for (const [x, y] of tiles) {
    if (!map.inBounds(x, y) || !map.buildable(map.idx(x, y))) return OUTSIDE;
    const i = map.idx(x, y);
    const b = map.build[i];
    if (isHighway(b)) return 'Too near the highway';
    if (b === Build.Rail || b === Build.Crossing) return 'The railway is in the way';
    if (ownedByTown(map, i)) return 'This belongs to the town';
    if (b === Build.Road) continue;
    if (b !== Build.None) return 'A roundabout needs 3×3 of public road or clear land';
    if (!map.isLand(i)) return 'Must be built on land';
    if (map.terrain[i] === Terrain.Rock) return 'Rock is in the way';
  }
  return null;
}

/** What a roundabout round the island at `c` costs: the junction, and road where there is none. */
export function roundaboutCost(map: GameMap, c: number): number {
  let cost = B.ROUNDABOUT_COST;
  for (const [dx, dy] of ROUNDABOUT_RING) {
    const i = map.idx(map.xOf(c) + dx, map.yOf(c) + dy);
    if (map.build[i] === Build.None) cost += BUILDABLES.road.cost;
    if (map.deco[i] === Deco.Tree) cost += B.TREE_CLEAR_COST;
  }
  return cost;
}

/**
 * How far through a yard gantry's lift, as a share of it, the spreader has
 * the container up off where it was, and has it set down: half way through
 * taking it up and setting it down. `legs`: the lift's run along the rails
 * to it, taking it up, carrying it and setting it down, as shares of it;
 * without them, a lift with no running along the rails.
 */
export function liftMarks(legs?: readonly number[]): { taken: number; set: number } {
  const [run, up, carry, down] = legs && legs.length === 4 ? legs : [0, 0.5, 0, 0.5];
  return { taken: run + up / 2, set: run + up + carry + down / 2 };
}

/** Which way trucks may go through a port gate. */
export function gateWay(map: GameMap, i: number): 'both' | 'in' | 'out' {
  if (map.build[i] !== Build.Gate) return 'both';
  return map.orient[i] & GATE_IN ? 'in' : map.orient[i] & GATE_OUT ? 'out' : 'both';
}

export function unmarkRefund(map: GameMap, i: number): number {
  if (map.build[i] === Build.Parking) return Math.floor(B.PARKING_COST * B.BULLDOZE_REFUND);
  const kind = storeKindAt(map, i);
  return kind ? Math.floor(STORE_COST[kind] * B.BULLDOZE_REFUND) : 0;
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
 * second. A gantry crane stands on 2×2 of quay, its front two tiles on the
 * edge, facing the water, and the bay it sets containers down in behind.
 */
const PARTS: Partial<Record<BuildKind, readonly (readonly [number, number])[]>> = {
  largeBay: [
    [0, 0],
    [1, 0],
  ],
  gantryCrane: [
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

/**
 * The quay a gantry crane at `i` runs on: both rows of its rails along the
 * quay edge, the length of a container ship, centred on the crane.
 */
export function gantryRails(map: GameMap, i: number, facing: number): number[] {
  const out: number[] = [];
  const from = 1 - B.GANTRY_RAILS / 2;
  for (let r = from; r < from + B.GANTRY_RAILS; r++) {
    for (const f of [0, -1]) out.push(offset(map, i, facing, r, f));
  }
  return out;
}

/** A gantry crane's rails and the land a tile round them: kept for port machines. */
export function gantryGround(map: GameMap, i: number, facing: number): number[] {
  const out: number[] = [];
  const from = 1 - B.GANTRY_RAILS / 2;
  for (let r = from - 1; r <= from + B.GANTRY_RAILS; r++) {
    for (const f of [0, -1, -2]) {
      const t = offset(map, i, facing, r, f);
      if (t >= 0) out.push(t);
    }
  }
  return out;
}

/**
 * The gantry crane (its main tile) whose rails run over tile `i`, or with
 * `ground` whose ground round them takes it in; -1 if none.
 */
export function gantryOver(map: GameMap, i: number, ground = false): number {
  const reach = B.GANTRY_RAILS + 1;
  const x = map.xOf(i);
  const y = map.yOf(i);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      if (!map.inBounds(x + dx, y + dy)) continue;
      const g = map.idx(x + dx, y + dy);
      if (map.build[g] !== Build.Gantry || map.orient[g] & EXTENSION) continue;
      const tiles = (ground ? gantryGround : gantryRails)(map, g, map.orient[g] & 3);
      if (tiles.includes(i)) return g;
    }
  }
  return -1;
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
  if (!map.buildable(i)) return OUTSIDE;
  const t = map.terrain[i];
  if ((kind === 'harbourCrane' || kind === 'jibCrane') && map.store[i]) {
    return 'Clear the storage marked out here first';
  }
  if (kind === 'gantryCrane') {
    const tiles = footprint(map, kind, i, facing);
    const quay = (t: number) =>
      t >= 0 && map.buildable(t) && map.build[t] === Build.Quay && !map.store[t];
    if (!tiles.every(quay)) return 'A gantry crane stands on 2×2 of clear quay';
    const sea = (t: number) => {
      const n = frontOf(map, t, facing);
      return n >= 0 && map.ocean[n] === 1 && map.build[n] === Build.None;
    };
    if (!sea(tiles[0]) || !sea(tiles[1])) {
      return 'Put the gantry at the quay edge, its front two tiles facing open water';
    }
    // Its rails run the length of a ship along the edge: clear quay, or
    // another gantry crane sharing them.
    // The landward rail may run on port road behind the quay too.
    const rails = gantryRails(map, i, facing);
    const clear = (t: number) => quay(t) || (t >= 0 && map.build[t] === Build.Gantry);
    const paved = (t: number) =>
      clear(t) || (t >= 0 && map.build[t] === Build.PortRoad && !map.store[t]);
    const edge = rails.filter((_, k) => k % 2 === 0);
    const back = rails.filter((_, k) => k % 2 === 1);
    if (!edge.every(clear) || !back.every(paved) || !edge.every(sea)) {
      return `A gantry crane runs on rails along ${B.GANTRY_RAILS} tiles of clear quay edge, the length of a container ship: clear the quay either side of it`;
    }
    return null;
  }
  if (footprint(map, kind, i, facing).some((t) => t >= 0 && gantryOver(map, t) >= 0)) {
    return 'Kept clear for a gantry crane’s rails';
  }
  if (kind === 'yardGantry') {
    const paved = map.build[i] === Build.PortRoad || map.build[i] === Build.Quay;
    if (!paved || map.store[i]) return 'A yard gantry stands on port road or quay, beside a yard';
    const yard = map.neighbors4(i).some((n) => storesBoxes(map.store[n]));
    // Trucks still drive under it, to load, so it may stand where they do.
    return yard ? null : 'Put it beside a container yard: it spans the stacks to load the trucks';
  }
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
  if (ownedByTown(map, i)) return 'This belongs to the town';
  if (isHighway(map.build[i]))
    return 'The highway runs here: open an exit off it with the exit tool';
  if (kind === 'parking') return parkingError(map, i);
  // A public road crosses the railway on the level.
  if (map.build[i] === Build.Rail) {
    if (kind !== 'road') return 'The railway is in the way';
    const along = map.neighbors4(i).some((n) => map.build[n] === Build.Crossing);
    return along ? 'Roads cross the railway straight over, not along it' : null;
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

  if (kind === 'tugBerth') {
    if (t !== Terrain.Water || !map.ocean[i]) return 'A tug berth goes in the water';
    if (map.depth[i] < B.TUG_DRAFT) return `Too shallow: a tug needs ${B.TUG_DRAFT} m`;
    const dock = map.neighbors4(i).some((n) => isDock(map.build[n]));
    return dock ? null : 'Put it beside a jetty or quay, where the crew step aboard';
  }

  if (kind === 'buoyIn' || kind === 'buoyOut') {
    if (t !== Terrain.Water) return 'Buoys go in the water';
    if (!map.ocean[i]) return 'This water is not connected to the sea';
    const crowded = map.neighbors4(i).some((n) => isBuoy(map.build[n]) || pending?.has(n));
    return crowded ? 'Leave a tile between buoys' : null;
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
    map.buildable(n) &&
    !pending?.has(n) &&
    map.build[n] === Build.None &&
    map.terrain[n] !== Terrain.Water &&
    map.terrain[n] !== Terrain.Rock;
  if (!footprint(map, kind, i, facing).slice(1).every(clear)) {
    return 'A large truck bay is two tiles wide: clear the tile beside it';
  }
  if (!ROTATABLE.has(kind)) return null;
  const front = frontOf(map, i, facing);
  const f = front >= 0 ? map.build[front] : Build.None;
  // Trucks come in off a public road, or along port roads and quays from a
  // port gate.
  const truckable =
    f === Build.Road || ((f === Build.PortRoad || f === Build.Quay) && !forkliftOnly(map, front));
  if (kind === 'portGate') {
    return f === Build.Road ? null : 'The gate must face a public road, where the trucks turn in';
  }
  if (kind === 'truckBay' || kind === 'largeBay') {
    return truckable ? null : 'The entrance must face a public road or a port road';
  }
  if (kind === 'depot') {
    return drivable(f) ? null : 'The garage door must face a port road or quay';
  }
  if (kind === 'office') {
    const ok = walkableAt(map, front) || f === Build.Road;
    return ok ? null : 'The door must face a port path or road';
  }
  return walkableAt(map, front) ? null : 'The door must face a port path, quay or truck bay';
}

/**
 * Port surfaces forklifts can drive on: port roads and quays, including
 * those for port machines only. Not port paths
 * (those are for people on foot), public roads (for the hauliers) or wooden
 * jetties (they cannot take the weight).
 */
export function drivable(code: number): boolean {
  return (
    code === Build.PortRoad ||
    code === Build.Quay ||
    code === Build.JibCrane ||
    code === Build.HarbourCrane ||
    code === Build.Gantry ||
    code === Build.YardGantry ||
    isBay(code) ||
    code === Build.Depot
  );
}

/** Walkable here: not kept for port machines, by marking or next to a crane. */
export function walkableAt(map: GameMap, i: number): boolean {
  return i >= 0 && walkable(map.build[i]) && !forkliftOnly(map, i) && !nearCrane(map, i);
}

/**
 * On or next to a crane, diagonals too: the 3×3 round each crane is for
 * the port's machines only, kept clear of people on foot and of the
 * hauliers' trucks.
 */
export function nearCrane(map: GameMap, i: number): boolean {
  const x = map.xOf(i);
  const y = map.yOf(i);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (map.inBounds(x + dx, y + dy) && isCrane(map.build[map.idx(x + dx, y + dy)])) return true;
    }
  }
  return false;
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

/** Tugs are bought at, and lie at, a tug berth: one each. */
export function tugPlacementError(map: GameMap, i: number): string | null {
  return map.build[i] === Build.TugBerth ? null : 'Click a tug berth to buy a tug there';
}

export function placementCost(map: GameMap, kind: BuildKind, i: number): number {
  if (kind === 'road' && map.build[i] === Build.Rail) return B.CROSSING_COST;
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
  if (!map.buildable(i)) return OUTSIDE;
  const empty = map.build[i] === Build.None && map.deco[i] === Deco.None;
  if (empty && map.terrain[i] !== Terrain.Rock) return 'Nothing to clear';
  if (isHighway(map.build[i])) {
    if (!isExit(map, i))
      return 'The highway is not yours to dig up: open exits off it with the exit tool';
    const y = map.yOf(i);
    if (y === map.yOf(map.entry)) return 'The port’s first exit off the highway stays open';
    if (ownedByTown(map, map.idx(HIGHWAY_COLUMNS, y))) return 'The town’s exit stays open';
    return null;
  }
  if (i === map.entry) return 'The main road cannot be removed';
  if (ownedByTown(map, i) || isTownBuilding(map.build[i])) return 'This belongs to the town';
  if (map.build[i] === Build.Rail) return 'The railway is not yours to take up';
  return null;
}

/** Money gained (positive) or spent (negative) by bulldozing a tile. */
export function bulldozeValue(map: GameMap, i: number): number {
  if (map.build[i] === Build.Crossing) return Math.floor(B.CROSSING_COST * B.BULLDOZE_REFUND);
  if (isExit(map, i)) return Math.floor(B.EXIT_COST * B.BULLDOZE_REFUND);
  const kind = kindOfCode(map.build[i]);
  const store = storeKindAt(map, i);
  const marked = store ? Math.floor(STORE_COST[store] * B.BULLDOZE_REFUND) : 0;
  if (kind === 'quay')
    return Math.floor(placementCost(map, 'quay', i) * B.BULLDOZE_REFUND) + marked;
  if (kind) return Math.floor(BUILDABLES[kind].cost * B.BULLDOZE_REFUND) + marked;
  if (map.deco[i] === Deco.Tree) return -B.TREE_CLEAR_COST;
  return map.terrain[i] === Terrain.Rock ? -B.ROCK_CLEAR_COST : 0;
}

/**
 * Dredging digs the seabed a step deeper, or a shore tile out into sea;
 * reclaiming fills it a step shallower, until it is dry land. `raise` is
 * reclaiming. `pending` holds tiles dug out earlier in the same drag, so a
 * channel can be dug inland from the shore.
 */
export function terraformError(
  map: GameMap,
  i: number,
  raise: boolean,
  pending?: ReadonlySet<number>,
): string | null {
  if (!map.buildable(i)) return OUTSIDE;
  if (map.build[i] !== Build.None) return 'Clear what is built here first';
  const t = map.terrain[i];
  if (raise) {
    if (t !== Terrain.Water) return 'This is dry land already';
    if (map.xOf(i) >= map.w - 4) return 'Too far out to fill in';
    return null;
  }
  if (t === Terrain.Rock) return 'Rock is in the way: bulldoze it first';
  if (t !== Terrain.Water) {
    const sea = map.neighbors4(i).some((n) => map.ocean[n] === 1 || pending?.has(n));
    return sea ? null : 'Dig out from the water’s edge';
  }
  if (map.depth[i] >= B.MAX_DREDGE_DEPTH)
    return `Already ${B.MAX_DREDGE_DEPTH} m deep, as deep as dredgers go`;
  return null;
}

export function terraformCost(map: GameMap, i: number, raise: boolean): number {
  if (raise) return B.RECLAIM_COST;
  if (map.terrain[i] === Terrain.Water) return B.DREDGE_COST;
  return B.DIG_LAND_COST + (map.deco[i] === Deco.Tree ? B.TREE_CLEAR_COST : 0);
}

/** Dig out or fill in one step. Call terraformError first; see reflood. */
export function terraform(map: GameMap, i: number, raise: boolean): void {
  if (raise) {
    const depth = Math.round((map.depth[i] - B.TERRAFORM_STEP) * 10) / 10;
    if (depth < 0.5) {
      map.terrain[i] = Terrain.Sand;
      map.depth[i] = 0;
      map.ocean[i] = 0;
    } else map.depth[i] = depth;
    return;
  }
  if (map.terrain[i] === Terrain.Water) {
    map.depth[i] = Math.min(B.MAX_DREDGE_DEPTH, map.depth[i] + B.TERRAFORM_STEP);
    return;
  }
  map.terrain[i] = Terrain.Water;
  map.depth[i] = B.TERRAFORM_STEP;
  map.deco[i] = Deco.None;
}

/**
 * Work out again which water is open sea, reachable from the sea edge.
 * Returns the tiles that changed.
 */
export function reflood(map: GameMap): number[] {
  const sea = new Uint8Array(map.build.length);
  const stack: number[] = [];
  for (let y = 0; y < map.h; y++) {
    const i = map.idx(map.w - 1, y);
    if (!map.isLand(i)) {
      sea[i] = 1;
      stack.push(i);
    }
  }
  while (stack.length > 0) {
    for (const n of map.neighbors4(stack.pop()!)) {
      if (sea[n] || map.isLand(n)) continue;
      sea[n] = 1;
      stack.push(n);
    }
  }
  const changed: number[] = [];
  for (let i = 0; i < sea.length; i++) {
    if (map.ocean[i] !== sea[i]) {
      map.ocean[i] = sea[i];
      changed.push(i);
    }
  }
  return changed;
}

/** The middle of the docks, which buoys are ordered from. */
export function harbourCentre(map: GameMap): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let n = 0;
  for (let i = 0; i < map.build.length; i++) {
    if (!isDock(map.build[i])) continue;
    x += map.xOf(i) + 0.5;
    y += map.yOf(i) + 0.5;
    n++;
  }
  if (n === 0) return { x: map.xOf(map.entry) + 0.5, y: map.yOf(map.entry) + 0.5 };
  return { x: x / n, y: y / n };
}

/**
 * Buoys of one colour in the order boats take them: the green way in from
 * the one furthest from the docks, the red way out from the nearest.
 */
export function buoyOrder(map: GameMap, out: boolean): number[] {
  const c = harbourCentre(map);
  const d = (i: number) => Math.hypot(map.xOf(i) + 0.5 - c.x, map.yOf(i) + 0.5 - c.y);
  const code = out ? Build.BuoyOut : Build.BuoyIn;
  const buoys: number[] = [];
  for (let i = 0; i < map.build.length; i++) if (map.build[i] === code) buoys.push(i);
  return buoys.sort((p, q) => (out ? d(p) - d(q) : d(q) - d(p)));
}

/**
 * Buoys of one colour paired off in the order boats take them: each pair
 * marks a line boats cross between the two (`b` is -1 for a buoy left over,
 * which boats pass close by instead).
 */
export function buoyGates(map: GameMap, out: boolean): { a: number; b: number }[] {
  const buoys = buoyOrder(map, out);
  const gates: { a: number; b: number }[] = [];
  for (let k = 0; k < buoys.length; k += 2) gates.push({ a: buoys[k], b: buoys[k + 1] ?? -1 });
  return gates;
}

/**
 * Trucks drive on public roads, and on port roads once they are through a
 * port gate: never straight from one to the other. A truck bay is only
 * enterable as the destination, or the one being left, from any side of it
 * that touches a road. Storage areas they load beside, never drive into, and
 * they keep off machines-only ground.
 */
export function truckCost(
  map: GameMap,
  target = -1,
  home = -1,
  /** The parking space a truck is driving into or out of; other parking it keeps off. */
  space?: ReadonlySet<number>,
  /** How far each road runs across from each tile, from laneRuns; worked out as needed without. */
  runs?: Uint8Array,
): CostFn {
  const way = (i: number): 'road' | 'port' | 'gate' | null => {
    const b = map.build[i];
    if (map.store[i] || nearCrane(map, i)) return null;
    if (isPublicRoad(b) || isHighway(b)) return 'road';
    // A parking space is driven through from the road on one side to the
    // road on the other, which are of a kind; see parkingLots.
    if (b === Build.Parking) return space?.has(i) ? 'gate' : null;
    // Trucks drive under a yard gantry, to load from it.
    const paved = b === Build.PortRoad || b === Build.Quay || b === Build.YardGantry;
    if (paved) return forkliftOnly(map, i) ? null : 'port';
    if (b === Build.Gate) return 'gate';
    const a = anchorOf(map, i);
    return a === target || a === home ? 'gate' : null;
  };
  return (i, from) => {
    const here = way(i);
    if (!here) return Infinity;
    const known = from !== undefined && from >= 0;
    // Along the highway its own way, on and off at the exits, and never
    // the wrong way down a one-way road.
    if (known && !flowOk(map, from, i)) return Infinity;
    const there = known ? way(from) : null;
    const jump = (here === 'road' && there === 'port') || (here === 'port' && there === 'road');
    if (jump) return Infinity;
    // A port gate for trucks only coming in, or only going out.
    if (known && map.build[i] === Build.Gate) {
      if (there === 'road' && map.orient[i] & GATE_OUT) return Infinity;
      if (there === 'port' && map.orient[i] & GATE_IN) return Infinity;
    }
    if (known && map.build[from] === Build.Gate) {
      if (here === 'port' && map.orient[from] & GATE_OUT) return Infinity;
      if (here === 'road' && map.orient[from] & GATE_IN) return Infinity;
    }
    // Keep to the right on a road wider than one: the left half of the road
    // it is on, across the way it is going, is the oncoming lane; across a
    // road three wide, the middle is either's, and on paving wider still
    // the right half is all its own. A one-way road has no oncoming lane.
    if (known && here !== 'gate' && oneWay(map, i) < 0) {
      const dx = map.xOf(i) - map.xOf(from);
      const dy = map.yOf(i) - map.yOf(from);
      if (leftHalf(map, i, -dy, dx, runs)) {
        return 1 + KEEP_RIGHT;
      }
    }
    return 1;
  };
}

/**
 * The kind of road a tile is for trucks, whatever they are going to: public
 * road (and the highway), or port road and quay; null for anything else,
 * and for storage, machines-only ground and the ground round a crane.
 */
function roadKind(map: GameMap, i: number): 'road' | 'port' | null {
  const b = map.build[i];
  if (map.store[i] || nearCrane(map, i)) return null;
  if (isPublicRoad(b) || isHighway(b)) return 'road';
  // Trucks drive under a yard gantry, to load from it.
  const paved = b === Build.PortRoad || b === Build.Quay || b === Build.YardGantry;
  return paved && !forkliftOnly(map, i) ? 'port' : null;
}

/** How far across a road the keep-right rule looks either way, in tiles. */
const LANE_SCAN = 4;

/** The grid steps along +x, -x, +y and -y, by their place in laneRuns. */
const STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function stepIndex(dx: number, dy: number): number {
  return dx > 0 ? 0 : dx < 0 ? 1 : dy > 0 ? 2 : 3;
}

/**
 * For each tile and each of the four ways along the grid (see STEPS), how
 * many tiles of road of its own kind run on from it that way, LANE_SCAN at
 * most: how far a road runs across from each tile, for keeping right.
 */
export function laneRuns(map: GameMap): Uint8Array {
  const n = map.build.length;
  const kinds = new Array<'road' | 'port' | null>(n);
  for (let i = 0; i < n; i++) kinds[i] = roadKind(map, i);
  const out = new Uint8Array(n * 4);
  STEPS.forEach(([dx, dy], d) => {
    // From the far end back, each one more than the next along, if alike.
    const xs = dx > 0 ? [map.w - 1, -1, -1] : [0, map.w, 1];
    const ys = dy > 0 ? [map.h - 1, -1, -1] : [0, map.h, 1];
    for (let y = ys[0]; y !== ys[1]; y += ys[2]) {
      for (let x = xs[0]; x !== xs[1]; x += xs[2]) {
        const i = map.idx(x, y);
        const nx = x + dx;
        const ny = y + dy;
        if (!kinds[i] || !map.inBounds(nx, ny)) continue;
        const j = map.idx(nx, ny);
        if (kinds[j] !== kinds[i]) continue;
        out[i * 4 + d] = Math.min(LANE_SCAN, 1 + out[j * 4 + d]);
      }
    }
  });
  return out;
}

/** How many tiles of road of its kind run on from tile `i` the way (dx, dy). */
function runFrom(map: GameMap, i: number, dx: number, dy: number, runs?: Uint8Array): number {
  if (runs) return runs[i * 4 + stepIndex(dx, dy)];
  const kind = roadKind(map, i);
  let n = 0;
  let x = map.xOf(i);
  let y = map.yOf(i);
  while (n < LANE_SCAN) {
    x += dx;
    y += dy;
    if (!map.inBounds(x, y) || roadKind(map, map.idx(x, y)) !== kind) break;
    n++;
  }
  return n;
}

/**
 * Whether tile `i` is in the left half of the road across it, for a truck
 * going the way whose right is (rx, ry): more of the road lies to its
 * right than to its left.
 */
function leftHalf(map: GameMap, i: number, rx: number, ry: number, runs?: Uint8Array): boolean {
  const right = runFrom(map, i, rx, ry, runs);
  return right > 0 && runFrom(map, i, -rx, -ry, runs) < right;
}

/** What driving in the left-hand lane of a wide road costs a truck, on top of a tile. */
const KEEP_RIGHT = 1.5;

/**
 * How far trucks drive from the highway to each tile they can get to, or
 * -1: public roads, and port roads and quays through a port gate.
 */
export function truckReach(map: GameMap): Int32Array {
  const cost = truckCost(map);
  const dist = new Int32Array(map.build.length).fill(-1);
  const queue: number[] = [];
  // In off the ends of the highway; on maps without one, at the main road's end.
  const starts = hasHighway(map) ? highwayIns(map).map((s) => s.tile) : [map.entry];
  for (const s of starts) {
    if (s < 0 || !Number.isFinite(cost(s))) continue;
    dist[s] = 0;
    queue.push(s);
  }
  for (let k = 0; k < queue.length; k++) {
    const cur = queue[k];
    for (const n of map.neighbors4(cur)) {
      if (dist[n] >= 0 || !Number.isFinite(cost(n, cur))) continue;
      dist[n] = dist[cur] + 1;
      queue.push(n);
    }
  }
  return dist;
}

/**
 * Tiles beside a storage area where trucks can stand to load, nearest the
 * highway first. Storage is inside the port, so they load from a port road
 * or quay they reach through a port gate, never from a public road outside
 * it; and not beside storage on machines-only ground, which only the port's
 * own machines work.
 */
export function loadingSpots(map: GameMap, tiles: number[], reach: Int32Array): number[] {
  const area = new Set(tiles);
  const spots = new Set<number>();
  for (const t of tiles) {
    if (machinesOnly(map, t)) continue;
    for (const n of map.neighbors4(t)) {
      if (area.has(n) || reach[n] < 0 || map.store[n]) continue;
      const b = map.build[n];
      // Under a yard gantry too, which loads them there.
      if (b !== Build.PortRoad && b !== Build.Quay && b !== Build.YardGantry) continue;
      spots.add(n);
    }
  }
  return [...spots].sort((p, q) => reach[p] - reach[q] || p - q);
}

/**
 * A parking space: the tiles across the lot a truck stands on, diagonally,
 * from the road on one side to the road on the other, and those two road
 * tiles. Trucks drive in from one road and out onto the other, only ever
 * forwards.
 */
export interface ParkingSpace {
  tiles: number[];
  ends: [number, number];
  /**
   * Whether a truck can turn into it off the road on the lot's in side,
   * coming the way it runs, and out onto the road on its out side, going on
   * that way: see ParkingLot.flow.
   */
  ok: boolean;
}

/**
 * Which way trucks go through a lot of angled parking, for the angle the
 * spaces lean at: in off the road on `ends[in]` of each space, driving
 * along it `along`, and out onto the road on the other side, going on the
 * same way. The spaces lean the way between `along` and across the lot.
 */
export interface ParkingFlow {
  in: 0 | 1;
  along: [number, number];
  across: [number, number];
}

/** On a parking tile, in `GameMap.orient`: its lot runs the other way round from the usual. */
export const PARK_FLIP = 32;

/** A run of truck parking, and why it is no use, if it is not. */
export interface ParkingLot {
  tiles: number[];
  spaces: ParkingSpace[];
  /** Joined to public roads, outside the port; else to port roads, inside. */
  outside: boolean;
  /** Two tiles wide, with room for the big trucks. */
  wide: boolean;
  why: string | null;
  /** Which way trucks drive through it, once laid out right. */
  flow: ParkingFlow | null;
}

/**
 * Parking lots: each run of parking tiles, which must be a strip one or two
 * tiles wide with a road all along both its long sides, both public roads
 * (outside the port) or both port roads (inside), for trucks to drive
 * across it into a space and out again on the far side.
 */
export function parkingLots(map: GameMap): ParkingLot[] {
  const lots: ParkingLot[] = [];
  const seen = new Uint8Array(map.build.length);
  const roadKind = (i: number): 'road' | 'port' | null => {
    if (i < 0) return null;
    const b = map.build[i];
    if (isPublicRoad(b) && b !== Build.Crossing) return 'road';
    const port = b === Build.PortRoad || b === Build.Quay || b === Build.YardGantry;
    return port && !forkliftOnly(map, i) && !map.store[i] && !nearCrane(map, i) ? 'port' : null;
  };
  for (let i = 0; i < map.build.length; i++) {
    if (seen[i] || map.build[i] !== Build.Parking) continue;
    const tiles: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length > 0) {
      const t = stack.pop()!;
      tiles.push(t);
      for (const n of map.neighbors4(t)) {
        if (seen[n] || map.build[n] !== Build.Parking) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    tiles.sort((a, b) => a - b);
    const xs = tiles.map((t) => map.xOf(t));
    const ys = tiles.map((t) => map.yOf(t));
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const w = Math.max(...xs) - x0 + 1;
    const h = Math.max(...ys) - y0 + 1;
    const lot: ParkingLot = {
      tiles,
      spaces: [],
      outside: false,
      wide: false,
      why: null,
      flow: null,
    };
    lots.push(lot);
    if (tiles.length !== w * h || Math.min(w, h) > 2) {
      lot.why = 'Parking is a straight strip, one or two tiles wide';
      continue;
    }
    // Across the short way, the spaces side by side along the long way; a
    // square lot may go either way round.
    const ways: boolean[] = [];
    if (h <= 2 && (h <= w || w > 2)) ways.push(true);
    if (w <= 2) ways.push(false);
    let why: string | null = null;
    for (const acrossY of ways) {
      const along = acrossY ? w : h;
      const across = acrossY ? h : w;
      const at = (a: number, c: number) =>
        acrossY ? map.idx(x0 + a, y0 + c) : map.idx(x0 + c, y0 + a);
      const off = (a: number, c: number) => {
        const x = acrossY ? x0 + a : x0 + c;
        const y = acrossY ? y0 + c : y0 + a;
        return map.inBounds(x, y) ? map.idx(x, y) : -1;
      };
      const spaces: ParkingSpace[] = [];
      const kinds = new Set<string | null>();
      for (let a = 0; a < along; a++) {
        const span = Array.from({ length: across }, (_, c) => at(a, c));
        const ends: [number, number] = [off(a, -1), off(a, across)];
        kinds.add(roadKind(ends[0]));
        kinds.add(roadKind(ends[1]));
        spaces.push({ tiles: span, ends, ok: false });
      }
      if (kinds.has(null)) {
        why ??=
          'Parking needs a road all along both its long sides, to drive in on one and out on the other';
        continue;
      }
      if (kinds.size > 1) {
        why ??=
          'A public road on one side and a port road on the other: trucks would get into the port without a gate';
        continue;
      }
      lot.spaces = spaces;
      lot.outside = kinds.has('road');
      lot.wide = across === 2;
      lot.flow = parkingFlow(map, tiles, acrossY);
      // Each space is turned into off the road coming the way the lot runs,
      // from along the road or straight at it, and out onto the far road
      // going on that way: never round a hairpin.
      const { in: k, along: f, across: c } = lot.flow;
      const kind = roadKind(spaces[0].ends[0]);
      const step = (i: number, dx: number, dy: number) => {
        const x = map.xOf(i) + dx;
        const y = map.yOf(i) + dy;
        return map.inBounds(x, y) ? map.idx(x, y) : -1;
      };
      for (const s of spaces) {
        const e = s.ends[k];
        const o = s.ends[1 - k];
        const into = [step(e, -f[0], -f[1]), step(e, -c[0], -c[1])];
        const onto = [step(o, f[0], f[1]), step(o, c[0], c[1])];
        s.ok = into.some((t) => roadKind(t) === kind) && onto.some((t) => roadKind(t) === kind);
      }
      why = spaces.some((s) => s.ok)
        ? null
        : 'Trucks drive through it the way its arrows show, turning in off the road and on again: carry the roads on past its ends';
      break;
    }
    lot.why = why;
  }
  return lots;
}

/**
 * Which way trucks go through a lot of parking across `acrossY` (or across
 * x): in off whichever side road has the lot on its right, keeping right,
 * so trucks turn in without crossing the traffic coming the other way, and
 * out the other side. Flipped (PARK_FLIP on its tiles), in off the other.
 */
export function parkingFlow(map: GameMap, tiles: number[], acrossY: boolean): ParkingFlow {
  const flipped = tiles.some((t) => map.orient[t] & PARK_FLIP);
  const k: 0 | 1 = flipped ? 1 : 0;
  // From the side road on `ends[0]` (the low side) into the lot, or back.
  const base: [number, number] = acrossY ? [0, 1] : [1, 0];
  const across: [number, number] = k === 0 ? base : [-base[0], -base[1]];
  // Driving `along` the road, the lot is on the right: the way whose right is `across`.
  const along: [number, number] = [across[1], -across[0]];
  return { in: k, along, across };
}

/** Whether a truck needs a space two tiles wide: the big trucks, and those with two containers. */
export function needsWideSpace(capacity: number, boxes: boolean): boolean {
  return boxes ? capacity > 1 : capacity > B.TRUCK_CAPACITY;
}

/** Tiles round a crane at `i` kept for port machines, and those a jib crane reaches storage in. */
export function craneGround(
  map: GameMap,
  kind: 'jibCrane' | 'harbourCrane' | 'gantryCrane',
  i: number,
  facing: number,
): { zone: number[]; reach: number[] } {
  const tiles = footprint(map, kind, i, facing).filter((t) => t >= 0);
  const around = (r: number) => {
    const out = new Set<number>();
    for (const t of tiles) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = map.xOf(t) + dx;
          const y = map.yOf(t) + dy;
          if (map.inBounds(x, y)) out.add(map.idx(x, y));
        }
      }
    }
    return out;
  };
  const zone = around(1);
  if (kind === 'gantryCrane') {
    // Its rails, in blue, the length of a ship, and the ground round them.
    const rails = gantryRails(map, i, facing).filter((t) => t >= 0);
    for (const t of gantryGround(map, i, facing)) zone.add(t);
    return { zone: [...zone].filter((t) => !rails.includes(t)), reach: rails };
  }
  const reach = kind === 'jibCrane' ? [...around(B.JIB_REACH)].filter((t) => !zone.has(t)) : [];
  return { zone: [...zone], reach };
}
