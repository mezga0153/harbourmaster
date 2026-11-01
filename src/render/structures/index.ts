import { Group, Vector3, type Object3D } from 'three';
import type { BayView, CraneView, HandAt, PileView, TileChange, YardView } from '../../protocol';
import {
  BOXES_PER_STORE_TILE,
  CRATES_PER_STORE_TILE,
  FORKLIFT_CAPACITY as PALLET,
  CRANE_LIFT_TAKEN,
  YARD_GANTRY_TICKS,
} from '../../sim/balance';
import type { GameMap } from '../../sim/map';
import type { Train } from '../../sim/railway';
import { liftMarks, ON_QUAY, parkingLots } from '../../sim/rules';
import { Build, isPublicRoad, isTownBuilding } from '../../sim/types';
import { disposeOwned, KeyedObjects } from '../keyed';
import { CRATE, paintContainer } from '../models';
import { QUAY_Y } from '../terrain';
import { headingOf, syncPhase, lerpAngle } from '../util/math';
import { runHarbourCrane } from './cranes/harbourCrane';
import { reachOut, runJib, setJib } from './cranes/jib';
import type { CraneParts, CraneSite, YardGantryParts } from './cranes/parts';
import { runShipGantry } from './cranes/shipGantry';
import { liftFrom, NO_RUN, pickOf, runYardGantry } from './cranes/yardGantry';
import { animateFurniture } from './furniture';
import { offset, storeArea } from './map';
import { freeIn, lookIn, Stock, type BayStack } from './stock';
import {
  boundary,
  FACES,
  highwayEnds,
  machinesOutline,
  mainLine,
  makeTile,
  quay,
  turn,
  type Lot,
  type Site,
  type Tile,
  type TileParts,
} from './tiles';

export { settle } from './stock';

/**
 * Everything built on the map: roads, quays, buildings, cranes and what
 * lies in storage, each tile's model made again when it changes (see
 * tiles.ts), the stock shown as the snapshots say (stock.ts), the cranes
 * run frame by frame (cranes/) and the furniture animated (furniture.ts).
 */
export class Structures {
  readonly group = new Group();
  private tiles = new KeyedObjects<number, Tile>((t) => {
    this.group.remove(t.obj);
    disposeOwned(t);
    this.byPart.clear();
  });
  /** The game's tick, for the traffic lights' phases. */
  private tick = 0;
  /** Where a truck's container slot is in the world; set by the renderer. */
  truckSlot?: (id: number, k: number, out: Vector3) => Vector3 | null;
  /** Whether a truck's, tractor's or ship's container slot `k` shows a container. */
  slotShown?: (id: number, k: number) => boolean;
  /** The crate or container in slot `k` of a boat or vehicle, shown or not. */
  slotObject?: (id: number, k: number) => Object3D | undefined;
  /** Which way a ship's container slot lies in the world, for a harbour crane's spreader. */
  slotTurn?: (id: number, k: number) => number | null;
  private countAt = new Vector3();
  /** Game speed, so a gantry's lift takes as long as it does in the game. */
  private speed = 1;
  private train: Train | null = null;
  /** What lies in storage, on the quay and on the cranes' stacks. */
  private stock: Stock;
  /** What the tile builders and the cranes' runners ask of the port. */
  private tileSite: Site;
  private craneSite: CraneSite = {
    speed: () => this.speed,
    follow: (dt) => 1 - Math.exp(-dt * Math.max(1, this.speed) * 30),
    truckSlot: (id, k, out) => this.truckSlot?.(id, k, out) ?? null,
    slotShown: (id, k) => !!this.slotShown?.(id, k),
    slotObject: (id, k) => this.slotObject?.(id, k),
    slotTurn: (id, k) => this.slotTurn?.(id, k) ?? null,
    kept: (key, look) => this.stock.kept(key, look),
    order: (key) => this.stock.order(key),
    placed: (idx) => this.stock.cranePlaces.has(idx),
    crateIn: (store, pile, place) => this.stock.crateIn(store, pile, place),
    shownOn: (id) => this.shownOn(id),
  };

