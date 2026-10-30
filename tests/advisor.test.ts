import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';

/** Tips the advisor gives over `days`, in order, and boats gone meanwhile. */
function run(world: World, days: number, until?: (tips: string[]) => boolean): string[] {
  const tips: string[] = [];
  for (let t = 0; t < days * TICKS_PER_DAY; t++) {
    world.step();
    for (const ev of world.drainEvents()) if (ev.kind === 'tip') tips.push(ev.id);
    if (until?.(tips)) break;
  }
  return tips;
}

const FIRST = ['speed', 'jetty', 'contract', 'screens'];

describe('The advisor’s first steps', () => {
  it('teach a boat at a time, and a break hut once someone is tired', () => {
    const world = World.create(7, 96);
    const tips = run(world, 20, (t) => t.includes('screens') && t.includes('hut'));
    expect(tips.filter((t) => FIRST.includes(t))).toEqual(FIRST);
    expect(tips).toContain('hut');
  });

  it('skip what the player has already done', () => {
    const world = World.create(7, 96);
    world.command({ type: 'setSpeed', speed: 4 });
    world.command({ type: 'learnt', tip: 'screens' });
    const tips = run(world, 20, (t) => t.includes('contract'));
    // The first boat out teaches nothing; the jetty comes with the second.
    expect(tips.filter((t) => FIRST.includes(t))).toEqual(['jetty', 'contract']);
  });

  it('come over again after a save', () => {
    const world = World.create(7, 96);
    run(world, 20, (t) => t.includes('jetty'));
    const back = World.fromSave(world.toSave());
    const tips = run(back, 20, (t) => t.includes('screens'));
    expect(tips.filter((t) => FIRST.includes(t))).toEqual(['contract', 'screens']);
  });
});
