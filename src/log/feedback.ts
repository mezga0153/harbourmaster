import type { Snapshot } from '../protocol';
import type { SaveData } from '../sim/world';
import { TICKS_PER_DAY } from '../sim/types';
import { VERSION, visitId } from './common';
import { playing } from './days';
import { recentErrors } from './errors';

// What a player tells us from the feedback panel (src/ui/Feedback.tsx), sent
// to /api/feedback: a bug, an idea or anything else, with what the game was
// doing (the version, the day, the port's figures, the window and settings,
// the last messages and errors), and if they let it their game, zipped, and a
// picture of the view. Sent whether or not the play log is on: the player
// asked for it.

const URL_ = '/api/feedback';

export type FeedbackKind = 'bug' | 'idea' | 'other';

/** Where the game and the picture come from, set by main.ts. */
let hooks: { save: () => Promise<SaveData>; picture: () => string | null } = {
  save: () => Promise.reject(new Error('no game')),
  picture: () => null,
};
export function setReportHooks(h: typeof hooks): void {
  hooks = h;
}

/** Gzipped, in base64. */
export async function zip(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export interface Report {
  kind: FeedbackKind;
  text: string;
  contact: string;
  withGame: boolean;
  withPicture: boolean;
}

/** What goes with the words: the game as it was, for whoever reads it. */
export function context(
  s: Snapshot | null,
  extra: { messages: string[]; selected: string | null; settings: Record<string, unknown> },
): Record<string, unknown> {
  return {
    seed: s?.seed ?? null,
    day: s ? Math.floor(s.tick / TICKS_PER_DAY) + 1 : null,
    tier: s?.progress.tier ?? null,
    cash: s ? Math.round(s.cash) : null,
    speed: s?.speed ?? null,
    town: s?.town?.population ?? null,
    problems: s ? s.problems.map((p) => p.text).slice(0, 10) : [],
    window: `${innerWidth}x${innerHeight}@${devicePixelRatio || 1}`,
    page: (location.pathname + location.search).slice(0, 200),
    messages: extra.messages.slice(-8),
    errors: recentErrors(),
    selected: extra.selected,
    settings: extra.settings,
  };
}

/** Off it goes; true if the server took it. */
export async function sendFeedback(r: Report, ctx: Record<string, unknown>): Promise<boolean> {
  const { game, day } = playing();
  const body: Record<string, unknown> = {
    kind: r.kind,
    text: r.text.slice(0, 5000),
    contact: r.contact.trim().slice(0, 200) || null,
    visit: visitId,
    game,
    day,
    version: VERSION,
    context: ctx,
  };
  if (r.withGame) {
    try {
      const text = JSON.stringify(await hooks.save());
      body.save = await zip(text);
      body.saveBytes = text.length;
    } catch {
      // Sent without it.
    }
  }
  if (r.withPicture) {
    try {
      body.picture = hooks.picture();
    } catch {
      // Sent without it.
    }
  }
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}
