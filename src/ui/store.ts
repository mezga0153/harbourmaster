import { signal } from '@preact/signals';
import type { Snapshot } from '../protocol';
import type { BuildKind } from '../sim/types';

export type Tool = 'select' | BuildKind | 'bulldoze';

export type Selection = { type: 'entity'; id: number } | { type: 'bay'; idx: number };

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
export const newGameOpen = signal(false);
/** Which management panel is open on the right. */
export type PanelName = 'contracts' | 'staff' | 'finance';
export const panel = signal<PanelName | null>(null);

export function togglePanel(name: PanelName): void {
  panel.value = panel.value === name ? null : name;
}

let nextMessageId = 1;

export function pushMessage(text: string, tone: Message['tone']): void {
  const msg = { id: nextMessageId++, text, tone, at: Date.now() };
  messages.value = [...messages.value.slice(-5), msg];
}
