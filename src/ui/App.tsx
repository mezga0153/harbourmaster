import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { BoatVisit, Command, Snapshot } from '../protocol';
import * as B from '../sim/balance';
import { BUILDABLES, ROTATABLE } from '../sim/rules';
import { Terrain, type BuildKind, type MachineKind } from '../sim/types';
import { dayProgress, duration, formatDate, money } from './format';
import { ContractsPanel } from './Contracts';
import { FinancePanel } from './Finance';
import { StatsPanel } from './Stats';
import { Advisor } from './Advisor';
import { FeedbackPanel } from './Feedback';
import { HandbookPanel } from './Handbook';
import { PortPanel } from './Port';
import { SettingsPanel } from './Settings';
import { SoundControl } from './Sound';
import { soundSettings } from '../audio/sound';
import { isMachineKind, MACHINES } from '../sim/machines';
import { MACHINE_TIER } from '../sim/tiers';
import { StaffPanel, StaffDetails } from './Staff';
import { RailwayPanel, TownPanel } from './Town';
import { TOWN_STAGES } from '../sim/town';
import { Icon, type IconName } from './icons';
import { thumbnail } from '../render/thumbs';
import {
  BULLDOZE_TOOL,
  CATEGORIES,
  SELECT_TOOL,
  UNMARK_TOOL,
  type Category,
  toolsAt,
  type ToolDef,
} from './tools';
import {
  menuOpen,
  narrow,
  openCategory,
  panel,
  type PanelName,
  togglePanel,
  hover,
  messages,
  newGameOpen,
  preview,
  seed,
  selection,
  snapshot,
  tool,
} from './store';
import { InfoHeader, Meter, More, Why } from './widgets';

export interface Actions {
  send(cmd: Command): void;
  setSpeed(speed: number): void;
  togglePause(): void;
  /** Point the camera at a tile. */
  focus(x: number, y: number): void;
  /** Turn the view a quarter round, as Q and E do. */
  rotateView(dir: 1 | -1): void;
  /** Zoom the view: below 1 in, above 1 out. */
  zoom(factor: number): void;
  /** Turn the building being placed, as a right-click does. */
  rotateBuilding(): void;
}

const SPEEDS = [
  { speed: 1, label: '1×' },
  { speed: 2, label: '2×' },
  { speed: 4, label: '4×' },
  { speed: 8, label: '8×' },
];

const TERRAIN_NAMES: Record<number, string> = {
  [Terrain.Water]: 'Water',
  [Terrain.Sand]: 'Sand',
  [Terrain.Grass]: 'Grass',
  [Terrain.Rock]: 'Rock',
};

export function App({ actions }: { actions: Actions }) {
  return (
    <>
      <TopBar actions={actions} />
      <BankBanner />
      <Messages />
      {panel.value === 'contracts' ? (
        <ContractsPanel actions={actions} />
      ) : panel.value === 'staff' ? (
        <StaffPanel actions={actions} />
      ) : panel.value === 'finance' ? (
        <FinancePanel actions={actions} />
      ) : panel.value === 'stats' ? (
        <StatsPanel />
      ) : panel.value === 'port' ? (
        <PortPanel actions={actions} />
      ) : panel.value === 'handbook' ? (
        <HandbookPanel />
      ) : panel.value === 'settings' ? (
        <SettingsPanel actions={actions} />
      ) : panel.value === 'feedback' ? (
        <FeedbackPanel />
      ) : (
        <InfoPanel actions={actions} />
      )}
      <PreviewTip />
      <HoverTip />
      {!(narrow.value && (panel.value || selection.value || menuOpen.value)) && <Advisor />}
      <MapControls actions={actions} />
      <BuildBar />
      <MobileMenu actions={actions} />
      {snapshot.value?.bankrupt && !newGameOpen.value && <BankruptDialog />}
      {newGameOpen.value && <NewGameDialog actions={actions} />}
    </>
  );
}

function Stat({
  icon,
  label,
  title,
  children,
  tone,
  priority = 1,
}: {
  icon?: IconName;
  label: string;
  title: string;
  children: ComponentChildren;
  tone?: string;
  /** Higher numbers hide first on narrow screens. */
  priority?: number;
}) {
  return (
    <div class={`stat ${tone ?? ''}`} title={title} data-priority={priority}>
      {icon && <Icon name={icon} />}
      <div>
        <div class="stat-label">{label}</div>
        <div class="stat-value">{children}</div>
      </div>
    </div>
  );
}

