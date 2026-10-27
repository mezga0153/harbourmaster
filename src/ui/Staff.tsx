import { useState } from 'preact/hooks';
import type { StaffView } from '../protocol';
import * as B from '../sim/balance';
import { traitDef, type Candidate, type Trait } from '../sim/staff';
import type { Actions } from './App';
import { money } from './format';
import { Icon } from './icons';
import { MACHINE_TIER, TIERS } from '../sim/tiers';
import { panel, snapshot } from './store';
import { InfoHeader, Meter } from './widgets';

function Skill({ value }: { value: number }) {
  return (
    <span class="skill" title={`Skill ${value} of 5`} aria-label={`Skill ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((k) => (
        <span key={k} class={k <= value ? 'pip on' : 'pip'} />
      ))}
    </span>
  );
}

function TraitBadge({ trait }: { trait: Trait | null }) {
  if (!trait) return null;
  const t = traitDef(trait);
  const good = trait === 'hardWorker' || trait === 'cheerful' || trait === 'strong';
  return (
    <span class={`badge ${good ? 'good' : 'bad'}`} title={t.hint}>
      {t.label}
    </span>
  );
}

function tone(v: number): string {
  return v >= 60 ? 'good' : v >= B.TIRED_ENERGY ? 'ok' : 'bad';
}

function Needs({ p }: { p: StaffView }) {
  return (
    <div class="needs">
      <span title="Energy">
        <Icon name="bolt" />
      </span>
      <Meter value={p.energy / 100} tone={tone(p.energy)} />
      <span title="Morale">
        <Icon name="smile" />
      </span>
      <Meter value={p.morale / 100} tone={tone(p.morale)} />
    </div>
  );
}

/** Dockhand details for the inspector when one is selected on the map. */
export function StaffDetails({
  id,
  actions,
  onDismiss,
}: {
  id: number;
  actions: Actions;
  onDismiss: () => void;
}) {
  const p = snapshot.value?.people.find((x) => x.id === id);
  if (!p) return null;
  if (p.kind === 'forklift') {
    return (
      <>
        <dl class="props">
          <dt>Carries</dt>
          <dd>{B.FORKLIFT_CAPACITY} crates a trip</dd>
          <dt>Drives on</dt>
          <dd>Quays, paths, roads</dd>
          <dt>Operator</dt>
          <dd>{money(p.wage)} / day</dd>
          <dt>Repairs</dt>
          <dd>{money(B.REPAIR_COST)} per breakdown</dd>
        </dl>
        <div class="actions">
          <button
            class="btn danger"
            onClick={() => {
              actions.send({ type: 'fire', id: p.id });
              onDismiss();
            }}
          >
            Sell · {money(B.FORKLIFT_PRICE * B.SELL_SHARE)}
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <p class="thought">“{p.thought}”</p>
      <dl class="props">
        <dt>Skill</dt>
        <dd>
          <Skill value={p.skill} />
        </dd>
        <dt>Trait</dt>
        <dd>{p.trait ? <TraitBadge trait={p.trait} /> : <span class="muted">None</span>}</dd>
        <dt>Energy</dt>
        <dd>{p.energy}%</dd>
        <dt>Morale</dt>
        <dd>{p.morale}%</dd>
        <dt>Wage</dt>
        <dd>{money(p.wage)} / day</dd>
      </dl>
      <Needs p={p} />
      <div class="actions">
        <button
          class="btn danger"
          onClick={() => {
            actions.send({ type: 'fire', id: p.id });
            onDismiss();
          }}
        >
          Dismiss
        </button>
      </div>
    </>
  );
}

function CandidateCard({ c, cash, actions }: { c: Candidate; cash: number; actions: Actions }) {
  return (
    <div class="card offer">
      <div class="card-head">
        <strong>{c.name}</strong>
        <TraitBadge trait={c.trait} />
      </div>
      <dl class="terms">
        <div>
          <dt>Skill</dt>
          <dd>
            <Skill value={c.skill} />
          </dd>
        </div>
        <div>
          <dt>Wage</dt>
          <dd>{money(c.wage)} / day</dd>
        </div>
      </dl>
      <div class="card-foot">
        <span class="muted">{c.trait ? traitDef(c.trait).hint : 'Steady worker'}</span>
        <button
          class="btn primary sm"
          disabled={cash < B.HIRE_FEE}
          onClick={() => actions.send({ type: 'hire', candidateId: c.id })}
        >
          Hire · {money(B.HIRE_FEE)}
        </button>
      </div>
    </div>
  );
}

function MachineCard({ p, actions }: { p: StaffView; actions: Actions }) {
  return (
    <div class="card person">
      <div class="card-head">
        <Icon name="forklift" />
        <strong>{p.name}</strong>
        {p.broken && <span class="badge bad">Broken down</span>}
      </div>
      <div class="card-foot">
        <span class="muted">
          {p.activity} · {money(p.wage)}/day
        </span>
        <button class="btn ghost sm" onClick={() => actions.send({ type: 'fire', id: p.id })}>
          Sell · {money(B.FORKLIFT_PRICE * B.SELL_SHARE)}
        </button>
      </div>
    </div>
  );
}

function PersonCard({ p, actions }: { p: StaffView; actions: Actions }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div class="card person">
      <div class="card-head">
        <strong>{p.name}</strong>
        <TraitBadge trait={p.trait} />
        <Skill value={p.skill} />
      </div>
      <Needs p={p} />
      <div class="card-foot">
        <span class="muted">
          {p.activity} · {money(p.wage)}/day
        </span>
        {confirming ? (
          <span class="confirm">
            <button class="btn ghost sm" onClick={() => setConfirming(false)}>
              Keep
            </button>
            <button class="btn danger sm" onClick={() => actions.send({ type: 'fire', id: p.id })}>
              Dismiss
            </button>
          </span>
        ) : (
          <button class="btn ghost sm" onClick={() => setConfirming(true)}>
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

export function StaffPanel({ actions }: { actions: Actions }) {
  const s = snapshot.value;
  if (!s) return null;
  const tired = s.people.filter((p) => p.energy < B.TIRED_ENERGY).length;
  const unhappy = s.people.filter((p) => p.morale < 30).length;
  const asks = s.people.filter((p) => p.raiseAsk > 0);
  const crew = s.people.filter((p) => p.kind === 'dockhand');
  const machines = s.people.filter((p) => p.kind === 'forklift');
  const locked = s.progress.tier < MACHINE_TIER.forklift;
  return (
    <aside class="side panel wide" aria-label="Staff">
      <InfoHeader kicker="People" title="Staff" onClose={() => (panel.value = null)} />
      <p class="muted intro">
        Skilled dockhands walk faster. Everyone tires while working; without a break hut they rest
        on the spot, slowly, and their morale suffers. Staff who stay miserable will quit.
      </p>
      {unhappy > 0 && (
        <p class="note bad">
          {unhappy} unhappy dockhand{unhappy === 1 ? '' : 's'}. Build a break hut so they can rest
          properly.
        </p>
      )}

      {asks.length > 0 && (
        <>
          <div class="section-title">
            <span>Requests</span>
            <span class="muted">answer by tomorrow</span>
          </div>
          {asks.map((p) => (
            <div class="card" key={p.id}>
              <div class="card-head">
                <strong>{p.name}</strong>
                <span class="muted">
                  {money(p.wage)} → {money(p.raiseAsk)}/day
                </span>
              </div>
              <p class="muted">Asks for a raise. Saying no will hurt their morale.</p>
              <div class="actions">
                <button
                  class="btn sm"
                  onClick={() => actions.send({ type: 'raise', id: p.id, accept: false })}
                >
                  Refuse
                </button>
                <button
                  class="btn primary sm"
                  onClick={() => actions.send({ type: 'raise', id: p.id, accept: true })}
                >
                  Give raise
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      <div class="section-title">
        <span>Candidates</span>
        <span class="muted">a new face every day</span>
      </div>
      {s.candidates.map((c) => (
        <CandidateCard key={c.id} c={c} cash={s.cash} actions={actions} />
      ))}

      <div class="section-title">
        <span>Your staff</span>
        <span class="muted">
          {crew.length} · {money(s.wages)}/day{tired > 0 ? ` · ${tired} tired` : ''}
        </span>
      </div>
      {crew.map((p) => (
        <PersonCard key={p.id} p={p} actions={actions} />
      ))}

      <div class="section-title">
        <span>Machines</span>
        <span class="muted">
          {machines.length} forklift{machines.length === 1 ? '' : 's'}
        </span>
      </div>
      <div class="card offer">
        <div class="card-head">
          <Icon name="forklift" />
          <strong>Forklift</strong>
          {locked && <span class="badge">{TIERS[MACHINE_TIER.forklift].name}</span>}
        </div>
        <p class="muted">
          Carries {B.FORKLIFT_CAPACITY} crates a trip, never tires, but only drives on quays, paths
          and roads, not wooden jetties. Breaks down now and then ({money(B.REPAIR_COST)} repair).
        </p>
        <div class="card-foot">
          <span class="muted">Operator {money(B.FORKLIFT_WAGE)}/day</span>
          <button
            class="btn primary sm"
            disabled={locked || s.cash < B.FORKLIFT_PRICE}
            onClick={() => actions.send({ type: 'buyMachine', kind: 'forklift' })}
          >
            {locked ? 'Locked' : `Buy · ${money(B.FORKLIFT_PRICE)}`}
          </button>
        </div>
      </div>
      {machines.map((p) => (
        <MachineCard key={p.id} p={p} actions={actions} />
      ))}
    </aside>
  );
}
