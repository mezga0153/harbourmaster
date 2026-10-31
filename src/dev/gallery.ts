import { Box3 } from 'three';
import { button, defaults, el, paramPanel, toggle, type Param, type Params } from './controls';
import { Stage, type Staged } from './stage';

// A gallery: a list of things to look at down the side, one of them on the
// stage, with the controls it offers. The models and the animations tabs
// are each one of these over their own catalogue.

export interface Item {
  group: string;
  name: string;
  note?: string;
  params?: readonly Param[];
  /** Make it as the params say; `update` on the result takes up live params as they change. */
  make(p: Params): Staged & { live?(p: Params): void };
}

export function gallery(items: Item[], intro: string): HTMLElement {
  const root = el('div', { className: 'lab-gallery' });
  const side = el('aside', { className: 'lab-side' });
  const view = el('div', { className: 'lab-view' });
  const stageBox = el('div', { className: 'lab-stage' });
  const controls = el('div', { className: 'lab-controls' });
  const info = el('div', { className: 'lab-info' });
  view.append(stageBox, controls, info);
  root.append(side, view);

  let stage: Stage | null = null;
  let current: Item | null = null;
  let values: Params = {};
  let shown: ReturnType<Item['make']> | null = null;
  let paramsEl: HTMLElement | null = null;

  const search = el('input', { type: 'search', placeholder: 'Filter…' });
  const list = el('div', { className: 'lab-list' });
  side.append(el('p', { className: 'lab-lead' }, intro), search, list);

  const rows = new Map<Item, HTMLButtonElement>();
  function fill(): void {
    list.replaceChildren();
    const q = search.value.trim().toLowerCase();
    let group = '';
    for (const it of items) {
      if (q && !`${it.group} ${it.name}`.toLowerCase().includes(q)) continue;
      if (it.group !== group) {
        group = it.group;
        list.append(el('h3', {}, group));
      }
      const row = button(it.name, () => pick(it), it === current ? 'on' : '');
      rows.set(it, row);
      list.append(row);
    }
  }
  search.oninput = fill;

  function rebuild(): void {
    if (!stage || !current) return;
    stage.clear();
    shown = current.make(values);
    stage.show(shown);
  }

  function pick(it: Item): void {
    stage ??= new Stage(stageBox);
    for (const [k, row] of rows) row.classList.toggle('on', k === it);
    current = it;
    values = defaults(it.params ?? []);
    paramsEl?.remove();
    paramsEl = paramPanel(it.params ?? [], values, () => shown?.live?.(values), rebuild);
    controls.prepend(paramsEl);
    rebuild();
    location.hash = `${location.hash.split('/')[0]}/${encodeURIComponent(it.group)}/${encodeURIComponent(it.name)}`;
  }

  // The stage's own controls, after the item's.
  const stageRow = el(
    'div',
    { className: 'lab-row' },
    toggle('Spin', false, (v) => stage && (stage.spin = v)),
    toggle('Game angle', false, (v) => {
      if (!stage) return;
      stage.iso = v;
      if (v) stage.gameAngle();
    }),
    toggle('Pause', false, (v) => stage && (stage.paused = v)),
    button('Frame', () => stage && shown && stage.frame(shown.box ?? boxOf(shown))),
    button('Save PNG', () => {
      if (!stage || !current) return;
      const a = el('a', {
        href: stage.png(),
        download: `${current.name.replace(/\W+/g, '-')}.png`,
      });
      a.click();
    }),
    button('Next', () => step(1)),
    button('Previous', () => step(-1)),
  );
  controls.append(stageRow);

  function step(d: number): void {
    const k = current ? items.indexOf(current) : -1;
    const next = items[(k + d + items.length) % items.length];
    pick(next);
    rows.get(next)?.scrollIntoView({ block: 'nearest' });
  }

  setInterval(() => {
    if (stage) info.textContent = `${current?.note ?? ''} ${stage.info}`.trim();
  }, 500);

  fill();
  // A handle for poking at the gallery from the console or a test driver.
  Object.assign(window, {
    __lab: {
      get stage() {
        return stage;
      },
      get item() {
        return current;
      },
      pick,
    },
  });
  return Object.assign(root, {
    /** Show the item named in the page's address, or the first. */
    open(group?: string, name?: string): void {
      const it = items.find((i) => i.group === group && i.name === name) ?? items[0];
      if (it && it !== current) {
        pick(it);
        rows.get(it)?.scrollIntoView({ block: 'nearest' });
      }
    },
  });
}

function boxOf(s: Staged): Box3 {
  s.object.updateMatrixWorld(true);
  return new Box3().setFromObject(s.object);
}