  /** `bare`: just the tiles, without the highway, railway and boundary round the map. */
  constructor(
    private map: GameMap,
    bare = false,
  ) {
    this.stock = new Stock(map, this.group, (i) => this.stackAt(i));
    this.tileSite = { map, lotAt: (i) => this.lotAt(i) };
    for (let i = 0; i < map.build.length; i++) this.rebuild(i);
    if (!bare) this.group.add(highwayEnds(map), mainLine(map), boundary(map));
  }

  /** What is drawn on tile `i`, if anything. */
  tileObject(i: number): Object3D | undefined {
    return this.tiles.get(i)?.obj;
  }

  /** The tiles with each kind of part, worked out once per rebuild; see each. */
  private byPart = new Map<keyof TileParts, Map<number, unknown>>();

  /** Each tile's `part`, with the tile, for those tiles that have one. */
  private each<P extends Exclude<keyof TileParts, 'owned'>>(
    part: P,
  ): Map<number, NonNullable<TileParts[P]>> {
    let m = this.byPart.get(part);
    if (!m) {
      m = new Map();
      for (const [i, t] of this.tiles) if (t[part] !== undefined) m.set(i, t[part]);
      this.byPart.set(part, m);
    }
    return m as Map<number, NonNullable<TileParts[P]>>;
  }

  private stackAt(i: number): BayStack | undefined {
    return this.tiles.get(i)?.stack;
  }

  /** The cranes and yard gantries by tile, as the tests look at them. */
  get cranes(): Map<number, CraneParts> {
    return new Map(this.each('crane'));
  }

  get yardGantries(): Map<number, YardGantryParts> {
    return new Map(this.each('yardGantry'));
  }

  private craneAt(i: number): CraneParts | undefined {
    return this.tiles.get(i)?.crane;
  }

