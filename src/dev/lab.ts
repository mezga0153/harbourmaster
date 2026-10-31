import '../ui/style.css';
import './lab.css';
import { soundLab } from '../audio/lab';
import { loadAssets } from '../render/assets';
import { rigItems } from './animations';
import { el } from './controls';
import { gallery } from './gallery';
import { modelItems } from './models';
import { scenesTab } from './scenes';

// The dev lab (dev.html, on the dev server only): every sound, model and
// animation in the game to look at on its own, and the game itself to set
// up in any situation and watch. Each tab is made when first opened.

type Tab = {
  id: string;
  label: string;
  make(): HTMLElement & { activate?(on: boolean): void; open?(a?: string, b?: string): void };
};

const TABS: Tab[] = [
  {
    id: 'models',
    label: 'Models',
    make: () =>
      gallery(
        modelItems(),
        'Everything drawn in the game, each built from its seed. Drag to look round, wheel to zoom, right-drag to pan.',
      ),
  },
  {
    id: 'animations',
    label: 'Animations',
    make: () =>
      gallery(
        rigItems(),
        'What moves in place, run by the game’s own code with its inputs on sliders. What moves about the port is on the Scenes tab.',
      ),
  },
  { id: 'scenes', label: 'Scenes', make: scenesTab },
  {
    id: 'sounds',
    label: 'Sounds',
    make: () => {
      const root = el('div', { className: 'lab-sounds' });
      soundLab(root);
      return root;
    },
  },
];

const root = document.getElementById('devlab')!;
const bar = el('nav', { className: 'lab-tabs' }, el('strong', {}, 'Harbourmaster lab'));
const pages = el('div', { className: 'lab-pages' });
root.append(bar, pages);

const made = new Map<string, ReturnType<Tab['make']>>();
const buttons = new Map<string, HTMLButtonElement>();
let current: string | null = null;

function show(id: string, a?: string, b?: string): void {
  const tab = TABS.find((t) => t.id === id) ?? TABS[0];
  if (current === tab.id) {
    made.get(tab.id)?.open?.(a, b);
    return;
  }
  if (current) made.get(current)?.activate?.(false);
  for (const [k, page] of made) page.style.display = k === tab.id ? '' : 'none';
  let page = made.get(tab.id);
  if (!page) {
    page = tab.make();
    page.classList.add('lab-page');
    made.set(tab.id, page);
    pages.append(page);
  }
  current = tab.id;
  for (const [k, btn] of buttons) btn.classList.toggle('on', k === tab.id);
  page.activate?.(true);
  page.open?.(a, b);
  if (!location.hash.startsWith(`#${tab.id}`)) location.hash = tab.id;
}

for (const t of TABS) {
  const btn = el('button', { onclick: () => show(t.id) }, t.label);
  buttons.set(t.id, btn);
  bar.append(btn);
}
bar.append(el('a', { href: '/', className: 'lab-game-link' }, 'The game ↗'));

function fromHash(): void {
  const [id, a, b] = location.hash
    .slice(1)
    .split('/')
    .map((s) => decodeURIComponent(s));
  show(id || 'models', a, b);
}

// The Kenney models (trees, rocks, containers) load once, before anything is shown.
void loadAssets().then(() => {
  fromHash();
  window.addEventListener('hashchange', fromHash);
});
