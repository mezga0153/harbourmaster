// stats.sh: the play log's answers, as plain tables in the terminal.
//   node stats/cli.mjs [--local] [section ...]     (see queries.mjs for the sections)
//   node stats/cli.mjs [--local] visits           (every section of the visitors)
//   node stats/cli.mjs [--local] sql "SELECT ..."
import { SECTIONS } from './queries.mjs';
import { ask, d1 } from './db.mjs';

const args = process.argv.slice(2),
  local = args[0] === '--local';
if (local) args.shift();

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
  } else {
    const want = (s) => args.includes(s.id) || (args.includes('visits') && s.tab === 'visitors');
    const pick = args.length ? SECTIONS.filter(want) : SECTIONS.filter((s) => !s.page);
    const known = new Set([...SECTIONS.map((s) => s.id), 'visits']);
    if (args.some((a) => !known.has(a)))
      throw new Error(`unknown section; there are: visits ${SECTIONS.map((s) => s.id).join(' ')}`);
    const { answers, missing } = await ask(pick, { local, since: 0 });
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
