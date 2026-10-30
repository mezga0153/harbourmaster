// The music, written as it plays: easy-going tunes in the manner of an old
// MIDI soundtrack, a few instruments over gentle chords, never quite the
// same twice. This part only writes the notes; music.ts plays them.

/** Which instrument plays a note. */
export type Voice = 'keys' | 'bass' | 'lead' | 'pad' | 'kick' | 'shaker' | 'rim';

export interface Note {
  /** Beats from the start of the bar, swing and all. */
  at: number;
  /** How long it is held, in beats. */
  dur: number;
  /** MIDI note number; 0 for the drums. */
  midi: number;
  /** How hard it is played, 0 to 1. */
  vel: number;
  voice: Voice;
}

/**
 * Which band plays a tune: the one made in code, or one of recorded
 * instruments (see music.ts), the keys and the tune each its own.
 */
export type Band = 'synth' | 'parlour' | 'fm' | 'island';
export const BANDS: readonly Band[] = ['synth', 'parlour', 'fm', 'island'];

export interface Bar {
  notes: Note[];
  /** Who plays it. */
  band: Band;
  /** Beats in the bar. */
  beats: number;
  /** Beats a minute. */
  tempo: number;
  /** The chord, for the record: its root as a MIDI note and its kind. */
  chord: { root: number; tones: number[] };
}

/** A small seeded random number source, so a tune can be heard again. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
/** The notes of the major scale a melody keeps to most: no fourth, no seventh. */
const PENTATONIC = [0, 2, 4, 7, 9];

/**
 * Chords, as degrees of the scale, one a bar: the old favourites, which
 * never sound out of place.
 */
const PROGRESSIONS = [
  [0, 5, 3, 4], // I vi IV V, the doo-wop changes
  [0, 3, 5, 4],
  [1, 4, 0, 0], // ii V I, as in jazz
  [0, 3, 0, 4],
  [5, 3, 0, 4],
  [0, 2, 3, 4],
  [3, 4, 2, 5],
  [0, 4, 5, 3], // I V vi IV, half the pop songs ever written
  [3, 0, 1, 4],
  [0, 5, 1, 4], // I vi ii V, the turnaround
  [1, 4, 0, 5],
  [5, 1, 4, 0],
  [0, 1, 2, 3], // walking up
  [3, 2, 1, 0], // and down
  [0, 3, 4, 3],
  [5, 4, 3, 4],
  [0, 4, 3, 0],
  [3, 4, 0, 0], // IV V I, a plain cadence
  [0, 0, 3, 4],
  [2, 5, 1, 4], // iii vi ii V, round the circle of fifths
];

/** Keys to start in: warm, easy ones, as MIDI tonic notes. */
const KEYS = [60, 62, 65, 67, 58];

/**
 * How the keys play the chord through a bar: struck together (`notes`
 * unset), or a note at a time, `notes` saying which of the chord, low to
 * high. Onsets and lengths in beats.
 */
interface Comp {
  hits: { at: number; dur: number; note?: number }[];
}

/** Ways to play the chords, under verses. */
const COMPING: Comp[] = [
  // Held through the bar.
  { hits: [{ at: 0, dur: 3.8 }] },
  // Held, with a push on the and of two.
  {
    hits: [
      { at: 0, dur: 1.4 },
      { at: 1.5, dur: 2.4 },
    ],
  },
  // On one and three.
  {
    hits: [
      { at: 0, dur: 1.9 },
      { at: 2, dur: 1.9 },
    ],
  },
  // Broken up, a note a beat, and left to ring.
  {
    hits: [
      { at: 0, dur: 3.8, note: 0 },
      { at: 1, dur: 2.8, note: 1 },
      { at: 2, dur: 1.8, note: 2 },
      { at: 3, dur: 0.9, note: 1 },
    ],
  },
  // Low, then the top two, gently.
  {
    hits: [
      { at: 0, dur: 1.4, note: 0 },
      { at: 1, dur: 0.9, note: 2 },
      { at: 1.5, dur: 1.4, note: 1 },
      { at: 3, dur: 0.9, note: 2 },
    ],
  },
];

/** Under the tune: sparser, out of its way. */
const UNDER_TUNE: Comp[] = [COMPING[0], COMPING[3]];

/** Rolled up and down through the chord an eighth at a time, as on a marimba. */
const ROLLING: Comp = {
  hits: [0, 1, 2, 1, 0, 1, 2, 1].map((note, k) => ({ at: k / 2, dur: 0.45, note })),
};

