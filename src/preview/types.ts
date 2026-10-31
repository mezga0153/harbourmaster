import type { Hints } from '../render/overlay';

// What a tool in hand shows before anything is built: worked out here from
// the map and the last snapshot alone, with nothing drawn and nothing read
// from the UI's state, so the rules can be tested on their own. input.ts
// hands the result to the renderer and the tip.

/** What the tip over the map says about the build in hand. */
export interface Preview {
  count: number;
  /** The tool places a building that can be turned. */
  rotatable: boolean;
  /** Money spent (negative) or refunded (positive). */
  value: number;
  error: string | null;
  /** How what is being built will work, shown under the cost. */
  note?: string;
  /** What is counted, if not tiles. */
  unit?: string;
}

export interface PreviewResult {
  /** The tiles the tool would touch, each tinted by whether it works there. */
  ghosts: { tiles: number[]; ok: boolean[] };
  /** An arrow on a tile for which way something faces or flows. */
  arrow: { at: number; facing: number; tiles?: number[] } | null;
  /** Tints explaining the tool: a crane's ground, the docks, where trucks load. */
  hints: Hints;
  /** The tip's words, or nothing to say. */
  preview: Preview | null;
  /** Which way the building shown faces, for the build command to send. */
  facing?: number;
}

/** Nothing in hand, or the pointer off the map. */
export const NOTHING: PreviewResult = {
  ghosts: { tiles: [], ok: [] },
  arrow: null,
  hints: [],
  preview: null,
};
