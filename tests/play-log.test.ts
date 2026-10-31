import { describe, expect, it } from 'vitest';
import { gist } from '../src/log/common';
import { dayRow, fresh } from '../src/log/days';
import { TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import { COLUMNS, row as dayIn } from '../server/api/days.js';
import { row as errorIn } from '../server/api/errors.js';
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
});
