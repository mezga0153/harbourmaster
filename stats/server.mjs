// The stats page, at http://127.0.0.1:8798 on this machine only. It asks the
// play log the questions in queries.mjs, of the live database or the local
// copy, and index.html draws the answers.
//   node stats/server.mjs [--local] [--no-open] [--port 8798]     (./stats.sh gui does this)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTIONS, gameSections } from './queries.mjs';
import { ask, ctes, d1, within } from './db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const PORT = Number(args[args.indexOf('--port') + 1]) || 8798;
const FIRST_DB = flag('--local') ? 'local' : 'live';
const CACHE_MS = 60 * 1000; // wrangler takes a second a call: answers are kept this long
const cache = new Map();

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

// Every section of a tab at once (the games', or the visitors'), for a
// stretch of time, from one database.
async function everything(db, since, fresh, tab) {
  const key = `${db}|${since}|${tab}`,
    hit = cache.get(key);
  if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit.data;
  const sections = SECTIONS.filter((s) => (s.tab || 'play') === tab);
  const t0 = Date.now(),
    { answers, missing } = await ask(sections, { local: db === 'local', since });
  const data = {
    db,
    since,
    tab,
    at: Date.now(),
    took: Date.now() - t0,
    answers,
    missing,
    titles: Object.fromEntries(sections.map((s) => [s.id, s.title])),
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// Your own question: one statement, only reading, with d, v and g there as in the sections.
function readOnly(sql) {
  const s = sql.trim().replace(/;\s*$/, ''),
    bare = s.replace(/'([^']|'')*'/g, "''");
  if (!/^(select|with)\b/i.test(s)) return 'only SELECT questions (WITH ... SELECT too)';
  if (bare.includes(';')) return 'one statement at a time';
  if (
    /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex)\b/i.test(
      bare,
    )
  )
    return 'this page only reads: nothing that changes the data';
  return null;
}
const yours = (sql, since) => {
  const s = sql.trim().replace(/;\s*$/, '');
  return /^with\b/i.test(s) ? s.replace(/^with\b/i, `WITH ${ctes(since)},`) : within(s, since);
};

const body = (req) =>
  new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => {
      s += d;
      if (s.length > 1e5) req.destroy();
    });
    req.on('end', () => resolve(s));
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'),
    db = url.searchParams.get('db') === 'local' ? 'local' : 'live';
  const since = Number(url.searchParams.get('since')) || 0;
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(
        res,
        200,
        (await readFile(join(HERE, 'index.html'), 'utf8')).replace('__FIRST_DB__', FIRST_DB),
        'text/html; charset=utf-8',
      );
    }
    if (req.method === 'GET' && url.pathname === '/api/all') {
      const tab = url.searchParams.get('tab') === 'visitors' ? 'visitors' : 'play';
      return send(res, 200, await everything(db, since, url.searchParams.has('fresh'), tab));
    }
    if (req.method === 'GET' && url.pathname === '/api/game') {
      const id = url.searchParams.get('id') || '';
      if (!/^[a-z0-9]{8,32}$/.test(id)) return send(res, 400, { error: 'not a game id' });
      const { answers, missing } = await ask(gameSections(id), {
        local: db === 'local',
        raw: true,
      });
      return send(res, 200, { ...answers, missing });
    }
    if (req.method === 'POST' && url.pathname === '/api/sql') {
      let sql = '';
      try {
        sql = JSON.parse(await body(req)).sql || '';
      } catch {}
      const no = readOnly(sql);
      if (no) return send(res, 400, { error: no });
      const [rows] = await d1([yours(sql, since)], { local: db === 'local' });
      return send(res, 200, { rows });
    }
    send(res, 404, { error: 'not here' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const at = `http://127.0.0.1:${PORT}`;
  console.log(`stats page: ${at}   (${FIRST_DB} database first; Ctrl-C to stop)`);
  if (!flag('--no-open'))
    execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [at], () => {});
});
