import {
  ConeGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  TorusGeometry,
  type Object3D,
} from 'three';
import type { GameMap } from '../../sim/map';
import { DEPOT_BACK } from '../../sim/machines';
import { hash01 } from '../../sim/noise';
import { hasHighway, hasLights, HIGHWAY_COLUMNS, isExit, oneWay } from '../../sim/roads';
import {
  EXTENSION,
  FACING,
  forksAlongZ,
  isTrack,
  machinesOnly,
  ON_QUAY,
  type ParkingFlow,
} from '../../sim/rules';
import { RAILS } from '../../sim/orient';
import { railColumn } from '../../sim/railway';
import { TOWN } from '../../sim/town';
import { Build, isDock, storesBoxes, storesOutgoing } from '../../sim/types';
import { BOX_HEIGHT } from '../assets';
import type { Owns } from '../keyed';
import { container, crate, CRATE } from '../models';
import { C } from '../palette';
import { box, cyl, mat } from '../parts';
import { DECK_Y, MARGIN, QUAY_Y, SEABED, landTop } from '../terrain';
import { bake, pavements, townBuilding } from '../town';
import { unitBox } from '../util/mesh';
import { makeHarbourCrane } from './cranes/harbourCrane';
import { makeJibCrane } from './cranes/jib';
import type { CraneParts, YardGantryParts } from './cranes/parts';
import { makeShipGantry } from './cranes/shipGantry';
import { makeYardGantry } from './cranes/yardGantry';
import {
  buoy,
  crossing,
  gate,
  trafficLights,
  type CrossingParts,
  type SignalParts,
  type GateParts,
  type LightParts,
} from './furniture';
import { fences } from './fences';
import { builtUp, is, joins, landAt, leadsTo, offset, openWater, storeArea, streetAt } from './map';
import { BALLAST, BARRIER, STEEL } from './paints';
import type { BayStack } from './stock';
import { STORE_ROWS } from '../../sim/rules/cells';

export { STORE_ROWS };

// What stands on each tile of the map: the static model for each kind of
// building, road and quay, built once by makeTile when the tile changes.
// The cranes' models are built beside their runners, in cranes/.

/** What the builders are given about the port round a tile. */
export interface Site {
  map: GameMap;
  /** Each parking tile's lot: inside the port or out, and which way its spaces run. */
  lotAt(i: number): Lot;
}

export interface Lot {
  inside: boolean;
  acrossX: boolean;
  wide: boolean;
  flow?: ParkingFlow | null;
}

/** The moving and worked parts on a tile, set as it is made; see Tile. */
export interface TileParts extends Owns {
  stack?: BayStack;
  crane?: CraneParts;
  gate?: GateParts;
  /** A buoy, bobbing on the swell. */
  buoy?: Object3D;
  crossing?: CrossingParts;
  /** A siding's signal at its switch. */
  signal?: SignalParts;
  lights?: LightParts;
  /** A yard gantry, for its trolley to run as it loads trucks. */
  yardGantry?: YardGantryParts;
}

/** What is drawn on a tile, with its parts: made whole and let go of whole, see rebuild. */
export interface Tile extends TileParts {
  obj: Object3D;
}

/** A tile being built: its map and index, the group to build into, how high its ground is, and the parts it gets. */
export interface TileBuild extends Site {
  i: number;
  code: number;
  g: Group;
  top: number;
  parts: TileParts;
  m: GameMap;
}

/** A depot's walls, inside up to its roof: clear of a forklift's mast. */
const DEPOT_HEIGHT = 0.56;
const lifebuoyGeo = new TorusGeometry(0.05, 0.017, 6, 12);
const roofGeo = new ConeGeometry(0.56, 0.26, 4);
roofGeo.rotateY(Math.PI / 4);
roofGeo.scale(1.05, 1, 0.8);
roofGeo.translate(0, 0.13, 0);

/**
 * The model for tile `i`, or null for nothing; the moving parts on it go
 * in `parts`, and any geometry made for it alone onto `parts.owned`.
 */
export function makeTile(site: Site, i: number, parts: TileParts): Object3D | null {
  const m = site.map;
  const code = m.build[i];
  if (code === Build.None) return null;
  // The second tile of a large bay is drawn with its first.
  if (m.orient[i] & EXTENSION) return null;
  const t: TileBuild = {
    ...site,
    m,
    i,
    code,
    g: new Group(),
    top: landTop(m.terrain[i]),
    parts,
  };
  const build = TILES[code];
  if (build) return build(t);
  return townBuilding(code, t.top, hash01(i, 11, 3), parts.owned);
}

/** Each kind of tile's builder, by Build code; those not here are town buildings. */
const TILES: Partial<Record<number, (t: TileBuild) => Object3D>> = {
  [Build.Road]: road,
  [Build.Highway]: (t) => {
    highwayTile(t.m, t.g, t.i, t.top);
    return bake(t.g, t.parts.owned);
  },
  [Build.Rail]: (t) => {
    track(
      t.g,
      t.top,
      !is(t.m, t.i, 0, 1, Build.Rail, Build.Crossing) &&
        !is(t.m, t.i, 0, -1, Build.Rail, Build.Crossing),
    );
    // A switch onto a siding beside it, curving off for trains from either way.
    for (const side of [1, -1] as const) {
      if (!isTrack(t.m, offset(t.m, t.i, side, 0))) continue;
      switchCurves(t.g, t.top, side);
      t.parts.signal = signal(t.g, t.top, side, t.i);
    }
    return t.g;
  },
  [Build.Siding]: (t) => {
    sidingTrack(t.m, t.g, t.i, t.top);
    return t.g;
  },
  [Build.Crossing]: (t) => {
    crossing(t.m, t.g, t.i, t.top, t.parts);
    return t.g;
  },
  [Build.Office]: office,
  [Build.PortRoad]: portRoad,
  [Build.Parking]: parking,
  [Build.Gate]: gate,
  [Build.TugBerth]: tugBerth,
  [Build.BuoyIn]: buoy,
  [Build.BuoyOut]: buoy,
  [Build.Footpath]: (t) => {
    footpath(t.m, t.g, t.i, t.top);
    return t.g;
  },
  [Build.Jetty]: jetty,
  [Build.Quay]: (t) => {
    const { m, i, g, parts } = t;
    quay(m, g, i);
    if (m.store[i]) {
      storage(m, g, i, QUAY_Y, parts);
      machinesOutline(m, g, i, QUAY_Y);
    } else if (machinesOnly(m, i)) machinesOutline(m, g, i, QUAY_Y);
    return g;
  },
  [Build.HarbourCrane]: (t) => {
    quay(t.m, t.g, t.i);
    machinesOutline(t.m, t.g, t.i, QUAY_Y);
    return makeHarbourCrane(t);
  },
  [Build.YardGantry]: (t) => {
    paving(t);
    // Over a siding: the track runs on under it.
    if (t.m.orient[t.i] & RAILS) railsAcross(t.m, t.g, t.i);
    return makeYardGantry(t);
  },
  [Build.Gantry]: makeShipGantry,
  [Build.JibCrane]: (t) => {
    quay(t.m, t.g, t.i);
    machinesOutline(t.m, t.g, t.i, QUAY_Y);
    return makeJibCrane(t);
  },
  [Build.Depot]: depot,
  [Build.BreakHut]: breakHut,
  [Build.HarbourHut]: harbourHut,
  [Build.Customs]: customsOffice,
  [Build.TruckBay]: truckBay,
  [Build.LargeBay]: largeBay,
};

