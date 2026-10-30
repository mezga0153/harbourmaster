import { describe, expect, it } from 'vitest';
import * as B from '../src/sim/balance';
import { GameMap } from '../src/sim/map';
import { generateMap, seaDepth, SHELF_DEPTH } from '../src/sim/mapgen';
import { railColumn } from '../src/sim/railway';
import {
  exitRows,
  flowOk,
  laneLine,
  waysMeet,
  GATE_IN,
  greenAt,
  HIGHWAY_COLUMNS,
  isExit,
  LIGHT_CYCLE,
  NORTH,
  ONE_WAY,
  oneWay,
  SOUTH,
} from '../src/sim/roads';
import { laneRuns, lightsError, truckCost } from '../src/sim/rules';
import { Build, isPublicRoad, Terrain, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';

/** A truck's way from tile to tile, every tick, checked against the rules of the road. */
function watchTrucks(world: World, ticks: number, each?: (from: number, to: number) => void) {
  const m = world.map;
  const at = new Map<number, number>();
  let wrong = 0;
  let moves = 0;
  for (let k = 0; k < ticks; k++) {
    world.step();
    for (const t of world.trucks) {
      if (t.round) continue;
      const tile = m.idx(Math.floor(t.x), Math.floor(t.y));
      const was = at.get(t.id);
      at.set(t.id, tile);
      if (was === undefined || was === tile || !m.neighbors4(was).includes(tile)) continue;
      moves++;
      if (!flowOk(m, was, tile)) wrong++;
      each?.(was, tile);
    }
  }
  return { wrong, moves };
}

function signAll(world: World): void {
  for (const o of [...world.offers]) world.command({ type: 'signContract', id: o.id });
}

/** The start road's row, and a tile along it with clear land either side, away from the line. */
function roundaboutSite(world: World): { row: number; x: number } {
  const m = world.map;
  const row = m.yOf(m.entry);
  const rail = railColumn(m);
  for (let x = HIGHWAY_COLUMNS + 3; x < m.w; x++) {
    if (Math.abs(x - rail) < 4 || m.build[m.idx(x, row)] !== Build.Road) continue;
    const clear = [-1, 1].every((dy) =>
      [-1, 0, 1].every((dx) => {
        const i = m.idx(x + dx, row + dy);
        return m.build[i] === Build.None && m.isLand(i) && m.terrain[i] !== Terrain.Rock;
      }),
    );
    const along =
      [1, 2, 3].every((d) => m.build[m.idx(x + d, row)] === Build.Road) &&
      m.build[m.idx(x - 1, row)] === Build.Road;
    if (clear && along) return { row, x };
  }
  throw new Error('no room for a junction');
}

describe('The highway', () => {
  it('runs down the west edge, a carriageway each way, with the port’s road off an exit', () => {
    const { map } = generateMap(11);
    for (let y = 0; y < map.h; y++) {
      expect(map.build[map.idx(0, y)]).toBe(Build.Highway);
      expect(map.build[map.idx(1, y)]).toBe(Build.Highway);
      expect(oneWay(map, map.idx(0, y))).toBe(SOUTH);
      expect(oneWay(map, map.idx(1, y))).toBe(NORTH);
    }
    const row = map.yOf(map.entry);
    expect(exitRows(map)).toContain(row);
    expect(map.build[map.idx(HIGHWAY_COLUMNS, row)]).toBe(Build.Road);
  });

  it('is driven only its own way, and left or joined only at an exit', () => {
    const { map } = generateMap(11);
    const row = map.yOf(map.entry);
    const at = (x: number, y: number) => map.idx(x, y);
    // Down the southbound side, never up it.
    expect(flowOk(map, at(0, 5), at(0, 6))).toBe(true);
    expect(flowOk(map, at(0, 6), at(0, 5))).toBe(false);
    expect(flowOk(map, at(1, 6), at(1, 5))).toBe(true);
    // Across the middle and off, only at the exit.
    expect(flowOk(map, at(0, row), at(1, row))).toBe(true);
    expect(flowOk(map, at(1, row), at(2, row))).toBe(true);
    expect(flowOk(map, at(2, row), at(1, row))).toBe(true);
    const plain = row + 10;
    expect(flowOk(map, at(0, plain), at(1, plain))).toBe(false);
    expect(flowOk(map, at(1, plain), at(2, plain))).toBe(false);
  });

  it('brings trucks in off its ends and out again, never the wrong way or off it between exits', () => {
    const world = World.create(7, 96);
    signAll(world);
    const m = world.map;
    const ends = new Set<number>();
    const before = world.stats.trucks;
    const { wrong, moves } = watchTrucks(world, TICKS_PER_DAY * 3, (from) => {
      if (m.yOf(from) === 0 || m.yOf(from) === m.h - 1) ends.add(m.xOf(from));
    });
    expect(moves).toBeGreaterThan(100);
    expect(wrong).toBe(0);
    expect(world.stats.trucks).toBeGreaterThan(before);
    expect(ends.size).toBeGreaterThan(0);
  });

  it('lets trucks pass through each other, so nothing ever queues on it', () => {
    const world = World.create(7, 96);
    signAll(world);
    const m = world.map;
    let queued = 0;
    for (let k = 0; k < TICKS_PER_DAY * 2; k++) {
      world.step();
      for (const t of world.trucks) {
        const tile = m.idx(Math.floor(t.x), Math.floor(t.y));
        const next = t.path[0];
        // Held up on the highway, with more highway ahead.
        const onIt = m.build[tile] === Build.Highway && next !== undefined;
        if (onIt && m.build[next] === Build.Highway && (t.held ?? 0) > 5) queued++;
      }
    }
    expect(queued).toBe(0);
  });

  it('opens a new exit from the Container Port, kept apart from the others, and closes it', () => {
    const world = World.create(7, 96);
    const m = world.map;
    const row = m.yOf(m.entry);
    world.command({ type: 'exit', row: row + 20 });
    expect(isExit(m, m.idx(1, row + 20))).toBe(false); // not yet unlocked
    world.debug({ type: 'debug', tier: 2, cash: 100_000 });
    world.command({ type: 'exit', row: row + 3 });
    expect(isExit(m, m.idx(1, row + 3))).toBe(false); // too near the first
    const cash = world.cash;
    world.command({ type: 'exit', row: row + 20 });
    expect(isExit(m, m.idx(0, row + 20))).toBe(true);
    expect(isExit(m, m.idx(1, row + 20))).toBe(true);
    expect(isPublicRoad(m.build[m.idx(HIGHWAY_COLUMNS, row + 20)])).toBe(true);
    expect(world.cash).toBe(cash - B.EXIT_COST);
    world.command({ type: 'bulldoze', tiles: [m.idx(1, row + 20)] });
    expect(isExit(m, m.idx(1, row + 20))).toBe(false);
    expect(m.build[m.idx(1, row + 20)]).toBe(Build.Highway);
    // The first exit stays open.
    world.command({ type: 'bulldoze', tiles: [m.idx(0, row)] });
    expect(isExit(m, m.idx(0, row))).toBe(true);
  });

  it('opens an exit where a public road is built up to it head on, not alongside it', () => {
    const world = World.create(7, 96);
    world.debug({ type: 'debug', tier: 2, cash: 100_000 });
    const m = world.map;
    const row = m.yOf(m.entry) + 20;
    const across = [5, 4, 3, 2].map((x) => m.idx(x, row));
    world.command({ type: 'build', kind: 'road', tiles: across });
    expect(isExit(m, m.idx(1, row))).toBe(true);
    // A road along the highway opens none.
    const along = [8, 9, 10, 11, 12].map((d) => m.idx(HIGHWAY_COLUMNS, row + d));
    world.command({ type: 'build', kind: 'road', tiles: along });
    for (let d = 8; d <= 12; d++) expect(isExit(m, m.idx(1, row + d))).toBe(false);
  });

  it('is laid in a save from before it, the old roads off the map’s edge joining it at exits', () => {
    const world = World.create(5, 96);
    signAll(world);
    for (let k = 0; k < TICKS_PER_DAY; k++) world.step();
    const save = world.toSave();
    const old = save.map;
    const w = old.w;
    const rows = exitRows(world.map);
    expect(rows.length).toBe(2); // the port's and the town's
    // As saved then: the roads ran on to the map's edge, and nothing else was there.
    for (let y = 0; y < old.h; y++) {
      for (let x = 0; x < HIGHWAY_COLUMNS; x++) {
        const i = y * w + x;
        old.build[i] = rows.includes(y) ? Build.Road : Build.None;
        old.orient[i] = 0;
      }
    }
    old.entry = rows[0] * w;
    const loaded = World.fromSave(save);
    const m = loaded.map;
    expect(m.build[m.idx(0, 3)]).toBe(Build.Highway);
    expect(exitRows(m)).toEqual(rows);
    expect(m.xOf(m.entry)).toBe(HIGHWAY_COLUMNS - 1);
    const before = loaded.stats.trucks;
    const { wrong } = watchTrucks(loaded, TICKS_PER_DAY * 2);
    expect(wrong).toBe(0);
    expect(loaded.stats.trucks).toBeGreaterThan(before);
  });
});

describe('One-way roads, gates and lights', () => {
  /** A strip of road, `codes` along x on one row. */
  function strip(codes: number[]): GameMap {
    const m = new GameMap(codes.length, 1);
    codes.forEach((c, x) => {
      m.terrain[x] = Terrain.Grass;
      m.build[x] = c;
    });
    return m;
  }

  it('never lets trucks drive against a one-way road, nor turn back on it', () => {
    const m = strip([Build.Road, Build.Road, Build.Road]);
    m.orient[1] = ONE_WAY | 0; // +x
    const cost = truckCost(m);
    expect(Number.isFinite(cost(1, 0))).toBe(true);
    expect(Number.isFinite(cost(2, 1))).toBe(true);
    expect(Number.isFinite(cost(1, 2))).toBe(false);
    expect(Number.isFinite(cost(0, 1))).toBe(false);
  });

  it('lets trucks only in through an in-only gate', () => {
    const m = strip([Build.Road, Build.Gate, Build.PortRoad]);
    m.orient[1] = 2 | GATE_IN; // facing the road, at -x
    const cost = truckCost(m);
    expect(Number.isFinite(cost(1, 0))).toBe(true);
    expect(Number.isFinite(cost(2, 1))).toBe(true);
    expect(Number.isFinite(cost(1, 2))).toBe(false);
    expect(Number.isFinite(cost(0, 1))).toBe(false);
  });

  it('turns the lights green each way in turn, with all red between', () => {
    const seen: (string | null)[] = [];
    for (let t = 0; t < LIGHT_CYCLE * 3; t++) {
      const g = greenAt(5, t);
      if (seen[seen.length - 1] !== g) seen.push(g);
    }
    const greens = seen.filter((g) => g !== null);
    expect(greens.length).toBeGreaterThanOrEqual(5);
    greens.forEach((g, k) => k > 0 && expect(g).not.toBe(greens[k - 1]));
    seen.forEach((g, k) => k > 0 && g !== null && expect(seen[k - 1]).toBeNull());
  });

  /** The start road's row, and a tile along it with clear land either side, away from the line. */
  function sideRoad(world: World): { row: number; x: number } {
    const m = world.map;
    const row = m.yOf(m.entry);
    const rail = railColumn(m);
    for (let x = HIGHWAY_COLUMNS + 3; x < m.w; x++) {
      if (Math.abs(x - rail) < 3 || m.build[m.idx(x, row)] !== Build.Road) continue;
      const clear = [-1, 1].every((dy) =>
        [-1, 0, 1].every((dx) => {
          const i = m.idx(x + dx, row + dy);
          return m.build[i] === Build.None && m.isLand(i) && m.terrain[i] !== Terrain.Rock;
        }),
      );
      if (clear && m.build[m.idx(x + 1, row)] === Build.Road) return { row, x };
    }
    throw new Error('no room for a junction');
  }

  it('holds trucks at a red light and lets them through on green', () => {
    const world = World.create(7, 96);
    world.debug({ type: 'debug', tier: 2, cash: 100_000 });
    const m = world.map;
    const { row, x } = sideRoad(world);
    const side = [1, 2].map((d) => m.idx(x, row - d));
    world.command({ type: 'build', kind: 'road', tiles: side });
    const junction = m.idx(x, row);
    expect(lightsError(m, junction)).toBeNull();
    world.command({ type: 'lights', tile: junction });
    signAll(world);
    let through = 0;
    let onRed = 0;
    watchTrucks(world, TICKS_PER_DAY * 3, (from, to) => {
      if (to !== junction || m.yOf(from) !== row) return;
      through++;
      // Along the row: on green east and west, or just after, still crossing the line.
      const late = [0, 1, 2, 3, 4, 5].every((k) => greenAt(junction, world.tick - k) !== 'ew');
      if (late) onRed++;
    });
    expect(through).toBeGreaterThan(0);
    expect(onRed).toBe(0);
  });

  it('lays a roundabout round an island, which trucks drive round and never against', () => {
    const world = World.create(7, 96);
    world.debug({ type: 'debug', tier: 2, cash: 100_000 });
    const m = world.map;
    const { row, x } = sideRoad(world);
    const island = m.idx(x, row);
    world.command({ type: 'roundabout', tile: island });
    expect(m.build[island]).toBe(Build.None);
    expect(oneWay(m, m.idx(x + 1, row))).toBe(NORTH);
    expect(oneWay(m, m.idx(x - 1, row))).toBe(SOUTH);
    signAll(world);
    const before = world.stats.trucks;
    let onIsland = 0;
    const { wrong } = watchTrucks(world, TICKS_PER_DAY * 3, (_, to) => {
      if (to === island) onIsland++;
    });
    expect(wrong).toBe(0);
    expect(onIsland).toBe(0);
    expect(world.stats.trucks).toBeGreaterThan(before);
  });
});

describe('The sea off the coast', () => {
  it('shelves down past where a quay stands, then lies a fill short of it for a stretch', () => {
    const size = 192;
    for (const n of [0.2, 0.5, 0.8]) {
      const depths = Array.from({ length: 80 }, (_, d) => seaDepth(d, n, 0.5, size));
      const first = depths.findIndex((d) => d > B.MAX_QUAY_DEPTH);
      expect(first).toBeGreaterThan(8);
      // One go of filling in brings the shelf within a quay's reach.
      const shelf = depths.slice(first, first + 20);
      expect(shelf.every((d) => d - B.TERRAFORM_STEP <= B.MAX_QUAY_DEPTH)).toBe(true);
      expect(depths[79]).toBeGreaterThan(SHELF_DEPTH + 5);
    }
  });
});

describe('Giving way at junctions', () => {
  const L = B.TRUCK_LANE;
  const E: [number, number] = [1, 0];
  const W: [number, number] = [-1, 0];
  const N: [number, number] = [0, -1];
  const S: [number, number] = [0, 1];

  it('knows which ways across a junction meet and which pass', () => {
    // Off a roundabout and onto it at the same arm, both turning right.
    expect(waysMeet(laneLine(N, E, L), laneLine(W, N, L))).toBe(false);
    // Into a side road turning left as another turns right out of it.
    expect(waysMeet(laneLine(E, N, L), laneLine(S, W, L))).toBe(false);
    // Passing each other straight on.
    expect(waysMeet(laneLine(E, E, L), laneLine(W, W, L))).toBe(false);
    // Across each other, onto the same lane, and turning left across oncoming traffic.
    expect(waysMeet(laneLine(E, E, L), laneLine(S, S, L))).toBe(true);
    expect(waysMeet(laneLine(N, E, L), laneLine(E, E, L))).toBe(true);
    expect(waysMeet(laneLine(E, N, L), laneLine(W, W, L))).toBe(true);
  });

  /** A truck like those the game sends, standing at `x, y` heading `dir`, on its way along `path`. */
  function truckAt(world: World, x: number, y: number, dir: number, path: number[]) {
    const t = {
      id: world.nextId++,
      contractId: -1,
      company: 'Test',
      capacity: 6,
      x: x + 0.5,
      y: y + 0.5,
      dir,
      path,
      goal: path[path.length - 1],
      state: 'toBay',
      bayIdx: -1,
      cargo: 0,
      value: 0,
      boxes: false,
      idle: 0,
      timer: 0,
      variant: 0,
      held: 0,
    };
    world.trucks.push(t as never);
    return t;
  }

  it('lets one truck turn off a roundabout while another turns on there, in the other lane', () => {
    const world = World.create(7, 96);
    world.debug({ type: 'debug', tier: 2, cash: 100_000 });
    world.trucks.length = 0;
    const m = world.map;
    const { row, x } = roundaboutSite(world);
    world.command({ type: 'roundabout', tile: m.idx(x, row) });
    const junction = m.idx(x + 1, row);
    const leaving = truckAt(world, x + 1, row + 1, -Math.PI / 2, [
      junction,
      m.idx(x + 2, row),
      m.idx(x + 3, row),
    ]);
    const entering = truckAt(world, x + 2, row, Math.PI, [junction, m.idx(x + 1, row - 1)]);
    const may = (t: unknown) => world['mayEnter'](t as never)(junction);
    expect(may(leaving)).toBe(true);
    expect(may(entering)).toBe(true);
    // Nor does either queue behind the other as it drives across.
    const gap = (t: unknown) => world['gapAhead'](t as never) as number;
    expect(gap(entering)).toBeGreaterThan(1);
    expect(gap(leaving)).toBeGreaterThan(1);
  });

  it('lets one still rounding the corner before the arm it turns off at by one come on there', () => {
    const world = World.create(7, 96);
    world.debug({ type: 'debug', tier: 2, cash: 100_000 });
    world.trucks.length = 0;
    const m = world.map;
    const { row, x } = roundaboutSite(world);
    world.command({ type: 'roundabout', tile: m.idx(x, row) });
    const corner = m.idx(x + 1, row + 1);
    const junction = m.idx(x + 1, row);
    // Into the corner heading east, turning north for the arm off to the east.
    const leaving = truckAt(world, x + 1, row + 1, -1.2, [
      junction,
      m.idx(x + 2, row),
      m.idx(x + 3, row),
    ]);
    leaving.x -= 0.28;
    leaving.y -= 0.28;
    // On from the east, turned north already, past where the other turns off.
    const entering = truckAt(world, x + 1, row, -1.9, [m.idx(x + 1, row - 1)]);
    entering.x += 0.22;
    entering.y -= 0.32;
    const came = world['cameFrom'] as Map<number, { tile: number; from: number }>;
    came.set(leaving.id, { tile: corner, from: m.idx(x, row + 1) });
    came.set(entering.id, { tile: junction, from: m.idx(x + 2, row) });
    world['gapAhead'](leaving as never);
    expect((leaving as { blocker?: number }).blocker).not.toBe(entering.id);
  });

  it('lets one truck turn into a side road while another turns out of it', () => {
    const world = World.create(7, 96);
    world.debug({ type: 'debug', tier: 2, cash: 100_000 });
    world.trucks.length = 0;
    const m = world.map;
    const { row, x } = roundaboutSite(world);
    world.command({ type: 'build', kind: 'road', tiles: [m.idx(x, row - 1), m.idx(x, row - 2)] });
    const junction = m.idx(x, row);
    // In from the west along the main road, turning left up the side road.
    const turningIn = truckAt(world, x - 1, row, 0, [junction, m.idx(x, row - 1)]);
    // Down the side road, turning right towards the west.
    const turningOut = truckAt(world, x, row - 1, Math.PI / 2, [junction, m.idx(x - 1, row)]);
    const may = (t: unknown) => world['mayEnter'](t as never)(junction);
    expect(may(turningIn)).toBe(true);
    expect(may(turningOut)).toBe(true);
    // One turning out left, onto the lane a truck from the west is driving along, gives way to it.
    turningOut.path = [junction, m.idx(x + 1, row)];
    expect(may(turningOut)).toBe(false);
  });
});

describe('Round a bend', () => {
  /** An L of public road on clear land: along a row from the west, then down. */
  function bend(world: World): number[] {
    const m = world.map;
    for (let y = 5; y < m.limit - 12; y++) {
      for (let x = HIGHWAY_COLUMNS + 2; x < 40; x++) {
        let ok = true;
        for (let dy = -1; dy <= 9 && ok; dy++) {
          for (let dx = -1; dx <= 9 && ok; dx++) {
            const i = m.idx(x + dx, y + dy);
            ok = m.build[i] === Build.None && m.isLand(i) && m.terrain[i] !== Terrain.Rock;
          }
        }
        if (!ok) continue;
        const way: number[] = [];
        for (let k = 0; k <= 8; k++) way.push(m.idx(x + k, y));
        for (let k = 1; k <= 8; k++) way.push(m.idx(x + 8, y + k));
        for (const i of way) m.build[i] = Build.Road;
        world['junctionCache'] = null;
        world['turnCache'] = null;
        world['reachCache'] = null;
        return way;
      }
    }
    throw new Error('no room for a bend');
  }

  /** A big truck leaving along `way` from its first tile, facing `dir`. */
  function driving(world: World, way: number[], dir: number) {
    const m = world.map;
    const t = {
      id: world.nextId++,
      contractId: -1,
      company: 'Test',
      capacity: B.BIG_TRUCK_CAPACITY,
      x: m.xOf(way[0]) + 0.5,
      y: m.yOf(way[0]) + 0.5,
      dir,
      path: way.slice(1),
      goal: way[way.length - 1],
      state: 'leaving',
      bayIdx: -1,
      cargo: 0,
      value: 0,
      boxes: false,
      idle: 0,
      timer: 0,
      variant: 0,
      held: 0,
    };
    world.trucks.push(t as never);
    return t;
  }

  it('has trucks going opposite ways round it keep to their sides, never stopping for each other', () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    const way = bend(world);
    const a = driving(world, way, 0);
    const b = driving(world, [...way].reverse(), -Math.PI / 2);
    let held = 0;
    for (let k = 0; k < 60; k++) {
      world.step();
      for (const t of [a, b]) if ((t.held ?? 0) > 0 && t.path.length > 0) held++;
    }
    expect(held).toBe(0);
  });

  it('has a truck following another round it keep its distance', () => {
    const world = World.create(7, 96);
    world.trucks.length = 0;
    const way = bend(world);
    const lead = driving(world, way.slice(1), 0);
    const next = driving(world, way, 0);
    let closest = Infinity;
    for (let k = 0; k < 60 && world.trucks.length === 2; k++) {
      world.step();
      closest = Math.min(closest, Math.hypot(lead.x - next.x, lead.y - next.y));
    }
    expect(closest).toBeGreaterThan(world['lengthOf'](lead as never) * 0.75);
  });
});

