import type { Hints } from '../render/overlay';
import type { Renderer } from '../render/renderer';
import * as B from '../sim/balance';
import { isMachineKind } from '../sim/machines';
import type { GameMap } from '../sim/map';
import { buoyGates, craneGround, driveNetwork, loadingSpots, truckReach } from '../sim/rules';
import { Build, isBay, isTownBuilding } from '../sim/types';
import { selection, snapshot, tool } from './store';

// What the UI's state has drawn over the map and done with the camera: the
// selection's ring and what explains it (where a machine can drive, a
// crane's ground, where trucks load, a boat's course), the buoys' channels
// with a buoy tool in hand, and the flight over to the town and back.

export interface MapOverlays {
  /** The map's tiles changed: what explains the selection and the channels may have too. */
  onTiles(): void;
  /** A new snapshot: the boats' courses. */
  onSnapshot(): void;
}

/** Follow the selection and the tool, drawing over the map as they change. */
export function wireOverlays(renderer: Renderer, getMap: () => GameMap | null): MapOverlays {
  /** Where the view was before it flew over to the town, to fly back to. */
  let beforeTown: { x: number; z: number; size: number } | null = null;

  /**
   * Opening the town flies the view over to it, the whole town in sight, and
   * closing it flies back to where it was, so the town is plainly up the
   * coast from the port on the same map.
   */
  function flyForTown(open: boolean): void {
    const cam = renderer.cam;
    if (!open) {
      if (beforeTown) cam.flyTo(beforeTown.x, beforeTown.z, beforeTown.size);
      beforeTown = null;
      return;
    }
    if (beforeTown || !getMap()) return;
    beforeTown = cam.view;
    // Once the panel is up, to see how much room it leaves.
    requestAnimationFrame(() => {
      if (beforeTown) flyOverTown();
    });
  }

  /** Fly the view over to the whole of the town, beside the town panel. */
  function flyOverTown(): void {
    const cam = renderer.cam;
    const m = getMap();
    if (!m) return;
    let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
    // Its homes, shops and works: its streets reach out to the highway.
    for (let i = 0; i < m.build.length; i++) {
      if (!isTownBuilding(m.build[i])) continue;
      const [x, z] = [m.xOf(i), m.yOf(i)];
      [x0, z0, x1, z1] = [
        Math.min(x0, x),
        Math.min(z0, z),
        Math.max(x1, x + 1),
        Math.max(z1, z + 1),
      ];
    }
    const t = snapshot.peek()?.town;
    if (!Number.isFinite(x0)) {
      if (t) cam.flyTo(t.x + 0.5, t.y + 0.5, 20);
      return;
    }
    // Seen from a corner, a square across S tiles spans S√2 across the screen
    // and about 0.82 S up it, in what the town panel down the side leaves.
    const span = Math.max(x1 - x0, z1 - z0) + 3;
    // On a phone the panel is a sheet across the whole width: the town goes above it.
    const panelWidth = document.querySelector('.side.panel')?.getBoundingClientRect().width ?? 0;
    const side = panelWidth < innerWidth * 0.6 ? panelWidth : 0;
    const wide = Math.max(1, innerWidth - side);
    const size = Math.max(span * 0.82, (span * Math.SQRT2 * innerHeight) / wide) * 1.1;
    // Moved over so it sits in the middle of what shows beside the panel.
    const shift = (side / 2) * (size / Math.max(1, innerHeight));
    const [rx, rz] = cam.right;
    cam.flyTo((x0 + x1) / 2 + rx * shift, (z0 + z1) / 2 + rz * shift, size);
  }

  /** With a buoy tool in hand, show the lines the pairs of buoys mark. */
  function showChannels(): void {
    const m = getMap();
    if (!m) return;
    const on = tool.peek() === 'buoyIn' || tool.peek() === 'buoyOut';
    const lines = (out: boolean): [number, number][] =>
      on ? buoyGates(m, out).flatMap((g) => (g.b < 0 ? [] : [[g.a, g.b] as [number, number]])) : [];
    renderer.overlay.setChannels(m, [lines(false), lines(true)]);
  }

  /** With a forklift, stacker or depot selected, show where it can drive. */
  function showReach(): void {
    const m = getMap();
    if (!m) return;
    const s = selection.peek();
    let start = -1;
    if (s?.type === 'depot') start = s.idx;
    if (s?.type === 'entity') {
      const e = snapshot.peek()?.entities.find((q) => q.id === s.id);
      if (e && isMachineKind(e.kind)) start = m.idx(Math.floor(e.x), Math.floor(e.y));
    }
    if (start < 0) return renderer.overlay.setReach(m, [], [], []);
    const net = driveNetwork(m, start);
    const route: number[] = [];
    const bays: number[] = [];
    const cutOff: number[] = [];
    for (let i = 0; i < m.build.length; i++) {
      if (isBay(m.build[i]) || m.store[i]) (net.has(i) ? bays : cutOff).push(i);
      else if (net.has(i)) route.push(i);
    }
    renderer.overlay.setReach(m, route, bays, cutOff);
  }

  /**
   * With a crane selected, its machines-only ground and a jib crane's reach;
   * with storage, where the trucks load beside it.
   */
  function showGround(): void {
    const m = getMap();
    if (!m) return;
    const s = selection.peek();
    const snap = snapshot.peek();
    let hints: Hints = [];
    if (s?.type === 'crane') {
      const b = m.build[s.idx];
      const kind =
        b === Build.JibCrane ? 'jibCrane' : b === Build.Gantry ? 'gantryCrane' : 'harbourCrane';
      const { zone, reach } = craneGround(m, kind, s.idx, m.orient[s.idx] & 3);
      hints = [
        { kind: 'reach', tiles: reach },
        { kind: 'zone', tiles: zone },
      ];
    } else if (s?.type === 'parking' && snap) {
      const lot = snap.parking.find((l) => l.tiles.includes(s.idx));
      if (lot) hints = [{ kind: lot.why ? 'zone' : 'good', tiles: lot.tiles }];
    } else if (s?.type === 'office' && snap) {
      hints = [
        { kind: 'good', tiles: snap.docks.inUse },
        { kind: 'zone', tiles: snap.docks.idle },
      ];
    } else if (s?.type === 'bay' || s?.type === 'yard') {
      const area =
        s.type === 'bay'
          ? snap?.bays.find((b) => b.idx === s.idx)?.tiles
          : snap?.yards.find((y) => y.idx === s.idx)?.tiles;
      if (area) {
        const most = Math.max(1, Math.floor(area.length / B.STORE_TILES_PER_TRUCK));
        hints = [{ kind: 'spot', tiles: loadingSpots(m, area, truckReach(m)).slice(0, most) }];
      }
    }
    renderer.overlay.setHints(m, 'selection', hints);
  }

  /** With a boat selected, show where it plots it will be, and the boat it gives way to. */
  function showPlots(): void {
    const s = selection.peek();
    const es = snapshot.peek()?.entities;
    const boat = s?.type === 'entity' ? es?.find((e) => e.id === s.id && e.kind === 'boat') : null;
    const other =
      boat?.givingWayTo !== undefined ? es?.find((e) => e.id === boat.givingWayTo) : null;
    renderer.overlay.setPlots([boat?.plot ?? null, other?.plot ?? null]);
  }

  selection.subscribe((s) => {
    renderer.select(s?.type === 'entity' ? s.id : null);
    showReach();
    showGround();
    flyForTown(s?.type === 'town');
  });
  tool.subscribe(() => showChannels());

  return {
    onTiles() {
      showReach();
      showGround();
      showChannels();
    },
    onSnapshot: showPlots,
  };
}