/** Panels the top bar opens from the cash rather than a button of their own. */
const MONEY: ReadonlySet<PanelName> = new Set(['finance', 'stats']);

/** The management panels, as the top bar and the phone menu list them. */
const MENU: {
  id: PanelName;
  icon: IconName;
  label: string;
  title: string;
  /** What wants looking at there, if anything: a count, or "!". */
  badge: (s: Snapshot) => string | number | null;
}[] = [
  {
    id: 'finance',
    icon: 'dollar',
    label: 'Finance',
    title: 'Finance: charts, loans and daily statement (M)',
    badge: (s) => (s.daysInRed > 0 ? '!' : null),
  },
  {
    id: 'stats',
    icon: 'box',
    label: 'Statistics',
    title: 'Statistics: where the crates and containers are',
    badge: () => null,
  },
  {
    id: 'port',
    icon: 'stairs',
    label: 'Port',
    title: 'Port development and upgrades (P)',
    badge: (s) => (s.progress.canUpgrade ? '!' : null),
  },
  {
    id: 'staff',
    icon: 'users',
    label: 'Staff',
    title: 'Staff and hiring (H)',
    badge: (s) => s.people.filter((p) => p.raiseAsk > 0).length || null,
  },
  {
    id: 'contracts',
    icon: 'contract',
    label: 'Contracts',
    title: 'Contracts (C)',
    badge: (s) => s.offers.length || null,
  },
];

function TopBar({ actions }: { actions: Actions }) {
  const s = snapshot.value;
  if (!s) return null;
  const costs = s.wages + s.contractFees + s.interest;
  const waiting = MENU.some((m) => m.badge(s) !== null);
  return (
    <header class="topbar panel">
      <div class="topbar-left">
        <button
          class={`btn icon menu-button ${menuOpen.value ? 'on' : ''}`}
          onClick={() => (menuOpen.value = !menuOpen.value)}
          aria-label="Menu"
          aria-expanded={menuOpen.value}
        >
          <Icon name="menu" />
          {waiting && <span class="dot-badge" />}
        </button>
        <button
          class={`brand ${panel.value === 'settings' ? 'on' : ''}`}
          onClick={() => togglePanel('settings')}
          title="Settings: graphics, sound, and saving the game to a file"
          aria-label="Settings"
        >
          <span class="brand-mark">
            <Icon name="anchor" />
          </span>
          <span class="brand-name">Harbourmaster</span>
        </button>
        <TimeControl actions={actions} />
        <span class="vr" />
        <button
          class={`stat-button cash ${panel.value === 'finance' || panel.value === 'stats' ? 'on' : ''}`}
          onClick={() =>
            (panel.value = panel.value === 'finance' || panel.value === 'stats' ? null : 'finance')
          }
          title="Finance and statistics: charts, loans, the daily statement, and where the cargo is (M)"
        >
          <Stat label="Cash" title="" tone={s.cash < 0 ? 'neg' : 'pos'}>
            {money(s.cash)}
            {s.loan > 0 && <span class="loan-tag">loan {money(s.loan)}</span>}
          </Stat>
          {s.daysInRed > 0 && <span class="count">!</span>}
        </button>
        <Stat
          icon="coins"
          label="Costs / day"
          title="Daily wages, haulier fees and loan interest"
          priority={2}
        >
          {money(-costs)}
        </Stat>
        <Stat icon="users" label="Staff" title="Dockhands employed" priority={3}>
          {s.staff}
        </Stat>
        <Stat icon="box" label="Crates" title="Crates handled so far" priority={3}>
          {s.stats.cratesHandled.toLocaleString('en-US')}
        </Stat>
        {s.town && (
          <button
            class={`stat-button town ${selection.value?.type === 'town' ? 'on' : ''}`}
            onClick={() => openTown()}
            title={`${s.town.name}, ${TOWN_STAGES[s.town.stage].name.toLowerCase()} up the coast: what the town wants, and how big it must grow for the port to grow`}
          >
            <Stat icon="town" label={s.town.name} title="">
              {s.town.population.toLocaleString('en-US')}
            </Stat>
          </button>
        )}
      </div>

      <div class="topbar-right">
        {MENU.filter((m) => !MONEY.has(m.id)).map((m) => {
          const badge = m.badge(s);
          return (
            <button
              key={m.id}
              class={`btn ${panel.value === m.id ? 'on' : ''} ${m.id === 'contracts' ? 'keep' : ''}`}
              onClick={() => togglePanel(m.id)}
              title={m.title}
            >
              <Icon name={m.icon} />
              <span>{m.label}</span>
              {badge !== null && <span class="count">{badge}</span>}
            </button>
          );
        })}
        <button
          class={`btn icon keep ${panel.value === 'handbook' ? 'on' : ''}`}
          onClick={() => togglePanel('handbook')}
          title="Handbook: how the port works (?)"
        >
          <Icon name="book" />
        </button>
        <SoundControl />
        <button class="btn icon" onClick={() => actions.send({ type: 'save' })} title="Save game">
          <Icon name="save" />
        </button>
      </div>
    </header>
  );
}

