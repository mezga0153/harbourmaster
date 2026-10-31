import { describe, expect, it } from 'vitest';
import { Box3, Group, Vector3, type Object3D } from 'three';
import { depotDoorTrouble, FACING, frontOf, placementError } from '../src/sim/rules';
import { Build, TICKS_PER_DAY } from '../src/sim/types';
import { World } from '../src/sim/world';
import { Entities } from '../src/render/entities';
import { Structures } from '../src/render/structures';
import { surfaceY } from '../src/render/terrain';

/**
 * The first port with its jetty made a quay, a jib crane and crate storage
 * at its end, its dockhands, and two forklifts to take the crates on to
 * the truck bay and load the trucks there.
 */
function port(): World {
  const world = World.create(7, 96);
  const m = world.map;
  world.tier = 1;
  world.cash = 1_000_000;
  const r = m.yOf(m.entry);
  const jetty = [...m.build.keys()].filter((i) => m.yOf(i) === r && m.build[i] === Build.Jetty);
  world.command({ type: 'build', kind: 'quay', tiles: jetty });
  const paths = [...m.build.keys()].filter((i) => m.build[i] === Build.Footpath);
  world.command({ type: 'build', kind: 'portRoad', tiles: paths });
  const office = m.build.findIndex((b, i) => b === Build.None && !placementError(m, 'office', i));
  world.command({ type: 'build', kind: 'office', tiles: [office] });
  world.command({ type: 'build', kind: 'jibCrane', tiles: [jetty[jetty.length - 1]] });
  world.command({ type: 'store', tiles: jetty.slice(-3, -1), kind: 'crates', on: true });
  for (let i = 0; i < m.build.length; i++) {
    if (placementError(m, 'depot', i)) continue;
    const f = [0, 1, 2, 3].find((f) => {
      const front = frontOf(m, i, f);
      return !depotDoorTrouble(m, i, f) && front >= 0 && m.build[front] === Build.PortRoad;
    });
    if (f === undefined) continue;
    world.command({ type: 'build', kind: 'depot', tiles: [i], facing: f });
    for (let k = 0; k < 2; k++) world.command({ type: 'buyMachine', kind: 'forklift', tile: i });
    break;
  }
  expect(world.people.filter((p) => p.kind === 'forklift')).toHaveLength(2);
  return world;
}

/**
 * Truck bays either side of the first, facing the same way, each with the
 * road it opens onto and port road behind it, so the bays stand in a row:
 * how many went up.
 */
function row(world: World): number {
  const m = world.map;
  const first = m.build.findIndex((b) => b === Build.TruckBay);
  const facing = m.orient[first];
  const [fx, fy] = FACING[facing];
  let built = 0;
  for (const side of [1, -1]) {
    const x = m.xOf(first) - fy * side;
    const y = m.yOf(first) + fx * side;
    const at = m.idx(x, y);
    const front = m.idx(x + fx, y + fy);
    const back = m.idx(x - fx, y - fy);
    if (m.build[at] !== Build.None) continue;
    if (m.build[front] === Build.None)
      world.command({ type: 'build', kind: 'road', tiles: [front] });
    if (m.build[back] === Build.None) {
      world.command({ type: 'build', kind: 'portRoad', tiles: [back] });
    }
    world.command({ type: 'build', kind: 'truckBay', tiles: [at], facing });
    if ((m.build[at] as number) === Build.TruckBay) built++;
  }
  return built;
}

