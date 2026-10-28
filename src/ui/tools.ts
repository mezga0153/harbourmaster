import * as B from '../sim/balance';
import type { IconName } from './icons';
import { money } from './format';
import type { Tool } from './store';

export interface ToolDef {
  tool: Tool;
  icon: IconName;
  label: string;
  /** Keyboard shortcut, shown on the button. */
  key?: string;
  note?: string;
  /** For tools that are not buildings or machines. */
  hint?: string;
  tier?: number;
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
      { tool: 'portRoad', icon: 'portRoad', label: 'Port road', key: 'W' },
      { tool: 'portGate', icon: 'gate', label: 'Port gate' },
      {
        tool: 'forkliftOnly',
        icon: 'lane',
        label: 'Forklift only',
        key: 'Y',
        note: `${money(B.FORKLIFT_ONLY_COST)}/tile`,
        hint: 'Drag over port roads or quays to keep people on foot off them, so forklifts do not queue behind dockhands. Drag over marked tiles to clear the mark',
        tier: B.FORKLIFT_ONLY_TIER,
      },
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
      { tool: 'buoyIn', icon: 'buoyIn', label: 'Buoy: way in' },
      { tool: 'buoyOut', icon: 'buoyOut', label: 'Buoy: way out' },
      {
        tool: 'dredge',
        icon: 'dredge',
        label: 'Dredge',
        note: `${money(B.DREDGE_COST)}/tile`,
        hint: `Dig the seabed ${B.TERRAFORM_STEP} m deeper (up to ${B.MAX_DREDGE_DEPTH} m), so bigger ships can come in, or dig the shore out into sea (${money(B.DIG_LAND_COST)}). Drag inland from the water's edge to cut a channel. Expensive`,
        tier: B.TERRAFORM_TIER,
      },
      {
        tool: 'reclaim',
        icon: 'reclaim',
        label: 'Reclaim',
        note: `${money(B.RECLAIM_COST)}/tile`,
        hint: `Fill the seabed in ${B.TERRAFORM_STEP} m at a time, until it is dry land you can build on, or shallow enough for a jetty or quay. Expensive`,
        tier: B.TERRAFORM_TIER,
      },
    ],
  },
  {
    id: 'cargo',
    label: 'Cargo',
    icon: 'crane',
    tools: [
      { tool: 'truckBay', icon: 'truckBay', label: 'Truck bay', key: 'T' },
      { tool: 'largeBay', icon: 'bigTruck', label: 'Large truck bay', key: 'X' },
      { tool: 'warehouse', icon: 'warehouse', label: 'Warehouse' },
      { tool: 'jibCrane', icon: 'crane', label: 'Jib crane', key: 'N' },
      { tool: 'harbourCrane', icon: 'bigCrane', label: 'Harbour crane', key: 'I' },
      { tool: 'containerYard', icon: 'box', label: 'Container yard', key: 'V' },
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
