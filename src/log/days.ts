import type { Command, SimEvent, Snapshot } from '../protocol';
import { ownedPlots } from '../sim/land';
import type { GameMap } from '../sim/map';
import { TICKS_PER_DAY } from '../sim/types';
import { gist, keep, LOG_ON, newId, post, recall, tally, VERSION, visitId } from './common';
import { setWhere } from './errors';
import { portSize, townNow } from './port';
import { visitAction, visitDay, visitGame } from './visit';

// Each day of a game is sent to /api/days as it ends: the port as it stands
// (money, the tier and whether the next could be bought, the town, the cargo
// and boats handled, how much is built and which features: port.ts, the plots of
// land it owns), what the player
// did that day (built, hired, signed, the screens looked at), the red marks
// on the map, the bad news, the advisor's tips, and how long it took in real
// time, paused, sped up or not, at how many frames a second. The day under way is sent
// too when the page is put away, and replaced once it ends. A game is a random
// id kept beside the autosave: the same seed carrying on from the day it was
// at is the same game, anything else a new one. The day's tallies are kept in
// the browser too, so a reload part-way through a day carries them on.

const URL_ = '/api/days';
const GAME_KEY = 'harbourmaster.log.game';
const DAY_KEY = 'harbourmaster.log.day';
/** Commands that are not the player doing something. A `debug` is the Shift+M cheat, kept so a day's money can be told apart. */
const NOT_ACTIONS = new Set(['learnt', 'dumpSave', 'loadSave']);

export interface Tallies {
  game: string;
  day: number;
  actions: Record<string, number>;
  bad: Record<string, number>;
  tips: string[];
  /** Real seconds with the page in view, and of them paused, and sped up. */
  seconds: number;
  paused: number;
  fast: number;
  /** Frames drawn in those seconds. */
  frames: number;
}

let game: string | null = null;
let day = 0;
let t: Tallies | null = null;
let starting = false; // a game sent from the worker, its first frame still to come
let games = 0;
let latest: Snapshot | null = null;
let map: GameMap | null = null;
let lastFrame = 0;
let frames = 0;

const dayOf = (tick: number) => Math.floor(tick / TICKS_PER_DAY) + 1;
export const fresh = (g: string, d: number): Tallies => ({
  game: g,
  day: d,
  actions: {},
  bad: {},
  tips: [],
  seconds: 0,
  paused: 0,
  fast: 0,
  frames: 0,
});

if (LOG_ON) {
  setWhere(playing);
  const count = () => {
    frames++;
    requestAnimationFrame(count);
  };
  requestAnimationFrame(count);
  addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      lastFrame = 0;
      frames = 0;
    } else if (latest && t) {
      keep(DAY_KEY, t);
      if (map) void post(URL_, { days: [dayRow(latest, map, false, t)] }, true);
    }
  });
}

/** The game being played and its day, as the log has them, if it has. */
export function playing(): { game: string | null; day: number | null } {
  return { game, day: day || null };
}

/** The worker has sent a game: a new one, a save loaded, or the autosave. */
export function logInit(): void {
  if (!LOG_ON) return;
  starting = true;
  games++;
}

/** The game the first frame shows: the one played here before, or a new one. */
function begin(s: Snapshot): void {
  const d = dayOf(s.tick);
  const was = recall<{ id: string; seed: number; day: number }>(GAME_KEY);
  game = was && was.seed === s.seed && d >= was.day ? was.id : newId();
  day = d;
  keep(GAME_KEY, { id: game, seed: s.seed, day });
  const kept = recall<Tallies>(DAY_KEY);
  t = kept && kept.game === game && kept.day === day ? kept : fresh(game, day);
  visitGame(game, s.seed, day, games > 1);
}

export function logFrame(s: Snapshot, events: SimEvent[], m: GameMap): void {
  if (!LOG_ON) return;
  map = m;
  try {
    if (starting) {
      starting = false;
      begin(s);
    }
    if (!game || !t) return;
    const d = dayOf(s.tick);
    if (d > day) {
      void post(URL_, { days: [dayRow(s, m, true, t)] });
      day = d;
      t = fresh(game, day);
      keep(GAME_KEY, { id: game, seed: s.seed, day });
      keep(DAY_KEY, t);
      visitDay(day);
    }
    const now = performance.now();
    if (!document.hidden && lastFrame) {
      const dt = Math.min(1, (now - lastFrame) / 1000);
      t.seconds += dt;
      if (s.speed === 0) t.paused += dt;
      else if (s.speed > 1) t.fast += dt;
      t.frames += frames;
    }
    frames = 0;
    lastFrame = now;
    for (const ev of events) {
      if (ev.kind === 'message' && ev.tone === 'bad') tally(t.bad, gist(ev.text, namesIn(s)));
      else if (ev.kind === 'tip' && !t.tips.includes(ev.id) && t.tips.length < 40)
        t.tips.push(ev.id);
    }
    latest = s;
  } catch {
    // The game goes on regardless.
  }
}