/**
 * Paving of its own, flush with the quays; not where it stands on a quay,
 * which is drawn under it already (see rebuild), or the two fight.
 */
export function paving(t: TileBuild): void {
  const { m, i, g, top } = t;
  if (!(m.orient[i] & ON_QUAY)) g.add(box(1, QUAY_Y - top, 1, C.quayTop, 0.5, top, 0.5));
}

function road(t: TileBuild): Object3D {
  const { m, i, g, top, parts } = t;
  g.add(box(1, 0.05, 1, C.asphalt, 0.5, top, 0.5));
  if (m.orient[i] & TOWN && builtUp(m, i)) {
    // A town street: pavements, and a lamp now and then.
    const open = DIRS.map(([dx, dy]) => streetAt(m, i, dx, dy));
    pavements(g, top, open, hash01(i, 5, 5) < 0.3);
    return bake(g, parts.owned);
  }
  const road = [Build.Road, Build.Crossing];
  // Off a highway exit, it runs on from the slip road.
  const offExit = m.xOf(i) === HIGHWAY_COLUMNS && isExit(m, i - 1);
  const ew = is(m, i, 1, 0, ...road) || is(m, i, -1, 0, ...road) || offExit;
  const ns = is(m, i, 0, 1, ...road) || is(m, i, 0, -1, ...road);
  const way = oneWay(m, i);
  if (way >= 0) roadArrow(g, top + 0.05, way);
  else if (ew !== ns) {
    for (const o of [0.25, 0.75]) {
      const [x, z, w, d] = ew ? [o, 0.5, 0.26, 0.05] : [0.5, o, 0.05, 0.26];
      g.add(box(w, 0.01, d, C.marking, x, top + 0.05, z));
    }
  }
  if (hasLights(m, i)) trafficLights(g, top + 0.05, parts);
  return g;
}

function office(t: TileBuild): Object3D {
  const { m, i, g, top } = t;
  // Harbour office: two storeys, a control room on top, radio mast and
  // flag. Offices side by side, facing the same way, make one long
  // block with a single entrance, control room, mast and flag.
  const { left, right } = joins(m, i);
  const [x0, x1] = [left ? 0 : 0.15, right ? 1 : 0.85];
  const lead = !left;
  g.add(box(1, 0.05, 1, C.concrete, 0.5, top, 0.5));
  const y = top + 0.05;
  g.add(box(x1 - x0, 0.4, 0.62, C.cabin, (x0 + x1) / 2, y, 0.5));
  const [w0, w1] = [left ? 0 : 0.22, right ? 1 : 0.78];
  for (const z of [0.18, 0.82]) {
    g.add(box(w1 - w0, 0.06, 0.012, C.window, (w0 + w1) / 2, y + 0.08, z));
    g.add(box(w1 - w0, 0.06, 0.012, C.window, (w0 + w1) / 2, y + 0.25, z));
  }
  const [r0, r1] = [left ? 0 : 0.13, right ? 1 : 0.87];
  g.add(box(r1 - r0, 0.03, 0.66, C.sign, (r0 + r1) / 2, y + 0.4, 0.5));
  if (lead) {
    g.add(box(0.36, 0.16, 0.36, C.window, 0.5, y + 0.43, 0.5));
    g.add(box(0.42, 0.03, 0.42, C.sign, 0.5, y + 0.59, 0.5));
    g.add(cyl(0.012, 0.42, C.chassis, 0.62, y + 0.62, 0.62));
    // Front door, towards +z like every building before it is turned.
    g.add(box(0.16, 0.22, 0.02, C.woodDark, 0.5, y, 0.82));
  }
  if (!right) {
    g.add(cyl(0.012, 0.5, C.chassis, 0.16 + (left ? 0.68 : 0), y, 0.84));
    g.add(box(0.012, 0.1, 0.14, C.funnel, 0.16 + (left ? 0.68 : 0), y + 0.4, 0.91));
  }
  return g;
}

function portRoad(t: TileBuild): Object3D {
  const { m, i, g, parts } = t;
  // Same paving as the quays and flush with them, with a dashed white centre
  // line, and the port's fence along any side facing the public road.
  paving(t);
  fences(m, g, i, QUAY_Y, parts.owned);
  const along = is(m, i, 1, 0, Build.PortRoad) || is(m, i, -1, 0, Build.PortRoad);
  if (m.store[i]) {
    storage(m, g, i, QUAY_Y, parts);
    machinesOutline(m, g, i, QUAY_Y);
    return g;
  }
  if (machinesOnly(m, i)) {
    machinesOutline(m, g, i, QUAY_Y);
    return g;
  }
  const way = oneWay(m, i);
  if (m.orient[i] & RAILS) railsAcross(m, g, i);
  else if (way >= 0) roadArrow(g, QUAY_Y, way);
  else {
    for (const o of [0.15, 0.6]) {
      const [x, z, w, d] = along ? [o + 0.125, 0.5, 0.25, 0.04] : [0.5, o + 0.125, 0.04, 0.25];
      g.add(box(w, 0.006, d, C.marking, x, QUAY_Y, z));
    }
  }
  if (hasLights(m, i)) trafficLights(g, QUAY_Y, parts);
  return g;
}

/**
 * A port road with the siding running across it: rails set flush in the
 * paving along the row, between yellow-and-black warning edges.
 */
