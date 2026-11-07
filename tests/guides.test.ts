import { describe, expect, it } from 'vitest';
import type { CraneFix, ProblemView, Snapshot } from '../src/protocol';
import { selectionAt } from '../src/input/select';
import { GUIDES, stepFor, type GuideStep } from '../src/ui/guides';
import { guide } from '../src/ui/store';

describe('Guides', () => {
  it('have a step for everything that can keep each kind of crane from working', () => {
    const can: Record<'jib' | 'harbour' | 'gantry', CraneFix[]> = {
      jib: ['water', 'office', 'storage'],
      harbour: ['water', 'office', 'wide', 'room', 'depth'],
      gantry: ['water', 'office', 'wide', 'room', 'depth'],
    };
    for (const [kind, fixes] of Object.entries(can) as [keyof typeof can, CraneFix[]][]) {
      const steps = GUIDES[kind].steps as GuideStep[];
      for (const fix of fixes) expect(steps[stepFor(kind, fix)].fixes).toContain(fix);
    }
  });

  it('open on the step that puts a crane right when its red mark is clicked', () => {
    guide.value = null;
    const s = { cranes: [{ idx: 7, kind: 'jib', fix: 'storage' }] } as unknown as Snapshot;
    const problem = { type: 'crane', idx: 7, x: 0, y: 0, h: 1, text: '' } as ProblemView;
    expect(selectionAt(null, s, 7, { problem, entity: null })).toEqual({ type: 'crane', idx: 7 });
    expect(guide.value).toEqual({ id: 'jib', step: stepFor('jib', 'storage'), target: 7 });
    // Any other mark opens none.
    guide.value = null;
    selectionAt(null, s, 7, { problem: { ...problem, type: 'depot' }, entity: null });
    expect(guide.value).toBeNull();
  });
});
