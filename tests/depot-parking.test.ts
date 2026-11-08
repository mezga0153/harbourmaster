import { describe, expect, it } from 'vitest';
import { Box3, Group, Mesh, Vector3, type Object3D } from 'three';
import { Entities } from '../src/render/entities';
import { Structures } from '../src/render/structures';
import { surfaceY } from '../src/render/terrain';
import { MACHINES, parkPoses } from '../src/sim/machines';
import { Build, Terrain, type MachineKind } from '../src/sim/types';
import { World } from '../src/sim/world';
import { depotRoom, headTo } from '../src/sim/systems/workforce/dockhands';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Depots round a crossroads of port road, by where they stand from it, which way their door faces and what lives there. */
const DEPOTS: [number, number, number, MachineKind[]][] = [
  [-2, -1, 1, ['forklift', 'forklift', 'forklift']],
  [2, 1, 3, ['forklift', 'forklift', 'forklift']],
  [-1, -3, 0, ['forklift', 'forklift', 'forklift']],
  [1, 3, 2, ['forklift', 'forklift', 'forklift']],
  // Two side by side, one long garage.
  [2, -1, 1, ['forklift', 'forklift']],
  [3, -1, 1, ['forklift', 'forklift', 'forklift']],
  [-3, 1, 3, ['stacker', 'forklift']],
  [-1, 3, 0, ['tractor', 'stacker']],
  [1, -3, 2, ['tractor', 'tractor', 'tractor']],
  [-4, -1, 1, ['tractor', 'forklift', 'tractor']],
  [4, 1, 3, ['forklift', 'tractor', 'forklift']],
  [-4, 1, 3, ['forklift']],
  [1, -1, 1, ['stacker']],
];

function depotPort() {
  const world: Any = World.create(7, 96);
  world.tier = 2;
  world.cash = 10_000_000;
  const m = world.map;
  let cx = -1;
  let cy = -1;
  for (let y = 8; y < m.h - 8 && cx < 0; y++) {
    for (let x = 8; x < m.w - 8 && cx < 0; x++) {
      let ok = true;
      for (let dy = -6; dy <= 6 && ok; dy++) {
        for (let dx = -6; dx <= 6 && ok; dx++) {
          const i = m.idx(x + dx, y + dy);
          const t = m.terrain[i];
          if (t === Terrain.Water || t === Terrain.Rock || m.build[i] !== Build.None) ok = false;
        }
      }
      if (ok) [cx, cy] = [x, y];
    }
  }
  expect(cx, 'a clear patch of land').toBeGreaterThan(0);
  const at = (x: number, y: number) => m.idx(cx + x, cy + y);
  const road: number[] = [];
  for (let k = -5; k <= 5; k++) road.push(at(k, 0), at(0, k));
  world.command({ type: 'build', kind: 'portRoad', tiles: road });
  const depots: number[] = [];
  for (const [x, y, facing, kinds] of DEPOTS) {
    const i = at(x, y);
    world.command({ type: 'build', kind: 'depot', tiles: [i], facing });
    expect(m.build[i]).toBe(Build.Depot);
    for (const kind of kinds) world.command({ type: 'buyMachine', kind, tile: i });
    expect(world.people.filter((p: Any) => p.home === i).length).toBe(kinds.length);
    depots.push(i);
  }
  return { world, m, depots, road: at(0, 0) };
}

/** Each visible mesh's box in the world, and its corners. */
function meshes(o: Object3D): { box: Box3; corners: Vector3[] }[] {
  const out: { box: Box3; corners: Vector3[] }[] = [];
  o.traverseVisible((c) => {
    // The light a machine throws on the ground at night is not part of it.
    if (!(c instanceof Mesh) || c.userData.thrown) return;
    c.geometry.computeBoundingBox();
    const b = c.geometry.boundingBox!;
    const corners: Vector3[] = [];
    for (const x of [b.min.x, b.max.x]) {
      for (const y of [b.min.y, b.max.y]) {
        for (const z of [b.min.z, b.max.z]) {
          corners.push(new Vector3(x, y, z).applyMatrix4(c.matrixWorld));
        }
      }
    }
    out.push({ box: new Box3().setFromPoints(corners), corners });
  });
  return out;
}

/** Overlapping by more than a hair. */
function overlaps(a: Box3, b: Box3, hair = 0.002): boolean {
  return (
    a.min.x < b.max.x - hair &&
    b.min.x < a.max.x - hair &&
    a.min.y < b.max.y - hair &&
    b.min.y < a.max.y - hair &&
    a.min.z < b.max.z - hair &&
    b.min.z < a.max.z - hair
  );
}

