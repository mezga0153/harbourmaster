import type { BoatVisit, Snapshot } from '../protocol';
import * as B from '../sim/balance';
import { isMachineKind, MACHINES } from '../sim/machines';
import { MACHINE_TIER } from '../sim/tiers';
import { needsCustomsOffice } from '../sim/contracts';
import { TICKS_PER_DAY, type MachineKind } from '../sim/types';
import type { Actions } from './actions';
import { duration, money } from './format';
import { Icon } from './icons';
import { StaffDetails } from './Staff';
import { cash, selected, selection, snapshot, tier } from './store';
import { RailwayPanel, TownPanel } from './Town';
import { InfoHeader, Meter, More, Why } from './widgets';

// What the player has clicked on the map, in the panel down the side: a
// building, a storage area, a crane, or a boat, truck, machine or dockhand.

const KIND_LABEL = {
  dockhand: 'Dockhand',
  forklift: 'Machine',
  stacker: 'Machine',
  tractor: 'Machine',
  boat: 'Boat',
  truck: 'Truck',
} as const;

/** The handbook page that explains why each kind of thing gets held up. */
const WHY_TOPIC: Record<string, string> = {
  boat: 'boats',
  truck: 'trucks',
  dockhand: 'machinesOnly',
  forklift: 'machines',
  stacker: 'machines',
  tractor: 'machines',
};

const CRANE_NAME = { jib: 'Jib crane', harbour: 'Harbour crane', gantry: 'Gantry crane' };

const CRANE_NOTE = {
  jib: `Lifts crates off a boat lying under it straight into crate storage for cargo coming in right next to it, in the machines-only ground round it, and never sets them down at its feet: with no such storage there, or all of it full, it unloads nothing. The ground round it is for port machines only, so dockhands keep off.`,
  harbour:
    'Lifts containers off a feeder ship alongside onto a stack beside it, for the reach stackers. Slow, but several can work one ship. The ground round it is for port machines only.',
  gantry:
    'Ship-to-shore crane: runs along the ship lifting containers off quickly, and sets them down at the shipside along its rails, with exports brought for it to put on board. Reach stackers collect from there, from the quay behind, and it lifts them onto terminal tractors waiting under it; never the hauliers’ trucks. The ground round it is for port machines only.',
};

type Depot = Snapshot['depots'][number];
type Bay = Snapshot['bays'][number];
type Yard = Snapshot['yards'][number];
type Crane = Snapshot['cranes'][number];
type Lot = Snapshot['parking'][number];
type Entity = Snapshot['entities'][number];

/** Closing the panel, and the game, for what is selected to act on. */
interface InfoProps {
  actions: Actions;
  onClose: () => void;
}

export function InfoPanel({ actions }: { actions: Actions }) {
  const sel = selection.value;
  if (!sel) return null;
  const close = () => (selection.value = null);

  if (sel.type === 'town') return <TownPanel actions={actions} />;
  if (sel.type === 'railway') return <RailwayPanel />;
  if (sel.type === 'yardGantry') return <YardGantryInfo idx={sel.idx} onClose={close} />;
  if (sel.type === 'office') return <OfficeInfo hut={!!sel.hut} onClose={close} />;
  if (sel.type === 'customs') return <CustomsInfo onClose={close} />;
  // The rest are things in the snapshot, found there; gone, nothing shows.
  const found = selected.value;
  if (!found) return null;
  switch (found.type) {
    case 'depot':
      return found.item && <DepotInfo depot={found.item} actions={actions} onClose={close} />;
    case 'bay':
      return found.item && <BayInfo bay={found.item} actions={actions} onClose={close} />;
    case 'parking':
      return found.item && <ParkingInfo lot={found.item} onClose={close} />;
    case 'crane':
      return found.item && <CraneInfo crane={found.item} onClose={close} />;
    case 'yard':
      return found.item && <YardInfo yard={found.item} actions={actions} onClose={close} />;
    case 'entity':
      return found.item && <EntityInfo entity={found.item} actions={actions} onClose={close} />;
  }
}

