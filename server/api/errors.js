// Error reports, at /api/errors: what went wrong in a player's browser (see
// migrations/0001_log.sql for each field), sent by src/log/errors.ts.
//   POST { errors: [ { kind, message, stack?, visit?, game?, day?, page?, device?, build? } ] }  -> 204
// Strings are trimmed to their limits; a report of a kind not known, or with
// no message, is turned away. The country, region and city come from the
// request (where.js), never the IP.

import { id, int, json, object } from '../check.js';
import { where } from '../where.js';

const MAX_BODY = 32 * 1024; // bytes
const MAX_ERRORS = 10; // reports a request
export const KINDS = ['error', 'rejection', 'worker', 'sim', 'save', 'autosave', 'webgl'];
const LIMIT = { message: 500, stack: 2000, page: 300, device: 2000, build: 120 };

const text = (v, n) =>
  typeof v === 'string' && v ? v.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').slice(0, n) : null;

/** A row ready to insert, or null if it is not a report. */
export function row(e, now) {
  if (!object(e) || !KINDS.includes(e.kind)) return null;
  const message = text(e.message, LIMIT.message);
  if (!message) return null;
  const device = object(e.device) ? JSON.stringify(e.device).slice(0, LIMIT.device) : null;
  return [
    id(e.visit) ? e.visit : null,
    id(e.game) ? e.game : null,
    int(e.day, 1, 1e6) ? e.day : null,
    e.kind,
    message,
    text(e.stack, LIMIT.stack),
    text(e.page, LIMIT.page),
    device,
    text(e.build, LIMIT.build),
    now,
  ];
}

export async function take(request, env) {
  const got = await json(request, MAX_BODY);
  if (got instanceof Response) return got;
  const list = got.body && Array.isArray(got.body.errors) ? got.body.errors : null;
  if (!list || !list.length || list.length > MAX_ERRORS)
    return new Response(`expected 1 to ${MAX_ERRORS} errors`, { status: 400 });
  const now = Date.now();
  const rows = list.map((e) => row(e, now)).filter(Boolean);
  if (!rows.length) return new Response('no reports', { status: 400 });
  const w = where(request);
  const insert = env.DB.prepare(
    'INSERT INTO errors (visit, game, day, kind, message, stack, page, device, build, created_at, country, region, city) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  await env.DB.batch(rows.map((r) => insert.bind(...r, w.country, w.region, w.city)));
  return new Response(null, { status: 204 });
}
