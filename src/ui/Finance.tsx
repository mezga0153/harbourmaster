import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { LineSeries, PAD, shortDate, ticks, Tip, useHover, W } from './charts';
import type { FinanceDay, Ledger, LedgerCategory } from '../protocol';
import * as B from '../sim/balance';
import type { Actions } from './App';
import { formatDate, money } from './format';
import { panel, snapshot } from './store';
import { InfoHeader, Meter, MoneyTabs } from './widgets';

/** The port tier where containers come in: the Container Port. */
export const CONTAINER_TIER = 2;

/** The kinds of income, in a fixed order that keeps their colours. */
const INCOME: { key: LedgerCategory; label: string }[] = [
  { key: 'cargo', label: 'Crates trucked out' },
  { key: 'containers', label: 'Containers trucked out' },
  { key: 'exports', label: 'Exports shipped' },
  { key: 'town', label: 'Town deliveries' },
];

const ROWS: { key: LedgerCategory; label: string }[] = [
  ...INCOME,
  { key: 'wages', label: 'Wages' },
  { key: 'hauliers', label: 'Haulier fees' },
  { key: 'construction', label: 'Construction' },
  { key: 'hiring', label: 'Hiring' },
  { key: 'contracts', label: 'Contracts' },
  { key: 'penalties', label: 'Penalties' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'interest', label: 'Loan interest' },
];

/** How many days back the charts look; kept while the panel is closed. */
const RANGES = [7, 30, 60] as const;
const range = signal<(typeof RANGES)[number]>(30);
/** The statement line opened to its chart, if any. */
const opened = signal<LedgerCategory | null>(null);

function total(l: Ledger): number {
  return ROWS.reduce((n, r) => n + l[r.key], 0);
}

function income(l: Ledger): number {
  return ROWS.reduce((n, r) => n + Math.max(0, l[r.key]), 0);
}

function costs(l: Ledger): number {
  return ROWS.reduce((n, r) => n + Math.min(0, l[r.key]), 0);
}

/** Money short enough for an axis or a tile: $840, $12.9K, $4.2M. */
function compact(n: number): string {
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(n);
  const short =
    a >= 1e6
      ? `${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`
      : a >= 1e3
        ? `${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`
        : `${Math.round(a)}`;
  return `${sign}$${short.replace(/\.0(?=[KM])/, '')}`;
}

function Amount({ value }: { value: number }) {
  if (value === 0) return <span class="muted">—</span>;
  return <span class={value > 0 ? 'pos' : 'neg'}>{money(value)}</span>;
}

/** A figure with what it is and how it moved. */
function Tile({
  label,
  value,
  delta,
  tone,
}: {
  label: string;
  value: string;
  delta?: string;
  tone?: 'pos' | 'neg';
}) {
  return (
    <div class="fin-tile">
      <div class="fin-tile-label">{label}</div>
      <div class={`fin-tile-value ${tone ?? ''}`}>{value}</div>
      {delta && <div class="fin-tile-delta">{delta}</div>}
    </div>
  );
}

/** Cash at the end of each day. */
function CashChart({ days }: { days: FinanceDay[] }) {
  return (
    <LineSeries
      points={days.map((d) => ({ tick: d.tick - 1, value: d.cash }))}
      format={compact}
      label="Cash at the end of each day"
      tip={(p) => (
        <>
          <div class="viz-tip-head">{formatDate(p.tick)}</div>
          <div>{money(p.value)}</div>
        </>
      )}
    />
  );
}

/**
 * A figure for each day as columns, up from the zero line in blue for
 * money in or a profit, down from it in red for money out or a loss.
 */