function DepotInfo({ depot, actions, onClose: close }: InfoProps & { depot: Depot }) {
  const idx = depot.idx;
  const fleet = (snapshot.value?.people ?? []).filter(
    (p) => p.kind !== 'dockhand' && p.home === idx,
  );
  const trouble = snapshot.value?.problems.find((p) => p.type === 'depot' && p.idx === idx);
  return (
    <aside class="side panel">
      <InfoHeader kicker="Building" title="Forklift depot" onClose={close} />
      <p class="muted">
        Forklifts refuel here, are repaired here and park here when there is nothing to do.{' '}
        <More topic="machines" />
      </p>
      {trouble && <Why topic="machines">Not working: {trouble.text}</Why>}
      <dl class="props">
        <dt>Places taken</dt>
        <dd>
          {depot.forklifts} / {B.DEPOT_SLOTS}
        </dd>
        <dt>Fuel</dt>
        <dd>{money(B.FUEL_COST)} a full tank</dd>
        <dt>Repairs</dt>
        <dd>{money(B.REPAIR_COST)} here, double if stranded</dd>
      </dl>
      {fleet.map((f) => (
        <div class="needs fuel" key={f.id} title={`${f.name}: ${f.activity}`}>
          <Icon name="fuel" />
          <Meter value={f.fuel / 100} tone={f.fuel < B.LOW_FUEL ? 'bad' : 'good'} />
        </div>
      ))}
      <div class="actions">
        {(Object.keys(MACHINES) as MachineKind[])
          .filter((k) => MACHINE_TIER[k] <= tier.value)
          .map((k) => (
            <button
              key={k}
              class="btn primary"
              disabled={
                depot.forklifts + MACHINES[k].room > B.DEPOT_SLOTS || cash.value < MACHINES[k].price
              }
              onClick={() => actions.send({ type: 'buyMachine', kind: k, tile: idx })}
            >
              {MACHINES[k].label} · {money(MACHINES[k].price)}
            </button>
          ))}
      </div>
    </aside>
  );
}

/** A place's kind and its designation, as on its sign: "Truck bay B3". */
function named(what: string, name: string | undefined): string {
  return name ? `${what} ${name}` : what;
}

function BayInfo({ bay, actions, onClose: close }: InfoProps & { bay: Bay }) {
  return (
    <aside class="side panel">
      <InfoHeader
        kicker={bay.tiles ? 'Storage' : 'Building'}
        title={
          bay.warehouse
            ? `${named('Crate storage', bay.name)}${bay.byCrane ? ', by a crane' : bay.outgoing ? ': out' : ': in'}`
            : named(bay.large ? 'Large truck bay' : 'Truck bay', bay.name)
        }
        onClose={close}
      />
      {bay.tiles && (
        <p class="muted">
          {bay.outgoing
            ? 'For crates going out: shippers’ trucks unload here, from inside the port, and the crates go on to the coasters.'
            : 'For crates coming in: dockhands and forklifts bring them, jib cranes close by swing them straight in, and trucks load from inside the port, on the yellow tiles.'}{' '}
          <More topic="storage" />
        </p>
      )}
      <dl class="props">
        <dt>{bay.outgoing && !bay.byCrane ? 'Crates in' : 'Crates waiting'}</dt>
        <dd>
          {bay.stock + bay.exports} / {bay.capacity}
        </dd>
        {bay.exports > 0 && (
          <>
            <dt>To ship out</dt>
            <dd>{bay.exports}</dd>
          </>
        )}
        {bay.customs && (
          <>
            <dt>In customs</dt>
            <dd>
              {bay.customs.n}
              <span class="muted"> · next clears in {duration(bay.customs.next)}</span>
            </dd>
          </>
        )}
        {bay.papers && (
          <>
            <dt>Export papers</dt>
            <dd>
              {bay.papers.n} waiting
              <span class="muted"> · next ready in {duration(bay.papers.next)}</span>
            </dd>
          </>
        )}
        {bay.tiles && (
          <>
            <dt>Area</dt>
            <dd>
              {bay.tiles.length} tile{bay.tiles.length === 1 ? '' : 's'}
            </dd>
          </>
        )}
      </dl>
      <Meter value={bay.stock / bay.capacity} />
      {bay.tiles && (
        <ShutToggle
          shut={bay.shut}
          what="crates"
          empty={bay.stock + bay.exports === 0}
          outgoing={bay.outgoing}
          onToggle={(shut) => actions.send({ type: 'shutStore', idx: bay.idx, shut })}
        />
      )}
      {(bay.customs || bay.papers) && bay.stock + bay.exports >= bay.capacity && (
        <p class="note bad">
          {bay.customs
            ? 'Full, with crates still in customs: no more can come in off the coasters until they clear. Mark out more crate storage for cargo coming in.'
            : 'Full, with canned fish still waiting on its export papers: the cannery’s trucks wait outside until there is room. Mark out more crate storage for cargo going out.'}
        </p>
      )}
      {bay.noAccess && (
        <p class="note bad">
          {bay.noAccessWhy && !bay.tiles
            ? bay.noAccessWhy
            : bay.tiles
              ? 'Trucks cannot load here: forklifts take the crates on to storage or a truck bay they can reach. Trucks load storage from inside the port: a port road or quay beside it, through a port gate, and not beside the machines-only ground round a crane.'
              : 'Trucks cannot reach this bay. It needs a public road to the highway, or port roads from a port gate.'}
        </p>
      )}
      {!bay.noAccess && <ShippersCut type="bay" idx={bay.idx} />}
    </aside>
  );
}

