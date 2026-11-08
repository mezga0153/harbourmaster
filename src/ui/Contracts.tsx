import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Capacity, ContractView, OfferView, Snapshot } from '../protocol';
import { C } from '../render/palette';
import * as B from '../sim/balance';
import {
  fisheryDailyCrates,
  fisheryDailyValue,
  railDailyValue,
  shipperDailyValue,
  type Terms,
} from '../sim/contracts';
import { TICKS_PER_DAY } from '../sim/types';
import type { Actions } from './actions';
import { fined, fineRate, paid } from './difficulty';
import { duration, money } from './format';
import { Icon } from './icons';
import {
  CARGO_LABEL,
  CARGOS,
  type Cargo,
  cargoOf,
  dailyValue,
  EXPIRING_TICKS,
  type Health,
  health,
  HEALTH_LABEL,
  KIND_LABEL,
  type KindGroup,
  kindGroup,
  KINDS,
  OFFER_DEFAULT,
  OFFER_SORT_LABEL,
  OFFER_STATUS_LABEL,
  type OfferFilter,
  offerFilter,
  offerIs,
  offerRows,
  type OfferSort,
  type OfferStatus,
  SIGNED_DEFAULT,
  SIGNED_SORT_LABEL,
  type SignedFilter,
  signedFilter,
  signedRows,
  type SignedSort,
  volume,
} from './contractList';
import {
  contractFocus,
  contractsTab,
  openContract,
  panel,
  snapshot,
  type ContractsTab,
} from './store';
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
  if (t.kind === 'haulier') {
    return t.cargo === 'container'
      ? 'Container haulier'
      : t.pickup
        ? 'Haulier, pickups'
        : 'Haulier';
  }
  if (t.kind === 'rail') return t.bulk ? 'Coal trains' : 'Rail line';
  if (t.kind === 'fishery' && t.vessel === 'bulker') return 'Bulk line';
  if (t.kind === 'shipper') {
    return t.cargo === 'container'
      ? 'Container shipper'
      : t.goods === 'ice'
        ? 'Ice works'
        : t.goods === 'canned'
          ? 'Cannery'
          : 'Shipper';
  }
  return t.vessel === 'feeder'
    ? 'Container line'
    : t.vessel === 'coaster'
      ? t.catch === 'timber'
        ? 'Timber line'
        : 'Shipping line'
      : t.catch === 'lobster'
        ? 'Lobstermen'
        : 'Fishery';
}

/** What the crates hold, after "crates": " of lobster", or nothing for fish and goods. */
function of(t: Terms): string {
  const what = t.kind === 'shipper' ? t.goods : t.kind === 'fishery' ? t.catch : undefined;
  if (what === 'canned') return ' of canned fish';
  if (what === 'goods' && t.kind === 'fishery') return ' of goods';
  return what === 'ice' || what === 'lobster' || what === 'timber' ? ` of ${what}` : '';
}