/** Show the town, or put it away again: the view flies over to it and back (see main.ts). */
function openTown(): void {
  if (!snapshot.value?.town) return;
  selection.value = selection.value?.type === 'town' ? null : { type: 'town' };
}

/**
 * On a phone, everything the top bar holds on a big screen, in a menu that
 * slides in from the left behind the hamburger: the port's figures, the
 * panels, the handbook and settings, sound, saving and a new port.
 */
function MobileMenu({ actions }: { actions: Actions }) {
  const s = snapshot.value;
  if (!s || !menuOpen.value) return null;
  const close = () => (menuOpen.value = false);
  const open = (id: PanelName) => {
    close();
    panel.value = id;
  };
  const costs = s.wages + s.contractFees + s.interest;
  const sound = soundSettings.value;
  const item = (id: PanelName, icon: IconName, label: string, badge: string | number | null) => (
    <button
      key={id}
      class={`drawer-item ${panel.value === id ? 'on' : ''}`}
      onClick={() => open(id)}
    >
      <Icon name={icon} />
      <span>{label}</span>
      {badge !== null && <span class="count">{badge}</span>}
      <Icon name="chevron" />
    </button>
  );
  return (
    <>
      <div class="drawer-backdrop" onClick={close} />
      <nav class="drawer panel" aria-label="Menu">
        <div class="drawer-head">
          <span class="brand-mark">
            <Icon name="anchor" />
          </span>
          <span class="brand-name">Harbourmaster</span>
          <button class="btn icon" onClick={close} aria-label="Close the menu">
            <Icon name="close" />
          </button>
        </div>
        <div class="drawer-stats">
          <button class="drawer-stat" onClick={() => open('finance')}>
            <span class="stat-label">Cash</span>
            <span class={`stat-value ${s.cash < 0 ? 'neg' : 'pos'}`}>{money(s.cash)}</span>
            {s.loan > 0 && <span class="loan-tag">loan {money(s.loan)}</span>}
          </button>
          <div class="drawer-stat">
            <span class="stat-label">Costs / day</span>
            <span class="stat-value">{money(-costs)}</span>
          </div>
          <div class="drawer-stat">
            <span class="stat-label">Staff</span>
            <span class="stat-value">{s.staff}</span>
          </div>
          <div class="drawer-stat">
            <span class="stat-label">Crates</span>
            <span class="stat-value">{s.stats.cratesHandled.toLocaleString('en-US')}</span>
          </div>
          {s.town && (
            <button
              class="drawer-stat wide"
              onClick={() => {
                close();
                openTown();
              }}
            >
              <span class="stat-label">{s.town.name}</span>
              <span class="stat-value">
                {s.town.population.toLocaleString('en-US')}{' '}
                <span class="muted">{TOWN_STAGES[s.town.stage].name.toLowerCase()}</span>
              </span>
            </button>
          )}
        </div>
        <div class="drawer-list">
          {s.town && (
            <button
              class={`drawer-item ${selection.value?.type === 'town' ? 'on' : ''}`}
              onClick={() => {
                close();
                openTown();
              }}
            >
              <Icon name="town" />
              <span>Town</span>
              <Icon name="chevron" />
            </button>
          )}
          {MENU.map((m) => item(m.id, m.icon, m.label, m.badge(s)))}
          {item('handbook', 'book', 'Handbook', null)}
          {item('settings', 'settings', 'Settings', null)}
        </div>
        <div class="drawer-actions">
          <button
            class={`btn ${sound.on ? '' : 'off'}`}
            onClick={() => (soundSettings.value = { ...sound, on: !sound.on })}
            aria-pressed={sound.on}
          >
            <Icon name={sound.on ? 'sound' : 'mute'} />
            <span>{sound.on ? 'Sound on' : 'Sound off'}</span>
          </button>
          <button
            class="btn"
            onClick={() => {
              actions.send({ type: 'save' });
              close();
            }}
          >
            <Icon name="save" />
            <span>Save</span>
          </button>
        </div>
      </nav>
    </>
  );
}

