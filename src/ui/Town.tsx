import { Fragment } from 'preact';
import * as B from '../sim/balance';
import { TOWN_STAGES } from '../sim/town';
import type { Actions } from './App';
import { money } from './format';
import { selection, snapshot } from './store';
import { InfoHeader, Meter } from './widgets';

const BLURBS = [
  'A handful of fishers’ cottages round a chapel, and boats drawn up on the beach.',
  'Families are moving in for work at the port. Two-storey houses line the streets.',
  'Shops have opened along the streets round the square, with flats above them.',
  'Blocks of flats rise round the centre.',
  'Towers stand over the old chapel square. The fishing village is a city now.',
];

const count = (n: number) => Math.round(n).toLocaleString('en-US');

export function TownPanel({ actions }: { actions: Actions }) {
  const s = snapshot.value;
  const t = s?.town;
  if (!s || !t) return null;
  const close = () => (selection.value = null);
  const next = TOWN_STAGES[t.stage + 1];
  const from = TOWN_STAGES[t.stage].from;
  return (
    <aside class="side panel" aria-label="Town">
      <InfoHeader kicker={TOWN_STAGES[t.stage].name} title={t.name} onClose={close} />
      <p class="muted">{BLURBS[t.stage]}</p>
      <dl class="props">
        <dt>Population</dt>
        <dd>{count(t.population)}</dd>
        <dt>Homes</dt>
        <dd>{count(t.homes)}</dd>
        <dt>Port jobs</dt>
        <dd title="Your staff, and the drivers of the hauliers you have signed">{t.jobs}</dd>
        <dt>Goods out by road</dt>
        <dd title={`Crates a day trucked out lately; a container counts as ${B.CONTAINER_GOODS}`}>
          {count(t.goods)} a day
        </dd>
        <dt>Delivered in town</dt>
        <dd title="Crates a day the hauliers dropped at the town's businesses lately">
          {count(t.supplied)} a day
        </dd>
        <dt>The port supports</dt>
        <dd>{count(t.target)} people</dd>
      </dl>
      {t.businesses.length > 0 && (
        <>
          <div class="section-title">
            <span>Businesses</span>
          </div>
          <dl class="props">
            {t.businesses.map((b) => (
              <Fragment key={b.label}>
                <dt>
                  {b.count > 1 ? `${b.count} ` : ''}
                  {b.label[0].toUpperCase() + b.label.slice(1)}
                  {b.count > 1 ? 's' : ''}
                </dt>
                <dd>
                  {b.perDay} {b.boxes ? 'containers' : 'crates'} a day
                </dd>
              </Fragment>
            ))}
            <dt>Still wanted today</dt>
            <dd>
              {count(t.wants.crates)} crates
              {t.businesses.some((b) => b.boxes) ? `, ${count(t.wants.boxes)} containers` : ''}
            </dd>
          </dl>
          <p class="muted">
            Hauliers drop goods at the town’s businesses on their way out, for{' '}
            {Math.round(B.TOWN_DELIVERY_BONUS * 100)}% more than the usual fee. Goods delivered in
            town count double towards its growth. The trucks need a public road from the port to the
            town.
          </p>
        </>
      )}
      {next && (
        <>
          <p class="muted">
            {next.name} at {count(next.from)} people
          </p>
          <Meter value={(t.population - from) / (next.from - from)} tone="good" />
        </>
      )}
      <p class="muted">
        The town grows by itself as the port brings work and trade: every hire, every haulier and
        every crate sent out by road keeps more people in town. As it grows it opens a cannery, a
        department store and factories, and gets more trains.
      </p>
      <div class="actions">
        <button class="btn" onClick={() => actions.focus(t.x + 0.5, t.y + 0.5)}>
          Show on map
        </button>
      </div>
    </aside>
  );
}

export function RailwayPanel() {
  const s = snapshot.value;
  if (!s) return null;
  const train = s.train;
  const wagons = train ? train.cars.length - 1 : 0;
  const passenger = train?.cars.includes('coach');
  return (
    <aside class="side panel" aria-label="Railway">
      <InfoHeader kicker="Railway" title="Main line" onClose={() => (selection.value = null)} />
      <p class="muted">
        The main line runs past inland. Freight and passenger trains pass now and then, more as the
        town grows. A siding into the port will come later.
      </p>
      <p class="status">
        <span class={`dot ${train ? 'live' : ''}`} />
        {train
          ? `A ${passenger ? 'passenger' : 'freight'} train is passing, ${wagons} ${passenger ? 'coaches' : 'wagons'}`
          : 'The line is quiet'}
      </p>
      <p class="muted">
        Trucks wait at level crossings while the barriers are down. A public road built across the
        line makes a new crossing for {money(B.CROSSING_COST)}.
      </p>
    </aside>
  );
}
