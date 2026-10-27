import { useState } from 'preact/hooks';
import type { Capacity, ContractView, OfferView } from '../protocol';
import { C } from '../render/palette';
import { fisheryDailyCrates, fisheryDailyValue, type Terms } from '../sim/contracts';
import * as B from '../sim/balance';
import { TICKS_PER_DAY } from '../sim/types';
import type { Actions } from './App';
import { money } from './format';
import { panel, snapshot } from './store';
import { InfoHeader, Meter } from './widgets';

function css(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

function every(days: number): string {
  const hours = Math.round(days * 24);
  if (hours <= 36) return `~${hours} h`;
  return `~${Math.round(days * 10) / 10} days`;
}

function mood(satisfaction: number): { label: string; tone: string } {
  if (satisfaction >= 70) return { label: 'Happy', tone: 'good' };
  if (satisfaction >= 45) return { label: 'Content', tone: 'ok' };
  if (satisfaction >= 25) return { label: 'Annoyed', tone: 'warn' };
  return { label: 'Furious', tone: 'bad' };
}

function TermsLines({ terms }: { terms: Terms }) {
  const rows: [string, string][] =
    terms.kind === 'fishery'
      ? [
          [terms.vessel === 'coaster' ? 'Coasters' : 'Boats', `every ${every(terms.boatEvery)}`],
          ['Load', `${terms.cratesMin}–${terms.cratesMax} crates`],
          ['Rate', `${money(terms.fee)} / crate`],
          ['Value', `${money(fisheryDailyValue(terms))} / day`],
        ]
      : [
          ['Fleet', `${terms.fleet} truck${terms.fleet > 1 ? 's' : ''}`],
          ['Capacity', `${terms.capacity} crates`],
          ['Fee', `${money(terms.dailyFee)} / day`],
        ];
  return (
    <dl class="terms">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function CardHead({ terms }: { terms: Terms }) {
  const color = terms.kind === 'fishery' ? C.hulls[terms.color] : C.trucks[terms.color];
  return (
    <div class="card-head">
      <span class="swatch" style={{ background: css(color) }} />
      <strong>{terms.name}</strong>
      <span class={`badge ${terms.kind}`}>
        {terms.kind === 'haulier'
          ? 'Haulier'
          : terms.vessel === 'coaster'
            ? 'Shipping line'
            : 'Fishery'}
      </span>
    </div>
  );
}

function ContractCard({ c, actions }: { c: ContractView; actions: Actions }) {
  const [confirming, setConfirming] = useState(false);
  const isFishery = c.terms.kind === 'fishery';
  const m = mood(c.satisfaction);
  const unit = isFishery ? 'boat' : 'truck';
  return (
    <div class="card">
      <CardHead terms={c.terms} />
      <TermsLines terms={c.terms} />
      {isFishery && (
        <div class="mood">
          <span class="field-label">Relationship</span>
          <Meter value={c.satisfaction / 100} tone={m.tone} />
          <span class={`mood-label ${m.tone}`}>{m.label}</span>
        </div>
      )}
      <div class="card-foot">
        <span class="muted">
          {c.active} {unit}
          {c.active === 1 ? '' : 's'} {isFishery ? 'here or on the way' : 'at the port'}
        </span>
        {confirming ? (
          <span class="confirm">
            <button class="btn ghost sm" onClick={() => setConfirming(false)}>
              Keep
            </button>
            <button
              class="btn danger sm"
              onClick={() => actions.send({ type: 'cancelContract', id: c.id })}
            >
              End{c.cancelFee > 0 ? ` · ${money(c.cancelFee)}` : ''}
            </button>
          </span>
        ) : (
          <button class="btn ghost sm" onClick={() => setConfirming(true)}>
            End contract
          </button>
        )}
      </div>
    </div>
  );
}

function load(demand: number, capacity: number): { pct: number; tone: string } {
  const pct = capacity > 0 ? demand / capacity : demand > 0 ? Infinity : 0;
  return { pct, tone: pct < 0.7 ? 'good' : pct < 0.9 ? 'ok' : pct <= 1 ? 'warn' : 'bad' };
}

function CapacityRow({ label, value, demand }: { label: string; value: number; demand: number }) {
  const l = load(demand, value);
  return (
    <div class="cap-row">
      <span class="cap-label">{label}</span>
      <Meter value={Math.min(1, l.pct)} tone={l.tone} />
      <span class={`cap-value ${l.tone}`}>
        {value}
        <span class="muted">/day</span>
      </span>
    </div>
  );
}

/** What the fisheries send against what the port can move, in crates/day. */
function CapacityPanel({ cap }: { cap: Capacity }) {
  const short =
    cap.demand > cap.unloading
      ? 'Not enough dockhands to unload what arrives. Hire more.'
      : cap.demand > cap.trucking
        ? 'Not enough trucks. Sign a haulier, or build another truck bay if trucks are spare.'
        : null;
  return (
    <div class="capacity">
      <div class="cap-row head">
        <span class="cap-label">Arriving</span>
        <span />
        <span class="cap-value">
          {cap.demand}
          <span class="muted">/day</span>
        </span>
      </div>
      <CapacityRow label="Unloading" value={cap.unloading} demand={cap.demand} />
      <CapacityRow label="Trucking" value={cap.trucking} demand={cap.demand} />
      {short && <p class="note bad">{short}</p>}
    </div>
  );
}

function OfferCard({
  o,
  cash,
  cap,
  actions,
}: {
  o: OfferView;
  cash: number;
  cap: Capacity;
  actions: Actions;
}) {
  const days = Math.max(1, Math.ceil(o.expiresIn / TICKS_PER_DAY));
  const extra = o.terms.kind === 'fishery' ? fisheryDailyCrates(o.terms) : 0;
  const overload = extra > 0 && cap.demand + extra > Math.min(cap.unloading, cap.trucking);
  return (
    <div class="card offer">
      <CardHead terms={o.terms} />
      <TermsLines terms={o.terms} />
      {o.terms.kind === 'fishery' && o.terms.vessel === 'coaster' && (
        <p class={`hint ${cap.deepBerths === 0 ? 'warn' : ''}`}>
          {cap.deepBerths === 0
            ? `No berth is deep enough yet. Coasters need ${B.COASTER_DRAFT} m: build a quay out into deeper water first.`
            : `Coasters need ${B.COASTER_DRAFT} m of water. You have ${cap.deepBerths} deep berth${cap.deepBerths === 1 ? '' : 's'}.`}
        </p>
      )}
      {overload && (
        <p class="hint warn">
          Adds ~{Math.round(extra)} crates/day, more than the port can handle right now.
        </p>
      )}
      <div class="card-foot">
        <span class="muted">
          Expires in {days} day{days === 1 ? '' : 's'}
        </span>
        <button
          class="btn primary sm"
          disabled={cash < o.signingFee}
          onClick={() => actions.send({ type: 'signContract', id: o.id })}
        >
          Sign · {money(o.signingFee)}
        </button>
      </div>
    </div>
  );
}

export function ContractsPanel({ actions }: { actions: Actions }) {
  const s = snapshot.value;
  if (!s) return null;
  const fisheries = s.contracts.filter((c) => c.terms.kind === 'fishery');
  const hauliers = s.contracts.filter((c) => c.terms.kind === 'haulier');
  const fleet = hauliers.reduce((n, c) => n + (c.terms.kind === 'haulier' ? c.terms.fleet : 0), 0);
  return (
    <aside class="side panel wide" aria-label="Contracts">
      <InfoHeader kicker="Business" title="Contracts" onClose={() => (panel.value = null)} />
      <p class="muted intro">
        Fisheries send boats and pay for every crate that leaves on a truck. Hauliers supply the
        trucks. Boats kept waiting cost demurrage, and a fishery that runs out of patience walks out
        and claims its signing fee as a penalty.
      </p>
      {fisheries.length === 0 && (
        <p class="note bad">No fishery is sending boats. Sign one below.</p>
      )}
      {hauliers.length === 0 && (
        <p class="note bad">No haulier under contract. No trucks will collect crates.</p>
      )}

      <div class="section-title">
        <span>Port capacity</span>
        <span class="muted">crates per day</span>
      </div>
      <CapacityPanel cap={s.capacity} />

      <div class="section-title">
        <span>Active</span>
        <span class="muted">
          {fisheries.length} fisher{fisheries.length === 1 ? 'y' : 'ies'} · {fleet} truck
          {fleet === 1 ? '' : 's'}
        </span>
      </div>
      {s.contracts.map((c) => (
        <ContractCard key={c.id} c={c} actions={actions} />
      ))}

      <div class="section-title">
        <span>Offers</span>
        <span class="muted">{s.offers.length} open</span>
      </div>
      {s.offers.length === 0 && (
        <p class="muted">No offers right now. New ones arrive every few days.</p>
      )}
      {s.offers.map((o) => (
        <OfferCard key={o.id} o={o} cash={s.cash} cap={s.capacity} actions={actions} />
      ))}
    </aside>
  );
}
