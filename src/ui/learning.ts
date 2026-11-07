import { offerFilter, OFFER_DEFAULT } from './contractList';
import type { Actions } from './actions';
import type { GuideAction } from './guides';
import { categoryOf, toolsAt } from './tools';
import {
  contractsTab,
  guide,
  menuOpen,
  openCategory,
  panel,
  selection,
  snapshot,
  tool,
  trayTabs,
} from './store';

/** Choosing a tool from help also opens its exact category and tab. */
export function chooseTool(next: import('./tools').Tool): boolean {
  const cat = categoryOf(next);
  const def = cat && toolsAt(cat, snapshot.value?.progress.tier ?? 0).find((t) => t.tool === next);
  if (cat && !def) return false;
  panel.value = null;
  selection.value = null;
  menuOpen.value = false;
  if (cat && def) {
    openCategory.value = cat.id;
    trayTabs.value = { ...trayTabs.value, [cat.id]: def.group ?? cat.label };
  } else openCategory.value = null;
  tool.value = next;
  return true;
}

export function availableAction(action: GuideAction): boolean {
  if (action.inspect) {
    const s = snapshot.peek();
    if (!s) return false;
    if (action.inspect === 'storage') return s.bays.some((b) => b.tiles && !b.outgoing);
    if (action.inspect === 'crane') {
      const g = guide.peek();
      return s.cranes.some(
        (c) =>
          (g?.target === undefined || c.idx === g.target) &&
          (!g || !['jib', 'harbour', 'gantry'].includes(g.id) || c.kind === g.id),
      );
    }
    return s.entities.some((e) => e.kind === action.inspect);
  }
  if (!action.tool) return true;
  const cat = categoryOf(action.tool);
  return (
    !cat || toolsAt(cat, snapshot.value?.progress.tier ?? 0).some((t) => t.tool === action.tool)
  );
}

export function runHelpAction(action: GuideAction, actions: Actions): void {
  if (!availableAction(action)) return;
  const g = guide.value;
  if (g && !g.practice) {
    panel.value = null;
    guide.value = { ...g, practice: true };
  }
  if (action.tool) chooseTool(action.tool);
  if (action.offers) {
    contractsTab.value = 'offers';
    panel.value = 'contracts';
    offerFilter.value = {
      ...OFFER_DEFAULT,
      kind: action.offers === 'coaster' ? 'line' : action.offers,
    };
  } else if (action.panel) {
    panel.value = action.panel;
  }
  if (action.inspect) {
    const s = snapshot.value;
    if (!s) return;
    tool.value = 'select';
    openCategory.value = null;
    let x: number | undefined;
    let y: number | undefined;
    if (action.inspect === 'storage') {
      const b = s.bays.find((b) => b.tiles && !b.outgoing);
      if (b) {
        selection.value = { type: 'bay', idx: b.idx };
        actions.focusTile(b.idx);
      }
    } else if (action.inspect === 'crane') {
      const eligible = s.cranes.filter(
        (c) => !g || !['jib', 'harbour', 'gantry'].includes(g.id) || c.kind === g.id,
      );
      const c =
        eligible.find((c) => c.idx === g?.target) ?? eligible.find((c) => c.trouble) ?? eligible[0];
      if (c) {
        selection.value = { type: 'crane', idx: c.idx };
        actions.focusTile(c.idx);
      }
    } else {
      const e = s.entities.find((e) => e.kind === action.inspect);
      if (e) {
        selection.value = { type: 'entity', id: e.id };
        x = e.x;
        y = e.y;
      }
    }
    if (x !== undefined && y !== undefined) actions.focus(x, y);
  }
}

/** Capture once per reading session; switching steps must not lose the original speed. */
export function guidePause(sendSpeed: (speed: number) => void) {
  let before: number | null = null;
  let requested: number | null = null;
  return {
    requested(speed: number) {
      requested = speed;
    },
    observed(speed: number) {
      if (requested === speed) requested = null;
    },
    update(reading: boolean, speed: number) {
      if (reading && before === null) {
        before = requested ?? speed;
        sendSpeed(0);
      } else if (!reading && before !== null) {
        const restore = before;
        before = null;
        sendSpeed(restore);
      }
    },
    reset() {
      before = null;
      requested = null;
    },
  };
}
