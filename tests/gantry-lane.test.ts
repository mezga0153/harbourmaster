import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { Build } from '../src/sim/types';
import { World } from '../src/sim/world';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * A world with a yard gantry's lane faked onto it: seven tiles down x = X
 * from y = Y0, the gantry at the middle one, the outgoing yard beside it,
 * and the road off the north end a shorter way to the highway than the south.
 */
function laneWorld(reachNorth = 5, reachSouth = 20) {
  const world: Any = World.create(7, 96);
  world.trucks.length = 0;
  world.people.length = 0;
  const m = world.map;
  const X = 10;
  const Y0 = 10;
  const tiles: number[] = Array.from({ length: 7 }, (_, k) => m.idx(X, Y0 + k));
  for (const t of tiles) m.build[t] = Build.PortRoad;
  const lane = new Map(tiles.map((t, k) => [t, k - 3]));
  const yard = {
    idx: m.idx(X + 1, Y0),
    tiles: Array.from({ length: 7 }, (_, k) => m.idx(X + 1, Y0 + k)),
    yard: true,
    outgoing: true,
    boxes: [],
    crates: [],
    boxIncoming: 0,
    incoming: 0,
    boxReady: [],
  };
  world.yards.set(yard.idx, yard);
  world.gantryLane = (b: Any) => (b === yard ? lane : null);
  world.loadingDocks = (b: Any) => (b === yard ? [...tiles] : []);
  world.storeSpots = world.loadingDocks;
  world.yardGantry = (b: Any) => b === yard;
  const north = m.idx(X, Y0 - 1);
  const south = m.idx(X, Y0 + 7);
  world.laneCache = null;
  // Off the north end it is `reachNorth` tiles to the highway, off the south
  // `reachSouth`, or no way at all below zero; and every spot has a way out.
  world.drivePath = (from: number) => {
    const n = from === north ? reachNorth : from === south ? reachSouth : 1;
    return n < 0 ? null : Array.from({ length: n }, () => tiles[6]);
  };
  const truck = (
    goal: number,
    state: string,
    at: number,
    more: Record<string, unknown> = {},
  ): Any => ({
    id: world.nextId++,
    contractId: 0,
    company: 'Test',
    capacity: 1,
    x: m.xOf(at) + 0.5,
    y: m.yOf(at) + 0.5,
    dir: Math.PI / 2,
    path: [] as number[],
    goal,
    state,
    bayIdx: yard.idx,
    cargo: 1,
    value: 0,
    boxes: true,
    exports: true,
    idle: 0,
    timer: 0,
    variant: 0,
    ...more,
  });
  return { world, m, tiles, yard, north, south, truck, X, Y0 };
}

describe('A yard gantry’s lane', () => {
  it('is one way for trucks: in at the end nearer the highway, out at the other', () => {
    const { world, m, tiles, north, south, X, Y0 } = laneWorld();
    const ways = world.laneWays();
    expect(ways.size).toBe(7);
    expect(ways.get(tiles[0])).toEqual([0, 1]);
    const cost = world.laneCost(() => 1);
    // Along it, in at the north end and out at the south.
    expect(cost(tiles[1], tiles[0])).toBe(1);
    expect(cost(tiles[0], north)).toBe(1);
    expect(cost(south, tiles[6])).toBe(1);
    // Never back up it, in at the south end, or out at the north.
    expect(cost(tiles[0], tiles[1])).toBe(Infinity);
    expect(cost(tiles[6], south)).toBe(Infinity);
    expect(cost(north, tiles[0])).toBe(Infinity);
    // Off it sideways is fine, where there is a road.
    expect(cost(m.idx(X - 1, Y0 + 3), tiles[3])).toBe(1);
    // With no `from`, as a path search starts, the base cost stands.
    expect(cost(tiles[0])).toBe(1);
  });

  it('runs the other way when the south end is nearer the highway, and both ways with a way out at one end only', () => {
    const a = laneWorld(20, 5);
    expect(a.world.laneWays().get(a.tiles[0])).toEqual([0, -1]);
    // With no way on from the far end, trucks drive in and back out again.
    const b = laneWorld(5, -1);
    expect(b.world.laneWays().size).toBe(0);
    const c = laneWorld(-1, 20);
    expect(c.world.laneWays().size).toBe(0);
  });

  it('sends a truck to the deepest free spot past one on its way in, to queue behind it', () => {
    const { world, tiles, north, truck } = laneWorld();
    // One about to pull in at the first spot.
    world.trucks.push(truck(tiles[0], 'toBay', north, { path: [tiles[0]] }));
    const route = (dock: number) => [north, ...tiles.slice(0, tiles.indexOf(dock) + 1)];
    const to = world.dockFor(world.yards.get(world.yards.keys().next().value), route, 1.18);
    expect(to?.dock).toBe(tiles[6]);
    // The next spot along is no good for a truck longer than a tile.
    expect(world.freeDockSet([...world.yards.values()][0], 1.18).has(tiles[1])).toBe(false);
    // Along a lane trucks drive both ways, it would stand in that one's way: it waits.
    world.laneWays = () => new Map();
    expect(world.dockFor([...world.yards.values()][0], route, 1.18)).toBeNull();
  });

  it('has a truck in the lane pull in short of one standing in its way, and go on deeper as it clears', () => {
    const { world, tiles, yard, north, truck } = laneWorld();
    const t = truck(tiles[6], 'toBay', north, { path: [...tiles] });
    const standing = truck(tiles[4], 'delivering', tiles[4]);
    world.trucks.push(t, standing);
    world.alongLane(t, yard);
    // Short of the one standing, and not right up against it.
    expect(t.goal).toBe(tiles[2]);
    expect(t.path).toEqual(tiles.slice(0, 3));
    // Once that one has gone, on to the far end.
    world.trucks = [t];
    world.alongLane(t, yard);
    expect(t.goal).toBe(tiles[6]);
    expect(t.path).toEqual([...tiles]);
    // A tractor standing for the gantry is in the way as a truck is.
    world.people.push({
      id: 99,
      kind: 'tractor',
      state: 'picking',
      stockIdx: yard.idx,
      bayIdx: -1,
      x: 10.5,
      y: 14.5,
      goal: tiles[4],
      path: [],
    });
    world.alongLane(t, yard);
    expect(t.goal).toBe(tiles[2]);
  });

  it('has a tractor pull in clear of the trucks’ spots, taken or being come to', () => {
    const { world, tiles, yard, truck } = laneWorld();
    world.spotTaken = () => false;
    world.pathFor = () => [tiles[3]];
    const p = { id: 1, kind: 'tractor', state: 'toPickup', stockIdx: yard.idx, bayIdx: -1 };
    // Nearest the gantry with no truck about.
    expect(world.tractorSpot(p, yard, tiles[0])).toBe(tiles[3]);
    // Not where a truck stands, nor where one is on its way to.
    world.trucks.push(truck(tiles[3], 'delivering', tiles[3]));
    expect(world.tractorSpot(p, yard, tiles[0])).toBe(tiles[2]);
    world.trucks.push(truck(tiles[2], 'toBay', tiles[0], { path: [tiles[1], tiles[2]] }));
    expect(world.tractorSpot(p, yard, tiles[0])).toBe(tiles[4]);
  });
});

