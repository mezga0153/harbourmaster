import { keyAction } from './input/keys';
import { dragsOut, dragTiles, Pointer } from './input/pointer';
import { selectionAt } from './input/select';
import { previewFor } from './preview';
import { landView } from './preview/land';
import { markingOn, storingOn } from './preview/marks';
import { nextGateWay } from './preview/roads';
import type { Command } from './protocol';
import type { Renderer } from './render/renderer';
import * as B from './sim/balance';
import { plotError, plotPrice, seaPlot } from './sim/land';
import { isMachineKind } from './sim/machines';
import type { GameMap } from './sim/map';
import { ROTATABLE } from './sim/rules';
import type { BuildKind } from './sim/types';
import { gameplay } from './ui/prefs';
import {
  hover,
  guide,
  isRoadTool,
  isStoreTool,
  landOffer,
  openCategory,
  panel,
  preview,
  type RoadTool,
  rotation,
  selection,
  snapshot,
  STORE_TOOLS,
  togglePanel,
  tool,
} from './ui/store';
import { categoryOf } from './ui/tools';

/**
 * Mouse, touch and keyboard → camera moves, previews and sim commands. The
 * gestures themselves are sorted out in input/pointer.ts, the keys in
 * input/keys.ts, what a click picks in input/select.ts and what a tool
 * would do in preview/; this joins them to the renderer, the UI's state
 * and the sim.
 */
export class Input {
  private pointer: Pointer;
  private lastSpeed = 1;
  private hovered: number | null = null;
  /** Facing the preview last showed, which a build click sends. */
  private facing = 0;

