import { describe, expect, it } from 'vitest';
import { CAMERA_KEYS, TOOL_KEYS } from '../src/ui/tools';

describe('tool shortcuts', () => {
  it('leaves the camera keys alone', () => {
    for (const k of CAMERA_KEYS) expect(TOOL_KEYS[k]).toBeUndefined();
  });
});
