import type { PlaceView } from '../protocol';
import { TIERS } from '../sim/tiers';
import { panel, selection, snapshot } from './store';
import { InfoHeader, Meter, PortTownTabs } from './widgets';

// The region along the main line, from the Container Port on: the places
// past the map's north and south ends, laid out as the line runs, with the
// port and the town between, each with how big it is and the next thing the
// port can do for it; and how big the region must grow for the next step up.

const count = (n: number) => Math.round(n).toLocaleString('en-US');

function Place({ p }: { p: PlaceView }) {
  const n = p.next;
  return (
    <div class={`card place ${p.city ? 'city' : 'waiting'}`}>
      <div class="card-head">
        <strong>{p.name}</strong>
        <span class={`badge ${p.city && p.size >= p.cap ? 'bad' : ''}`}>
          {count(p.size)}
          {p.city ? ` / ${count(p.cap)}` : ''} people
        </span>
      </div>
      <p class="muted place-where">
        {p.label}, {p.far} km {p.side < 0 ? 'north, up' : 'south, down'} the line
      </p>
      {p.waits && <p class="muted">{p.waits}: it waits for the Bulk Terminal.</p>}
      {p.city && (
        <p class="status">
          <span class={`dot ${p.line && p.lately > 0 ? 'live' : ''}`} />
          {p.line
            ? `${p.line} runs its trains${p.lately > 0 ? `, ${count(p.lately)} containers a day lately` : ''}`
            : p.open
              ? 'Offers its container trains: sign them on the contracts board (C)'
              : 'Its trains are not offered yet'}
        </p>
      )}
      {n && (
        <>
          <p>
            Next: {n.name.toLowerCase()}. {n.aim}.
          </p>
          <div class="req">
            <span>So far</span>
            <Meter value={n.need > 0 ? n.have / n.need : 1} tone="ok" />
            <span class="req-value">
              {count(Math.min(n.have, n.need))} / {count(n.need)}
            </span>
          </div>
          <p class="muted">
            {n.opens}. Once it opens, it may grow to {count(n.cap)} people.
          </p>
        </>
      )}
      {p.taken.length > 0 && <p class="muted">Open already: {p.taken.join(', ')}.</p>}
    </div>
  );
}

export function RegionPanel() {
  const s = snapshot.value;
  if (!s) return null;
  const close = () => (selection.value = null);
  const t = s.town;
  const north = s.region.filter((p) => p.side < 0).sort((a, b) => b.far - a.far);
  const south = s.region.filter((p) => p.side > 0).sort((a, b) => a.far - b.far);
  const gate = TIERS.find((x, k) => k > s.progress.tier && x.region !== undefined);
  return (
    <aside class="side panel wide" aria-label="Region">
      <InfoHeader kicker="Region" title="Along the line" onClose={close} />
      <PortTownTabs on="region" />
      <p class="muted">
        The main line runs on past both ends of the map to towns, cities and works inland. The port
        serves them by rail: each city grows as its trains carry containers to and from the feeders,
        and the works wait for a bulk terminal.
      </p>
      <div class="card">
        <div class="card-head">
          <strong>{count(s.progress.region)} people in the region</strong>
          {gate?.region !== undefined && (
            <span class={`badge ${s.progress.region >= gate.region ? 'good' : ''}`}>
              {gate.name}: {count(gate.region)}
            </span>
          )}
        </div>
        {gate?.region !== undefined && (
          <div class="req">
            <span>{gate.name}</span>
            <Meter value={Math.min(1, s.progress.region / gate.region)} tone="ok" />
            <span class="req-value">
              {count(s.progress.region)} / {count(gate.region)}
            </span>
          </div>
        )}
      </div>
      <h3 class="place-end">North, up the line</h3>
      {north.map((p) => (
        <Place key={p.id} p={p} />
      ))}
      <div class="card place here">
        <div class="card-head">
          <strong>The port{t ? ` and ${t.name}` : ''}</strong>
          {t && <span class="badge">{count(t.population)} people</span>}
        </div>
        <p class="muted">
          {s.sidings.length > 0
            ? `${s.sidings.length} siding${s.sidings.length === 1 ? '' : 's'} off the main line.`
            : 'No sidings yet: the port lays them once the town has its railway station.'}{' '}
          <button
            class="link"
            onClick={() => {
              selection.value = null;
              panel.value = 'contracts';
            }}
          >
            Contracts ›
          </button>
        </p>
      </div>
      <h3 class="place-end">South, down the line</h3>
      {south.map((p) => (
        <Place key={p.id} p={p} />
      ))}
    </aside>
  );
}
