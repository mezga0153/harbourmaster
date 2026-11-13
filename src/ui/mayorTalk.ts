import { effect, signal } from '@preact/signals';
import type { Snapshot } from '../protocol';
import { TICKS_PER_DAY } from '../sim/types';
import type { GuideAction, GuideId } from './guides';
import { gameplay } from './prefs';
import { snapshot } from './store';

// The town's mayor, a rosy old soul in a top hat and a great moustache (TownMayor.tsx), who tells the player
// what the town wants next and, now and then, how the port is getting on
// with it. Worked out on the page from the snapshot's town: what the mayor
// last saw (`Watch`) against what is there now. Nothing of it is saved; a
// game carried on gets a "welcome back".

type TownView = NonNullable<Snapshot['town']>;

/** How the mayor looks saying it: the portrait's face. */
export type Mood = 'cheer' | 'hope' | 'worry' | 'ponder' | 'proud';

export interface MayorLine {
  id: number;
  mood: Mood;
  text: string;
  /** The game's tick it was said at. */
  tick: number;
  /** Where the button under it goes: the town panel, or the port panel to upgrade. */
  action?: 'town' | 'port';
  /** Stays open till put away; a passing update closes by itself after a while. */
  keep?: boolean;
  /** Where to learn how to do what the mayor asks: a lesson (at a step), or the offer to sign. */
  help?: Help;
}

export type Help = { guide: GuideId; step?: number } | { action: GuideAction };

/**
 * How to do what each landmark wants: the lesson that shows it, or, where
 * no lesson does (ice and lobster are an offer to sign and the usual
 * pickups), the offer itself.
 */
export const HELP: Record<string, Help> = {
  // "Follow the first pickup": fish trucked out.
  'Fish market': { guide: 'start', step: 2 },
  'Ice house': { action: { label: 'Show the ice offer', offers: 'shipper', cargo: 'ice' } },
  'Seafood restaurant': {
    action: { label: 'Show the lobster offer', offers: 'fishery', cargo: 'lobster' },
  },
  Cannery: { guide: 'wharf' },
  "Builders' yard": { guide: 'exports' },
  School: { guide: 'wharf' },
  'Town hall': { guide: 'wharf' },
  Hospital: { guide: 'harbour' },
  'Technical college': { guide: 'harbour' },
  'Railway station': { guide: 'harbour' },
};

export type Said = Omit<MayorLine, 'id'>;

/** What the mayor last saw of the town, to tell what has changed. */
export interface Watch {
  /** The landmark wanted next, `wait:<tier>` while its goal waits on the port, or '' with all open. */
  goal: string;
  /** What that landmark opens, for when it does. */
  opens: string;
  opened: number;
  have: number;
  /** Days running met, for a goal kept up for days. */
  days: number;
  /** Of a total: 1 once past half way told, 2 once nearly there. */
  mark: number;
  /** When the mayor last gave a passing update, and how far the goal was then. */
  lastTalk: number;
  lastHave: number;
  /** The town has been told it is full, till it is not. */
  full: boolean;
}

/** About a day between passing updates. */
export const UPDATE_TICKS = TICKS_PER_DAY;

/** Why each landmark is wanted, in the mayor's words; the goal follows. */
const WHY: Record<string, string> = {
  'Fish market':
    'Our fishmongers are selling herring off upturned barrels, and the gulls are winning. A proper fish market would set things right!',
  'Ice house':
    'The fish market is a triumph, but by noon the cod look rather tired. We need ice, and somewhere to keep it.',
  'Seafood restaurant':
    'A chef has arrived with a very tall hat and a very short temper. Only lobster will do, apparently.',
  Cannery:
    'There is more fish in this town than anyone can eat, and I have tried. A cannery would put the rest in tins.',
  "Builders' yard":
    'Our tins of fish long to see the world! Ship them out and the builders will set up shop.',
  School:
    'Children everywhere, and nowhere to put them. The builders need timber for a schoolhouse.',
  'Town hall':
    'The council meets in the back of the bakery. It is warm, but the minutes are covered in flour. Goods would build us a town hall.',
  Hospital:
    'The doctor has been seeing patients in the lighthouse. Lovely views, dreadful stairs. The factory needs its containers moving before we can afford a hospital.',
  'Technical college':
    'Young folk keep asking how the cranes work, and I keep making things up. A technical college, please!',
  'Railway station':
    'The railway company has noticed us at last. Show them a busy port and they will build a station.',
};

const CHEERS = [
  'Splendid! ',
  'Hats off to you! ',
  'Marvellous! ',
  'Oh, well done! ',
  'Three cheers! ',
];

const OPENED = [
  'Ribbon cut, speeches made, and only one gull ran off with the scissors.',
  'The brass band played all afternoon. Mostly in tune.',
  'Half the town turned out, and the other half sent cake.',
  'I made a speech. It was short, I promise.',
];

