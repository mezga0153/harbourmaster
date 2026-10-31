import { useState } from 'preact/hooks';
import { thumbnail } from '../render/thumbs';
import { isMachineKind, MACHINES } from '../sim/machines';
import { BUILDABLES } from '../sim/rules';
import type { BuildKind } from '../sim/types';
import { money } from './format';
import { Icon } from './icons';
import { land, narrow, openCategory, panel, snapshot, togglePanel, tool } from './store';
import {
  BULLDOZE_TOOL,
  CATEGORIES,
  LAND_TOOL,
  SELECT_TOOL,
  UNMARK_TOOL,
  type Category,
  toolsAt,
  type ToolDef,
} from './tools';

// The bar along the bottom with the tools, and the build menu that opens
// above it from each category.

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

export function BuildBar() {
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
          <ToolButton
            t={{ ...LAND_TOOL, note: land.value ? money(land.value.next) : LAND_TOOL.note }}
            active={current === 'land'}
          />
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
