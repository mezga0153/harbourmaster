import type { GameMap } from '../sim/map';
import { terraformCost, terraformError } from '../sim/rules';
import { landNote } from './shared';
import type { PreviewResult } from './types';

/**
 * Dredging or reclaiming `tiles`: the same rounds as the sim, so a channel
 * dug inland from the shore fits.
 */
export function previewTerraform(map: GameMap, tiles: number[], raise: boolean): PreviewResult {
  const ok = tiles.map(() => false);
  const done = new Set<number>();
  let value = 0;
  let error: string | null = null;
  for (let progress = true; progress;) {
    progress = false;
    error = null;
    tiles.forEach((tile, k) => {
      if (ok[k]) return;
      const err = terraformError(map, tile, raise, done);
      if (err) {
        error ??= err;
        return;
      }
      ok[k] = progress = true;
      done.add(tile);
      value -= terraformCost(map, tile, raise);
    });
  }
  return {
    ghosts: { tiles, ok },
    arrow: null,
    hints: [],
    preview: {
      count: done.size,
      rotatable: false,
      value,
      error: done.size === 0 ? error : null,
      note: done.size > 0 ? landNote(map, tiles, ok) : undefined,
    },
  };
}