/**
 * On a touch screen, what the keys and the right mouse button do on a
 * computer: zoom, turn the view, and turn a building being placed. Two
 * fingers pinch to zoom and drag to pan.
 */
function MapControls({ actions }: { actions: Actions }) {
  // Out of the way of a panel, which rises from the bottom on a phone.
  if (!narrow.value || panel.value || selection.value) return null;
  const turnable = ROTATABLE.has(tool.value as BuildKind);
  return (
    <div class={`map-controls ${openCategory.value ? 'raised' : ''}`}>
      {turnable && (
        <button class="btn" onClick={() => actions.rotateBuilding()} aria-label="Turn the building">
          <Icon name="turn" />
          <span>Turn</span>
        </button>
      )}
      <div class="map-controls-group panel">
        <button class="btn icon" onClick={() => actions.zoom(1 / 1.25)} aria-label="Zoom in">
          <Icon name="plus" />
        </button>
        <button class="btn icon" onClick={() => actions.zoom(1.25)} aria-label="Zoom out">
          <Icon name="minus" />
        </button>
        <button
          class="btn icon"
          onClick={() => actions.rotateView(-1)}
          aria-label="Turn the view left"
        >
          <Icon name="rotateLeft" />
        </button>
        <button
          class="btn icon"
          onClick={() => actions.rotateView(1)}
          aria-label="Turn the view right"
        >
          <Icon name="rotateRight" />
        </button>
      </div>
    </div>
  );
}

function BankBanner() {
  const s = snapshot.value;
  if (!s || s.daysInRed === 0 || s.bankrupt) return null;
  const left = B.BANKRUPT_DAYS - s.daysInRed;
  return (
    <div class="banner" role="alert">
      <Icon name="alert" />
      <span>
        In the red. The bank closes the port in{' '}
        <strong>
          {left} day{left === 1 ? '' : 's'}
        </strong>{' '}
        unless cash is back above $0.
      </span>
    </div>
  );
}

function Messages() {
  const now = Date.now();
  // Re-rendered by snapshot updates, which keeps the fade timer moving.
  void snapshot.value;
  const live = messages.value.filter((m) => now - m.at < 9000);
  return (
    <div class="messages" aria-live="polite">
      {live.map((m) => (
        <div key={m.id} class={`message panel ${m.tone}`}>
          {m.text}
        </div>
      ))}
    </div>
  );
}

const KIND_LABEL = {
  dockhand: 'Dockhand',
  forklift: 'Machine',
  stacker: 'Machine',
  tractor: 'Machine',
  boat: 'Boat',
  truck: 'Truck',
} as const;

