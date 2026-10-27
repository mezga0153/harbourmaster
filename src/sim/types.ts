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
} as const;
export type BuildCode = (typeof Build)[keyof typeof Build];

export const Deco = { None: 0, Tree: 1 } as const;

export type BuildKind =
  'road' | 'footpath' | 'jetty' | 'truckBay' | 'breakHut' | 'quay' | 'jibCrane' | 'depot';

export type MachineKind = 'forklift';

/** Tiles boats can moor alongside. */
export function isDock(code: number): boolean {
  return code === Build.Jetty || code === Build.Quay || code === Build.JibCrane;
}
