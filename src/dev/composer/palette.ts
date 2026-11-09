// Transcribed from public-domain editions kept in sources/. Pitches are scale
// degrees; whole three-beat bars are stretched to four to share a common clock.
export const SOURCES = {
  satie: {
    title: 'Gymnopédie No. 1',
    composer: 'Erik Satie',
    credit: 'Evin Robertson · Mutopia-2014/12/14-37',
    license: 'Public Domain',
    url: 'https://github.com/MutopiaProject/MutopiaProject/blob/master/ftp/SatieE/gymnopedie_1/gymnopedie_1.ly',
    file: 'sources/gymnopedie-1.ly',
    extraction:
      'Melody bars 5–8 and 17–20; opening Gmaj7 / Dmaj7 harmony and bass–chord gesture. Transposed; 3/4 stretched to 4/4. Long ties rearticulated.',
  },
  bach: {
    title: 'Prelude in C · BWV 846',
    composer: 'J. S. Bach',
    credit:
      'Tobias Erbsland; Shay Rojansky, Han-Wen Nienhuys, Javier Ruiz-Alma · Mutopia-2011/09/12-5',
    license: 'Public Domain',
    url: 'https://github.com/MutopiaProject/MutopiaProject/blob/master/ftp/BachJS/BWV846/wtk1-prelude1/wtk1-prelude1.ly',
    file: 'sources/bwv846-prelude.ly',
    extraction:
      'Upper arpeggio line and harmony, opening four bars. The answer repeats the contour with a home-note cadence. Accompaniment slowed to eighth notes.',
  },
  greensleeves: {
    title: 'Greensleeves',
    composer: 'Traditional',
    credit: 'Ralf Axel Gehlert · Mutopia-2008/01/20-1265',
    license: 'Public Domain',
    url: 'https://github.com/MutopiaProject/MutopiaProject/blob/master/ftp/Traditional/GreensleevesAcc/GreensleevesAcc.ly',
    file: 'sources/greensleeves.ly',
    extraction:
      'First eight full melody bars, omitting the pickup; Am–G–F–E harmony. Transposed; 3/4 stretched to 4/4. Raised leading notes retained in minor.',
  },
} as const;
export type SourceId = keyof typeof SOURCES;
export type Mode = 'major' | 'minor';
export interface ClipNote {
  at: number;
  dur: number;
  degree: number;
  sharp?: number;
}
export interface Theme {
  name: string;
  source: SourceId;
  mode: Mode;
  description: string;
  clips: [ClipNote[], ClipNote[]];
}

// [scale degree, quarter-note duration, optional accidental]; null is a rest.
function waltz(
  bars: readonly (readonly (readonly [number | null, number, number?])[])[],
): ClipNote[] {
  return bars.flatMap((bar, index) => {
    let beat = index * 4;
    return bar.flatMap(([degree, duration, sharp]) => {
      const at = beat;
      const dur = (duration * 4) / 3;
      beat += dur;
      return degree === null ? [] : [{ at, dur, degree, ...(sharp ? { sharp } : {}) }];
    });
  });
}

const bachOpening: ClipNote[] = [
  [4, 7, 9],
  [5, 8, 10],
  [4, 8, 10],
  [4, 7, 9],
].flatMap((pitches, bar) =>
  [0, 2].flatMap((half) =>
    [0, 1, 2, 0, 1, 2].map((pick, i) => ({
      at: bar * 4 + half + 0.5 + i * 0.25,
      dur: 0.23,
      degree: pitches[pick] - 7,
    })),
  ),
);