function railsAcross(m: GameMap, g: Group, i: number): void {
  const out = m.xOf(i) > railColumn(m) ? 1 : -1;
  const first = is(m, i, -out, 0, Build.Rail);
  const from = first ? (out > 0 ? 0.5 : 0) : 0;
  const len = first ? 0.5 : 1;
  const mid = from + len / 2;
  g.add(box(len, 0.008, 0.44, C.quayWall, mid, QUAY_Y, 0.5));
  for (const z of [0.35, 0.65]) g.add(box(len, 0.012, 0.03, STEEL, mid, QUAY_Y, z));
  for (const z of [0.2, 0.8]) {
    for (let k = 0; k < 4; k++) {
      g.add(box(0.12, 0.007, 0.03, k % 2 ? C.stripe : 0x26282b, 0.125 + k * 0.25, QUAY_Y, z));
    }
  }
}

function parking(t: TileBuild): Object3D {
  const { i, g, top } = t;
  // Asphalt outside the port, port paving inside it, and white lines
  // between one space and the next, at the angle trucks park at. A
  // truck stands across the middle of its tile, so the lines run through
  // the tile's edges: each tile draws the half of each line inside it,
  // and the lines stop at the ends of the lot, off the roads.
  const { inside, acrossX, wide, flow } = t.lotAt(i);
  const y = inside ? QUAY_Y : top + 0.05;
  g.add(box(1, y - top, 1, inside ? C.quayTop : C.asphalt, 0.5, top, 0.5));
  // The spaces lean the way trucks drive through the lot: between the
  // way along it and the way across it, in off one road, out onto the other.
  const lean = flow
    ? [flow.along[0] + flow.across[0], flow.along[1] + flow.across[1]]
    : acrossX
      ? [1, 1]
      : [1, -1];
  const vx = lean[0] * Math.SQRT1_2;
  const vz = lean[1] * Math.SQRT1_2;
  const turn = Math.atan2(-vz, vx);
  // Which way through it, painted on it.
  if (flow) {
    const facing = FACING.findIndex(([fx, fy]) => fx === flow.across[0] && fy === flow.across[1]);
    if (facing >= 0) roadArrow(g, y, facing, 0.55);
  }
  // Two tiles wide, a truck stands across the middle of both, where
  // the corners of the tiles meet: the lines between the spaces run
  // corner to corner across each tile, joining up across the strip.
  if (wide) {
    const line = box(1.3, 0.008, 0.035, C.marking, 0.5, y, 0.5);
    line.rotation.y = turn;
    g.add(line);
    return g;
  }
  // Along the lines, which run with the parked trucks.
  for (const o of [0, 1]) {
    const [px, pz] = acrossX ? [0.5, o] : [o, 0.5];
    // Into this tile from its edge.
    const k = (o === 0 ? 1 : -1) * 0.31 * Math.sign(acrossX ? vz : vx);
    const half = box(0.62, 0.008, 0.035, C.marking, px + vx * k, y, pz + vz * k);
    half.rotation.y = turn;
    g.add(half);
  }
  return g;
}

function tugBerth(t: TileBuild): Object3D {
  const { m, i, g } = t;
  // A pontoon afloat along the dock edge, where the tug lies: tyre
  // fenders on its water side and a pair of bollards.
  const dock = m.neighbors4(i).find((n) => isDock(m.build[n]));
  const [dx, dy] = dock === undefined ? [0, -1] : [m.xOf(dock) - m.xOf(i), m.yOf(dock) - m.yOf(i)];
  const pontoon = new Group();
  pontoon.add(box(0.9, 0.08, 0.22, C.quayWall, 0, -0.04, 0));
  pontoon.add(box(0.9, 0.012, 0.22, C.quayTop, 0, 0.04, 0));
  for (const x of [-0.3, 0, 0.3]) {
    const tyre = cyl(0.045, 0.035, 0x1d1f22, x, -0.01, 0.13, 10);
    tyre.rotation.x = Math.PI / 2;
    pontoon.add(tyre);
  }
  for (const x of [-0.36, 0.36]) pontoon.add(cyl(0.025, 0.06, C.chassis, x, 0.05, 0.02, 8));
  // Along the edge nearest the dock, its fenders facing the water.
  pontoon.position.set(0.5 + dx * 0.38, 0, 0.5 + dy * 0.38);
  pontoon.rotation.y = Math.atan2(-dx, -dy);
  g.add(pontoon);
  return g;
}

function jetty(t: TileBuild): Object3D {
  const { m, i, g, top } = t;
  const onBeach = m.isLand(i);
  const ew = is(m, i, 1, 0, Build.Jetty) || is(m, i, -1, 0, Build.Jetty);
  const ns = is(m, i, 0, 1, Build.Jetty) || is(m, i, 0, -1, Build.Jetty);
  // Run along neighbouring jetty; a lone beach jetty runs along the shore.
  const alongX = ew
    ? true
    : ns
      ? false
      : onBeach
        ? !landAt(m, i, 0, 1) || !landAt(m, i, 0, -1)
        : landAt(m, i, 1, 0) || landAt(m, i, -1, 0);
  const footing = onBeach ? top : SEABED;
  for (let k = 0; k < 4; k++) {
    const o = 0.13 + k * 0.245;
    const [x, z, w, d] = alongX ? [o, 0.5, 0.22, 1] : [0.5, o, 1, 0.22];
    g.add(box(w, 0.06, d, k % 2 ? C.wood : C.woodDark, x, DECK_Y - 0.06, z));
  }
  for (const px of [0.12, 0.88]) {
    for (const pz of [0.12, 0.88]) {
      g.add(cyl(0.05, DECK_Y - 0.06 - footing, C.woodDark, px, footing, pz));
    }
  }
  return g;
}

