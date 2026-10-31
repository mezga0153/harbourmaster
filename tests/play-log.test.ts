import { describe, expect, it } from 'vitest';
import { gist } from '../src/log/common';
import { zip } from '../src/log/feedback';
import { dayRow, fresh } from '../src/log/days';
import { TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import { COLUMNS, row as dayIn } from '../server/api/days.js';
import { row as errorIn } from '../server/api/errors.js';
import { row as feedbackIn } from '../server/api/feedback.js';
import { row as visitIn } from '../server/api/visits.js';
import { playDay } from './bot';

const NOWHERE = { device: null, ua: null, country: null, region: null, city: null };

describe('The play log', () => {
  it('sends days the server keeps, ended and under way', () => {
    const w = World.create(1);
    const t = fresh('abcdefgh1234', 1);
    for (let d = 1; d <= 6; d++) {
      for (let i = 0; i < TICKS_PER_DAY; i++) w.step();
      playDay(w);
    }
    t.day = 6;
    t.actions = { 'build:road': 12, 'open:finance': 1 };
    t.bad = { 'Not enough money': 2 };
    t.tips = ['jetty'];
    t.seconds = 80;
    t.frames = 4800;
    const s = w.snapshot();
    const done = dayRow(s, w.map, true, t);
    expect(done).toMatchObject({ game: 'abcdefgh1234', day: 6, done: true, fps: 60 });
    // The version it was played on, from vite.config.ts: the commit's time and hash.
    expect(done.version).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d [0-9a-f]{7,}$|^unknown$/);
    expect(done.staff).toBeGreaterThan(0);
    // How big the port is, what is in it, and the town.
    expect(done.size).toBeGreaterThan(0);
    // How much land it owns.
    expect(done.plots).toBe(w.map.plots.length);
    expect(done.port).toMatchObject({ jetty: expect.any(Number), docks: expect.any(Number) });
    expect(done.town).toMatchObject({ homes: expect.any(Number), target: expect.any(Number) });
    const kept = dayIn(done, 1);
    expect(kept).not.toBeNull();
    // Every column filled.
    expect(kept).toHaveLength(COLUMNS.length);
    expect(kept!.filter((v: unknown) => v === undefined)).toEqual([]);
    expect(dayIn(dayRow(s, w.map, false, { ...t, day: 7 }), 1)).not.toBeNull();
    // Turned away whole when anything is off.
    expect(dayIn({ ...done, cash: 'lots' }, 1)).toBeNull();
    expect(dayIn({ ...done, game: 'X' }, 1)).toBeNull();
    expect(dayIn({ ...done, plots: -1 }, 1)).toBeNull();
    // Kept with the day, and days sent before land was bought still taken.
    expect(kept![COLUMNS.indexOf('plots')]).toBe(done.plots);
    const { plots: _, ...older } = done;
    expect(dayIn(older, 1)![COLUMNS.indexOf('plots')]).toBeNull();
  });

  it('counts messages by kind, without names or numbers', () => {
    expect(gist('Ada Byron has quit. Morale was too low.', ['Ada Byron'])).toBe(
      '… has quit. Morale was too low.',
    );
    expect(gist('3 days until the bank closes the port.', [])).toBe(
      '# days until the bank closes the port.',
    );
    expect(gist('Repaid $1,200 of the loan', [])).toBe('Repaid # of the loan');
  });

  it('takes visits and errors as the game sends them', () => {
    const first = {
      visit: 'abcdefgh1234',
      version: '2026-10-31 00:51 3b839e2',
      page: '/?fbclid=xyz&nodebug',
      ref: 'https://www.reddit.com/r/games/comments/1?utm_source=x&id=2',
      lang: 'sl-SI',
      sw: 390,
      sh: 844,
      dpr: 3,
      touch: true,
      graphics: 'high/high/sharp',
      gpu: 'Apple GPU',
      game: null,
      seed: null,
      day0: null,
      day: null,
      actions: 0,
      newGames: 0,
      seconds: 0.4,
    };
    const v = visitIn(first, 1, NOWHERE);
    expect(v).not.toBeNull();
    expect(v!.slice(1, 5)).toEqual([
      '2026-10-31 00:51 3b839e2',
      '/?nodebug',
      'www.reddit.com/r/games/comments/1?utm_source=x',
      'www.reddit.com',
    ]);
    expect(
      visitIn({ ...first, game: 'abcdefgh1234', seed: 5, day0: 1, day: 3 }, 1, NOWHERE),
    ).not.toBeNull();
    expect(visitIn({ ...first, day: 0 }, 1, NOWHERE)).toBeNull();
    expect(visitIn({ ...first, version: 'x; DROP TABLE' }, 1, NOWHERE)).toBeNull();
    expect(errorIn({ kind: 'sim', message: 'boom', stack: 'at step', day: 4 }, 1)).not.toBeNull();
    expect(errorIn({ kind: 'nonsense', message: 'boom' }, 1)).toBeNull();
  });

  it('takes what players tell us, with their game zipped as the stats tools unzip it', async () => {
    const save = JSON.stringify({ seed: 5, tick: 1234, note: 'x'.repeat(5000) });
    const zipped = await zip(save);
    const report = {
      kind: 'bug',
      text: '  The boat sank\ninto the quay.  ',
      contact: 'me@example.com',
      visit: 'abcdefgh1234',
      game: 'abcdefgh5678',
      day: 3,
      version: '2026-10-31 00:51 3b839e2',
      context: { seed: 5, messages: ['Not enough money'] },
      save: zipped,
      saveBytes: save.length,
      picture: 'data:image/jpeg;base64,/9j/4AAQ',
    };
    const r = feedbackIn(report, 1, NOWHERE);
    expect(r).not.toBeNull();
    expect(r!.slice(0, 3)).toEqual(['bug', 'The boat sank\ninto the quay.', 'me@example.com']);
    // Zipped small, and back to the same game.
    expect(zipped.length).toBeLessThan(save.length / 10);
    const bytes = Uint8Array.from(atob(zipped), (c) => c.charCodeAt(0));
    const back = await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).text();
    expect(back).toBe(save);
    // Turned away: no words, a kind not known, a picture that is not one.
    expect(feedbackIn({ ...report, text: '   ' }, 1, NOWHERE)).toBeNull();
    expect(feedbackIn({ ...report, kind: 'rant' }, 1, NOWHERE)).toBeNull();
    expect(feedbackIn({ ...report, picture: 'javascript:alert(1)' }, 1, NOWHERE)).toBeNull();
  });
});
