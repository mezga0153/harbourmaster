import * as B from '../sim/balance';
import type { GameMap } from '../sim/map';
import { exitError, hasLights, HIGHWAY_COLUMNS, oneWay, stepFacing } from '../sim/roads';
import {
  anchorOf,
  FACING,
  flowFor,
  gateWay,
  lightsError,
  nextParkWay,
  oneWayError,
  PARK_FLIP,
  PARK_MIRROR,
  parkingLots,
  ROUNDABOUT_RING,
  roundaboutCost,
  roundaboutError,
} from '../sim/rules';
import { TIERS } from '../sim/tiers';
import { Build } from '../sim/types';
import type { RoadTool } from '../ui/tools';
import type { PreviewResult } from './types';

// The rules of the road: one-way roads, gates' ways, lights, roundabouts
// and exits off the highway.

/** The gate's next way, clicking round: both ways, in only, out only. */
export function nextGateWay(map: GameMap, i: number): 'both' | 'in' | 'out' {
  const now = gateWay(map, anchorOf(map, i));
  return now === 'both' ? 'in' : now === 'in' ? 'out' : 'both';
}

/** What a road tool would do here, what it costs, and why not if it cannot. */
export function previewRoad(
  map: GameMap,
  tier: number,
  t: RoadTool,
  tiles: number[],
): PreviewResult {
  const need =
    t === 'highwayExit'
      ? B.EXIT_TIER
      : t === 'lights' || t === 'roundabout'
        ? B.LIGHTS_TIER
        : B.ONE_WAY_TIER;
  const locked = tier < need ? `Unlocks at the ${TIERS[need].name}` : null;
  const i = tiles[tiles.length - 1];
  let shown = [i];
  let ok = [false];
  let value = 0;
  let error: string | null = null;
  let note: string | undefined;
  let arrow: { at: number; facing: number } | null = null;
  if (t === 'oneWay' && map.build[i] === Build.Parking) {
    // Truck parking: its lot turned the next way round, free; the arrow
    // shows which way trucks will come in across it.
    const lot = parkingLots(map).find((l) => l.tiles.includes(i));
    shown = lot ? lot.tiles : [i];
    ok = shown.map(() => !!lot?.flow);
    if (lot?.flow) {
      const next = nextParkWay(map, lot.tiles);
      const acrossY = lot.flow.across[1] !== 0;
      const flow = flowFor(acrossY, (next & PARK_FLIP) !== 0, (next & PARK_MIRROR) !== 0);
      const facing = FACING.findIndex(([x, y]) => x === flow.across[0] && y === flow.across[1]);
      arrow = { at: i, facing };
      const mirrored =
        (next & PARK_MIRROR) !==
        (lot.tiles.some((k) => map.orient[k] & PARK_MIRROR) ? PARK_MIRROR : 0);
      note = mirrored
        ? `Click to have its spaces lean the other way: trucks will turn in ${next & PARK_MIRROR ? 'left, across the traffic' : 'right, keeping right'}`
        : 'Click to turn it round: trucks will come in off the other road';
    } else error = lot?.why ?? 'Not a lot trucks can park in yet';
  } else if (t === 'oneWay') {
    shown = tiles;
    ok = tiles.map((k) => !oneWayError(map, k));
    const count = ok.filter(Boolean).length;
    value = -count * B.ONE_WAY_COST;
    error = count > 0 ? null : oneWayError(map, tiles[0]);
    if (tiles.length > 1) {
      arrow = { at: i, facing: stepFacing(map, tiles[tiles.length - 2], i) };
      note = 'Traffic will go the way you drag';
    } else if (oneWay(map, i) >= 0) {
      arrow = { at: i, facing: oneWay(map, i) ^ 2 };
      note = 'Click to turn it round';
    } else note = 'Drag along the road the way the traffic should go';
  } else if (t === 'highwayExit') {
    const y = map.yOf(i);
    shown = Array.from({ length: HIGHWAY_COLUMNS + 1 }, (_, x) => map.idx(x, y));
    error =
      map.xOf(i) > HIGHWAY_COLUMNS ? 'Click the highway, down the west edge' : exitError(map, y);
    ok = shown.map(() => !error);
    value = -B.EXIT_COST;
  } else if (t === 'lights') {
    error = lightsError(map, i);
    ok = [!error];
    const on = hasLights(map, i);
    value = on ? 0 : -B.LIGHTS_COST;
    if (on && !error) note = 'Click to take them down';
  } else if (t === 'roundabout') {
    const inside =
      map.xOf(i) >= 1 && map.yOf(i) >= 1 && map.xOf(i) < map.w - 1 && map.yOf(i) < map.h - 1;
    shown = inside
      ? [i, ...ROUNDABOUT_RING.map(([dx, dy]) => map.idx(map.xOf(i) + dx, map.yOf(i) + dy))]
      : [i];
    error = inside ? roundaboutError(map, i) : 'Too near the edge of the map';
    ok = shown.map(() => !error);
    value = error ? 0 : -roundaboutCost(map, i);
    note = 'The island goes on the tile you click';
  } else {
    const gate = map.build[anchorOf(map, i)] === Build.Gate;
    error = gate ? null : 'Click a port gate';
    ok = [gate];
    if (gate) {
      const next = nextGateWay(map, i);
      note =
        next === 'both'
          ? 'Click to let trucks through both ways'
          : `Click to let trucks only ${next}`;
      value = -B.GATE_WAY_COST;
    }
  }
  if (locked) {
    error = locked;
    ok = ok.map(() => false);
  }
  return {
    ghosts: { tiles: shown, ok },
    arrow,
    hints: [],
    preview: {
      count: error ? 0 : ok.filter(Boolean).length,
      rotatable: false,
      value,
      error,
      note,
    },
  };
}