/** Rhythms for a two-bar melody idea, as onsets and lengths in beats. */
const MOTIFS: [number, number][][] = [
  [
    [0, 1],
    [1, 0.5],
    [1.5, 1.5],
    [4, 1],
    [5, 1],
    [6, 2],
  ],
  [
    [0.5, 0.5],
    [1, 1],
    [2, 2],
    [4.5, 0.5],
    [5, 0.5],
    [5.5, 2.5],
  ],
  [
    [0, 1.5],
    [1.5, 0.5],
    [2, 1],
    [3, 1],
    [4, 3],
  ],
  [
    [0, 0.5],
    [0.5, 0.5],
    [1, 1],
    [2.5, 1.5],
    [4, 0.5],
    [4.5, 0.5],
    [5, 3],
  ],
];

/** What plays in an eight-bar section. */
type Part = 'intro' | 'verse' | 'tune' | 'bridge' | 'rest';

/** How the sections of a tune follow on. */
const FORMS: Part[][] = [
  ['intro', 'tune', 'verse', 'tune', 'bridge', 'tune'],
  ['intro', 'verse', 'tune', 'bridge', 'tune', 'rest'],
  ['verse', 'tune', 'tune', 'bridge', 'verse'],
];

const SWING = 0.08;

/** An offbeat eighth lands a little late: it lilts. */
function swing(at: number): number {
  return at % 1 === 0.5 ? at + SWING : at;
}

/** The scale degree's note, any number of degrees up or down. */
function degreeNote(tonic: number, degree: number): number {
  const oct = Math.floor(degree / 7);
  return tonic + 12 * oct + MAJOR[((degree % 7) + 7) % 7];
}

/** Root, third, fifth and seventh of the chord on a degree, a ninth now and then. */
function chordOn(tonic: number, degree: number, ninth: boolean): number[] {
  const tones = [0, 2, 4, 6].map((k) => degreeNote(tonic, degree + k));
  if (ninth) tones.push(degreeNote(tonic, degree + 8));
  return tones;
}

/** The note of `pcs` (pitch classes) nearest `near`, within lo to hi. */
function nearest(pcs: number[], near: number, lo: number, hi: number): number {
  let best = near;
  let dist = Infinity;
  for (let n = lo; n <= hi; n++) {
    if (!pcs.includes(((n % 12) + 12) % 12)) continue;
    const d = Math.abs(n - near);
    if (d < dist) {
      dist = d;
      best = n;
    }
  }
  return best;
}

/** Pitch classes of a set of notes. */
const classes = (notes: number[]) => [...new Set(notes.map((n) => ((n % 12) + 12) % 12))];

/**
 * Writes the music a bar at a time, for as long as it is asked: tune after
 * tune, each in its own key, speed and feel.
 */
export class Composer {
  private random: () => number;
  private tonic = 60;
  private tempo = 84;
  private form: Part[] = [];
  private section = 0;
  private barInSection = 0;
  private progression: number[] = [];
  private bridgeProgression: number[] = [];
  private comp = COMPING[0];
  private underTune = UNDER_TUNE[0];
  private motif = MOTIFS[0];
  /** The tune's contour: how far up the scale each motif note sits from the last. */
  private shape: number[] = [];
  private lastLead = 72;
  private keysVoicing: number[] = [];
  private band: Band = 'synth';
  /** Only this band, to hear it on its own (in the sound lab); otherwise each tune its own. */
  only: Band | null = null;