describe("A truck bay's sign", () => {
  it('stands where no truck, forklift or dockhand at the bay ever goes', () => {
    const world = port();
    expect(row(world)).toBe(2);
    const m = world.map;
    const structures = new Structures(m, true);
    const entities = new Entities(m);
    structures.truckSlot = (id, k, out) => entities.slotPosition(id, k, out);
    structures.slotShown = (id, k) => entities.slotShown(id, k);
    structures.slotObject = (id, k) => entities.slotObject(id, k);
    entities.containerAt = (at, out) => structures.containerAt(at, out);
    entities.crateIn = (x, z, pad) => structures.crateIn(x, z, pad);
    const scene = new Group();
    scene.add(structures.group, entities.group);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (entities as any).entries as Map<number, any>;
    const still = new Map<number, number>();
    // Each sign's post, and how high its board's bottom edge is.
    const signs = () => {
      const posts: Vector3[] = [];
      const lows: number[] = [];
      structures.group.traverse((o: Object3D) => {
        if (o.userData.baySignPost) posts.push(o.getWorldPosition(new Vector3()));
        if (!o.userData.baySign) return;
        const at = o.localToWorld(new Vector3(0, -0.5, 0));
        lows.push(at.y - surfaceY(m, at.x, at.z));
      });
      return { posts, lows };
    };
    // How far a model reaches each way from its middle, unturned.
    const sizeOf = (root: Object3D) => {
      const turned = root.clone();
      turned.position.set(0, 0, 0);
      turned.rotation.y = 0;
      turned.updateMatrixWorld(true);
      return new Box3().setFromObject(turned);
    };
    // How far a point is inside a body facing `dir` round `x, z`, from
    // `behind` to `ahead` along it and `lo` to `hi` across; below 0 if clear.
    const into = (
      p: Vector3,
      x: number,
      z: number,
      dir: number,
      [behind, ahead, lo, hi]: number[],
    ) => {
      const dx = p.x - x;
      const dz = p.z - z;
      const a = dx * Math.cos(dir) + dz * Math.sin(dir);
      const b = -dx * Math.sin(dir) + dz * Math.cos(dir);
      return Math.min(a - behind, ahead - a, b - lo, hi - b);
    };
    // A forklift's body and its forks out ahead (see forklift()), and the
    // height of it and the trucks, the board over them.
    const FORKLIFT = [-0.26, 0.42, -0.175, 0.175];
    const TALLEST = 0.48;
    // The post's half width and a little room round it.
    const pad = 0.03;
    let near = 0;
    let loading = 0;
    for (let t = 0, now = 0; t < TICKS_PER_DAY * 2; t++) {
      world.step();
      const s = world.snapshot();
      entities.push(s.entities, now, s.tick);
      structures.setBays(s.bays);
      structures.setPiles(s.piles);
      for (const v of s.entities) {
        if (v.kind === 'truck') still.set(v.id, v.moving ? 0 : (still.get(v.id) ?? 0) + 1);
      }
      for (let f = 0; f < 6; f++) {
        now += 100 / 6;
        entities.update(now, now / 1000);
        structures.update(1 / 60, now / 1000);
        scene.updateMatrixWorld(true);
        const { posts, lows } = signs();
        expect(posts.length).toBe(3);
        for (const low of lows) expect(low).toBeGreaterThan(TALLEST);
        for (const post of posts) {
          for (const e of entries.values()) {
            const v = e.view;
            const r = e.model.root;
            if (Math.hypot(post.x - r.position.x, post.z - r.position.z) > 1) continue;
            const at = [r.position.x, r.position.z, -r.rotation.y] as const;
            if (v.kind === 'forklift') {
              near++;
              expect(into(post, ...at, FORKLIFT)).toBeLessThan(-pad);
            } else if (v.kind === 'dockhand') {
              near++;
              expect(Math.hypot(post.x - r.position.x, post.z - r.position.z)).toBeGreaterThan(
                0.08,
              );
            } else if (v.kind === 'truck') {
              // Standing in the bay, and coming and going.
              if ((still.get(v.id) ?? 0) >= 10) loading++;
              const body: Box3 = (e.size ??= sizeOf(r));
              const box = [body.min.x, body.max.x, body.min.z, body.max.z];
              expect(into(post, ...at, box)).toBeLessThan(-pad);
            }
          }
        }
      }
    }
    expect(near).toBeGreaterThan(200);
    expect(loading).toBeGreaterThan(50);
  }, 120_000);
});
