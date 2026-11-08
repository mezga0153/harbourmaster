import type { Snapshot } from '../protocol';
import { EXTENSION, forkliftOnly, portCrossing } from '../sim/rules';
import type { GameMap } from '../sim/map';
import { canBeOneWay, hasLights, isExit, ONE_WAY } from '../sim/roads';
import { isTownStreet } from '../sim/town';
import { Build, Store } from '../sim/types';

// How big the port is and which of its features are in use, and how the town
// is doing, for the play log's day rows (days.ts): from the map and the
// snapshot as the day ends.

/** What the player builds, counted in tiles, by the name it goes by in the log. */
const TILES: Partial<Record<number, string>> = {
  [Build.Road]: 'road',
  [Build.PortRoad]: 'portRoad',
  [Build.Footpath]: 'footpath',
  [Build.Jetty]: 'jetty',
  [Build.Quay]: 'quay',
  [Build.Parking]: 'parking',
  [Build.Siding]: 'siding',
};
/** What the player builds, counted one apiece (a two-tile building once). */
const PIECES: Partial<Record<number, string>> = {
  [Build.TruckBay]: 'truckBay',
  [Build.LargeBay]: 'largeBay',
  [Build.BreakHut]: 'breakHut',
  [Build.Depot]: 'depot',
  [Build.Office]: 'office',
  [Build.HarbourHut]: 'harbourHut',
  [Build.Customs]: 'customs',
  [Build.Gate]: 'gate',
  [Build.BuoyIn]: 'buoy',
  [Build.BuoyOut]: 'buoy',
  [Build.TugBerth]: 'tugBerth',
  [Build.YardGantry]: 'yardGantry',
};
const STORES: Record<number, string> = {
  [Store.Crates]: 'crateStore',
  [Store.Boxes]: 'boxYard',
  [Store.CratesOut]: 'crateExports',
  [Store.BoxesOut]: 'boxExports',
};

export interface PortSize {
  /** Tiles the player has built on, all told. */
  size: number;
  /**
   * Tiles of each kind, pieces of each building, cranes, storage tiles, and
   * road features in use: one-way, lights, forklift-only, highway exits (tiles).
   */
  port: Record<string, number>;
}

export function portSize(m: GameMap, s: Snapshot): PortSize {
  const port: Record<string, number> = {};
  const add = (k: string, n = 1) => (port[k] = (port[k] ?? 0) + n);
  let size = 0;
  for (let i = 0; i < m.build.length; i++) {
    const b = m.build[i];
    // the town lays its own streets
    if (isTownStreet(m, i)) {
      add('townStreet');
      continue;
    }
    if (isExit(m, i)) add('exit');
    const tile = TILES[b];
    const piece = PIECES[b];
    if (tile || piece) size++;
    if (tile) add(tile);
    else if (piece && !(m.orient[i] & EXTENSION)) add(piece);
    if (m.store[i] && STORES[m.store[i]]) add(STORES[m.store[i]]);
    if (canBeOneWay(b)) {
      if (m.orient[i] & ONE_WAY) add('oneWay');
      if (hasLights(m, i)) add('lights');
    }
    if (b === Build.PortRoad && forkliftOnly(m, i)) add('forkliftOnly');
    if (portCrossing(m, i)) add('railCrossing');
  }
  for (const c of s.cranes) add(`${c.kind}Crane`);
  if (s.sidings.length > 0) add('sidings', s.sidings.length);
  const trains = s.trains.filter((t) => t.port?.contractId !== undefined).length;
  if (trains > 0) add('portTrains', trains);
  add('docks', s.docks.total);
  return { size, port };
}

/** The town as the day ends: its homes, what it would grow to, its trade and businesses. */
export function townNow(s: Snapshot): Record<string, number> | null {
  const t = s.town;
  if (!t) return null;
  return {
    homes: t.homes,
    target: Math.round(t.target),
    jobs: Math.round(t.jobs),
    goods: Math.round(t.goods * 10) / 10,
    supplied: Math.round(t.supplied * 10) / 10,
    businesses: t.businesses.reduce((n, b) => n + b.count, 0),
  };
}
