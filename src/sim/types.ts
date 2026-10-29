export const TICKS_PER_SECOND = 10;
export const TICKS_PER_DAY = 600;
export const MAP_SIZE = 96;
/** Rows of country along the south edge, past the port's land, where the town is. */
export const TOWN_BAND = 36;

export const Terrain = { Water: 0, Sand: 1, Grass: 2, Rock: 3 } as const;
export type TerrainCode = (typeof Terrain)[keyof typeof Terrain];

export const Build = {
  None: 0,
  Road: 1,
  Footpath: 2,
  Jetty: 3,
  TruckBay: 4,
  BreakHut: 5,
  Quay: 6,
  JibCrane: 7,
  Depot: 8,
  /** Old saves only: now a port road tagged forklift-only. */
  ForkliftLane: 9,
  Office: 10,
  LargeBay: 11,
  HarbourCrane: 12,
  PortRoad: 13,
  /** Old saves only: now port road or quay marked out as a container yard. */
  Yard: 14,
  Gate: 15,
  /** Old saves only: now port road marked out for crate storage. */
  Warehouse: 16,
  /** Channel buoys: green marks the way in, red the way out. */
  BuoyIn: 17,
  BuoyOut: 18,
  /** The main line, which trains run along. Not the player's to move. */
  Rail: 19,
  /** A public road crossing the railway, with barriers that come down for trains. */
  Crossing: 20,
  // The town's buildings, which it builds and rebuilds itself; see town.ts.
  Cottage: 21,
  House: 22,
  Shop: 23,
  Flats: 24,
  Tower: 25,
  Chapel: 26,
  FishShed: 27,
  Park: 28,
  // Town businesses, which take goods from the port.
  FishMarket: 29,
  Cannery: 30,
  Store: 31,
  Factory: 32,
  /** A ship-to-shore gantry crane, 2×2 on a quay edge. */
  Gantry: 33,
  /** A berth in the water beside a jetty or quay, where a harbour tug lies. */
  TugBerth: 34,
  // 34 is the tug berth.
  /**
   * Truck parking: outside the port where it joins a public road, inside
   * where it joins port roads. See parkingSides in rules.ts.
   */
  Parking: 35,
} as const;
export type BuildCode = (typeof Build)[keyof typeof Build];

export const Deco = { None: 0, Tree: 1 } as const;

/**
 * What a port road or quay tile is marked out to store, in `GameMap.store`.
 * Tiles of one kind that touch make one storage area.
 */
export const Store = { None: 0, Crates: 1, Boxes: 2, CratesOut: 3, BoxesOut: 4 } as const;
/** Storage for cargo coming in off the ships, or (`Out`) going out on them. */
export type StoreKind = 'crates' | 'boxes' | 'cratesOut' | 'boxesOut';
export const STORE_CODE: Record<StoreKind, number> = {
  crates: Store.Crates,
  boxes: Store.Boxes,
  cratesOut: Store.CratesOut,
  boxesOut: Store.BoxesOut,
};

/** Storage for containers, coming in or going out. */
export function storesBoxes(code: number): boolean {
  return code === Store.Boxes || code === Store.BoxesOut;
}

/** Storage for cargo going out on the ships. */
export function storesOutgoing(code: number): boolean {
  return code === Store.CratesOut || code === Store.BoxesOut;
}

export type BuildKind =
  | 'road'
  | 'footpath'
  | 'jetty'
  | 'truckBay'
  | 'breakHut'
  | 'quay'
  | 'jibCrane'
  | 'depot'
  | 'office'
  | 'largeBay'
  | 'harbourCrane'
  | 'gantryCrane'
  | 'tugBerth'
  | 'portRoad'
  | 'portGate'
  | 'parking'
  | 'buoyIn'
  | 'buoyOut';

export type MachineKind = 'forklift' | 'stacker';

/** A channel buoy; boats sail past it, so the water stays open. */
export function isBuoy(code: number): boolean {
  return code === Build.BuoyIn || code === Build.BuoyOut;
}

/** Built and kept by the town, never the player. */
export function isTownBuilding(code: number): boolean {
  return code >= Build.Cottage && code <= Build.Factory;
}

/** Public roads trucks drive along, level crossings included. */
export function isPublicRoad(code: number): boolean {
  return code === Build.Road || code === Build.Crossing;
}

/** A truck bay of either size, where trucks collect crates. */
export function isBay(code: number): boolean {
  return code === Build.TruckBay || code === Build.LargeBay;
}

/** A crane standing on a quay. */
export function isCrane(code: number): boolean {
  return code === Build.JibCrane || code === Build.HarbourCrane || code === Build.Gantry;
}

/** Tiles boats can moor alongside. */
export function isDock(code: number): boolean {
  return (
    code === Build.Jetty ||
    code === Build.Quay ||
    code === Build.JibCrane ||
    code === Build.HarbourCrane ||
    code === Build.Gantry
  );
}