const STALLED = [
  'Nothing new towards it since yesterday, I am afraid. The council is starting to fidget.',
  'Not much has moved towards it lately. Is something stuck down at the port?',
  'Quiet day for it. I have polished my chain twice.',
];

const FULL = [
  'Every bed in town is taken: folk are sleeping in the net lofts! The town cannot grow till the next landmark opens.',
  'No room at the inn, nor anywhere else. We need the next landmark before anyone else can move in.',
];

/** A stable pick from `list`, by something that changes from one line to the next. */
const pick = (list: string[], n: number) => list[Math.abs(Math.floor(n)) % list.length];

const count = (n: number) => Math.round(n).toLocaleString('en-US');

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The goal's key in a Watch. */
function goalKey(t: TownView): string {
  if (!t.next) return '';
  return t.next.waiting ? `wait:${t.next.waiting}` : t.next.name;
}

/** What the town wants next, said as the mayor would on first asking. */
function ask(t: TownView, tick: number, hello?: string): Said {
  const n = t.next;
  const start = hello ? `${hello} ` : '';
  if (!n) {
    return {
      mood: 'proud',
      tick,
      keep: true,
      action: 'town',
      text: `${start}Every landmark I ever dreamt of stands in ${t.name}. I have run out of ribbons to cut. Carry on as you are!`,
    };
  }
  if (n.waiting) {
    return {
      mood: 'ponder',
      tick,
      keep: true,
      action: 'port',
      text: `${start}The council has grand plans for a ${lower(n.name)}, but the harbour authority will not hear of it till the port is a ${n.waiting}. Upgrade it in the Port panel when ${t.name} is big enough.`,
    };
  }
  const why = WHY[n.name] ?? `${t.name} would dearly love a ${lower(n.name)}.`;
  return {
    mood: 'hope',
    tick,
    keep: true,
    action: 'town',
    text: `${start}${why} ${n.aim}, and it is yours.`,
  };
}

/** Of a total: 2 nearly there, 1 past half way, else 0; none for days running. */
function markOf(n: TownView['next']): number {
  if (!n || n.days || n.waiting || n.need <= 0) return 0;
  const part = n.have / n.need;
  return part >= 0.8 ? 2 : part >= 0.5 ? 1 : 0;
}

/** How far the goal has got, in words. */
function progress(n: NonNullable<TownView['next']>): string {
  if (n.days) {
    return `${count(Math.min(n.have, n.need))} of ${count(n.need)} crates today, ${n.days.done} of ${n.days.need} days kept up so far`;
  }
  return `${count(Math.min(n.have, n.need))} of ${count(n.need)} so far`;
}

/**
 * What the mayor says, if anything, seeing the town as it is now, and what
 * the mayor has seen after. `w` null is the first look at this game.
 */