function unit(t: Terms): string {
  if ((t.kind === 'fishery' || t.kind === 'rail') && t.bulk) return 'tonnes';
  const boxes =
    t.kind === 'fishery' ? t.vessel === 'feeder' : t.kind === 'rail' || t.cargo === 'container';
  return boxes ? 'containers' : 'crates';
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
          <strong>≈{money(paid(fisheryDailyValue(terms)))}</strong>/day
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
          <strong>≈{money(paid(shipperDailyValue(terms)))}</strong>/day
        </span>
      </div>
    );
  }
  if (terms.kind === 'rail') {
    return (
      <div class="headline">
        <span>
          {terms.bulk ? (
            <>
              <strong>{terms.take}</strong> tonnes of {terms.bulk} a train
            </>
          ) : (
            <>
              <strong>{terms.bring}</strong> out, up to <strong>{terms.take}</strong> in, a train
            </>
          )}
        </span>
        <span class={railDailyValue(terms) >= 0 ? 'pos' : 'neg'}>
          <strong>≈{money(paid(railDailyValue(terms)))}</strong>/day
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
      ['Load', `${t.capacity} ${unit(t)}${of(t)}`],
      ['Pays', `${money(paid(t.fee))} a ${unit(t).slice(0, -1)} on board`],
      [
        'Needs',
        t.goods === 'ice'
          ? 'A truck bay and fishing boats'
          : `Parking outside the port, ${t.cargo ? 'container yards and feeders' : 'crate storage and coasters'}`,
      ],
    ];
  }
  if (t.kind === 'haulier') {
    return [
      ['Fleet', `${t.fleet} truck${t.fleet > 1 ? 's' : ''}`],
      [t.pickup ? 'Per pickup' : 'Per truck', `${t.capacity} ${unit(t)}`],
      [
        'Needs',
        t.cargo
          ? 'Container yards'
          : t.pickup
            ? 'Road beside a truck bay, and dockhands to load it by hand'
            : t.capacity > B.TRUCK_CAPACITY
              ? 'Large truck bays or crate storage'
              : 'Any truck bay',
      ],
    ];
  }
  if (t.kind === 'rail' && t.bulk) {
    return [
      ['A train', `every ${span(t.trainEvery)}`],
      [
        'Takes',
        `${t.take} tonnes of ${t.bulk}, ${Math.round(t.take / B.HOPPER_WAGON)} hopper wagons`,
      ],
      [
        'Pays',
        `${money(paid(t.fee))} a tonne as it leaves; ${money(t.dailyFee)}/day to the railway`,
      ],
      ['Needs', 'A rail loadout over a siding, fed by a conveyor belt from a stockpile'],
    ];
  }
  if (t.kind === 'fishery' && t.vessel === 'bulker') {
    return [
      ['A bulk carrier', `every ${span(t.boatEvery)}`],
      ['Load', `${t.cratesMin}–${t.cratesMax} tonnes of ${t.bulk ?? 'coal'}`],
      ['Pays', `${money(paid(t.fee))} a tonne, as the grab cranes land it`],
      [
        'Needs',
        `A grab crane on a 2-wide quay in ${B.BULKER_DRAFT} m of water, a belt from its hopper to a stockpile`,
      ],
    ];
  }
  if (t.kind === 'rail') {
    return [
      ['A train', `every ${span(t.trainEvery)}`],
      ['Brings', `${t.bring} containers to go out on the feeders`],
      ['Takes', `Up to ${t.take} containers off the feeders, inland`],
      [
        'Pays',
        `${money(paid(t.fee))} a container it brought, on board; ${money(t.dailyFee)}/day to the railway`,
      ],
      [
        'Needs',
        'A rail siding with container yards beside it, in and out, and reach stackers to work the wagons',
      ],
    ];
  }
  return [
    [
      t.vessel === 'feeder'
        ? 'A feeder'
        : t.vessel === 'coaster'
          ? 'A coaster'
          : t.catch === 'lobster'
            ? 'A lobster boat'
            : 'A boat',
      `every ${span(t.boatEvery)}`,
    ],
    ['Load', `${t.cratesMin}–${t.cratesMax} ${unit(t)}${of(t)}`],
    ['Pays', `${money(paid(t.fee))} a ${unit(t).slice(0, -1)}`],
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
        ? 'Bottleneck: moving cargo on from the jib cranes. Buy forklifts to empty the storage beside them, or mark out more of it.'
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
          hint="Dockhands carry crates all the way to the bays and storage; forklifts empty storage the trucks cannot reach, as by a jib crane"
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

// ── Lists ─────────────────────────────────────────────────

function Swatch({ terms }: { terms: Terms }) {
  const color = terms.kind === 'fishery' ? C.hulls[terms.color] : C.trucks[terms.color];
  return <span class="swatch" style={{ background: css(color) }} />;
}

/** The money a day, signed: green coming in, red going out. */
function Value({ terms }: { terms: Terms }) {
  const v = dailyValue(terms);
  return (
    <span class={`crow-value ${v >= 0 ? 'pos' : 'neg'}`}>
      {v >= 0 ? `≈${money(v)}` : money(v)}
      <span class="muted">/day</span>
    </span>
  );
}

/**
 * One contract or offer as a line: what it is, what it pays and how it is
 * getting on, a reason under it when it is not working, and the full terms
 * when it is opened.
 */
function Row({
  terms,
  open,
  onToggle,
  tone,
  right,
  why,
  whyTone,
  offer,
  children,
  rowRef,
}: {
  terms: Terms;
  open: boolean;
  onToggle: () => void;
  tone?: string;
  right: ComponentChildren;
  why?: string | null;
  whyTone?: string;
  offer?: boolean;
  children: ComponentChildren;
  rowRef?: { current: HTMLDivElement | null };
}) {
  return (
    <div ref={rowRef} class={`crow ${offer ? 'offer' : ''} ${tone ?? ''} ${open ? 'open' : ''}`}>
      <button class="crow-main" aria-expanded={open} onClick={onToggle}>
        <Swatch terms={terms} />
        <span class="crow-what">
          <span class="crow-name">{terms.name}</span>
          <span class="crow-sub">
            <span class={`badge ${terms.kind}`}>{kindLabel(terms)}</span>
            <span>{CARGO_LABEL[cargoOf(terms)]}</span>
            <span>{volume(terms)}</span>
          </span>
        </span>
        <span class="crow-right">
          <Value terms={terms} />
          {right}
        </span>
        <span class="crow-caret" aria-hidden="true" />
      </button>
      {why && <p class={`crow-why ${whyTone ?? ''}`}>{why}</p>}
      {open && <div class="crow-body">{children}</div>}
    </div>
  );
}

function SignedRow({
  c,
  state,
  why,
  open,
  onToggle,
  actions,
}: {
  c: ContractView;
  state: Health;
  why?: string;
  open: boolean;
  onToggle: () => void;
  actions: Actions;
}) {
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
  } else if (t.kind === 'rail') {
    rows.push(['Next train', c.nextIn <= 0 ? 'Due now' : `in ${span(c.nextIn / TICKS_PER_DAY)}`]);
    rows.push([
      'At the port',
      c.active > 0 ? 'A train in its siding' : <span class="muted">None</span>,
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
  // Opened on this one from its red mark on the map: bring it into view.
  const focused = contractFocus.value === c.id;
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) row.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focused]);
  const tone = state === 'trouble' || focused ? 'bad' : state === 'held' ? 'warn' : '';
  return (
    <Row
      terms={t}
      open={open}
      onToggle={onToggle}
      tone={tone}
      rowRef={row}
      why={why}
      whyTone={state === 'trouble' ? 'bad' : 'warn'}
      right={<span class={`pill ${state}`}>{HEALTH_LABEL[state]}</span>}
    >
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
    </Row>
  );
}