function depot(t: TileBuild): Object3D {
  const { m, i, g, top } = t;
  // A garage over the whole tile, its front (+z) open under a rolled-up
  // door, tall enough for a forklift's mast, with the machines parked
  // side by side inside (see parkPoses), backs to the back wall. Its
  // side walls stand on the tile's edges, so three fit across.
  // Depots side by side, facing the same way, make one long garage
  // with a door for each bay and a fuel tank on the roof at the end.
  const { left, right } = joins(m, i);
  g.add(box(1, 0.05, 1, C.concrete, 0.5, top, 0.5));
  const y = top + 0.05;
  const [x0, x1] = [left ? 0 : -0.005, right ? 1 : 1.005];
  const mid = (x0 + x1) / 2;
  g.add(
    box(x1 - x0, DEPOT_HEIGHT, DEPOT_BACK - 0.005, C.depotWall, mid, y, (DEPOT_BACK - 0.005) / 2),
  );
  for (const [x, on] of [
    [0, !left],
    [1, !right],
  ] as const) {
    if (!on) continue;
    g.add(box(0.01, DEPOT_HEIGHT, 1, C.depotWall, x, y, 0.5));
    // A strip of windows high up along the side.
    g.add(box(0.014, 0.06, 0.6, C.window, x, y + DEPOT_HEIGHT - 0.14, 0.5));
  }
  g.add(box(x1 - x0, 0.04, 1, C.depotRoof, mid, y + DEPOT_HEIGHT, 0.5));
  // Over the door: the lintel, and the door rolled up under it.
  g.add(box(x1 - x0, 0.03, 0.03, C.depotWall, mid, y + DEPOT_HEIGHT - 0.03, 0.985));
  g.add(box(x1 - x0 - 0.02, 0.02, 0.025, C.chassis, mid, y + DEPOT_HEIGHT - 0.05, 0.98));
  // Hazard stripe across the doorway.
  g.add(box(1, 0.004, 0.03, C.stripe, 0.5, y, 0.975));
  if (!right) {
    // The fuel tank on the roof, red, with its pipe down the side.
    const tank = cyl(0.07, 0.3, C.funnel, 0, 0, 0, 10);
    tank.rotation.x = Math.PI / 2;
    tank.position.set(0.82, y + DEPOT_HEIGHT + 0.11, 0.2);
    g.add(tank);
    for (const z of [0.1, 0.3])
      g.add(box(0.1, 0.05, 0.03, C.chassis, 0.82, y + DEPOT_HEIGHT + 0.04, z));
    g.add(box(0.02, DEPOT_HEIGHT, 0.02, C.chassis, 1.012, y, 0.12));
  }
  return g;
}

function breakHut(t: TileBuild): Object3D {
  const { g, top } = t;
  // A little timber hut with a red roof and a bench out front.
  g.add(box(1, 0.04, 1, C.path, 0.5, top, 0.5));
  g.add(box(0.7, 0.34, 0.5, C.cabin, 0.5, top + 0.04, 0.38));
  g.add(box(0.14, 0.22, 0.02, C.woodDark, 0.5, top + 0.04, 0.64));
  g.add(box(0.14, 0.1, 0.02, C.window, 0.3, top + 0.2, 0.64));
  g.add(box(0.14, 0.1, 0.02, C.window, 0.7, top + 0.2, 0.64));
  const roof = new Mesh(roofGeo, mat(C.funnel));
  roof.position.set(0.5, top + 0.38, 0.38);
  roof.castShadow = roof.receiveShadow = true;
  g.add(roof);
  // The bench the dockhands sit on, on their break.
  g.add(box(0.7, 0.03, 0.12, C.wood, 0.5, top + 0.1, 0.8));
  for (const x of [0.2, 0.8]) g.add(box(0.04, 0.06, 0.1, C.woodDark, x, top + 0.04, 0.8));
  return g;
}

function customsOffice(t: TileBuild): Object3D {
  const { g, top } = t;
  // The customs house: a squat stone building under a dark hipped roof,
  // white pilasters either side of a porch over the door, a blue board
  // with the red customs seal (as on the crates waiting for it) over the
  // porch, a striped barrier arm out front and a flag on the roof.
  g.add(box(1, 0.04, 1, C.flagstone, 0.5, top, 0.5));
  const y = top + 0.04;
  // A plinth, the walls on it, and a white cornice under the roof.
  g.add(box(0.72, 0.04, 0.56, C.quayWall, 0.5, y, 0.42));
  g.add(box(0.68, 0.3, 0.52, C.concrete, 0.5, y + 0.04, 0.42));
  g.add(box(0.74, 0.03, 0.58, C.shedTrim, 0.5, y + 0.34, 0.42));
  const roof = new Mesh(roofGeo, mat(C.depotRoof));
  roof.scale.set(0.95, 0.75, 0.95);
  roof.position.set(0.5, y + 0.37, 0.42);
  roof.castShadow = roof.receiveShadow = true;
  g.add(roof);
  // Tall windows down each side and along the front, either side of the porch.
  for (const x of [0.25, 0.75]) g.add(box(0.08, 0.15, 0.012, C.window, x, y + 0.1, 0.685));
  for (const z of [0.3, 0.54]) {
    for (const x of [0.155, 0.845]) g.add(box(0.012, 0.15, 0.08, C.window, x, y + 0.1, z));
  }
  // The porch: two white columns, a flat white roof and the door behind.
  for (const x of [0.39, 0.61]) g.add(cyl(0.022, 0.26, C.shedTrim, x, y + 0.04, 0.78));
  g.add(box(0.3, 0.03, 0.14, C.shedTrim, 0.5, y + 0.3, 0.74));
  g.add(box(0.13, 0.22, 0.02, C.woodDark, 0.5, y + 0.04, 0.69));
  g.add(box(0.3, 0.02, 0.14, C.quayWall, 0.5, y, 0.75));
  // The board over the porch, and the seal on it.
  g.add(box(0.3, 0.07, 0.02, C.sign, 0.5, y + 0.33, 0.81));
  g.add(cyl(0.028, 0.012, C.seal, 0.5, y + 0.36, 0.822, 12).rotateX(Math.PI / 2));
  // A barrier arm across the way in, red and white, on a post.
  g.add(box(0.05, 0.12, 0.05, C.chassis, 0.14, y, 0.9));
  for (let k = 0; k < 4; k++) {
    g.add(box(0.07, 0.025, 0.025, k % 2 ? C.cabin : C.funnel, 0.2 + k * 0.07, y + 0.1, 0.9));
  }
  // A flagpole at the roof's corner.
  g.add(cyl(0.01, 0.5, C.cabin, 0.82, y + 0.34, 0.2));
  g.add(box(0.012, 0.09, 0.15, C.sign, 0.82, y + 0.72, 0.28));
  return g;
}

