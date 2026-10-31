import { signal } from '@preact/signals';
import type { Snapshot } from '../protocol';
import type { BuildKind, MachineKind, StoreKind } from '../sim/types';

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

export type Selection =
  | { type: 'entity'; id: number }
  | { type: 'bay'; idx: number }
  | { type: 'depot'; idx: number }
  | { type: 'yard'; idx: number }
  | { type: 'crane'; idx: number }
  /** A harbour office, or (`hut`) a harbourmaster's hut. */
  | { type: 'office'; idx: number; hut?: boolean }
  | { type: 'parking'; idx: number }
  | { type: 'yardGantry'; idx: number }
  | { type: 'town' }
  | { type: 'railway' };

export interface Message {
  id: number;
  text: string;
  tone: 'info' | 'good' | 'bad';
  at: number;
}

export interface HoverInfo {
  x: number;
  y: number;
  terrain: number;
  depth: number;
}

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

export const snapshot = signal<Snapshot | null>(null);
export const seed = signal(0);
export const tool = signal<Tool>('select');
export const selection = signal<Selection | null>(null);
export const messages = signal<Message[]>([]);
export const hover = signal<HoverInfo | null>(null);
export const preview = signal<Preview | null>(null);
/** Which way the next building faces; null picks a way that fits. */
export const rotation = signal<number | null>(null);
export const newGameOpen = signal(false);
/** The port's land: plots owned, and what the next plot of land and of seabed costs. */
export const land = signal<{
  owned: number;
  next: number;
  nextSea: number;
  /** The plot of land after the next. */
  after: number;
} | null>(null);
/** A plot of land the player has clicked to buy, to ask first; see Land.tsx. */
export const landOffer = signal<{ plot: number; price: number; sea: boolean } | null>(null);
/** The build category whose tools are showing above the bar. */
export const openCategory = signal<string | null>(null);
/** Which management panel is open on the right. */
export type PanelName =
  | 'contracts'
  | 'staff'
  | 'finance'
  | 'stats'
  | 'port'
  | 'handbook'
  | 'settings'
  /** Telling us about a bug or an idea: see Feedback.tsx. */
  | 'feedback';
export const panel = signal<PanelName | null>(null);
/** The Contracts panel tab last open, kept for next time, in this browser too. */
export type ContractsTab = 'overview' | 'active' | 'offers' | 'rules';
const TAB_KEY = 'harbourmaster.contractsTab';
function savedTab(): ContractsTab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (t === 'overview' || t === 'active' || t === 'offers' || t === 'rules') return t;
  } catch {
    // No storage here: start on the overview.
  }
  return 'overview';
}
export const contractsTab = signal<ContractsTab>(savedTab());
contractsTab.subscribe((t) => {
  try {
    localStorage.setItem(TAB_KEY, t);
  } catch {
    // Remembered for this visit only.
  }
});

/** The handbook page open; see Handbook.tsx. */
export const handbookTopic = signal('start');

export function openHandbook(topic: string): void {
  handbookTopic.value = topic;
  panel.value = 'handbook';
}

export function togglePanel(name: PanelName): void {
  panel.value = panel.value === name ? null : name;
}

/** The menu behind the hamburger, on a phone: open or not. */
export const menuOpen = signal(false);

const NARROW = '(max-width: 760px)';
/** A phone-sized screen: the menus go behind the hamburger and panels rise from the bottom. */
export const narrow = signal(typeof matchMedia === 'function' && matchMedia(NARROW).matches);
if (typeof matchMedia === 'function') {
  matchMedia(NARROW).addEventListener('change', (e) => (narrow.value = e.matches));
}

/** Advisor tips waiting to be read, the first showing; see Advisor.tsx. */
export const advice = signal<string[]>([]);

export function advise(id: string): void {
  if (!advice.value.includes(id)) advice.value = [...advice.value, id];
}

let nextMessageId = 1;

export function pushMessage(text: string, tone: Message['tone']): void {
  const msg = { id: nextMessageId++, text, tone, at: Date.now() };
  messages.value = [...messages.value.slice(-5), msg];
}
