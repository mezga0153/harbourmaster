import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { Capacity, ContractView, OfferView } from '../protocol';
import { C } from '../render/palette';
import * as B from '../sim/balance';
import {
  fisheryDailyCrates,
  fisheryDailyValue,
  shipperDailyValue,
  type Terms,
} from '../sim/contracts';
import { TICKS_PER_DAY } from '../sim/types';
import type { Actions } from './App';
import { duration, money } from './format';
import { Icon } from './icons';
import { contractsTab, panel, snapshot, type ContractsTab } from './store';
import { InfoHeader, Meter, More } from './widgets';

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
  if (t.kind === 'shipper') return t.cargo === 'container' ? 'Container shipper' : 'Shipper';
  return t.vessel === 'feeder'
    ? 'Container line'
    : t.vessel === 'coaster'
      ? 'Shipping line'
      : 'Fishery';
}

function unit(t: Terms): string {
  return (t.kind === 'fishery' ? t.vessel === 'feeder' : t.cargo === 'container')
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
  if (terms.kind === 'shipper') {
    return (
      <div class="headline">
        <span>
          <strong>≈{terms.perDay}</strong> {unit(terms)}/day out
        </span>
        <span class="pos">
          <strong>≈{money(shipperDailyValue(terms))}</strong>/day
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
  if (t.kind === 'shipper') {
    return [
      ['A truck', `every ${span(t.capacity / t.perDay)}`],
      ['Load', `${t.capacity} ${unit(t)}`],
      ['Pays', `${money(t.fee)} a ${unit(t).slice(0, -1)} on board`],
      [
        'Needs',
        `Parking outside the port, ${t.cargo ? 'container yards and feeders' : 'crate storage and coasters'}`,
      ],
    ];
  }
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
  below,
}: {
  label: string;
  value: number;
  demand?: number;
  hint: string;
  /** What is waiting after this step. */
  below?: string;
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
      {below && <span class="kpi-below">{below}</span>}
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
        : `Each harbour office coordinates ${B.DOCKS_PER_OFFICE} docks. Build another.`}{' '}
      Select an office, or pick the jetty, quay or office tool, to see which: they show red.
    </p>
  );
}

function ContainerSummary({ cap }: { cap: Capacity }) {
  const b = cap.boxes;
  const stock = snapshot.value?.stock;
  const tier = snapshot.value?.progress.tier ?? 0;
  if (tier < 2 && b.demand === 0) return null;
  const short =
    b.demand > 0 && b.berths === 0
      ? 'No feeder berth: needs a harbour or gantry crane on a 2-wide quay in 4 m of water.'
      : b.demand > b.lifting
        ? 'Containers bottleneck: lifting them off the ships. Build another harbour crane, or a gantry crane: several can work one ship.'
        : b.demand > b.moving
          ? (snapshot.value?.yards ?? []).some((y) => !y.gantry)
            ? 'Containers bottleneck: reach stackers. They take containers from the cranes to the yards, and without a yard gantry load the trucks too. Buy more, or build yard gantries.'
            : 'Containers bottleneck: moving them from the cranes to the yards. Buy reach stackers.'
          : b.demand > b.trucking
            ? 'Containers bottleneck: trucking. Sign a container haulier, and give the container yards a port road beside them, inside the port gate.'
            : null;
  return (
    <>
      <h3 class="flow-title">
        Containers, ship to truck <More topic="containers" label="How" />
      </h3>
      <div class="kpis four flow">
        <Kpi label="Arriving" value={b.demand} hint="Containers per day your lines send" />
        <Kpi
          label="Lifted"
          value={b.lifting}
          demand={b.demand}
          hint="Harbour and gantry cranes lift containers off the ships"
          below={stock && `${stock.boxLanded} by the cranes`}
        />
        <Kpi
          label="Moved"
          value={b.moving}
          demand={b.demand}
          hint="Reach stackers take them from the cranes to the container yards, and load the trucks at yards without a yard gantry"
          below={stock && `${stock.boxCustoms} in customs`}
        />
        <Kpi
          label="Trucked"
          value={b.trucking}
          demand={b.demand}
          hint="Container trucks take them away once customs clear them, a day after their ship is unloaded"
          below={stock && `${stock.boxCleared} cleared`}
        />
      </div>
      {short && <p class="note bad">{short}</p>}
    </>
  );
}

/** Goods the shippers have sent in, waiting in the port for a ship to take them out. */
function ExportSummary() {
  const s = snapshot.value;
  if (!s || !s.contracts.some((c) => c.terms.kind === 'shipper')) return null;
  const { crateExports, boxExports } = s.stock;
  const shipped = s.stats.exported ?? 0;
  return (
    <>
      <h3 class="flow-title">
        Exports, truck to ship <More topic="exports" label="How" />
      </h3>
      <p class="hint">
        Waiting to ship: {crateExports} crate{crateExports === 1 ? '' : 's'}
        {boxExports > 0 || s.progress.tier >= 2
          ? `, ${boxExports} container${boxExports === 1 ? '' : 's'}`
          : ''}
        . {shipped.toLocaleString('en-US')} shipped so far.
      </p>
    </>
  );
}

