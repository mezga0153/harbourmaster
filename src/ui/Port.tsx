import { TIERS } from '../sim/tiers';
import type { Actions } from './actions';
import { money } from './format';
import { land, openGuide, panel, snapshot, tool } from './store';
import { InfoHeader, Meter, More, PortTownTabs } from './widgets';

/** The handbook page on what each step up brings. */
const TIER_TOPIC = ['start', 'machines', 'containers'];

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
  const { tier, town, canUpgrade } = s.progress;
  const townName = s.town?.name ?? 'the town';
  return (
    <aside class="side panel wide" aria-label="Port development">
      <InfoHeader kicker="Development" title="Port" onClose={() => (panel.value = null)} />
      {s.town && <PortTownTabs on="port" />}
      <p class="muted intro">
        The port grows with the town it serves: once {townName} has enough people, the harbour
        authority lets you upgrade, for a fee, to unlock new quays, machines and bigger ships. Jobs
        at the port and goods sent into town make it grow.
      </p>
      {land.value && (
        <div class="card">
          <div class="card-head">
            <strong>Land</strong>
            <span class="badge">{land.value.owned} plots</span>
          </div>
          <p class="muted">
            The port builds only on plots it owns, buying them one at a time beside its own: the
            next plot of land costs {money(land.value.next)}, of sea {money(land.value.nextSea)}.
          </p>
          <div class="actions">
            <button
              class="btn"
              onClick={() => {
                tool.value = 'land';
                panel.value = null;
              }}
            >
              Buy land
            </button>
            <More topic="land" label="How it works" />
          </div>
        </div>
      )}
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
            {TIER_TOPIC[k] && !t.comingSoon && <More topic={TIER_TOPIC[k]} label="How it works" />}
            {k === 1 && (
              <button class="link" onClick={() => openGuide('wharf')}>
                Show me how to build it ›
              </button>
            )}
            {state === 'next' && !t.comingSoon && (
              <>
                <Requirement label={`People in ${townName}`} have={town} need={t.town} />
                {s.progress.waitsOn && (
                  <p class="muted">
                    {townName} cannot grow to {t.town.toLocaleString('en-US')} people till it opens
                    its {s.progress.waitsOn.toLowerCase()}: see the Town panel for what it wants.
                  </p>
                )}
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