/** Outgoing storage shippers' trucks cannot get to: their red mark's words. */
function ShippersCut({ type, idx }: { type: 'bay' | 'yard'; idx: number }) {
  const mark = snapshot.value?.problems.find((p) => p.type === type && p.idx === idx);
  return mark ? <p class="note bad">{mark.text}</p> : null;
}

function YardGantryInfo({ idx, onClose: close }: { idx: number; onClose: () => void }) {
  const trouble = snapshot.value?.problems.find((p) => p.type === 'yardGantry' && p.idx === idx);
  return (
    <aside class="side panel">
      <InfoHeader kicker="Crane" title="Yard gantry" onClose={close} />
      <p class="muted">
        Spans the container yard beside it and lifts containers on and off the trucks and terminal
        tractors in the lane under it, running along its rails to each. Other traffic keeps out from
        under it where it can. <More topic="containers" />
      </p>
      {trouble ? (
        <Why topic="containers">Not working: {trouble.text}.</Why>
      ) : (
        <p class="status">
          <span class="dot live" />
          Working the yard beside it
        </p>
      )}
    </aside>
  );
}

function ParkingInfo({ lot, onClose: close }: { lot: Lot; onClose: () => void }) {
  return (
    <aside class="side panel">
      <InfoHeader
        kicker="Truck parking"
        title={`${named('Parking', lot.name)} ${lot.outside ? 'outside the port' : 'inside the port'}`}
        onClose={close}
      />
      <p class="muted">
        Trucks drive in off the road on one side, stand at an angle across the strip, and drive out
        onto the road on the other side: always forwards, never backing out.{' '}
        {lot.outside
          ? 'Outside the port, shippers’ trucks wait here for their paperwork.'
          : 'Inside the port, trucks queue here for a free loading spot.'}{' '}
        <More topic="trucks" />
      </p>
      <dl class="props">
        <dt>Spaces</dt>
        <dd>
          {lot.used} / {lot.spaces}
        </dd>
        <dt>Takes</dt>
        <dd>{lot.wide ? 'Any truck' : 'Small trucks only: big trucks need two tiles'}</dd>
      </dl>
      {lot.why ? <Why topic="trucks">Not in use: {lot.why}.</Why> : null}
    </aside>
  );
}

