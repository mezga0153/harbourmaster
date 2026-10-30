import { describe, expect, it } from 'vitest';
import { DEFAULT_GRAPHICS, readGraphics } from '../src/render/graphics';

describe('Graphics settings kept in the browser', () => {
  it('reads back what was kept, and anything missing or unknown as the default', () => {
    expect(readGraphics(null)).toEqual(DEFAULT_GRAPHICS);
    expect(readGraphics('nonsense')).toEqual(DEFAULT_GRAPHICS);
    expect(readGraphics({ water: 'low', shadows: 'off', resolution: 'fast' })).toEqual({
      water: 'low',
      shadows: 'off',
      resolution: 'fast',
    });
    expect(readGraphics({ water: 'ultra', shadows: 'low', resolution: 7 })).toEqual({
      ...DEFAULT_GRAPHICS,
      shadows: 'low',
    });
  });
});
