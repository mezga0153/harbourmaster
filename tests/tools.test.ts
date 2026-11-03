import { describe, expect, it } from 'vitest';
import { keyAction, panelKey, SHORTCUTS, SPEEDS } from '../src/input/keys';
import { CAMERA_KEYS, TOOL_KEYS } from '../src/ui/tools';

describe('tool shortcuts', () => {
  it('leaves the camera keys alone', () => {
    for (const k of CAMERA_KEYS) expect(TOOL_KEYS[k]).toBeUndefined();
  });

  it('never share a key with the table of fixed shortcuts', () => {
    for (const s of SHORTCUTS) expect(TOOL_KEYS[s.key]).toBeUndefined();
  });
});

describe('the keyboard table', () => {
  const press = (key: string, shiftKey = false) => ({ key, shiftKey }) as KeyboardEvent;

  it('gives the speeds in the order of their number keys, and the panels their hints', () => {
    expect(SPEEDS.map((s) => s.speed)).toEqual([1, 2, 4, 8]);
    expect(SPEEDS.map((s) => s.key)).toEqual(['1', '2', '3', '4']);
    expect(panelKey('staff')).toBe('H');
    expect(panelKey('handbook')).toBe('?');
    expect(panelKey('stats')).toBeUndefined();
  });

  it('reads a key press: fixed keys first, then the tools the port has come to', () => {
    expect(keyAction(press('3'), 0, false)).toEqual({ type: 'speed', speed: 4 });
    expect(keyAction(press('?', true), 0, false)).toEqual({ type: 'panel', panel: 'handbook' });
    expect(keyAction(press('Delete'), 0, false)).toEqual({
      type: 'tool',
      tool: 'bulldoze',
      toggle: false,
    });
    expect(keyAction(press('b'), 0, false)).toEqual({
      type: 'tool',
      tool: 'bulldoze',
      toggle: true,
    });
    // Shift+M is a million, on the dev server and in the published game; M alone the finance panel.
    expect(keyAction(press('M', true), 0, true)).toEqual({ type: 'debugCash' });
    expect(keyAction(press('M', true), 0, false)).toEqual({ type: 'debugCash' });
    expect(keyAction(press('M'), 0, false)).toEqual({ type: 'panel', panel: 'finance' });
    expect(keyAction(press('x'), 0, false)).toBeNull();
  });
});
