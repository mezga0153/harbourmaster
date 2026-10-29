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
      { tool: 'portRoad', icon: 'portRoad', label: 'Port road' },
      { tool: 'portGate', icon: 'gate', label: 'Port gate' },
      { tool: 'parking', icon: 'parking', label: 'Truck parking' },
      {
        tool: 'forkliftOnly',
        icon: 'lane',
        label: 'Machines only',
        key: 'Y',
        note: `${money(B.FORKLIFT_ONLY_COST)}/tile`,
        hint: 'Drag over port roads or quays to keep them for port machines: no people on foot, so forklifts and reach stackers do not queue behind dockhands, and no hauliers’ trucks. Outlined in red, like the ground round every crane. Drag over marked tiles to clear the mark',
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
      {
        tool: 'crateStore',
        icon: 'warehouse',
        label: 'Crate storage',
        note: `${money(B.CRATE_STORE_COST)}/tile`,
        hint: `Drag out an area on port roads or quays to store crates, ${B.CRATES_PER_STORE_TILE} a tile. Forklifts and dockhands bring crates, jib cranes within ${B.JIB_REACH} tiles swing them straight in, and trucks load fast from a public road beside it or a port road behind a port gate, big trucks too: one at a time for every ${B.STORE_TILES_PER_TRUCK} tiles. Where trucks cannot get to it, forklifts take the crates on. Drag over marked tiles to clear them`,
        tier: B.CRATE_STORE_TIER,
      },
      { tool: 'jibCrane', icon: 'crane', label: 'Jib crane', key: 'N' },
      { tool: 'harbourCrane', icon: 'bigCrane', label: 'Harbour crane', key: 'I' },
      { tool: 'gantryCrane', icon: 'bigCrane', label: 'Gantry crane' },
      {
        tool: 'boxStore',
        icon: 'box',
        label: 'Container yard',
        key: 'V',
        note: `${money(B.BOX_STORE_COST)}/tile`,
        hint: `Drag out an area on port roads or quays to stack containers, ${B.BOXES_PER_STORE_TILE} a tile. Reach stackers bring them from the cranes, they wait a day for customs, and container trucks load from a public road beside it or a port road behind a port gate: one at a time for every ${B.STORE_TILES_PER_TRUCK} tiles. Drag over marked tiles to clear them`,
        tier: B.BOX_STORE_TIER,
      },
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
      { tool: 'tugBerth', icon: 'anchor', label: 'Tug berth' },
      {
        tool: 'tug',
        icon: 'anchor',
        label: 'Tugboat',
        note: money(B.TUG_PRICE),
        hint: `Click a tug berth to buy a tug there. It sails out to meet coasters and feeders and works them in alongside and out again, quickly, where on their own they swing round and come alongside slowly. ${money(B.TUG_RUNNING_COST)}/day to run`,
        tier: B.TUG_TIER,
      },
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

/** Keys that move the camera, so never a tool's shortcut. */
export const CAMERA_KEYS = ['w', 'a', 's', 'd', 'q', 'e'];

/** Lower-case key → tool, for single-letter shortcuts. */
export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(
  [...CATEGORIES.flatMap((c) => c.tools), BULLDOZE_TOOL]
    .filter((t) => t.key && t.key.length === 1)
    .map((t) => [t.key!.toLowerCase(), t.tool]),
);
