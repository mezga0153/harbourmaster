// What the play log's addresses share: reading the body, and telling whether
// a value is what it should be. Anything off is turned away whole: this is
// for tuning the game, so a wrong row is worse than a missing one.

export const ID = /^[a-z0-9]{8,32}$/;

export const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
export const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
export const plain = (v, n) => typeof v === 'string' && v.length <= n && !/[\u0000-\u001f]/.test(v);
export const id = (v) => typeof v === 'string' && ID.test(v);
export const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** {what: how many}, with at most `most` keys of `len` characters: as JSON, or undefined if it is not that. */
export function counts(v, most = 60, len = 120) {
  if (v == null) return null;
  if (!object(v)) return undefined;
  const e = Object.entries(v);
  if (e.length > most || !e.every(([k, n]) => plain(k, len) && k && int(n, 0, 1e7)))
    return undefined;
  return JSON.stringify(v);
}

/** {name: number}, flat, with at most `most` keys: as JSON, or undefined if it is not that. */
export function numbers(v, most = 30) {
  if (v == null) return null;
  if (!object(v)) return undefined;
  const e = Object.entries(v);
  if (e.length > most || !e.every(([k, n]) => /^[a-zA-Z]{1,30}$/.test(k) && num(n, -1e13, 1e13)))
    return undefined;
  return JSON.stringify(v);
}

/** The body as JSON, or a Response turning it away. */
export async function json(request, most) {
  const text = await request.text();
  if (text.length > most) return new Response('too big', { status: 413 });
  try {
    return { body: JSON.parse(text) };
  } catch {
    return new Response('expected JSON', { status: 400 });
  }
}
