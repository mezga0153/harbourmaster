// Visits, at /api/visits: one row per page load of the game, sent by
// src/log/visit.ts (see migrations/0001_log.sql for each field).
//   POST { visit, page, ref?, lang?, sw?, sh?, dpr?, touch?, graphics?, gpu?,
//          game?, seed?, day0?, day?, actions, newGames, seconds }  -> 204
// The first one makes the row; the ones after bring how far the visit got up
// to date (the game, its day, what was done, the time looked at), and only for
// a day. Where and on what come from the request (where.js), never the IP.

import { id, int, json, num, plain } from '../check.js';
import { where } from '../where.js';

const MAX_BODY = 4 * 1024; // bytes
const FRESH = 24 * 3600 * 1000; // ms a visit can be brought up to date for
const CLICK_IDS =
  /^(fbclid|gclid|gbraid|wbraid|dclid|msclkid|ttclid|twclid|igshid|yclid|mc_eid|_ga|_gl)$/i;

const dec = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// the page it came from, as host and path and any utm_ tags, whatever else
// the browser sent (an app says android-app://its.name); undefined if it isn't one
function from(ref) {
  if (ref == null || ref === '') return null;
  if (!plain(ref, 600)) return undefined;
  let u;
  try {
    u = new URL(ref);
  } catch {
    return undefined;
  }
  const web = u.protocol === 'http:' || u.protocol === 'https:';
  const host = (u.hostname || u.protocol.slice(0, -1)).slice(0, 120);
  const q = new URLSearchParams(
    [...u.searchParams]
      .filter(([k]) => /^utm_\w{1,20}$/i.test(k))
      .map(([k, v]) => [k, v.slice(0, 60)]),
  ).toString();
  const path = u.hostname ? u.pathname : '';
  return {
    host,
    ref: ((web ? '' : u.protocol + '//') + host + path + (q ? '?' + q : '')).slice(0, 300),
  };
}

// the address it landed on, without the ad networks' click ids or the view in the #
function landing(page) {
  if (!plain(page, 400) || page[0] !== '/') return null;
  const [path, query = ''] = page.split('#')[0].split('?');
  const q = query.split('&').filter((kv) => kv && !CLICK_IDS.test(dec(kv.split('=')[0])));
  return (path + (q.length ? '?' + q.join('&') : '')).slice(0, 300);
}

/** A row ready to insert, or null if anything about it is off. */
export function row(v, now, w) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !id(v.visit)) return null;
  if (v.game != null && !id(v.game)) return null;
  const page = landing(v.page);
  const ref = from(v.ref);
  if (!page || ref === undefined) return null;
  if (
    v.lang != null &&
    (typeof v.lang !== 'string' || !/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{1,8}){0,3}$/.test(v.lang))
  )
    return null;
  for (const k of ['sw', 'sh']) if (v[k] != null && !int(v[k], 0, 100000)) return null;
  if (v.dpr != null && !num(v.dpr, 0.1, 20)) return null;
  if (v.touch != null && typeof v.touch !== 'boolean') return null;
  if (
    v.graphics != null &&
    (typeof v.graphics !== 'string' || !/^[a-z]{1,12}(\/[a-z]{1,12}){0,4}$/.test(v.graphics))
  )
    return null;
  if (v.gpu != null && !plain(v.gpu, 300)) return null;
  if (v.seed != null && !int(v.seed, 0, 1e9)) return null;
  for (const k of ['day0', 'day']) if (v[k] != null && !int(v[k], 1, 1e6)) return null;
  if (!int(v.actions, 0, 1e7) || !int(v.newGames, 0, 1e4) || !num(v.seconds, 0, 7 * 86400))
    return null;
  return [
    v.visit,
    page,
    ref ? ref.ref : null,
    ref ? ref.host : null,
    v.lang ?? null,
    v.sw ?? null,
    v.sh ?? null,
    v.dpr == null ? null : Math.round(v.dpr * 100) / 100,
    v.touch == null ? null : v.touch ? 1 : 0,
    v.graphics ?? null,
    v.gpu ? v.gpu.slice(0, 120) : null,
    w.device,
    w.ua,
    w.country,
    w.region,
    w.city,
    v.game ?? null,
    v.seed ?? null,
    v.day0 ?? null,
    v.day ?? null,
    v.actions,
    v.newGames,
    Math.round(v.seconds * 10) / 10,
    now,
    now,
  ];
}

export async function take(request, env) {
  const got = await json(request, MAX_BODY);
  if (got instanceof Response) return got;
  const r = row(got.body, Date.now(), where(request));
  if (!r) return new Response('malformed visit', { status: 400 });
  // where it came from and on what stay as the first beacon had them; the
  // game is the latest one played, the day the game opened on the first
  await env.DB.prepare(
    'INSERT INTO visits (visit, page, referrer, ref_host, lang, screen_w, screen_h, dpr, touch, graphics, gpu, device, ua, ' +
      'country, region, city, game, seed, day0, day, actions, new_games, seconds, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (visit) DO UPDATE SET game = COALESCE(excluded.game, game), seed = COALESCE(excluded.seed, seed), ' +
      'day0 = COALESCE(day0, excluded.day0), day = COALESCE(excluded.day, day), actions = MAX(actions, excluded.actions), ' +
      'new_games = MAX(new_games, excluded.new_games), seconds = MAX(seconds, excluded.seconds), updated_at = excluded.updated_at ' +
      `WHERE created_at > excluded.created_at - ${FRESH}`,
  )
    .bind(...r)
    .run();
  return new Response(null, { status: 204 });
}
