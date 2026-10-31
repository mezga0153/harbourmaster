import { useState } from 'preact/hooks';
import * as B from '../sim/balance';
import type { Actions } from './actions';
import { formatDate, money } from './format';
import { newGameOpen, seed, snapshot } from './store';
import { InfoHeader } from './widgets';

// Dialogs over the whole game: starting a new port, and the bank closing this one.

export function NewGameDialog({ actions }: { actions: Actions }) {
  const [value, setValue] = useState(String(Math.floor(Math.random() * 1_000_000)));
  const close = () => (newGameOpen.value = false);
  const start = () => {
    const n = Number.parseInt(value, 10);
    actions.send({ type: 'newGame', seed: Number.isFinite(n) ? Math.abs(n) : undefined });
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
