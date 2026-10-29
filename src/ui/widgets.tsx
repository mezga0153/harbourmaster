import type { ComponentChildren } from 'preact';
import { Icon } from './icons';

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
export function Why({ children }: { children: ComponentChildren }) {
  return (
    <p class="note why">
      <Icon name="alert" />
      <span>{children}</span>
    </p>
  );
}

export function Meter({ value, tone }: { value: number; tone?: string }) {
  return (
    <div class={`meter ${tone ?? ''}`}>
      <span style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}
