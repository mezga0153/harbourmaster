// The loading screen in index.html, up until the first port is drawn: how
// far along it is, and what it waits on.

const box = document.getElementById('loading');

/** Moves the bar to `fraction` (0 to 1) and says what is loading; never back. */
export function loading(fraction: number, what: string): void {
  if (!box) return;
  box.classList.add('js');
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  if (pct < Number(box.getAttribute('aria-valuenow') ?? 0)) return;
  box.setAttribute('aria-valuenow', String(pct));
  box.querySelector<HTMLElement>('.bar span')!.style.width = `${pct}%`;
  box.querySelector('.what')!.textContent = what;
}

/**
 * The game cannot start: the bar stops and the screen says why and what to
 * do, in place of what was loading.
 */
export function failed(why: string): void {
  if (!box) return;
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
