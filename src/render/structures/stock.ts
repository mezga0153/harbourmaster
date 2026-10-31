import { Group, type Object3D } from 'three';
import type { BayView, PileView } from '../../protocol';
import {
  BOXES_PER_STORE_TILE,
  CRATES_PER_STORE_TILE,
  FORKLIFT_CAPACITY as PALLET,
} from '../../sim/balance';
import type { Cargo } from '../../sim/cargo';
import type { GameMap } from '../../sim/map';
import { crate, CRATE, paintCargo, paintContainer, setCrateIcon, setCrateSeal } from '../models';
import { C } from '../palette';
import { box } from '../parts';
import { QUAY_Y } from '../terrain';

// What lies in the port's storage: crates on the truck bays, in crate
// storage and piled on the quay, containers in the yards and on the cranes'
// stacks; shown as the snapshots say, each container staying in its slot
// as others come and go (see settle).

export interface BayStack {
  crates: Object3D[];
  boxes: Object3D[];
  /** Crate storage: the pallets' places, each holding four of `crates` and its pallet (`userData.pallet`). */
  places?: Object3D[];
}

/** Crates set down on the quay beside the boats, two piles of two high. */
export interface Pile {
  group: Group;
  crates: Object3D[];
  pallets: boolean;
}

export class Stock {
  /** Which container is in which slot, by yard (its first tile) or crane (as -1 - idx); see settle. */
  readonly slots = new Map<number, number[]>();
  /** Gantry cranes' stacks: each container's look and place, as the game has them. */
  readonly cranePlaces = new Map<number, { looks: number[]; places: number[] }>();
  /** Each container yard's tiles, by its first. */
  readonly yardTiles = new Map<number, number[]>();
  /** The tiles of each crate storage area, by its first, for where a jib crane sets crates. */
  readonly areas = new Map<number, number[]>();
  /** Cargo landed on the quay, by tile. */
  readonly piles = new Map<number, Pile>();

  constructor(
    private map: GameMap,
    /** Where the piles are drawn. */
    private group: Group,
    /** The crates and containers built on a tile, if any. */
    private stackAt: (i: number) => BayStack | undefined,
  ) {}

  setBays(bays: BayView[]): void {
    for (const b of bays) {
      if (b.tiles) {
        this.areas.set(b.idx, b.tiles);
        if (b.slots) this.palletise(b.tiles, b.slots, b.cargo, b.waiting);
        else this.fill(b.tiles, b.stock + b.exports, false, undefined, b.cargo, b.waiting);
        continue;
      }
      const stack = this.stackAt(b.idx);
      if (!stack) continue;
      // Its crates, and on top any ice waiting for the fishing boats, each
      // in the slot it was set down in.
      if (b.slots) {
        const at = new Map<number, number>();
        b.slots.forEach((s, j) => s >= 0 && at.set(s, j));
        stack.crates.forEach((c, s) => {
          const j = at.get(s);
          c.visible = j !== undefined;
          const kind = j === undefined ? undefined : b.cargo?.[j];
          if (kind) setCrateIcon(c, kind);
        });
      } else {
        stack.crates.forEach((c, k) => (c.visible = k < b.stock + b.exports));
        paintCargo(stack.crates, b.cargo);
      }
      stack.boxes.forEach((c, k) => (c.visible = k < b.boxes));
    }
  }

  /** Crates set down on the quay beside the boats, two piles of two high, on pallets or not. */
  setPiles(views: PileView[]): void {
    const seen = new Set<number>();
    for (const v of views) {
      seen.add(v.idx);
      let pile = this.piles.get(v.idx);
      if (pile && pile.pallets !== v.pallets) {
        this.group.remove(pile.group);
        pile = undefined;
      }
      if (!pile) {
        pile = this.pile(v.idx, v.pallets);
        this.piles.set(v.idx, pile);
        this.group.add(pile.group);
      }
      pile.crates.forEach((c, k) => (c.visible = k < v.crates));
      paintCargo(pile.crates, v.cargo);
    }
    for (const [i, pile] of this.piles) {
      if (seen.has(i)) continue;
      this.group.remove(pile.group);
      this.piles.delete(i);
    }
  }

  pile(i: number, pallets: boolean): Pile {
    const g = new Group();
    g.position.set(this.map.xOf(i), 0, this.map.yOf(i));
    const lift = pallets ? 0.04 : 0;
    const crates: Object3D[] = [];
    for (let layer = 0; layer < 2; layer++) {
      for (const [x, z] of [
        [0.38, 0.38],
        [0.62, 0.38],
        [0.38, 0.62],
        [0.62, 0.62],
      ]) {
        const c = crate(CRATE, x, QUAY_Y + lift + layer * CRATE, z);
        c.visible = false;
        g.add(c);
        crates.push(c);
      }
    }
    if (pallets) {
      for (const x of [0.38, 0.62]) {
        for (const z of [0.38, 0.62]) g.add(box(0.22, 0.04, 0.22, C.wood, x, QUAY_Y, z));
      }
    }
    return { group: g, crates, pallets };
  }

  /** Show a storage area's goods, a tile's worth at a time from its first tile. */
  fill(
    tiles: number[],
    count: number,
    boxes: boolean,
    looks?: number[],
    cargo?: Cargo[],
    waiting?: boolean[],
  ): void {
    let left = count;
    let at = 0;
    // Each container as it looks, staying in its slot as others come and go.
    const order = looks && tiles.length > 0 ? this.settled(tiles[0], looks) : undefined;
    for (const t of tiles) {
      const stack = this.stackAt(t);
      if (!stack) continue;
      const items = boxes ? stack.boxes : stack.crates;
      items.forEach((o, k) => {
        o.visible = k < left;
        if (order && o.visible && at + k < order.length) paintContainer(o, order[at + k]);
        if (!boxes && cargo && at + k < cargo.length) setCrateIcon(o, cargo[at + k]);
        if (!boxes) setCrateSeal(o, !!waiting?.[at + k]);
      });
      at += Math.min(left, items.length);
      left = Math.max(0, left - items.length);
    }
  }

