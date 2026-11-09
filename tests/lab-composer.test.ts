import { describe, expect, it } from 'vitest';
import {
  arrangementFor,
  audition,
  compose,
  DEFAULT_SETTINGS,
  shuffleArrangement,
} from '../src/dev/composer/score';
import {
  HARMONIES,
  SOURCES,
  TEXTURES,
  THEMES,
  type Harmony,
  type SourceId,
  type Texture,
  type ThemeId,
} from '../src/dev/composer/palette';
import type { Bar } from '../src/audio/score';
import { layerOf } from '../src/dev/composer/player';

const lead = (bars: Bar[]) =>
  bars.map((bar) => bar.notes.filter((n) => n.voice === 'lead').map(({ vel: _, ...note }) => note));
const pitches = (bars: Bar[]) =>
  bars.flatMap((bar) => bar.notes.filter((n) => n.voice === 'lead').map((n) => n.midi));
const pc = (midi: number) => ((midi % 12) + 12) % 12;

describe('The phrase composer', () => {
  it('repeats a seed and uses other seeds to arrange whole phrases', () => {
    expect(compose(DEFAULT_SETTINGS)).toEqual(compose({ ...DEFAULT_SETTINGS }));
    const versions = Array.from({ length: 12 }, (_, i) =>
      compose({ ...DEFAULT_SETTINGS, seed: String(i) }),
    );
    expect(new Set(versions.map((p) => p.phrases.join(','))).size).toBeGreaterThan(1);
    for (const version of versions) {
      // Every version begins with the same four-bar call, regardless of seed.
      expect(lead(version.bars.slice(0, 4))).toEqual(lead(versions[0].bars.slice(0, 4)));
    }
  });

  it('retains the transcribed source melodies before optional chord fitting', () => {
    const fixtures: Record<ThemeId, number[]> = {
      // Satie bars 5–8, D major transposed down a tone to C major.
      satie: [76, 79, 77, 76, 71, 69, 71, 72, 67],
      // Bach opening upper line, six sixteenth notes twice per bar.
      bach: [
        ...[67, 72, 76, 67, 72, 76, 67, 72, 76, 67, 72, 76],
        ...[69, 74, 77, 69, 74, 77, 69, 74, 77, 69, 74, 77],
        ...[67, 74, 77, 67, 74, 77, 67, 74, 77, 67, 74, 77],
        ...[67, 72, 76, 67, 72, 76, 67, 72, 76, 67, 72, 76],
      ],
      // Greensleeves first four complete bars, A minor transposed to C minor.
      greensleeves: [75, 77, 79, 80, 79, 77, 74, 70, 72, 74],
      'satie-middle': [67, 69, 70, 74, 72, 69, 72, 70, 69, 72],
      'greensleeves-chorus': [82, 82, 81, 79, 77, 74, 70, 72, 74],
    };
    for (const theme of Object.keys(fixtures) as ThemeId[]) {
      expect(pitches(audition({ ...DEFAULT_SETTINGS, theme }, 'theme'))).toEqual(fixtures[theme]);
    }
    const folk = audition({ ...DEFAULT_SETTINGS, theme: 'greensleeves' }, 'theme');
    const secondBar = folk[1].notes;
    expect(secondBar).toHaveLength(3);
    [0, 2, 8 / 3].forEach((at, i) => expect(secondBar[i].at).toBeCloseTo(at, 10));
  });

  it('uses the sourced harmonic loops and correctly names their chord qualities', () => {
    expect(compose(DEFAULT_SETTINGS).chords.slice(0, 4)).toEqual([
      'Fmaj7',
      'Cmaj7',
      'Fmaj7',
      'Cmaj7',
    ]);
    expect(compose({ ...DEFAULT_SETTINGS, harmony: 'prelude' }).chords.slice(0, 4)).toEqual([
      'C',
      'Dm7',
      'G7',
      'C',
    ]);
    expect(
      compose({ ...DEFAULT_SETTINGS, theme: 'greensleeves', harmony: 'folk' }).chords.slice(0, 8),
    ).toEqual(['Cm', 'Cm', 'B♭', 'B♭', 'A♭', 'A♭', 'G', 'G']);
  });

  it('keeps notes playable and fits the first melody note to the chord across all ingredient combinations', () => {
    for (const theme of Object.keys(THEMES) as ThemeId[]) {
      for (const harmony of Object.keys(HARMONIES) as Harmony[]) {
        for (const texture of Object.keys(TEXTURES) as Texture[]) {
          for (const density of [0, 0.5, 1]) {
            const piece = compose({ ...DEFAULT_SETTINGS, theme, harmony, texture, density });
            expect(piece.bars).toHaveLength(32);
            for (const bar of piece.bars) {
              expect(bar.beats).toBe(4);
              const first = bar.notes.find((note) => note.voice === 'lead');
              if (first) expect(bar.chord.tones.map(pc)).toContain(pc(first.midi));
              for (const note of bar.notes) {
                expect(note.at).toBeGreaterThanOrEqual(0);
                expect(note.at).toBeLessThan(4);
                expect(note.dur).toBeGreaterThan(0);
                expect(note.at + note.dur).toBeLessThanOrEqual(4 + 1e-8);
                expect(note.vel).toBeGreaterThan(0);
                expect(note.vel).toBeLessThanOrEqual(1);
                if (layerOf(note.voice) !== 'percussion') {
                  expect(note.midi).toBeGreaterThanOrEqual(36);
                  expect(note.midi).toBeLessThanOrEqual(86);
                }
              }
            }
          }
        }
      }
    }
  });

  it('changes backing density and tempo without deleting or rewriting the melody', () => {
    const sparse = compose({ ...DEFAULT_SETTINGS, density: 0, tempo: 40 });
    const busy = compose({ ...DEFAULT_SETTINGS, density: 1, tempo: 140 });
    expect(lead(sparse.bars)).toEqual(lead(busy.bars));
    expect(busy.bars.flatMap((bar) => bar.notes).length).toBeGreaterThan(
      sparse.bars.flatMap((bar) => bar.notes).length,
    );
    expect(sparse.bars[0].tempo).toBe(40);
    expect(busy.bars[0].tempo).toBe(140);
  });

  it('isolates ingredients for four-bar auditions', () => {
    const melody = audition(DEFAULT_SETTINGS, 'theme');
    expect(melody).toHaveLength(4);
    expect(melody.flatMap((bar) => bar.notes).every((note) => note.voice === 'lead')).toBe(true);
    const chords = audition(DEFAULT_SETTINGS, 'harmony');
    expect(chords.flatMap((bar) => bar.notes).some((note) => note.voice === 'keys')).toBe(true);
    expect(chords.flatMap((bar) => bar.notes).some((note) => note.voice === 'lead')).toBe(false);
    for (const source of Object.keys(SOURCES) as SourceId[]) {
      expect(pitches(audition(DEFAULT_SETTINGS, 'theme', source)).length).toBeGreaterThan(0);
      expect(SOURCES[source].license).toBe('Public Domain');
    }
  });

  it('combines intact phrases in individual four-bar slots and leaves the other slots alone', () => {
    const slots = arrangementFor(DEFAULT_SETTINGS);
    slots[0] = { theme: 'bach', phrase: 'answer', locked: false };
    slots[1] = { theme: 'satie-middle', phrase: 'call', locked: false };
    const piece = compose({ ...DEFAULT_SETTINGS, fit: false, slots });
    expect(lead(piece.bars.slice(0, 4))).toEqual(
      lead(audition(DEFAULT_SETTINGS, 'theme', 'bach', 'answer')),
    );
    expect(lead(piece.bars.slice(4, 8))).toEqual(
      lead(audition(DEFAULT_SETTINGS, 'theme', 'satie-middle', 'call')),
    );
    const original = compose({ ...DEFAULT_SETTINGS, fit: false });
    expect(lead(piece.bars.slice(8))).toEqual(lead(original.bars.slice(8)));
    expect(piece.phrases[0]).toContain('Bach');
    expect(piece.phrases[4]).toContain('middle passage');
  });

  it('makes melody breaks without silencing the backing, and auditions bypass the custom arrangement', () => {
    const slots = arrangementFor(DEFAULT_SETTINGS);
    slots[1].theme = 'rest';
    const settings = { ...DEFAULT_SETTINGS, slots };
    const piece = compose(settings);
    for (const bar of piece.bars.slice(4, 8)) {
      expect(bar.notes.some((note) => note.voice === 'lead')).toBe(false);
      expect(bar.notes.some((note) => note.voice === 'keys')).toBe(true);
      expect(bar.notes.some((note) => note.voice === 'bass')).toBe(true);
    }
    expect(piece.phrases[4]).toBe('Melody break');
    slots[0].theme = 'rest';
    expect(pitches(audition(settings, 'theme', 'satie', 'answer'))).toEqual([71, 76, 74, 74]);
  });

  it('shuffles whole phrases reproducibly while preserving kept blocks without mutation', () => {
    const slots = arrangementFor(DEFAULT_SETTINGS);
    slots[2] = { theme: 'greensleeves-chorus', phrase: 'answer', locked: true };
    slots[5] = { theme: 'rest', phrase: 'call', locked: true };
    const settings = { ...DEFAULT_SETTINGS, slots };
    const before = JSON.stringify(settings);
    const shuffled = shuffleArrangement(settings);
    expect(shuffled).toEqual(shuffleArrangement(settings));
    expect(shuffled[2]).toEqual(slots[2]);
    expect(shuffled[5]).toEqual(slots[5]);
    expect(shuffled[0]).toEqual({ theme: 'follow', phrase: 'call', locked: false });
    expect(shuffled[7]).toEqual({ theme: 'follow', phrase: 'answer', locked: false });
    expect(new Set(shuffled.map((slot) => slot.theme)).size).toBeGreaterThan(2);
    expect(JSON.stringify(settings)).toBe(before);
  });
});
