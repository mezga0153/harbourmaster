import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { Capacity, ContractView, OfferView } from '../protocol';
import { C } from '../render/palette';
import * as B from '../sim/balance';
import { fisheryDailyCrates, fisheryDailyValue, type Terms } from '../sim/contracts';
import { TICKS_PER_DAY } from '../sim/types';
import type { Actions } from './App';
import { duration, money } from './format';
import { Icon } from './icons';
import { panel, snapshot } from './store';
import { InfoHeader, Meter } from './widgets';

type Tab = 'active' | 'offers' | 'rules';

function css(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

/** "~5 h" or "~1.5 days" from a number of days. */
function span(days: number): string {
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

function kindLabel(t: Terms): string {
  if (t.kind === 'haulier') return t.cargo === 'container' ? 'Container haulier' : 'Haulier';
  return t.vessel === 'feeder'
    ? 'Container line'
    : t.vessel === 'coaster'
      ? 'Shipping line'
      : 'Fishery';
}

function unit(t: Terms): string {
  return (t.kind === 'haulier' ? t.cargo === 'container' : t.vessel === 'feeder')
    ? 'containers'
    : 'crates';
}

function CardHead({ terms, extra }: { terms: Terms; extra?: ComponentChildren }) {
  const color = terms.kind === 'fishery' ? C.hulls[terms.color] : C.trucks[terms.color];
  return (
    <div class="card-head">
      <span class="swatch" style={{ background: css(color) }} />
      <strong>{terms.name}</strong>
      {extra}
      <span class={`badge ${terms.kind}`}>{kindLabel(terms)}</span>
    </div>
  );
}

/** The one-line headline: what this contract brings or costs per day. */
function Headline({ terms }: { terms: Terms }) {
  if (terms.kind === 'fishery') {
    return (
      <div class="headline">
        <span>
          <strong>≈{Math.round(fisheryDailyCrates(terms))}</strong> {unit(terms)}/day
        </span>
        <span class="pos">
          <strong>≈{money(fisheryDailyValue(terms))}</strong>/day
        </span>
      </div>
    );
  }
  return (
    <div class="headline">
      <span>
        <strong>{terms.fleet}</strong> truck{terms.fleet > 1 ? 's' : ''} ×{' '}
        <strong>{terms.capacity}</strong> {unit(terms)}
      </span>
      <span class="neg">
        <strong>{money(-terms.dailyFee)}</strong>/day
      </span>
    </div>
  );
}

function Facts({ rows }: { rows: [string, ComponentChildren][] }) {
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

function termRows(t: Terms): [string, ComponentChildren][] {
  if (t.kind === 'haulier') {
    return [
      ['Fleet', `${t.fleet} truck${t.fleet > 1 ? 's' : ''}`],
      ['Per truck', `${t.capacity} ${unit(t)}`],
      [
        'Needs',
        t.cargo
          ? 'Container yards'
          : t.capacity > B.TRUCK_CAPACITY
            ? 'Large truck bays or crate storage'
            : 'Any truck bay',
      ],
    ];
  }
  return [
    [
      t.vessel === 'feeder' ? 'A feeder' : t.vessel === 'coaster' ? 'A coaster' : 'A boat',
      `every ${span(t.boatEvery)}`,
    ],
    ['Load', `${t.cratesMin}–${t.cratesMax} ${unit(t)}`],
    ['Pays', `${money(t.fee)} a ${unit(t).slice(0, -1)}`],
    [
      'Needs',
      t.vessel === 'feeder'
        ? `Harbour or gantry crane, ${B.FEEDER_DRAFT} m`
        : t.vessel === 'coaster'
          ? `2-wide quay, ${B.COASTER_DRAFT} m, forklifts or a jib crane`
          : 'Any berth',
    ],
  ];
}

// ── Summary ───────────────────────────────────────────────

function Kpi({
  label,
  value,
  demand,
  hint,
}: {
  label: string;
  value: number;
  demand?: number;
  hint: string;
}) {
  const tone =
    demand === undefined ? '' : value >= demand * 1.1 ? 'good' : value >= demand ? 'warn' : 'bad';
  return (
    <div class={`kpi ${tone}`} title={hint}>
      <span class="kpi-label">{label}</span>
      <span class="kpi-value">
        {value}
        <span class="muted">/day</span>
      </span>
    </div>
  );
}

function DockAlert() {
  const d = snapshot.value?.docks;
  if (!d || d.coordinated >= d.total) return null;
  const idle = d.total - d.coordinated;
  return (
    <p class="note bad">
      {idle} dock{idle === 1 ? ' is' : 's are'} not in use.{' '}
      {d.offices === 0
        ? `Without a harbour office only ${B.FREE_DOCKS} jetties work, and no quays. Build one (O).`
        : `Each harbour office coordinates ${B.DOCKS_PER_OFFICE} docks. Build another.`}
    </p>
  );
}

function ContainerSummary({ cap }: { cap: Capacity }) {
  const b = cap.boxes;
  const tier = snapshot.value?.progress.tier ?? 0;
  if (tier < 2 && b.demand === 0) return null;
  const short =
    b.demand > 0 && b.berths === 0
      ? 'No feeder berth: needs a harbour or gantry crane on a 2-wide quay in 4 m of water.'
      : b.demand > b.lifting
        ? 'Containers bottleneck: lifting. Build another harbour crane, or a gantry crane: several can work one ship.'
        : b.demand > b.moving
          ? 'Containers bottleneck: moving. Buy reach stackers.'
          : b.demand > b.trucking
            ? 'Containers bottleneck: trucking. Sign a container haulier, and mark out container yards beside a public road or behind a port gate.'
            : null;
  return (
    <>
      <div class="kpis four">
        <Kpi label="Containers" value={b.demand} hint="Containers per day your lines send" />
        <Kpi label="Lifting" value={b.lifting} demand={b.demand} hint="Harbour and gantry cranes" />
        <Kpi label="Moving" value={b.moving} demand={b.demand} hint="Reach stackers" />
        <Kpi label="Trucking" value={b.trucking} demand={b.demand} hint="Container trucks" />
      </div>
      {short && <p class="note bad">{short}</p>}
    </>
  );
}

function Summary({ cap }: { cap: Capacity }) {
  const jammed = cap.congestion >= 0.15;
  const short =
    cap.demand > cap.unloading
      ? jammed
        ? 'Bottleneck: unloading, and workers are queueing on narrow walkways. More staff will not help much: widen jetties and paths, add berths, or use cranes and forklifts.'
        : 'Bottleneck: unloading. Hire dockhands to lift cargo off the boats, build jib cranes, or buy forklifts to take it on from the quay.'
      : cap.demand > cap.trucking
        ? 'Bottleneck: trucking. Sign a haulier, or add a truck bay if trucks are spare.'
        : cap.demand > Math.min(cap.unloading, cap.trucking) * 0.9
          ? 'Running close to capacity. Expand before signing more.'
          : null;
  return (
    <div class="summary">
      <div class="kpis">
        <Kpi label="Arriving" value={cap.demand} hint="Crates per day your contracts send" />
        <Kpi
          label="Unloading"
          value={cap.unloading}
          demand={cap.demand}
          hint="Crates per day your dockhands and forklifts can carry to the bays"
        />
        <Kpi
          label="Trucking"
          value={cap.trucking}
          demand={cap.demand}
          hint="Crates per day your hauliers can take away"
        />
      </div>
      {cap.congestion >= 0.05 && (
        <p class={`hint ${jammed ? 'warn' : ''}`}>
          Workers lost {Math.round(cap.congestion * 100)}% of their walking time yesterday waiting
          for each other to get out of the way.
        </p>
      )}
      {short && <p class="note bad">{short}</p>}
      <ContainerSummary cap={cap} />
      <DockAlert />
    </div>
  );
}

// ── Active ────────────────────────────────────────────────

function ContractCard({ c, actions }: { c: ContractView; actions: Actions }) {
  const [confirming, setConfirming] = useState(false);
  const t = c.terms;
  const m = mood(c.satisfaction);
  const rows = termRows(t);
  if (t.kind === 'fishery') {
    rows.push(['Next boat', c.nextIn <= 0 ? 'Due now' : `in ${span(c.nextIn / TICKS_PER_DAY)}`]);
    rows.push([
      'Waiting now',
      c.waiting > 0 ? (
        <span class="neg">{c.waiting} at anchor</span>
      ) : (
        <span class="muted">None</span>
      ),
    ]);
  } else {
    rows.push(['At the port', `${c.active} of ${t.fleet}`]);
    rows.push([
      'Away',
      c.away > 0 ? (
        `${c.away} on their round, the next back in ${duration(c.backIn)}`
      ) : (
        <span class="muted">None</span>
      ),
    ]);
  }
  return (
    <div class={`card ${c.waiting > 0 ? 'alerting' : ''}`}>
      <CardHead terms={t} />
      <Headline terms={t} />
      <Facts rows={rows} />
      {t.kind === 'fishery' && (
        <div class="mood" title={`Walks out at 0 and claims ${money(c.breach)}`}>
          <span class="field-label">Relationship</span>
          <Meter value={c.satisfaction / 100} tone={m.tone} />
          <span class={`mood-label ${m.tone}`}>{m.label}</span>
        </div>
      )}
      {t.kind === 'fishery' && c.satisfaction < 45 && (
        <p class="note bad">
          Unhappy. If the relationship reaches zero they walk out and claim {money(c.breach)}.
        </p>
      )}
      <div class="card-foot">
        <span class="muted">Ending it costs {money(c.cancelFee)}</span>
        {confirming ? (
          <span class="confirm">
            <button class="btn ghost sm" onClick={() => setConfirming(false)}>
              Keep
            </button>
            <button
              class="btn danger sm"
              onClick={() => actions.send({ type: 'cancelContract', id: c.id })}
            >
              End · {money(c.cancelFee)}
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

// ── Offers ────────────────────────────────────────────────

function Check({
  ok,
  warn,
  children,
}: {
  ok: boolean;
  warn?: boolean;
  children: ComponentChildren;
}) {
  const tone = ok ? 'good' : warn ? 'warn' : 'bad';
  return (
    <li class={`check ${tone}`}>
      <span class="check-mark">{ok ? '✓' : warn ? '!' : '✕'}</span>
      <span>{children}</span>
    </li>
  );
}

function OfferCard({
  o,
  cash,
  cap,
  bays,
  trucks,
  actions,
}: {
  o: OfferView;
  cash: number;
  cap: Capacity;
  bays: number;
  /** Trucks already under contract. */
  trucks: number;
  actions: Actions;
}) {
  const t = o.terms;
  const days = Math.max(1, Math.ceil(o.expiresIn / TICKS_PER_DAY));
  const checks: ComponentChildren[] = [];
  let blocked = false;

  if (t.kind === 'fishery' && t.vessel === 'feeder') {
    const b = cap.boxes;
    const after = b.demand + Math.round(fisheryDailyCrates(t));
    blocked = b.berths === 0;
    checks.push(
      <Check ok={b.berths > 0}>
        {b.berths > 0
          ? `${b.berths} feeder berth${b.berths === 1 ? '' : 's'} with a container crane`
          : 'No feeder berth: needs a harbour or gantry crane on a 2-wide quay in 4 m of water, with 7 tiles of open water along it'}
      </Check>,
      <Check ok={after <= b.lifting} warn={after > b.lifting}>
        Lifting: {after} needed, {b.lifting} possible
      </Check>,
      <Check ok={after <= b.moving} warn={after > b.moving}>
        Moving: {after} needed, {b.moving} possible
      </Check>,
      <Check ok={after <= b.trucking} warn={after > b.trucking}>
        Trucking: {after} needed, {b.trucking} possible
      </Check>,
    );
  } else if (t.kind === 'haulier' && t.cargo === 'container') {
    const yards = (snapshot.value?.yards ?? []).length;
    checks.push(
      <Check ok={yards > 0}>
        {yards > 0
          ? `${yards} container yard${yards === 1 ? '' : 's'} to load at`
          : 'Container trucks load at a container yard: mark one out on port road or quay beside a public road, or behind a port gate'}
      </Check>,
    );
  } else if (t.kind === 'fishery') {
    const after = cap.demand + Math.round(fisheryDailyCrates(t));
    const payback = o.signingFee / Math.max(1, fisheryDailyValue(t));
    const unloadOk = after <= cap.unloading;
    const truckOk = after <= cap.trucking;
    checks.push(
      <Check ok={unloadOk} warn={!unloadOk && after <= cap.unloading * 1.2}>
        Unloading: {after} needed, {cap.unloading} possible
      </Check>,
      <Check ok={truckOk} warn={!truckOk && after <= cap.trucking * 1.2}>
        Trucking: {after} needed, {cap.trucking} possible
      </Check>,
    );
    if (t.vessel === 'coaster') {
      const ok = cap.deepBerths > 0;
      blocked = !ok;
      checks.push(
        <Check ok={ok}>
          {ok
            ? `${cap.deepBerths} coaster berth${cap.deepBerths === 1 ? '' : 's'} (${B.COASTER_DRAFT} m deep, 2-wide quay)`
            : `No coaster berth yet: needs a quay two tiles wide, in ${B.COASTER_DRAFT} m of water`}
        </Check>,
      );
      const pallets = cap.pallets.demand + Math.round(fisheryDailyCrates(t));
      const forks = cap.pallets.unloading;
      checks.push(
        <Check ok={forks >= pallets} warn={forks > 0 && forks < pallets}>
          {forks > 0
            ? `Pallets: ${pallets} crates a day, ${forks} can be unloaded`
            : 'Crates come on pallets: dockhands or jib cranes lift them off, then forklifts take them on, or a jib crane swings them into crate storage'}
        </Check>,
      );
    }
    checks.push(
      <Check ok={payback <= 3} warn={payback > 3}>
        Signing fee pays back in {span(payback)}
      </Check>,
    );
  } else {
    const gain = o.truckingAfter - cap.trucking;
    const total = trucks + t.fleet;
    checks.push(
      <Check ok={gain > 0} warn={gain === 0}>
        Trucking {cap.trucking} → {o.truckingAfter} crates/day
      </Check>,
      <Check ok={total <= bays} warn={total > bays}>
        {total <= bays
          ? `${bays} truck bays for ${total} trucks`
          : `Only ${bays} truck bay${bays === 1 ? '' : 's'} for ${total} trucks: build more bays`}
      </Check>,
    );
  }

  return (
    <div class="card offer">
      <CardHead terms={t} extra={<span class="chip">{days}d left</span>} />
      <Headline terms={t} />
      <Facts rows={termRows(t)} />
      <ul class="checks">{checks}</ul>
      <div class="card-foot">
        <span class="muted">
          {t.kind === 'fishery' ? `Walk-out penalty ${money(o.breach)}` : 'No penalties'}
        </span>
        <button
          class="btn primary sm"
          disabled={cash < o.signingFee || blocked}
          onClick={() => actions.send({ type: 'signContract', id: o.id })}
        >
          Sign · {money(o.signingFee)}
        </button>
      </div>
    </div>
  );
}

// ── Penalties ─────────────────────────────────────────────

function Rules() {
  const rows: [string, string][] = [
    ['A boat waits at anchor or unloads slowly', `${money(B.DEMURRAGE_PER_DAY)} per boat per day`],
    [
      'A boat gives up after ~1.5 days',
      `${Math.round(B.LOST_CARGO_SHARE * 100)}% of the cargo still on board`,
    ],
    [
      'A fishery or shipping line walks out',
      `${B.BREACH_MULTIPLIER}× the signing fee, at least ${money(B.BREACH_MIN)}`,
    ],
    ['You end a contract yourself', 'The signing fee'],
  ];
  return (
    <>
      <p class="muted intro">
        Every boat served promptly improves the relationship. Waiting at anchor, slow unloading and
        boats leaving with cargo all damage it. At zero, they walk out.
      </p>
      <table class="ledger rules">
        <tbody>
          {rows.map(([when, cost]) => (
            <tr key={when}>
              <td>{when}</td>
              <td class="neg">{cost}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="muted intro">
        Hauliers never charge penalties, but each truck bay loads only one truck at a time, so
        trucks beyond your number of bays just wait.
      </p>
    </>
  );
}

// ── Panel ─────────────────────────────────────────────────

function TabButton({
  id,
  tab,
  setTab,
  children,
}: {
  id: Tab;
  tab: Tab;
  setTab: (t: Tab) => void;
  children: ComponentChildren;
}) {
  return (
    <button
      role="tab"
      aria-selected={tab === id}
      class={tab === id ? 'on' : ''}
      onClick={() => setTab(id)}
    >
      {children}
    </button>
  );
}

export function ContractsPanel({ actions }: { actions: Actions }) {
  const [tab, setTab] = useState<Tab>('active');
  const s = snapshot.value;
  if (!s) return null;
  const waiting = s.contracts.reduce((n, c) => n + c.waiting, 0);
  const trucks = s.contracts.reduce(
    (n, c) => n + (c.terms.kind === 'haulier' ? c.terms.fleet : 0),
    0,
  );
  // Fisheries first, the unhappiest at the top.
  const sorted = [...s.contracts].sort(
    (a, b) =>
      (a.terms.kind === 'haulier' ? 1 : 0) - (b.terms.kind === 'haulier' ? 1 : 0) ||
      a.satisfaction - b.satisfaction,
  );
  return (
    <aside class="side panel wide xwide" aria-label="Contracts">
      <InfoHeader kicker="Business" title="Contracts" onClose={() => (panel.value = null)} />
      <Summary cap={s.capacity} />

      <div class="tabs" role="tablist">
        <TabButton id="active" tab={tab} setTab={setTab}>
          Active <span class="tab-count">{s.contracts.length}</span>
          {waiting > 0 && (
            <span class="count bad" title="Boats waiting at anchor">
              {waiting}
            </span>
          )}
        </TabButton>
        <TabButton id="offers" tab={tab} setTab={setTab}>
          Offers <span class="tab-count">{s.offers.length}</span>
        </TabButton>
        <TabButton id="rules" tab={tab} setTab={setTab}>
          <Icon name="alert" /> Penalties
        </TabButton>
      </div>

      {tab === 'active' && (
        <>
          {!s.contracts.some((c) => c.terms.kind === 'fishery') && (
            <p class="note bad">No fishery is sending boats. Sign one from the Offers tab.</p>
          )}
          {!s.contracts.some((c) => c.terms.kind === 'haulier') && (
            <p class="note bad">No haulier under contract. No trucks will collect crates.</p>
          )}
          {sorted.map((c) => (
            <ContractCard key={c.id} c={c} actions={actions} />
          ))}
        </>
      )}

      {tab === 'offers' && (
        <>
          {s.offers.length === 0 && (
            <p class="muted">No offers right now. New ones arrive every few days.</p>
          )}
          {s.offers.map((o) => (
            <OfferCard
              key={o.id}
              o={o}
              cash={s.cash}
              cap={s.capacity}
              bays={s.bays.length}
              trucks={trucks}
              actions={actions}
            />
          ))}
        </>
      )}

      {tab === 'rules' && <Rules />}
    </aside>
  );
}
