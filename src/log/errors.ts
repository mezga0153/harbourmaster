import { LOG_ON, post, visitId } from './common';

// What goes wrong in a player's browser, sent to /api/errors: an error
// nothing caught, a promise nobody waited on, the sim worker failing, the
// simulation throwing (the game pauses), a save failing or an autosave the
// game could not read, the 3D view lost. Each different message once a page,
// and a handful at most. With the game and its day, and what the device is.

const URL_ = '/api/errors';
const MOST = 8;
const sent = new Set<string>();

export type ErrorKind = 'error' | 'rejection' | 'worker' | 'sim' | 'save' | 'autosave' | 'webgl';

/** Which game and day are being played, from days.ts. */
let where: () => { game: string | null; day: number | null } = () => ({ game: null, day: null });
export function setWhere(f: typeof where): void {
  where = f;
}

let canvas: HTMLCanvasElement | null = null;
/** The graphics card, as WebGL names it, or null. */
export function gpu(): string | null {
  try {
    const gl = canvas?.getContext('webgl2') ?? null;
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)).slice(0, 120) : null;
  } catch {
    return null;
  }
}

// which script is running: its hashed name once built
const BUILD = (() => {
  try {
    return new URL(import.meta.url).pathname.split('/').pop() ?? null;
  } catch {
    return null;
  }
})();

export function report(kind: ErrorKind, err: unknown, stack?: string): void {
  if (!LOG_ON) return;
  try {
    const e = err as { message?: unknown; stack?: unknown } | null;
    const message = String((e && e.message) || err || 'unknown').slice(0, 500);
    const key = `${kind} ${message}`;
    if (sent.has(key) || sent.size >= MOST) return;
    sent.add(key);
    const nav = navigator as { deviceMemory?: number; hardwareConcurrency?: number };
    const device = {
      w: innerWidth,
      h: innerHeight,
      dpr: devicePixelRatio || 1,
      mem: nav.deviceMemory ?? null,
      cores: nav.hardwareConcurrency ?? null,
      gpu: gpu(),
    };
    const { game, day } = where();
    void post(URL_, {
      errors: [
        {
          kind,
          message,
          stack: (stack ?? (e && e.stack ? String(e.stack) : null))?.slice(0, 2000) ?? null,
          visit: visitId,
          game,
          day,
          page: (location.pathname + location.search).slice(0, 300),
          device,
          build: BUILD,
        },
      ],
    });
  } catch {
    // Reporting must never make things worse.
  }
}

/** Listen for what nothing else catches: on the page, in the sim worker, and the 3D view. */
export function watchErrors(worker: Worker, view: HTMLCanvasElement): void {
  canvas = view;
  if (!LOG_ON) return;
  // A browser extension's errors, and another site's script's (only ever
  // "Script error."), are not the game's.
  addEventListener('error', (e) => {
    if (!e.error && /^Script error\.?$/.test(e.message || '')) return;
    if (e.filename && !e.filename.startsWith(location.origin)) return;
    report('error', e.error || e.message);
  });
  addEventListener('unhandledrejection', (e) => report('rejection', e.reason));
  worker.addEventListener('error', (e) => report('worker', e.message || 'the sim worker failed'));
  view.addEventListener('webglcontextlost', () => report('webgl', 'the 3D view was lost'));
}
