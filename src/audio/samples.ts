// Written by scripts/fetch-music.mjs: the recorded notes the music has, by
// instrument, as MIDI note numbers (or the names of the drum hits), each at
// public/music/<instrument>/<note>.mp3. From the Versilian Community Sample
// Library, CC0.

export const SAMPLES = {
  vibes: [57, 81, 71, 60, 74, 64, 53, 77, 67],
  marimba: [59, 83, 48, 72, 41, 65, 89, 55, 79],
  piano: [36, 48, 60, 72, 84, 43, 55, 67, 79, 91],
  fmpiano: [36, 48, 60, 72, 84, 40, 52, 64, 76, 88, 44, 56, 68, 80, 92],
  kalimba: [58, 70, 82, 83, 49, 61, 73, 85, 51, 63, 75, 74, 88, 90, 53, 65, 77, 92, 55, 67, 79],
  shaker: ['hit0', 'hit1'],
  claves: ['hit0', 'hit1'],
} as const;

export type Instrument = keyof typeof SAMPLES;
