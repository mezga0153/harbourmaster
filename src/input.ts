import type { Command } from './protocol';
import type { Renderer } from './render/renderer';
import type { GameMap } from './sim/map';
import * as B from './sim/balance';
import {
  BUILDABLES,
  bulldozeError,
  bulldozeValue,
  machinePlacementError,
  placementCost,
  placementError,
} from './sim/rules';
import type { BuildKind } from './sim/types';
import { hover, panel, preview, selection, snapshot, togglePanel, tool } from './ui/store';
import { TOOL_KEYS } from './ui/tools';

type Mode = 'none' | 'select' | 'pan' | 'drag' | 'place';

const SPEED_KEYS: Record<string, number> = { '1': 1, '2': 2, '3': 4, '4': 8 };

/** Mouse and keyboard → camera moves, previews and sim commands. */
export class Input {
  private mode: Mode = 'none';
  private button = 0;
  private downX = 0;
  private downY = 0;
  private lastX = 0;
  private lastY = 0;
  private moved = false;
  private dragStart: number | null = null;
  private lastSpeed = 1;

  constructor(
    private renderer: Renderer,
    private getMap: () => GameMap | null,
    private send: (cmd: Command) => void,
  ) {
    const el = renderer.canvas;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointerleave', () => {
      if (this.mode === 'none') this.setHover(null);
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        renderer.cam.zoom(e.deltaY > 0 ? 1.12 : 1 / 1.12);
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => this.key(e));
    tool.subscribe(() => this.refreshPreview(null));
  }

  setSpeed(speed: number): void {
    if (speed > 0) this.lastSpeed = speed;
    this.send({ type: 'setSpeed', speed });
  }

  togglePause(): void {
    const s = snapshot.value?.speed ?? 1;
    this.setSpeed(s === 0 ? this.lastSpeed : 0);
  }

  private down(e: PointerEvent): void {
    this.renderer.canvas.setPointerCapture(e.pointerId);
    this.button = e.button;
    this.downX = this.lastX = e.clientX;
    this.downY = this.lastY = e.clientY;
    this.moved = false;
    if (e.button !== 0) {
      this.mode = 'pan';
      return;
    }
    const t = tool.value;
    if (t === 'select') this.mode = 'select';
    else if (t === 'bulldoze' || (t in BUILDABLES && BUILDABLES[t as BuildKind].drag)) {
      this.mode = 'drag';
      this.dragStart = this.renderer.pickTile(e.clientX, e.clientY);
    } else this.mode = 'place';
  }

  private move(e: PointerEvent): void {
    if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > 4) this.moved = true;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    if (this.mode === 'pan' || (this.mode === 'select' && this.moved)) {
      this.renderer.cam.panPixels(dx, dy, this.renderer.canvas.clientHeight);
      return;
    }
    const i = this.renderer.pickTile(e.clientX, e.clientY);
    this.setHover(i);
    this.refreshPreview(i);
  }

  private up(e: PointerEvent): void {
    const mode = this.mode;
    this.mode = 'none';
    const i = this.renderer.pickTile(e.clientX, e.clientY);

    if (mode === 'pan' && !this.moved && this.button === 2) {
      tool.value = 'select';
      return;
    }
    if (mode === 'select' && !this.moved) this.selectAt(e.clientX, e.clientY, i);
    if (mode === 'drag' || mode === 'place') {
      const tiles = this.tilesFor(i);
      const t = tool.value;
      if (tiles.length > 0) {
        if (t === 'forklift') this.send({ type: 'buyMachine', kind: t, tile: tiles[0] });
        else if (t === 'bulldoze') this.send({ type: 'bulldoze', tiles });
        else if (t !== 'select') this.send({ type: 'build', kind: t, tiles });
      }
    }
    this.dragStart = null;
    this.refreshPreview(i);
  }

  private key(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    if (k === 'q') this.renderer.cam.rotate(-1);
    else if (k === 'e') this.renderer.cam.rotate(1);
    else if (k === ' ') {
      e.preventDefault();
      this.togglePause();
    } else if (k in SPEED_KEYS) this.setSpeed(SPEED_KEYS[k]);
    else if (k === 'escape') {
      tool.value = 'select';
      selection.value = null;
      panel.value = null;
    } else if (k === 'delete' || k === 'backspace') tool.value = 'bulldoze';
    else if (k === 'h') togglePanel('staff');
    else if (k === 'c') togglePanel('contracts');
    else if (k === 'm') togglePanel('finance');
    else if (k === 'p') togglePanel('port');
    else if (k in TOOL_KEYS) tool.value = tool.value === TOOL_KEYS[k] ? 'select' : TOOL_KEYS[k];
    else if (k === '+' || k === '=') this.renderer.cam.zoom(1 / 1.2);
    else if (k === '-') this.renderer.cam.zoom(1.2);
  }

  private selectAt(cx: number, cy: number, i: number | null): void {
    const ent = this.renderer.pickEntity(cx, cy);
    if (ent) selection.value = { type: 'entity', id: ent.id };
    else if (i !== null && snapshot.value?.bays.some((b) => b.idx === i)) {
      selection.value = { type: 'bay', idx: i };
    } else selection.value = null;
  }

  /** Tiles covered by the current drag (an L-shaped line) or the hovered tile. */
  private tilesFor(end: number | null): number[] {
    const map = this.getMap();
    if (!map || end === null) return [];
    const start = this.dragStart;
    if (start === null) return [end];
    const sx = map.xOf(start);
    const sy = map.yOf(start);
    const ex = map.xOf(end);
    const ey = map.yOf(end);
    const out: number[] = [];
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

  private refreshPreview(i: number | null): void {
    const map = this.getMap();
    const t = tool.value;
    if (!map) return;
    if (t === 'select' || i === null) {
      this.renderer.overlay.setGhosts(map, [], []);
      preview.value = null;
      return;
    }
    const tiles = this.tilesFor(i);
    const ok: boolean[] = [];
    const pending = new Set<number>();
    let value = 0;
    let error: string | null = null;
    for (const tile of tiles) {
      const err =
        t === 'bulldoze'
          ? bulldozeError(map, tile)
          : t === 'forklift'
            ? machinePlacementError(map, tile)
            : placementError(map, t, tile, pending);
      ok.push(!err);
      if (err) {
        error ??= err;
        continue;
      }
      pending.add(tile);
      value +=
        t === 'bulldoze'
          ? bulldozeValue(map, tile)
          : t === 'forklift'
            ? -B.FORKLIFT_PRICE
            : -placementCost(map, t, tile);
    }
    this.renderer.overlay.setGhosts(map, tiles, ok);
    preview.value = { count: pending.size, value, error: pending.size === 0 ? error : null };
  }

  private setHover(i: number | null): void {
    const map = this.getMap();
    if (!map) return;
    this.renderer.overlay.setHover(map, i);
    hover.value =
      i === null
        ? null
        : { x: map.xOf(i), y: map.yOf(i), terrain: map.terrain[i], depth: map.depth[i] };
  }
}