function InfoPanel({ actions }: { actions: Actions }) {
  const sel = selection.value;
  const s = snapshot.value;
  if (!sel || !s) return null;
  const close = () => (selection.value = null);

  if (sel.type === 'town') return <TownPanel actions={actions} />;
  if (sel.type === 'railway') return <RailwayPanel />;

  if (sel.type === 'depot') {
    const depot = s.depots.find((d) => d.idx === sel.idx);
    if (!depot) return null;
    const fleet = s.people.filter((p) => p.kind !== 'dockhand' && p.home === sel.idx);
    return (
      <aside class="side panel">
        <InfoHeader kicker="Building" title="Forklift depot" onClose={close} />
        <p class="muted">
          Forklifts refuel here, are repaired here and park here when there is nothing to do.{' '}
          <More topic="machines" />
        </p>
        <dl class="props">
          <dt>Forklifts</dt>
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
            .filter((k) => MACHINE_TIER[k] <= s.progress.tier)
            .map((k) => (
              <button
                key={k}
                class="btn primary"
                disabled={depot.forklifts >= B.DEPOT_SLOTS || s.cash < MACHINES[k].price}
                onClick={() => actions.send({ type: 'buyMachine', kind: k, tile: sel.idx })}
              >
                {MACHINES[k].label} · {money(MACHINES[k].price)}
              </button>
            ))}
        </div>
      </aside>
    );
  }

  if (sel.type === 'bay') {
    const bay = s.bays.find((b) => b.idx === sel.idx);
    if (!bay) return null;
    return (
      <aside class="side panel">
        <InfoHeader
          kicker={bay.tiles ? 'Storage' : 'Building'}
          title={
            bay.warehouse
              ? `Crate storage${bay.byCrane ? ', by a crane' : bay.outgoing ? ': out' : ': in'}`
              : bay.large
                ? 'Large truck bay'
                : 'Truck bay'
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
        {bay.noAccess && (
          <p class="note bad">
            {bay.noAccessWhy && !bay.tiles
              ? bay.noAccessWhy
              : bay.tiles
                ? 'Trucks cannot load here: forklifts take the crates on to storage or a truck bay they can reach. Trucks load storage from inside the port: a port road or quay beside it, through a port gate, and not beside the machines-only ground round a crane.'
                : 'Trucks cannot reach this bay. It needs a public road to the highway, or port roads from a port gate.'}
          </p>
        )}
      </aside>
    );
  }

  if (sel.type === 'yardGantry') {
    const trouble = s.problems.find((p) => p.type === 'yardGantry' && p.idx === sel.idx);
    return (
      <aside class="side panel">
        <InfoHeader kicker="Crane" title="Yard gantry" onClose={close} />
        <p class="muted">
          Spans the container yard beside it and lifts containers on and off the trucks and terminal
          tractors in the lane under it, running along its rails to each. Other traffic keeps out
          from under it where it can. <More topic="containers" />
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

  if (sel.type === 'parking') {
    const lot = s.parking.find((l) => l.tiles.includes(sel.idx));
    if (!lot) return null;
    return (
      <aside class="side panel">
        <InfoHeader
          kicker="Truck parking"
          title={lot.outside ? 'Parking outside the port' : 'Parking inside the port'}
          onClose={close}
        />
        <p class="muted">
          Trucks drive in off the road on one side, stand at an angle across the strip, and drive
          out onto the road on the other side: always forwards, never backing out.{' '}
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

  if (sel.type === 'office') {
    const d = s.docks;
    const idle = d.total - d.coordinated;
    const hut = !!sel.hut;
    return (
      <aside class="side panel">
        <InfoHeader
          kicker="Building"
          title={hut ? "Harbourmaster's hut" : 'Harbour office'}
          onClose={close}
        />
        <p class="muted">
          The harbour master coordinates the berths: boats only moor at docks someone looks after,
          the nearest the port first. A harbour office looks after {B.DOCKS_PER_OFFICE} docks,
          jetties or quays; a harbourmaster's hut {B.JETTIES_PER_HUT} more jetties, but no quays;
          and with no office, {B.FREE_DOCKS} jetties run on their own. A dock is a jetty or quay and
          everything joined to it. On the map: green, docks in use; red, docks boats do not use.{' '}
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
            {idle} dock{idle === 1 ? ' is' : 's are'} not in use: build a harbourmaster's hut for
            more jetties, or a harbour office, which quays need.
          </Why>
        ) : (
          <p class="note">Every dock is in use.</p>
        )}
      </aside>
    );
  }

  if (sel.type === 'crane') {
    const c = s.cranes.find((k) => k.idx === sel.idx);
    if (!c) return null;
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
            ? 'Red on the map: machines only. Blue: as far as it reaches into storage.'
            : 'Red on the map: machines only.'}{' '}
          <More topic="cranes" />
        </p>
        <dl class="props">
          <dt>{c.kind === 'gantry' ? 'Along the quay' : 'Landing stack'}</dt>
          <dd>
            {c.stack} / {c.max} {c.kind === 'jib' ? 'crates' : 'containers'}
          </dd>
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
              <dt>Crate storage in reach</dt>
              <dd>{c.stores > 0 ? `${c.stores} area${c.stores === 1 ? '' : 's'}` : 'None'}</dd>
            </>
          )}
        </dl>
        <Meter value={c.stack / c.max} />
      </aside>
    );
  }

  if (sel.type === 'yard') {
    const yard = s.yards.find((y) => y.idx === sel.idx);
    if (!yard) return null;
    return (
      <aside class="side panel">
        <InfoHeader
          kicker="Storage"
          title={`Container yard${yard.outgoing ? ': out' : ': in'}${yard.byCrane ? ', by a crane' : ''}`}
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
      </aside>
    );
  }

  const e = s.entities.find((x) => x.id === sel.id);
  if (!e) return null;
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
  jib: `Lifts crates off a boat lying under it: straight into crate storage up to ${B.JIB_REACH} tiles away, or else onto its landing stack for the forklifts. The ground round it is for port machines only, so dockhands keep off.`,
  harbour:
    'Lifts containers off a feeder ship alongside onto a stack beside it, for the reach stackers. Slow, but several can work one ship. The ground round it is for port machines only.',
  gantry:
    'Ship-to-shore crane: runs along the ship lifting containers off quickly, and sets them down at the shipside along its rails, with exports brought for it to put on board. Reach stackers collect from there, from the quay behind, and it lifts them onto terminal tractors waiting under it; never the hauliers’ trucks. The ground round it is for port machines only.',
};

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