function harbourHut(t: TileBuild): Object3D {
  const { g, top } = t;
  // The harbourmaster's hut: a little blue-painted timber shed with a
  // white door and a big window on the water, a red roof, a lifebuoy
  // and a noticeboard by the door, and a flag flying on a pole.
  g.add(box(1, 0.04, 1, C.path, 0.5, top, 0.5));
  const y = top + 0.04;
  g.add(box(0.56, 0.3, 0.46, C.shed, 0.5, y, 0.42));
  // Corner posts and a band under the eaves in white.
  for (const [x, z] of [
    [0.23, 0.2],
    [0.77, 0.2],
    [0.23, 0.64],
    [0.77, 0.64],
  ]) {
    g.add(box(0.04, 0.3, 0.04, C.shedTrim, x, y, z));
  }
  g.add(box(0.6, 0.03, 0.5, C.shedTrim, 0.5, y + 0.28, 0.42));
  const roof = new Mesh(roofGeo, mat(C.funnel));
  roof.scale.set(0.82, 0.9, 0.94);
  roof.position.set(0.5, y + 0.31 + 0.12, 0.42);
  roof.castShadow = roof.receiveShadow = true;
  g.add(roof);
  // Door and window at the front (+z).
  g.add(box(0.13, 0.21, 0.02, C.shedTrim, 0.4, y, 0.66));
  g.add(box(0.15, 0.1, 0.02, C.window, 0.62, y + 0.12, 0.66));
  g.add(box(0.17, 0.02, 0.025, C.shedTrim, 0.62, y + 0.11, 0.665));
  // Lifebuoy on the wall by the door, red and white.
  const buoy = new Mesh(lifebuoyGeo, mat(C.funnel));
  buoy.position.set(0.24, y + 0.17, 0.675);
  buoy.castShadow = true;
  g.add(buoy);
  for (const a of [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2]) {
    g.add(
      box(
        0.02,
        0.02,
        0.012,
        C.cabin,
        0.24 + Math.cos(a) * 0.05,
        y + 0.16 + Math.sin(a) * 0.05,
        0.69,
      ),
    );
  }
  // Noticeboard on two legs out front.
  for (const x of [0.73, 0.89]) g.add(box(0.015, 0.14, 0.015, C.woodDark, x, y, 0.86));
  g.add(box(0.2, 0.1, 0.02, C.wood, 0.81, y + 0.1, 0.86));
  g.add(box(0.06, 0.05, 0.022, C.cabin, 0.77, y + 0.125, 0.86));
  g.add(box(0.05, 0.04, 0.022, C.stripe, 0.85, y + 0.13, 0.86));
  // Flagpole with a flag at the corner.
  g.add(cyl(0.01, 0.62, C.cabin, 0.12, y, 0.86));
  g.add(box(0.012, 0.09, 0.15, C.sign, 0.12, y + 0.5, 0.94));
  g.add(box(0.013, 0.03, 0.15, C.cabin, 0.12, y + 0.53, 0.94));
  return g;
}

function truckBay(t: TileBuild): Object3D {
  const { g, top, parts } = t;
  // Entrance at the front (+z): the truck backs in, and the crates
  // stand two by two in the front corner, out of the way of those
  // loading it.
  g.add(box(1, 0.06, 1, C.concrete, 0.5, top, 0.5));
  const y = top + 0.06;
  for (const x of [0.06, 0.94]) g.add(box(0.05, 0.01, 0.9, C.stripe, x, y, 0.5));
  const crates: Object3D[] = [];
  // The front row stacked to the top first, away from those who stack
  // them from behind, then the row in front of them; taken off the
  // other way round.
  for (const z of [0.89, 0.71]) {
    for (let layer = 0; layer < 4; layer++) {
      for (const x of [0.71, 0.89]) {
        const c = crate(CRATE, x, y + layer * CRATE, z);
        c.visible = false;
        g.add(c);
        crates.push(c);
      }
    }
  }
  baySign(g, y);
  parts.stack = { crates, boxes: [] };
  return g;
}

/**
 * A truck bay's sign on its post, its designation on both faces (see
 * labels.ts): at the front corner by the road on the side away from the
 * crates, beside the truck's cab and outside the lane line, where neither
 * the truck, nor the stack, nor those who load it from behind the stack,
 * along the bay's back or from the next bay along ever go; up high, over
 * the trucks, the forklifts and the loads they carry.
 */
function baySign(g: Group, y: number): void {
  const x = 0.015;
  const post = cyl(0.02, 0.6, C.chassis, x, y, 0.9);
  post.userData.baySignPost = true;
  g.add(post);
  // The board on it, out over the bay towards its back.
  const sign = box(0.03, 0.2, 0.27, C.sign, x, y + 0.55, 0.79);
  sign.userData.baySign = true;
  g.add(sign);
}

function largeBay(t: TileBuild): Object3D {
  const { g, top, parts } = t;
  // Two tiles: a truck lane (x 0..1) and a covered cargo yard beside it
  // (x 1..2), both opening onto the road at the front (+z).
  g.add(box(2, 0.06, 1, C.quayTop, 1, top, 0.5));
  const y = top + 0.06;
  for (const x of [0.06, 0.94]) g.add(box(0.05, 0.01, 0.9, C.stripe, x, y, 0.5));
  g.add(box(0.8, 0.01, 0.05, C.marking, 0.5, y, 0.08));
  // Crates: four rows of four, stacked up.
  const crates: Object3D[] = [];
  for (let layer = 0; layer < 4; layer++) {
    for (const z of [0.2, 0.4, 0.6, 0.8]) {
      for (const x of [1.2, 1.4, 1.6, 1.8]) {
        if (crates.length >= 28) break;
        const c = crate(CRATE, x, y + layer * CRATE, z);
        c.visible = false;
        g.add(c);
        crates.push(c);
      }
    }
  }
  // Canopy over the yard on four posts.
  for (const x of [1.06, 1.94]) {
    for (const z of [0.06, 0.94]) g.add(cyl(0.03, 0.8, C.chassis, x, y, z));
  }
  g.add(box(1, 0.04, 1, C.depotRoof, 1.5, y + 0.8, 0.5));
  baySign(g, y);
  parts.stack = { crates, boxes: [] };
  return g;
}

/** Ballast, sleepers and rails, along z (or along x). */
function track(g: Group, top: number, alongX = false): void {
  const put = (w: number, h: number, d: number, color: number, x: number, y: number, z: number) =>
    g.add(alongX ? box(d, h, w, color, z, y, x) : box(w, h, d, color, x, y, z));
  put(0.64, 0.05, 1, BALLAST, 0.5, top, 0.5);
  for (const z of [0.17, 0.5, 0.83]) put(0.54, 0.025, 0.11, C.woodDark, 0.5, top + 0.05, z);
  for (const x of [0.35, 0.65]) put(0.03, 0.03, 1, STEEL, x, top + 0.075, 0.5);
}

