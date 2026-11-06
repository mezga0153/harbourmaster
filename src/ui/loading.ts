import type { Command } from '../protocol';
import { DIFFICULTIES, DIFFICULTY_ORDER, type Difficulty } from '../sim/balance';
import { TIERS } from '../sim/tiers';
import { formatDate, money } from './format';

// The title screen in index.html, up until the first port is drawn: what to
// play (the port saved in this browser, a new one or a save file), and how
// far along the loading is meanwhile, behind it.

const box = document.getElementById('loading');
const bar = box?.querySelector<HTMLElement>('.bar');
const menu = box?.querySelector<HTMLElement>('.menu');
const levels = box?.querySelector<HTMLElement>('.levels');
const note = box?.querySelector<HTMLElement>('.note');

/** What the player picked, sent once the worker has said what is saved. */
let picked = false;
/** The models are in: until a pick, the bar has nothing left to say. */
let ready = false;

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

/**
 * What is saved in this browser is known: the menu comes up, with Carry on
 * first if there is a port to carry on with. `start` sends the pick.
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
    setNote('');
    start(cmd);
  };
  if (new URLSearchParams(location.search).has('continue')) return go({ type: 'continue' });

  const carry = menu.querySelector<HTMLButtonElement>('[data-go="continue"]')!;
  const fresh = menu.querySelector<HTMLButtonElement>('[data-go="new"]')!;
  const file = menu.querySelector<HTMLButtonElement>('[data-go="file"]')!;
  const picker = menu.querySelector<HTMLInputElement>('input[type="file"]')!;
  const where = saved && `${TIERS[saved.tier]?.name ?? 'Your port'} · ${formatDate(saved.tick)}`;

  carry.hidden = !saved;
  if (saved) {
    const sea = DIFFICULTIES[saved.difficulty ?? 'hard'].name;
    carry.querySelector('small')!.textContent = `${where} · ${sea} · ${money(saved.cash)}`;
  }
  fresh.classList.toggle('primary', !saved);
  carry.onclick = () => go({ type: 'continue' });

  // Over a saved port, a new one asks twice: the old one is set aside for good.
  let sure = !saved;
  fresh.onclick = () => {
    if (sure) return chooseSea(go);
    sure = true;
    fresh.querySelector('span')!.textContent = 'Yes, start afresh';
    setNote(
      `That sets your port (${where}) aside for good: to keep a copy, carry on and save it to a file from Settings first.`,
    );
  };

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

  box.classList.add('menu-up');
  (saved ? carry : fresh).focus({ preventScroll: true });
}

/**
 * A new port: how rough a sea, in place of the menu, each with what it
 * means; Back goes back to the menu.
 */
function chooseSea(go: (cmd: Command) => void): void {
  if (!box || !levels) return;
  const list = levels.querySelector<HTMLElement>('.list')!;
  list.replaceChildren(
    ...DIFFICULTY_ORDER.map((d) => {
      const b = document.createElement('button');
      b.className = `go level ${d}`;
      const name = document.createElement('span');
      name.textContent = DIFFICULTIES[d].name;
      const blurb = document.createElement('small');
      blurb.textContent = DIFFICULTIES[d].blurb;
      b.append(name, blurb);
      b.onclick = () => go({ type: 'newGame', difficulty: d });
      return b;
    }),
  );
  levels.querySelector<HTMLButtonElement>('.back')!.onclick = () => {
    box.classList.remove('levels-up');
    setNote('');
    menu?.querySelector<HTMLButtonElement>('[data-go="new"]')?.focus({ preventScroll: true });
  };
  setNote('');
  box.classList.add('levels-up');
  list.querySelector<HTMLButtonElement>('.medium')?.focus({ preventScroll: true });
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
