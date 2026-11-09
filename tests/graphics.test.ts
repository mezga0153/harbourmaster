import { describe, expect, it } from 'vitest';
import { DEFAULT_GRAPHICS, GRAPHICS_PRESETS, presetOf, readGraphics } from '../src/render/graphics';

describe('Graphics settings kept in the browser', () => {
  it('reads back what was kept, and anything missing or unknown as the default', () => {
    expect(readGraphics(null)).toEqual(DEFAULT_GRAPHICS);
    expect(readGraphics('nonsense')).toEqual(DEFAULT_GRAPHICS);
    expect(readGraphics({ water: 'low', shadows: 'off', resolution: 'fast' })).toEqual({
      water: 'low',
      shadows: 'off',
      resolution: 'fast',
      daylight: 'cycle',
      fps: 'screen',
    });
    expect(readGraphics({ fps: '30' }).fps).toBe('30');
    expect(readGraphics({ fps: 144 }).fps).toBe('screen');
    expect(
      readGraphics({ water: 'low', shadows: 'off', resolution: 'fast', daylight: 'day' }).daylight,
    ).toBe('day');
    expect(readGraphics({ water: 'ultra', shadows: 'low', resolution: 7 })).toEqual({
      ...DEFAULT_GRAPHICS,
      shadows: 'low',
    });
  });

  it('names the preset the settings make, if any', () => {
    expect(presetOf(DEFAULT_GRAPHICS)).toBe('high');
    expect(presetOf({ ...DEFAULT_GRAPHICS, ...GRAPHICS_PRESETS.low })).toBe('low');
    expect(presetOf({ ...DEFAULT_GRAPHICS, shadows: 'off' })).toBeNull();
  });
});
