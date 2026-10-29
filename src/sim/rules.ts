import * as B from './balance';
import type { GameMap } from './map';
import type { CostFn } from './path';
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
    hint: `Ship-to-shore crane: lifts containers off feeder ships three times as fast as a harbour crane and sets them down in the bay between its legs, ${B.GANTRY_STACK} at most, where reach stackers or terminal tractors collect them, never the hauliers' trucks. 2×2 on quay, two tiles along the quay edge facing open water. It runs on rails along the quay to each bay of the ship in turn, so it needs ${B.GANTRY_RAILS} tiles of clear quay edge, the length of a ship, kept for its rails, and the ground a tile round them is for port machines only. Put two side by side along one berth and they share the rails and the ship out between them, working it twice as fast. $${B.GANTRY_RUNNING_COST}/day to run`,
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
    hint: 'Drag out a strip one or two tiles wide, with a road all along both its long sides. Trucks drive in off one road, park at an angle across the strip, one to each space along it, and drive out onto the other road: always forwards. Big trucks need two tiles. Between public roads it is outside the port: shippers\u2019 trucks wait there for their paperwork. Between port roads it is inside, behind a port gate: trucks queue there for a free loading spot',
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
export function unmarkable(map: GameMap, i: number): { store: boolean; machines: boolean } {
  if (!map.buildable(i)) return { store: false, machines: false };
  return {
    store: map.store[i] !== 0,
    machines: forkliftOnly(map, i) && gantryOver(map, i, true) < 0,
  };
}

export function unmarkRefund(map: GameMap, i: number): number {
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
  if (i === map.entry) return 'The main road cannot be removed';
  if (ownedByTown(map, i) || isTownBuilding(map.build[i])) return 'This belongs to the town';
  if (map.build[i] === Build.Rail) return 'The railway is not yours to take up';
  return null;
}

/** Money gained (positive) or spent (negative) by bulldozing a tile. */
export function bulldozeValue(map: GameMap, i: number): number {
  if (map.build[i] === Build.Crossing) return Math.floor(B.CROSSING_COST * B.BULLDOZE_REFUND);
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
): CostFn {
  const way = (i: number): 'road' | 'port' | 'gate' | null => {
    const b = map.build[i];
    if (map.store[i] || nearCrane(map, i)) return null;
    if (isPublicRoad(b)) return 'road';
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
    const there = from === undefined || from < 0 ? null : way(from);
    const jump = (here === 'road' && there === 'port') || (here === 'port' && there === 'road');
    return jump ? Infinity : 1;
  };
}

/**
 * How far trucks drive from the highway to each tile they can get to, or
 * -1: public roads, and port roads and quays through a port gate.
 */
export function truckReach(map: GameMap): Int32Array {
  const cost = truckCost(map);
  const dist = new Int32Array(map.build.length).fill(-1);
  const queue: number[] = [];
  if (Number.isFinite(cost(map.entry))) {
    dist[map.entry] = 0;
    queue.push(map.entry);
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
}

/** A run of truck parking, and why it is no use, if it is not. */
export interface ParkingLot {
  tiles: number[];
  spaces: ParkingSpace[];
  /** Joined to public roads, outside the port; else to port roads, inside. */
  outside: boolean;
  /** Two tiles wide, with room for the big trucks. */
  wide: boolean;
  why: string | null;
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
    const lot: ParkingLot = { tiles, spaces: [], outside: false, wide: false, why: null };
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
        spaces.push({ tiles: span, ends });
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
      why = null;
      break;
    }
    lot.why = why;
  }
  return lots;
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