function PreviewTip() {
  const p = preview.value;
  if (!p) return null;
  if (p.error) {
    return (
      <div class={`tip preview bad ${openCategory.value ? 'raised' : ''}`}>
        <Icon name="alert" />
        {p.error}
        {p.rotatable && <span class="muted">Right-click to rotate</span>}
      </div>
    );
  }
  if (p.count === 0) return null;
  return (
    <div class={`tip preview ${openCategory.value ? 'raised' : ''}`}>
      {!p.rotatable && <span class="muted">{p.count === 1 ? '1 tile' : `${p.count} tiles`}</span>}
      <strong class={p.value < 0 ? 'neg' : 'pos'}>{money(p.value)}</strong>
      {p.rotatable && <span class="muted">Right-click to rotate</span>}
      {p.note && <span class="muted">{p.note}</span>}
    </div>
  );
}

function HoverTip() {
  const h = hover.value;
  if (!h) return null;
  return (
    <div class="tip hovertip">
      <span class="muted">
        {h.x}, {h.y}
      </span>
      <span>{TERRAIN_NAMES[h.terrain]}</span>
      {h.terrain === Terrain.Water && <span class="muted">{h.depth.toFixed(1)} m deep</span>}
    </div>
  );
}

/** What the build menu says about a tool: what it does and costs. */
function toolInfo(t: ToolDef) {
  const def = t.tool in BUILDABLES ? BUILDABLES[t.tool as BuildKind] : null;
  const machine = isMachineKind(t.tool) ? MACHINES[t.tool] : null;
  const hint = def
    ? def.hint
    : machine
      ? `${machine.hint}. Click a depot to buy one there`
      : (t.hint ?? '');
  const price = def ? money(def.cost) : machine ? money(machine.price) : t.note;
  const upkeep = machine
    ? `Operator ${money(machine.wage)}/day`
    : t.upkeep
      ? `${money(t.upkeep)}/day to run`
      : null;
  return { hint, price, upkeep };
}

function ToolButton({ t, active }: { t: ToolDef; active: boolean }) {
  const { hint, price } = toolInfo(t);
  const title = [hint ? `${t.label}: ${hint}` : t.label, t.key && `(${t.key})`]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      class={`tool ${active ? 'on' : ''}`}
      onClick={() => (tool.value = active ? 'select' : t.tool)}
      title={title}
      aria-pressed={active}
    >
      {t.key && <kbd>{t.key}</kbd>}
      <Icon name={t.icon} />
      <span class="tool-label">{t.label}</span>
      <span class="tool-cost">{price}</span>
    </button>
  );
}

/** The tab last open in each category of the build menu. */
const trayTabs = new Map<string, string>();