function OfficeInfo({ hut, onClose: close }: { hut: boolean; onClose: () => void }) {
  const d = snapshot.value?.docks;
  if (!d) return null;
  const idle = d.total - d.coordinated;
  return (
    <aside class="side panel">
      <InfoHeader
        kicker="Building"
        title={hut ? "Harbourmaster's hut" : 'Harbour office'}
        onClose={close}
      />
      <p class="muted">
        The harbour master coordinates the berths: boats only moor at docks someone looks after, the
        nearest the port first. A harbour office looks after {B.DOCKS_PER_OFFICE} docks, jetties or
        quays; a harbourmaster's hut {B.JETTIES_PER_HUT} more jetties, but no quays; and with no
        office, {B.FREE_DOCKS} jetties run on their own. A dock is a jetty or quay and everything
        joined to it. On the map: green, docks in use; red, docks boats do not use.{' '}
        <More topic="boats" />
      </p>
      <dl class="props">
        <dt>Harbour offices</dt>
        <dd>{d.offices}</dd>
        <dt>Harbourmaster's huts</dt>
        <dd>{d.huts}</dd>
        <dt>Docks in use</dt>
        <dd>
          {d.coordinated} / {d.total}
        </dd>
      </dl>
      <Meter value={d.total > 0 ? d.coordinated / d.total : 1} tone={idle > 0 ? 'bad' : 'good'} />
      {idle > 0 ? (
        <Why topic="boats">
          {idle} dock{idle === 1 ? ' is' : 's are'} not in use: build a harbourmaster's hut for more
          jetties, or a harbour office, which quays need.
        </Why>
      ) : (
        <p class="note">Every dock is in use.</p>
      )}
    </aside>
  );
}

function CustomsInfo({ onClose: close }: { onClose: () => void }) {
  const s = snapshot.value;
  if (!s) return null;
  const lines = s.contracts.filter((c) => needsCustomsOffice(c.terms)).map((c) => c.terms.name);
  return (
    <aside class="side panel">
      <InfoHeader kicker="Building" title="Customs office" onClose={close} />
      <p class="muted">
        Customs officers clear timber and goods off the coasters, about{' '}
        {Math.round((B.CRATE_CUSTOMS_TICKS / TICKS_PER_DAY) * 24)} h in crate storage, containers
        off the feeders in the yard, and the cannery's export papers. Lines with cargo like that
        cannot be signed without a customs office; one does for the whole port.{' '}
        <More topic="storage" />
      </p>
      <dl class="props">
        <dt>Crates in customs</dt>
        <dd>{s.cargo.crates.customs}</dd>
        <dt>Containers in customs</dt>
        <dd>{s.cargo.containers.customs}</dd>
        <dt>Lines it clears</dt>
        <dd>{lines.length > 0 ? lines.join(', ') : <span class="muted">None yet</span>}</dd>
      </dl>
    </aside>
  );
}

function CraneInfo({ crane: c, onClose: close }: { crane: Crane; onClose: () => void }) {
  return (
    <aside class="side panel">
      <InfoHeader kicker="Crane" title={CRANE_NAME[c.kind]} onClose={close} />
      <p class="status">
        <span class={`dot ${c.busy ? 'live' : ''}`} />
        {c.why}
      </p>
      {c.trouble && <p class="note bad">{c.trouble}</p>}
      <p class="muted">
        {CRANE_NOTE[c.kind]}{' '}
        {c.kind === 'jib'
          ? 'Red on the map: machines only, and as far as it reaches into storage.'
          : 'Red on the map: machines only.'}{' '}
        <More topic="cranes" />
      </p>
      <dl class="props">
        {c.kind !== 'jib' && (
          <>
            <dt>{c.kind === 'gantry' ? 'Along the quay' : 'Landing stack'}</dt>
            <dd>
              {c.stack} / {c.max} containers
            </dd>
          </>
        )}
        {c.kind === 'jib' && c.stack > 0 && (
          <>
            <dt>Left at its feet</dt>
            <dd>{c.stack} crates, for the forklifts</dd>
          </>
        )}
        {c.out > 0 && (
          <>
            <dt>Exports set down for it</dt>
            <dd>
              {c.out} {c.out === 1 ? 'container' : 'containers'}, for the next ship it works
            </dd>
          </>
        )}
        {c.kind === 'jib' && (
          <>
            <dt>Crate storage in reach, for cargo coming in</dt>
            <dd>
              {c.stores > 0
                ? `${c.stores} tile${c.stores === 1 ? '' : 's'} beside it, ${c.storeRoom ? `room for ${c.storeRoom} more crate${c.storeRoom === 1 ? '' : 's'}` : 'full'}`
                : 'None'}
            </dd>
          </>
        )}
      </dl>
      {c.kind !== 'jib' && <Meter value={c.stack / c.max} />}
    </aside>
  );
}

