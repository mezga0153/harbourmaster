import type { Snapshot } from '../protocol';
import type { Hints } from '../render/overlay';
import { landError } from '../sim/land';
import type { GameMap } from '../sim/map';
import { craneGround } from '../sim/rules';

/** What the tints shown while placing these mean. */
export const TOOL_NOTES: Partial<Record<string, string>> = {
  parking:
    'Marked out on a road, one or two tiles wide, with road left along both long sides: trucks drive in off one and out onto the other. Green works, red does not',
  jibCrane: 'Red: machines only. Blue: crate storage here is filled straight from the boats',
  harbourCrane: 'Red: machines only, no dockhands or hauliers’ trucks',
  gantryCrane: 'Red: machines only, no dockhands or hauliers’ trucks',
};

/**
 * For a drag running off the port's land: why nothing is built on the red
 * there, and what the plot costs. Undefined when the drag stays on it.
 */
export function landNote(map: GameMap, tiles: number[], ok: boolean[]): string | undefined {
  for (let k = 0; k < tiles.length; k++) {
    const why = ok[k] ? null : landError(map, tiles[k]);
    if (why) return `Red is not the port’s land: ${why[0].toLowerCase()}${why.slice(1)}`;
  }
  return undefined;
}

/** A crane's machines-only ground in red, and how far a jib crane reaches storage in blue. */
export function craneGroundHints(
  map: GameMap,
  kind: 'jibCrane' | 'harbourCrane' | 'gantryCrane',
  i: number,
  facing: number,
): Hints {
  const { zone, reach } = craneGround(map, kind, i, facing);
  return [
    { kind: 'reach', tiles: reach },
    { kind: 'zone', tiles: zone },
  ];
}

/** Docks the harbour office coordinates in green, those boats do not use in red. */
export function dockHints(snap: Snapshot | null): Hints {
  const d = snap?.docks;
  if (!d) return [];
  return [
    { kind: 'good', tiles: d.inUse },
    { kind: 'zone', tiles: d.idle },
  ];
}

/** Parking that works in green, parking trucks cannot use in red. */
export function parkingHints(snap: Snapshot | null): Hints {
  const lots = snap?.parking ?? [];
  return [
    { kind: 'good', tiles: lots.filter((l) => !l.why).flatMap((l) => l.tiles) },
    { kind: 'zone', tiles: lots.filter((l) => l.why).flatMap((l) => l.tiles) },
  ];
}