  constructor(
    private renderer: Renderer,
    private getMap: () => GameMap | null,
    private send: (cmd: Command) => void,
  ) {
    const cam = renderer.cam;
    const height = () => renderer.canvas.clientHeight;
    this.pointer = new Pointer(renderer.canvas, {
      begin: () => {
        const t = tool.value;
        return t === 'select' ? 'select' : dragsOut(t) ? 'drag' : 'place';
      },
      pickTile: (x, y) => renderer.pickTile(x, y),
      pan: (dx, dy) => cam.panPixels(dx, dy, height()),
      pinch: (scale, dx, dy) => {
        cam.zoom(scale);
        cam.panPixels(dx, dy, height());
      },
      wheel: (dy) => cam.zoom(dy > 0 !== gameplay.peek().invertZoom ? 1.12 : 1 / 1.12),
      over: (i) => {
        this.setHover(i);
        this.refreshPreview(i);
      },
      leave: () => this.setHover(null),
      secondary: () => this.secondary(),
      select: (x, y, i) => this.selectAt(x, y, i),
      apply: (i, start) => this.apply(i, start),
      settle: (i) => this.refreshPreview(i),
      cancelled: () => this.refreshPreview(null),
    });
    window.addEventListener('keydown', (e) => this.key(e));
    tool.subscribe(() => {
      rotation.value = null;
      this.refreshPreview(null);
      this.refreshLand();
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

  /**
   * Right-click turns a building being placed, Theme Hospital style;
   * otherwise it puts the tool down and closes the build menu.
   */
  private secondary(): void {
    if (ROTATABLE.has(tool.value as BuildKind)) this.rotate();
    else {
      tool.value = 'select';
      openCategory.value = null;
    }
  }

  /** A click or a drag with a tool in hand, let go over `i`: the command it means. */
  private apply(i: number | null, start: number | null): void {
    const map = this.getMap();
    if (!map || i === null) return;
    const t = tool.value;
    const tiles = dragTiles(map, t, start, i);
    const first = start ?? tiles[0];
    if (t === 'land') this.offerLand(map, tiles[0]);
    else if (t === 'tug') this.send({ type: 'buyTug', tile: tiles[0] });
    else if (isMachineKind(t)) this.send({ type: 'buyMachine', kind: t, tile: tiles[0] });
    else if (t === 'bulldoze') this.send({ type: 'bulldoze', tiles });
    else if (t === 'unmark') this.send({ type: 'unmark', tiles });
    else if (isRoadTool(t)) this.sendRoad(map, t, tiles);
    else if (t === 'dredge' || t === 'reclaim') {
      this.send({ type: 'terraform', tiles, raise: t === 'reclaim' });
    } else if (t === 'forkliftOnly') {
      this.send({ type: 'forkliftOnly', tiles, on: markingOn(map, first) });
    } else if (isStoreTool(t)) {
      this.send({ type: 'store', tiles, kind: STORE_TOOLS[t], on: storingOn(map, t, first) });
    } else if (ROTATABLE.has(t as BuildKind)) {
      const kind = t as BuildKind;
      this.send({ type: 'build', kind, tiles: [tiles[0]], facing: this.facing });
    } else if (t !== 'select') this.send({ type: 'build', kind: t as BuildKind, tiles });
  }

  private key(e: KeyboardEvent): void {
    if (
      e.target instanceof HTMLElement &&
      (e.target.matches('input, textarea, select') || e.target.isContentEditable)
    )
      return;
    if (guide.value && !guide.value.practice) {
      if (e.key === 'Escape') guide.value = null;
      return;
    }
    const a = keyAction(e, snapshot.value?.progress.tier ?? 0, import.meta.env.DEV);
    if (!a) return;
    switch (a.type) {
      case 'rotateView':
        return this.renderer.cam.rotate(a.dir);
      case 'zoom':
        return this.renderer.cam.zoom(a.factor);
      case 'pause':
        e.preventDefault();
        return this.togglePause();
      case 'speed':
        return this.setSpeed(a.speed);
      case 'escape':
        tool.value = 'select';
        selection.value = null;
        panel.value = null;
        openCategory.value = null;
        return;
      case 'panel':
        return togglePanel(a.panel);
      case 'debugCash':
        return this.send({ type: 'debug', cash: 1_000_000 });
      case 'tool': {
        if (!a.toggle) {
          tool.value = a.tool;
          return;
        }
        const next = tool.value === a.tool ? 'select' : a.tool;
        tool.value = next;
        // Show the category the shortcut belongs to, as if it had been clicked.
        const cat = categoryOf(next);
        if (cat) openCategory.value = cat.id;
        return;
      }
    }
  }

  rotate(): void {
    rotation.value = (this.facing + 1) % 4;
    this.refreshPreview(this.hovered);
  }

  private selectAt(cx: number, cy: number, at: number | null): void {
    // A click on the map beside an open panel puts the panel away.
    if (panel.value) {
      panel.value = null;
      return;
    }
    selection.value = selectionAt(this.getMap(), snapshot.value, at, {
      problem: this.renderer.pickProblem(cx, cy),
      entity: this.renderer.pickEntity(cx, cy),
    });
  }

  /** Show what the tool in hand would do at `i`, over the map and in the tip. */
  private refreshPreview(i: number | null): void {
    const map = this.getMap();
    if (!map) return;
    const t = tool.value;
    if (t === 'land' && i !== null) this.refreshLand(i);
    const start = this.pointer.dragStart;
    const tiles = i === null ? [] : dragTiles(map, t, start, i);
    const r = previewFor(map, snapshot.value, t, i, tiles, start ?? tiles[0], rotation.value);
    if (r.facing !== undefined) this.facing = r.facing;
    const o = this.renderer.overlay;
    o.setHints(map, 'tool', r.hints);
    o.setGhosts(map, r.ghosts.tiles, r.ghosts.ok);
    o.setArrow(map, r.arrow?.at ?? null, r.arrow?.facing ?? 0, r.arrow?.tiles);
    preview.value = r.preview;
  }

  private sendRoad(map: GameMap, t: RoadTool, tiles: number[]): void {
    const i = tiles[tiles.length - 1];
    if (t === 'oneWay') this.send({ type: 'oneWay', tiles, on: true });
    else if (t === 'highwayExit') this.send({ type: 'exit', row: map.yOf(i) });
    else if (t === 'lights') this.send({ type: 'lights', tile: i });
    else if (t === 'roundabout') this.send({ type: 'roundabout', tile: i });
    else this.send({ type: 'gateWay', tile: i, way: nextGateWay(map, i) });
  }

  /**
   * Show the port's plots of land: with the Land tool, those for sale
   * outlined with their price and the rest dimmed, and with any other tool
   * in hand the land the port does not own faintly shaded.
   */
  refreshLand(hoverTile: number | null = null): void {
    const map = this.getMap();
    if (!map) return;
    const { view, labels } = landView(map, tool.value, hoverTile);
    this.renderer.overlay.setLand(map, view, B.PLOT_SIZE);
    this.renderer.setLabels(labels);
  }

  /** Ask before buying the plot clicked, if it can be bought. */
  private offerLand(map: GameMap, i: number): void {
    const p = map.plotOf(i);
    if (plotError(map, p)) return;
    landOffer.value = { plot: p, price: plotPrice(map, p), sea: seaPlot(map, p) };
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