describe('A shipper’s truck waiting for a spot', () => {
  function staging() {
    const w = laneWorld();
    const { world, m, X, Y0 } = w;
    const far = m.idx(X, Y0 + 40);
    const near = m.idx(X + 5, Y0 + 3);
    const space = { tiles: [near], ends: [near - 1, near + 1] as [number, number] };
    world.freeParking = () => space;
    world.routeFrom = (_t: unknown, goal: number) => [goal];
    world.exportStore = () => null;
    world.outgoingRoom = () => true;
    const outside = w.truck(far, 'parked', far, {
      bayIdx: -1,
      papers: 0,
      park: far,
      lot: [far],
      parkFrom: far - 1,
    });
    world.trucks.push(outside);
    return { ...w, outside, near, space };
  }

  it('moves to parking much nearer the storage, inside the port, to be there when a spot comes free', () => {
    const { world, outside, yard, near, space } = staging();
    world.stageNearer(outside);
    expect(outside.state).toBe('toPark');
    expect(outside.staged).toBe(yard.idx);
    expect(outside.park).toBe(near);
    // Through the new space first, and the old one to get out of it.
    expect(outside.lot?.slice(0, 1)).toEqual(space.tiles);
    expect(outside.goal).toBe(near);
  });

  it('stays put when the nearer parking is not much nearer, or as many as the storage has spots wait there', () => {
    const a = staging();
    a.world.distTo = () => 10;
    a.world.stageNearer(a.outside);
    expect(a.outside.state).toBe('parked');
    const b = staging();
    for (let k = 0; k < b.world.loadingDocks(b.yard).length; k++) {
      b.world.trucks.push(b.truck(b.near, 'parked', b.near, { staged: b.yard.idx }));
    }
    b.world.stageNearer(b.outside);
    expect(b.outside.state).toBe('parked');
    expect(b.outside.staged).toBeUndefined();
  });

  it('lets one waiting near the storage take the spot before one far off outside the port', () => {
    const { world, outside, yard, tiles, near, truck } = staging();
    const staged = truck(near, 'parked', near, {
      bayIdx: -1,
      papers: 0,
      park: near,
      lot: [near],
      staged: yard.idx,
    });
    world.trucks.push(staged);
    world.exportStore = () => ({ store: yard, dock: tiles[6], path: [tiles[6]] });
    world.handlerFree = () => true;
    world.freeParking = () => null;
    // On their turn, every tenth tick.
    world.tick = 10 - (outside.id % 10);
    world.updateTruck(outside);
    expect(outside.state).toBe('parked');
    world.tick = 10 - (staged.id % 10) + 10;
    world.updateTruck(staged);
    expect(staged.state).toBe('toBay');
    expect(staged.staged).toBeUndefined();
    expect(staged.goal).toBe(tiles[6]);
    // With no one waiting near any more, the one outside goes.
    world.tick = 10 - (outside.id % 10) + 20;
    world.updateTruck(outside);
    expect(outside.state).toBe('toBay');
  });

  it('counts a tile nearer by the staging margin', () => {
    expect(B.STAGE_NEARER_BY).toBeGreaterThan(0);
  });
});
