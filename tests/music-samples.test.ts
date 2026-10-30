import { describe, expect, it } from 'vitest';
import { BAND_PARTS } from '../src/audio/music';
import { SAMPLES, type Instrument } from '../src/audio/samples';
import { BANDS } from '../src/audio/score';

/** The notes each part plays, as the composer writes them. */
const RANGE: Record<string, [number, number]> = { keys: [52, 76], lead: [64, 84] };

/** The recordings shipped with the game, by path: how many bytes each. */
const SIZES = new Map(
  Object.entries(
    import.meta.glob<string>('../public/music/**/*.mp3', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  ).map(([p, raw]) => [p.replace('../', ''), raw.length]),
);
const FILES = new Set(SIZES.keys());

describe('The recorded instruments', () => {
  it('are all there, for every band that plays them, and nothing else', () => {
    let count = 0;
    for (const [inst, keys] of Object.entries(SAMPLES)) {
      expect(keys.length, inst).toBeGreaterThan(0);
      for (const key of keys) {
        const file = `public/music/${inst}/${key}.mp3`;
        expect(FILES.has(file), file).toBe(true);
        // A sound, not an empty file from a recording trimmed away.
        expect(SIZES.get(file), file).toBeGreaterThan(1500);
        count++;
      }
    }
    expect(FILES.size).toBe(count);
    for (const band of BANDS) {
      for (const inst of Object.values(BAND_PARTS[band])) {
        expect(SAMPLES[inst as Instrument], `${band} ${inst}`).toBeDefined();
      }
    }
  });

  it('have a recording near every note their part plays, so none is pitched far', () => {
    for (const band of BANDS) {
      for (const [voice, inst] of Object.entries(BAND_PARTS[band])) {
        const range = RANGE[voice];
        if (!range) continue;
        const keys = SAMPLES[inst as Instrument] as readonly number[];
        for (let midi = range[0]; midi <= range[1]; midi++) {
          const near = Math.min(...keys.map((k) => Math.abs(k - midi)));
          expect(near, `${band} ${voice} ${inst} ${midi}`).toBeLessThanOrEqual(4);
        }
      }
    }
  });
});
