import { computed, effect, signal } from '@preact/signals';
import type { Snapshot } from '../protocol';
import type { Preview } from '../preview/types';
import type { Tool } from './tools';

// The UI's shared state: what the sim last sent, what the player has in
// hand, selected and open, and the game's messages. The other layers
// (debug/bridge.ts, log/) read some of these from here.

export {
  isRoadTool,
  isStoreTool,
  ROAD_TOOLS,
  STORE_TOOLS,
  type RoadTool,
  type StoreTool,
  type Tool,
} from './tools';

export type Selection =
  | { type: 'entity'; id: number }
  | { type: 'bay'; idx: number }
  | { type: 'depot'; idx: number }
  | { type: 'yard'; idx: number }
  | { type: 'crane'; idx: number }
  /** A harbour office, or (`hut`) a harbourmaster's hut. */
  | { type: 'office'; idx: number; hut?: boolean }
  | { type: 'customs'; idx: number }
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

/** What the tip over the map says about the build in hand; worked out in preview/. */
export type { Preview } from '../preview/types';

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
/** The tab last open in each category of the build menu, by the category's id. */
export const trayTabs = signal<Readonly<Record<string, string>>>({});

// Slices of the snapshot that change far less often than the snapshot
// itself, so what shows them need not redraw ten times a second.

/** The port's cash in hand. */
export const cash = computed(() => snapshot.value?.cash ?? 0);
/** The port's step, see TIERS: 0 before the first. */
export const tier = computed(() => snapshot.value?.progress.tier ?? 0);
/** The town up the coast, once there is one. */
export const town = computed(() => snapshot.value?.town ?? null);
/** What the port pays out a day: wages, haulier fees and loan interest. */
export const costsPerDay = computed(() => {
  const s = snapshot.value;
  return s ? s.wages + s.contractFees + s.interest : 0;
});
/**
 * What the player has selected, found in the snapshot: the depot, bay,
 * yard, crane, parking lot or entity itself, with the kind of selection, or
 * null for nothing, the town, the railway or something no longer there.
 */
export const selected = computed(() => {
  const sel = selection.value;
  const s = snapshot.value;
  if (!sel || !s) return null;
  switch (sel.type) {
    case 'depot':
      return { type: sel.type, item: s.depots.find((d) => d.idx === sel.idx) ?? null } as const;
    case 'bay':
      return { type: sel.type, item: s.bays.find((b) => b.idx === sel.idx) ?? null } as const;
    case 'yard':
      return { type: sel.type, item: s.yards.find((y) => y.idx === sel.idx) ?? null } as const;
    case 'crane':
      return { type: sel.type, item: s.cranes.find((c) => c.idx === sel.idx) ?? null } as const;
    case 'parking':
      return {
        type: sel.type,
        item: s.parking.find((l) => l.tiles.includes(sel.idx)) ?? null,
      } as const;
    case 'entity':
      return { type: sel.type, item: s.entities.find((e) => e.id === sel.id) ?? null } as const;
    default:
      return null;
  }
});

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

/** The contract the Contracts panel was opened on, from its red mark on the map, to show first. */
export const contractFocus = signal<number | null>(null);

/** Open the Contracts panel on contract `id`, among the active ones. */
export function openContract(id: number): void {
  contractFocus.value = id;
  contractsTab.value = 'active';
  panel.value = 'contracts';
}

// Shown first only until the panel is put away.
effect(() => {
  if (panel.value !== 'contracts') contractFocus.value = null;
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

// One panel open at a time: opening one puts away what was selected, and
// selecting something puts away the panel, rather than leaving it to come
// back when the other is closed.
effect(() => {
  if (panel.value) selection.value = null;
});
effect(() => {
  if (selection.value) panel.value = null;
});

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
