import { Color, Vector3 } from 'three';
import { TICKS_PER_DAY } from '../sim/types';
import { C } from './palette';
import { glowAtNight } from './util/mesh';

/** The colour lamps are painted, street lamps, headlamps and all, which shine at night. */
export const LAMP = 0xfff2b0;

// Day and night, for the look of the game only: the sun crosses the sky
// over each game day, the light warms at either end of it, and after
// sunset a short moonlit night, the port's windows and lamps lit, before
// dawn and the next day. Mostly day: a game day starts in the morning,
// and the night is a fifth of it.

/** How the scene is lit at a moment of the day. */
export interface Daylight {
  /** Towards the sun, or the moon at night, from the ground. */
  dir: Vector3;
  /** The sun's (or moon's) light, and how strong. */
  color: Color;
  intensity: number;
  /** The sky's light from above and the ground's bounced back up. */
  sky: Color;
  ground: Color;
  hemi: number;
  /** What the sea's colour is multiplied by, and the background beyond it. */
  sea: Color;
  background: Color;
  /** 0 by day to 1 at night: how brightly windows and lamps shine. */
  night: number;
}

// Lit at night: windows everywhere (houses, cabs, wheelhouses) and lamps,
// street lamps and headlamps alike.
glowAtNight(C.window, 0xffc46b, 0.9);
glowAtNight(LAMP, 0xffe39a, 1.4);

/** Where the light came from before there was a day: the sun at its height. */
export const NOON_DIR = new Vector3(-0.55, 1, 0.35).normalize();

/**
 * Where in the day `g` is reckoned from sunrise: the sun is up from 0 to
 * SUNSET, then night until 1, the next sunrise. A game day starts at MORNING.
 */
const MORNING = 0.07;
const SUNSET = 0.8;

/** The sun's height in the sky, highest at noon, and how far it swings either side of south. */
const NOON_HEIGHT = Math.asin(NOON_DIR.y);
const LOW_HEIGHT = 0.07;
const SWING = 1.05;
const SUN = 2.4;
const MOON = 0.9;
const MOON_COLOR = new Color(0xa9c0ff);

/** The light at points through the day, `g` from sunrise; between them it blends. */
interface Key {
  g: number;
  sun: number;
  sky: number;
  ground: number;
  hemi: number;
  night: number;
}

const DAY: Key = {
  g: 0,
  sun: 0xfff1dc,
  sky: 0xeaf4ff,
  ground: 0x8a7f6a,
  hemi: 1.6,
  night: 0,
};
const NIGHT: Key = {
  g: 0,
  sun: 0xff8a50,
  sky: 0x55689f,
  ground: 0x2a2c40,
  hemi: 0.75,
  night: 1,
};

const KEYS: Key[] = [
  {
    ...NIGHT,
    g: 0,
    sun: 0xffa060,
    sky: 0xe6b9b4,
    ground: 0x5a4c55,
    hemi: 0.95,
    night: 0.5,
  },
  { ...DAY, g: 0.1, sun: 0xffdcb4, sky: 0xf2eef0 },
  { ...DAY, g: 0.2 },
  { ...DAY, g: 0.6 },
  {
    ...DAY,
    g: 0.72,
    sun: 0xffc488,
    sky: 0xfbe2c8,
    ground: 0x8a7060,
    hemi: 1.35,
  },
  {
    ...NIGHT,
    g: SUNSET,
    sun: 0xff7a44,
    sky: 0xc495b0,
    ground: 0x5a4652,
    hemi: 1.0,
    night: 0.4,
  },
  { ...NIGHT, g: 0.86 },
  { ...NIGHT, g: 0.95 },
  {
    ...NIGHT,
    g: 1,
    sun: 0xffa060,
    sky: 0xe6b9b4,
    ground: 0x5a4c55,
    hemi: 0.95,
    night: 0.5,
  },
];

