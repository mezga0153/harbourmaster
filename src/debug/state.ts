import { signal } from '@preact/signals';
import { DEFAULT_PILOT, isPilot, type PilotId } from '../sim/systems/boats/pilots';
import type { DebugView, PassKind } from './types';

// Dev server only: which debug overlays are on, kept in the browser from
// one visit to the next, and the last the sim told of what they show.

export interface DebugOpts {
  /** The menu is showing. */
  open: boolean;
  /** Overlays drawn at all (the menu can be closed with them still on). */
  on: boolean;
  /** Every agent's path, not just the selected one's. */
  allPaths: boolean;
  /** What each agent is doing, written over it. */
  labels: boolean;
  /** Tile passability: for whom, 'auto' going by what is selected. */
  pass: PassKind | 'auto' | null;
  /** The view's own finer passability round the middle of the view; see fine.ts. */
  fine: string | null;
  roads: boolean;
  slots: boolean;
  cranes: boolean;
  plots: boolean;
  /** What is on the tile under the pointer. */
  hover: boolean;
  /** How ships find their way off their berths, in the game and the lab; see pilots.ts. */
  pilot: PilotId;
}

const KEY = 'hm-debug-overlays';
/** The ship pathing is kept apart, so a pick from before Navigator was the default is dropped. */
const PILOT_KEY = 'hm-debug-pilot';

const DEFAULTS: DebugOpts = {
  open: false,
  on: true,
  allPaths: false,
  labels: false,
  pass: 'auto',
  fine: null,
  roads: false,
  slots: false,
  cranes: false,
  plots: false,
  hover: true,
  pilot: DEFAULT_PILOT,
};

function load(): DebugOpts {
  try {
    const raw = localStorage.getItem(KEY);
    const pilot = localStorage.getItem(PILOT_KEY);
    return {
      ...DEFAULTS,
      ...(raw ? (JSON.parse(raw) as Partial<DebugOpts>) : {}),
      pilot: isPilot(pilot) ? pilot : DEFAULTS.pilot,
    };
  } catch {
    // No storage here: the defaults.
  }
  return DEFAULTS;
}

export const opts = signal<DebugOpts>(load());
opts.subscribe((o) => {
  try {
    const { pilot, ...rest } = o;
    localStorage.setItem(KEY, JSON.stringify(rest));
    localStorage.setItem(PILOT_KEY, pilot);
  } catch {
    // Not kept, then.
  }
});

export function setOpt<K extends keyof DebugOpts>(k: K, v: DebugOpts[K]): void {
  opts.value = { ...opts.value, [k]: v };
}

/** The sim's last answer. */
export const lastView = signal<DebugView | null>(null);