export function mayorStep(
  w: Watch | null,
  t: TownView,
  tick: number,
): { watch: Watch; say: Said[] } {
  const n = t.next;
  const goal = goalKey(t);
  const now: Watch = {
    goal,
    opens: n?.opens ?? '',
    opened: t.opened.length,
    have: n?.have ?? 0,
    days: n?.days?.done ?? 0,
    mark: w && w.goal === goal ? w.mark : markOf(n),
    lastTalk: w?.lastTalk ?? tick,
    lastHave: w && w.goal === goal ? w.lastHave : (n?.have ?? 0),
    full: w?.full ?? false,
  };
  const say: Said[] = [];
  const help = n && !n.waiting ? HELP[n.name] : undefined;
  const done = (): { watch: Watch; say: Said[] } => ({
    watch: now,
    say: help ? say.map((l) => (l.mood === 'proud' ? l : { ...l, help })) : say,
  });
  const talked = () => {
    now.lastTalk = tick;
    now.lastHave = now.have;
  };

  if (!w) {
    // A game just begun, or carried on.
    const hello =
      tick < TICKS_PER_DAY / 4
        ? `Welcome to ${t.name}, harbourmaster! I am Mayor Bramblewick, and this town has plans.`
        : 'Welcome back, harbourmaster!';
    say.push(ask(t, tick, hello));
    talked();
    return done();
  }

  if (now.opened > w.opened) {
    const name = t.opened[t.opened.length - 1];
    say.push({
      mood: 'proud',
      tick,
      keep: true,
      action: 'town',
      text: `${pick(CHEERS, tick)}The ${lower(name)} is open! ${pick(OPENED, now.opened)}${w.opens ? ` ${w.opens}.` : ''}`,
    });
    say.push(ask(t, tick));
    talked();
    return done();
  }

  if (goal !== w.goal) {
    // The port's upgrade came, and the goal counts now; or the other way round.
    say.push(ask(t, tick, n && !n.waiting && w.goal.startsWith('wait:') ? 'At last!' : undefined));
    talked();
    return done();
  }

  // The town at its cap, once till it grows again.
  const full = t.cap !== null && t.population >= t.cap;
  if (full && !w.full && n) {
    now.full = true;
    say.push({ mood: 'worry', tick, action: 'town', text: pick(FULL, tick) });
  }
  if (!full) now.full = false;

  if (!n || n.waiting) {
    if (tick - w.lastTalk >= UPDATE_TICKS * 2 && n?.waiting) {
      say.push({
        mood: 'ponder',
        tick,
        action: 'port',
        text: `Still waiting on the harbour authority, harbourmaster. Once the port is a ${n.waiting}, the ${lower(n.name)} can begin.`,
      });
      talked();
    }
    return done();
  }

  if (n.days) {
    if (now.days > w.days) {
      const left = n.days.need - now.days;
      say.push({
        mood: 'cheer',
        tick,
        action: 'town',
        text:
          left > 0
            ? `${pick(CHEERS, tick)}Another good day: ${now.days} of ${n.days.need} kept up. ${left === 1 ? 'Just one more like it!' : `${left} more like it, please.`}`
            : `${pick(CHEERS, tick)}That is every day kept up!`,
      });
      talked();
      return done();
    }
    if (now.days < w.days) {
      say.push({
        mood: 'worry',
        tick,
        action: 'town',
        text: `Oh dear: yesterday fell short, and the count of days starts over. ${n.aim}, without a gap.${n.hint ? ` ${n.hint}.` : ''}`,
      });
      talked();
      return done();
    }
  } else if (n.need > 0) {
    const mark = markOf(n);
    if (mark > now.mark && now.have < n.need) {
      now.mark = mark;
      say.push({
        mood: 'cheer',
        tick,
        action: 'town',
        text:
          mark === 2
            ? `Nearly there! ${progress(n)}. I have ordered the bunting.`
            : `Half way to the ${lower(n.name)}! ${progress(n)}.`,
      });
      talked();
      return done();
    }
  }

  // Now and then, how it is going.
  if (tick - w.lastTalk >= UPDATE_TICKS && say.length === 0) {
    if (n.hint) {
      say.push({
        mood: 'worry',
        tick,
        action: 'town',
        text: `About the ${lower(n.name)}: ${progress(n)}. The trouble is, ${lower(n.hint)}.`,
      });
    } else if (now.have <= w.lastHave && !n.days) {
      say.push({
        mood: 'ponder',
        tick,
        action: 'town',
        text: `${pick(STALLED, tick)} ${progress(n)}.`,
      });
    } else {
      say.push({
        mood: 'hope',
        tick,
        action: 'town',
        text: `A little word on the ${lower(n.name)}: ${progress(n)}. Keep it coming!`,
      });
    }
    talked();
  }
  return done();
}

// The mayor in the running game.

/** Lines said this visit, oldest first, at most HISTORY. */
export const mayorLines = signal<MayorLine[]>([]);
/** The line showing, by its index in mayorLines. */
export const mayorAt = signal(0);
/** The mayor's card is open, rather than only the portrait. */
export const mayorOpen = signal(false);
/** Lines said since the card was last looked at. */
export const mayorUnread = signal(0);

const HISTORY = 12;
let watch: Watch | null = null;
let seen: { seed: number; tick: number } | null = null;
let nextId = 1;

/** Open the card on the first of `fresh` new lines, or count them unread. */
function heard(fresh: MayorLine[], pop: boolean): void {
  const all = [...mayorLines.peek(), ...fresh];
  const drop = Math.max(0, all.length - HISTORY);
  mayorLines.value = all.slice(drop);
  const first = mayorLines.peek().length - fresh.length;
  if (pop) {
    mayorAt.value = first;
    mayorOpen.value = true;
    mayorUnread.value = 0;
  } else {
    if (!mayorOpen.peek()) mayorUnread.value += fresh.length;
    else mayorAt.value = first;
  }
}

/** Watch the snapshot from now on; call once, from main.ts. */
export function startMayor(): () => void {
  return effect(() => {
    const s = snapshot.value;
    const t = s?.town;
    if (!s || !t) return;
    // A new game, or one loaded: start afresh.
    if (seen && (seen.seed !== s.seed || s.tick < seen.tick)) {
      watch = null;
      mayorLines.value = [];
      mayorAt.value = 0;
      mayorUnread.value = 0;
    }
    seen = { seed: s.seed, tick: s.tick };
    const first = watch === null;
    const out = mayorStep(watch, t, s.tick);
    watch = out.watch;
    if (out.say.length === 0) return;
    const fresh = out.say.map((l) => ({ ...l, id: nextId++ }));
    // Pops up for news, unless the player keeps the mayor quiet; a game
    // carried on only shows the portrait with a line waiting.
    const pop = gameplay.peek().mayor && (!first || s.tick < TICKS_PER_DAY / 4);
    heard(fresh, pop);
  });
}
