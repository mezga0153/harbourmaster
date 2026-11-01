import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { keyHint, panelKey } from '../input/keys';
import { thumbnail } from '../render/thumbs';
import { isMachineKind, MACHINES } from '../sim/machines';
import { BUILDABLES } from '../sim/rules';
import type { BuildKind } from '../sim/types';
import { money } from './format';
import { Icon } from './icons';
import {
  land,
  lockedTools,
  narrow,
  openCategory,
  panel,
  tier,
  togglePanel,
  tool,
  trayTabs,
} from './store';
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
  // Shown, but not to be picked up yet: why is said below the cards.
  const locked = !!lockedTools.value[t.tool];
  return (
    <button
      class={`build-card ${active ? 'on' : ''} ${locked ? 'locked' : ''}`}
      onClick={() => (tool.value = active || locked ? 'select' : t.tool)}
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
        {locked && (
          <span class="lock">
            <Icon name="lock" />
          </span>
        )}
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
  // Only what the port has come to: the rest are not shown at all.
  const tools = toolsAt(cat, tier.value);
  const tabs = [...new Set(tools.map((t) => t.group ?? cat.label))];
  const inHand = tools.find((t) => t.tool === current);
  const kept = trayTabs.value[cat.id];
  const tab =
    (kept && tabs.includes(kept) ? kept : undefined) ??
    (inHand ? (inHand.group ?? cat.label) : undefined) ??
    tabs[0];
  const shown = tools.filter((t) => (t.group ?? cat.label) === tab);
  const about = hovered ?? inHand ?? null;
  const info = about && toolInfo(about);
  const pick = (g: string) => {
    trayTabs.value = { ...trayTabs.value, [cat.id]: g };
    setHovered(null);
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
            {lockedTools.value[about.tool] && (
              <p class="tray-locked">{lockedTools.value[about.tool]}</p>
            )}
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
  const staffKey = panelKey('staff');
  const at = tier.value;
  // Menus with nothing in them yet are not shown at all.
  const categories = CATEGORIES.filter((c) => toolsAt(c, at).length > 0);
  const open = categories.find((c) => c.id === openCategory.value);
  // The tools at the right end of the bar: under a More button that opens
  // them over the map where the bar is too narrow for them all.
  const rest = (
    <>
      <ToolButton t={BULLDOZE_TOOL} active={current === 'bulldoze'} />
      <ToolButton t={UNMARK_TOOL} active={current === 'unmark'} />
      <ToolButton
        t={{ ...LAND_TOOL, note: land.value ? money(land.value.next) : LAND_TOOL.note }}
        active={current === 'land'}
      />
      <button
        class={`tool ${panel.value === 'staff' ? 'on' : ''}`}
        onClick={() => togglePanel('staff')}
        title={`Hire and manage dockhands${keyHint('staff')}`}
      >
        {staffKey && <kbd>{staffKey}</kbd>}
        <Icon name="hire" />
        <span class="tool-label">Staff</span>
        <span class="tool-cost">Hire</span>
      </button>
      {import.meta.env.DEV && (
        // src/debug/: paths, passability, slots and more drawn over the map.
        <button
          class="tool"
          onClick={() => window.dispatchEvent(new Event('hm-debug'))}
          title="Debug overlays (`)"
        >
          <kbd>`</kbd>
          <Icon name="map" />
          <span class="tool-label">Debug</span>
          <span class="tool-cost">Overlays</span>
        </button>
      )}
    </>
  );
  const catButton = (c: Category) => {
    const tools = toolsAt(c, at);
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
  };
  const bar = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  // How many of the menus stay on the bar; the rest go under More too.
  const [shown, setShown] = useState(categories.length);
  const [more, setMore] = useState(false);
  // How wide the bar needs to be for every tool, measured while they were all on it.
  const needs = useRef(0);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const fit = () => {
      if (!compact) {
        if (el.scrollWidth > el.clientWidth + 1) {
          needs.current = el.scrollWidth;
          setCompact(true);
        } else if (shown !== categories.length) setShown(categories.length);
        return;
      }
      if (el.clientWidth >= needs.current) {
        setCompact(false);
        setShown(categories.length);
        return;
      }
      // As many menus as there is room for beside Select and More.
      const [left, middle, right] = [...el.children] as HTMLElement[];
      const button = middle.querySelector<HTMLElement>('.tool')?.offsetWidth ?? 64;
      const style = getComputedStyle(el);
      const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const sides = left.offsetWidth + right.offsetWidth + 2 * 13 + pad;
      const fits = Math.floor((el.clientWidth - sides + 2) / (button + 2));
      const n = Math.max(0, Math.min(categories.length, fits));
      if (n !== shown) setShown(n);
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [compact, shown, categories.length]);
  // Picking a tool, a panel or a menu from it puts it away again.
  useEffect(() => setMore(false), [current, panel.value, openCategory.value]);
  const hidden = compact ? categories.slice(shown) : [];
  const moreOn =
    current === 'bulldoze' ||
    current === 'unmark' ||
    current === 'land' ||
    panel.value === 'staff' ||
    hidden.some(
      (c) => c.id === openCategory.value || toolsAt(c, at).some((t) => t.tool === current),
    );
  return (
    <>
      {open && <CategoryTray key={open.id} cat={open} />}
      {compact && more && (
        <div class="dock-more panel">
          {hidden.map(catButton)}
          {rest}
        </div>
      )}
      <footer class="dock panel" ref={bar}>
        <div class="dock-group">
          <ToolButton t={SELECT_TOOL} active={current === 'select'} />
        </div>
        <div class="dock-group">
          {categories.slice(0, compact ? shown : categories.length).map(catButton)}
        </div>
        {compact ? (
          <div class="dock-group">
            <button
              class={`tool ${more || moreOn ? 'on' : ''}`}
              onClick={() => setMore(!more)}
              aria-expanded={more}
              title="Bulldoze, unmark, land, staff and more"
            >
              <Icon name="menu" />
              <span class="tool-label">More</span>
            </button>
          </div>
        ) : (
          <div class="dock-group">{rest}</div>
        )}
      </footer>
    </>
  );
}
