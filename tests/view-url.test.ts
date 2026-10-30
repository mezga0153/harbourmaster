import { describe, expect, it } from 'vitest';
import { IsoCamera } from '../src/render/camera';
import { applyView, readView, viewHash, viewOf } from '../src/view-url';

describe('The view in the address', () => {
  it('writes where the camera looks and reads it back', () => {
    const cam = new IsoCamera();
    cam.setBounds(192, 192);
    applyView(cam, { seed: 844241, x: 30.64, y: 52.81, zoom: 21.37, turns: 3 });
    const hash = viewHash(viewOf(cam, 844241), '');
    expect(hash).toBe('#view=844241,30.6,52.8,21.4,3');
    expect(readView(hash)).toEqual({ seed: 844241, x: 30.6, y: 52.8, zoom: 21.4, turns: 3 });
  });

  it('keeps anything else in the hash, and ignores a broken view', () => {
    const v = { seed: 7, x: 1, y: 2, zoom: 16, turns: 0 };
    expect(viewHash(v, '#other=1')).toBe('#other=1&view=7,1,2,16,0');
    expect(readView('#view=7,1,2')).toBeNull();
    expect(readView('#view=7,a,2,16,0')).toBeNull();
    expect(readView('')).toBeNull();
  });

  it('holds a view from the address within the map and the zoom limits', () => {
    const cam = new IsoCamera();
    cam.setBounds(96, 96);
    applyView(cam, { seed: 1, x: 500, y: -4, zoom: 9999, turns: 6 });
    expect(cam.target.x).toBe(96);
    expect(cam.target.z).toBe(0);
    expect(cam.viewSize).toBeLessThan(9999);
    expect(cam.turns).toBe(2);
  });
});