// ── Offers ────────────────────────────────────────────────

interface CheckView {
  ok: boolean;
  warn?: boolean;
  text: string;
}

function Check({ k }: { k: CheckView }) {
  const tone = k.ok ? 'good' : k.warn ? 'warn' : 'bad';
  return (
    <li class={`check ${tone}`}>
      <span class="check-mark">{k.ok ? '✓' : k.warn ? '!' : '✕'}</span>
      <span>{k.text}</span>
    </li>
  );
}

/**
 * What an offer needs, checked against the port as it stands, and why it
 * cannot be signed at all yet (no berth for its ships, or what the sim says
 * in `blocked`), or null.
 */
export function offerChecks(
  o: OfferView,
  s: Snapshot,
): { checks: CheckView[]; blocked: string | null } {
  const t = o.terms;
  const cap = s.capacity;
  const checks: CheckView[] = [];
  let blocked: string | null = o.blocked ?? null;
  const add = (ok: boolean, text: string, warn?: boolean) => checks.push({ ok, warn, text });

  if (t.kind === 'fishery' && t.vessel === 'bulker') {
    const grabs = s.bulk.grabs.length;
    if (grabs === 0) blocked ??= 'No grab crane yet: build one on a quay edge in deep water';
    add(
      grabs > 0,
      grabs > 0
        ? `${grabs} grab crane${grabs === 1 ? '' : 's'} to land it`
        : `Needs a grab crane on a 2-wide quay in ${B.BULKER_DRAFT} m of water`,
    );
  }
  if (t.kind === 'rail' && t.bulk) {
    const loadouts = s.sidings.filter((x) => x.loadout).length;
    add(
      loadouts > 0,
      loadouts > 0
        ? 'A rail loadout over a siding to fill its wagons'
        : 'Needs a rail loadout over a siding, fed by a belt from a stockpile',
    );
  }
  if (t.kind === 'fishery' && t.vessel === 'feeder') {
    const b = cap.boxes;
    const after = b.demand + Math.round(fisheryDailyCrates(t));
    if (b.berths === 0) blocked ??= 'No feeder berth yet: needs a harbour or gantry crane';
    add(
      b.berths > 0,
      b.berths > 0
        ? `${b.berths} feeder berth${b.berths === 1 ? '' : 's'} with a container crane`
        : 'No feeder berth: needs a harbour or gantry crane on a 2-wide quay in 4 m of water, with 7 tiles of open water along it',
    );
    add(after <= b.lifting, `Lifting: ${after} needed, ${b.lifting} possible`, after > b.lifting);
    add(after <= b.moving, `Moving: ${after} needed, ${b.moving} possible`, after > b.moving);
    add(
      after <= b.trucking,
      `Trucking: ${after} needed, ${b.trucking} possible`,
      after > b.trucking,
    );
  } else if (t.kind === 'haulier' && t.cargo === 'container') {
    const yards = s.yards.length;
    add(
      yards > 0,
      yards > 0
        ? `${yards} container yard${yards === 1 ? '' : 's'} to load at`
        : 'Container trucks load at a container yard: mark one out on port road or quay, with a port road beside it inside a port gate',
    );
  } else if (t.kind === 'shipper' && t.goods === 'ice') {
    // Ice comes straight to a truck bay, for the fishing boats to take.
    const boats = s.contracts.some((c) => c.terms.kind === 'fishery' && c.terms.vessel === 'smack');
    // Ice and the catch keep to truck bays of their own: one for each.
    const bays = s.bays.filter((b) => !b.tiles && !b.large).length;
    add(
      boats,
      boats ? 'Fishing boats call to take it on board' : 'No fishing boats call yet to take it',
    );
    add(
      bays >= 2,
      bays >= 2
        ? 'A truck bay of its own to unload into, besides one for the catch'
        : 'Needs a truck bay of its own: ice and the catch never share one. Build another',
    );
  } else if (t.kind === 'shipper') {
    // What its trucks need, as the port stands: worked out in the sim (shipperChecks).
    for (const k of o.checks ?? []) checks.push(k);
    if (t.goods === 'canned') {
      add(
        true,
        `The canned fish waits in the outgoing storage about ${Math.round((B.EXPORT_PAPERS_TICKS / TICKS_PER_DAY) * 24)} h for its export papers before it may go on board: room for half a day of it`,
      );
    }
  } else if (t.kind === 'fishery') {
    const after = cap.demand + Math.round(fisheryDailyCrates(t));
    const payback = o.signingFee / Math.max(1, paid(fisheryDailyValue(t)));
    const unloadOk = after <= cap.unloading;
    const truckOk = after <= cap.trucking;
    add(
      unloadOk,
      `Unloading: ${after} needed, ${cap.unloading} possible`,
      !unloadOk && after <= cap.unloading * 1.2,
    );
    add(
      truckOk,
      `Trucking: ${after} needed, ${cap.trucking} possible`,
      !truckOk && after <= cap.trucking * 1.2,
    );
    // Timber and goods wait a day in crate storage for customs.
    if (t.catch === 'timber' || t.catch === 'goods') {
      const room = s.bays.some((b) => b.tiles && !b.outgoing);
      const h = Math.round((B.CRATE_CUSTOMS_TICKS / TICKS_PER_DAY) * 24);
      add(
        room,
        room
          ? `Its ${t.catch} waits about ${h} h in crate storage for customs: room for a day of it`
          : `Needs crate storage for cargo coming in: its ${t.catch} waits there about ${h} h for customs`,
      );
    }
    if (t.vessel === 'coaster') {
      const ok = cap.deepBerths > 0;
      if (!ok)
        blocked ??= `No coaster berth yet: needs a 2-wide quay in ${B.COASTER_DRAFT} m of water`;
      add(
        ok,
        ok
          ? `${cap.deepBerths} coaster berth${cap.deepBerths === 1 ? '' : 's'} (${B.COASTER_DRAFT} m deep, 2-wide quay)`
          : `No coaster berth yet: needs a quay two tiles wide, in ${B.COASTER_DRAFT} m of water`,
      );
      const pallets = cap.pallets.demand + Math.round(fisheryDailyCrates(t));
      const forks = cap.pallets.unloading;
      add(
        forks >= pallets,
        forks > 0
          ? `Pallets: ${pallets} crates a day, ${forks} can be unloaded`
          : 'Crates come on pallets: dockhands carry them off into crate storage or a truck bay, or a jib crane swings them into crate storage beside it',
        forks > 0 && forks < pallets,
      );
    }
    add(payback <= 3, `Signing fee pays back in ${span(payback)}`, payback > 3);
  } else if (t.kind === 'rail') {
    const yards = s.yards.length;
    add(
      s.sidings.length > 0,
      s.sidings.length > 0
        ? `${s.sidings.length} rail siding${s.sidings.length === 1 ? '' : 's'}`
        : 'No rail siding yet: lay one off the main line (Roads, then Rail siding)',
    );
    add(
      yards > 0,
      yards > 0
        ? 'Container yards for its trains to be worked from, beside a siding'
        : 'Needs container yards beside a siding, in and out',
    );
  } else {
    const trucks = s.contracts.reduce(
      (n, c) => n + (c.terms.kind === 'haulier' ? c.terms.fleet : 0),
      0,
    );
    const bays = s.bays.length;
    const gain = o.truckingAfter - cap.trucking;
    const total = trucks + t.fleet;
    add(gain > 0, `Trucking ${cap.trucking} → ${o.truckingAfter} crates/day`, gain === 0);
    add(
      total <= bays,
      total <= bays
        ? `${bays} truck bays for ${total} trucks`
        : `Only ${bays} truck bay${bays === 1 ? '' : 's'} for ${total} trucks: build more bays`,
      total > bays,
    );
  }
  return { checks, blocked };
}

