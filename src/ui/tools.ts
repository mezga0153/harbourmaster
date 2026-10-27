import type { IconName } from './icons';
import type { Tool } from './store';

export interface ToolDef {
  tool: Tool;
  icon: IconName;
  label: string;
  /** Keyboard shortcut, shown on the button. */
  key?: string;
  note?: string;
}

export const TOOL_GROUPS: ToolDef[][] = [
  [{ tool: 'select', icon: 'select', label: 'Select', key: 'Esc', note: 'Inspect' }],
  [
    { tool: 'road', icon: 'road', label: 'Road', key: 'R' },
    { tool: 'footpath', icon: 'footpath', label: 'Path', key: 'F' },
    { tool: 'jetty', icon: 'jetty', label: 'Jetty', key: 'J' },
    { tool: 'truckBay', icon: 'truckBay', label: 'Truck bay', key: 'T' },
  ],
  [{ tool: 'bulldoze', icon: 'bulldoze', label: 'Bulldoze', key: 'B', note: 'Clear' }],
];

/** Lower-case key → tool, for single-letter shortcuts. */
export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(
  TOOL_GROUPS.flat()
    .filter((t) => t.key && t.key.length === 1)
    .map((t) => [t.key!.toLowerCase(), t.tool]),
);
