// The lab arranges complete source phrases, never random individual melody notes.
import { rng, type Bar, type Note, type Voice } from '../../audio/score';
import { THEMES, type Harmony, type Mode, type ThemeId, type Texture } from './palette';

export const MOODS = {
  drift: {
    name: 'Morning drift',
    tempo: 72,
    theme: 'satie',
    harmony: 'floating',
    texture: 'steps',
  },
  working: {
    name: 'Quayside motion',
    tempo: 86,
    theme: 'bach',
    harmony: 'prelude',
    texture: 'ripple',
  },
  night: {
    name: 'After the last ferry',
    tempo: 68,
    theme: 'greensleeves',
    harmony: 'folk',
    texture: 'folk',
  },
} as const;
export type Mood = keyof typeof MOODS;
export interface PhraseSlot {
  theme: ThemeId | 'follow' | 'rest';
  phrase: 'call' | 'answer';
  locked: boolean;
}
export interface Settings {
  seed: string;
  mood: Mood;
  tempo: number;
  density: number;
  theme: ThemeId;
  harmony: Harmony;
  texture: Texture;
  fit: boolean;
  slots?: PhraseSlot[];
}
export interface Piece {
  bars: Bar[];
  tonic: number;
  mode: Mode;
  sections: string[];
  chords: string[];
  phrases: string[];
  slots: PhraseSlot[];
}
export const DEFAULT_SETTINGS: Settings = {
  seed: 'a quiet harbour',
  mood: 'drift',
  tempo: 72,
  density: 0.5,
  theme: 'satie',
  harmony: 'floating',
  texture: 'steps',
  fit: true,
};

export function seedNumber(seed: string): number {
  let hash = 2166136261;
  for (const c of seed) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  return hash >>> 0;
}
export function noteName(midi: number): string {
  return ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'][((midi % 12) + 12) % 12];
}
const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const pc = (midi: number) => ((midi % 12) + 12) % 12;

export function arrangementFor(settings: Settings): PhraseSlot[] {
  const orders = [
    [0, 1, 0, 0, 1, 0, 0, 1],
    [0, 0, 0, 1, 1, 1, 0, 1],
    [0, 1, 0, 1, 1, 0, 0, 0],
  ];
  const order = orders[Math.floor(rng(seedNumber(settings.seed))() * orders.length)];
  return order.map((phrase, i) => ({
    ...(settings.slots?.[i] ?? {
      theme: 'follow',
      phrase: phrase ? 'answer' : 'call',
      locked: false,
    }),
  }));
}

/** Shuffle entire clips, keeping locked blocks and a familiar opening and ending. */
export function shuffleArrangement(settings: Settings): PhraseSlot[] {
  const random = rng(seedNumber(`${settings.seed}:phrases`));
  const themes = Object.keys(THEMES) as ThemeId[];
  return arrangementFor(settings).map((slot, i) => {
    if (slot.locked) return { ...slot };
    return {
      theme: i === 0 || i === 7 ? 'follow' : themes[Math.floor(random() * themes.length)],
      phrase: i === 0 ? 'call' : i === 7 || random() > 0.5 ? 'answer' : 'call',
      locked: false,
    };
  });
}

function chordTone(midi: number, tones: number[]): number {
  const classes = tones.map(pc);
  for (let distance = 0; distance <= 6; distance++) {
    for (const candidate of [midi - distance, midi + distance]) {
      if (classes.includes(pc(candidate))) return candidate;
    }
  }
  return midi;
}

