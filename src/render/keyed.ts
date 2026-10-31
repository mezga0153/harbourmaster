import type { BufferGeometry } from 'three';

// Things drawn by key (an entity's id, a tile, a red mark's place in the
// list) that come and go as the game's snapshots say. Whatever is let go
// of is handed to one callback, the one place that takes it out of the
// scene and frees what it owned on the GPU, so nothing is dropped on the
// floor still holding a geometry.

/** Something drawn that may hold geometry of its own, made for it alone and freed with it. */
export interface Owns {
  /** Geometry this owns: never any of the shared geometry in parts.ts or util/mesh.ts. */
  owned?: BufferGeometry[];
}

/** Free the geometry `o` owns, and forget it. */
export function disposeOwned(o: Owns): void {
  if (!o.owned) return;
  for (const g of o.owned) g.dispose();
  o.owned = undefined;
}

export class KeyedObjects<K, T> {
  private items = new Map<K, T>();

  /** `gone` is called with each item as it is let go of, replaced or deleted. */
  constructor(private readonly gone: (item: T, key: K) => void) {}

  get size(): number {
    return this.items.size;
  }

  get(key: K): T | undefined {
    return this.items.get(key);
  }

  has(key: K): boolean {
    return this.items.has(key);
  }

  keys(): IterableIterator<K> {
    return this.items.keys();
  }

  values(): IterableIterator<T> {
    return this.items.values();
  }

  entries(): IterableIterator<[K, T]> {
    return this.items.entries();
  }

  [Symbol.iterator](): IterableIterator<[K, T]> {
    return this.items.entries();
  }

  /** Puts `item` under `key`, letting go of whatever was there. */
  set(key: K, item: T): T {
    const old = this.items.get(key);
    if (old !== undefined && old !== item) this.gone(old, key);
    this.items.set(key, item);
    return item;
  }

  /** Lets go of what is under `key`, if anything. */
  delete(key: K): boolean {
    const old = this.items.get(key);
    if (old === undefined) return false;
    this.items.delete(key);
    this.gone(old, key);
    return true;
  }

  /**
   * Keeps just the items under `keys`: makes any missing with `make`, in
   * the order given, and lets go of the rest.
   */
  sync(keys: Iterable<K>, make: (key: K) => T): void {
    const keep = new Set<K>();
    for (const k of keys) {
      keep.add(k);
      if (!this.items.has(k)) this.items.set(k, make(k));
    }
    for (const [k, item] of this.items) {
      if (!keep.has(k)) {
        this.items.delete(k);
        this.gone(item, k);
      }
    }
  }

  /** Lets go of everything. */
  clear(): void {
    for (const [k, item] of this.items) this.gone(item, k);
    this.items.clear();
  }
}