function DayColumns({
  days,
  value,
  label,
  tip,
  height = 120,
}: {
  days: FinanceDay[];
  value: (d: FinanceDay) => number;
  label: string;
  tip: (d: FinanceDay) => ComponentChildren;
  height?: number;
}) {
  const { at, setAt } = useHover();
  const H = height;
  const net = days.map(value);
  const lo = Math.min(0, ...net);
  const hi = Math.max(0, ...net, lo + 1);
  const axis = ticks(lo, hi, 3);
  const y0 = Math.min(lo, axis[0] ?? lo);
  const y1 = Math.max(hi, axis[axis.length - 1] ?? hi);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / days.length;
  // Thin columns, a gap of air between them, never wider than 24.
  const bar = Math.max(1, Math.min(24, band - 2));
  const y = (v: number) => PAD.top + (1 - (v - y0) / (y1 - y0)) * plotH;
  const cx = (k: number) => PAD.left + band * (k + 0.5);
  const r = Math.min(4, bar / 2);
  /** A column from the zero line to v, rounded at its far end only. */
  const column = (k: number, v: number) => {
    const left = cx(k) - bar / 2;
    const base = y(0);
    const end = y(v);
    const h = Math.abs(end - base);
    if (h < 0.5) return '';
    const rr = Math.min(r, h);
    if (v >= 0) {
      return `M${left},${base}V${end + rr}Q${left},${end} ${left + rr},${end}H${left + bar - rr}Q${left + bar},${end} ${left + bar},${end + rr}V${base}Z`;
    }
    return `M${left},${base}V${end - rr}Q${left},${end} ${left + rr},${end}H${left + bar - rr}Q${left + bar},${end} ${left + bar},${end - rr}V${base}Z`;
  };
  const hover = at === null ? null : days[at];
  return (
    <div class="viz">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={label}
        onMouseMove={(e) => {
          const svg = e.currentTarget as SVGSVGElement;
          const box = svg.getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * W;
          setAt(Math.max(0, Math.min(days.length - 1, Math.floor((px - PAD.left) / band))));
        }}
        onMouseLeave={() => setAt(null)}
      >
        {axis.map((v) => (
          <g key={v}>
            <line
              class={v === 0 ? 'viz-zero' : 'viz-grid'}
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(v)}
              y2={y(v)}
            />
            <text class="viz-axis" x={PAD.left - 6} y={y(v) + 3.5} text-anchor="end">
              {compact(v)}
            </text>
          </g>
        ))}
        {at !== null && (
          <rect
            class="viz-hover-band"
            x={PAD.left + band * at}
            y={PAD.top}
            width={band}
            height={plotH}
          />
        )}
        {net.map((v, k) => (
          <path key={k} class={v >= 0 ? 'viz-gain' : 'viz-loss'} d={column(k, v)} />
        ))}
        <text class="viz-axis" x={PAD.left} y={H - 4}>
          {shortDate(days[0].tick - 1)}
        </text>
        <text class="viz-axis" x={W - PAD.right} y={H - 4} text-anchor="end">
          {shortDate(days[days.length - 1].tick - 1)}
        </text>
      </svg>
      {hover && at !== null && (
        <Tip x={cx(at)}>
          <div class="viz-tip-head">{formatDate(hover.tick - 1)}</div>
          {tip(hover)}
        </Tip>
      )}
    </div>
  );
}

/** Each day's profit or loss. */
function ProfitChart({ days }: { days: FinanceDay[] }) {
  return (
    <DayColumns
      days={days}
      value={(d) => total(d.ledger)}
      label="Profit or loss each day"
      tip={(d) => (
        <>
          <div class="viz-tip-row">
            <span>In</span>
            <span>{money(income(d.ledger))}</span>
          </div>
          <div class="viz-tip-row">
            <span>Out</span>
            <span>{money(costs(d.ledger))}</span>
          </div>
          <div class="viz-tip-row strong">
            <span>{total(d.ledger) >= 0 ? 'Profit' : 'Loss'}</span>
            <span>{money(total(d.ledger))}</span>
          </div>
        </>
      )}
    />
  );
}

/** One line of the statement, day by day. */
function LineChart({ days, row }: { days: FinanceDay[]; row: (typeof ROWS)[number] }) {
  const sum = days.reduce((n, d) => n + d.ledger[row.key], 0);
  return (
    <div class="fin-line-chart">
      <div class="fin-line-head">
        <span class="muted">
          {row.label}, last {days.length} days
        </span>
        <Amount value={sum} />
      </div>
      <DayColumns
        days={days}
        height={96}
        value={(d) => d.ledger[row.key]}
        label={`${row.label} each day`}
        tip={(d) => <div class="viz-tip-row strong">{money(d.ledger[row.key])}</div>}
      />
    </div>
  );
}

/** Slices of a pie: from the top, clockwise, a gap of the panel between them. */
function slice(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    return `M${cx},${cy - r}A${r},${r} 0 1 1 ${cx - 0.01},${cy - r}Z`;
  }
  const p = (a: number) => [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  return `M${cx},${cy}L${x0},${y0}A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1},${y1}Z`;
}

