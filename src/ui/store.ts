import { signal } from '@preact/signals';
import type { Snapshot } from '../protocol';
import type { BuildKind, MachineKind } from '../sim/types';

export type Tool =
  'select' | BuildKind | MachineKind | 'bulldoze' | 'forkliftOnly' | 'dredge' | 'reclaim';

export type Selection =
  | { type: 'entity'; id: number }
  | { type: 'bay'; idx: number }
  | { type: 'depot'; idx: number }
  | { type: 'yard'; idx: number };

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
export type PanelName = 'contracts' | 'staff' | 'finance' | 'port';
export const panel = signal<PanelName | null>(null);

export function togglePanel(name: PanelName): void {
  panel.value = panel.value === name ? null : name;
}

let nextMessageId = 1;

export function pushMessage(text: string, tone: Message['tone']): void {
  const msg = { id: nextMessageId++, text, tone, at: Date.now() };
  messages.value = [...messages.value.slice(-5), msg];
}
