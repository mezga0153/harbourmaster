// stats.sh: the play log's answers, as plain tables in the terminal.
//   node stats/cli.mjs [--local] [section ...]     (see queries.mjs for the sections)
//   node stats/cli.mjs [--local] visits           (every section of the visitors)
//   node stats/cli.mjs [--local] sql "SELECT ..."
//   node stats/cli.mjs [--local] feedback          what players have told us
//   node stats/cli.mjs [--local] feedback-game 12  report 12's game, to .debug/feedback-12.json
//   node stats/cli.mjs [--local] feedback-mark 12 done ["a note"]
//   --version '2026-10-31 00:51 3b839e2' anywhere: only that version of the game
import { SECTIONS } from './queries.mjs';
import { ask, d1 } from './db.mjs';
import * as feedback from './feedback.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2),
  local = args[0] === '--local';
if (local) args.shift();
const at = args.indexOf('--version');
const version = at >= 0 ? args.splice(at, 2)[1] : null;

function table(title, rows) {
  console.log(`\n== ${title}`);
  if (!rows.length) {
    console.log('(nothing yet)');
    return;
  }
  const keys = Object.keys(rows[0]),
    cell = (v) => (v == null ? '-' : String(v));
  const w = keys.map((k) => Math.max(k.length, ...rows.map((r) => cell(r[k]).length)));
  const num = keys.map((k) => rows.every((r) => r[k] == null || typeof r[k] === 'number'));
  const line = (vals) =>
    vals.map((v, i) => (num[i] ? v.padStart(w[i]) : v.padEnd(w[i]))).join('  ');
  console.log(line(keys));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(keys.map((k) => cell(r[k]))));
}

try {
  if (args[0] === 'sql') {
    const [rows] = await d1([args[1] || ''], { local });
    table('your query', rows);
  } else if (args[0] === 'feedback') {
    const rows = await feedback.list(local);
    console.log(`\n== What players have told us (${rows.length}, the new ones first)`);
    for (const r of rows) {
      const when = new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
      const with_ = [r.has_game && 'game', r.has_picture && 'picture'].filter(Boolean).join(', ');
      console.log(
        `\n#${r.id} ${r.kind.toUpperCase()} [${r.status}] ${when} · ${r.version ?? '?'} · day ${r.day ?? '?'}` +
          ` · ${[r.device, r.city, r.country].filter(Boolean).join(', ') || '?'}` +
          (r.contact ? ` · ${r.contact}` : '') +
          (with_ ? ` · with ${with_}` : ''),
      );
      console.log('  ' + r.text.replace(/\n/g, '\n  '));
      if (r.note) console.log(`  (note: ${r.note})`);
    }
  } else if (args[0] === 'feedback-game') {
    const save = await feedback.game(local, args[1]);
    if (!save) throw new Error(`report ${args[1]} came without its game`);
    mkdirSync('.debug', { recursive: true });
    const file = `.debug/feedback-${Number(args[1])}.json`;
    writeFileSync(file, save);
    console.log(`${file}: load it into the open dev game with`);
    console.log(`  curl -X POST --data-binary @${file} localhost:5199/__debug/load`);
  } else if (args[0] === 'feedback-mark') {
    await feedback.mark(local, args[1], args[2], args[3]);
    console.log(`report ${args[1]}: ${args[2]}`);
  } else {
    const want = (s) => args.includes(s.id) || (args.includes('visits') && s.tab === 'visitors');
    const pick = args.length ? SECTIONS.filter(want) : SECTIONS.filter((s) => !s.page);
    const known = new Set([...SECTIONS.map((s) => s.id), 'visits']);
    if (args.some((a) => !known.has(a)))
      throw new Error(`unknown section; there are: visits ${SECTIONS.map((s) => s.id).join(' ')}`);
    const { answers, missing } = await ask(pick, { local, since: 0, version });
    for (const s of pick) {
      if (missing.includes(s.id))
        console.log(
          `\n== ${s.title}\n(not in this database yet: it needs ${s.needs.join(', ')}, from a migration still to be applied)`,
        );
      else table(s.title, answers[s.id]);
    }
  }
} catch (e) {
  console.error(`stats: ${e.message}`);
  process.exit(1);
}
