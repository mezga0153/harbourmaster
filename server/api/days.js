// The days of players' games, at /api/days: one row per day of a game, sent
// by src/log/days.ts (see migrations/0001_log.sql for each field).
//   POST { days: [ { game, visit?, version?, seed, day, done, tier, cash, loan, income, spend, ledger,
//                    inRed, bankrupt, earned, crates, containers, boats, trucks, exported,
//                    penalties, staff, machines, contracts, canUp, townPop?, townStage?, town?,
//                    size, plots?, port, capacity, problems, bad, actions, tips, seconds, paused, fast, fps? } ] }  -> 204
// A day under way (done false: the page put away) is replaced when it is sent
// again, finished or not; a finished day is never replaced by one under way.

import { counts, id, int, json, num, numbers, object, version } from '../check.js';

const MAX_BODY = 32 * 1024; // bytes
const MAX_DAYS = 10; // rows a request
const MONEY = 1e13;

export const COLUMNS = [
  'game',
  'visit',
  'version',
  'seed',
  'day',
  'done',
  'tier',
  'cash',
  'loan',
  'income',
  'spend',
  'ledger',
  'in_red',
  'bankrupt',
  'earned',
  'crates',
  'containers',
  'boats',
  'trucks',
  'exported',
  'penalties',
  'staff',
  'machines',
  'contracts',
  'can_up',
  'town_pop',
  'town_stage',
  'town',
  'size',
  'plots',
  'port',
  'capacity',
  'problems',
  'bad',
  'actions',
  'tips',
  'seconds',
  'paused',
  'fast',
  'fps',
  'created_at',
];

/** A row ready to insert, in COLUMNS' order, or null if anything about it is off. */
export function row(d, now) {
  if (!object(d) || !id(d.game) || (d.visit != null && !id(d.visit))) return null;
  if (d.version != null && !version(d.version)) return null;
  if (
    !int(d.seed, 0, 1e9) ||
    !int(d.day, 1, 1e6) ||
    typeof d.done !== 'boolean' ||
    !int(d.tier, 0, 50)
  )
    return null;
  if (
    !int(d.cash, -MONEY, MONEY) ||
    !int(d.loan, 0, MONEY) ||
    !int(d.income, 0, MONEY) ||
    !int(d.spend, 0, MONEY)
  )
    return null;
  if (!int(d.inRed, 0, 1e6) || typeof d.bankrupt !== 'boolean') return null;
  for (const k of ['earned', 'penalties']) if (!int(d[k], -MONEY, MONEY)) return null;
  for (const k of ['crates', 'containers', 'boats', 'trucks', 'exported', 'staff', 'contracts'])
    if (!int(d[k], 0, 1e9)) return null;
  if (d.townPop != null && !int(d.townPop, 0, 1e7)) return null;
  if (d.townStage != null && !int(d.townStage, 0, 50)) return null;
  if (typeof d.canUp !== 'boolean' || !int(d.size, 0, 1e7)) return null;
  if (d.plots != null && !int(d.plots, 0, 1e5)) return null;
  const json = {
    ledger: numbers(d.ledger),
    machines: counts(d.machines, 10, 20),
    capacity: numbers(d.capacity),
    problems: counts(d.problems),
    bad: counts(d.bad),
    actions: counts(d.actions, 120, 60),
    town: numbers(d.town),
    port: counts(d.port, 60, 30),
  };
  if (Object.values(json).some((v) => v === undefined)) return null;
  if (
    !Array.isArray(d.tips) ||
    d.tips.length > 40 ||
    !d.tips.every((t) => typeof t === 'string' && /^[\w-]{1,40}$/.test(t))
  )
    return null;
  if (!num(d.seconds, 0, 7 * 86400) || !num(d.paused, 0, 7 * 86400) || !num(d.fast, 0, 7 * 86400))
    return null;
  if (d.fps != null && !num(d.fps, 0, 1000)) return null;
  const tenth = (v) => Math.round(v * 10) / 10;
  const r = {
    game: d.game,
    visit: d.visit ?? null,
    version: d.version ?? null,
    seed: d.seed,
    day: d.day,
    done: d.done ? 1 : 0,
    tier: d.tier,
    cash: d.cash,
    loan: d.loan,
    income: d.income,
    spend: d.spend,
    ledger: json.ledger,
    in_red: d.inRed,
    bankrupt: d.bankrupt ? 1 : 0,
    earned: d.earned,
    crates: d.crates,
    containers: d.containers,
    boats: d.boats,
    trucks: d.trucks,
    exported: d.exported,
    penalties: d.penalties,
    staff: d.staff,
    machines: json.machines,
    contracts: d.contracts,
    can_up: d.canUp ? 1 : 0,
    town_pop: d.townPop ?? null,
    town_stage: d.townStage ?? null,
    town: json.town,
    size: d.size,
    plots: d.plots ?? null,
    port: json.port,
    capacity: json.capacity,
    problems: json.problems,
    bad: json.bad,
    actions: json.actions,
    tips: JSON.stringify(d.tips),
    seconds: tenth(d.seconds),
    paused: tenth(d.paused),
    fast: tenth(d.fast),
    fps: d.fps == null ? null : tenth(d.fps),
    created_at: now,
  };
  return COLUMNS.map((c) => r[c]);
}

export async function take(request, env) {
  const got = await json(request, MAX_BODY);
  if (got instanceof Response) return got;
  const list = got.body && Array.isArray(got.body.days) ? got.body.days : null;
  if (!list || !list.length || list.length > MAX_DAYS)
    return new Response(`expected 1 to ${MAX_DAYS} days`, { status: 400 });
  const now = Date.now();
  const rows = list.map((d) => row(d, now));
  if (rows.some((r) => !r)) return new Response('malformed day', { status: 400 });
  const kept = COLUMNS.filter((c) => c !== 'game' && c !== 'day');
  const insert = env.DB.prepare(
    `INSERT INTO days (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')}) ` +
      `ON CONFLICT (game, day) DO UPDATE SET ${kept.map((c) => `${c} = excluded.${c}`).join(', ')} ` +
      'WHERE excluded.done >= days.done',
  );
  await env.DB.batch(rows.map((r) => insert.bind(...r)));
  return new Response(null, { status: 204 });
}