  /**
   * Crate storage's crates, each in the slot it was set down in (`slots[j]`
   * the crate `j`'s, as the game has them): four pallet places to a tile,
   * four crates to each, a pallet under those with any.
   */
  palletise(tiles: number[], slots: number[], cargo?: Cargo[], waiting?: boolean[]): void {
    const at = new Map<number, number>();
    slots.forEach((s, j) => s >= 0 && at.set(s, j));
    tiles.forEach((t, n) => {
      const stack = this.stackAt(t);
      stack?.crates.forEach((o, k) => {
        const j = at.get(n * CRATES_PER_STORE_TILE + k);
        o.visible = j !== undefined;
        const c = j === undefined ? undefined : cargo?.[j];
        if (c) setCrateIcon(o, c);
        // Still in customs, or waiting on its export papers: sealed.
        setCrateSeal(o, j !== undefined && !!waiting?.[j]);
      });
      stack?.places?.forEach((place, p) => {
        const pallet = place.userData.pallet as Object3D | undefined;
        if (!pallet) return;
        const first = p * PALLET;
        pallet.visible = stack.crates.slice(first, first + PALLET).some((o) => o.visible);
      });
    });
  }

  /**
   * A yard's containers each in the slot the game stacks it in, `slots[k]`
   * looking like `looks[k]`: a tile's two stacks, three high, tile by tile.
   */
  stackYard(tiles: number[], slots: number[], looks: number[]): void {
    const per = BOXES_PER_STORE_TILE;
    const shown = new Map<number, number>();
    slots.forEach((k, j) => shown.set(k, looks[j]));
    tiles.forEach((t, n) => {
      this.stackAt(t)?.boxes.forEach((o, r) => {
        const look = shown.get(n * per + r);
        o.visible = look !== undefined;
        if (look !== undefined) paintContainer(o, look);
      });
    });
    // What is in it, for a gantry to tell when one has come or gone.
    if (tiles.length > 0) this.slots.set(tiles[0], [...looks]);
  }

  /** The slots of the containers kept under `key`, brought up to date with `looks`. */
  settled(key: number, looks: number[]): number[] {
    const order = settle(this.slots.get(key) ?? [], looks);
    this.slots.set(key, order);
    return order;
  }

  /**
   * How many containers that look like `look` are kept under `key` (a yard,
   * or a crane's stack): counted at the start of a lift, more or fewer show
   * when one has been set down there or taken away.
   */
  kept(key: number, look: number): number {
    return (this.slots.get(key) ?? []).reduce((n, l) => n + (l === look ? 1 : 0), 0);
  }

  /** Container slot `k` of a yard, counting a tile's worth at a time from its first. */
  yardSlot(tiles: number[], k: number): Object3D | undefined {
    if (k < 0) return undefined;
    for (const t of tiles) {
      const items = this.stackAt(t)?.boxes ?? [];
      if (k < items.length) return items[k];
      k -= items.length;
    }
    return undefined;
  }

  /** The containers kept under `key`, in slot order; see settle. */
  order(key: number): number[] {
    return this.slots.get(key) ?? [];
  }

  /** Yard slot `k` as the game stacks them: a tile's worth at a time, by tile. */
  boxAt(tiles: number[], k: number): Object3D | undefined {
    const per = BOXES_PER_STORE_TILE;
    return this.stackAt(tiles[Math.floor(k / per)])?.boxes[k % per];
  }

  /** The crate in crate storage `store` or pile `pile`, at `place`, if either is given. */
  crateIn(
    store: number | undefined,
    pile: number | undefined,
    place: number,
  ): Object3D | undefined {
    if (pile !== undefined) return this.piles.get(pile)?.crates[place];
    if (store === undefined) return undefined;
    let k = place;
    for (const t of this.areas.get(store) ?? []) {
      const items = this.stackAt(t)?.crates ?? [];
      if (k < items.length) return items[k];
      k -= items.length;
    }
    return undefined;
  }
}

/**
 * Which container goes in which slot of a stack or yard, given the slots
 * as they were and the containers there now (`looks`, in any order): each
 * stays in its slot, one gone makes room for the last, which moves into
 * its slot, and one come goes on the end. So taking one never changes the
 * colour of more than one slot, and the stack never has a gap in it.
 */
export function settle(order: number[], looks: number[]): number[] {
  const want = new Map<number, number>();
  for (const l of looks) want.set(l, (want.get(l) ?? 0) + 1);
  const kept = new Map<number, number>();
  const slots: (number | null)[] = order.map((l) => {
    const n = kept.get(l) ?? 0;
    if (n >= (want.get(l) ?? 0)) return null;
    kept.set(l, n + 1);
    return l;
  });
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] !== null) continue;
    while (slots.length > i && slots[slots.length - 1] === null) slots.pop();
    if (slots.length > i + 1) slots[i] = slots.pop()!;
  }
  for (const l of looks) {
    const n = kept.get(l) ?? 0;
    if (n >= (want.get(l) ?? 0)) continue;
    kept.set(l, n + 1);
    slots.push(l);
  }
  return slots as number[];
}
