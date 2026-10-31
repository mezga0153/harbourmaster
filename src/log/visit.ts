import { LOG_ON, post, VERSION, visitId } from './common';

// Each page load of the game is a visit, sent to /api/visits: the page it came
// from (the referrer's host and path, and any utm_ tags), the address it
// landed on, the browser's language, the screen, a finger or a mouse, the
// graphics settings and card; then how far it got: the game and its day, how
// much the player did, how long the page was looked at. The server adds the
// country and city and the kind of device. One beacon at load; if the server
// took it, more as the game starts, each day ends and the page is put away.

const URL_ = '/api/visits';
const MOST = 80; // updates a page sends at most
const CLICK_IDS =
  /^(fbclid|gclid|gbraid|wbraid|dclid|msclkid|ttclid|twclid|igshid|yclid|mc_eid|_ga|_gl)$/i;

let first: Record<string, unknown> | null = null; // what the visit is, as it opened
let open = false; // the server has it
let owed = false; // something changed before it did
let sent = 0;
let last = '';
const now = {
  game: null as string | null,
  seed: null as number | null,
  day0: null as number | null,
  day: null as number | null,
  actions: 0,
  newGames: 0,
};
let seen = 0; // ms looked at before this look
let since = performance.now(); // and when this look began
const looked = () =>
  Math.round((seen + (document.hidden ? 0 : performance.now() - since)) / 100) / 10;

// the referrer, as host and path and utm_ tags only
function from(): string | null {
  const r = document.referrer;
  if (!r) return null;
  const u = new URL(r);
  const utm = [...u.searchParams].filter(([k]) => /^utm_\w+$/i.test(k));
  return (
    u.protocol +
    '//' +
    u.host +
    u.pathname +
    (utm.length ? '?' + new URLSearchParams(utm) : '')
  ).slice(0, 500);
}
// the address, without an ad network's click id (and never the view in the #)
function landing(): string {
  const q = new URLSearchParams(location.search);
  for (const k of [...q.keys()]) if (CLICK_IDS.test(k)) q.delete(k);
  const s = q.toString();
  return (location.pathname + (s ? '?' + s : '')).slice(0, 300);
}

const body = () => JSON.stringify({ ...first, ...now, seconds: looked() });

function send(leaving = false): void {
  if (!first) return;
  if (!open) {
    owed = true;
    return;
  }
  const b = body();
  if (b === last || sent >= MOST) return;
  last = b;
  sent++;
  void post(URL_, JSON.parse(b), leaving);
}

/** The game is on the page: off goes the first one. */
export function visitOpen(graphics: string, gpu: string | null): void {
  if (!LOG_ON) return;
  try {
    let ref: string | null = null;
    try {
      ref = from();
    } catch {
      // Not an address.
    }
    const s = window.screen;
    first = {
      visit: visitId,
      version: VERSION,
      page: landing(),
      ref,
      lang: String(navigator.language || '').slice(0, 35) || null,
      sw: s?.width | 0 || null,
      sh: s?.height | 0 || null,
      dpr: Math.round((devicePixelRatio || 1) * 100) / 100,
      touch: matchMedia('(pointer: coarse)').matches,
      graphics,
      gpu,
    };
    last = body();
    void post(URL_, JSON.parse(last)).then((ok) => {
      open = ok;
      if (open && owed) send(document.hidden);
    });
    addEventListener('visibilitychange', () => {
      if (document.hidden) {
        seen += performance.now() - since;
        send(true);
      } else since = performance.now();
    });
    addEventListener('pagehide', () => send(true));
  } catch {
    // The game goes on regardless.
  }
}

/** A game started or carried on: the first, or a new one on this page. */
export function visitGame(game: string, seed: number, day: number, again: boolean): void {
  Object.assign(now, { game, seed, day });
  now.day0 ??= day;
  if (again) now.newGames++;
  send();
}
/** A day of it ended. */
export function visitDay(day: number): void {
  now.day = day;
  send();
}
/** The player did something. */
export function visitAction(): void {
  now.actions++;
}