const a = new Color();
const b = new Color();
const SEA = new Color(C.waterDeep);

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** The light `ticks` into the game, into `out`. */
export function daylightAt(ticks: number, out: Daylight): Daylight {
  const day = (((ticks / TICKS_PER_DAY) % 1) + 1) % 1;
  const g = (day + MORNING) % 1;
  let k = 0;
  while (k < KEYS.length - 2 && KEYS[k + 1].g <= g) k++;
  const [p, q] = [KEYS[k], KEYS[k + 1]];
  const t = smooth(p.g, q.g, g);
  const mix = (from: number, to: number, c: Color) => c.copy(a.set(from).lerp(b.set(to), t));
  mix(p.sky, q.sky, out.sky);
  mix(p.ground, q.ground, out.ground);
  out.hemi = p.hemi + (q.hemi - p.hemi) * t;
  out.night = p.night + (q.night - p.night) * t;

  if (g < SUNSET) {
    // The sun, from low in the east round by the south to low in the west,
    // fading in after sunrise and out as it sets.
    const s = g / SUNSET;
    const height = LOW_HEIGHT + (NOON_HEIGHT - LOW_HEIGHT) * Math.sin(s * Math.PI);
    sunDir(SWING * (0.5 - s) * 2, height, out.dir);
    mix(p.sun, q.sun, out.color);
    out.intensity = SUN * smooth(0, 0.06, s) * smooth(0, 0.07, 1 - s);
  } else {
    // The moon, high in the south, once the sun is down and gone by dawn.
    sunDir(-0.6, 0.85, out.dir);
    out.color.copy(MOON_COLOR);
    out.intensity = MOON * smooth(SUNSET + 0.01, SUNSET + 0.05, g) * smooth(0.995, 0.955, g);
  }
  seaLight(g, out);
  return out;
}

/**
 * What the sea's colours are multiplied by through the day, `g` from
 * sunrise. The sea is drawn by its own shader, not lit as the land is, so
 * it is dimmed and tinted to go with it: by eye, against the land.
 */
const SEA_KEYS: [number, number, number, number][] = [
  [0, 0.62, 0.52, 0.58],
  [0.1, 1, 1, 1],
  [0.6, 1, 1, 1],
  [0.72, 1, 0.93, 0.84],
  [SUNSET, 0.34, 0.27, 0.36],
  [0.86, 0.15, 0.19, 0.34],
  [0.95, 0.15, 0.19, 0.34],
  [1, 0.62, 0.52, 0.58],
];

function seaLight(g: number, out: Daylight): void {
  let k = 0;
  while (k < SEA_KEYS.length - 2 && SEA_KEYS[k + 1][0] <= g) k++;
  const [p, q] = [SEA_KEYS[k], SEA_KEYS[k + 1]];
  const t = smooth(p[0], q[0], g);
  out.sea.setRGB(p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t, p[3] + (q[3] - p[3]) * t);
  out.background.copy(SEA).multiply(out.sea);
}

/** Towards the sun at `swing` round from its noon bearing, `height` above the horizon. */
function sunDir(swing: number, height: number, out: Vector3): Vector3 {
  const bearing = Math.atan2(NOON_DIR.z, NOON_DIR.x) + swing;
  const flat = Math.cos(height);
  return out.set(Math.cos(bearing) * flat, Math.sin(height), Math.sin(bearing) * flat);
}

/** A Daylight to fill in. */
export function newDaylight(): Daylight {
  return {
    dir: NOON_DIR.clone(),
    color: new Color(),
    intensity: SUN,
    sky: new Color(),
    ground: new Color(),
    hemi: 1.6,
    sea: new Color(1, 1, 1),
    background: new Color(),
    night: 0,
  };
}

/** Always day, as the game was before: the sun at its height. */
export function noon(out: Daylight): Daylight {
  out.dir.copy(NOON_DIR);
  out.color.set(DAY.sun);
  out.intensity = SUN;
  out.sky.set(DAY.sky);
  out.ground.set(DAY.ground);
  out.hemi = DAY.hemi;
  out.sea.setRGB(1, 1, 1);
  out.background.copy(SEA);
  out.night = 0;
  return out;
}
