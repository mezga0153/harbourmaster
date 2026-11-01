import type { ComponentChildren } from 'preact';
import type { Snapshot } from '../protocol';
import { keyHint, PAUSE_KEY, SPEEDS } from '../input/keys';
import { TOWN_STAGES } from '../sim/town';
import type { Actions } from './actions';
import { dayProgress, formatDate, money } from './format';
import { Icon, type IconName } from './icons';
import { SoundControl } from './Sound';
import { soundSettings } from './prefs';
import {
  cash,
  costsPerDay,
  menuOpen,
  panel,
  type PanelName,
  selection,
  snapshot,
  togglePanel,
  town,
} from './store';

function Stat({
  icon,
  label,
  title,
  children,
  tone,
  priority = 1,
  bar,
}: {
  icon?: IconName;
  label: string;
  title: string;
  children: ComponentChildren;
  tone?: string;
  /** Higher numbers hide first on narrow screens. */
  priority?: number;
  /** A bar under the value, as the date has: how far along, 0 to 1. */
  bar?: number;
}) {
  return (
    <div class={`stat ${tone ?? ''}`} title={title} data-priority={priority}>
      {icon && <Icon name={icon} />}
      <div>
        <div class="stat-label">{label}</div>
        <div class="stat-value">{children}</div>
        {bar !== undefined && (
          <span class="daybar stat-bar">
            <span style={{ width: `${Math.round(bar * 100)}%` }} />
          </span>
        )}
      </div>
    </div>
  );
}

/** Contracts held up: a shipper's trucks with nowhere to wait or unload, or no way in. */
function troubled(s: Snapshot): number {
  return s.contracts.filter((c) => c.trouble?.bad).length;
}

/** Panels the top bar opens from the cash rather than a button of their own. */
const MONEY: ReadonlySet<PanelName> = new Set(['finance', 'stats']);

/** The management panels, as the top bar and the phone menu list them. */
const MENU: {
  id: PanelName;
  icon: IconName;
  label: string;
  /** What the panel is for; its key (input/keys.ts) is added when shown. */
  title: string;
  /** What wants looking at there, if anything: a count, or "!". */
  badge: (s: Snapshot) => string | number | null;
  /** The badge counts something wrong, in red, rather than something new. */
  bad?: (s: Snapshot) => boolean;
}[] = [
  {
    id: 'finance',
    icon: 'dollar',
    label: 'Finance',
    title: 'Finance: charts, loans and daily statement',
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
    title: 'Port development and upgrades',
    badge: (s) => (s.progress.canUpgrade ? '!' : null),
  },
  {
    id: 'staff',
    icon: 'users',
    label: 'Staff',
    title: 'Staff and hiring',
    badge: (s) => s.people.filter((p) => p.raiseAsk > 0).length || null,
  },
  {
    id: 'contracts',
    icon: 'contract',
    label: 'Contracts',
    title: 'Contracts',
    // Contracts held up first (a shipper's trucks with nowhere to wait or
    // unload), then the offers.
    badge: (s) => troubled(s) || s.offers.length || null,
    bad: (s) => troubled(s) > 0,
  },
];

export function TopBar({ actions }: { actions: Actions }) {
  const s = snapshot.value;
  if (!s) return null;
  const t = town.value;
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
          title={`Finance and statistics: charts, loans, the daily statement, and where the cargo is${keyHint('finance')}`}
        >
          <Stat label="Cash" title="" tone={cash.value < 0 ? 'neg' : 'pos'}>
            {money(cash.value)}
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
          {money(-costsPerDay.value)}
        </Stat>
        <Stat icon="users" label="Staff" title="Dockhands employed" priority={3}>
          {s.staff}
        </Stat>
        <Stat icon="box" label="Crates" title="Crates handled so far" priority={3}>
          {s.stats.cratesHandled.toLocaleString('en-US')}
        </Stat>
        {t && (
          <button
            class={`stat-button town ${selection.value?.type === 'town' ? 'on' : ''}`}
            onClick={() => openTown()}
            title={`${t.name}, ${TOWN_STAGES[t.stage].name.toLowerCase()} up the coast: what the town wants, and how big it must grow for the port to grow${t.next?.waiting ? `. Next: upgrade the port to a ${t.next.waiting}` : t.next ? `. Next: ${t.next.name.toLowerCase()}, ${Math.round(landmarkProgress(t.next) * 100)}% of the way` : ''}`}
          >
            <Stat
              icon="town"
              label={t.name}
              title=""
              bar={t.next && !t.next.waiting ? landmarkProgress(t.next) : undefined}
            >
              {t.population.toLocaleString('en-US')}
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
              title={m.title + keyHint(m.id)}
            >
              <Icon name={m.icon} />
              <span>{m.label}</span>
              {badge !== null && <span class={`count ${m.bad?.(s) ? 'bad' : ''}`}>{badge}</span>}
            </button>
          );
        })}
        <button
          class={`btn icon keep ${panel.value === 'handbook' ? 'on' : ''}`}
          onClick={() => togglePanel('handbook')}
          title={`Handbook: how the port works${keyHint('handbook')}`}
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