/**
 * A siding's track along its row, from the main line out to its buffer
 * stop. The first tile carries track only from its middle out: the
 * switch's curves come in to its middle.
 */
function sidingTrack(m: GameMap, g: Group, i: number, top: number): void {
  const out = m.xOf(i) > railColumn(m) ? 1 : -1;
  const first = is(m, i, -out, 0, Build.Rail);
  const last = !isTrack(m, offset(m, i, out, 0));
  // Along x: `u` runs across the track (z), `v` along it (x).
  const put = (w: number, h: number, d: number, color: number, u: number, y: number, v: number) =>
    g.add(box(d, h, w, color, v, y, u));
  const from = first ? 0.5 : 0;
  const len = 1 - from;
  const mid = out > 0 ? from + len / 2 : 1 - from - len / 2;
  put(0.64, 0.05, len, BALLAST, 0.5, top, mid);
  for (const v of [0.17, 0.5, 0.83]) {
    if (!first || (out > 0 ? v >= 0.5 : v <= 0.5))
      put(0.54, 0.025, 0.11, C.woodDark, 0.5, top + 0.05, v);
  }
  for (const u of [0.35, 0.65]) put(0.03, 0.03, len, STEEL, u, top + 0.075, mid);
  if (last) {
    // The buffer stop: a frame across the end with red-and-white beams.
    const v = out > 0 ? 0.9 : 0.1;
    for (const u of [0.35, 0.65]) put(0.05, 0.16, 0.05, STEEL, u, top + 0.075, v);
    put(0.5, 0.07, 0.06, 0xd6453d, 0.5, top + 0.18, v);
    put(0.16, 0.071, 0.061, 0xf4f4f0, 0.5, top + 0.18, v);
  }
}

/**
 * A siding's signal by its switch, on the siding side of the line: a post
 * with a red and a green lamp, green while its train has the road.
 */
function signal(g: Group, top: number, side: 1 | -1, i: number): SignalParts {
  const x = 0.5 + side * 0.44;
  const z = 0.08;
  g.add(cyl(0.015, 0.42, C.chassis, x, top, z, 6));
  g.add(box(0.07, 0.15, 0.05, 0x26282b, x, top + 0.36, z));
  const red = box(0.035, 0.035, 0.015, 0xff3b30, x, top + 0.45, z + 0.03);
  const green = box(0.035, 0.035, 0.015, 0x34d058, x, top + 0.39, z + 0.03);
  for (const lamp of [red, green]) lamp.castShadow = false;
  g.add(red, green);
  return { red, green, switch: i };
}

/**
 * A switch's curves off the main line onto a siding on side `side` (+1
 * east): a quarter circle of a tile's radius from the line, a tile before
 * this one, round to the middle of the siding's first tile; one from the
 * north and one from the south.
 */
function switchCurves(g: Group, top: number, side: 1 | -1): void {
  const steps = 8;
  for (const north of [true, false]) {
    // The circle's middle, in the tile's own x and z.
    const cx = 0.5 + side;
    const cz = north ? -0.5 : 1.5;
    for (let k = 0; k < steps; k++) {
      // From the line (angle 0) round to the siding (a quarter turn).
      const a = ((k + 0.5) / steps) * (Math.PI / 2);
      const dx = -side * Math.cos(a);
      const dz = north ? Math.sin(a) : -Math.sin(a);
      // Along the curve, the way a train from the line runs.
      const heading = Math.atan2(side * Math.sin(a), north ? Math.cos(a) : -Math.cos(a));
      const piece = (Math.PI / 2 / steps) * 1.04;
      for (const r of [0.85, 1.15]) {
        const rail = box(0.03, 0.03, r * piece, STEEL, 0, 0, 0);
        rail.position.set(cx + dx * r, top + 0.09, cz + dz * r);
        rail.rotation.y = heading;
        g.add(rail);
      }
      if (k % 2 === 0) {
        const sleeper = box(0.54, 0.025, 0.11, C.woodDark, 0, 0, 0);
        sleeper.position.set(cx + dx, top + 0.0625, cz + dz);
        sleeper.rotation.y = heading;
        g.add(sleeper);
      }
    }
  }
}

/**
 * A tile marked out as storage: a line painted round the edge of the area,
 * and the goods stacked on it, crates four high in four piles or containers
 * two abreast and three high, lying along the area.
 */
export function storage(m: GameMap, g: Group, i: number, y: number, parts: TileParts): void {
  const code = m.store[i];
  const boxes = storesBoxes(code);
  // Storage for cargo going out is outlined in blue.
  const line = storesOutgoing(code) ? C.sign : boxes ? C.stripe : C.marking;
  const same = (dx: number, dy: number) => {
    const n = offset(m, i, dx, dy);
    return n >= 0 && m.store[n] === code;
  };
  for (const [dx, dy] of DIRS) {
    if (same(dx, dy)) continue;
    const [x, z, w, d] = dx ? [0.5 + dx * 0.45, 0.5, 0.04, 1] : [0.5, 0.5 + dy * 0.45, 1, 0.04];
    g.add(box(w, 0.006, d, line, x, y, z));
  }
  const stack: BayStack = { crates: [], boxes: [], places: [] };
  if (boxes) {
    // Along the yard's long side, as its gantry runs.
    const area = storeArea(m, i);
    const xs = area.map((t) => m.xOf(t));
    const ys = area.map((t) => m.yOf(t));
    const alongX = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
    for (let layer = 0; layer < 3; layer++) {
      for (const o of [0.32, 0.68]) {
        const [x, z] = alongX ? [0.5, o] : [o, 0.5];
        const c = container(i * 7 + stack.boxes.length, x, y + layer * BOX_HEIGHT, z);
        if (!alongX) c.rotation.y = Math.PI / 2;
        c.visible = false;
        g.add(c);
        stack.boxes.push(c);
      }
    }
  } else {
    // One stack to a tile, in the middle of it with room all round for
    // the forklifts, as a truck bay stacks its crates: two rows, each two
    // pallets high, each pallet a forklift's load as it carries them, two
    // crates wide and two high. The forks go in to the front row from one
    // side, to the back row from the other: the way there is ground to
    // drive on at both, across the area's length where either will do.
    const alongX = forksAlongZ(m, i);
    for (const a of STORE_ROWS) {
      for (let level = 0; level < 2; level++) {
        const place = new Group();
        const up = y + level * STORE_PALLET;
        // Its forks' way runs along local x.
        if (alongX) {
          place.position.set(0.5, up, a);
          place.rotation.y = -Math.PI / 2;
        } else place.position.set(a, up, 0.5);
        for (let layer = 0; layer < 2; layer++) {
          for (const z of [-0.08, 0.08]) {
            const c = crate(CRATE, 0, 0.025 + layer * CRATE, z);
            c.visible = false;
            place.add(c);
            stack.crates.push(c);
          }
        }
        // The pallet, showing while any crate is on it.
        const pallet = box(0.2, 0.025, 0.34, C.wood, 0, 0, 0);
        pallet.visible = false;
        place.add(pallet);
        place.userData.pallet = pallet;
        g.add(place);
        stack.places!.push(place);
      }
    }
  }
  parts.stack = stack;
}

