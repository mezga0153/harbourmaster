import { useState } from 'preact/hooks';
import type { ContractView, OfferView } from '../protocol';
import { C } from '../render/palette';
import { fisheryDailyValue, type Terms } from '../sim/contracts';
import { TICKS_PER_DAY } from '../sim/types';
import type { Actions } from './App';
import { money } from './format';
import { contractsOpen, snapshot } from './store';
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
          ['Boats', `every ${every(terms.boatEvery)}`],
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
      <span class={`badge ${terms.kind}`}>{terms.kind === 'fishery' ? 'Fishery' : 'Haulier'}</span>
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

function OfferCard({ o, cash, actions }: { o: OfferView; cash: number; actions: Actions }) {
  const days = Math.max(1, Math.ceil(o.expiresIn / TICKS_PER_DAY));
  return (
    <div class="card offer">
      <CardHead terms={o.terms} />
      <TermsLines terms={o.terms} />
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
      <InfoHeader
        kicker="Business"
        title="Contracts"
        onClose={() => (contractsOpen.value = false)}
      />
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
        <OfferCard key={o.id} o={o} cash={s.cash} actions={actions} />
      ))}
    </aside>
  );
}
