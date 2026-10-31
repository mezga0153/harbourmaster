import * as B from '../sim/balance';
import { isMachineKind } from '../sim/machines';
import { BUILDABLES } from '../sim/rules';
import { BUILD_TIER, MACHINE_TIER } from '../sim/tiers';
import type { BuildKind, MachineKind, StoreKind } from '../sim/types';
import type { IconName } from './icons';
import { money } from './format';

// The tools the player can pick up: what each is, and the catalogue of them
// the bar at the bottom shows, by category.

/** Tools that mark port roads and quays out as storage. */
export const STORE_TOOLS = {
  crateStore: 'crates',
  crateOutStore: 'cratesOut',
  boxStore: 'boxes',
  boxOutStore: 'boxesOut',
} as const satisfies Record<string, StoreKind>;
export type StoreTool = keyof typeof STORE_TOOLS;

export function isStoreTool(t: string): t is StoreTool {
  return t in STORE_TOOLS;
}

export type Tool =
  | 'select'
  | BuildKind
  | MachineKind
  | 'tug'
  | StoreTool
  | 'bulldoze'
  | 'unmark'
  | 'forkliftOnly'
  | 'dredge'
  | 'reclaim'
  /** Buying plots of land for the port; see land.ts. */
  | 'land'
  | RoadTool;

/** Tools for the rules of the road rather than for building. */
export type RoadTool = 'highwayExit' | 'oneWay' | 'lights' | 'roundabout' | 'gateWay';
export const ROAD_TOOLS: readonly RoadTool[] = [
  'highwayExit',
  'oneWay',
  'lights',
  'roundabout',
  'gateWay',
];
export function isRoadTool(t: Tool): t is RoadTool {
  return (ROAD_TOOLS as readonly string[]).includes(t);
}

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
  /** The tab of its category it is under in the build menu. */
  group?: string;
  /** What it costs to run, a day. */
  upkeep?: number;
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

export const UNMARK_TOOL: ToolDef = {
  tool: 'unmark',
  icon: 'eraser',
  label: 'Unmark',
  note: 'Clear marks',
  hint: 'Drag over storage areas, machines-only ground, one-way roads and traffic lights to clear their marks, whatever kind they are, leaving the port road or quay as it was. Storage gives back what bulldozing it would; cargo stored on cleared tiles is lost. The ground round cranes and a gantry crane’s rails stays kept for port machines',
};

export const LAND_TOOL: ToolDef = {
  tool: 'land',
  icon: 'map',
  label: 'Land',
  note: 'Buy plots',
  hint: `The port builds only on land it owns, in plots of ${B.PLOT_SIZE}×${B.PLOT_SIZE} tiles. Click a plot outlined in yellow, beside the port’s own land, to buy it. Each plot costs ${Math.round((B.PLOT_PRICE_RISE - 1) * 100)}% more than the one before; a plot all of sea is a seabed lease, for ${Math.round(B.SEA_PLOT_SHARE * 100)}% of the price of land`,
};

