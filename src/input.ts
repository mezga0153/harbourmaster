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
  tugPlacementError,
  placementCost,
  placementError,
  ROTATABLE,
  STORE_COST,
  storeError,
  craneGround,
  loadingSpots,
  truckReach,
  machinesOnly,
  unmarkable,
  unmarkRefund,
  gateWay,
  lightsError,
  oneWayError,
  ROUNDABOUT_RING,
  roundaboutCost,
  roundaboutError,
} from './sim/rules';
import { exitError, hasLights, HIGHWAY_COLUMNS, oneWay, stepFacing } from './sim/roads';
import { TIERS } from './sim/tiers';
import * as B from './sim/balance';
import { isMachineKind, MACHINES } from './sim/machines';
import { ownedByTown } from './sim/town';
import { Build, isTownBuilding, STORE_CODE, type BuildKind } from './sim/types';
import {
  hover,
  isRoadTool,
  isStoreTool,
  openCategory,
  type RoadTool,
  panel,
  preview,
  rotation,
  selection,
  snapshot,
  STORE_TOOLS,
  togglePanel,
  tool,
} from './ui/store';
import { categoryOf, TOOL_KEYS } from './ui/tools';

type Mode = 'none' | 'select' | 'pan' | 'drag' | 'place';

/** What the tints shown while placing these mean. */
const TOOL_NOTES: Partial<Record<string, string>> = {
  parking:
    'Marked out on a road, one or two tiles wide, with road left along both long sides: trucks drive in off one and out onto the other. Green works, red does not',
  jibCrane: 'Red: machines only. Blue: crate storage here is filled straight from the boats',
  harbourCrane: 'Red: machines only, no dockhands or hauliers’ trucks',
  gantryCrane: 'Red: machines only, no dockhands or hauliers’ trucks',
};

const SPEED_KEYS: Record<string, number> = { '1': 1, '2': 2, '3': 4, '4': 8 };

