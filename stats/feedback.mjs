// What players have told us (the feedback table, migrations/0002_feedback.sql):
// listing it, a report's picture and context, its game unzipped to load in the
// dev game, and marking it seen or done. For the stats page and stats.sh.
import { gunzipSync } from 'node:zlib';
import { d1 } from './db.mjs';

export const STATUSES = ['new', 'seen', 'done', 'wontfix'];
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const number = (id) => {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new Error('not a report id');
  return n;
};

/** Every report, the ones still to be read first, without their game and picture. */
export async function list(local) {
  const [rows] = await d1(
    [
      `SELECT id, created_at, status, kind, text, contact, version, game, day, device, city, country,
              save IS NOT NULL AS has_game, picture IS NOT NULL AS has_picture, save_bytes, note, updated_at
       FROM feedback ORDER BY status <> 'new', id DESC LIMIT 300`,
    ],
    { local },
  );
  return rows;
}

/** One report's picture (a data: URL) and context. */
export async function item(local, id) {
  const [rows] = await d1(
    [`SELECT id, picture, context, ua, visit FROM feedback WHERE id = ${number(id)}`],
    { local },
  );
  return rows[0] ?? null;
}

/** One report's game, as the JSON save the game loads, or null if it came without. */
export async function game(local, id) {
  const [rows] = await d1([`SELECT save FROM feedback WHERE id = ${number(id)}`], { local });
  const save = rows[0]?.save;
  return save ? gunzipSync(Buffer.from(save, 'base64')).toString('utf8') : null;
}

/** Mark a report new, seen, done or won't fix, with a note of ours. */
export async function mark(local, id, status, note) {
  if (!STATUSES.includes(status)) throw new Error(`a status is one of ${STATUSES.join(', ')}`);
  const set = [`status = ${quote(status)}`, `updated_at = ${Date.now()}`];
  if (note != null) set.push(`note = ${note === '' ? 'NULL' : quote(String(note).slice(0, 2000))}`);
  await d1([`UPDATE feedback SET ${set.join(', ')} WHERE id = ${number(id)}`], { local });
}