/** Why an offer cannot be signed right now, or null: blocked, or too dear. */
export function whyNot(o: OfferView, s: Snapshot): string | null {
  const { blocked } = offerChecks(o, s);
  if (blocked) return blocked;
  if (s.cash < o.signingFee) return `Needs ${money(o.signingFee - s.cash)} more cash to sign`;
  return null;
}

function OfferRow({
  o,
  s,
  open,
  onToggle,
  actions,
}: {
  o: OfferView;
  s: Snapshot;
  open: boolean;
  onToggle: () => void;
  actions: Actions;
}) {
  const t = o.terms;
  const days = Math.max(1, Math.ceil(o.expiresIn / TICKS_PER_DAY));
  const { checks, blocked } = offerChecks(o, s);
  const why = blocked ?? (s.cash < o.signingFee ? whyNot(o, s) : null);
  // The first thing short, for a row closed: what to build before signing.
  const short = why ? null : (checks.find((k) => !k.ok && !k.warn)?.text ?? null);
  const expiring = o.expiresIn <= EXPIRING_TICKS;
  return (
    <Row
      terms={t}
      offer
      open={open}
      onToggle={onToggle}
      tone={blocked ? 'locked' : ''}
      why={why ?? (open ? null : short)}
      whyTone={blocked ? 'bad' : 'warn'}
      right={<span class={`pill ${expiring ? 'expiring' : 'days'}`}>{days}d left</span>}
    >
      <Headline terms={t} />
      <Facts rows={termRows(t)} />
      <ul class="checks">
        {checks.map((k) => (
          <Check key={k.text} k={k} />
        ))}
      </ul>
      <div class="card-foot">
        <span class="muted">
          {t.kind === 'fishery' ? `Walk-out penalty ${money(o.breach)}` : 'No penalties'}
        </span>
        <button
          class="btn primary sm"
          disabled={!!why}
          title={why ?? undefined}
          onClick={() => actions.send({ type: 'signContract', id: o.id })}
        >
          Sign · {money(o.signingFee)}
        </button>
      </div>
    </Row>
  );
}