/**
 * A turned mesh, given by its corners, overlapping a box set square by
 * more than a hair: no axis keeps them apart (the separating axis test).
 */
function cuts(corners: Vector3[], b: Box3, hair = 0.004): boolean {
  // Corners 0..7 run z fastest, then y, then x: the mesh's own axes.
  const edges = [
    corners[4].clone().sub(corners[0]),
    corners[2].clone().sub(corners[0]),
    corners[1].clone().sub(corners[0]),
  ];
  const square = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  const axes = [...square, ...edges.map((e) => e.clone().normalize())];
  for (const e of edges) for (const q of square) axes.push(e.clone().cross(q));
  const boxCorners: Vector3[] = [];
  for (const x of [b.min.x, b.max.x]) {
    for (const y of [b.min.y, b.max.y]) {
      for (const z of [b.min.z, b.max.z]) boxCorners.push(new Vector3(x, y, z));
    }
  }
  for (const axis of axes) {
    const n = axis.length();
    if (n < 1e-9) continue;
    const span = (ps: Vector3[]) => {
      const d = ps.map((p) => p.dot(axis) / n);
      return [Math.min(...d), Math.max(...d)];
    };
    const [a0, a1] = span(corners);
    const [b0, b1] = span(boxCorners);
    if (a1 <= b0 + hair || b1 <= a0 + hair) return false;
  }
  return true;
}

function scene(world: Any) {
  const m = world.map;
  const structures = new Structures(m, true);
  const entities = new Entities(m);
  const root = new Group();
  root.add(structures.group, entities.group);
  return { structures, entities, root };
}

/** A depot's walls, roof and door, without the floor the machines stand on. */
function walls(structures: Structures, m: Any, depots: number[]): Box3[] {
  const out: Box3[] = [];
  for (const i of depots) {
    const floor = surfaceY(m, m.xOf(i) + 0.5, m.yOf(i) + 0.5);
    for (const { box } of meshes(structures.tileObject(i)!)) {
      if (box.max.y > floor + 0.01) out.push(box);
    }
  }
  return out;
}

