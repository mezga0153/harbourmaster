/** How the game is drawn: kept by the player, per browser. */
export interface Graphics {
  /** The sea: its ripples, boats' wakes and shade on the water. */
  water: 'low' | 'medium' | 'high';
  /** Shadows cast by the sun, and how sharp. */
  shadows: 'off' | 'low' | 'high' | 'ultra';
  /** How many pixels it draws, against the screen's own. */
  resolution: 'fast' | 'balanced' | 'sharp';
  /** Day and night going round with the game's days, or always day. */
  daylight: 'cycle' | 'day';
  /** Frames a second at most: as many as the screen shows, or fewer to spare a laptop's battery. */
  fps: 'screen' | '60' | '30';
}

export const DEFAULT_GRAPHICS: Graphics = {
  water: 'high',
  shadows: 'high',
  resolution: 'sharp',
  daylight: 'cycle',
  fps: 'screen',
};

/** The quality presets, each setting the sea, the shadows and the pixels together. */
export type GraphicsPreset = 'low' | 'medium' | 'high' | 'ultra';
export const GRAPHICS_PRESETS: Record<
  GraphicsPreset,
  Pick<Graphics, 'water' | 'shadows' | 'resolution'>
> = {
  low: { water: 'low', shadows: 'off', resolution: 'fast' },
  medium: { water: 'medium', shadows: 'low', resolution: 'balanced' },
  high: { water: 'high', shadows: 'high', resolution: 'sharp' },
  ultra: { water: 'high', shadows: 'ultra', resolution: 'sharp' },
};

/** The preset these settings are, if they are one. */
export function presetOf(g: Graphics): GraphicsPreset | null {
  for (const [name, p] of Object.entries(GRAPHICS_PRESETS) as [GraphicsPreset, Graphics][]) {
    if (p.water === g.water && p.shadows === g.shadows && p.resolution === g.resolution) {
      return name;
    }
  }
  return null;
}

/** The fewest milliseconds between frames, by setting; 0 for as many as the screen shows. */
export const FRAME_GAP: Record<Graphics['fps'], number> = {
  screen: 0,
  '60': 1000 / 60,
  '30': 1000 / 30,
};

/** The sea's detail as the water shader counts it. */
export const WATER_LEVEL: Record<Graphics['water'], number> = { low: 0, medium: 1, high: 2 };

/** Pixels across the sun's shadow map, by setting. */
export const SHADOW_SIZE: Record<Exclude<Graphics['shadows'], 'off'>, number> = {
  low: 1024,
  high: 2048,
  ultra: 4096,
};

/** The most of the screen's pixels it draws to, by setting. */
export const PIXEL_RATIO: Record<Graphics['resolution'], number> = {
  // A pixel to every 2 by 2 of the screen's, shown blocky rather than blurred.
  fast: 0.5,
  balanced: 1.25,
  sharp: 2,
};

/** A setting read back from storage, checked: anything unknown is left as it was. */
export function readGraphics(raw: unknown): Graphics {
  const out = { ...DEFAULT_GRAPHICS };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (r.water === 'low' || r.water === 'medium' || r.water === 'high') out.water = r.water;
  if (r.shadows === 'off' || r.shadows === 'low' || r.shadows === 'high' || r.shadows === 'ultra') {
    out.shadows = r.shadows;
  }
  if (r.resolution === 'fast' || r.resolution === 'balanced' || r.resolution === 'sharp') {
    out.resolution = r.resolution;
  }
  if (r.daylight === 'cycle' || r.daylight === 'day') out.daylight = r.daylight;
  if (r.fps === 'screen' || r.fps === '60' || r.fps === '30') out.fps = r.fps;
  return out;
}