/** Tools that drag out a rectangle rather than a line (storage tools do too). */
const AREA_TOOLS: ReadonlySet<string> = new Set(['parking', 'unmark', 'bulldoze', 'portRoad']);

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
      t === 'unmark' ||
      t === 'forkliftOnly' ||
      t === 'oneWay' ||
      isStoreTool(t) ||
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
      // Right-click turns a building being placed, Theme Hospital style;
      // otherwise it puts the tool down and closes the build menu.
      if (ROTATABLE.has(tool.value as BuildKind)) this.rotate();
      else {
        tool.value = 'select';
        openCategory.value = null;
      }
      return;
    }
    if (mode === 'select' && !this.moved) this.selectAt(e.clientX, e.clientY, i);
    if (mode === 'drag' || mode === 'place') {
      const tiles = this.tilesFor(i);
      const t = tool.value;
      if (tiles.length > 0) {
        if (t === 'tug') this.send({ type: 'buyTug', tile: tiles[0] });
        else if (isMachineKind(t)) this.send({ type: 'buyMachine', kind: t, tile: tiles[0] });
        else if (t === 'bulldoze') this.send({ type: 'bulldoze', tiles });
        else if (t === 'unmark') this.send({ type: 'unmark', tiles });
        else if (isRoadTool(t)) this.sendRoad(t, tiles);
        else if (t === 'dredge' || t === 'reclaim') {
          this.send({ type: 'terraform', tiles, raise: t === 'reclaim' });
        } else if (t === 'forkliftOnly') {
          this.send({ type: 'forkliftOnly', tiles, on: this.marking(tiles[0]) });
        } else if (isStoreTool(t)) {
          this.send({ type: 'store', tiles, kind: STORE_TOOLS[t], on: this.storing(tiles[0]) });
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
    else if (k === '?') togglePanel('handbook');
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
    // A red mark over something wrong picks that, to say what is wrong.
    const problem = this.renderer.pickProblem(cx, cy);
    if (problem) {
      selection.value = { type: problem.type, idx: problem.idx };
      return;
    }
    const ent = this.renderer.pickEntity(cx, cy);
    const s = snapshot.value;
    // A storage area is picked from any of its tiles.
    const store =
      i === null
        ? undefined
        : (s?.bays.find((b) => b.tiles?.includes(i)) ?? s?.yards.find((y) => y.tiles.includes(i)));
    if (ent) selection.value = { type: 'entity', id: ent.id };
    else if (store) {
      selection.value = { type: 'warehouse' in store ? 'bay' : 'yard', idx: store.idx };
    } else if (i !== null && snapshot.value?.bays.some((b) => b.idx === i)) {
      selection.value = { type: 'bay', idx: i };
    } else if (i !== null && snapshot.value?.cranes.some((c) => c.idx === i)) {
      selection.value = { type: 'crane', idx: i };
    } else if (i !== null && snapshot.value?.depots.some((d) => d.idx === i)) {
      selection.value = { type: 'depot', idx: i };
    } else if (i !== null && map?.build[i] === Build.Office) {
      selection.value = { type: 'office', idx: i };
    } else if (i !== null && map?.build[i] === Build.Parking) {
      selection.value = { type: 'parking', idx: i };
    } else if (i !== null && snapshot.value?.yards.some((y) => y.idx === i)) {
      selection.value = { type: 'yard', idx: i };
    } else if (i !== null && map && (ownedByTown(map, i) || isTownBuilding(map.build[i]))) {
      selection.value = { type: 'town' };
    } else if (
      i !== null &&
      map &&
      (map.build[i] === Build.Rail || map.build[i] === Build.Crossing)
    ) {
      selection.value = { type: 'railway' };
    } else selection.value = null;
  }

  /**
   * Tiles covered by the current drag (an L-shaped line, or a rectangle for
   * storage areas, parking, port roads, bulldozing and unmarking) or the
   * hovered tile.
   */
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
    if (AREA_TOOLS.has(tool.value) || isStoreTool(tool.value)) {
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

  private refreshPreview(i: number | null): void {
    const map = this.getMap();
    const t = tool.value;
    if (!map) return;
    this.renderer.overlay.setHints(map, 'tool', []);
    if (t === 'select' || i === null) {
      this.renderer.overlay.setGhosts(map, [], []);
      this.renderer.overlay.setArrow(map, null, 0);
      preview.value = null;
      return;
    }
    if (ROTATABLE.has(t as BuildKind)) return this.previewBuilding(map, t as BuildKind, i);
    if (t === 'forkliftOnly') return this.previewMarking(map, this.tilesFor(i));
    if (isRoadTool(t)) return this.previewRoad(map, t, this.tilesFor(i));
    if (t === 'unmark') return this.previewUnmark(map, this.tilesFor(i));
    if (isStoreTool(t)) return this.previewStore(map, t, this.tilesFor(i));
    if (t === 'jibCrane' || t === 'harbourCrane') this.showCraneGround(map, t, i, 0);
    if (t === 'jetty' || t === 'quay') this.showDocks(map);
    if (t === 'parking') this.showParking(map);
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
            : t === 'tug'
              ? tugPlacementError(map, tile)
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
            : t === 'tug'
              ? -B.TUG_PRICE
              : isMachineKind(t)
                ? -MACHINES[t].price
                : -placementCost(map, t as BuildKind, tile);
      });
    }
    // A public road up to the highway, meeting it head on, opens an exit there.
    let note = TOOL_NOTES[t];
    if (t === 'road') {
      const meets = tiles.filter((k, n) => {
        if (!ok[n] || map.xOf(k) !== HIGHWAY_COLUMNS) return false;
        const y = map.yOf(k);
        return ![y - 1, y + 1].some(
          (r) =>
            tiles.includes(map.idx(HIGHWAY_COLUMNS, r)) ||
            (r >= 0 && r < map.h && map.build[map.idx(HIGHWAY_COLUMNS, r)] === Build.Road),
        );
      });
      for (const k of meets) {
        const tier = snapshot.value?.progress.tier ?? 0;
        const why =
          tier < B.EXIT_TIER
            ? `exits open from the ${TIERS[B.EXIT_TIER].name}`
            : exitError(map, map.yOf(k));
        if (why)
          note = `Meets the highway, but no exit opens: ${why[0].toLowerCase()}${why.slice(1)}`;
        else {
          note = `Meets the highway: an exit opens here, for $${B.EXIT_COST.toLocaleString('en-US')}`;
          value -= B.EXIT_COST;
        }
      }
    }
    this.renderer.overlay.setGhosts(map, tiles, ok);
    this.renderer.overlay.setArrow(map, null, 0);
    preview.value = {
      count: pending.size,
      rotatable: false,
      value,
      error: pending.size === 0 ? error : null,
      note,
    };
  }

  /** The gate's next way, clicking round: both ways, in only, out only. */
  private nextGateWay(map: GameMap, i: number): 'both' | 'in' | 'out' {
    const now = gateWay(map, anchorOf(map, i));
    return now === 'both' ? 'in' : now === 'in' ? 'out' : 'both';
  }

  private sendRoad(t: RoadTool, tiles: number[]): void {
    const map = this.getMap();
    if (!map) return;
    const i = tiles[tiles.length - 1];
    if (t === 'oneWay') this.send({ type: 'oneWay', tiles, on: true });
    else if (t === 'highwayExit') this.send({ type: 'exit', row: map.yOf(i) });
    else if (t === 'lights') this.send({ type: 'lights', tile: i });
    else if (t === 'roundabout') this.send({ type: 'roundabout', tile: i });
    else this.send({ type: 'gateWay', tile: i, way: this.nextGateWay(map, i) });
  }

  /** What a road tool would do here, what it costs, and why not if it cannot. */
  private previewRoad(map: GameMap, t: RoadTool, tiles: number[]): void {
    const tier = snapshot.value?.progress.tier ?? 0;
    const need =
      t === 'highwayExit'
        ? B.EXIT_TIER
        : t === 'lights' || t === 'roundabout'
          ? B.LIGHTS_TIER
          : B.ONE_WAY_TIER;
    const locked = tier < need ? `Unlocks at the ${TIERS[need].name}` : null;
    const i = tiles[tiles.length - 1];
    let shown = [i];
    let ok = [false];
    let value = 0;
    let error: string | null = null;
    let note: string | undefined;
    let arrow: { at: number; facing: number } | null = null;
    if (t === 'oneWay') {
      shown = tiles;
      ok = tiles.map((k) => !oneWayError(map, k));
      const count = ok.filter(Boolean).length;
      value = -count * B.ONE_WAY_COST;
      error = count > 0 ? null : oneWayError(map, tiles[0]);
      if (tiles.length > 1) {
        arrow = { at: i, facing: stepFacing(map, tiles[tiles.length - 2], i) };
        note = 'Traffic will go the way you drag';
      } else if (oneWay(map, i) >= 0) {
        arrow = { at: i, facing: oneWay(map, i) ^ 2 };
        note = 'Click to turn it round';
      } else note = 'Drag along the road the way the traffic should go';
    } else if (t === 'highwayExit') {
      const y = map.yOf(i);
      shown = Array.from({ length: HIGHWAY_COLUMNS + 1 }, (_, x) => map.idx(x, y));
      error =
        map.xOf(i) > HIGHWAY_COLUMNS ? 'Click the highway, down the west edge' : exitError(map, y);
      ok = shown.map(() => !error);
      value = -B.EXIT_COST;
    } else if (t === 'lights') {
      error = lightsError(map, i);
      ok = [!error];
      const on = hasLights(map, i);
      value = on ? 0 : -B.LIGHTS_COST;
      if (on && !error) note = 'Click to take them down';
    } else if (t === 'roundabout') {
      const inside =
        map.xOf(i) >= 1 && map.yOf(i) >= 1 && map.xOf(i) < map.w - 1 && map.yOf(i) < map.h - 1;
      shown = inside
        ? [i, ...ROUNDABOUT_RING.map(([dx, dy]) => map.idx(map.xOf(i) + dx, map.yOf(i) + dy))]
        : [i];
      error = inside ? roundaboutError(map, i) : 'Too near the edge of the map';
      ok = shown.map(() => !error);
      value = error ? 0 : -roundaboutCost(map, i);
      note = 'The island goes on the tile you click';
    } else {
      const gate = map.build[anchorOf(map, i)] === Build.Gate;
      error = gate ? null : 'Click a port gate';
      ok = [gate];
      if (gate) {
        const next = this.nextGateWay(map, i);
        note =
          next === 'both'
            ? 'Click to let trucks through both ways'
            : `Click to let trucks only ${next}`;
        value = -B.GATE_WAY_COST;
      }
    }
    if (locked) {
      error = locked;
      ok = ok.map(() => false);
    }
    this.renderer.overlay.setGhosts(map, shown, ok);
    this.renderer.overlay.setArrow(map, arrow?.at ?? null, arrow?.facing ?? 0);
    preview.value = {
      count: error ? 0 : ok.filter(Boolean).length,
      rotatable: false,
      value,
      error,
      note,
    };
  }

  /**
   * A drag that starts on an unmarked tile marks it machines only; one that
   * starts on a marked tile clears the mark.
   */
  private marking(first: number): boolean {
    const map = this.getMap();
    return !map || !forkliftOnly(map, this.dragStart ?? first);
  }

  /** What a drag of the Unmark tool would clear, and give back. */
  private previewUnmark(map: GameMap, tiles: number[]): void {
    const ok = tiles.map((t) => {
      const what = unmarkable(map, t);
      return what.store || what.machines || what.road || what.parking;
    });
    this.renderer.overlay.setGhosts(map, tiles, ok);
    this.renderer.overlay.setArrow(map, null, 0);
    const count = ok.filter(Boolean).length;
    const near = tiles.some((t) => machinesOnly(map, t) && !forkliftOnly(map, t));
    preview.value = {
      count,
      rotatable: false,
      value: tiles.reduce((n, t, k) => n + (ok[k] ? unmarkRefund(map, t) : 0), 0),
      error:
        count > 0
          ? null
          : near
            ? 'The ground round a crane is always kept for port machines'
            : 'Nothing marked out here',
    };
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

  /**
   * A drag that starts on a tile already marked out as this storage clears
   * it; any other marks it out.
   */
  private storing(first: number): boolean {
    const map = this.getMap();
    const t = tool.value;
    if (!map || !isStoreTool(t)) return true;
    return map.store[this.dragStart ?? first] !== STORE_CODE[STORE_TOOLS[t]];
  }

  private previewStore(map: GameMap, t: keyof typeof STORE_TOOLS, tiles: number[]): void {
    const kind = STORE_TOOLS[t];
    const on = this.storing(tiles[0]);
    const ok = tiles.map((i) => !storeError(map, i, kind, on));
    const count = ok.filter(Boolean).length;
    const each = on ? -STORE_COST[kind] : Math.floor(STORE_COST[kind] * B.BULLDOZE_REFUND);
    this.renderer.overlay.setGhosts(map, tiles, ok);
    this.renderer.overlay.setArrow(map, null, 0);
    // Where trucks would stand to load, beside what is being marked out.
    const marked = tiles.filter((_, k) => ok[k]);
    const spots = on && count > 0 ? loadingSpots(map, marked, truckReach(map)) : [];
    this.renderer.overlay.setHints(map, 'tool', [{ kind: 'spot', tiles: spots }]);
    const note =
      !on || count === 0
        ? undefined
        : spots.length > 0
          ? 'Trucks load from the yellow tiles beside it'
          : kind === 'crates'
            ? 'Trucks cannot get beside it: forklifts will take its crates on. Trucks load from a port road or quay beside it, through a port gate'
            : 'Trucks cannot get beside it: they load from a port road or quay beside it, through a port gate, off machines-only ground';
    preview.value = {
      count,
      rotatable: false,
      value: count * each,
      error: count > 0 ? null : storeError(map, tiles[0], kind, on),
      note,
    };
  }

  /** Parking that works in green, parking trucks cannot use in red. */
  private showParking(map: GameMap): void {
    const lots = snapshot.value?.parking ?? [];
    this.renderer.overlay.setHints(map, 'tool', [
      { kind: 'good', tiles: lots.filter((l) => !l.why).flatMap((l) => l.tiles) },
      { kind: 'zone', tiles: lots.filter((l) => l.why).flatMap((l) => l.tiles) },
    ]);
  }

  /** Docks the harbour office coordinates in green, those boats do not use in red. */
  private showDocks(map: GameMap): void {
    const d = snapshot.value?.docks;
    if (!d) return;
    this.renderer.overlay.setHints(map, 'tool', [
      { kind: 'good', tiles: d.inUse },
      { kind: 'zone', tiles: d.idle },
    ]);
  }

  /** A crane's machines-only ground in red, and how far a jib crane reaches storage in blue. */
  private showCraneGround(
    map: GameMap,
    kind: 'jibCrane' | 'harbourCrane' | 'gantryCrane',
    i: number,
    facing: number,
  ): void {
    const { zone, reach } = craneGround(map, kind, i, facing);
    this.renderer.overlay.setHints(map, 'tool', [
      { kind: 'reach', tiles: reach },
      { kind: 'zone', tiles: zone },
    ]);
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
    if (kind === 'gantryCrane') this.showCraneGround(map, kind, i, f);
    if (kind === 'office') this.showDocks(map);
    const tiles = footprint(map, kind, i, f).filter((t) => t >= 0);
    const error = placementError(map, kind, i, undefined, f);
    this.renderer.overlay.setGhosts(
      map,
      tiles,
      tiles.map(() => !error),
    );
    this.renderer.overlay.setArrow(map, i, f, tiles);
    preview.value = {
      count: error ? 0 : 1,
      rotatable: true,
      value: -placementCost(map, kind, i),
      error,
      note: TOOL_NOTES[kind],
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
