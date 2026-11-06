import { useState } from 'preact/hooks';
import * as B from '../sim/balance';
import type { Actions } from './actions';
import { formatDate, money } from './format';
import { newGameOpen, seed, snapshot } from './store';
import { InfoHeader } from './widgets';

// Dialogs over the whole game: starting a new port, and the bank closing this one.

export function NewGameDialog({ actions }: { actions: Actions }) {
  const [value, setValue] = useState(String(Math.floor(Math.random() * 1_000_000)));
  const [level, setLevel] = useState<B.Difficulty>(snapshot.value?.difficulty ?? 'medium');
  const close = () => (newGameOpen.value = false);
  const start = () => {
    const n = Number.parseInt(value, 10);
    actions.send({
      type: 'newGame',
      seed: Number.isFinite(n) ? Math.abs(n) : undefined,
      difficulty: level,
    });
    close();
  };
  return (
    <div class="backdrop" onClick={close}>
      <div
        class="dialog panel"
        role="dialog"
        aria-labelledby="newgame-title"
        onClick={(e) => e.stopPropagation()}
      >
        <InfoHeader kicker="Sandbox" title="New port" onClose={close} />
        <p class="muted" id="newgame-title">
          Every seed makes a different coastline. Your current port is replaced. Current seed:{' '}
          <strong>{seed.value}</strong>
        </p>
        <label class="field">
          <span class="field-label">Seed</span>
          <div class="row">
            <input
              value={value}
              inputMode="numeric"
              onInput={(e) => setValue(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && start()}
            />
            <button
              class="btn"
              onClick={() => setValue(String(Math.floor(Math.random() * 1_000_000)))}
            >
              Random
            </button>
          </div>
        </label>
        <div class="field">
          <span class="field-label">Sea</span>
          <div class="segmented" role="group" aria-label="Sea">
            {B.DIFFICULTY_ORDER.map((d) => (
              <button
                key={d}
                class={level === d ? 'on' : ''}
                aria-pressed={level === d}
                onClick={() => setLevel(d)}
              >
                {B.DIFFICULTIES[d].name}
              </button>
            ))}
          </div>
          <p class="muted">{B.DIFFICULTIES[level].blurb}</p>
        </div>
        <button class="btn primary block" onClick={start}>
          Build a new port
        </button>
      </div>
    </div>
  );
}

export function BankruptDialog() {
  const s = snapshot.value!;
  return (
    <div class="backdrop">
      <div class="dialog panel" role="alertdialog" aria-labelledby="bankrupt-title">
        <div class="kicker bad">Game over</div>
        <h2 id="bankrupt-title">Bankrupt</h2>
        <p class="muted">
          The port spent {B.BANKRUPT_DAYS} days in the red and the bank has closed it on{' '}
          {formatDate(s.tick)}.
        </p>
        <dl class="props">
          <dt>Crates handled</dt>
          <dd>{s.stats.cratesHandled}</dd>
          <dt>Boats served</dt>
          <dd>{s.stats.boats}</dd>
          <dt>Total earned</dt>
          <dd>{money(s.stats.earned)}</dd>
        </dl>
        <button class="btn primary block" onClick={() => (newGameOpen.value = true)}>
          Start a new port
        </button>
      </div>
    </div>
  );
}

/** Whether the player has been told, on this device, that the game plays best on a computer. */
const PHONE_KEY = 'hm-phone-notice';

/** A phone or tablet: a touch screen with no fine pointer, or a narrow window. */
function onPhone(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 760px)').matches;
}

function told(): boolean {
  try {
    return localStorage.getItem(PHONE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Opened on a phone or tablet, once: it plays there, but best on a
 * computer, with a mouse and a big screen.
 */
export function PhoneNotice() {
  const [open, setOpen] = useState(() => onPhone() && !told());
  if (!open) return null;
  const close = () => {
    try {
      localStorage.setItem(PHONE_KEY, '1');
    } catch {
      // Private browsing: it shows again next time, no harm done.
    }
    setOpen(false);
  };
  return (
    <div class="backdrop" onClick={close}>
      <div
        class="dialog panel"
        role="dialog"
        aria-labelledby="phone-title"
        onClick={(e) => e.stopPropagation()}
      >
        <InfoHeader kicker="Welcome" title="Best on a computer" onClose={close} />
        <p id="phone-title">
          We have tried to make Harbourmaster playable on phones and tablets, but there is a lot to
          see and build, and it is at its best on a computer, with a mouse and a big screen.
        </p>
        <p class="muted">
          Here, pinch to zoom, drag with two fingers to move about, and use the buttons on the right
          to turn the view.
        </p>
        <button class="btn primary block" onClick={close}>
          Play here anyway
        </button>
      </div>
    </div>
  );
}
