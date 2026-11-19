import type { Snapshot } from '../protocol';
import type { Hints } from '../render/overlay';
import * as B from '../sim/balance';
import { isMachineKind, MACHINES } from '../sim/machines';
import type { GameMap } from '../sim/map';
import { exitError, HIGHWAY_COLUMNS } from '../sim/roads';
import {
  anchorOf,
  bayPath,
  bayTrouble,
  bestFacing,
  bulldozeError,
  bulldozeTiles,
  bulldozeValue,
  footprint,
  machinePlacementError,
  placementCost,
  placementError,
  tugPlacementError,
  walkableAt,
} from '../sim/rules';
import { TIERS } from '../sim/tiers';
import { Build, type BuildKind } from '../sim/types';
import type { Tool } from '../ui/tools';
import { craneGroundHints, dockHints, landNote, parkingHints, TOOL_NOTES } from './shared';
import type { PreviewResult } from './types';

// Building: a line or area of tiles, a machine or tug bought on a tile, and
// bulldozing; and one building that can be turned.

/**
 * What building `t` over `tiles` (the drag, or the hovered tile) would do:
 * which tiles take it, what it costs, and why not where it does not.
 */
export function previewBuild(
  map: GameMap,
  snap: Snapshot | null,
  t: Tool,
  dragged: number[],
  i: number,
): PreviewResult {
  let hints: Hints = [];
  if (t === 'jibCrane' || t === 'harbourCrane') hints = craneGroundHints(map, t, i, 0);
  if (t === 'jetty' || t === 'quay') hints = dockHints(snap);
  if (t === 'parking') hints = parkingHints(snap);
  // Bulldozing any tile of a building clears all of it, once.
  const tiles =
    t === 'bulldoze'
      ? [...new Set(dragged.flatMap((k) => bulldozeTiles(map, anchorOf(map, k))))]
      : dragged;
  const ok: boolean[] = [];
  const pending = new Set<number>();
  let value = 0;
  let error: string | null = null;
  // Same rounds as the sim: a dock dragged from the sea inwards still fits.
  tiles.forEach(() => ok.push(false));
  for (let progress = true; progress;) {
    progress = false;
    error = null;
    tiles.forEach((tile, k) => {
      if (ok[k]) return;
      const err =
        t === 'bulldoze'
          ? bulldozeError(map, tile)
          : t === 'tug'
            ? tugPlacementError(map, tile)
            : isMachineKind(t)
              ? machinePlacementError(map, tile)
              : placementError(map, t as BuildKind, tile, pending);
      if (err) {
        error ??= err;
        return;
      }
      ok[k] = progress = true;
      pending.add(tile);
      value +=
        t === 'bulldoze'
          ? anchorOf(map, tile) === tile
            ? bulldozeValue(map, tile)
            : 0
          : t === 'tug'
            ? -B.TUG_PRICE
            : isMachineKind(t)
              ? -MACHINES[t].price
              : -placementCost(map, t as BuildKind, tile);
    });
  }
  // A public road up to the highway, meeting it head on, opens an exit there.
  let note = TOOL_NOTES[t];
  if (t === 'road') {
    const meets = tiles.filter((k, n) => {
      if (!ok[n] || map.xOf(k) !== HIGHWAY_COLUMNS) return false;
      const y = map.yOf(k);
      return ![y - 1, y + 1].some(
        (r) =>
          tiles.includes(map.idx(HIGHWAY_COLUMNS, r)) ||
          (r >= 0 && r < map.h && map.build[map.idx(HIGHWAY_COLUMNS, r)] === Build.Road),
      );
    });
    for (const k of meets) {
      const tier = snap?.progress.tier ?? 0;
      const why =
        tier < B.EXIT_TIER
          ? `exits open from the ${TIERS[B.EXIT_TIER].name}`
          : exitError(map, map.yOf(k));
      if (why)
        note = `Meets the highway, but no exit opens: ${why[0].toLowerCase()}${why.slice(1)}`;
      else {
        note = `Meets the highway: an exit opens here, for $${B.EXIT_COST.toLocaleString('en-US')}`;
        value -= B.EXIT_COST;
      }
    }
  }
  return {
    ghosts: { tiles, ok },
    arrow: null,
    hints,
    preview: {
      count: pending.size,
      rotatable: false,
      value,
      error: pending.size === 0 ? error : null,
      note: pending.size > 0 ? (landNote(map, tiles, ok) ?? note) : note,
    },
  };
}

/** One building on the hovered tile, facing the chosen (or a fitting) way. */
export function previewBuilding(
  map: GameMap,
  snap: Snapshot | null,
  kind: BuildKind,
  i: number,
  rotation: number | null,
): PreviewResult {
  const f = rotation ?? bestFacing(map, kind, i);
  let hints: Hints = [];
  if (kind === 'gantryCrane') hints = craneGroundHints(map, kind, i, f);
  if (kind === 'office' || kind === 'harbourHut') hints = dockHints(snap);
  const tiles = footprint(map, kind, i, f).filter((t) => t >= 0);
  const error = placementError(map, kind, i, undefined, f);
  let value = -placementCost(map, kind, i);
  let note = TOOL_NOTES[kind];
  const ghosts = { tiles: [...tiles], ok: tiles.map(() => !error) };
  // A truck bay is loaded from behind: a port path goes in there with it,
  // if it has no way in behind it; else it says why it would be no use.
  if (!error && (kind === 'truckBay' || kind === 'largeBay')) {
    const way = bayPath(map, kind, i, f);
    if (way.length > 0) {
      const path = way.reduce((n, t) => n + placementCost(map, 'footpath', t), 0);
      value -= path;
      ghosts.tiles.push(...way);
      ghosts.ok.push(...way.map(() => true));
      hints = [...hints, { kind: 'good', tiles: way }];
      const joined = way.some((t) =>
        map.neighbors4(t).some((n) => walkableAt(map, n) && !tiles.includes(n)),
      );
      note = joined
        ? `A port path goes in behind it, for the dockhands who load it, up to where they walk ($${path.toLocaleString('en-US')})`
        : `A port path goes in behind it, for the dockhands who load it ($${path.toLocaleString('en-US')}): join it up to the jetty`;
    } else {
      const why = bayTrouble(map, i, f);
      if (why) note = `No use here as it stands: ${why[0].toLowerCase()}${why.slice(1)}`;
    }
  }
  return {
    ghosts,
    arrow: { at: i, facing: f, tiles },
    hints,
    facing: f,
    preview: {
      count: error ? 0 : 1,
      rotatable: true,
      value,
      error,
      note,
    },
  };
}
