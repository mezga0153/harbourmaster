import { describe, expect, it } from 'vitest';
import { settle } from '../src/render/structures';

describe('Container slots', () => {
  it('keeps each container in its slot as others come and go', () => {
    let order = settle([], [1, 2, 3, 4, 5]);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    // The first is taken: the last moves into its slot, the rest stay put.
    order = settle(order, [2, 3, 4, 5]);
    expect(order).toEqual([5, 2, 3, 4]);
    // One comes, in any order the yard lists them: it goes on the end.
    order = settle(order, [9, 2, 3, 4, 5]);
    expect(order).toEqual([5, 2, 3, 4, 9]);
    // Two go at once, one of them the last.
    order = settle(order, [2, 4, 5]);
    expect(order).toEqual([5, 2, 4]);
    // Alike ones count as many as there are.
    expect(settle([7, 7, 8], [7, 8])).toEqual([7, 8]);
    expect(settle([], [])).toEqual([]);
  });
});