  apply(changes: TileChange[]): void {
    const touched = new Set<number>();
    for (const c of changes) {
      // Diagonals too: a quay's safety line looks one tile round the corner.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const n = offset(this.map, c.i, dx, dy);
          if (n >= 0) touched.add(n);
        }
      }
    }
    // A parking lot is drawn whole: inside or out, and which way it runs,
    // depend on all of it and the roads along it.
    this.lots = null;
    for (const lot of parkingLots(this.map)) {
      if (lot.tiles.some((t) => touched.has(t))) for (const t of lot.tiles) touched.add(t);
    }
    // Containers lie along the long side of their yard, so the whole yard is
    // laid again when it changes shape.
    for (const i of [...touched]) {
      if (this.map.store[i]) for (const t of storeArea(this.map, i)) touched.add(t);
    }
    // A yard gantry's rails run the length of its yard, so it is laid again
    // whatever changes.
    if (changes.length > 0) for (const [i] of this.each('yardGantry')) touched.add(i);
    for (const i of touched) this.rebuild(i);
  }

  /** Each parking tile's lot: inside the port or out, and whether its spaces run across x. */
  private lots: Map<number, Lot> | null = null;

  private lotAt(i: number): Lot {
    if (!this.lots) {
      const m = this.map;
      this.lots = new Map();
      for (const lot of parkingLots(m)) {
        const xs = lot.tiles.map((t) => m.xOf(t));
        const ys = lot.tiles.map((t) => m.yOf(t));
        const w = Math.max(...xs) - Math.min(...xs) + 1;
        const h = Math.max(...ys) - Math.min(...ys) + 1;
        const space = lot.spaces[0];
        const acrossX = space ? m.xOf(space.ends[0]) !== m.xOf(space.ends[1]) : w <= h;
        // Laid out wrong it has no side yet: port paving if only port roads join it.
        const near = lot.tiles.flatMap((t) => m.neighbors4(t).map((n) => m.build[n]));
        const inside = space
          ? !lot.outside
          : !near.some((b) => isPublicRoad(b)) &&
            near.some((b) => b === Build.PortRoad || b === Build.Quay);
        const wide = space ? space.tiles.length === 2 : Math.min(w, h) === 2;
        const flow = lot.flow;
        for (const t of lot.tiles) this.lots.set(t, { inside, acrossX, wide, flow });
      }
    }
    return this.lots.get(i) ?? { inside: false, acrossX: false, wide: false };
  }

  setCranes(views: CraneView[]): void {
    for (const v of views) {
      const c = this.craneAt(v.idx);
      if (!c) continue;
      // Exports set down for a container crane wait on its stack too: on a
      // gantry crane's each in the place the game has it.
      if (v.cells) {
        const cells = v.cells;
        c.stack.forEach((o, k) => {
          const look = cells[k]?.look;
          o.visible = look !== undefined;
          if (look !== undefined) paintContainer(o, look);
        });
        // How each place looks, -1 empty, for its runner to tell when one has come or gone.
        this.stock.slots.set(
          -1 - v.idx,
          cells.map((q) => q?.look ?? -1),
        );
        this.stock.cranePlaces.set(v.idx, cells);
      } else c.stack.forEach((o, k) => (o.visible = k < v.stack + v.out));
      c.busy = v.busy;
      if (v.busy) c.target = -v.angle;
      if (c.jib) {
        setJib(c, c.jib, v);
        continue;
      }
      const g = c.sts ?? c.mhc;
      if (!g) continue;
      g.stacked = v.stack + v.out;
      g.work = v.working ?? null;
      g.truck = v.workTruck ?? -1;
      g.place = v.workPlace;
      if (v.workBoat !== undefined) g.boat = v.workBoat;
      if (v.workSlot !== undefined) g.slot = v.workSlot;
      if (v.workLook !== undefined && v.workLook !== g.look) {
        g.look = v.workLook;
        g.base = this.stock.kept(-1 - v.idx, g.look);
      }
      // Kept in step with the game, without jumping for a small difference,
      // nor while a harbour crane waits on the game to hand a container over.
      // A gantry waiting on a hand-over is let go once the game is on to its next lift.
      const waits = c.sts?.holding && v.workPhase !== undefined && v.workPhase >= CRANE_LIFT_TAKEN;
      if (v.workPhase !== undefined && !c.mhc?.held && !waits) {
        g.phase = syncPhase(g.phase, v.workPhase, { wrap: true });
      }
    }
  }

  /** Port gates lift their barrier while a truck is passing through. */
  setGates(trucks: { x: number; y: number }[]): void {
    for (const [i, g] of this.each('gate')) {
      const cx = this.map.xOf(i) + 0.5;
      const cy = this.map.yOf(i) + 0.5;
      g.open = trucks.some((t) => Math.hypot(t.x - cx, t.y - cy) < 1.6);
    }
  }

  /** Where the train is this frame, for the level crossings' barriers. */
  setTrain(train: Train | null): void {
    this.train = train;
  }

  /** The game's tick, which the traffic lights change by as they do in the game. */
  setTick(tick: number): void {
    this.tick = tick;
  }

  /** Per-frame animation: slew cranes towards their boats, bob the hooks, lift barriers. */
  update(dt: number, time: number): void {
    animateFurniture(
      {
        lights: this.each('lights'),
        crossings: this.each('crossing'),
        buoys: this.each('buoy'),
        gates: this.each('gate'),
      },
      dt,
      time,
      this.tick,
      this.train,
    );
    for (const [, g] of this.each('yardGantry')) runYardGantry(this.craneSite, g, dt);
    for (const [, c] of this.each('crane')) {
      if (c.sts) {
        runShipGantry(this.craneSite, c, c.sts, dt);
        continue;
      }
      if (c.jib) {
        runJib(this.craneSite, c, c.jib, dt);
        continue;
      }
      if (c.mhc) {
        runHarbourCrane(this.craneSite, c, c.mhc, dt);
        continue;
      }
      if (c.fixed) {
        // Out over the ship and back in over the bay between the legs.
        const out = c.busy ? 0.5 + 0.5 * Math.sin(time * 1.1) : 1;
        c.slew.position.z += (-0.5 + out * 2.7 - c.slew.position.z) * Math.min(1, dt * 4);
      } else {
        c.angle = lerpAngle(c.angle, c.target, Math.min(1, dt * 3));
        c.slew.rotation.y = c.angle;
      }
      const drop = c.rest + (c.busy ? (0.5 + 0.5 * Math.sin(time * 3)) * c.reach : 0);
      c.rope.scale.y = drop;
      c.rope.position.y = -drop / 2;
      c.hook.position.y = -drop;
    }
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  setYards(yards: YardView[]): void {
    for (const y of yards) {
      if (y.cells) this.stock.stackYard(y.tiles, y.cells);
      else this.stock.fill(y.tiles, y.boxes + y.exports + (y.lifted ?? 0), true);
      if (y.tiles.length > 0) this.stock.yardTiles.set(y.tiles[0], y.tiles);
      // Its gantry, at work or not, and where in the yard the container
      // it is moving lies, or for one coming off a truck, where it goes.
      const tiles = new Set(y.tiles);
      for (const [, g] of this.each('yardGantry')) {
        // Only the yard it works, though it may stand beside another too.
        if (!tiles.has(g.works)) continue;
        const was = g.work;
        const truck = g.truck;
        // A lift it has not been at yet: by when the game began it.
        const same =
          y.working === was &&
          y.workLook === g.look &&
          (y.workStart === undefined || y.workStart === g.liftStart);
        g.liftStart = y.workStart;
        g.legs = y.workLegs ?? NO_RUN;
        g.ticks = y.workTicks ?? YARD_GANTRY_TICKS;
        g.work = y.working ?? null;
        g.laneAt = y.workAt ?? 0;
        g.truck = y.workTruck;
        g.slot = y.workSlot ?? 0;
        // Keep the lift in step with the game's: the container leaves the
        // truck, or lands on it, as the spreader takes it or sets it down.
        // A new one starts where the game has it; the one it is at is
        // brought into step gently, never wrapped round into another.
        if (y.workPhase !== undefined && y.working) {
          g.phase = !same ? y.workPhase : syncPhase(g.phase, y.workPhase);
        }
        // A new lift runs along the rails from wherever it stands now.
        if (!same) {
          liftFrom(g);
          g.offAt = undefined;
        }
        if (y.workLook !== undefined) g.look = y.workLook;
        g.yard = y.tiles[0];
        // Seen first part way through a lift, as at speed, the container
        // may be lifted already: it was there as the lift began.
        const taken = (y.workPhase ?? 0) >= liftMarks(y.workLegs).taken ? 1 : 0;
        if (!same) g.base = this.stock.kept(g.yard, g.look) + (y.working === 'load' ? taken : 0);
        if (!same || g.truck !== truck) {
          g.held = this.shownOn(g.truck) + (y.working === 'unload' ? taken : 0);
        }
        // Once it has lifted a container out of the yard its slot is empty:
        // it is still going from there.
        const pick = !y.working
          ? null
          : y.workYard !== undefined
            ? pickOf(g, this.stock.boxAt(y.tiles, y.workYard))
            : this.slotFor(g, y.tiles, y.working, y.workLook);
        g.pick = pick ?? (y.working && same ? g.pick : null);
      }
    }
  }

  /**
   * Where on its beam a yard gantry takes the container it is loading on a
   * truck (the slot it lies in, by `look`), or puts one off a truck (the
   * next free slot): along the beam, across it, and how far down.
   */
  private slotFor(
    g: YardGantryParts,
    tiles: number[],
    work: 'load' | 'unload',
    look?: number,
  ): YardGantryParts['pick'] {
    const cells = tiles.length > 0 ? (this.stock.yardCells.get(tiles[0]) ?? []) : [];
    const k = work === 'load' ? (look === undefined ? -1 : lookIn(cells, look)) : freeIn(cells);
    return k < 0 ? null : pickOf(g, this.stock.boxAt(tiles, k));
  }

  /**
   * Where a container lies on a crane's stack or in a yard, by how it
   * looks, or with no look the next free place there, for a reach stacker
   * or tractor to take it or set it down: its base in `out`, and which way
   * its length runs, as a heading. Null if there is no such place.
   */
  containerAt(at: HandAt, out: Vector3): number | null {
    const crate = this.crateAt(at);
    if (crate !== undefined) {
      if (!crate) return null;
      crate.getWorldPosition(out);
      return headingOf(crate);
    }
    let slot: Object3D | undefined;
    const placed = at.crane !== undefined ? this.stock.cranePlaces.get(at.crane) : undefined;
    if (at.crane !== undefined && placed) {
      // A gantry crane's stack, each in its place.
      const stack = this.craneAt(at.crane)?.stack ?? [];
      const j = at.look === undefined ? -1 : lookIn(placed, at.look);
      const k = j >= 0 ? j : at.place;
      slot = k === undefined ? undefined : stack[k];
      if (at.look !== undefined && !slot?.visible) slot = undefined;
    } else if (at.crane !== undefined) {
      const stack = this.craneAt(at.crane)?.stack ?? [];
      const order = this.stock.slots.get(-1 - at.crane) ?? [];
      const k = at.look === undefined ? order.length : order.indexOf(at.look);
      slot = k < 0 ? undefined : stack[Math.min(k, stack.length - 1)];
    } else if (at.store !== undefined && at.place !== undefined) {
      // A pallet's place in crate storage, the way its forks go in.
      const tiles = this.stock.areas.get(at.store) ?? [at.store];
      const per = CRATES_PER_STORE_TILE / PALLET;
      const place = this.stackAt(tiles[Math.floor(at.place / per)])?.places?.[at.place % per];
      if (!place) return null;
      place.getWorldPosition(out);
      return headingOf(place);
    } else if (at.yard !== undefined && at.place !== undefined) {
      const tiles = this.stock.yardTiles.get(at.yard) ?? [];
      const per = BOXES_PER_STORE_TILE;
      slot = this.stackAt(tiles[Math.floor(at.place / per)])?.boxes[at.place % per];
      // A given container is there only while it shows.
      if (at.look !== undefined && !slot?.visible) slot = undefined;
    } else if (at.yard !== undefined) {
      const cells = this.stock.yardCells.get(at.yard) ?? [];
      const k = at.look === undefined ? freeIn(cells) : lookIn(cells, at.look);
      if (k >= 0) slot = this.stock.boxAt(this.stock.yardTiles.get(at.yard) ?? [], k);
    }
    if (!slot) return null;
    slot.getWorldPosition(out);
    return headingOf(slot);
  }

  /**
   * A crate's place a forklift or dockhand works, by its slot: on the quay,
   * at a truck bay, in crate storage or on a jib crane's landing stack; null
   * if there is none there, undefined if `at` is not one of these.
   */
  private crateAt(at: HandAt): Object3D | null | undefined {
    if (at.slot === undefined || at.look !== undefined) return undefined;
    const k = at.slot;
    if (at.pile !== undefined) return this.stock.piles.get(at.pile)?.crates[k] ?? null;
    if (at.bay !== undefined) return this.stackAt(at.bay)?.crates[k] ?? null;
    if (at.store !== undefined) {
      const tiles = this.stock.areas.get(at.store) ?? [at.store];
      const tile = tiles[Math.floor(k / CRATES_PER_STORE_TILE)];
      return this.stackAt(tile)?.crates[k % CRATES_PER_STORE_TILE] ?? null;
    }
    if (at.crane !== undefined && this.craneAt(at.crane)?.jib) {
      return this.craneAt(at.crane)?.stack[k] ?? null;
    }
    return undefined;
  }

  /**
   * Whether a crate shows on the ground at x, z, `pad` round it: in a truck
   * bay's stack or crate storage, piled on the quay or on a jib crane's
   * landing stack. For a forklift to keep its body off them.
   */
  crateIn(x: number, z: number, pad = 0): boolean {
    const m = this.map;
    const at = new Vector3();
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = Math.floor(x) + dx;
        const tz = Math.floor(z) + dz;
        if (!m.inBounds(tx, tz)) continue;
        const i = m.idx(tx, tz);
        const crates = [
          ...(this.stackAt(i)?.crates ?? []),
          ...(this.stock.piles.get(i)?.crates ?? []),
          ...(this.craneAt(i)?.jib ? this.craneAt(i)!.stack : []),
        ];
        for (const c of crates) {
          if (!c.visible) continue;
          c.getWorldPosition(at);
          const half = (c.userData.size ?? CRATE) / 2 + pad;
          if (Math.abs(at.x - x) < half && Math.abs(at.z - z) < half) return true;
        }
      }
    }
    return false;
  }

  /**
   * The crates showing on the ground of tile `i`, in a truck bay's stack or
   * crate storage, piled on the quay or on a jib crane's landing stack:
   * each one's middle and half its width, for the staff's grid (see
   * entities/grid.ts) to keep dockhands and forklifts out of.
   */
  cratesOn(i: number): { x: number; z: number; half: number }[] {
    const out: { x: number; z: number; half: number }[] = [];
    const at = new Vector3();
    const crane = this.craneAt(i);
    for (const list of [
      this.stackAt(i)?.crates,
      this.stock.piles.get(i)?.crates,
      crane?.jib ? crane.stack : undefined,
    ]) {
      for (const c of list ?? []) {
        if (!c.visible) continue;
        c.getWorldPosition(at);
        out.push({ x: at.x, z: at.z, half: (c.userData.size ?? CRATE) / 2 });
      }
    }
    return out;
  }

  /** How many containers a truck or tractor shows. */
  private shownOn(id: number | undefined): number {
    let n = 0;
    if (id === undefined) return n;
    for (let k = 0; this.truckSlot?.(id, k, this.countAt); k++) {
      if (this.slotShown?.(id, k)) n++;
    }
    return n;
  }

  setBays(bays: BayView[]): void {
    this.stock.setBays(bays);
  }

  /** Crates set down on the quay beside the boats, two piles of two high, on pallets or not. */
  setPiles(views: PileView[]): void {
    this.stock.setPiles(views);
  }

  private rebuild(i: number): void {
    const old = this.tiles.get(i);
    // A yard gantry or jib crane laid again carries on where it was.
    const was = old?.yardGantry;
    const jibWas = old?.crane;
    // Out of the scene, and its own geometry (baked roads and buildings) freed.
    this.tiles.delete(i);
    const parts: TileParts = { owned: [] };
    let obj = makeTile(this.tileSite, i, parts);
    const now = parts.yardGantry;
    if (was && now) {
      // On its rails as they are now, the yard made shorter or split.
      now.carriage.position.x = Math.min(
        now.railTo,
        Math.max(now.railFrom, was.carriage.position.x),
      );
      now.trolley.position.z = was.trolley.position.z;
      const { pick, work, look, phase, base, held, legs, ticks, startX, startZ } = was;
      Object.assign(now, { pick, work, look, phase, base, held, legs, ticks, startX, startZ });
    }
    const jibNow = parts.crane;
    if (jibWas?.jib && jibNow?.jib) {
      jibNow.angle = jibWas.angle;
      jibNow.slew.rotation.y = jibWas.angle;
      reachOut(jibNow.jib, jibWas.jib.out);
      const { work, boat, slot, store, pile, place, carriesPallet, phase, key, start } = jibWas.jib;
      Object.assign(jibNow.jib, { work, boat, slot, store, pile, place, carriesPallet });
      Object.assign(jibNow.jib, { phase, key, start });
    }
    if ((FACES.has(this.map.build[i]) || isTownBuilding(this.map.build[i])) && obj) {
      obj = turn(obj, this.map.orient[i]);
    }
    // A yard laid out on a quay stands on the quay's walls and piles.
    if (this.map.orient[i] & ON_QUAY) {
      const both = new Group();
      const deck = new Group();
      quay(this.map, deck, i, true);
      machinesOutline(this.map, deck, i, QUAY_Y);
      both.add(deck);
      if (obj) both.add(obj);
      obj = both;
    }
    if (!obj) return;
    obj.position.set(this.map.xOf(i), 0, this.map.yOf(i));
    this.group.add(obj);
    this.tiles.set(i, { ...parts, obj });
    this.byPart.clear();
  }
}
