#!/usr/bin/env node
// Fetches the recorded instruments the music plays, from the Versilian
// Community Sample Library (VCSL, CC0: public domain, no credit needed),
// trims each note to a few seconds, makes it mono and small (mp3), and writes
// them to public/music/ with a list for the game, src/audio/samples.ts.
//
//   node scripts/fetch-music.mjs
//
// Needs ffmpeg. Run again to change which notes or instruments are kept.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'sgossner/VCSL';
const BRANCH = 'master';
const OUT = 'public/music';

/**
 * Each instrument: where in the library, which recordings of it (a pattern
 * on the file name picking one loudness and take), the octaves wanted (as
 * named), how many seconds of each note to keep, and how far its names are
 * off the true pitch, as measured.
 */
const INSTRUMENTS = [
  {
    id: 'vibes',
    // Named an octave low, with middle C as C3.
    shift: 12,
    dir: 'Idiophones/Struck Idiophones/Vibraphone/',
    pick: /^Vibes_soft_[A-G]#?\d_v2_rr1_Main\.wav$/,
    octaves: [2, 5],
    seconds: 3,
  },
  {
    id: 'marimba',
    // Named an octave low, with middle C as C3.
    shift: 12,
    dir: 'Idiophones/Struck Idiophones/Marimba/',
    pick: /_med_01\.wav$/,
    octaves: [2, 6],
    seconds: 1.6,
  },
  {
    id: 'piano',
    // Named an octave low, with middle C as C3.
    shift: 12,
    dir: 'Chordophones/Zithers/Upright Piano, Yamaha/',
    pick: /^Upright1_Sus_[A-G]#?\d_vl2_rr1\.wav$/,
    octaves: [2, 6],
    seconds: 3.5,
  },
  {
    id: 'fmpiano',
    dir: 'Electrophones/TX81Z/FM Piano/',
    pick: /_vl2\.wav$/,
    octaves: [2, 6],
    seconds: 3,
  },
  {
    id: 'kalimba',
    // Named an octave low, with middle C as C3.
    shift: 12,
    dir: 'Idiophones/Plucked Idiophones/Kalimba, Tanzania/',
    pick: /_rr2\.wav$/,
    octaves: [3, 6],
    seconds: 2,
  },
  {
    id: 'shaker',
    dir: 'Idiophones/Struck Idiophones/Shaker, Small/',
    pick: /^Mid_Shaker(Double|HighFaster)_Up_rr1\.wav$/,
    seconds: 0.4,
  },
  {
    id: 'claves',
    dir: 'Idiophones/Struck Idiophones/Claves/',
    pick: /^claves_(mp|pp1)\.wav$/,
    seconds: 0.4,
  },
];

const PCS = {
  C: 0,
  'C#': 1,
  D: 2,
  'D#': 3,
  E: 4,
  F: 5,
  'F#': 6,
  G: 7,
  'G#': 8,
  A: 9,
  'A#': 10,
  B: 11,
};

/** The MIDI note a sample's file name says it is, middle C (C4) being 60. */
function midiOf(name) {
  const m = /_([A-G]#?)(-?\d)_/.exec(name);
  return m ? (Number(m[2]) + 1) * 12 + PCS[m[1]] : null;
}

/** The loudest a sound gets, in dB, once trimmed. */
function peakOf(wav, trim) {
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-i', wav, '-af', `${trim},volumedetect`, '-f', 'null', '-'],
    {
      encoding: 'utf8',
    },
  );
  const m = /max_volume: (-?[\d.]+) dB/.exec(r.stderr);
  return m ? Number(m[1]) : 0;
}

const tree = await (
  await fetch(`https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`)
).json();
const paths = tree.tree.filter((t) => t.type === 'blob').map((t) => t.path);

// Keep the credits; the notes are written afresh.
for (const inst of INSTRUMENTS) rmSync(join(OUT, inst.id), { recursive: true, force: true });
const tmp = join(tmpdir(), 'hm-music');
mkdirSync(tmp, { recursive: true });
const list = {};

for (const inst of INSTRUMENTS) {
  mkdirSync(join(OUT, inst.id), { recursive: true });
  const files = paths
    .filter((p) => p.startsWith(inst.dir) && inst.pick.test(p.split('/').pop()))
    .map((p) => {
      const midi = midiOf(p.split('/').pop());
      return { path: p, midi: midi === null ? null : midi + (inst.shift ?? 0) };
    })
    .filter(
      (f) =>
        !inst.octaves ||
        (f.midi !== null &&
          f.midi >= (inst.octaves[0] + 1) * 12 &&
          f.midi < (inst.octaves[1] + 2) * 12),
    );
  // One recording a note.
  const seen = new Set();
  const notes = [];
  for (const [k, f] of files.entries()) {
    const key = f.midi ?? k;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = f.midi !== null ? String(f.midi) : `hit${notes.length}`;
    const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${f.path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    const wav = join(tmp, `${inst.id}-${name}.wav`);
    writeFileSync(wav, Buffer.from(await (await fetch(url)).arrayBuffer()));
    const fade = Math.min(0.5, inst.seconds / 3);
    // From the strike, not the silence before it; faded out at the end.
    const trim = `silenceremove=start_periods=1:start_threshold=-45dB,atrim=0:${inst.seconds},afade=t=out:st=${inst.seconds - fade}:d=${fade}`;
    // Every note peaking at -3 dB, so the game sets each instrument's level.
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      wav,
      '-af',
      `${trim},volume=${-3 - peakOf(wav, trim)}dB`,
      '-ac',
      '1',
      '-ar',
      '44100',
      '-b:a',
      '80k',
      join(OUT, inst.id, `${name}.mp3`),
    ]);
    notes.push(f.midi ?? name);
    console.log(`${inst.id} ${name}`);
  }
  list[inst.id] = notes;
}

const ts = `// Written by scripts/fetch-music.mjs: the recorded notes the music has, by
// instrument, as MIDI note numbers (or the names of the drum hits), each at
// public/music/<instrument>/<note>.mp3. From the Versilian Community Sample
// Library, CC0.

export const SAMPLES = ${JSON.stringify(list, null, 2)} as const;

export type Instrument = keyof typeof SAMPLES;
`;
writeFileSync('src/audio/samples.ts', ts);
rmSync(tmp, { recursive: true, force: true });