describe('Machines parked in their depot', () => {
  it('stand inside it, under its roof, clear of its walls and of each other, whichever way it faces', () => {
    const { world, m, depots } = depotPort();
    for (let k = 0; k < 30; k++) world.step();
    const { structures, entities, root } = scene(world);
    const s = world.snapshot();
    let now = 0;
    entities.push(s.entities, now, s.tick);
    for (let f = 0; f < 10; f++) entities.update((now += 16), now / 1000);
    root.updateMatrixWorld(true);
    const solid = walls(structures, m, depots);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (entities as any).entries as Map<number, any>;
    const parked = world.people.filter((p: Any) => p.kind !== 'dockhand');
    expect(parked.length).toBe(DEPOTS.reduce((n, d) => n + d[3].length, 0));
    const shapes = new Map<number, { box: Box3; corners: Vector3[] }[]>();
    for (const p of parked) {
      const view = s.entities.find((v: Any) => v.id === p.id);
      expect(view.parked, `${p.name} parked`).toBe(true);
      const home = p.home;
      const [tx, ty] = [m.xOf(home), m.yOf(home)];
      const floor = surfaceY(m, tx + 0.5, ty + 0.5);
      const parts = meshes(entries.get(p.id).model.root);
      shapes.set(p.id, parts);
      for (const { box } of parts) {
        // On its own tile, under the roof.
        expect(box.min.x, `${p.name} in its depot`).toBeGreaterThan(tx - 0.001);
        expect(box.max.x, `${p.name} in its depot`).toBeLessThan(tx + 1.001);
        expect(box.min.z, `${p.name} in its depot`).toBeGreaterThan(ty - 0.001);
        expect(box.max.z, `${p.name} in its depot`).toBeLessThan(ty + 1.001);
        expect(box.max.y, `${p.name} under the roof`).toBeLessThan(floor + 0.51);
        for (const w of solid) expect(overlaps(box, w), `${p.name} through a wall`).toBe(false);
      }
    }
    // Clear of each other.
    for (const a of parked) {
      for (const b of parked) {
        if (a.id >= b.id || a.home !== b.home) continue;
        for (const pa of shapes.get(a.id)!) {
          for (const pb of shapes.get(b.id)!) {
            expect(overlaps(pa.box, pb.box), `${a.name} in ${b.name}`).toBe(false);
          }
        }
      }
    }
  });

  it('lie inside the tile for every way a depot faces and every mix it houses', () => {
    const mixes: MachineKind[][] = [
      ['forklift'],
      ['forklift', 'forklift'],
      ['forklift', 'forklift', 'forklift'],
      ['tractor', 'tractor', 'tractor'],
      ['forklift', 'tractor', 'tractor'],
      ['tractor', 'forklift', 'forklift'],
      ['stacker', 'forklift'],
      ['tractor', 'stacker'],
    ];
    for (const mix of mixes) {
      expect(mix.reduce((n, k) => n + MACHINES[k].room, 0)).toBeLessThanOrEqual(3);
      for (let facing = 0; facing < 4; facing++) {
        for (const p of parkPoses(mix, 10, 20, facing)) {
          expect(Math.floor(p.x)).toBe(10);
          expect(Math.floor(p.y)).toBe(20);
          // Square on to the door.
          expect(Math.abs(Math.sin(p.dir - (facing * Math.PI) / 2))).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('house a reach stacker in two places', () => {
    const { world, depots } = depotPort();
    const stacker = depots[DEPOTS.findIndex((d) => d[3].length === 1 && d[3][0] === 'stacker')];
    const before = world.people.length;
    world.command({ type: 'buyMachine', kind: 'stacker', tile: stacker });
    expect(world.people.length).toBe(before);
    world.command({ type: 'buyMachine', kind: 'forklift', tile: stacker });
    expect(world.people.length).toBe(before + 1);
  });

  it('move to another depot with room when an older save has more in one than fit', () => {
    const { world, depots } = depotPort();
    const one = depots[DEPOTS.findIndex((d) => d[3].length === 1 && d[3][0] === 'stacker')];
    const two = depots[DEPOTS.findIndex((d) => d[3].length === 1 && d[3][0] === 'forklift')];
    // A second stacker in one depot, as an older save could have, and room for it in another.
    world.people.splice(
      world.people.findIndex((p: Any) => p.home === two),
      1,
    );
    world.people.find((p: Any) => p.kind === 'stacker' && p.home !== one).home = one;
    const loaded: Any = World.fromSave(world.toSave());
    for (const i of depots) expect(depotRoom(loaded, i), `room at ${i}`).toBeGreaterThanOrEqual(0);
    expect(loaded.people.filter((p: Any) => p.home === one).length).toBe(1);
  });

  it('drive out and back in through the door, not through the walls', () => {
    const { world, m, depots, road } = depotPort();
    for (let k = 0; k < 5; k++) world.step();
    const { structures, entities, root } = scene(world);
    root.updateMatrixWorld(true);
    // Each one's own depot: on the road outside it is in traffic like any other.
    const own = new Map(depots.map((i) => [i, walls(structures, m, [i])]));
    expect(own.get(depots[0])!.length).toBeGreaterThan(4);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (entities as any).entries as Map<number, any>;
    let now = 0;
    // Seen parked first.
    const first = world.snapshot();
    entities.push(first.entities, now, first.tick);
    for (let f = 0; f < 3; f++) entities.update((now += 100 / 3), now / 1000);
    // Every one sent off to the crossroads, to come back to park.
    const fleet = world.people.filter((p: Any) => p.kind !== 'dockhand');
    for (const p of fleet) {
      expect(headTo(world, p, road), `${p.name} finds its way out`).toBe(true);
      p.state = 'wander';
    }
    let left = 0;
    for (let t = 0; t < 600; t++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      for (let f = 0; f < 3; f++) {
        entities.update((now += 100 / 3), now / 1000);
        root.updateMatrixWorld(true);
        for (const p of fleet) {
          for (const { box, corners } of meshes(entries.get(p.id).model.root)) {
            const hit = own.get(p.home)!.find((w) => overlaps(box, w) && cuts(corners, w));
            if (hit) {
              throw new Error(
                `${p.name} through a wall at tick ${t}: ${JSON.stringify(box)} ${JSON.stringify(hit)}`,
              );
            }
          }
        }
      }
      if (fleet.some((p: Any) => world.tileOf(p) !== p.home)) left++;
    }
    expect(left, 'they went out').toBeGreaterThan(10);
    // And back home again, parked.
    const s = world.snapshot();
    for (const p of fleet) expect(s.entities.find((v: Any) => v.id === p.id)?.parked).toBe(true);
  }, 120_000);
});