export const CATEGORIES: Category[] = [
  {
    id: 'roads',
    label: 'Roads',
    icon: 'road',
    tools: [
      { tool: 'road', icon: 'road', label: 'Public road', key: 'R', group: 'Roads' },
      { tool: 'footpath', icon: 'footpath', label: 'Port path', key: 'F', group: 'Roads' },
      { tool: 'portRoad', icon: 'portRoad', label: 'Port road', group: 'Roads' },
      { tool: 'portGate', icon: 'gate', label: 'Port gate', group: 'Roads' },
      { tool: 'parking', icon: 'parking', label: 'Truck parking', group: 'Areas' },
      {
        tool: 'forkliftOnly',
        group: 'Areas',
        icon: 'lane',
        label: 'Machines only',
        key: 'Y',
        note: `${money(B.FORKLIFT_ONLY_COST)}/tile`,
        hint: 'Drag over port roads or quays to keep them for port machines: no people on foot, so forklifts and reach stackers do not queue behind dockhands, and no hauliers’ trucks. Outlined in red, like the ground round every crane. Drag over marked tiles to clear the mark',
        tier: B.FORKLIFT_ONLY_TIER,
      },
      {
        tool: 'oneWay',
        group: 'Traffic',
        icon: 'oneWay',
        label: 'One-way road',
        note: `${money(B.ONE_WAY_COST)}/tile`,
        hint: 'Drag along a public road or port road the way the trucks should go. Arrows on the road show it. Trucks may turn into and out of it but never drive against it, nor turn round on it, and traffic going on along a one-way road has the right of way where others join it. Click a one-way tile to turn it round; the Unmark tool makes roads two way again',
        tier: B.ONE_WAY_TIER,
      },
      {
        tool: 'gateWay',
        group: 'Traffic',
        icon: 'gate',
        label: 'One-way gate',
        note: money(B.GATE_WAY_COST),
        hint: 'Click a port gate to let trucks only in through it, then only out, then both ways again. With one gate in and another out, trucks coming and going never meet in the gateway',
        tier: B.ONE_WAY_TIER,
      },
      {
        tool: 'lights',
        group: 'Traffic',
        icon: 'lights',
        label: 'Traffic lights',
        note: money(B.LIGHTS_COST),
        hint: 'Click a junction of three or four roads to put up traffic lights, and again to take them down. Trucks going north and south, then east and west, take turns on green, with all red between to clear the junction, rather than giving way to whoever comes from the right',
        tier: B.LIGHTS_TIER,
      },
      {
        tool: 'roundabout',
        group: 'Traffic',
        icon: 'roundabout',
        label: 'Roundabout',
        note: `from ${money(B.ROUNDABOUT_COST)}`,
        hint: 'Click a crossroads, or any 3×3 of public road and clear land, to lay a ring of one-way road round an island in the middle. Trucks go round it anticlockwise, keeping right; those coming onto it give way to those already on it. Trucks that need to turn about can go round it',
        tier: B.LIGHTS_TIER,
      },
      {
        tool: 'highwayExit',
        group: 'Traffic',
        icon: 'exit',
        label: 'Highway exit',
        note: money(B.EXIT_COST),
        hint: `Click the highway down the west edge of the map to open a new exit off it, with a public road beside it to build on from; a public road built up to the highway opens one too. Trucks come in off the highway's nearer end and take the exit nearest where they are going. Exits are at least 6 tiles apart. Out on the highway trucks drive fast and pass through each other, so it never jams; bulldoze an exit to close it`,
        tier: B.EXIT_TIER,
      },
    ],
  },
  {
    id: 'docks',
    label: 'Docks',
    icon: 'jetty',
    tools: [
      { tool: 'jetty', icon: 'jetty', label: 'Jetty', key: 'J', group: 'Docks' },
      { tool: 'quay', icon: 'quay', label: 'Quay', key: 'G', group: 'Docks' },
      { tool: 'harbourHut', icon: 'office', label: "Harbourmaster's hut", group: 'Docks' },
      { tool: 'office', icon: 'office', label: 'Harbour office', key: 'O', group: 'Docks' },
      { tool: 'buoyIn', icon: 'buoyIn', label: 'Buoy: way in', group: 'Channel' },
      { tool: 'buoyOut', icon: 'buoyOut', label: 'Buoy: way out', group: 'Channel' },
      {
        tool: 'dredge',
        group: 'Terraform',
        icon: 'dredge',
        label: 'Dredge',
        note: `${money(B.DREDGE_COST)}/tile`,
        hint: `Dig the seabed ${B.TERRAFORM_STEP} m deeper (up to ${B.MAX_DREDGE_DEPTH} m), so bigger ships can come in, or dig the shore out into sea (${money(B.DIG_LAND_COST)}). Drag inland from the water's edge to cut a channel. Expensive`,
        tier: B.TERRAFORM_TIER,
      },
      {
        tool: 'reclaim',
        group: 'Terraform',
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
      { tool: 'truckBay', icon: 'truckBay', label: 'Truck bay', key: 'T', group: 'Truck bays' },
      {
        tool: 'largeBay',
        icon: 'bigTruck',
        label: 'Large truck bay',
        key: 'X',
        group: 'Truck bays',
      },
      {
        tool: 'crateStore',
        group: 'Storage',
        icon: 'warehouse',
        label: 'Crate storage: in',
        note: `${money(B.CRATE_STORE_COST)}/tile`,
        hint: `Drag out an area on port roads or quays to store crates coming in off the ships, ${B.CRATES_PER_STORE_TILE} a tile. Forklifts and dockhands bring crates, jib cranes within ${B.JIB_REACH} tiles swing them straight in, and trucks load fast from a port road or quay beside it, inside the port through a port gate, big trucks too: one at a time for every ${B.STORE_TILES_PER_TRUCK} tiles. Where trucks cannot get to it, forklifts take the crates on. Drag over marked tiles to clear them`,
        tier: B.CRATE_STORE_TIER,
      },
      {
        tool: 'crateOutStore',
        group: 'Storage',
        icon: 'warehouse',
        label: 'Crate storage: out',
        note: `${money(B.CRATE_STORE_COST)}/tile`,
        hint: `Drag out an area on port roads or quays for crates going out on the coasters, ${B.CRATES_PER_STORE_TILE} a tile, outlined in blue. Shippers' trucks unload into it from inside the port; dockhands carry the crates on board, forklifts bring them to the quay or to storage by a jib crane, and jib cranes lift them on from storage in reach. Kept apart from storage for crates coming in. Drag over marked tiles to clear them`,
        tier: B.CRATE_STORE_TIER,
      },
      {
        tool: 'jibCrane',
        icon: 'crane',
        label: 'Jib crane',
        key: 'N',
        group: 'Cranes',
        upkeep: B.CRANE_RUNNING_COST,
      },
      {
        tool: 'harbourCrane',
        icon: 'bigCrane',
        label: 'Harbour crane',
        key: 'I',
        group: 'Cranes',
        upkeep: B.HARBOUR_CRANE_RUNNING_COST,
      },
      {
        tool: 'gantryCrane',
        icon: 'bigCrane',
        label: 'Gantry crane',
        group: 'Cranes',
        upkeep: B.GANTRY_RUNNING_COST,
      },
      {
        tool: 'yardGantry',
        icon: 'bigCrane',
        label: 'Yard gantry',
        group: 'Cranes',
        upkeep: B.YARD_GANTRY_RUNNING_COST,
      },
      {
        tool: 'boxStore',
        group: 'Storage',
        icon: 'box',
        label: 'Container yard: in',
        key: 'V',
        note: `${money(B.BOX_STORE_COST)}/tile`,
        hint: `Drag out an area on port roads or quays to stack containers coming in off the ships, ${B.BOXES_PER_STORE_TILE} a tile. Reach stackers bring them from the cranes, they wait for customs, a day from when their ship is unloaded, and container trucks load from a port road or quay beside it, inside the port through a port gate: one at a time for every ${B.STORE_TILES_PER_TRUCK} tiles. Drag over marked tiles to clear them`,
        tier: B.BOX_STORE_TIER,
      },
      {
        tool: 'boxOutStore',
        group: 'Storage',
        icon: 'box',
        label: 'Container yard: out',
        note: `${money(B.BOX_STORE_COST)}/tile`,
        hint: `Drag out an area on port roads or quays for containers going out on the feeders, ${B.BOXES_PER_STORE_TILE} a tile, outlined in blue. Shippers' trucks unload into it from inside the port, and reach stackers take the containers to the crane over the ship. Kept apart from yards for containers coming in. Drag over marked tiles to clear them`,
        tier: B.BOX_STORE_TIER,
      },
    ],
  },
  {
    id: 'machines',
    label: 'Machines',
    icon: 'forklift',
    tools: [
      { tool: 'depot', icon: 'garage', label: 'Depot', key: 'U', group: 'Machines' },
      { tool: 'forklift', icon: 'forklift', label: 'Forklift', key: 'L', group: 'Machines' },
      { tool: 'stacker', icon: 'stacker', label: 'Reach stacker', key: 'Z', group: 'Machines' },
      { tool: 'tractor', icon: 'tractor', label: 'Terminal tractor', group: 'Machines' },
      { tool: 'tugBerth', icon: 'anchor', label: 'Tug berth', group: 'Tugs' },
      {
        tool: 'tug',
        group: 'Tugs',
        upkeep: B.TUG_RUNNING_COST,
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

/** The port's step up a tool comes with, see TIERS. */
export function toolTier(t: ToolDef): number {
  if (t.tool in BUILDABLES) return BUILD_TIER[t.tool as BuildKind];
  if (isMachineKind(t.tool)) return MACHINE_TIER[t.tool];
  return t.tier ?? 0;
}

/** The tools of a category the port has come to, at step `tier`: the rest are not shown at all. */
export function toolsAt(cat: Category, tier: number): ToolDef[] {
  return cat.tools.filter((t) => toolTier(t) <= tier);
}

/** The tool a shortcut picks up, if the port has come to it yet. */
export function keyTool(key: string, tier: number): Tool | undefined {
  const t = TOOL_KEYS[key];
  const def = t && [...CATEGORIES.flatMap((c) => c.tools), BULLDOZE_TOOL].find((d) => d.tool === t);
  return def && toolTier(def) <= tier ? t : undefined;
}

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
