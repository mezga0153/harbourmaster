import type { IsoCamera } from './render/camera';

/**
 * Where the player is looking, kept in the address as #view=seed,x,y,zoom,turns,
 * so a refresh, or the link shared, opens on the same spot of the same port.
 */
export interface View {
  seed: number;
  x: number;
  y: number;
  zoom: number;
  turns: number;
}

const KEY = 'view';

/** The view in the address, if there is a sound one. */
export function readView(hash = location.hash): View | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const parts = params.get(KEY)?.split(',').map(Number);
  if (!parts || parts.length !== 5 || !parts.every(Number.isFinite)) return null;
  const [seed, x, y, zoom, turns] = parts;
  return { seed, x, y, zoom, turns: Math.round(turns) };
}

/** The address with this view in it, anything else in the hash kept. */
export function viewHash(v: View, hash = location.hash): string {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const r = (n: number) => String(Math.round(n * 10) / 10);
  params.set(KEY, [v.seed, r(v.x), r(v.y), r(v.zoom), v.turns].join(','));
  // Commas read better unescaped.
  return '#' + params.toString().replace(/%2C/g, ',');
}

/** Where the camera is looking now. */
export function viewOf(cam: IsoCamera, seed: number): View {
  return { seed, x: cam.target.x, y: cam.target.z, zoom: cam.viewSize, turns: cam.turns };
}

/** Turn the camera to look as the view says. */
export function applyView(cam: IsoCamera, v: View): void {
  cam.lookAt(v.x, v.y);
  cam.setViewSize(v.zoom);
  cam.setTurns(v.turns);
}

/**
 * Keep the address up to date as the player looks about, without adding to
 * the browser's history: a few times a second at most, and only on change.
 */
export function trackView(cam: IsoCamera, seed: () => number, ready: () => boolean): void {
  let last = '';
  setInterval(() => {
    if (!ready()) return;
    const hash = viewHash(viewOf(cam, seed()));
    if (hash === last) return;
    last = hash;
    history.replaceState(history.state, '', hash);
  }, 400);
}
