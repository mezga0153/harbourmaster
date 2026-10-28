import { describe, expect, it } from 'vitest';
import { report } from '../src/debug/report';
import { TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';

declare const process: { env: Record<string, string | undefined> };

/**
 * Loads the game the dev bridge last mirrored into .debug/save.json and
 * prints the same report the browser writes, optionally after running it on
 * for a few days. Skipped unless asked for:
 *
 *   HM_SAVE=1 [HM_DAYS=2] npx vitest run tests/debug-save.test.ts --silent=false
 */
const saves = import.meta.glob('../.debug/save.json', { eager: true, import: 'default' });
const save = Object.values(saves)[0];

describe.skipIf(!process.env.HM_SAVE)('Mirrored save', () => {
  it('loads and reports', () => {
    expect(save, 'no .debug/save.json: is the game open on the dev server?').toBeDefined();
    expect(World.isValidSave(save)).toBe(true);
    const world = World.fromSave(save as Parameters<typeof World.fromSave>[0]);
    const days = Number(process.env.HM_DAYS ?? 0);
    for (let t = 0; t < days * TICKS_PER_DAY; t++) world.step();
    console.log(report(world.snapshot(), { width: world.map.w }));
  });
});
