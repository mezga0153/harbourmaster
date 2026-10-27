import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type { Command } from '../protocol';
import * as B from '../sim/balance';
import { BUILDABLES } from '../sim/rules';
import { Terrain, type BuildKind } from '../sim/types';
import { dayProgress, formatDate, money } from './format';
import { ContractsPanel } from './Contracts';
import { Icon, type IconName } from './icons';
import { TOOL_GROUPS, type ToolDef } from './tools';
import {
  contractsOpen,
  hover,
  messages,
  newGameOpen,
  preview,
  seed,
  selection,
  snapshot,
  tool,
} from './store';
import { InfoHeader, Meter } from './widgets';

export interface Actions {
  send(cmd: Command): void;
  setSpeed(speed: number): void;
  togglePause(): void;
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
      {contractsOpen.value ? <ContractsPanel actions={actions} /> : <InfoPanel actions={actions} />}
      <PreviewTip />
      <HoverTip />
      <BuildBar actions={actions} />
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
  icon: IconName;
  label: string;
  title: string;
  children: ComponentChildren;
  tone?: string;
  /** Higher numbers hide first on narrow screens. */
  priority?: number;
}) {
  return (
    <div class={`stat ${tone ?? ''}`} title={title} data-priority={priority}>
      <Icon name={icon} />
      <div>
        <div class="stat-label">{label}</div>
        <div class="stat-value">{children}</div>
      </div>
    </div>
  );
}

function TopBar({ actions }: { actions: Actions }) {
  const s = snapshot.value;
  if (!s) return null;
  const costs = s.wages + s.contractFees;
  return (
    <header class="topbar panel">
      <div class="topbar-left">
        <div class="brand">
          <span class="brand-mark">
            <Icon name="anchor" />
          </span>
          <span class="brand-name">Harbourmaster</span>
        </div>
        <span class="vr" />
        <Stat icon="coins" label="Cash" title="Cash in the bank" tone={s.cash < 0 ? 'neg' : 'pos'}>
          {money(s.cash)}
        </Stat>
        <Stat icon="coins" label="Costs / day" title="Daily wages and haulier fees" priority={2}>
          {money(-costs)}
        </Stat>
        <Stat icon="users" label="Staff" title="Dockhands employed" priority={3}>
          {s.staff}
        </Stat>
        <Stat icon="box" label="Crates" title="Crates handled so far" priority={3}>
          {s.stats.cratesHandled.toLocaleString('en-US')}
        </Stat>
      </div>

      <div class="topbar-center">
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

      <div class="topbar-right">
        <button
          class={`btn ${contractsOpen.value ? 'on' : ''}`}
          onClick={() => (contractsOpen.value = !contractsOpen.value)}
          title="Contracts (C)"
        >
          <Icon name="contract" />
          <span>Contracts</span>
          {s.offers.length > 0 && <span class="count">{s.offers.length}</span>}
        </button>
        <button class="btn icon" onClick={() => actions.send({ type: 'save' })} title="Save game">
          <Icon name="save" />
        </button>
        <button class="btn icon" onClick={() => (newGameOpen.value = true)} title="New port">
          <Icon name="map" />
        </button>
      </div>
    </header>
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

const KIND_LABEL = { dockhand: 'Dockhand', boat: 'Fishing boat', truck: 'Truck' } as const;

function InfoPanel({ actions }: { actions: Actions }) {
  const sel = selection.value;
  const s = snapshot.value;
  if (!sel || !s) return null;
  const close = () => (selection.value = null);

  if (sel.type === 'bay') {
    const bay = s.bays.find((b) => b.idx === sel.idx);
    if (!bay) return null;
    return (
      <aside class="side panel">
        <InfoHeader kicker="Building" title="Truck bay" onClose={close} />
        <dl class="props">
          <dt>Crates waiting</dt>
          <dd>
            {bay.stock} / {B.BAY_CAPACITY}
          </dd>
        </dl>
        <Meter value={bay.stock / B.BAY_CAPACITY} />
        {bay.noAccess && <p class="note bad">No road connection. Trucks cannot reach this bay.</p>}
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
      {e.kind === 'dockhand' && (
        <>
          <dl class="props">
            <dt>Role</dt>
            <dd>Dockhand</dd>
            <dt>Wage</dt>
            <dd>{money(B.WAGE_DOCKHAND)} / day</dd>
          </dl>
          <div class="actions">
            <button
              class="btn danger"
              onClick={() => {
                actions.send({ type: 'fire', id: e.id });
                close();
              }}
            >
              Dismiss
            </button>
          </div>
        </>
      )}
      {e.kind === 'boat' && (
        <dl class="props">
          <dt>Cargo</dt>
          <dd>{e.load} crates</dd>
        </dl>
      )}
      {e.kind === 'truck' && (
        <>
          <dl class="props">
            <dt>Load</dt>
            <dd>
              {e.load} / {e.capacity} crates
            </dd>
          </dl>
          <Meter value={e.load / e.capacity} />
        </>
      )}
    </aside>
  );
}

function PreviewTip() {
  const p = preview.value;
  if (!p) return null;
  if (p.error) {
    return (
      <div class="tip preview bad">
        <Icon name="alert" />
        {p.error}
      </div>
    );
  }
  if (p.count === 0) return null;
  return (
    <div class="tip preview">
      <span class="muted">{p.count === 1 ? '1 tile' : `${p.count} tiles`}</span>
      <strong class={p.value < 0 ? 'neg' : 'pos'}>{money(p.value)}</strong>
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

function ToolButton({ t, active }: { t: ToolDef; active: boolean }) {
  const def = t.tool in BUILDABLES ? BUILDABLES[t.tool as BuildKind] : null;
  const title = [def ? `${def.label}: ${def.hint}` : t.label, t.key && `(${t.key})`]
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
      <span class="tool-cost">{def ? money(def.cost) : t.note}</span>
    </button>
  );
}

function BuildBar({ actions }: { actions: Actions }) {
  const current = tool.value;
  const cash = snapshot.value?.cash ?? 0;
  return (
    <footer class="dock panel">
      {TOOL_GROUPS.map((group, g) => (
        <div class="dock-group" key={g}>
          {group.map((t) => (
            <ToolButton key={t.tool} t={t} active={current === t.tool} />
          ))}
        </div>
      ))}
      <div class="dock-group">
        <button
          class="tool"
          onClick={() => actions.send({ type: 'hire' })}
          disabled={cash < B.HIRE_FEE}
          title={`Hire a dockhand (H). ${money(B.HIRE_FEE)} fee, ${money(B.WAGE_DOCKHAND)}/day`}
        >
          <kbd>H</kbd>
          <Icon name="hire" />
          <span class="tool-label">Hire</span>
          <span class="tool-cost">{money(B.HIRE_FEE)}</span>
        </button>
      </div>
    </footer>
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
