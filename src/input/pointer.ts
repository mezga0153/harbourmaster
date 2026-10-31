import type { GameMap } from '../sim/map';
import { BUILDABLES } from '../sim/rules';
import type { BuildKind } from '../sim/types';
import { isStoreTool, type Tool } from '../ui/tools';

// The mouse and fingers on the map: which gesture they are making, told to
// whoever handles it. What the gestures mean for the game is input.ts's.

export type Mode = 'none' | 'select' | 'pan' | 'drag' | 'place' | 'pinch';

/** What the pointer's gestures do; see Input. */
export interface PointerHandlers {
  /** What pressing the primary button starts, by the tool in hand. */
  begin(): 'select' | 'drag' | 'place';
  pickTile(x: number, y: number): number | null;
  pan(dx: number, dy: number): void;
  /** Two fingers: how much closer they came (above 1, zoom out), and how far they moved. */
  pinch(scale: number, dx: number, dy: number): void;
  wheel(deltaY: number): void;
  /** The pointer is over tile `i` (or off the map), not panning. */
  over(i: number | null): void;
  /** The pointer left the map with nothing in progress. */
  leave(): void;
  /** A right-click without moving. */
  secondary(): void;
  /** A click with the select tool, at x, y over tile `i`. */
  select(x: number, y: number, i: number | null): void;
  /** A click or a drag with a tool in hand, let go over `i`, having begun on `start` (null for a click). */
  apply(i: number | null, start: number | null): void;
  /** Let go over `i`: the preview for what comes next. */
  settle(i: number | null): void;
  /** Everything let go, or a second finger down: nothing is built. */
  cancelled(): void;
}

/** Tools that drag out a rectangle rather than a line (storage tools do too). */
const AREA_TOOLS: ReadonlySet<string> = new Set(['parking', 'unmark', 'bulldoze', 'portRoad']);

/** Tools that drag out a line or an area, rather than placing one thing with a click. */
export function dragsOut(t: Tool): boolean {
  return (
    t === 'bulldoze' ||
    t === 'unmark' ||
    t === 'forkliftOnly' ||
    t === 'oneWay' ||
    isStoreTool(t) ||
    t === 'dredge' ||
    t === 'reclaim' ||
    (t in BUILDABLES && BUILDABLES[t as BuildKind].drag)
  );
}

/**
 * Tiles covered by a drag of tool `t` from `start` to `end`: an L-shaped
 * line, or a rectangle for storage areas, parking, port roads, bulldozing
 * and unmarking. With no drag, just `end`.
 */
export function dragTiles(map: GameMap, t: Tool, start: number | null, end: number): number[] {
  if (start === null) return [end];
  const sx = map.xOf(start);
  const sy = map.yOf(start);
  const ex = map.xOf(end);
  const ey = map.yOf(end);
  const out: number[] = [];
  if (AREA_TOOLS.has(t) || isStoreTool(t)) {
    for (let y = Math.min(sy, ey); y <= Math.max(sy, ey); y++) {
      for (let x = Math.min(sx, ex); x <= Math.max(sx, ex); x++) out.push(map.idx(x, y));
    }
    return out;
  }
  const stepX = Math.sign(ex - sx) || 1;
  for (let x = sx; ; x += stepX) {
    out.push(map.idx(x, sy));
    if (x === ex) break;
  }
  const stepY = Math.sign(ey - sy);
  if (stepY !== 0) {
    for (let y = sy + stepY; ; y += stepY) {
      out.push(map.idx(ex, y));
      if (y === ey) break;
    }
  }
  return out;
}

/** Pointer events on the map canvas, sorted into gestures. */
export class Pointer {
  mode: Mode = 'none';
  /** Where a drag began, while one is on. */
  dragStart: number | null = null;
  /** Fingers or the mouse on the map, where each is now. */
  private touches = new Map<number, { x: number; y: number }>();
  /** Two fingers on the map: how far apart and where between them, last time. */
  private pinch: { dist: number; x: number; y: number } | null = null;
  private button = 0;
  private downX = 0;
  private downY = 0;
  private lastX = 0;
  private lastY = 0;
  private moved = false;

  constructor(
    private el: HTMLElement,
    private h: PointerHandlers,
  ) {
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.cancel(e));
    el.addEventListener('pointerleave', () => {
      if (this.mode === 'none') h.leave();
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        h.wheel(e.deltaY);
      },
      { passive: false },
    );
  }

  private down(e: PointerEvent): void {
    this.el.setPointerCapture(e.pointerId);
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A second finger: pinch to zoom and drag to pan, whatever the tool,
    // and whatever the first finger had begun is let go.
    if (this.touches.size >= 2 || this.mode === 'pinch') {
      this.mode = 'pinch';
      this.dragStart = null;
      this.pinch = this.pinchNow();
      this.h.cancelled();
      return;
    }
    this.button = e.button;
    this.downX = this.lastX = e.clientX;
    this.downY = this.lastY = e.clientY;
    this.moved = false;
    if (e.button !== 0) {
      this.mode = 'pan';
      return;
    }
    this.mode = this.h.begin();
    if (this.mode === 'drag') this.dragStart = this.h.pickTile(e.clientX, e.clientY);
  }

  private move(e: PointerEvent): void {
    if (this.touches.has(e.pointerId))
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.mode === 'pinch') {
      const now = this.pinchNow();
      if (now && this.pinch) {
        this.h.pinch(
          this.pinch.dist / Math.max(1, now.dist),
          now.x - this.pinch.x,
          now.y - this.pinch.y,
        );
      }
      this.pinch = now;
      return;
    }
    if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > 4) this.moved = true;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    if (this.mode === 'pan' || (this.mode === 'select' && this.moved)) {
      this.h.pan(dx, dy);
      return;
    }
    this.h.over(this.h.pickTile(e.clientX, e.clientY));
  }

  /** How far apart the first two fingers are, and the point between them. */
  private pinchNow(): { dist: number; x: number; y: number } | null {
    const [a, b] = [...this.touches.values()];
    if (!a || !b) return null;
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  /** A finger taken away by the browser (a system gesture, say): nothing is built. */
  private cancel(e: PointerEvent): void {
    this.touches.delete(e.pointerId);
    if (this.touches.size > 0) return;
    this.mode = 'none';
    this.pinch = null;
    this.dragStart = null;
    this.h.cancelled();
  }

  private up(e: PointerEvent): void {
    this.touches.delete(e.pointerId);
    // Out of a pinch, nothing happens until every finger is off the map.
    if (this.mode === 'pinch') {
      this.pinch = this.pinchNow();
      if (this.touches.size === 0) this.mode = 'none';
      return;
    }
    const mode = this.mode;
    this.mode = 'none';
    const i = this.h.pickTile(e.clientX, e.clientY);

    if (mode === 'pan' && !this.moved && this.button === 2) {
      this.h.secondary();
      return;
    }
    if (mode === 'select' && !this.moved) this.h.select(e.clientX, e.clientY, i);
    if (mode === 'drag' || mode === 'place') this.h.apply(i, this.dragStart);
    this.dragStart = null;
    this.h.settle(i);
  }
}
