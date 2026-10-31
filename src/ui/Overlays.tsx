import { useEffect, useState } from 'preact/hooks';
import * as B from '../sim/balance';
import { Terrain } from '../sim/types';
import { money } from './format';
import { Icon } from './icons';
import { hover, messages, openCategory, preview, snapshot } from './store';

/** How long a message shows before it fades. */
const MESSAGE_MS = 9000;

// What floats over the map without a panel of its own: the cost of what is
// being built, what is under the pointer, the game's messages and the bank's
// warning.

const TERRAIN_NAMES: Record<number, string> = {
  [Terrain.Water]: 'Water',
  [Terrain.Sand]: 'Sand',
  [Terrain.Grass]: 'Grass',
  [Terrain.Rock]: 'Rock',
};

export function BankBanner() {
  const s = snapshot.value;
  if (!s || s.daysInRed === 0 || s.bankrupt) return null;
  const left = B.BANKRUPT_DAYS - s.daysInRed;
  return (
    <div class="banner" role="alert">
      <Icon name="alert" />
      <span>
        In the red. The bank closes the port in{' '}
        <strong>
          {left} day{left === 1 ? '' : 's'}
        </strong>{' '}
        unless cash is back above $0.
      </span>
    </div>
  );
}

export function Messages() {
  const all = messages.value;
  const [now, setNow] = useState(Date.now());
  // Redrawn when the oldest message still showing is due to go, not with
  // every snapshot.
  useEffect(() => {
    const due = all.map((m) => m.at + MESSAGE_MS).filter((t) => t > now);
    if (due.length === 0) return;
    const wait = Math.max(0, Math.min(...due) - Date.now()) + 1;
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [all, now]);
  const live = all.filter((m) => now - m.at < MESSAGE_MS);
  return (
    <div class="messages" aria-live="polite">
      {live.map((m) => (
        <div key={m.id} class={`message panel ${m.tone}`}>
          {m.text}
        </div>
      ))}
    </div>
  );
}

export function PreviewTip() {
  const p = preview.value;
  if (!p) return null;
  if (p.error) {
    return (
      <div class={`tip preview bad ${openCategory.value ? 'raised' : ''}`}>
        <Icon name="alert" />
        {p.error}
        {p.rotatable && <span class="muted">Right-click to rotate</span>}
      </div>
    );
  }
  if (p.count === 0) return null;
  return (
    <div class={`tip preview ${openCategory.value ? 'raised' : ''}`}>
      {!p.rotatable && (
        <span class="muted">
          {p.count === 1 ? `1 ${p.unit ?? 'tile'}` : `${p.count} ${p.unit ?? 'tile'}s`}
        </span>
      )}
      <strong class={p.value < 0 ? 'neg' : 'pos'}>{money(p.value)}</strong>
      {p.rotatable && <span class="muted">Right-click to rotate</span>}
      {p.note && <span class="muted">{p.note}</span>}
    </div>
  );
}

export function HoverTip() {
  const h = hover.value;
  if (!h) return null;
  return (
    <div class="tip hovertip">
      <span class="muted">
        {h.x}, {h.y}
      </span>
      <span>{TERRAIN_NAMES[h.terrain]}</span>
      {h.terrain === Terrain.Water && <span class="muted">{h.depth.toFixed(1)} m deep</span>}
    </div>
  );
}