/** One thing on offer in the build menu: its picture, name and price. */
function ToolCard({
  t,
  active,
  onHover,
}: {
  t: ToolDef;
  active: boolean;
  onHover(t: ToolDef | null): void;
}) {
  const { price } = toolInfo(t);
  const picture = thumbnail(t.tool);
  return (
    <button
      class={`build-card ${active ? 'on' : ''}`}
      onClick={() => (tool.value = active ? 'select' : t.tool)}
      onMouseEnter={() => onHover(t)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(t)}
      onBlur={() => onHover(null)}
      aria-pressed={active}
      aria-label={t.label}
    >
      <span class="build-picture">
        {picture ? <img src={picture} alt="" draggable={false} /> : <Icon name={t.icon} />}
        {t.key && <kbd>{t.key}</kbd>}
      </span>
      <span class="build-label">{t.label}</span>
      <span class="build-cost">{price}</span>
    </button>
  );
}

/**
 * The build menu above the bar, Cities: Skylines style: the open category's
 * tabs, a card with a picture for each thing in the tab, and what the one
 * under the pointer (or in hand) does and costs.
 */
function CategoryTray({ cat }: { cat: Category }) {
  const current = tool.value;
  const [hovered, setHovered] = useState<ToolDef | null>(null);
  const [, redraw] = useState(0);
  // Only what the port has come to: the rest are not shown at all.
  const tools = toolsAt(cat, snapshot.value?.progress.tier ?? 0);
  const tabs = [...new Set(tools.map((t) => t.group ?? cat.label))];
  const inHand = tools.find((t) => t.tool === current);
  const kept = trayTabs.get(cat.id);
  const tab =
    (kept && tabs.includes(kept) ? kept : undefined) ??
    (inHand ? (inHand.group ?? cat.label) : undefined) ??
    tabs[0];
  const shown = tools.filter((t) => (t.group ?? cat.label) === tab);
  const about = hovered ?? inHand ?? null;
  const info = about && toolInfo(about);
  const pick = (g: string) => {
    trayTabs.set(cat.id, g);
    setHovered(null);
    redraw((n) => n + 1);
  };
  return (
    <div class="tray panel" role="toolbar" aria-label={cat.label}>
      <div class="tray-head">
        <span class="tray-title">
          <Icon name={cat.icon} />
          {cat.label}
        </span>
        {tabs.length > 1 && (
          <div class="tray-tabs" role="tablist">
            {tabs.map((g) => (
              <button
                key={g}
                role="tab"
                class={`tray-tab ${g === tab ? 'on' : ''}`}
                aria-selected={g === tab}
                onClick={() => pick(g)}
              >
                {g}
              </button>
            ))}
          </div>
        )}
      </div>
      <div class="tray-cards">
        {shown.map((t) => (
          <ToolCard key={t.tool} t={t} active={current === t.tool} onHover={setHovered} />
        ))}
      </div>
      <div class="tray-about">
        {about && info ? (
          <>
            <div class="tray-about-head">
              <strong>{about.label}</strong>
              <span class="tray-about-costs">
                <span>{info.price}</span>
                {info.upkeep && <span class="muted">{info.upkeep}</span>}
                {about.key && <kbd>{about.key}</kbd>}
              </span>
            </div>
            <p class="muted">{info.hint}</p>
          </>
        ) : (
          <p class="muted">
            {narrow.value
              ? 'Tap something to pick it up and see what it does and what it costs.'
              : 'Point at something to see what it does and what it costs.'}
          </p>
        )}
      </div>
    </div>
  );
}

