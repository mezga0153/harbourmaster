import type { Command } from './protocol';
import type { Renderer } from './render/renderer';
import type { GameMap } from './sim/map';
import {
  anchorOf,
  bestFacing,
  BUILDABLES,
  bulldozeError,
  bulldozeTiles,
  bulldozeValue,
  footprint,
  forkliftOnly,
  forkliftOnlyError,
  terraformCost,
  terraformError,
  machinePlacementError,
  placementCost,
  placementError,
  ROTATABLE,
} from './sim/rules';
import * as B from './sim/balance';
import { isMachineKind, MACHINES } from './sim/machines';
import type { BuildKind } from './sim/types';
import {
  hover,
  openCategory,
  panel,
  preview,
  rotation,
  selection,
  snapshot,
  togglePanel,
  tool,
} from './ui/store';
import { categoryOf, TOOL_KEYS } from './ui/tools';

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
  private hovered: number | null = null;
  /** Facing the preview last showed, which a build click sends. */
  private facing = 0;

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
    tool.subscribe(() => {
      rotation.value = null;
      this.refreshPreview(null);
    });
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
    else if (
      t === 'bulldoze' ||
      t === 'forkliftOnly' ||
      t === 'dredge' ||
      t === 'reclaim' ||
      (t in BUILDABLES && BUILDABLES[t as BuildKind].drag)
    ) {
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
      // Right-click turns a building being placed, Theme Hospital style.
      if (ROTATABLE.has(tool.value as BuildKind)) this.rotate();
      else tool.value = 'select';
      return;
    }
    if (mode === 'select' && !this.moved) this.selectAt(e.clientX, e.clientY, i);
    if (mode === 'drag' || mode === 'place') {
      const tiles = this.tilesFor(i);
      const t = tool.value;
      if (tiles.length > 0) {
        if (isMachineKind(t)) this.send({ type: 'buyMachine', kind: t, tile: tiles[0] });
        else if (t === 'bulldoze') this.send({ type: 'bulldoze', tiles });
        else if (t === 'dredge' || t === 'reclaim') {
          this.send({ type: 'terraform', tiles, raise: t === 'reclaim' });
        } else if (t === 'forkliftOnly') {
          this.send({ type: 'forkliftOnly', tiles, on: this.marking(tiles[0]) });
        } else if (ROTATABLE.has(t as BuildKind)) {
          const kind = t as BuildKind;
          this.send({ type: 'build', kind, tiles: [tiles[0]], facing: this.facing });
        } else if (t !== 'select') this.send({ type: 'build', kind: t as BuildKind, tiles });
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
      openCategory.value = null;
    } else if (k === 'delete' || k === 'backspace') tool.value = 'bulldoze';
    else if (k === 'h') togglePanel('staff');
    else if (k === 'c') togglePanel('contracts');
    else if (k === 'm' && e.shiftKey && import.meta.env.DEV) {
      // Dev server only: a million for testing.
      this.send({ type: 'debug', cash: 1_000_000 });
    } else if (k === 'm') togglePanel('finance');
    else if (k === 'p') togglePanel('port');
    else if (k in TOOL_KEYS) {
      const next = tool.value === TOOL_KEYS[k] ? 'select' : TOOL_KEYS[k];
      tool.value = next;
      // Show the category the shortcut belongs to, as if it had been clicked.
      const cat = categoryOf(next);
      if (cat) openCategory.value = cat.id;
    } else if (k === '+' || k === '=') this.renderer.cam.zoom(1 / 1.2);
    else if (k === '-') this.renderer.cam.zoom(1.2);
  }

  rotate(): void {
    rotation.value = (this.facing + 1) % 4;
    this.refreshPreview(this.hovered);
  }

  private selectAt(cx: number, cy: number, at: number | null): void {
    const map = this.getMap();
    const i = at !== null && map ? anchorOf(map, at) : at;
    const ent = this.renderer.pickEntity(cx, cy);
    if (ent) selection.value = { type: 'entity', id: ent.id };
    else if (i !== null && snapshot.value?.bays.some((b) => b.idx === i)) {
      selection.value = { type: 'bay', idx: i };
    } else if (i !== null && snapshot.value?.depots.some((d) => d.idx === i)) {
      selection.value = { type: 'depot', idx: i };
    } else if (i !== null && snapshot.value?.yards.some((y) => y.idx === i)) {
      selection.value = { type: 'yard', idx: i };
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
      this.renderer.overlay.setArrow(map, null, 0);
      preview.value = null;
      return;
    }
    if (ROTATABLE.has(t as BuildKind)) return this.previewBuilding(map, t as BuildKind, i);
    if (t === 'forkliftOnly') return this.previewMarking(map, this.tilesFor(i));
    if (t === 'dredge' || t === 'reclaim') {
      return this.previewTerraform(map, this.tilesFor(i), t === 'reclaim');
    }
    // Bulldozing any tile of a building clears all of it, once.
    const tiles =
      t === 'bulldoze'
        ? [...new Set(this.tilesFor(i).flatMap((k) => bulldozeTiles(map, anchorOf(map, k))))]
        : this.tilesFor(i);
    const ok: boolean[] = [];
    const pending = new Set<number>();
    let value = 0;
    let error: string | null = null;
    // Same rounds as the sim: a dock dragged from the sea inwards still fits.
    tiles.forEach(() => ok.push(false));
    for (let progress = true; progress;) {
      progress = false;
      error = null;
      tiles.forEach((tile, k) => {
        if (ok[k]) return;
        const err =
          t === 'bulldoze'
            ? bulldozeError(map, tile)
            : isMachineKind(t)
              ? machinePlacementError(map, tile)
              : placementError(map, t as BuildKind, tile, pending);
        if (err) {
          error ??= err;
          return;
        }
        ok[k] = progress = true;
        pending.add(tile);
        value +=
          t === 'bulldoze'
            ? anchorOf(map, tile) === tile
              ? bulldozeValue(map, tile)
              : 0
            : isMachineKind(t)
              ? -MACHINES[t].price
              : -placementCost(map, t as BuildKind, tile);
      });
    }
    this.renderer.overlay.setGhosts(map, tiles, ok);
    this.renderer.overlay.setArrow(map, null, 0);
    preview.value = {
      count: pending.size,
      rotatable: false,
      value,
      error: pending.size === 0 ? error : null,
    };
  }

  /**
   * A drag that starts on an unmarked tile marks forklift-only; one that
   * starts on a marked tile clears the mark.
   */
  private marking(first: number): boolean {
    const map = this.getMap();
    return !map || !forkliftOnly(map, this.dragStart ?? first);
  }

  private previewMarking(map: GameMap, tiles: number[]): void {
    const on = this.marking(tiles[0]);
    const ok = tiles.map((t) => !forkliftOnlyError(map, t));
    const changed = tiles.filter((t, k) => ok[k] && forkliftOnly(map, t) !== on).length;
    this.renderer.overlay.setGhosts(map, tiles, ok);
    this.renderer.overlay.setArrow(map, null, 0);
    preview.value = {
      count: changed,
      rotatable: false,
      value: -changed * B.FORKLIFT_ONLY_COST,
      error: ok.some(Boolean) ? null : forkliftOnlyError(map, tiles[0]),
    };
  }

  /** Same rounds as the sim, so a channel dug inland from the shore fits. */
  private previewTerraform(map: GameMap, tiles: number[], raise: boolean): void {
    const ok = tiles.map(() => false);
    const done = new Set<number>();
    let value = 0;
    let error: string | null = null;
    for (let progress = true; progress;) {
      progress = false;
      error = null;
      tiles.forEach((tile, k) => {
        if (ok[k]) return;
        const err = terraformError(map, tile, raise, done);
        if (err) {
          error ??= err;
          return;
        }
        ok[k] = progress = true;
        done.add(tile);
        value -= terraformCost(map, tile, raise);
      });
    }
    this.renderer.overlay.setGhosts(map, tiles, ok);
    this.renderer.overlay.setArrow(map, null, 0);
    preview.value = {
      count: done.size,
      rotatable: false,
      value,
      error: done.size === 0 ? error : null,
    };
  }

  /** One building on the hovered tile, facing the chosen (or a fitting) way. */
  private previewBuilding(map: GameMap, kind: BuildKind, i: number): void {
    const f = rotation.value ?? bestFacing(map, kind, i);
    this.facing = f;
    const tiles = footprint(map, kind, i, f).filter((t) => t >= 0);
    const error = placementError(map, kind, i, undefined, f);
    this.renderer.overlay.setGhosts(
      map,
      tiles,
      tiles.map(() => !error),
    );
    this.renderer.overlay.setArrow(map, i, f);
    preview.value = {
      count: error ? 0 : 1,
      rotatable: true,
      value: -placementCost(map, kind, i),
      error,
    };
  }

  private setHover(i: number | null): void {
    this.hovered = i;
    const map = this.getMap();
    if (!map) return;
    this.renderer.overlay.setHover(map, i);
    hover.value =
      i === null
        ? null
        : { x: map.xOf(i), y: map.yOf(i), terrain: map.terrain[i], depth: map.depth[i] };
  }
}