/** Something the player did: a command, as what kind of thing it is. */
export function logCommand(cmd: Command): void {
  if (!LOG_ON || !t || NOT_ACTIONS.has(cmd.type)) return;
  if (cmd.type === 'exportSave' && cmd.forReport) return;
  const what =
    cmd.type === 'build'
      ? `build:${cmd.kind}`
      : cmd.type === 'buyMachine'
        ? `buy:${cmd.kind}`
        : cmd.type === 'setSpeed'
          ? `speed:${cmd.speed}`
          : cmd.type;
  tally(t.actions, what, 120);
  visitAction();
}

/** A screen opened: the finance, the contracts, ... */
export function logPanel(panel: string | null): void {
  if (LOG_ON && t && panel) tally(t.actions, `open:${panel}`, 120);
}

/** The names in the port, to take out of messages. */
function namesIn(s: Snapshot): string[] {
  const names = new Set<string>();
  for (const p of s.people) names.add(p.name);
  for (const k of s.contracts) names.add((k.terms as { name?: string }).name ?? '');
  for (const e of s.entities) names.add(e.name);
  if (s.town) names.add(s.town.name);
  names.delete('');
  // The longest first, so a name inside another goes with it.
  return [...names].sort((a, b) => b.length - a.length);
}

const round = (v: number) => Math.round(v) || 0;

/**
 * The row for a day: ended (`done`, read at the start of the next) or under
 * way, with the day's tallies.
 */
export function dayRow(
  s: Snapshot,
  m: GameMap,
  done: boolean,
  tt: Tallies,
): Record<string, unknown> {
  const ledger = (done ? s.yesterday : null) ?? s.today;
  let income = 0;
  let spend = 0;
  for (const v of Object.values(ledger))
    if (v > 0) income += v;
    else spend -= v;
  const names = namesIn(s);
  const problems: Record<string, number> = {};
  for (const p of s.problems) tally(problems, gist(p.text, names));
  const machines: Record<string, number> = {};
  for (const p of s.people) if (p.kind !== 'dockhand') tally(machines, p.kind, 10);
  const c = s.capacity;
  const { size, port } = portSize(m, s);
  return {
    game: tt.game,
    visit: visitId,
    version: VERSION,
    seed: s.seed,
    day: tt.day,
    done,
    tier: s.progress.tier,
    cash: round(s.cash),
    loan: round(s.loan),
    income: round(income),
    spend: round(spend),
    ledger: Object.fromEntries(Object.entries(ledger).map(([k, v]) => [k, round(v)])),
    inRed: s.daysInRed,
    bankrupt: s.bankrupt,
    earned: round(s.stats.earned),
    crates: round(s.stats.cratesHandled),
    containers: round(s.stats.containers),
    boats: round(s.stats.boats),
    trucks: round(s.stats.trucks),
    exported: round(s.stats.exported ?? 0),
    penalties: round(s.stats.penalties),
    staff: s.people.filter((p) => p.kind === 'dockhand').length,
    machines,
    contracts: s.contracts.length,
    canUp: s.progress.canUpgrade,
    townPop: s.town ? round(s.town.population) : null,
    townStage: s.town?.stage ?? null,
    town: townNow(s),
    size,
    plots: ownedPlots(m),
    difficulty: s.difficulty,
    port,
    capacity: {
      demand: c.demand,
      unloading: c.unloading,
      trucking: c.trucking,
      congestion: Math.round(c.congestion * 100) / 100,
      boxDemand: c.boxes.demand,
      boxLifting: c.boxes.lifting,
      boxMoving: c.boxes.moving,
      boxTrucking: c.boxes.trucking,
    },
    problems,
    bad: tt.bad,
    actions: tt.actions,
    tips: tt.tips,
    seconds: Math.round(tt.seconds * 10) / 10,
    paused: Math.round(tt.paused * 10) / 10,
    fast: Math.round((tt.fast ?? 0) * 10) / 10,
    fps: tt.seconds > 5 ? Math.round((tt.frames / tt.seconds) * 10) / 10 : null,
  };
}
