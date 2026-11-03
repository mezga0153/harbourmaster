import type { PanelName } from '../ui/store';
import { keyTool, type Tool } from '../ui/tools';

// The keyboard: one table of what each key does, which the top bar and the
// build bar read for the hints they show, so a key and its hint never part.
// The build tools' own letters are on the tools themselves (ui/tools.ts).

export type KeyAction =
  | { type: 'speed'; speed: number }
  | { type: 'pause' }
  | { type: 'rotateView'; dir: 1 | -1 }
  | { type: 'zoom'; factor: number }
  | { type: 'panel'; panel: PanelName }
  /** Put the tool down, close the panel and the build menu, select nothing. */
  | { type: 'escape' }
  /** Pick a tool up (`toggle`: or put it down again, and show its category). */
  | { type: 'tool'; tool: Tool; toggle: boolean }
  /** A million, a cheat for testing or for fun. */
  | { type: 'debugCash' };

export interface Shortcut {
  /** The key, lower case, as KeyboardEvent.key gives it. */
  key: string;
  /** Only with Shift held; without it a key matches whether or not Shift is held. */
  shift?: boolean;
  /** Only on the dev server. */
  dev?: boolean;
  /** How the key is shown in a hint. */
  label: string;
  action: KeyAction;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { key: 'q', label: 'Q', action: { type: 'rotateView', dir: -1 } },
  { key: 'e', label: 'E', action: { type: 'rotateView', dir: 1 } },
  { key: ' ', label: 'Space', action: { type: 'pause' } },
  { key: '1', label: '1', action: { type: 'speed', speed: 1 } },
  { key: '2', label: '2', action: { type: 'speed', speed: 2 } },
  { key: '3', label: '3', action: { type: 'speed', speed: 4 } },
  { key: '4', label: '4', action: { type: 'speed', speed: 8 } },
  { key: 'escape', label: 'Esc', action: { type: 'escape' } },
  { key: 'delete', label: 'Del', action: { type: 'tool', tool: 'bulldoze', toggle: false } },
  { key: 'backspace', label: 'Del', action: { type: 'tool', tool: 'bulldoze', toggle: false } },
  { key: 'h', label: 'H', action: { type: 'panel', panel: 'staff' } },
  { key: 'c', label: 'C', action: { type: 'panel', panel: 'contracts' } },
  { key: 'm', label: 'M', shift: true, action: { type: 'debugCash' } },
  { key: 'm', label: 'M', action: { type: 'panel', panel: 'finance' } },
  { key: 'p', label: 'P', action: { type: 'panel', panel: 'port' } },
  { key: '?', label: '?', action: { type: 'panel', panel: 'handbook' } },
  { key: '+', label: '+', action: { type: 'zoom', factor: 1 / 1.2 } },
  { key: '=', label: '+', action: { type: 'zoom', factor: 1 / 1.2 } },
  { key: '-', label: '−', action: { type: 'zoom', factor: 1.2 } },
];

/** The game's speeds, in the order of the number keys that pick them. */
export const SPEEDS: readonly { speed: number; label: string; key: string }[] = SHORTCUTS.flatMap(
  (s) =>
    s.action.type === 'speed'
      ? [{ speed: s.action.speed, label: `${s.action.speed}×`, key: s.label }]
      : [],
);

/** The key that pauses the game, for its hint. */
export const PAUSE_KEY = SHORTCUTS.find((s) => s.action.type === 'pause')!.label;

/** The key that opens a panel, as shown in its hint, if it has one. */
export function panelKey(panel: PanelName): string | undefined {
  return SHORTCUTS.find((s) => s.action.type === 'panel' && s.action.panel === panel)?.label;
}

/** " (H)" to end a panel's hint with, or nothing for a panel with no key. */
export function keyHint(panel: PanelName): string {
  const k = panelKey(panel);
  return k ? ` (${k})` : '';
}

/**
 * What a key press does, if anything: the table first, then the build
 * tools' own letters, for those the port has come to at step `tier`.
 */
export function keyAction(e: KeyboardEvent, tier: number, dev: boolean): KeyAction | null {
  const k = e.key.toLowerCase();
  const hit = SHORTCUTS.find((s) => s.key === k && (!s.shift || e.shiftKey) && (!s.dev || dev));
  if (hit) return hit.action;
  const t = keyTool(k, tier);
  return t ? { type: 'tool', tool: t, toggle: true } : null;
}