  constructor(seed = Math.floor(Math.random() * 2 ** 31)) {
    this.random = rng(seed);
    this.newTune(true);
  }

  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.random() * xs.length)];
  }

  /** A fresh tune: its key, speed, chords, feel and melody idea. */
  private newTune(first: boolean): void {
    // Next tune a fourth up or a step down, or anywhere easy to start.
    this.tonic = first
      ? this.pick(KEYS)
      : (() => {
          let t = this.tonic + this.pick([5, -2, -5, 2]);
          while (t > 66) t -= 12;
          while (t < 56) t += 12;
          return t;
        })();
    this.tempo = 76 + Math.floor(this.random() * 13);
    this.form = this.pick(FORMS);
    this.section = 0;
    this.barInSection = 0;
    this.progression = this.pick(PROGRESSIONS);
    do {
      this.bridgeProgression = this.pick(PROGRESSIONS);
    } while (this.bridgeProgression === this.progression);
    this.comp = this.pick(COMPING);
    this.underTune = this.pick(UNDER_TUNE);
    // A different band from the last tune.
    const last = this.band;
    do {
      this.band = this.pick(BANDS);
    } while (!first && this.band === last);
    if (this.only) this.band = this.only;
    // The island band's marimba rolls through the chords.
    if (this.band === 'island') this.comp = this.underTune = ROLLING;
    this.newMotif();
  }

  private newMotif(): void {
    this.motif = this.pick(MOTIFS);
    // Mostly steps, now and then a leap, wandering back towards the middle.
    this.shape = this.motif.map(() => {
      const r = this.random();
      return r < 0.35 ? 1 : r < 0.7 ? -1 : r < 0.82 ? 0 : r < 0.91 ? 2 : -2;
    });
  }

  /** Start a fresh tune at the next bar. */
  skip(): void {
    this.section = this.form.length;
  }

  /** The next bar of music. */
  next(): Bar {
    if (this.section >= this.form.length) this.newTune(false);
    const part = this.form[this.section];
    const b = this.barInSection;
    const prog = part === 'bridge' ? this.bridgeProgression : this.progression;
    const degree = prog[b % prog.length];
    // The last bar of a tune comes home.
    const last = this.section === this.form.length - 1 && b === 7;
    const home = last ? 0 : degree;
    const tones = chordOn(this.tonic, home, this.random() < 0.3);
    const root = degreeNote(this.tonic, home) - 24;
    const notes: Note[] = [];

    if (part !== 'rest' || b < 4) this.keys(notes, tones, part);
    if (part !== 'intro' || b >= 4) this.bass(notes, root, prog[(b + 1) % prog.length], last);
    if (part === 'tune' || (part === 'bridge' && b >= 4)) this.lead(notes, tones, b, last);
    if (part === 'bridge' || part === 'rest' || part === 'intro') this.pad(notes, tones);
    if (part === 'verse' || part === 'tune') this.drums(notes, b);

    this.barInSection++;
    if (this.barInSection === 8) {
      this.barInSection = 0;
      this.section++;
      // A new idea for the tune now and then, so it does not wear thin.
      if (this.random() < 0.4) this.newMotif();
    }
    notes.sort((x, y) => x.at - y.at);
    return { notes, band: this.band, beats: 4, tempo: this.tempo, chord: { root, tones } };
  }

  private keys(notes: Note[], tones: number[], part: Part): void {
    // The third, fifth and seventh: no root, as the bass has it, and no
    // ninth. Three notes a third or so apart in any order they come in,
    // never a cluster of neighbours. Close together below the tune, each
    // chord moving as little as it can from the last.
    const shell = classes(tones.slice(1, 4));
    const from = this.keysVoicing[0] ?? 57;
    let best: number[] = [];
    for (let k = 0; k < 3; k++) {
      const order = [...shell.slice(k), ...shell.slice(0, k)];
      let low = nearest([order[0]], from, 50, 61);
      const v = [low];
      for (const pc of order.slice(1)) {
        low = nearest([pc], low + 3, low + 1, low + 11);
        v.push(low);
      }
      if (best.length === 0 || Math.abs(v[0] - from) < Math.abs(best[0] - from)) best = v;
    }
    this.keysVoicing = best;
    const soft = part === 'intro' || part === 'rest' ? 0.75 : 1;
    const comp = part === 'tune' || part === 'bridge' ? this.underTune : this.comp;
    for (const hit of comp.hits) {
      const at = swing(hit.at);
      if (hit.note !== undefined) {
        notes.push({
          at,
          dur: hit.dur,
          midi: best[hit.note],
          vel: (0.42 + 0.1 * this.random()) * soft,
          voice: 'keys',
        });
        continue;
      }
      best.forEach((n, k) => {
        // Played by hand: rolled gently up from the bottom, the top note
        // a touch louder.
        notes.push({
          at: at + k * (0.02 + 0.02 * this.random()),
          dur: hit.dur,
          midi: n,
          vel: (0.3 + 0.06 * this.random() + (k === best.length - 1 ? 0.06 : 0)) * soft,
          voice: 'keys',
        });
      });
    }
  }

  private bass(notes: Note[], root: number, nextDegree: number, last: boolean): void {
    while (root < 36) root += 12;
    while (root > 47) root -= 12;
    notes.push({ at: 0, dur: 1.4, midi: root, vel: 0.75, voice: 'bass' });
    if (last) {
      notes.push({ at: 2, dur: 1.8, midi: root, vel: 0.6, voice: 'bass' });
      return;
    }
    const r = this.random();
    if (r < 0.45) notes.push({ at: 2, dur: 1.2, midi: root + 7, vel: 0.6, voice: 'bass' });
    else if (r < 0.75) {
      notes.push({ at: swing(1.5), dur: 0.5, midi: root + 12, vel: 0.45, voice: 'bass' });
      notes.push({ at: 2, dur: 1.2, midi: root + 7, vel: 0.6, voice: 'bass' });
    } else notes.push({ at: 2.5 + SWING, dur: 1, midi: root, vel: 0.55, voice: 'bass' });
    // A step towards the next chord's root, on the last beat.
    if (this.random() < 0.5) {
      let target = degreeNote(this.tonic, nextDegree) - 24;
      while (target < root - 6) target += 12;
      while (target > root + 6) target -= 12;
      // Not down where the bass turns to mud.
      if (target < 36) target += 12;
      const approach = target + (target > root ? -1 : 1) * (this.random() < 0.5 ? 1 : 2);
      notes.push({ at: 3.5 + SWING, dur: 0.45, midi: approach, vel: 0.45, voice: 'bass' });
    }
  }

  private lead(notes: Note[], tones: number[], bar: number, last: boolean): void {
    const chord = classes(tones);
    const scale = classes(PENTATONIC.map((d) => this.tonic + d));
    // A two-bar idea: this bar's half of it.
    const half = bar % 2;
    const phraseEnd = bar % 4 === 3;
    const motif = this.motif.filter(([at]) => (half === 0 ? at < 4 : at >= 4));
    motif.forEach(([at0, dur], i) => {
      const at = at0 - half * 4;
      const k = this.motif.indexOf(motif[i]);
      // The tune's shape, kept in the middle of the range.
      let want = this.lastLead + this.shape[k] * 2;
      if (want > 81) want -= 4;
      if (want < 66) want += 4;
      // On the beat, a note of the chord; between, any note of the tune's scale.
      const strong = at % 1 === 0;
      let midi = nearest(strong ? chord : scale, want, 64, 84);
      let d = dur;
      const lastNote = i === motif.length - 1;
      if ((phraseEnd || last) && lastNote) {
        // The end of a phrase rests on the chord, the end of the tune on its root.
        midi = nearest(last ? [this.tonic % 12] : chord, midi, 64, 84);
        d = Math.max(d, 4 - at);
      }
      this.lastLead = midi;
      // Let go a touch before the next note, swung or not.
      const next = i + 1 < motif.length ? swing(motif[i + 1][0] - half * 4) : 4;
      const start = swing(at);
      notes.push({
        at: start,
        dur: Math.min(d * 0.92, (next - start) * 0.92),
        midi,
        vel: (strong ? 0.62 : 0.5) + 0.1 * this.random(),
        voice: 'lead',
      });
    });
  }

  private pad(notes: Note[], tones: number[]): void {
    // Just the root and fifth, open and low, under the keys: a warm floor,
    // never rubbing against them.
    const root = nearest([tones[0] % 12], 48, 43, 54);
    for (const n of [root, root + 7]) {
      notes.push({ at: 0, dur: 4, midi: n, vel: 0.5, voice: 'pad' });
    }
  }

  private drums(notes: Note[], bar: number): void {
    notes.push({ at: 0, dur: 0.3, midi: 0, vel: 0.7, voice: 'kick' });
    notes.push({
      at: 2 + (this.random() < 0.25 ? 0.5 + SWING : 0),
      dur: 0.3,
      midi: 0,
      vel: 0.55,
      voice: 'kick',
    });
    for (let e = 0; e < 8; e++) {
      const at = swing(e / 2);
      const off = e % 2 === 1;
      notes.push({
        at,
        dur: 0.1,
        midi: 0,
        vel: (off ? 0.55 : 0.3) + 0.15 * this.random(),
        voice: 'shaker',
      });
    }
    if (bar % 2 === 1) notes.push({ at: 3, dur: 0.1, midi: 0, vel: 0.5, voice: 'rim' });
  }
}
