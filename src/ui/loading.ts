import { h, render } from 'preact';
import { VERSION } from '../log/common';
import type { Command } from '../protocol';
import { DIFFICULTIES, DIFFICULTY_ORDER, type Difficulty } from '../sim/balance';
import { TIERS } from '../sim/tiers';
import { formatDate, money } from './format';
import { TitleOptions } from './Options';

// The title screen in index.html, up until the first port is drawn: the main
// menu (the port saved in this browser, a new one, a save file, the options)
// and how far along the loading is meanwhile, behind it. The title screen is
// at /, the game at /play: a game started moves the address there, so a
// refresh carries on rather than coming back to the menu.

const PLAY_PATH = '/play';

const box = document.getElementById('loading');
const bar = box?.querySelector<HTMLElement>('.bar');
const menu = box?.querySelector<HTMLElement>('.menu');
const note = box?.querySelector<HTMLElement>('.note');

/** What the player picked, sent once the worker has said what is saved. */
let picked = false;
/** The models are in: until a pick, the bar has nothing left to say. */
let ready = false;

const version = box?.querySelector('.version');
if (version) version.textContent = `Version ${VERSION}`;

/** The page is the game's own address, not the title screen's. */
function onPlayPath(): boolean {
  return location.pathname.replace(/\/+$/, '') === PLAY_PATH;
}

/** The address, at `path`, with what else it holds (the debug flags, the view) kept. */
function moveTo(path: string): void {
  if (location.pathname !== path) {
    history.replaceState(history.state, '', path + location.search + location.hash);
  }
}

/** A game is up: the address is the game's, so a refresh carries on with it. */
export function playing(): void {
  moveTo(PLAY_PATH);
}

/** Back to the title screen, as a fresh page (the game is saved first, see main.ts). */
export function toTitle(): void {
  const params = new URLSearchParams(location.search);
  params.delete('continue');
  const query = params.toString();
  location.assign('/' + (query ? `?${query}` : ''));
}

/** Moves the bar to `fraction` (0 to 1) and says what is loading; never back. */
export function loading(fraction: number, what: string): void {
  if (!box || !bar) return;
  box.classList.add('js');
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  if (pct < Number(bar.getAttribute('aria-valuenow') ?? 0)) return;
  bar.setAttribute('aria-valuenow', String(pct));
  bar.querySelector('span')!.style.width = `${pct}%`;
  box.querySelector('.what')!.textContent = what;
}

/** The models are loaded: if the player has not picked yet, the bar steps aside for the menu. */
export function assetsLoaded(): void {
  ready = true;
  loading(0.88, 'Laying out the port…');
  if (!picked) box?.classList.add('idle');
}

type Sheet = 'new' | 'options';

/** Opens a sheet beside the menu (a new port's sea, the options), or closes it. */
function showSheet(sheet: Sheet | null, back?: HTMLElement | null): void {
  if (!box) return;
  if (sheet) box.dataset.sheet = sheet;
  else delete box.dataset.sheet;
  setNote('');
  if (!sheet) back?.focus({ preventScroll: true });
}

/**
 * What is saved in this browser is known: the menu comes up, with Continue
 * first if there is a port to carry on with. `start` sends the pick. At
 * /play, the saved port carries on at once.
 */
