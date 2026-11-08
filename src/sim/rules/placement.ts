// Whether a building may go where the player puts it, what it costs, and bulldozing, dredging and reclaiming.

import * as B from '../balance';
import { landError } from '../land';
import type { GameMap } from '../map';
import { HIGHWAY_COLUMNS, isExit, isHighway } from '../roads';
import { ownedByTown } from '../town';
import {
  Build,
  Deco,
  isBay,
  isBuoy,
  isCrane,
  isDock,
  isTownBuilding,
  storesBoxes,
  Terrain,
  type BuildKind,
} from '../types';
import {
  anchorOf,
  bestFacing,
  footprint,
  frontOf,
  gantryOver,
  gantryRails,
  kindOfCode,
} from './footprint';
import { BUILDABLES, ROTATABLE } from './buildables';
import { STORE_COST, forkliftOnly, parkingError, storeKindAt } from './marking';
import { portCrossing, sidingBulldozeError, sidingError } from './rails';

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
  const land = landError(map, i);
  if (land) return land;
  // A building over two plots needs both.
  for (const f of footprint(map, kind, i, facing)) {
    const off = f >= 0 && f !== i ? landError(map, f) : null;
    if (off) return off;
  }
  const t = map.terrain[i];
  if ((kind === 'harbourCrane' || kind === 'jibCrane') && map.store[i]) {
    return 'Clear the storage marked out here first';
  }
  if (kind === 'gantryCrane') {
    const tiles = footprint(map, kind, i, facing);
    const quay = (t: number) =>
      t >= 0 && map.owns(t) && map.build[t] === Build.Quay && !map.store[t];
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
    // Or over a siding beside the yard, to load the trains on it.
    const paved =
      map.build[i] === Build.PortRoad ||
      map.build[i] === Build.Quay ||
      map.build[i] === Build.Siding;
    if (!paved || map.store[i])
      return 'A yard gantry stands on port road, quay or siding track, beside a yard';
    const yard = map.neighbors4(i).some((n) => storesBoxes(map.store[n]));
    // Trucks still drive under it, to load, so it may stand where they do.
    return yard ? null : 'Put it beside a container yard: it spans the stacks to load the trucks';
  }
  if (kind === 'grabCrane') {
    if (map.build[i] !== Build.Quay || map.store[i]) return 'A grab crane goes on a quay';
    const water = map.neighbors4(i).find((n) => map.ocean[n] === 1 && map.build[n] === Build.None);
    if (water === undefined) return 'Put the crane at the quay edge, next to open water';
    const bx = 2 * map.xOf(i) - map.xOf(water);
    const by = 2 * map.yOf(i) - map.yOf(water);
    const behind = map.inBounds(bx, by) ? map.build[map.idx(bx, by)] : Build.None;
    return behind === Build.Quay || behind === Build.Belt
      ? null
      : 'A grab crane needs quay behind it too (2 wide), for its hopper';
  }
  if (kind === 'loadout') {
    const track = map.build[i] === Build.Siding || portCrossing(map, i);
    if (map.build[i] === Build.Loadout) return 'A loadout stands here already';
    return track ? null : 'A rail loadout stands over siding track';
  }
  // Belts and stockpiles go on open ground or quay; a belt laid again turns it.
  if (kind === 'belt' && map.build[i] === Build.Belt) return null;
  if ((kind === 'belt' || kind === 'stockpile') && map.build[i] === Build.Quay) {
    return map.store[i] ? 'Clear the storage marked out here first' : null;
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
  if (kind === 'siding') return sidingError(map, i, pending);
  // A public road crosses the railway on the level.
  if (map.build[i] === Build.Rail) {
    if (kind !== 'road') return 'The railway is in the way';
    const along = map.neighbors4(i).some((n) => map.build[n] === Build.Crossing);
    return along ? 'Roads cross the railway straight over, not along it' : null;
  }
  // A jetty can be paved over into a quay and a port path into a port road,
  // and a harbour office, hut or customs office put up on a port path or road not marked
  // out for storage; nothing else is built over.
  const upgrade =
    (kind === 'quay' && map.build[i] === Build.Jetty) ||
    (kind === 'portRoad' && map.build[i] === Build.Footpath) ||
    // A port road across siding track: a level crossing.
    (kind === 'portRoad' && map.build[i] === Build.Siding) ||
    ((kind === 'office' || kind === 'harbourHut' || kind === 'customs') && onPath(map, i));
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
    map.owns(n) &&
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
  if (kind === 'portGate') {
    return f === Build.Road ? null : 'The gate must face a public road, where the trucks turn in';
  }
  // A truck bay goes up anywhere: one with no road in front or way in
  // behind for those who load it shows why, with a red mark (bayTrouble).
  if (kind === 'truckBay' || kind === 'largeBay') return null;
  // A depot goes anywhere, but its machines are shut in till its door faces
  // a port road or quay: see depotDoorTrouble.
  if (kind === 'depot') return null;
  if (kind === 'office' || kind === 'harbourHut' || kind === 'customs') {
    const ok = walkableAt(map, front) || f === Build.Road;
    return ok ? null : 'The door must face a port path or road';
  }
  return walkableAt(map, front) ? null : 'The door must face a port path, quay or truck bay';
}

/** A port path or road a harbour office, hut or customs office may go up on: not storage, not by a crane. */
function onPath(map: GameMap, i: number): boolean {
  const b = map.build[i];
  return (b === Build.Footpath || b === Build.PortRoad) && map.store[i] === 0 && !nearCrane(map, i);
}

/**
 * Why a truck bay at `i`, facing `facing`, is no use as it stands: no road
 * in front for the trucks to back in off (a public road, or a port road
 * from a port gate), or no port road, quay or path behind it for the
 * dockhands and forklifts that load it. Null when it has both.
 */
export function bayTrouble(map: GameMap, i: number, facing: number): string | null {
  const front = frontOf(map, i, facing);
  const f = front >= 0 ? map.build[front] : Build.None;
  const truckable =
    f === Build.Road || ((f === Build.PortRoad || f === Build.Quay) && !forkliftOnly(map, front));
  const back = frontOf(map, i, (facing + 2) & 3);
  const b = back >= 0 ? map.build[back] : Build.None;
  const loaders = b === Build.Footpath || b === Build.PortRoad || b === Build.Quay;
  if (!truckable && !loaders) {
    return 'No road in front for the trucks, nor a way in behind for those who load them: it faces a public road, with a port road or path behind it';
  }
  if (!truckable) {
    return 'No road in front for the trucks to back in off: turn it to face a public road, or build one up to its entrance';
  }
  if (!loaders) {
    return 'No port road, quay or path behind it for the dockhands and forklifts that load it: build one up to its back';
  }
  return null;
}

/**
 * Why a forklift depot at `i`, facing `facing`, is no use: its garage door
 * opens onto nothing its machines can drive on. Null when it does.
 */
export function depotDoorTrouble(map: GameMap, i: number, facing: number): string | null {
  const front = frontOf(map, i, facing);
  if (front >= 0 && drivable(map.build[front])) return null;
  return 'Its garage door faces no port road or quay, so its machines cannot drive out. Turn it round, or build a port road up to its door.';
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
  // Turning a belt round costs nothing.
  if (kind === 'belt' && map.build[i] === Build.Belt) return 0;
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
  const land = landError(map, i);
  if (land) return land;
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
  const b = map.build[i];
  if (b === Build.Siding || b === Build.PortRoad || b === Build.YardGantry || b === Build.Loadout) {
    return sidingBulldozeError(map, i);
  }
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
  const land = landError(map, i);
  if (land) return land;
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
