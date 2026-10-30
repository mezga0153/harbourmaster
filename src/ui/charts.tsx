import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { TICKS_PER_DAY } from '../sim/types';
import { formatDate } from './format';

// The panels' charts: drawn to a fixed width and scaled to the panel. Their
// colours are set on the panel (see style.css) and were checked there for
// colour blindness and contrast.
export const W = 392;
export const PAD = { left: 44, right: 10, top: 10, bottom: 20 };

/** A date without the year, for an axis. */
export function shortDate(tick: number): string {
  return formatDate(tick).replace(/ \d+$/, '');
}

/** The date and the time of day, for a chart's tip. */
export function dateAndTime(tick: number): string {
  const minutes = Math.floor(((tick % TICKS_PER_DAY) / TICKS_PER_DAY) * 24 * 60);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${formatDate(tick)}, ${hh}:${mm}`;
}

/** A count short enough for an axis: 840, 12.9K, 4.2M. */
export function compactCount(n: number): string {
  const a = Math.abs(n);
  const short =
    a >= 1e6
      ? `${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`
      : a >= 1e3
        ? `${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`
        : `${Math.round(a)}`;
  return `${n < 0 ? '−' : ''}${short.replace(/\.0(?=[KM])/, '')}`;
}

/** Clean axis ticks taking in a to b, about `n` steps of them. */
export function ticks(a: number, b: number, n: number): number[] {
  const span = Math.max(1, b - a);
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(a / step) * step; v < b + step - 1e-9; v += step) out.push(v);
  return out;
}

/** Which point the pointer is over on a chart, if any. */
export function useHover() {
  const [at, setAt] = useState<number | null>(null);
  return { at, setAt };
}

/** A chart's tip, kept inside it: on the left of the pointer past the middle. */
export function Tip({ x, children }: { x: number; children: ComponentChildren }) {
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

/**
 * One measure over time: a line over a light wash, the latest marked, and
 * on hover a crosshair and a tip. Scaled from nothing with `fromZero`, as
 * for a count; else to how far it moved.
 */
export function LineSeries({
  points,
  format,
  label,
  tip,
  height = 132,
  fromZero = false,
}: {
  points: { tick: number; value: number }[];
  format: (n: number) => string;
  label: string;
  tip: (p: { tick: number; value: number }) => ComponentChildren;
  height?: number;
  fromZero?: boolean;
}) {
  const { at, setAt } = useHover();
  const H = height;
  const values = points.map((p) => p.value);
  const lo = fromZero ? Math.min(0, ...values) : Math.min(...values);
  const hi = Math.max(...values, lo + 1);
  const axis = ticks(lo, hi, 3);
  const y0 = Math.min(lo, axis[0] ?? lo);
  const y1 = Math.max(hi, axis[axis.length - 1] ?? hi);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const n = points.length;
  const x = (k: number) => PAD.left + (n === 1 ? plotW : (k / (n - 1)) * plotW);
  const y = (v: number) => PAD.top + (1 - (v - y0) / (y1 - y0)) * plotH;
  const line = values
    .map((v, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)},${y(v).toFixed(1)}`)
    .join('');
  const area = `${line}L${x(n - 1)},${y(y0)}L${x(0)},${y(y0)}Z`;
  const last = n - 1;
  const hover = at === null ? null : points[at];
  return (
    <div class="viz">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${label}, latest ${format(values[last])}`}
        onMouseMove={(e) => {
          const svg = e.currentTarget as SVGSVGElement;
          const box = svg.getBoundingClientRect();
          const px = ((e.clientX - box.left) / box.width) * W;
          setAt(Math.max(0, Math.min(last, Math.round(((px - PAD.left) / plotW) * last))));
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
              {format(v)}
            </text>
          </g>
        ))}
        <path class="viz-area" d={area} />
        <path class="viz-line" d={line} />
        <text class="viz-axis" x={PAD.left} y={H - 4}>
          {shortDate(points[0].tick)}
        </text>
        <text class="viz-axis" x={W - PAD.right} y={H - 4} text-anchor="end">
          {shortDate(points[last].tick)}
        </text>
        {hover && at !== null && (
          <line class="viz-cross" x1={x(at)} x2={x(at)} y1={PAD.top} y2={H - PAD.bottom} />
        )}
        <circle class="viz-dot" cx={x(at ?? last)} cy={y(values[at ?? last])} r={4} />
      </svg>
      {hover && at !== null && <Tip x={x(at)}>{tip(hover)}</Tip>}
    </div>
  );
}
