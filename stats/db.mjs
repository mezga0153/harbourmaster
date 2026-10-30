// Asking the play log (the days, visits and errors tables in D1, see
// migrations/) through wrangler: the live database, or the local copy that
// wrangler dev keeps (in .wrangler/state). One
// wrangler call takes about a second however many questions it carries, so
// they go together, and one at a time: two at once on the dev copy trip over
// each other ("internal error; reference = ...").
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB = 'harbourmaster-log';
const ACCOUNT = '5b599c00c72a707712ba9f65977a2acd'; // the personal account, as deploy.sh
const PROFILE = join(homedir(), '.config', 'cf-personal'); // its wrangler login, when there is one
const TIMEOUT = 90 * 1000; // ms a wrangler call may take before it is given up on
// what is worth a second go: the dev copy busy, the network, the API having a moment
const PASSING =
  /internal error|SQLITE_BUSY|database is locked|fetch failed|network|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|overloaded|\b50[234]\b/i;

// In front of every question, for the stretch of time since `since` (ms
// since epoch): d, the days of games sent; v, the visits, each with whether
// it started a game (started), did anything in it (played) and was a bot;
// and g, the games, each with its seed, the furthest day it got to (far),
// when it was first and last seen, and on how many visits.
export const ctes = (since) => {
  const t = Math.max(0, Math.floor(+since || 0));
  return (
    `d AS (SELECT * FROM days WHERE created_at >= ${t}), ` +
    `v AS (SELECT *, game IS NOT NULL AS started, actions > 0 AS played, device LIKE 'bot ·%' AS bot FROM visits WHERE created_at >= ${t}), ` +
    `g AS (SELECT game, MAX(seed) AS seed, MAX(day) AS far, MIN(created_at) AS first, MAX(created_at) AS last, ` +
    `SUM(visit) AS visits FROM (SELECT game, seed, day, created_at, 0 AS visit FROM d UNION ALL ` +
    `SELECT game, seed, day, created_at, 1 FROM v WHERE game IS NOT NULL AND NOT bot) GROUP BY game)`
  );
};
export const within = (sql, since) => `WITH ${ctes(since)} ${sql}`;

let queue = Promise.resolve();
function wrangler(statements, local) {
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT };
  if (!env.XDG_CONFIG_HOME && existsSync(PROFILE)) env.XDG_CONFIG_HOME = PROFILE;
  const args = [
    'd1',
    'execute',
    DB,
    local ? '--local' : '--remote',
    '--json',
    '--command',
    statements.map((s) => s.trim().replace(/;\s*$/, '')).join(';\n'),
  ];
  return new Promise((resolve, reject) => {
    execFile(
      'wrangler',
      args,
      { cwd: ROOT, env, maxBuffer: 64 * 1024 * 1024, timeout: TIMEOUT },
      (err, stdout, stderr) => {
        let out = null;
        try {
          out = JSON.parse(stdout);
        } catch {}
        if (Array.isArray(out)) return resolve(out.map((r) => r.results || []));
        if (err && err.killed)
          return reject(new Error(`wrangler took more than ${TIMEOUT / 1000} s and was stopped`));
        // the live database says only "A request to the Cloudflare API (...) failed.", and why in its notes
        const e = out && out.error,
          notes = e && Array.isArray(e.notes) ? e.notes.map((n) => n.text).filter(Boolean) : [];
        if (notes.length) return reject(new Error(notes.join('; ')));
        const msg = (e && (e.text || e.message)) || (stderr || stdout || String(err)).trim();
        reject(
          new Error(
            msg.split('\n').find((l) => /error|no such|unknown|not/i.test(l)) ||
              msg.split('\n')[0] ||
              'wrangler failed',
          ),
        );
      },
    );
  });
}

// Several statements at once: an array of row lists, one per statement.
// Calls wait their turn, and one that fails in passing gets a second go.
export function d1(statements, { local = false } = {}) {
  const go = () =>
    wrangler(statements, local).catch((e) => {
      if (!PASSING.test(e.message)) throw e;
      return new Promise((r) => setTimeout(r, 400)).then(() => wrangler(statements, local));
    });
  const run = queue.then(go, go);
  queue = run.catch(() => {});
  return run;
}

// What tables and columns the database has, as 'table' and 'table.column'.
async function schema(local) {
  const [rows] = await d1(
    [
      `SELECT m.name AS t, c.name AS c FROM sqlite_master m, pragma_table_info(m.name) c
                            WHERE m.type = 'table' AND substr(m.name, 1, 4) <> '_cf_'`,
    ],
    { local },
  ); // D1's own tables are not to be read
  return new Set(rows.flatMap((r) => [r.t, `${r.t}.${r.c}`]));
}

// Every section's answer, keyed by its id. A section `needs` the tables and
// columns it reads that came with a later migration: when the database
// hasn't got one yet (the live one before a deploy), that section answers
// nothing and is named in `missing`, and the others are asked again without it.
// raw sections are asked as they are, without p and v in front.
export async function ask(sections, { local, since, raw = false }) {
  const sql = (s) => (raw ? s.sql : within(s.sql, since));
  let asked = sections,
    missing = [],
    rows;
  try {
    rows = await d1(asked.map(sql), { local });
  } catch (e) {
    if (!/no such (table|column)/i.test(e.message) || !sections.some((s) => s.needs)) throw e;
    const has = await schema(local);
    asked = sections.filter((s) => (s.needs || []).every((n) => has.has(n)));
    missing = sections.filter((s) => !asked.includes(s)).map((s) => s.id);
    rows = asked.length ? await d1(asked.map(sql), { local }) : [];
  }
  const answers = Object.fromEntries(sections.map((s) => [s.id, []]));
  asked.forEach((s, i) => {
    answers[s.id] = rows[i];
  });
  return { answers, missing };
}