/** Where the money comes from over the days shown: a pie, with each kind's amount and share. */
function IncomePie({ days }: { days: FinanceDay[] }) {
  const [at, setAt] = useState<LedgerCategory | null>(null);
  const kinds = INCOME.map((r, k) => ({
    ...r,
    slot: k + 1,
    sum: days.reduce((n, d) => n + Math.max(0, d.ledger[r.key]), 0),
  }));
  const all = kinds.reduce((n, r) => n + r.sum, 0);
  if (all <= 0) return <p class="muted">No income over these days.</p>;
  const shown = kinds.filter((r) => r.sum > 0);
  let a = 0;
  const arcs = shown.map((r) => {
    const a0 = a;
    a += (r.sum / all) * Math.PI * 2;
    return { ...r, a0, a1: a };
  });
  const S = 112;
  return (
    <div class="fin-pie">
      <svg viewBox={`0 0 ${S} ${S}`} role="img" aria-label="Income by kind">
        {arcs.map((r) => (
          <path
            key={r.key}
            class={`viz-slot-${r.slot} viz-slice ${at && at !== r.key ? 'dim' : ''}`}
            d={slice(S / 2, S / 2, S / 2 - 2, r.a0, r.a1)}
            onMouseEnter={() => setAt(r.key)}
            onMouseLeave={() => setAt(null)}
          />
        ))}
      </svg>
      <div class="fin-pie-legend">
        {kinds.map((r) => (
          <div
            key={r.key}
            class={`fin-pie-row ${at === r.key ? 'on' : ''} ${r.sum > 0 ? '' : 'none'}`}
            onMouseEnter={() => setAt(r.key)}
            onMouseLeave={() => setAt(null)}
          >
            <span class={`viz-key viz-slot-${r.slot}`} />
            <span class="fin-pie-label">{r.label}</span>
            <span class="fin-pie-value">{compact(r.sum)}</span>
            <span class="fin-pie-share">{Math.round((r.sum / all) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** What the money went on over the days shown, biggest first. */
function Spending({ days }: { days: FinanceDay[] }) {
  const sums = ROWS.filter((r) => !INCOME.includes(r))
    .map((r) => ({ ...r, spent: -days.reduce((n, d) => n + Math.min(0, d.ledger[r.key]), 0) }))
    .filter((r) => r.spent > 0)
    .sort((a, b) => b.spent - a.spent);
  if (sums.length === 0) return <p class="muted">Nothing spent.</p>;
  const most = sums[0].spent;
  return (
    <div class="fin-bars">
      {sums.map((r) => (
        <div class="fin-bar" key={r.key}>
          <span class="fin-bar-label">{r.label}</span>
          <span class="fin-bar-track">
            <span
              class="fin-bar-fill"
              style={{ width: `${Math.max(1, (r.spent / most) * 100)}%` }}
            />
          </span>
          <span class="fin-bar-value">{compact(r.spent)}</span>
        </div>
      ))}
    </div>
  );
}

export function FinancePanel({ actions }: { actions: Actions }) {
  const s = snapshot.value;
  if (!s) return null;
  const y = s.yesterday;
  const history = s.history ?? [];
  const days = history.slice(-range.value);
  const before = history.length >= 2 ? total(history[history.length - 2].ledger) : null;
  const lastNet = y ? total(y) : null;
  const shownIn = days.reduce((n, d) => n + income(d.ledger), 0);
  const shownOut = days.reduce((n, d) => n + costs(d.ledger), 0);
  const average = days.length ? (shownIn + shownOut) / days.length : null;
  // Containers only once the port can take them, or has.
  const containers =
    s.progress.tier >= CONTAINER_TIER || history.some((d) => d.ledger.containers !== 0);
  return (
    <aside class="side panel xwide finance" aria-label="Finance">
      <InfoHeader kicker="Money" title="Finance" onClose={() => (panel.value = null)} />
      <MoneyTabs on="finance" />

      <div class="fin-tiles">
        <Tile label="Cash" value={compact(s.cash)} tone={s.cash < 0 ? 'neg' : undefined} />
        <Tile
          label="Yesterday"
          value={lastNet === null ? '—' : compact(lastNet)}
          tone={lastNet === null ? undefined : lastNet >= 0 ? 'pos' : 'neg'}
          delta={
            lastNet !== null && before !== null
              ? `${lastNet - before >= 0 ? '▲' : '▼'} ${compact(Math.abs(lastNet - before))} vs the day before`
              : undefined
          }
        />
        <Tile
          label="Average a day"
          value={average === null ? '—' : compact(average)}
          tone={average === null ? undefined : average >= 0 ? 'pos' : 'neg'}
        />
      </div>

      {days.length < 2 ? (
        <p class="muted">The charts fill in as the days go by: come back after a day or two.</p>
      ) : (
        <>
          <div class="fin-range">
            <span class="muted">
              In {compact(shownIn)} · out {compact(-shownOut)}
            </span>
            <div class="segmented" role="group" aria-label="Days shown">
              {RANGES.map((n) => (
                <button
                  key={n}
                  class={range.value === n ? 'on' : ''}
                  onClick={() => (range.value = n)}
                >
                  {n} days
                </button>
              ))}
            </div>
          </div>

          <div class="section-title">
            <span>Cash</span>
            <span class="muted">at the end of each day</span>
          </div>
          <CashChart days={days} />

          <div class="section-title">
            <span>Profit and loss</span>
            <span class="viz-legend">
              <span class="viz-key gain" /> profit
              <span class="viz-key loss" /> loss
            </span>
          </div>
          <ProfitChart days={days} />

          <div class="section-title">
            <span>Where the money comes from</span>
            <span class="muted">over these days</span>
          </div>
          <IncomePie days={days} />

          <div class="section-title">
            <span>Where the money goes</span>
            <span class="muted">over these days</span>
          </div>
          <Spending days={days} />
        </>
      )}

      <div class="section-title">
        <span>Bank loan</span>
        <span class="muted">{(B.LOAN_DAILY_RATE * 100).toFixed(1)}% interest per day</span>
      </div>
      <div class="card">
        <dl class="terms">
          <div>
            <dt>Owed</dt>
            <dd>{money(s.loan)}</dd>
          </div>
          <div>
            <dt>Interest</dt>
            <dd>{money(s.interest)} / day</dd>
          </div>
        </dl>
        <Meter value={s.loan / B.LOAN_MAX} tone={s.loan > B.LOAN_MAX * 0.75 ? 'warn' : 'ok'} />
        <div class="card-foot">
          <span class="muted">Limit {money(B.LOAN_MAX)}</span>
          <span class="confirm">
            <button
              class="btn sm"
              disabled={s.loan === 0 || s.cash < Math.min(B.LOAN_STEP, s.loan)}
              onClick={() => actions.send({ type: 'loan', amount: -B.LOAN_STEP })}
            >
              Repay {money(Math.min(B.LOAN_STEP, s.loan) || B.LOAN_STEP)}
            </button>
            <button
              class="btn primary sm"
              disabled={s.loan >= B.LOAN_MAX}
              onClick={() => actions.send({ type: 'loan', amount: B.LOAN_STEP })}
            >
              Borrow {money(B.LOAN_STEP)}
            </button>
          </span>
        </div>
      </div>

      <div class="section-title">
        <span>Statement</span>
        <span class="muted">pick a line for its chart</span>
      </div>
      <table class="ledger">
        <thead>
          <tr>
            <th />
            <th>Today</th>
            <th>Yesterday</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.filter((r) => containers || r.key !== 'containers').map((r) => (
            <Fragment key={r.key}>
              <tr
                class={`fin-row ${opened.value === r.key ? 'on' : ''}`}
                tabIndex={0}
                aria-expanded={opened.value === r.key}
                onClick={() => (opened.value = opened.value === r.key ? null : r.key)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  opened.value = opened.value === r.key ? null : r.key;
                }}
              >
                <td>
                  <span class="fin-caret">{opened.value === r.key ? '▾' : '▸'}</span>
                  {r.label}
                </td>
                <td>
                  <Amount value={s.today[r.key]} />
                </td>
                <td>{y ? <Amount value={y[r.key]} /> : <span class="muted">—</span>}</td>
              </tr>
              {opened.value === r.key && (
                <tr class="fin-row-chart">
                  <td colSpan={3}>
                    {days.length < 2 ? (
                      <p class="muted">Its chart fills in as the days go by.</p>
                    ) : (
                      <LineChart days={days} row={r} />
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Net</td>
            <td>
              <Amount value={total(s.today)} />
            </td>
            <td>{y ? <Amount value={total(y)} /> : <span class="muted">—</span>}</td>
          </tr>
        </tfoot>
      </table>
    </aside>
  );
}
