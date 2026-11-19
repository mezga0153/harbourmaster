import { TIERS } from '../sim/tiers';
import type { Actions } from './actions';
import { money } from './format';
import { useState } from 'preact/hooks';
import * as B from '../sim/balance';
import {
  burnPerDay,
  cashReserve,
  land,
  openGuide,
  panel,
  selection,
  snapshot,
  tool,
} from './store';
import { InfoHeader, Meter, More, PortTownTabs } from './widgets';

/** The handbook page on what each step up brings. */
const TIER_TOPIC = ['start', 'machines', 'containers', 'bulk'];

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
            {(k === 1 || k === 2) && (
              <button class="link" onClick={() => openGuide(k === 1 ? 'wharf' : 'harbour')}>
                Show me how to build it ›
              </button>
            )}
            {state === 'next' && t.region !== undefined && (
              <>
                <Requirement
                  label="People in the region"
                  have={s.progress.region}
                  need={t.region}
                />
                <button
                  class="link"
                  onClick={() => {
                    panel.value = null;
                    selection.value = { type: 'region' };
                  }}
                >
                  See the region ›
                </button>
              </>
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
                <UpgradeButton
                  cost={t.cost}
                  can={canUpgrade}
                  onUpgrade={() => actions.send({ type: 'upgrade' })}
                />
              </>
            )}
          </div>
        );
      })}
    </aside>
  );
}

/**
 * The upgrade, paid for: what the fee leaves in hand against what goes out
 * a day, and, when that is less than a cushion for bad days, a second click
 * to go ahead anyway.
 */
function UpgradeButton({
  cost,
  can,
  onUpgrade,
}: {
  cost: number;
  can: boolean;
  onUpgrade: () => void;
}) {
  const [sure, setSure] = useState(false);
  const s = snapshot.value;
  if (!s) return null;
  const left = s.cash - cost;
  const burn = burnPerDay.value;
  const short = can && burn > 0 && left < cashReserve.value;
  const days = burn > 0 ? Math.max(0, left / burn) : Infinity;
  return (
    <>
      {short && (
        <p class="note bad">
          The fee leaves {money(left)}, about {Math.round(days * 10) / 10} days of what goes out a
          day
          {s.yesterday && s.yesterday.penalties < 0 ? ', counting the claims paid yesterday' : ''}.
          A boat that gives up or a line that walks out can cost more than that: keep about{' '}
          {B.RESERVE_DAYS} days in hand ({money(cashReserve.value)}), or a loan ready in Finance,
          before upgrading.
        </p>
      )}
      <div class="actions">
        {sure && short ? (
          <span class="confirm">
            <button class="btn ghost" onClick={() => setSure(false)}>
              Wait
            </button>
            <button class="btn danger" disabled={!can} onClick={onUpgrade}>
              Upgrade anyway · {money(cost)}
            </button>
          </span>
        ) : (
          <button
            class="btn primary"
            disabled={!can}
            onClick={() => (short ? setSure(true) : onUpgrade())}
          >
            Upgrade · {money(cost)}
          </button>
        )}
      </div>
    </>
  );
}