/** How high a pallet of crates in storage stands, board and two crates, for the next on top. */
export const STORE_PALLET = 0.025 + 2 * CRATE;

/** A red line round the edge of an area kept for port machines, if `i` is in one. */
export function machinesOutline(m: GameMap, g: Group, i: number, y: number): void {
  if (!machinesOnly(m, i)) return;
  for (const [dx, dy] of DIRS) {
    const n = offset(m, i, dx, dy);
    if (n >= 0 && machinesOnly(m, n)) continue;
    const [x, z, w, d] = dx ? [0.5 + dx * 0.48, 0.5, 0.03, 1] : [0.5, 0.5 + dy * 0.48, 1, 0.03];
    g.add(box(w, 0.007, d, C.buoyRed, x, y, z));
  }
}

/**
 * A worn path: a dirt track with stepping stones down it and trampled grass
 * along its edges, running out to each side that leads somewhere so a run
 * of tiles reads as one winding path.
 */
function footpath(m: GameMap, g: Group, i: number, top: number): void {
  const arms = DIRS.filter(([dx, dy]) => leadsTo(m, i, dx, dy));
  for (const [w, h, color] of [
    [0.64, 0.012, C.verge],
    [0.42, 0.02, C.dirt],
  ] as const) {
    g.add(cyl(w / 2, h, color, 0.5, top, 0.5, 8));
    for (const [dx, dy] of arms) {
      const [x, z, bw, bd] = dx ? [0.5 + dx / 4, 0.5, 0.5, w] : [0.5, 0.5 + dy / 4, w, 0.5];
      g.add(box(bw, h, bd, color, x, top, z));
    }
  }
  // Flat stones every quarter tile, nudged and turned a little so the line wanders.
  const spots: [number, number][] = [
    [0.5, 0.5],
    ...arms.map(([dx, dy]) => [0.5 + dx / 4, 0.5 + dy / 4] as [number, number]),
  ];
  spots.forEach(([x, z], k) => {
    const jx = (hash01(i, k, 1) - 0.5) * 0.08;
    const jz = (hash01(i, k, 2) - 0.5) * 0.08;
    const s = 0.13 + hash01(i, k, 3) * 0.05;
    const stone = box(s, 0.012, s * 0.8, C.flagstone, x + jx, top + 0.02, z + jz);
    stone.rotation.y = (hash01(i, k, 4) - 0.5) * 1.2;
    g.add(stone);
  });
}

/** Concrete slab (on the shore) or block (in the water) with edge details. */
/** A quay tile; `bare` leaves off the edge furniture, for a deck built over. */
export function quay(m: GameMap, g: Group, i: number, bare = false): void {
  const onLand = m.isLand(i);
  const base = onLand ? landTop(m.terrain[i]) : SEABED;
  // Full-tile top so neighbouring quays and port roads join without a seam.
  g.add(box(1, QUAY_Y - 0.03 - base, 1, C.quayWall, 0.5, base, 0.5));
  g.add(box(1, 0.03, 1, C.quayTop, 0.5, QUAY_Y - 0.03, 0.5));
  // Safety line, bollards and tyre fenders along open-water edges.
  const sides = [
    { dx: 1, dy: 0, x: 0.95, z: 0.5, w: 0.04, d: 1 },
    { dx: -1, dy: 0, x: 0.05, z: 0.5, w: 0.04, d: 1 },
    { dx: 0, dy: 1, x: 0.5, z: 0.95, w: 1, d: 0.04 },
    { dx: 0, dy: -1, x: 0.5, z: 0.05, w: 1, d: 0.04 },
  ];
  for (const s of bare ? [] : sides) {
    if (!openWater(m, i, s.dx, s.dy)) continue;
    const inX = s.dx !== 0 ? s.x - s.dx * 0.07 : s.x;
    const inZ = s.dy !== 0 ? s.z - s.dy * 0.07 : s.z;
    // The line runs on into the next quay along this edge, and stops at
    // the corner where the edge turns.
    const [ax, ay] = s.dx ? [0, 1] : [1, 0];
    let from = 0;
    let to = 1;
    for (const e of [-1, 1]) {
      const n = offset(m, i, ax * e, ay * e);
      const runsOn = n >= 0 && isDock(m.build[n]) && openWater(m, n, s.dx, s.dy);
      if (!runsOn && e < 0) from = 0.12;
      if (!runsOn && e > 0) to = 0.88;
    }
    const mid = (from + to) / 2;
    const len = to - from;
    g.add(
      box(
        s.dx ? s.w : len,
        0.005,
        s.dy ? s.d : len,
        C.stripe,
        s.dx ? inX : mid,
        QUAY_Y,
        s.dy ? inZ : mid,
      ),
    );
    g.add(
      cyl(
        0.04,
        0.08,
        C.chassis,
        s.dx ? s.x - s.dx * 0.03 : 0.3,
        QUAY_Y,
        s.dy ? s.z - s.dy * 0.03 : 0.3,
      ),
    );
    g.add(
      box(
        s.dx ? 0.05 : 0.14,
        0.12,
        s.dy ? 0.05 : 0.14,
        C.tyre,
        s.dx ? s.x + s.dx * 0.06 : 0.5,
        QUAY_Y - 0.2,
        s.dy ? s.z + s.dy * 0.06 : 0.5,
      ),
    );
  }
}

