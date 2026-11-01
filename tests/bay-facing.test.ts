import { describe, expect, it } from 'vitest';
import { bayTrouble, bestFacing, frontOf, placementError } from '../src/sim/rules';
import { problems } from '../src/sim/systems/snapshot';
import { faceRoads } from '../src/sim/systems/roads/bays';
import { Build } from '../src/sim/types';
import { World } from '../src/sim/world';

/** The first port's truck bay, with port road behind it as well as the public road in front. */
function port() {
  const w = World.create(7, 96);
  const m = w.map;
  const bay = m.build.findIndex((b) => b === Build.TruckBay);
  const front = m.orient[bay] & 3;
  expect(m.build[frontOf(m, bay, front)]).toBe(Build.Road);
  const back = frontOf(m, bay, (front + 2) & 3);
  m.build[back] = Build.PortRoad;
  return { w, m, bay, front, back };
}

describe('Truck bays', () => {
  it('go up facing the public road rather than a port road', () => {
    const { m, bay, front } = port();
    m.build[bay] = Build.None;
    expect(bestFacing(m, 'truckBay', bay)).toBe(front);
  });

  it('turn round to face the public road once nothing is coming to them', () => {
    const { w, m, bay, front } = port();
    m.orient[bay] = (m.orient[bay] & ~3) | ((front + 2) & 3);
    w.bays.get(bay)!.name = 'B1';
    // A truck on its way holds it as it is.
    const truck = { bayIdx: bay } as (typeof w.trucks)[number];
    w.trucks.push(truck);
    expect(faceRoads(w)).toBe(false);
    w.trucks = w.trucks.filter((t) => t !== truck);
    for (const p of w.people) p.state = 'idle';
    expect(faceRoads(w)).toBe(true);
    expect(m.orient[bay] & 3).toBe(front);
    expect(w.dirty.has(bay)).toBe(true);
  });

  it('go up anywhere, with a red mark saying why where there is no road in front or way in behind', () => {
    const { w, m, bay, front, back } = port();
    // Facing away from the road, onto a path: allowed, but marked.
    m.build[back] = Build.Footpath;
    m.build[bay] = Build.None;
    const away = (front + 2) & 3;
    expect(placementError(m, 'truckBay', bay, undefined, away)).toBeNull();
    m.build[bay] = Build.TruckBay;
    m.orient[bay] = (m.orient[bay] & ~3) | away;
    expect(bayTrouble(m, bay, away)).toMatch(/No road in front/);
    const mark = problems(w).find((p) => p.type === 'bay' && p.idx === bay);
    expect(mark?.text).toMatch(/No road in front/);
    // Facing the road with nothing behind: marked for those who load it.
    m.orient[bay] = (m.orient[bay] & ~3) | front;
    m.build[back] = Build.None;
    expect(bayTrouble(m, bay, front)).toMatch(/behind it/);
    // Both: no mark.
    m.build[back] = Build.Footpath;
    expect(bayTrouble(m, bay, front)).toBeNull();
    expect(problems(w).some((p) => p.type === 'bay' && p.idx === bay)).toBe(false);
  });
});