describe('Keeping right', () => {
  /** Public road `wide` tiles across, along x, on an otherwise empty map 8 long. */
  function road(wide: number): GameMap {
    const m = new GameMap(8, wide + 2);
    for (let i = 0; i < m.build.length; i++) m.terrain[i] = Terrain.Grass;
    for (let y = 1; y <= wide; y++) for (let x = 0; x < 8; x++) m.build[m.idx(x, y)] = Build.Road;
    return m;
  }
  /** What a tile in row `y` costs going +x along it (whose right is +y), and going -x. */
  const costs = (m: GameMap, y: number, runs?: Uint8Array) => {
    const cost = truckCost(m, -1, -1, undefined, runs);
    return [cost(m.idx(4, y), m.idx(3, y)), cost(m.idx(3, y), m.idx(4, y))];
  };

  it('keeps to the right-hand lane of a road two wide', () => {
    const m = road(2);
    // Going +x the right is +y: row 2 is its lane, row 1 the oncoming one.
    expect(costs(m, 2)[0]).toBe(1);
    expect(costs(m, 1)[0]).toBeGreaterThan(1);
    expect(costs(m, 1)[1]).toBe(1);
    expect(costs(m, 2)[1]).toBeGreaterThan(1);
  });

  it('on a road wider than two, keeps only off the far half of it, not to the very edge', () => {
    const m = road(5);
    const going = [1, 2, 3, 4, 5].map((y) => costs(m, y)[0]);
    // The left two rows are the oncoming half; the middle and right are its own.
    expect(going.map((c) => c > 1)).toEqual([true, true, false, false, false]);
    const back = [1, 2, 3, 4, 5].map((y) => costs(m, y)[1]);
    expect(back.map((c) => c > 1)).toEqual([false, false, false, true, true]);
    // The same worked out ahead for the whole map, as the game does.
    const runs = laneRuns(m);
    expect([1, 2, 3, 4, 5].map((y) => costs(m, y, runs)[0])).toEqual(going);
    expect([1, 2, 3, 4, 5].map((y) => costs(m, y, runs)[1])).toEqual(back);
  });

  it('has no lane to keep to on a one-way road', () => {
    const m = road(2);
    for (let x = 0; x < 8; x++) for (const y of [1, 2]) m.orient[m.idx(x, y)] = ONE_WAY | 0;
    expect(costs(m, 1)[0]).toBe(1);
    expect(costs(m, 2)[0]).toBe(1);
  });
});