function YardInfo({ yard, actions, onClose: close }: InfoProps & { yard: Yard }) {
  return (
    <aside class="side panel">
      <InfoHeader
        kicker="Storage"
        title={`${named('Container yard', yard.name)}${yard.outgoing ? ': out' : ': in'}${yard.byCrane ? ', by a crane' : ''}`}
        onClose={close}
      />
      {yard.outgoing && (
        <p class="muted">
          For containers going out: shippers’ trucks unload here, and reach stackers take them to
          the crane over the feeder.
        </p>
      )}
      <p class="muted">
        Reach stackers stack containers here from the cranes. Customs clear them a day after their
        ship has been unloaded, and then container trucks load them from inside the port, on the
        yellow tiles. <More topic="containers" />
      </p>
      <dl class="props">
        <dt>Containers</dt>
        <dd>
          {yard.boxes + yard.exports} / {yard.capacity}
        </dd>
        {yard.exports > 0 && (
          <>
            <dt>To ship out</dt>
            <dd>{yard.exports}</dd>
          </>
        )}
        <dt>Cleared by customs</dt>
        <dd>
          {yard.cleared}
          {yard.buried > 0 && (
            <span class="muted">
              {' '}
              · {yard.buried} under others still in customs: a free reach stacker restacks them
            </span>
          )}
        </dd>
        {yard.pending > 0 && (
          <>
            <dt>Ship still unloading</dt>
            <dd>{yard.pending}</dd>
          </>
        )}
        <dt>In customs</dt>
        <dd>
          {yard.boxes - yard.cleared - yard.pending}
          {yard.nextClear >= 0 && (
            <span class="muted"> · next clears in {duration(yard.nextClear)}</span>
          )}
        </dd>
        <dt>Area</dt>
        <dd>
          {yard.tiles.length} tile{yard.tiles.length === 1 ? '' : 's'}
        </dd>
      </dl>
      <Meter value={yard.boxes / yard.capacity} />
      <ShutToggle
        shut={yard.shut}
        what="containers"
        empty={yard.boxes + yard.exports === 0}
        outgoing={yard.outgoing}
        onToggle={(shut) => actions.send({ type: 'shutStore', idx: yard.idx, shut })}
      />
      {yard.noAccess && (
        <p class="note bad">
          {yard.noAccessWhy ??
            'Container trucks cannot reach this yard. They load from inside the port: a port road or quay beside it, through a port gate, and not beside machines-only ground.'}
        </p>
      )}
      {!yard.noAccess && <ShippersCut type="yard" idx={yard.idx} />}
    </aside>
  );
}

/** A boat, truck, dockhand or machine: what it is doing, and why it is held up if it is. */
function EntityInfo({ entity: e, actions, onClose: close }: InfoProps & { entity: Entity }) {
  return (
    <aside class="side panel">
      <InfoHeader kicker={KIND_LABEL[e.kind]} title={e.name} onClose={close} />
      <p class="status">
        <span class={`dot ${e.moving ? 'live' : ''}`} />
        {e.activity}
      </p>
      {e.why && <Why topic={WHY_TOPIC[e.kind]}>{e.why}</Why>}
      {(e.kind === 'dockhand' || isMachineKind(e.kind)) && (
        <StaffDetails id={e.id} actions={actions} onDismiss={close} />
      )}
      {e.kind === 'boat' && e.vessel !== 'tug' && (
        <dl class="props">
          <dt>Cargo</dt>
          <dd>
            {e.load}{' '}
            {e.boxes ? 'containers' : e.vessel === 'coaster' ? 'crates on pallets' : 'crates'}
          </dd>
        </dl>
      )}
      {e.visit && (
        <VisitDetails visit={e.visit} onSail={() => actions.send({ type: 'sailNow', id: e.id })} />
      )}
      {e.kind === 'truck' && (
        <>
          <dl class="props">
            <dt>Load</dt>
            <dd>
              {e.load} / {e.capacity} {e.boxes ? 'containers' : 'crates'}
            </dd>
          </dl>
          <Meter value={e.load / e.capacity} />
        </>
      )}
    </aside>
  );
}

