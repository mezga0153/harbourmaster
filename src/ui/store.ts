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
  | 'reclaim';

export type Selection =
  | { type: 'entity'; id: number }
  | { type: 'bay'; idx: number }
  | { type: 'depot'; idx: number }
  | { type: 'yard'; idx: number }
  | { type: 'crane'; idx: number }
  | { type: 'office'; idx: number }
  | { type: 'parking'; idx: number }
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
/** The build category whose tools are showing above the bar. */
export const openCategory = signal<string | null>(null);
/** Which management panel is open on the right. */
export type PanelName = 'contracts' | 'staff' | 'finance' | 'port' | 'handbook';
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
