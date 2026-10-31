import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { World } from '../src/sim/world';
import { heldView } from '../src/sim/systems/economy';
import { countWait, waitingFor } from '../src/sim/systems/boats/traffic';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe('A ship held up by one moored in its way', () => {
  function harbour() {
    const world: Any = World.create(7, 96);
    world.boats.length = 0;
    const moored: Any = { id: 1, state: 'moored', vessel: 'feeder', company: 'Blue Box Line' };
    const coming: Any = { id: 2, state: 'arriving', vessel: 'feeder', x: 10.5, y: 10.5 };
    world.boats.push(moored, coming);
    return { world, moored, coming };
  }

  it('counts the whole wait, though it creeps, and says so on its card', () => {
    const { world, moored, coming } = harbour();
    for (let k = 0; k < B.BERTH_BLOCKED_TICKS + 20; k++) {
      // Stopped by it most ticks, let on a little now and then.
      countWait(world, coming, k % 7 === 0 ? undefined : moored);
      if (k % 7 === 0) coming.x += 0.1;
    }
    expect(coming.waitingOn).toBe(1);
    expect(coming.waitedFor).toBeGreaterThan(B.BERTH_BLOCKED_TICKS);
    expect(waitingFor(world, moored)).toBe(coming);
    expect(heldView(world, coming)).toEqual({
      heldBy: 'the Blue Box Line feeder ship',
      heldFor: coming.waitedFor,
    });
  });

  it('starts again once it is well on its way, or the other has sailed', () => {
    const { world, moored, coming } = harbour();
    for (let k = 0; k < 30; k++) countWait(world, coming, moored);
    coming.x += B.WAIT_CREEP + 0.5;
    countWait(world, coming, undefined);
    expect(coming.waitedFor).toBe(0);
    expect(coming.waitingOn).toBeUndefined();
    for (let k = 0; k < 30; k++) countWait(world, coming, moored);
    moored.state = 'leaving';
    countWait(world, coming, undefined);
    expect(coming.waitedFor).toBe(0);
    expect(heldView(world, coming)).toEqual({});
  });
});
