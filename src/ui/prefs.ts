import { signal } from '@preact/signals';
import { DEFAULT_GRAPHICS, readGraphics, type Graphics } from '../render/graphics';

// What the player has set for themselves, kept in this browser: how the
// game is drawn and how it sounds.

const GRAPHICS_KEY = 'harbourmaster.graphics';

/**
 * On a phone or tablet, lighter to start with: the full sea, sharp shadows
 * and every pixel of a phone's dense screen are more than its graphics can
 * keep up, and some browsers turn 3D off for the site once it crashes.
 */
const PHONE_GRAPHICS: Graphics = {
  water: 'medium',
  shadows: 'low',
  resolution: 'balanced',
  daylight: 'cycle',
  fps: 'screen',
};

function onPhone(): boolean {
  return (
    typeof matchMedia === 'function' &&
    (matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 760px)').matches)
  );
}

function loadGraphics(): Graphics {
  const start = onPhone() ? PHONE_GRAPHICS : DEFAULT_GRAPHICS;
  try {
    const raw = localStorage.getItem(GRAPHICS_KEY);
    const kept = raw ? readGraphics(JSON.parse(raw)) : null;
    // Kept only as the old defaults were, never chosen: a phone starts lighter.
    const same = kept && JSON.stringify(kept) === JSON.stringify(DEFAULT_GRAPHICS);
    return kept && !(same && onPhone()) ? kept : { ...start };
  } catch {
    return { ...start };
  }
}

/** How the game is drawn, as the player set it; kept in this browser. */
export const graphics = signal<Graphics>(loadGraphics());
graphics.subscribe((g) => {
  try {
    localStorage.setItem(GRAPHICS_KEY, JSON.stringify(g));
  } catch {
    // Kept for this visit only.
  }
});

export interface SoundSettings {
  on: boolean;
  /** 0 to 1. */
  volume: number;
  /** The sea, 0 to 1 of the volume. */
  ambience: number;
  /** The work: engines, cranes, containers and crates, horns, the port's hum, 0 to 1 of the volume. */
  effects: number;
  /** The music, 0 to 1 of the volume; none at 0. */
  music: number;
}

const SOUND_DEFAULTS: SoundSettings = {
  on: true,
  volume: 0.6,
  ambience: 1,
  effects: 1,
  music: 0.5,
};
const share = (v: unknown, or: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : or;

const SOUND_KEY = 'harbourmaster.sound';

function loadSound(): SoundSettings {
  try {
    const s = JSON.parse(localStorage.getItem(SOUND_KEY) ?? 'null');
    if (s && typeof s.on === 'boolean') {
      return {
        on: s.on,
        volume: share(s.volume, SOUND_DEFAULTS.volume),
        ambience: share(s.ambience, SOUND_DEFAULTS.ambience),
        effects: share(s.effects, SOUND_DEFAULTS.effects),
        music: share(s.music, SOUND_DEFAULTS.music),
      };
    }
  } catch {
    // No storage here: the defaults.
  }
  return { ...SOUND_DEFAULTS };
}

/** How the game sounds, as the player set it; kept in this browser. The soundscape (audio/sound.ts) follows it. */
export const soundSettings = signal<SoundSettings>(loadSound());
soundSettings.subscribe((s) => {
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify(s));
  } catch {
    // Kept for this visit only.
  }
});

export interface Gameplay {
  /** How fast the arrow keys and WASD pan the view. */
  pan: 'slow' | 'normal' | 'fast';
  /** The mouse wheel zooms the other way round. */
  invertZoom: boolean;
  /** Lessons open by themselves on a new port and a tier upgrade, or only from the Handbook. */
  lessons: boolean;
}

/** The keys' panning speed, against the usual, by setting. */
export const PAN_SPEED: Record<Gameplay['pan'], number> = { slow: 0.6, normal: 1, fast: 1.6 };

const GAMEPLAY_DEFAULTS: Gameplay = { pan: 'normal', invertZoom: false, lessons: true };
const GAMEPLAY_KEY = 'harbourmaster.gameplay';

function loadGameplay(): Gameplay {
  const out = { ...GAMEPLAY_DEFAULTS };
  try {
    const g = JSON.parse(localStorage.getItem(GAMEPLAY_KEY) ?? 'null');
    if (g?.pan === 'slow' || g?.pan === 'normal' || g?.pan === 'fast') out.pan = g.pan;
    if (typeof g?.invertZoom === 'boolean') out.invertZoom = g.invertZoom;
    if (typeof g?.lessons === 'boolean') out.lessons = g.lessons;
  } catch {
    // No storage here: the defaults.
  }
  return out;
}

/** How the game handles, as the player set it; kept in this browser. */
export const gameplay = signal<Gameplay>(loadGameplay());
gameplay.subscribe((g) => {
  try {
    localStorage.setItem(GAMEPLAY_KEY, JSON.stringify(g));
  } catch {
    // Kept for this visit only.
  }
});