const THEME_DATA = {
  satie: {
    name: 'Satie · floating phrase',
    source: 'satie',
    mode: 'major',
    description: 'A rising call and a long, falling answer. Adapted from Gymnopédie No. 1.',
    clips: [
      waltz([
        [
          [null, 1],
          [2, 1],
          [4, 1],
        ],
        [
          [3, 1],
          [2, 1],
          [-1, 1],
        ],
        [
          [-2, 1],
          [-1, 1],
          [0, 1],
        ],
        [[-3, 3]],
      ]),
      waltz([[[-1, 3]], [[2, 3]], [[1, 3]], [[1, 3]]]),
    ],
  },
  bach: {
    name: 'Bach · rippling figure',
    source: 'bach',
    mode: 'major',
    description: 'A measured arpeggio with a familiar harmonic destination. From Prelude in C.',
    clips: [
      bachOpening,
      bachOpening.map((note) => (note.at >= 12 ? { ...note, degree: 0 } : { ...note })),
    ],
  },
  greensleeves: {
    name: 'Greensleeves · folk phrase',
    source: 'greensleeves',
    mode: 'minor',
    description: 'A complete folk call and answer, with the dotted rhythm kept intact.',
    clips: [
      waltz([
        [
          [2, 2],
          [3, 1],
        ],
        [
          [4, 1.5],
          [5, 0.5],
          [4, 1],
        ],
        [
          [3, 2],
          [1, 1],
        ],
        [
          [-1, 1.5],
          [0, 0.5],
          [1, 1],
        ],
      ]),
      waltz([
        [
          [2, 2],
          [0, 1],
        ],
        [
          [0, 1.5],
          [-1, 0.5, 1],
          [0, 1],
        ],
        [
          [1, 2],
          [-1, 1, 1],
        ],
        [
          [-3, 2],
          [0, 1],
        ],
      ]),
    ],
  },
  'satie-middle': {
    name: 'Satie · middle passage',
    source: 'satie',
    mode: 'major',
    description:
      'The stepwise middle phrase from bars 22–25, with an original held-note answer. Adapted to the shared key and four-beat clock.',
    clips: [
      waltz([
        [
          [-3, 1],
          [-2, 1],
          [-1, 1, -1],
        ],
        [
          [1, 1],
          [0, 1],
          [-2, 1],
        ],
        [
          [0, 1],
          [-1, 1, -1],
          [-2, 1],
        ],
        [[0, 3]],
      ]),
      waltz([[[0, 3]], [[0, 3]], [[-2, 3]], [[-3, 3]]]),
    ],
  },
  'greensleeves-chorus': {
    name: 'Greensleeves · chorus',
    source: 'greensleeves',
    mode: 'minor',
    description:
      'The broad, high opening of the chorus and the familiar falling response. From the second half of the same traditional score.',
    clips: [
      waltz([
        [[6, 3]],
        [
          [6, 1.5],
          [5, 0.5, 1],
          [4, 1],
        ],
        [
          [3, 2],
          [1, 1],
        ],
        [
          [-1, 1.5],
          [0, 0.5],
          [1, 1],
        ],
      ]),
      waltz([
        [
          [2, 2],
          [0, 1],
        ],
        [
          [0, 1.5],
          [-1, 0.5, 1],
          [0, 1],
        ],
        [
          [1, 2],
          [-1, 1, 1],
        ],
        [[-3, 3]],
      ]),
    ],
  },
} satisfies Record<string, Theme>;
export type ThemeId = keyof typeof THEME_DATA;
export const THEMES: Record<ThemeId, Theme> = THEME_DATA;

export const HARMONIES = {
  floating: {
    name: 'Floating sevenths',
    source: 'satie',
    description: 'IVmaj7 ⇄ Imaj7 · two settled chords',
  },
  prelude: {
    name: 'Prelude turnaround',
    source: 'bach',
    description: 'I → ii7 → V7 → I · a clear return home',
  },
  folk: {
    name: 'Folk descent',
    source: 'greensleeves',
    description: 'i → ♭VII → ♭VI → V · the traditional eight-bar descent',
  },
} as const;
export type Harmony = keyof typeof HARMONIES;
export const TEXTURES = {
  steps: {
    name: 'Bass, then chord',
    source: 'satie',
    description: 'A low note, then a quiet chord. Adapted from Satie’s left hand.',
  },
  ripple: {
    name: 'Broken chord ripple',
    source: 'bach',
    description: 'A repeating low–middle–high figure. Slowed down from Bach’s arpeggios.',
  },
  folk: {
    name: 'Folk lilt',
    source: 'greensleeves',
    description: 'Bass and two answering chords. Adapted from the accordion accompaniment.',
  },
} as const;
export type Texture = keyof typeof TEXTURES;