/**
 * How a ship's visit is going: how long it has been in, waited, unloaded
 * and loaded, against the time its line allows alongside, and how its line
 * stands to take it; with the order to sail now while it is loading.
 */
function VisitDetails({ visit: v, onSail }: { visit: BoatVisit; onSail: () => void }) {
  const over = v.worked - v.allowed;
  const took = (ticks: number, done: boolean) =>
    ticks < 0 ? 'not yet' : done ? duration(ticks) : `${duration(ticks)} so far`;
  const sign = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');
  return (
    <>
      <dl class="props">
        {v.inPort >= 0 && (
          <>
            <dt>In port</dt>
            <dd>{duration(v.inPort)}</dd>
          </>
        )}
        {v.anchored > 0 && (
          <>
            <dt>At anchor</dt>
            <dd>{duration(v.anchored)}</dd>
          </>
        )}
        {v.heldBy && v.heldFor !== undefined && (
          <>
            <dt>Held up</dt>
            <dd class="neg">
              {duration(v.heldFor)} so far, behind {v.heldBy} moored in its way
            </dd>
          </>
        )}
        <dt>Unloading</dt>
        <dd>{took(v.unloading, v.unloaded)}</dd>
        {v.loads && (
          <>
            <dt>Loading</dt>
            <dd>
              {took(v.loading, v.loaded)}
              {v.unloaded && (
                <span class="muted">
                  {' '}
                  · {v.out}
                  {v.quota !== undefined && v.quota > v.out ? ` of ${v.quota}` : ''} exports on
                  board
                </span>
              )}
            </dd>
          </>
        )}
        <dt>Time alongside</dt>
        <dd>
          {duration(v.worked)} of {duration(v.allowed)} allowed
          {over > 0 && <span class="neg"> · over by {duration(over)}</span>}
        </dd>
        {v.mood !== undefined && (
          <>
            <dt>Owner’s goodwill</dt>
            <dd>{v.mood} / 100</dd>
            <dt>This visit</dt>
            <dd class={v.moodChange < 0 ? 'neg' : undefined}>
              {sign(Math.round(v.moodChange))} goodwill, if it sailed now
            </dd>
          </>
        )}
      </dl>
      {v.mood !== undefined && (
        <Meter value={Math.min(1, v.mood / 100)} tone={v.mood < 25 ? 'bad' : undefined} />
      )}
      {v.canSail && (
        <>
          <p class="muted">
            Waiting on exports to fill up? Send it off with the {v.out} it has on board: the cranes
            finish the lifts they are in, and the rest wait in the port for the next ship.
          </p>
          <div class="actions">
            <button class="btn" onClick={onSail}>
              Sail now
            </button>
          </div>
        </>
      )}
    </>
  );
}

/**
 * Stop a storage area taking any more cargo, so it empties out, or open it
 * again; with what it is doing meanwhile.
 */
function ShutToggle({
  shut,
  what,
  empty,
  outgoing,
  onToggle,
}: {
  shut: boolean;
  what: 'crates' | 'containers';
  empty: boolean;
  outgoing: boolean;
  onToggle: (shut: boolean) => void;
}) {
  return (
    <>
      {shut && (
        <p class="note">
          {empty
            ? `Empty, and taking no more ${what}. Open it again to use it.`
            : `Taking no more ${what}, emptying out: ${outgoing ? 'those in it still go on to the ships' : 'the trucks still take those in it'}.`}
        </p>
      )}
      <div class="actions">
        <button class={shut ? 'btn primary' : 'btn'} onClick={() => onToggle(!shut)}>
          {shut ? `Take ${what} again` : `Stop taking ${what}`}
        </button>
      </div>
    </>
  );
}
