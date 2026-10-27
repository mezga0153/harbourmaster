import { TIERS } from '../sim/tiers';
import type { Actions } from './App';
import { money } from './format';
import { panel, snapshot } from './store';
import { InfoHeader, Meter } from './widgets';

function Requirement({ label, have, need }: { label: string; have: number; need: number }) {
  const done = have >= need;
  return (
    <div class="req">
      <span class={done ? 'pos' : ''}>
        {done ? '✓ ' : ''}
        {label}
      </span>
      <Meter value={need > 0 ? have / need : 1} tone={done ? 'good' : 'ok'} />
      <span class="req-value">
        {Math.min(have, need).toLocaleString('en-US')} / {need.toLocaleString('en-US')}
      </span>
    </div>
  );
}

export function PortPanel({ actions }: { actions: Actions }) {
  const s = snapshot.value;
  if (!s) return null;
  const { tier, crates, contracts, canUpgrade } = s.progress;
  return (
    <aside class="side panel wide" aria-label="Port development">
      <InfoHeader kicker="Development" title="Port" onClose={() => (panel.value = null)} />
      <p class="muted intro">
        Grow the port to unlock new quays, machines and bigger ships. Each upgrade needs a track
        record and a fee to the harbour authority.
      </p>
      {TIERS.map((t, k) => {
        const state =
          k < tier ? 'done' : k === tier ? 'current' : k === tier + 1 ? 'next' : 'later';
        return (
          <div class={`card tier ${state}`} key={t.name}>
            <div class="card-head">
              <span class="tier-num">{k + 1}</span>
              <strong>{t.name}</strong>
              {state === 'current' && <span class="badge good">Current</span>}
              {state === 'done' && <span class="badge">Done</span>}
              {t.comingSoon && state !== 'done' && <span class="badge">Coming later</span>}
            </div>
            <p class="muted">{t.blurb}</p>
            <ul class="unlocks">
              {t.unlocks.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
            {state === 'next' && !t.comingSoon && (
              <>
                <Requirement label="Crates handled" have={crates} need={t.crates} />
                <Requirement label="Active contracts" have={contracts} need={t.contracts} />
                <Requirement label="Cash for the fee" have={Math.max(0, s.cash)} need={t.cost} />
                <div class="actions">
                  <button
                    class="btn primary"
                    disabled={!canUpgrade}
                    onClick={() => actions.send({ type: 'upgrade' })}
                  >
                    Upgrade · {money(t.cost)}
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </aside>
  );
}