/** The date and the game's speed, at the top left. */
function TimeControl({ actions }: { actions: Actions }) {
  const s = snapshot.value;
  if (!s) return null;
  return (
    <div class="time">
      <div class="clock" title="Date">
        <span class="clock-date">{formatDate(s.tick)}</span>
        <span class="daybar">
          <span style={{ width: `${dayProgress(s.tick) * 100}%` }} />
        </span>
      </div>
      <div class="segmented" role="group" aria-label="Game speed">
        <button
          class={s.speed === 0 ? 'on' : ''}
          onClick={() => actions.togglePause()}
          title="Pause (Space)"
          aria-label="Pause"
        >
          <Icon name="pause" />
        </button>
        {SPEEDS.map((o, k) => (
          <button
            key={o.speed}
            class={s.speed === o.speed ? 'on' : ''}
            onClick={() => actions.setSpeed(o.speed)}
            title={`Speed ${o.label} (${k + 1})`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function BuildBar() {
  const current = tool.value;
  const tier = snapshot.value?.progress.tier ?? 0;
  // Menus with nothing in them yet are not shown at all.
  const categories = CATEGORIES.filter((c) => toolsAt(c, tier).length > 0);
  const open = categories.find((c) => c.id === openCategory.value);
  return (
    <>
      {open && <CategoryTray key={open.id} cat={open} />}
      <footer class="dock panel">
        <div class="dock-group">
          <ToolButton t={SELECT_TOOL} active={current === 'select'} />
        </div>
        <div class="dock-group">
          {categories.map((c) => {
            const tools = toolsAt(c, tier);
            const using = tools.find((t) => t.tool === current);
            const isOpen = openCategory.value === c.id;
            return (
              <button
                key={c.id}
                class={`tool category ${isOpen ? 'open' : ''} ${using ? 'on' : ''}`}
                onClick={() => (openCategory.value = isOpen ? null : c.id)}
                aria-expanded={isOpen}
                title={tools.map((t) => t.label).join(', ')}
              >
                <Icon name={using?.icon ?? c.icon} />
                <span class="tool-label">{c.label}</span>
                <span class="tool-cost">
                  {using ? using.label : `${tools.length} item${tools.length === 1 ? '' : 's'}`}
                </span>
              </button>
            );
          })}
        </div>
        <div class="dock-group">
          <ToolButton t={BULLDOZE_TOOL} active={current === 'bulldoze'} />
          <ToolButton t={UNMARK_TOOL} active={current === 'unmark'} />
          <button
            class={`tool ${panel.value === 'staff' ? 'on' : ''}`}
            onClick={() => togglePanel('staff')}
            title="Hire and manage dockhands (H)"
          >
            <kbd>H</kbd>
            <Icon name="hire" />
            <span class="tool-label">Staff</span>
            <span class="tool-cost">Hire</span>
          </button>
        </div>
      </footer>
    </>
  );
}

function NewGameDialog({ actions }: { actions: Actions }) {
  const [value, setValue] = useState(String(Math.floor(Math.random() * 1_000_000)));
  const close = () => (newGameOpen.value = false);
  const start = () => {
    const n = Number.parseInt(value, 10);
    actions.send({ type: 'newGame', seed: Number.isFinite(n) ? Math.abs(n) : undefined });
    close();
  };
  return (
    <div class="backdrop" onClick={close}>
      <div
        class="dialog panel"
        role="dialog"
        aria-labelledby="newgame-title"
        onClick={(e) => e.stopPropagation()}
      >
        <InfoHeader kicker="Sandbox" title="New port" onClose={close} />
        <p class="muted" id="newgame-title">
          Every seed makes a different coastline. Your current port is replaced. Current seed:{' '}
          <strong>{seed.value}</strong>
        </p>
        <label class="field">
          <span class="field-label">Seed</span>
          <div class="row">
            <input
              value={value}
              inputMode="numeric"
              onInput={(e) => setValue(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && start()}
            />
            <button
              class="btn"
              onClick={() => setValue(String(Math.floor(Math.random() * 1_000_000)))}
            >
              Random
            </button>
          </div>
        </label>
        <button class="btn primary block" onClick={start}>
          Build a new port
        </button>
      </div>
    </div>
  );
}

function BankruptDialog() {
  const s = snapshot.value!;
  return (
    <div class="backdrop">
      <div class="dialog panel" role="alertdialog" aria-labelledby="bankrupt-title">
        <div class="kicker bad">Game over</div>
        <h2 id="bankrupt-title">Bankrupt</h2>
        <p class="muted">
          The port spent {B.BANKRUPT_DAYS} days in the red and the bank has closed it on{' '}
          {formatDate(s.tick)}.
        </p>
        <dl class="props">
          <dt>Crates handled</dt>
          <dd>{s.stats.cratesHandled}</dd>
          <dt>Boats served</dt>
          <dd>{s.stats.boats}</dd>
          <dt>Total earned</dt>
          <dd>{money(s.stats.earned)}</dd>
        </dl>
        <button class="btn primary block" onClick={() => (newGameOpen.value = true)}>
          Start a new port
        </button>
      </div>
    </div>
  );
}
