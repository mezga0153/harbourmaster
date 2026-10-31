// What players tell us, at /api/feedback: a bug, an idea or anything else
// (see migrations/0002_feedback.sql for each field), sent by
// src/log/feedback.ts from the game's feedback panel.
//   POST { kind, text, contact?, visit?, game?, day?, version?, context?, save?, saveBytes?, picture? }  -> 204
// The words are trimmed to their limits; the game and the picture are taken
// only as what they should be (gzip in base64, a JPEG data: URL). Where it
// came from and on what come from the request (where.js), never the IP.

import { id, int, json, object, version } from '../check.js';
import { where } from '../where.js';

const MAX_BODY = 3 * 1024 * 1024; // bytes: a game zipped is tens of kB, a picture a few hundred
const KINDS = ['bug', 'idea', 'other'];
const MAX_SAVE = 1_500_000; // characters of base64
const MAX_PICTURE = 1_200_000;

const words = (v, n) =>
  typeof v === 'string' && v.trim()
    ? v
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
        .trim()
        .slice(0, n)
    : null;

/** The values to insert, or null if it is not feedback. */
export function row(f, now, w) {
  if (!object(f) || !KINDS.includes(f.kind)) return null;
  const text = words(f.text, 5000);
  if (!text) return null;
  if (
    f.save != null &&
    (typeof f.save !== 'string' || f.save.length > MAX_SAVE || !/^[A-Za-z0-9+/]+=*$/.test(f.save))
  )
    return null;
  if (
    f.picture != null &&
    (typeof f.picture !== 'string' ||
      f.picture.length > MAX_PICTURE ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(f.picture))
  )
    return null;
  return [
    f.kind,
    text,
    words(f.contact, 200),
    id(f.visit) ? f.visit : null,
    id(f.game) ? f.game : null,
    int(f.day, 1, 1e6) ? f.day : null,
    version(f.version) ? f.version : null,
    object(f.context) ? JSON.stringify(f.context).slice(0, 20000) : null,
    f.save ?? null,
    f.save != null && int(f.saveBytes, 0, 1e9) ? f.saveBytes : null,
    f.picture ?? null,
    w.device,
    w.ua,
    w.country,
    w.city,
    now,
    now,
  ];
}

export async function take(request, env) {
  const got = await json(request, MAX_BODY);
  if (got instanceof Response) return got;
  const r = row(got.body, Date.now(), where(request));
  if (!r) return new Response('malformed feedback', { status: 400 });
  await env.DB.prepare(
    'INSERT INTO feedback (kind, text, contact, visit, game, day, version, context, save, save_bytes, picture, ' +
      'device, ua, country, city, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(...r)
    .run();
  return new Response(null, { status: 204 });
}