export function compose(settings: Settings): Piece {
  const random = rng(seedNumber(`${settings.seed}:dynamics`));
  const theme = THEMES[settings.theme];
  const mode = theme.mode;
  const scale = SCALES[mode];
  // A shared tonic; the seed chooses phrase order and dynamics, never random pitches.
  const tonic = 60;
  const degree = (n: number) => tonic + Math.floor(n / 7) * 12 + scale[((n % 7) + 7) % 7];
  const tempo = Math.max(40, Math.min(140, settings.tempo));
  const density = Math.max(0, Math.min(1, settings.density));
  const slots = arrangementFor(settings);
  const bars: Bar[] = [];
  const chords: string[] = [];
  const phrases: string[] = [];
  for (let k = 0; k < 32; k++) {
    const local = k % 8;
    const chordDegrees =
      settings.harmony === 'floating'
        ? mode === 'major'
          ? [3, 0]
          : [5, 0]
        : settings.harmony === 'prelude'
          ? mode === 'major'
            ? [0, 1, 4, 0]
            : [0, 3, 4, 0]
          : mode === 'minor'
            ? [0, 0, 6, 6, 5, 5, 4, 4]
            : [0, 0, 4, 4, 3, 3, 4, 0];
    const chordDegree = chordDegrees[local % chordDegrees.length];
    const root = degree(chordDegree);
    const tones = [root, degree(chordDegree + 2), degree(chordDegree + 4)];
    const dominant = mode === 'minor' && chordDegree === 4;
    if (dominant) tones[1] = root + 4;
    const seventh =
      settings.harmony === 'floating' ||
      (settings.harmony === 'prelude' && (local % 4 === 1 || local % 4 === 2));
    if (seventh) tones.push(dominant ? root + 10 : degree(chordDegree + 6));
    const minor = tones[1] - root === 3;
    const suffix = seventh
      ? tones[3] - root === 11
        ? 'maj7'
        : minor
          ? 'm7'
          : '7'
      : minor
        ? 'm'
        : '';
    chords.push(`${noteName(root)}${suffix}`);
    let pianoRoot = root;
    while (pianoRoot > 60) pianoRoot -= 12;
    const voicing = tones.map((midi) => pianoRoot + midi - root);
    const notes: Note[] = [];
    const add = (voice: Voice, at: number, dur: number, midi: number, vel: number) => {
      notes.push({
        voice,
        at,
        dur: Math.min(dur, 4 - at),
        midi,
        vel: vel * (0.96 + random() * 0.04),
      });
    };
    add('bass', 0, 3.7, root - 24, 0.45);
    if (density >= 0.75) add('bass', 2, 1.7, root - 17, 0.28);
    add('pad', 0, 3.8, root - 12, 0.16);
    const chord = (at: number, dur: number, vel: number) => {
      for (const midi of voicing) add('keys', at, dur, midi, vel);
    };
    if (settings.texture === 'steps') {
      chord(4 / 3, 2.5, 0.34);
      if (density >= 0.75) chord(10 / 3, 0.5, 0.17);
    } else if (settings.texture === 'folk') {
      chord(4 / 3, 1.15, 0.27);
      if (density >= 0.3) chord(8 / 3, 1.15, 0.23);
    } else {
      const pattern = [0, 1, 2, 1, 0, 1, 2, 1];
      const steps = density >= 0.35 ? 8 : 4;
      for (let i = 0; i < steps; i++) add('keys', (i * 4) / steps, 0.85, voicing[pattern[i]], 0.3);
    }
    const slot = slots[Math.floor(k / 4)];
    const phrase = slot.phrase === 'answer' ? 1 : 0;
    const clipTheme =
      THEMES[slot.theme === 'follow' || slot.theme === 'rest' ? settings.theme : slot.theme];
    phrases.push(slot.theme === 'rest' ? 'Melody break' : `${clipTheme.name} · ${slot.phrase}`);
    const start = (k % 4) * 4;
    let first = true;
    for (const note of slot.theme === 'rest' ? [] : clipTheme.clips[phrase]) {
      if (note.at < start - 1e-8 || note.at >= start + 4 - 1e-8) continue;
      const at = Math.max(0, note.at - start);
      let midi = degree(note.degree) + 12 + (mode === clipTheme.mode ? (note.sharp ?? 0) : 0);
      if (settings.fit && (first || at < 0.01 || Math.abs(at - 2) < 0.01))
        midi = chordTone(midi, tones);
      first = false;
      add('lead', at, note.dur * 0.9, midi, 0.72);
    }
    if (density >= 0.7) {
      add('kick', 0, 0.2, 0, 0.16);
      add('shaker', 1, 0.08, 0, 0.12);
      add('shaker', 3, 0.08, 0, 0.12);
    }
    bars.push({
      notes: notes.sort((a, b) => a.at - b.at),
      beats: 4,
      tempo,
      band: 'parlour',
      chord: { root, tones },
    });
  }
  return {
    bars,
    tonic,
    mode,
    sections: ['Call & answer', 'Familiar ground', 'A different answer', 'Coming home'],
    chords,
    phrases,
    slots,
  };
}

/** Four-bar auditions play the adapted source before optional chord fitting. */
export function audition(
  settings: Settings,
  ingredient: 'theme' | 'harmony' | 'texture',
  source?: ThemeId,
  phrase: 'call' | 'answer' = 'call',
): Bar[] {
  const value: Settings = {
    ...settings,
    fit: false,
    slots: Array.from({ length: 8 }, () => ({ theme: 'follow', phrase, locked: false })),
  };
  if (source) {
    value.theme = source;
    const preset = Object.values(MOODS).find((mood) => mood.theme === THEMES[source].source)!;
    value.harmony = preset.harmony;
    value.texture = preset.texture;
  }
  return compose(value)
    .bars.slice(0, 4)
    .map((bar) => ({
      ...bar,
      notes: bar.notes.filter((note) =>
        ingredient === 'theme'
          ? note.voice === 'lead'
          : ingredient === 'harmony'
            ? note.voice === 'bass' || note.voice === 'keys'
            : note.voice !== 'lead' && note.voice !== 'pad',
      ),
    }));
}