// ── Filters ───────────────────────────────────────────────

function Seg<T extends string>({
  options,
  value,
  onPick,
  label,
}: {
  options: { id: T | 'all'; label: string; count: number; tone?: string }[];
  value: T | 'all';
  onPick: (v: T | 'all') => void;
  label: string;
}) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          class={`seg-btn ${o.tone ?? ''} ${value === o.id ? 'on' : ''}`}
          aria-pressed={value === o.id}
          onClick={() => onPick(o.id)}
        >
          {o.label}
          <span class="seg-count">{o.count}</span>
        </button>
      ))}
    </div>
  );
}

function Pick<T extends string>({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onPick: (v: T) => void;
}) {
  return (
    <label class="cpick">
      <span class="field-label">{label}</span>
      <select value={value} onChange={(e) => onPick((e.target as HTMLSelectElement).value as T)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Kind and cargo choices for the terms in a list: those it has, with how many, and the one chosen. */
function kindCargoOptions(all: Terms[], f: { kind: KindGroup | 'all'; cargo: Cargo | 'all' }) {
  const kinds: { id: KindGroup | 'all'; label: string }[] = [
    { id: 'all', label: `All kinds (${all.length})` },
  ];
  for (const k of KINDS) {
    const n = all.filter((t) => kindGroup(t) === k).length;
    if (n > 0 || f.kind === k) kinds.push({ id: k, label: `${KIND_LABEL[k]} (${n})` });
  }
  const cargos: { id: Cargo | 'all'; label: string }[] = [{ id: 'all', label: 'All cargo' }];
  for (const k of CARGOS) {
    const n = all.filter((t) => cargoOf(t) === k).length;
    if (n > 0 || f.cargo === k) cargos.push({ id: k, label: `${CARGO_LABEL[k]} (${n})` });
  }
  return { kinds, cargos };
}

function NoMatch({ onClear }: { onClear: () => void }) {
  return (
    <p class="muted cnone">
      None match these filters.{' '}
      <button class="link" onClick={onClear}>
        Show all
      </button>
    </p>
  );
}

function useOpen(): [Set<number>, (id: number) => void] {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (id: number) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return [open, toggle];
}

function SignedList({ actions }: { actions: Actions }) {
  const s = snapshot.value!;
  const f = signedFilter.value;
  const set = (p: Partial<SignedFilter>) => (signedFilter.value = { ...f, ...p });
  const [open, toggle] = useOpen();
  const focus = contractFocus.value;
  // Counts for each status among those of the kind and cargo chosen.
  const narrowed = signedRows(s.contracts, { ...f, status: 'all' });
  const count = (h: Health) => narrowed.filter((r) => r.health === h).length;
  let rows = signedRows(s.contracts, f);
  // The contract the panel was opened on shows whatever the filters say.
  if (focus !== null && !rows.some((r) => r.c.id === focus)) {
    const c = s.contracts.find((c) => c.id === focus);
    if (c) rows = [{ c, ...health(c) }, ...rows];
  }
  const { kinds, cargos } = kindCargoOptions(
    s.contracts.map((c) => c.terms),
    f,
  );
  if (s.contracts.length === 0) {
    return <p class="muted">No contracts signed yet. Sign one from the Offers tab.</p>;
  }
  return (
    <>
      <div class="cfilter">
        <Seg<Health>
          label="Status"
          value={f.status}
          onPick={(status) => set({ status })}
          options={[
            { id: 'all', label: 'All', count: narrowed.length },
            { id: 'working', label: 'Working', count: count('working'), tone: 'good' },
            { id: 'held', label: 'Held up', count: count('held'), tone: 'warn' },
            { id: 'trouble', label: 'Trouble', count: count('trouble'), tone: 'bad' },
          ]}
        />
        <div class="cpicks">
          <Pick label="Kind" value={f.kind} options={kinds} onPick={(kind) => set({ kind })} />
          <Pick label="Cargo" value={f.cargo} options={cargos} onPick={(cargo) => set({ cargo })} />
          <Pick
            label="Sort"
            value={f.sort}
            options={(Object.keys(SIGNED_SORT_LABEL) as SignedSort[]).map((id) => ({
              id,
              label: SIGNED_SORT_LABEL[id],
            }))}
            onPick={(sort) => set({ sort })}
          />
        </div>
      </div>
      {rows.length === 0 && (
        <NoMatch onClear={() => (signedFilter.value = { ...SIGNED_DEFAULT, sort: f.sort })} />
      )}
      <div class="clist">
        {rows.map((r) => (
          <SignedRow
            key={r.c.id}
            c={r.c}
            state={r.health}
            why={r.why}
            open={open.has(r.c.id) || r.c.id === focus}
            onToggle={() => {
              if (r.c.id === focus) contractFocus.value = null;
              else toggle(r.c.id);
            }}
            actions={actions}
          />
        ))}
      </div>
    </>
  );
}

function OfferList({ actions }: { actions: Actions }) {
  const s = snapshot.value!;
  const f = offerFilter.value;
  const set = (p: Partial<OfferFilter>) => (offerFilter.value = { ...f, ...p });
  const [open, toggle] = useOpen();
  const blocked = (o: OfferView) => whyNot(o, s);
  const narrowed = offerRows(s.offers, { ...f, status: 'all' }, blocked);
  const count = (st: OfferStatus) => narrowed.filter((o) => offerIs(o, st, blocked)).length;
  const rows = offerRows(s.offers, f, blocked);
  const { kinds, cargos } = kindCargoOptions(
    s.offers.map((o) => o.terms),
    f,
  );
  if (s.offers.length === 0) {
    return <p class="muted">No offers right now. New ones arrive every few days.</p>;
  }
  return (
    <>
      <div class="cfilter">
        <Seg<OfferStatus>
          label="Status"
          value={f.status}
          onPick={(status) => set({ status })}
          options={[
            { id: 'all', label: 'All', count: narrowed.length },
            { id: 'ready', label: OFFER_STATUS_LABEL.ready, count: count('ready'), tone: 'good' },
            {
              id: 'blocked',
              label: OFFER_STATUS_LABEL.blocked,
              count: count('blocked'),
              tone: 'bad',
            },
            {
              id: 'expiring',
              label: OFFER_STATUS_LABEL.expiring,
              count: count('expiring'),
              tone: 'warn',
            },
          ]}
        />
        <div class="cpicks">
          <Pick label="Kind" value={f.kind} options={kinds} onPick={(kind) => set({ kind })} />
          <Pick label="Cargo" value={f.cargo} options={cargos} onPick={(cargo) => set({ cargo })} />
          <Pick
            label="Sort"
            value={f.sort}
            options={(Object.keys(OFFER_SORT_LABEL) as OfferSort[]).map((id) => ({
              id,
              label: OFFER_SORT_LABEL[id],
            }))}
            onPick={(sort) => set({ sort })}
          />
        </div>
      </div>
      {rows.length === 0 && (
        <NoMatch onClear={() => (offerFilter.value = { ...OFFER_DEFAULT, sort: f.sort })} />
      )}
      <div class="clist">
        {rows.map((o) => (
          <OfferRow
            key={o.id}
            o={o}
            s={s}
            open={open.has(o.id)}
            onToggle={() => toggle(o.id)}
            actions={actions}
          />
        ))}
      </div>
    </>
  );
}

// ── Penalties ─────────────────────────────────────────────

function Rules() {
  const rows: [string, string][] = [
    [
      'A boat waits at anchor, or unloads or loads exports slowly',
      `${money(fined(B.DEMURRAGE_PER_DAY))} per boat per day`,
    ],
    [
      `A boat gives up after ${span(B.BOAT_GIVE_UP_TICKS / TICKS_PER_DAY)}`,
      `${Math.round(B.LOST_CARGO_SHARE * fineRate() * 100)}% of the cargo still on board`,
    ],
    [
      'A fishery or shipping line walks out',
      `${B.BREACH_MULTIPLIER * fineRate()}× the signing fee, at least ${money(fined(B.BREACH_MIN))}`,
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
    income += paid(fisheryDailyValue(c.terms));
  }
  for (const c of ships) if (c.terms.kind === 'shipper') income += paid(shipperDailyValue(c.terms));
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
  // Those needing attention first, then by kind and name.
  const rows = signedRows(s.contracts, SIGNED_DEFAULT);
  const notWorking = rows.filter((r) => r.health !== 'working').length;
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
      {notWorking > 0 && (
        <p class="hint">
          {notWorking} contract{notWorking === 1 ? ' is' : 's are'} not working as they should.{' '}
          <button
            class="link"
            onClick={() => {
              signedFilter.value = { ...SIGNED_DEFAULT, status: 'all', sort: 'status' };
              contractsTab.value = 'active';
            }}
          >
            See why
          </button>
        </p>
      )}
      <table class="roster">
        <tbody>
          {rows.map(({ c, health: h }) => {
            const t = c.terms;
            return (
              <tr key={c.id} onClick={() => openContract(c.id)} title="Show in detail">
                <td>
                  <Swatch terms={t} />
                </td>
                <td class="roster-name">{t.name}</td>
                <td class="muted roster-kind">{kindLabel(t)}</td>
                <td class="num">
                  <span class={`pill ${h}`}>{HEALTH_LABEL[h]}</span>
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
  const notWorking = s.contracts.filter((c) => health(c).health !== 'working').length;
  const ready = s.offers.filter((o) => whyNot(o, s) === null).length;
  return (
    <aside class="side panel wide xwide contracts" aria-label="Contracts">
      <InfoHeader kicker="Business" title="Contracts" onClose={() => (panel.value = null)} />
      <div class="tabs" role="tablist">
        <TabButton id="overview">Overview</TabButton>
        <TabButton id="active">
          Signed <span class="tab-count">{s.contracts.length}</span>
          {notWorking > 0 && (
            <span class="count bad" title="Contracts held up or in trouble">
              {notWorking}
            </span>
          )}
        </TabButton>
        <TabButton id="offers">
          Offers <span class="tab-count">{s.offers.length}</span>
          {ready > 0 && (
            <span class="count good" title="Offers you can sign now">
              {ready}
            </span>
          )}
        </TabButton>
        <TabButton id="rules">
          <Icon name="alert" />
          <span class="tab-label">Penalties</span>
        </TabButton>
      </div>

      {tab === 'overview' && <Overview />}
      {tab === 'active' && <SignedList actions={actions} />}
      {tab === 'offers' && <OfferList actions={actions} />}
      {tab === 'rules' && <Rules />}
    </aside>
  );
}
