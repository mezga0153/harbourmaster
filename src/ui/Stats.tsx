import { signal } from '@preact/signals';
import type { CargoIn, CargoOut } from '../protocol';
import { panel, snapshot } from './store';
import { InfoHeader } from './widgets';

/** Containers or crates: which the panel shows; kept while it is closed. */
const kind = signal<'containers' | 'crates'>('containers');

/** Where cargo coming in goes, in order. */
const IN: { key: keyof CargoIn; label: string; boxes?: boolean }[] = [
  { key: 'atSea', label: 'At sea, on ships coming in' },
  { key: 'onShips', label: 'On ships alongside, to unload' },
  { key: 'landed', label: 'Landed at the quay' },
  { key: 'carried', label: 'Being carried to storage' },
  { key: 'customs', label: 'Waiting for customs', boxes: true },
  { key: 'ready', label: 'Waiting for a truck' },
  { key: 'onTrucks', label: 'On trucks, going out' },
];

/** Where cargo going out goes, in order. */
const OUT: { key: keyof CargoOut; label: string }[] = [
  { key: 'waiting', label: 'On trucks waiting outside' },
  { key: 'comingIn', label: 'On trucks driving in' },
  { key: 'stored', label: 'In outgoing storage' },
  { key: 'carried', label: 'Being carried to the ships' },
  { key: 'atCrane', label: 'Set down at the cranes' },
  { key: 'aboard', label: 'On board, ship still alongside' },
];

/** Counted as in the port: alongside or ashore, not at sea nor outside the gate. */
function inPort(c: CargoIn, o: CargoOut): number {
  return (
    c.onShips +
    c.landed +
    c.carried +
    c.customs +
    c.ready +
    c.onTrucks +
    o.comingIn +
    o.stored +
    o.carried +
    o.atCrane +
    o.aboard
  );
}

function Stages<T extends string>({
  rows,
  counts,
}: {
  rows: { key: T; label: string }[];
  counts: Record<T, number>;
}) {
  const most = Math.max(1, ...rows.map((r) => counts[r.key]));
  return (
    <div class="fin-bars">
      {rows.map((r) => (
        <div class={`fin-bar stat-bar ${counts[r.key] ? '' : 'none'}`} key={r.key}>
          <span class="fin-bar-label" title={r.label}>
            {r.label}
          </span>
          <span class="fin-bar-track">
            {counts[r.key] > 0 && (
              <span
                class="fin-bar-fill"
                style={{ width: `${Math.max(1, (counts[r.key] / most) * 100)}%` }}
              />
            )}
          </span>
          <span class="fin-bar-value">{counts[r.key].toLocaleString('en-US')}</span>
        </div>
      ))}
    </div>
  );
}

function Figure({ label, value, note }: { label: string; value: number; note: string }) {
  return (
    <div class="fin-tile">
      <div class="fin-tile-label">{label}</div>
      <div class="fin-tile-value">{value.toLocaleString('en-US')}</div>
      <div class="fin-tile-delta">{note}</div>
    </div>
  );
}

export function StatsPanel() {
  const s = snapshot.value;
  if (!s) return null;
  const c = s.cargo;
  const boxes = kind.value === 'containers';
  const into = boxes ? c.containers : c.crates;
  const out = boxes ? c.containerExports : c.crateExports;
  const word = boxes ? 'containers' : 'crates';
  const rowsIn = IN.filter((r) => boxes || !r.boxes);
  const comingIn = rowsIn.reduce((n, r) => n + into[r.key], 0);
  const goingOut = OUT.reduce((n, r) => n + out[r.key], 0);
  return (
    <aside class="side panel xwide stats" aria-label="Statistics">
      <InfoHeader kicker="Port" title="Statistics" onClose={() => (panel.value = null)} />

      <div class="fin-tiles">
        <Figure
          label="Containers"
          value={inPort(c.containers, c.containerExports)}
          note="in the port now"
        />
        <Figure label="Crates" value={inPort(c.crates, c.crateExports)} note="in the port now" />
        <Figure label="Shipped out" value={s.stats.exported ?? 0} note="exports so far" />
      </div>

      <div class="fin-range">
        <span class="muted">Where they are now</span>
        <div class="segmented" role="group" aria-label="Cargo shown">
          <button class={boxes ? 'on' : ''} onClick={() => (kind.value = 'containers')}>
            Containers
          </button>
          <button class={boxes ? '' : 'on'} onClick={() => (kind.value = 'crates')}>
            Crates
          </button>
        </div>
      </div>

      <div class="section-title">
        <span>Coming in</span>
        <span class="muted">
          {comingIn.toLocaleString('en-US')} {word}
        </span>
      </div>
      <Stages rows={rowsIn} counts={into} />

      <div class="section-title">
        <span>Going out</span>
        <span class="muted">
          {goingOut.toLocaleString('en-US')} {word}
        </span>
      </div>
      <Stages rows={OUT} counts={out} />

      <div class="section-title">
        <span>So far</span>
      </div>
      <dl class="terms stat-totals">
        <div>
          <dt>Crates handled</dt>
          <dd>{s.stats.cratesHandled.toLocaleString('en-US')}</dd>
        </div>
        <div>
          <dt>Containers handled</dt>
          <dd>{s.stats.containers.toLocaleString('en-US')}</dd>
        </div>
        <div>
          <dt>Ships</dt>
          <dd>{s.stats.boats.toLocaleString('en-US')}</dd>
        </div>
        <div>
          <dt>Trucks</dt>
          <dd>{s.stats.trucks.toLocaleString('en-US')}</dd>
        </div>
      </dl>
    </aside>
  );
}
