import { describe, expect, it } from 'vitest';
import { daylightAt, newDaylight } from '../src/render/daylight';
import { TICKS_PER_DAY } from '../src/sim/types';

describe('Day and night', () => {
  const at = (day: number) => daylightAt(day * TICKS_PER_DAY, newDaylight());

  it('starts a game in the morning light, with the sun up', () => {
    const l = at(0);
    expect(l.dir.y).toBeGreaterThan(0.1);
    expect(l.intensity).toBeGreaterThan(1.5);
    expect(l.night).toBeLessThan(0.2);
  });

  it('is mostly day, with a moonlit night of about a fifth of each game day', () => {
    let dark = 0;
    for (let k = 0; k < 1000; k++) if (at(k / 1000).night > 0.9) dark++;
    expect(dark).toBeGreaterThan(80);
    expect(dark).toBeLessThan(220);
    const midnight = at(0.83);
    expect(midnight.night).toBe(1);
    expect(midnight.intensity).toBeGreaterThan(0.3);
    expect(midnight.hemi).toBeGreaterThan(0.4);
  });

  it('changes smoothly through the day, never jumping', () => {
    let last = at(0);
    for (let k = 1; k <= 2000; k++) {
      const l = at(k / 2000);
      expect(Math.abs(l.intensity - last.intensity)).toBeLessThan(0.1);
      expect(Math.abs(l.hemi - last.hemi)).toBeLessThan(0.05);
      // The light swings round from the sun to the moon only while it is dark.
      if (l.dir.angleTo(last.dir) > 0.05)
        expect(Math.max(l.intensity, last.intensity)).toBeLessThan(0.15);
      last = l;
    }
  });
});