/** How far the port is towards the town's next landmark, 0 to 1. */
function landmarkProgress(n: NonNullable<NonNullable<Snapshot['town']>['next']>): number {
  const part = n.need > 0 ? Math.min(1, n.have / n.need) : 1;
  return n.days ? Math.min(1, (n.days.done + part) / n.days.need) : part;
}

/** Show the town, or put it away again: the view flies over to it and back (see main.ts). */
function openTown(): void {
  if (!town.value) return;
  selection.value = selection.value?.type === 'town' ? null : { type: 'town' };
}

/**
 * On a phone, everything the top bar holds on a big screen, in a menu that
 * slides in from the left behind the hamburger: the port's figures, the
 * panels, the handbook and settings, sound, saving and a new port.
 */
export function MobileMenu({ actions }: { actions: Actions }) {
  const s = snapshot.value;
  if (!s || !menuOpen.value) return null;
  const close = () => (menuOpen.value = false);
  const open = (id: PanelName) => {
    close();
    panel.value = id;
  };
  const t = town.value;
  const sound = soundSettings.value;
  const item = (
    id: PanelName,
    icon: IconName,
    label: string,
    badge: string | number | null,
    bad = false,
  ) => (
    <button
      key={id}
      class={`drawer-item ${panel.value === id ? 'on' : ''}`}
      onClick={() => open(id)}
    >
      <Icon name={icon} />
      <span>{label}</span>
      {badge !== null && <span class={`count ${bad ? 'bad' : ''}`}>{badge}</span>}
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
            <span class={`stat-value ${cash.value < 0 ? 'neg' : 'pos'}`}>{money(cash.value)}</span>
            {s.loan > 0 && <span class="loan-tag">loan {money(s.loan)}</span>}
          </button>
          <div class="drawer-stat">
            <span class="stat-label">Costs / day</span>
            <span class="stat-value">{money(-costsPerDay.value)}</span>
          </div>
          <div class="drawer-stat">
            <span class="stat-label">Staff</span>
            <span class="stat-value">{s.staff}</span>
          </div>
          <div class="drawer-stat">
            <span class="stat-label">Crates</span>
            <span class="stat-value">{s.stats.cratesHandled.toLocaleString('en-US')}</span>
          </div>
          {t && (
            <button
              class="drawer-stat wide"
              onClick={() => {
                close();
                openTown();
              }}
            >
              <span class="stat-label">{t.name}</span>
              <span class="stat-value">
                {t.population.toLocaleString('en-US')}{' '}
                <span class="muted">{TOWN_STAGES[t.stage].name.toLowerCase()}</span>
              </span>
            </button>
          )}
        </div>
        <div class="drawer-list">
          {t && (
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
          {MENU.map((m) => item(m.id, m.icon, m.label, m.badge(s), m.bad?.(s)))}
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
          title={`Pause (${PAUSE_KEY})`}
          aria-label="Pause"
        >
          <Icon name="pause" />
        </button>
        {SPEEDS.map((o) => (
          <button
            key={o.speed}
            class={s.speed === o.speed ? 'on' : ''}
            onClick={() => actions.setSpeed(o.speed)}
            title={`Speed ${o.label} (${o.key})`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
