export const TICKS_PER_SECOND = 10;
export const TICKS_PER_DAY = 600;
export const MAP_SIZE = 96;

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
  Yard: 14,
  Gate: 15,
  Warehouse: 16,
  /** Channel buoys: green marks the way in, red the way out. */
  BuoyIn: 17,
  BuoyOut: 18,
} as const;
export type BuildCode = (typeof Build)[keyof typeof Build];

export const Deco = { None: 0, Tree: 1 } as const;

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
  | 'portRoad'
  | 'containerYard'
  | 'portGate'
  | 'warehouse'
  | 'buoyIn'
  | 'buoyOut';

export type MachineKind = 'forklift' | 'stacker';

/** A channel buoy; boats sail past it, so the water stays open. */
export function isBuoy(code: number): boolean {
  return code === Build.BuoyIn || code === Build.BuoyOut;
}

/** Where trucks collect crates: a truck bay of either size, or a warehouse. */
export function isBay(code: number): boolean {
  return code === Build.TruckBay || code === Build.LargeBay || code === Build.Warehouse;
}

/** Tiles boats can moor alongside. */
export function isDock(code: number): boolean {
  return (
    code === Build.Jetty ||
    code === Build.Quay ||
    code === Build.JibCrane ||
    code === Build.HarbourCrane
  );
}
