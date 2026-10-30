import { signal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { FinanceDay, Ledger, LedgerCategory } from '../protocol';
import * as B from '../sim/balance';
import type { Actions } from './App';
import { formatDate, money } from './format';
import { panel, snapshot } from './store';
import { InfoHeader, Meter } from './widgets';

const ROWS: { key: LedgerCategory; label: string }[] = [
  { key: 'cargo', label: 'Cargo handled' },
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

/** A date without the year, for an axis. */
function shortDate(tick: number): string {
  return formatDate(tick - 1).replace(/ \d+$/, '');
}

/** Clean axis ticks taking in a to b, about `n` steps of them. */
function ticks(a: number, b: number, n: number): number[] {
  const span = Math.max(1, b - a);
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(a / step) * step; v < b + step - 1e-9; v += step) out.push(v);
  return out;
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

// The charts: drawn to a fixed width and scaled to the panel.
const W = 392;
const PAD = { left: 44, right: 10, top: 10, bottom: 20 };

/** Where the pointer is over a chart, as a day's index, and the tip to show. */
function useHover() {
  const [at, setAt] = useState<number | null>(null);
  return { at, setAt };
}

/** Which day a pointer over the plot is nearest. */
function dayAt(e: MouseEvent, n: number): number {
  const svg = e.currentTarget as SVGSVGElement;
  const box = svg.getBoundingClientRect();
  const x = ((e.clientX - box.left) / box.width) * W;
  const plot = W - PAD.left - PAD.right;
  return Math.max(0, Math.min(n - 1, Math.round(((x - PAD.left) / plot) * (n - 1))));
}

function Tip({ x, children }: { x: number; children: ComponentChildren }) {
  // Kept inside the chart: on the left of the pointer past the middle.
  const left = x / W > 0.55;
  return (
    <div
      class="viz-tip"
      style={left ? { right: `${(1 - x / W) * 100 + 2}%` } : { left: `${(x / W) * 100 + 2}%` }}
    >
      {children}
    </div>
  );
}

/** Cash at the end of each day: a line over a light wash, the latest marked. */
function CashChart({ days }: { days: FinanceDay[] }) {
  const { at, setAt } = useHover();
  const H = 132;
  const cash = days.map((d) => d.cash);
  // Scaled to how far it moved, not from nothing: $0 shows only if it went near it.
  const lo = Math.min(...cash);
  const hi = Math.max(...cash, lo + 1);
  const axis = ticks(lo, hi, 3);
  const y0 = Math.min(lo, axis[0] ?? lo);
  const y1 = Math.max(hi, axis[axis.length - 1] ?? hi);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (k: number) => PAD.left + (days.length === 1 ? plotW : (k / (days.length - 1)) * plotW);
  const y = (v: number) => PAD.top + (1 - (v - y0) / (y1 - y0)) * plotH;
  const line = cash.map((v, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line}L${x(days.length - 1)},${y(y0)}L${x(0)},${y(y0)}Z`;
  const last = days.length - 1;
  const hover = at === null ? null : days[at];
  return (
    <div class="viz">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Cash at the end of each day, latest ${money(cash[last])}`}
        onMouseMove={(e) => setAt(dayAt(e, days.length))}
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
        <path class="viz-area" d={area} />
        <path class="viz-line" d={line} />
        <text class="viz-axis" x={PAD.left} y={H - 4}>
          {shortDate(days[0].tick)}
        </text>
        <text class="viz-axis" x={W - PAD.right} y={H - 4} text-anchor="end">
          {shortDate(days[last].tick)}
        </text>
        {hover && at !== null && (
          <line class="viz-cross" x1={x(at)} x2={x(at)} y1={PAD.top} y2={H - PAD.bottom} />
        )}
        <circle class="viz-dot" cx={x(at ?? last)} cy={y(cash[at ?? last])} r={4} />
      </svg>
      {hover && at !== null && (
        <Tip x={x(at)}>
          <div class="viz-tip-head">{formatDate(hover.tick - 1)}</div>
          <div>{money(hover.cash)}</div>
        </Tip>
      )}
    </div>
  );
}

/** Each day's profit or loss: columns up from the line or down below it. */
function ProfitChart({ days }: { days: FinanceDay[] }) {
  const { at, setAt } = useHover();
  const H = 120;
  const net = days.map((d) => total(d.ledger));
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
        aria-label="Profit or loss each day"
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
          {shortDate(days[0].tick)}
        </text>
        <text class="viz-axis" x={W - PAD.right} y={H - 4} text-anchor="end">
          {shortDate(days[days.length - 1].tick)}
        </text>
      </svg>
      {hover && at !== null && (
        <Tip x={cx(at)}>
          <div class="viz-tip-head">{formatDate(hover.tick - 1)}</div>
          <div class="viz-tip-row">
            <span>In</span>
            <span>{money(income(hover.ledger))}</span>
          </div>
          <div class="viz-tip-row">
            <span>Out</span>
            <span>{money(costs(hover.ledger))}</span>
          </div>
          <div class="viz-tip-row strong">
            <span>{total(hover.ledger) >= 0 ? 'Profit' : 'Loss'}</span>
            <span>{money(total(hover.ledger))}</span>
          </div>
        </Tip>
      )}
    </div>
  );
}

/** What the money went on over the days shown, biggest first. */
function Spending({ days }: { days: FinanceDay[] }) {
  const sums = ROWS.filter((r) => r.key !== 'cargo')
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
  return (
    <aside class="side panel xwide finance" aria-label="Finance">
      <InfoHeader kicker="Money" title="Finance" onClose={() => (panel.value = null)} />

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
        <span class="muted">wages and fees are paid at midnight</span>
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
          {ROWS.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td>
                <Amount value={s.today[r.key]} />
              </td>
              <td>{y ? <Amount value={y[r.key]} /> : <span class="muted">—</span>}</td>
            </tr>
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