/**
 * The way cargo goes from boat to truck, a step at a time: how much each
 * step can handle a day, what is waiting after it, and the step holding
 * everything up.
 */
function Summary({ cap }: { cap: Capacity }) {
  const stock = snapshot.value?.stock;
  const jammed = cap.congestion >= 0.15;
  const short =
    cap.demand > cap.off
      ? jammed
        ? 'Bottleneck: lifting cargo off the boats, and workers are queueing on narrow walkways. More staff will not help much: widen jetties and paths, add berths, or build jib cranes.'
        : 'Bottleneck: lifting cargo off the boats. Hire dockhands, or build jib cranes. Forklifts cannot unload boats.'
      : cap.demand > cap.moved
        ? 'Bottleneck: moving cargo on from the quay. Buy forklifts to take what is landed to the bays, or mark out crate storage within reach of the jib cranes.'
        : cap.demand > cap.trucking
          ? 'Bottleneck: trucking. Sign a haulier, or add a truck bay if trucks are spare. Trucks are away a while on each round.'
          : cap.demand > Math.min(cap.unloading, cap.trucking) * 0.9
            ? 'Running close to capacity. Expand before signing more.'
            : null;
  return (
    <div class="summary">
      <h3 class="flow-title">
        Crates, boat to truck <More topic="start" label="How" />
      </h3>
      <div class="kpis four flow">
        <Kpi label="Arriving" value={cap.demand} hint="Crates per day your contracts send" />
        <Kpi
          label="Off boats"
          value={cap.off}
          demand={cap.demand}
          hint="Dockhands and jib cranes lift crates off the boats. Forklifts cannot"
          below={stock && `${stock.landed} on the quay`}
        />
        <Kpi
          label="Moved on"
          value={cap.moved}
          demand={cap.demand}
          hint="Forklifts take what is landed to the bays and storage; without forklifts, dockhands carry it all the way"
          below={stock && `${stock.stored} in store`}
        />
        <Kpi
          label="Trucked"
          value={cap.trucking}
          demand={cap.demand}
          hint="Crates per day your hauliers can take away, each truck away a while on its round"
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
      <ExportSummary />
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
  } else if (t.kind === 'shipper') {
    rows.push(['Next truck', c.nextIn <= 0 ? 'Due now' : `in ${span(c.nextIn / TICKS_PER_DAY)}`]);
    rows.push(['At the port', `${c.active} truck${c.active === 1 ? '' : 's'}`]);
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
          : 'Container trucks load at a container yard: mark one out on port road or quay, with a port road beside it inside a port gate'}
      </Check>,
    );
  } else if (t.kind === 'shipper') {
    const s = snapshot.value;
    const ships = (s?.contracts ?? []).some(
      (c) => c.terms.kind === 'fishery' && c.terms.vessel === (t.cargo ? 'feeder' : 'coaster'),
    );
    const stores = t.cargo
      ? (s?.yards ?? []).some((y) => y.outgoing || y.byCrane)
      : (s?.bays ?? []).some((b) => b.tiles && (b.outgoing || b.byCrane));
    checks.push(
      <Check ok={ships}>
        {ships
          ? `${t.cargo ? 'Feeders' : 'Coasters'} call to take it out`
          : `No ${t.cargo ? 'container line' : 'shipping line'} calls yet to take it out`}
      </Check>,
      <Check ok={stores}>
        {stores
          ? `${t.cargo ? 'A container yard' : 'Crate storage'} for cargo going out`
          : `Needs ${t.cargo ? 'a container yard' : 'crate storage'} marked out for cargo going out`}
      </Check>,
      <Check ok={true}>Its trucks need parking outside the port for a day of paperwork</Check>,
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
    [
      'A boat waits at anchor, or unloads or loads exports slowly',
      `${money(B.DEMURRAGE_PER_DAY)} per boat per day`,
    ],
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
        Every boat served promptly improves the relationship. Waiting at anchor, slow unloading,
        slow loading of exports and boats leaving with cargo all damage it. Each boat is allowed
        time for every crate or container it unloads and every export it takes on. At zero, they
        walk out.
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

function TabButton({ id, children }: { id: ContractsTab; children: ComponentChildren }) {
  const on = contractsTab.value === id;
  return (
    <button
      role="tab"
      aria-selected={on}
      class={`tab ${on ? 'on' : ''}`}
      onClick={() => (contractsTab.value = id)}
    >
      {children}
    </button>
  );
}

/**
 * All the contracts at a glance: the cargo flow, totals for the lines and
 * the hauliers, what needs attention, and a line for each contract.
 */
function Overview() {
  const s = snapshot.value!;
  const lines = s.contracts.filter((c) => c.terms.kind === 'fishery');
  const hauls = s.contracts.filter((c) => c.terms.kind === 'haulier');
  const ships = s.contracts.filter((c) => c.terms.kind === 'shipper');
  let crates = 0;
  let boxes = 0;
  let income = 0;
  for (const c of lines) {
    if (c.terms.kind !== 'fishery') continue;
    if (c.terms.vessel === 'feeder') boxes += fisheryDailyCrates(c.terms);
    else crates += fisheryDailyCrates(c.terms);
    income += fisheryDailyValue(c.terms);
  }
  for (const c of ships) if (c.terms.kind === 'shipper') income += shipperDailyValue(c.terms);
  let fleet = 0;
  let fees = 0;
  for (const c of hauls) {
    if (c.terms.kind !== 'haulier') continue;
    fleet += c.terms.fleet;
    fees += c.terms.dailyFee;
  }
  const atPort = hauls.reduce((n, c) => n + c.active, 0);
  const away = hauls.reduce((n, c) => n + c.away, 0);
  const waiting = lines.reduce((n, c) => n + c.waiting, 0);
  const unhappy = lines
    .filter((c) => c.satisfaction < 45)
    .sort((a, b) => a.satisfaction - b.satisfaction);
  // The lines first, unhappiest at the top, then the hauliers.
  const rows = [
    ...lines.sort((a, b) => a.satisfaction - b.satisfaction),
    ...ships.sort((a, b) => a.terms.name.localeCompare(b.terms.name)),
    ...hauls.sort((a, b) => a.terms.name.localeCompare(b.terms.name)),
  ];
  return (
    <>
      <Summary cap={s.capacity} />
      <div class="kpis four">
        <div class="kpi">
          <span class="kpi-label">Lines</span>
          <span class="kpi-value">{lines.length}</span>
          <span class="kpi-below">
            ≈{Math.round(crates)} crates{boxes > 0 ? `, ${Math.round(boxes)} boxes` : ''}/day
          </span>
        </div>
        <div class="kpi good">
          <span class="kpi-label">Brings in</span>
          <span class="kpi-value">≈{money(income)}</span>
          <span class="kpi-below">a day</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Trucks</span>
          <span class="kpi-value">{fleet}</span>
          <span class="kpi-below">
            {atPort} here, {away} away · {money(-fees)}/day
          </span>
        </div>
        <div class={`kpi ${waiting > 0 ? 'bad' : 'good'}`}>
          <span class="kpi-label">At anchor</span>
          <span class="kpi-value">{waiting}</span>
          <span class="kpi-below">boats waiting</span>
        </div>
      </div>
      {lines.length === 0 && (
        <p class="note bad">No fishery or line is sending boats. Sign one from the Offers tab.</p>
      )}
      {hauls.length === 0 && (
        <p class="note bad">No haulier under contract. No trucks will collect the cargo.</p>
      )}
      {unhappy.length > 0 && (
        <p class="note bad">
          {unhappy.map((c) => c.terms.name).join(', ')} {unhappy.length === 1 ? 'is' : 'are'}{' '}
          unhappy: serve their boats promptly, or they walk out and claim{' '}
          {money(unhappy.reduce((n, c) => n + c.breach, 0))}.
        </p>
      )}
      <table class="roster">
        <tbody>
          {rows.map((c) => {
            const t = c.terms;
            const color = t.kind === 'fishery' ? C.hulls[t.color] : C.trucks[t.color];
            const m = mood(c.satisfaction);
            return (
              <tr key={c.id} onClick={() => (contractsTab.value = 'active')} title="Show in detail">
                <td>
                  <span class="swatch" style={{ background: css(color) }} />
                </td>
                <td class="roster-name">{t.name}</td>
                <td class="muted">{kindLabel(t)}</td>
                <td class="num">
                  {t.kind === 'fishery'
                    ? `≈${Math.round(fisheryDailyCrates(t))}/day`
                    : t.kind === 'shipper'
                      ? `≈${t.perDay}/day out`
                      : `${t.fleet}×${t.capacity}`}
                </td>
                <td class="num">
                  {t.kind === 'fishery' ? (
                    c.waiting > 0 ? (
                      <span class="neg">{c.waiting} waiting</span>
                    ) : (
                      <span class={`mood-label ${m.tone}`}>{m.label}</span>
                    )
                  ) : (
                    <span class="muted">
                      {c.active} here{c.away > 0 ? `, ${c.away} away` : ''}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

export function ContractsPanel({ actions }: { actions: Actions }) {
  const tab = contractsTab.value;
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
      <div class="tabs" role="tablist">
        <TabButton id="overview">Overview</TabButton>
        <TabButton id="active">
          All <span class="tab-count">{s.contracts.length}</span>
          {waiting > 0 && (
            <span class="count bad" title="Boats waiting at anchor">
              {waiting}
            </span>
          )}
        </TabButton>
        <TabButton id="offers">
          Offers <span class="tab-count">{s.offers.length}</span>
        </TabButton>
        <TabButton id="rules">
          <Icon name="alert" /> Penalties
        </TabButton>
      </div>

      {tab === 'overview' && <Overview />}

      {tab === 'active' && (
        <>
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
