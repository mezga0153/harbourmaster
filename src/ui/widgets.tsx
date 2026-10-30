import type { ComponentChildren } from 'preact';
import { Icon } from './icons';
import { openHandbook, panel } from './store';

/** Finance and statistics, one panel apiece behind the cash: a switch between them. */
export function MoneyTabs({ on }: { on: 'finance' | 'stats' }) {
  return (
    <div class="segmented money-tabs" role="tablist" aria-label="Money and statistics">
      <button
        role="tab"
        aria-selected={on === 'finance'}
        class={on === 'finance' ? 'on' : ''}
        onClick={() => (panel.value = 'finance')}
      >
        Finance
      </button>
      <button
        role="tab"
        aria-selected={on === 'stats'}
        class={on === 'stats' ? 'on' : ''}
        onClick={() => (panel.value = 'stats')}
      >
        Statistics
      </button>
    </div>
  );
}

export function InfoHeader({
  title,
  kicker,
  onClose,
}: {
  title: ComponentChildren;
  kicker?: string;
  onClose: () => void;
}) {
  return (
    <div class="side-head">
      <div>
        {kicker && <div class="kicker">{kicker}</div>}
        <h2>{title}</h2>
      </div>
      <button class="btn icon ghost" onClick={onClose} aria-label="Close">
        <Icon name="close" />
      </button>
    </div>
  );
}

/** Why something is held up, and what would help. */
export function Why({ children, topic }: { children: ComponentChildren; topic?: string }) {
  return (
    <p class="note why">
      <Icon name="alert" />
      <span>
        {children} {topic && <More topic={topic} />}
      </span>
    </p>
  );
}

/** A link to a page of the handbook. */
export function More({ topic, label = 'More' }: { topic: string; label?: string }) {
  return (
    <button class="link" onClick={() => openHandbook(topic)}>
      {label} ›
    </button>
  );
}

export function Meter({ value, tone }: { value: number; tone?: string }) {
  return (
    <div class={`meter ${tone ?? ''}`}>
      <span style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}
