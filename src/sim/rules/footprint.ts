// Where a building stands: which way it faces, the tiles it covers, and the ground a gantry or crane keeps round it.

import { EXTENSION, PART_SHIFT } from '../orient';
import * as B from '../balance';
import type { GameMap } from '../map';
import { Build, storesBoxes, type BuildKind } from '../types';
import { storeArea } from './marking';
import { BUILDABLES, ROTATABLE } from './buildables';
import { depotDoorTrouble, placementError } from './placement';

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

/**
 * The container yard a yard gantry at `g` spans: one, the biggest beside
 * it where it stands between two, then the first; by the tile of it beside
 * the gantry, which it reaches into, and all its tiles. Null with none.
 */
export function gantryYard(map: GameMap, g: number): { into: number; area: Set<number> } | null {
  let best: { into: number; area: Set<number> } | null = null;
  for (const n of map.neighbors4(g)) {
    if (!storesBoxes(map.store[n]) || best?.area.has(n)) continue;
    const area = storeArea(map, n);
    if (!best || area.size > best.area.size) best = { into: n, area };
  }
  return best;
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
  // A depot can go up facing anywhere, but faces a way its machines can drive out if there is one.
  if (kind === 'depot') {
    for (let f = 0; f < 4; f++) {
      if (!placementError(map, kind, i, pending, f) && !depotDoorTrouble(map, i, f)) return f;
    }
  }
  // A truck bay opens onto the public road where it can, as the hauliers
  // come in off it.
  if (kind === 'truckBay' || kind === 'largeBay') {
    for (let f = 0; f < 4; f++) {
      const front = frontOf(map, i, f);
      if (
        front >= 0 &&
        map.build[front] === Build.Road &&
        !placementError(map, kind, i, pending, f)
      )
        return f;
    }
  }
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
 * Tiles round a crane at `i` kept for port machines (a jib crane reaches
 * storage in just these, right beside it), and a gantry crane's rails.
 */
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
  return { zone: [...zone], reach: [] };
}
