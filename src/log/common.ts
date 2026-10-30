// What the play log's parts share. The play log tells how players get on:
// each page load (visit.ts), each day of each game (days.ts) and what goes
// wrong (errors.ts), sent to the game's own server (server/), read with
// stats.sh. Nothing about who is playing: random ids kept in the browser, no
// IP, no cookie. Only the built game sends anything, not the dev server, and
// never an automated browser; ?nolog turns it off. Nothing here may get in the
// game's way: every call is wrapped, and a failed send is let go.

export const LOG_ON =
  import.meta.env.PROD &&
  !new URLSearchParams(location.search).has('nolog') &&
  !(navigator as { webdriver?: boolean }).webdriver;

/** A random id: twelve letters and digits. */
export const newId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');

/** This page load's id, which every part of the log names. */
export const visitId = newId();

/** Off it goes: with fetch, or as a beacon when the page is on its way out. */
export function post(url: string, body: unknown, leaving = false): Promise<boolean> {
  const text = JSON.stringify(body);
  try {
    if (leaving && navigator.sendBeacon?.(url, new Blob([text], { type: 'application/json' })))
      return Promise.resolve(true);
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: text,
      keepalive: text.length < 60_000,
    }).then(
      (r) => r.ok,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

/** localStorage, as JSON, or null; nothing thrown. */
export function recall<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
export function keep(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Kept for this page only.
  }
}

/** One more of `what` in a tally. */
export function tally(t: Record<string, number>, what: string, most = 60): void {
  if (what in t) t[what]++;
  else if (Object.keys(t).length < most) t[what] = 1;
}

/**
 * A message as a kind of message, to count with the others like it: the
 * names of people, boats, companies and the town, and the numbers, taken out.
 */
export function gist(text: string, names: string[]): string {
  let s = text;
  for (const n of names) if (n.length > 2) s = s.split(n).join('…');
  return s
    .replace(/\$?\d[\d,.]*/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}
