import type { Snapshot } from '../protocol';
import type { GameMap } from '../sim/map';
import { ROTATABLE } from '../sim/rules';
import type { BuildKind } from '../sim/types';
import { isRoadTool, isStoreTool, type Tool } from '../ui/tools';
import { previewBuild, previewBuilding } from './build';
import { previewLand } from './land';
import { previewMarking, previewStore, previewUnmark } from './marks';
import { previewRoad } from './roads';
import { previewTerraform } from './terraform';
import { NOTHING, type PreviewResult } from './types';

export type { Preview, PreviewResult } from './types';

/**
 * What tool `t` would do at `i`, the hovered tile, over `tiles` (the drag
 * from `start`, or just `i`), with the building turned to `rotation` if the
 * player has turned it.
 */
export function previewFor(
  map: GameMap,
  snap: Snapshot | null,
  t: Tool,
  i: number | null,
  tiles: number[],
  start: number,
  rotation: number | null,
): PreviewResult {
  if (t === 'select' || i === null) return NOTHING;
  if (t === 'land') return previewLand(map, snap?.cash ?? 0, i);
  if (ROTATABLE.has(t as BuildKind)) return previewBuilding(map, snap, t as BuildKind, i, rotation);
  if (t === 'forkliftOnly') return previewMarking(map, tiles, start);
  if (isRoadTool(t)) return previewRoad(map, snap?.progress.tier ?? 0, t, tiles);
  if (t === 'unmark') return previewUnmark(map, tiles);
  if (isStoreTool(t)) return previewStore(map, t, tiles, start);
  if (t === 'dredge' || t === 'reclaim') return previewTerraform(map, tiles, t === 'reclaim');
  return previewBuild(map, snap, t, tiles, i);
}