export function titleMenu(
  saved: { tick: number; cash: number; tier: number; difficulty?: Difficulty } | null,
  start: (cmd: Command) => void,
): void {
  if (!box || !menu || box.classList.contains('failed')) return;
  const go = (cmd: Command) => {
    if (picked) return;
    picked = true;
    box.classList.remove('idle');
    box.classList.add('picked');
    showSheet(null);
    start(cmd);
  };
  if (new URLSearchParams(location.search).has('continue') || (onPlayPath() && saved)) {
    return go({ type: 'continue' });
  }
  // Nothing to carry on with at /play: the menu, at its own address.
  moveTo('/');

  const carry = menu.querySelector<HTMLButtonElement>('[data-go="continue"]')!;
  const fresh = menu.querySelector<HTMLButtonElement>('[data-go="new"]')!;
  const file = menu.querySelector<HTMLButtonElement>('[data-go="file"]')!;
  const options = menu.querySelector<HTMLButtonElement>('[data-go="options"]')!;
  const picker = menu.querySelector<HTMLInputElement>('input[type="file"]')!;
  const where = saved && `${TIERS[saved.tier]?.name ?? 'Your port'} · ${formatDate(saved.tick)}`;

  carry.hidden = !saved;
  if (saved) {
    const sea = DIFFICULTIES[saved.difficulty ?? 'hard'].name;
    carry.querySelector('small')!.textContent = `${where} · ${sea} · ${money(saved.cash)}`;
  }
  fresh.classList.toggle('primary', !saved);
  carry.onclick = () => go({ type: 'continue' });
  fresh.onclick = () => {
    seaSheet(go, where);
    showSheet('new');
    box.querySelector<HTMLButtonElement>('.sea.medium')?.focus({ preventScroll: true });
  };
  options.onclick = () => {
    const body = box.querySelector<HTMLElement>('.opts');
    if (body && !body.hasChildNodes()) render(h(TitleOptions, {}), body);
    showSheet('options');
    box.querySelector<HTMLButtonElement>('.opts [role="tab"]')?.focus({ preventScroll: true });
  };
  for (const sheet of box.querySelectorAll<HTMLElement>('.sheet')) {
    const opener = sheet.dataset.sheet === 'new' ? fresh : options;
    for (const close of sheet.querySelectorAll<HTMLButtonElement>('[data-close]')) {
      close.onclick = () => showSheet(null, opener);
    }
  }

  file.onclick = () => picker.click();
  picker.onchange = async () => {
    const f = picker.files?.[0];
    picker.value = '';
    if (!f) return;
    try {
      go({ type: 'importSave', save: JSON.parse(await f.text()), name: f.name });
    } catch {
      setNote(`${f.name} is not a Harbourmaster save.`);
    }
  };

  // Up and down go through the menu; Escape shuts a sheet.
  box.onkeydown = (e) => {
    if (picked) return;
    if (e.key === 'Escape' && box.dataset.sheet) {
      showSheet(null, box.dataset.sheet === 'new' ? fresh : options);
      return;
    }
    if ((e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || box.dataset.sheet) return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('.go')].filter((b) => !b.hidden);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
    e.preventDefault();
  };

  box.classList.add('menu-up');
  (saved ? carry : fresh).focus({ preventScroll: true });
}

/**
 * A new port: how rough a sea, each with what it means, and the coastline's
 * seed (random unless the player gives one). Over a saved port, a word that
 * it is set aside for good.
 */
function seaSheet(go: (cmd: Command) => void, where: string | null): void {
  if (!box) return;
  const list = box.querySelector<HTMLElement>('.seas')!;
  const seed = box.querySelector<HTMLInputElement>('.seed input')!;
  const warn = box.querySelector<HTMLElement>('.replace')!;
  warn.hidden = !where;
  if (where) {
    warn.textContent = `This sets your port (${where}) aside for good. To keep a copy, carry on and save it to a file from Settings first.`;
  }
  box.querySelector<HTMLButtonElement>('.seed button')!.onclick = () => {
    seed.value = String(Math.floor(Math.random() * 1_000_000));
  };
  const pick = (d: Difficulty) => {
    const n = Number.parseInt(seed.value, 10);
    go({ type: 'newGame', difficulty: d, seed: Number.isFinite(n) ? Math.abs(n) : undefined });
  };
  list.replaceChildren(
    ...DIFFICULTY_ORDER.map((d) => {
      const b = document.createElement('button');
      b.className = `sea ${d}`;
      const waves = document.createElement('span');
      waves.className = 'waves';
      waves.setAttribute('aria-hidden', 'true');
      waves.textContent = '~'.repeat(DIFFICULTY_ORDER.indexOf(d) + 1);
      const name = document.createElement('strong');
      name.textContent = DIFFICULTIES[d].name;
      const blurb = document.createElement('small');
      blurb.textContent = DIFFICULTIES[d].blurb;
      const terms = document.createElement('span');
      terms.className = 'terms';
      terms.textContent = `Pay ×${DIFFICULTIES[d].pay} · Penalties ×${DIFFICULTIES[d].penalties}`;
      b.append(waves, name, blurb, terms);
      if (d === 'medium') {
        const tag = document.createElement('span');
        tag.className = 'pick';
        tag.textContent = 'Recommended';
        b.append(tag);
      }
      b.onclick = () => pick(d);
      return b;
    }),
  );
}

/** The pick could not start a game (a save file it cannot read): the menu comes back, saying why. */
export function refused(why: string): void {
  if (!box) return;
  picked = false;
  box.classList.remove('picked');
  if (ready) box.classList.add('idle');
  setNote(why);
}

function setNote(text: string): void {
  if (!note) return;
  note.textContent = text;
  note.hidden = !text;
}

/**
 * The game cannot start: the bar stops and the screen says why and what to
 * do, in place of what was loading.
 */
export function failed(why: string): void {
  if (!box) return;
  box.classList.remove('idle', 'menu-up');
  delete box.dataset.sheet;
  box.classList.add('js', 'failed');
  box.querySelector('.what')!.textContent = why;
  box.querySelector('.quip')?.remove();
}

/** The game is up: the screen fades away. */
export function loaded(): void {
  if (!box || box.classList.contains('done')) return;
  loading(1, 'Ready');
  box.classList.add('done');
  setTimeout(() => box.remove(), 500);
}