/**
 * A tile of the highway: a carriageway of two lanes one way, the solid
 * line along its outer edge and the crash barrier down the middle, both
 * open at an exit, and now and then an arrow the way it goes.
 */
function highwayTile(m: GameMap, g: Group, i: number, top: number): void {
  const x = m.xOf(i);
  const y = m.yOf(i);
  const exit = isExit(m, i);
  g.add(box(1, 0.05, 1, C.asphalt, 0.5, top, 0.5));
  const lineY = top + 0.05;
  // Dashes between its two lanes.
  for (const z of [0.12, 0.62]) g.add(box(0.04, 0.008, 0.26, C.marking, 0.5, lineY, z + 0.13));
  // The edge line on the outside; open where the slip road joins at an exit.
  const outer = x === 0 ? 0.07 : 0.93;
  if (!(exit && x === HIGHWAY_COLUMNS - 1)) {
    g.add(box(0.04, 0.008, 1, C.marking, outer, lineY, 0.5));
  }
  // Half the barrier down the middle each side; at an exit, the gap through it.
  const inner = x === 0 ? 0.975 : 0.025;
  if (!exit) {
    g.add(box(0.05, 0.09, 1, BARRIER, inner, lineY, 0.5));
  } else {
    // Give-way lines across the gap, and the barrier's ends.
    g.add(box(0.05, 0.008, 0.9, C.marking, inner, lineY, 0.5));
  }
  if (y % 12 === 6 && !exit) roadArrow(g, lineY, m.orient[i] & 3);
}

/**
 * The highway running on past the north and south ends of the map, so
 * trucks come in from somewhere and go somewhere.
 */
export function highwayEnds(m: GameMap): Object3D {
  const g = new Group();
  if (!hasHighway(m)) return g;
  for (const [from, y] of [
    [-MARGIN, 0],
    [m.h, m.h - 1],
  ] as const) {
    const top = landTop(m.terrain[m.idx(0, y)]);
    const z = from + MARGIN / 2;
    g.add(box(HIGHWAY_COLUMNS, 0.05, MARGIN, C.asphalt, HIGHWAY_COLUMNS / 2, top, z));
    g.add(box(0.04, 0.008, MARGIN, C.marking, 0.07, top + 0.05, z));
    g.add(box(0.04, 0.008, MARGIN, C.marking, HIGHWAY_COLUMNS - 0.07, top + 0.05, z));
    g.add(box(0.1, 0.09, MARGIN, BARRIER, 1, top + 0.05, z));
    for (let k = 0; k < MARGIN; k += 1) {
      for (const x of [0.5, 1.5]) {
        g.add(box(0.04, 0.008, 0.26, C.marking, x, top + 0.05, from + k + 0.25));
      }
    }
  }
  return bake(g);
}

/** Stakes and a painted line where the port's land ends and the country begins. */
export function boundary(m: GameMap): Object3D {
  const g = new Group();
  const z = m.limit;
  if (z >= m.h) return g;
  for (let x = 0; x < m.w; x++) {
    const i = m.idx(x, z - 1);
    if (!m.isLand(i) || !m.isLand(i + m.w)) continue;
    const top = landTop(m.terrain[i]);
    g.add(box(0.5, 0.012, 0.05, C.marking, x + 0.5, top, z));
    if (x % 3 === 0) {
      g.add(cyl(0.025, 0.24, C.marking, x + 0.1, top, z));
      g.add(cyl(0.027, 0.06, C.funnel, x + 0.1, top + 0.18, z));
    }
  }
  return bake(g);
}

/** The main line running on past both ends of the map. */
export function mainLine(m: GameMap): Object3D {
  const g = new Group();
  const x = railColumn(m);
  if (x < 0) return g;
  const sleepers = new InstancedMesh(unitBox, mat(C.woodDark), MARGIN * 3 * 2);
  const at = new Matrix4();
  let n = 0;
  for (const [from, y] of [
    [-MARGIN, 0],
    [m.h, m.h - 1],
  ] as const) {
    const top = landTop(m.terrain[m.idx(x, y)]);
    g.add(box(0.64, 0.05, MARGIN, BALLAST, x + 0.5, top, from + MARGIN / 2));
    for (const o of [0.35, 0.65])
      g.add(box(0.03, 0.03, MARGIN, STEEL, x + o, top + 0.075, from + MARGIN / 2));
    for (let k = 0; k < MARGIN * 3; k++) {
      at.makeScale(0.54, 0.025, 0.11).setPosition(x + 0.5, top + 0.0625, from + (k + 0.5) / 3);
      sleepers.setMatrixAt(n++, at);
    }
  }
  sleepers.receiveShadow = true;
  g.add(sleepers);
  return g;
}

export const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Buildings drawn facing +z and then turned the way they were placed. */
export const FACES = new Set<number>([
  Build.Gate,
  Build.Gantry,
  Build.TruckBay,
  Build.LargeBay,
  Build.Depot,
  Build.Office,
  Build.HarbourHut,
  Build.Customs,
  Build.BreakHut,
]);

/** Turn a tile's model about the tile centre so its front faces `orient`. */
export function turn(obj: Object3D, orient: number): Object3D {
  const [dx, dy] = FACING[orient & 3];
  const pivot = new Group();
  pivot.position.set(0.5, 0, 0.5);
  pivot.rotation.y = Math.atan2(dx, dy);
  obj.position.set(-0.5, 0, -0.5);
  pivot.add(obj);
  const outer = new Group();
  outer.add(pivot);
  return outer;
}

/**
 * An arrow painted on a road, the way traffic goes on it (a facing, see
 * FACING): a shaft and a head, flat on the tarmac at height `y`.
 */
export function roadArrow(g: Group, y: number, facing: number, scale = 1): void {
  const [dx, dy] = FACING[facing & 3];
  const arrow = new Group();
  arrow.scale.setScalar(scale);
  arrow.add(box(0.07, 0.008, 0.36, C.marking, 0, 0, -0.06));
  // The head: two strokes back from the tip, either side of the shaft.
  for (const side of [-1, 1]) {
    const head = new Group();
    head.position.set(0, 0, 0.14);
    head.rotation.y = side * 2.4;
    head.add(box(0.07, 0.008, 0.2, C.marking, 0, 0, 0.1));
    arrow.add(head);
  }
  arrow.position.set(0.5, y, 0.5);
  arrow.rotation.y = Math.atan2(dx, dy);
  g.add(arrow);
}
