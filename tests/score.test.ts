import { describe, expect, it } from 'vitest';
import { Composer, type Bar } from '../src/audio/score';

const bars = (seed: number, n: number): Bar[] => {
  const c = new Composer(seed);
  return Array.from({ length: n }, () => c.next());
};

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const pc = (n: number) => ((n % 12) + 12) % 12;
/** Whether a note is in the major key whose tonic is a chord's tones' home. */
const inKey = (tonic: number, n: number) => MAJOR.includes(pc(n - tonic));

describe('The music', () => {
  it('writes the same tune again from the same seed, and another from another', () => {
    expect(bars(5, 40)).toEqual(bars(5, 40));
    expect(bars(5, 40)).not.toEqual(bars(6, 40));
  });

  it('keeps to bars of four beats at an easy pace, every note in its bar and range', () => {
    const range = {
      keys: [52, 76],
      bass: [33, 60],
      lead: [64, 84],
      pad: [40, 80],
    } as Record<string, [number, number]>;
    for (const seed of [1, 2, 3]) {
      for (const bar of bars(seed, 300)) {
        expect(bar.beats).toBe(4);
        expect(bar.tempo).toBeGreaterThanOrEqual(76);
        expect(bar.tempo).toBeLessThanOrEqual(88);
        for (const n of bar.notes) {
          expect(n.at).toBeGreaterThanOrEqual(0);
          expect(n.at).toBeLessThan(4);
          expect(n.dur).toBeGreaterThan(0);
          expect(n.vel).toBeGreaterThan(0);
          expect(n.vel).toBeLessThanOrEqual(1);
          const r = range[n.voice];
          if (r) {
            expect(n.midi, n.voice).toBeGreaterThanOrEqual(r[0]);
            expect(n.midi, n.voice).toBeLessThanOrEqual(r[1]);
          }
        }
      }
    }
  });

  it('plays in key: the chords and the tune in the key of the moment, the bass on the root', () => {
    let tonic = 0;
    let checked = 0;
    for (const bar of bars(11, 400)) {
      // The chord's tones are the key's; find a tonic they all fit.
      const fits = (t: number) => bar.chord.tones.every((n) => inKey(t, n));
      if (!fits(tonic)) tonic = [...Array(12).keys()].find(fits)!;
      const lead = bar.notes.filter((n) => n.voice === 'lead');
      for (const n of [...lead, ...bar.notes.filter((x) => x.voice === 'keys')]) {
        expect(inKey(tonic, n.midi)).toBe(true);
        checked++;
      }
      // On the beat, the tune sits on a note of the chord.
      for (const n of lead.filter((x) => Number.isInteger(x.at))) {
        expect(bar.chord.tones.map(pc)).toContain(pc(n.midi));
      }
      const first = bar.notes.find((n) => n.voice === 'bass' && n.at === 0);
      if (first) expect(pc(first.midi)).toBe(pc(bar.chord.root));
      // One note of the tune at a time.
      for (let k = 1; k < lead.length; k++) {
        expect(lead[k].at).toBeGreaterThanOrEqual(lead[k - 1].at + lead[k - 1].dur - 1e-9);
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('moves on: tune after tune, in more than one key and with quiet stretches', () => {
    const all = bars(3, 400);
    const roots = new Set(all.filter((_, k) => k % 8 === 0).map((b) => pc(b.chord.root)));
    expect(roots.size).toBeGreaterThan(2);
    expect(new Set(all.map((b) => b.tempo)).size).toBeGreaterThan(1);
    // Not every bar has a tune or drums: it breathes.
    expect(all.some((b) => !b.notes.some((n) => n.voice === 'lead'))).toBe(true);
    expect(all.some((b) => !b.notes.some((n) => n.voice === 'kick'))).toBe(true);
    expect(all.some((b) => b.notes.some((n) => n.voice === 'lead'))).toBe(true);
  });
});
