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

/** A group of tools behind one button in the bar, Cities: Skylines style. */
export interface Category {
  id: string;
  label: string;
  icon: IconName;
  tools: ToolDef[];
}

export const SELECT_TOOL: ToolDef = {
  tool: 'select',
  icon: 'select',
  label: 'Select',
  key: 'Esc',
  note: 'Inspect',
};

export const BULLDOZE_TOOL: ToolDef = {
  tool: 'bulldoze',
  icon: 'bulldoze',
  label: 'Bulldoze',
  key: 'B',
  note: 'Clear',
};

export const CATEGORIES: Category[] = [
  {
    id: 'roads',
    label: 'Roads',
    icon: 'road',
    tools: [
      { tool: 'road', icon: 'road', label: 'Public road', key: 'R' },
      { tool: 'footpath', icon: 'footpath', label: 'Port path', key: 'F' },
      { tool: 'forkliftLane', icon: 'lane', label: 'Forklift lane', key: 'Y' },
    ],
  },
  {
    id: 'docks',
    label: 'Docks',
    icon: 'jetty',
    tools: [
      { tool: 'jetty', icon: 'jetty', label: 'Jetty', key: 'J' },
      { tool: 'quay', icon: 'quay', label: 'Quay', key: 'G' },
      { tool: 'office', icon: 'office', label: 'Harbour office', key: 'O' },
    ],
  },
  {
    id: 'cargo',
    label: 'Cargo',
    icon: 'crane',
    tools: [
      { tool: 'truckBay', icon: 'truckBay', label: 'Truck bay', key: 'T' },
      { tool: 'largeBay', icon: 'bigTruck', label: 'Large truck bay', key: 'X' },
      { tool: 'jibCrane', icon: 'crane', label: 'Jib crane', key: 'N' },
      { tool: 'harbourCrane', icon: 'bigCrane', label: 'Harbour crane', key: 'I' },
    ],
  },
  {
    id: 'machines',
    label: 'Machines',
    icon: 'forklift',
    tools: [
      { tool: 'depot', icon: 'garage', label: 'Depot', key: 'U' },
      { tool: 'forklift', icon: 'forklift', label: 'Forklift', key: 'L' },
      { tool: 'stacker', icon: 'stacker', label: 'Reach stacker', key: 'Z' },
    ],
  },
  {
    id: 'facilities',
    label: 'Facilities',
    icon: 'hut',
    tools: [{ tool: 'breakHut', icon: 'hut', label: 'Break hut', key: 'K' }],
  },
];

export function categoryOf(t: Tool): Category | undefined {
  return CATEGORIES.find((c) => c.tools.some((d) => d.tool === t));
}

/** Lower-case key → tool, for single-letter shortcuts. */
export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(
  [...CATEGORIES.flatMap((c) => c.tools), BULLDOZE_TOOL]
    .filter((t) => t.key && t.key.length === 1)
    .map((t) => [t.key!.toLowerCase(), t.tool]),
);
