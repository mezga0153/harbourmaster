import type { LandView } from '../render/overlay';
import * as B from '../sim/balance';
import { buyable, plotError, plotPrice, seaPlot } from '../sim/land';
import type { GameMap } from '../sim/map';
import type { Tool } from '../ui/tools';
import type { PreviewResult } from './types';

// Buying plots of land for the port.

/** A price pinned over a plot for sale. */
export interface PlotLabel {
  x: number;
  y: number;
  text: string;
  tone: string;
}

/** What buying the plot under the pointer would cost, and why not if it cannot be bought. */
export function previewLand(map: GameMap, cash: number, i: number): PreviewResult {
  const p = map.plotOf(i);
  const price = p >= 0 ? plotPrice(map, p) : 0;
  const error = plotError(map, p) ?? (price > cash ? 'Not enough money' : null);
  return {
    ghosts: { tiles: [], ok: [] },
    arrow: null,
    hints: [],
    preview: {
      count: error ? 0 : 1,
      rotatable: false,
      unit: 'plot',
      value: error && p >= 0 && map.plots[p] ? 0 : -price,
      error,
      note:
        p >= 0 && seaPlot(map, p)
          ? 'All sea: a seabed lease from the harbour authority'
          : undefined,
    },
  };
}

/**
 * How the port's plots of land are shown with tool `t` in hand: with the
 * Land tool, those for sale outlined with their price and the rest dimmed,
 * and with any other tool the land the port does not own faintly shaded.
 */
export function landView(
  map: GameMap,
  t: Tool,
  hoverTile: number | null,
): { view: LandView; labels: PlotLabel[] } {
  const unowned: number[] = [];
  for (let p = 0; p < map.plots.length; p++) if (!map.plots[p]) unowned.push(p);
  if (t === 'select' || unowned.length === 0) return { view: { mode: 'off' }, labels: [] };
  if (t !== 'land') return { view: { mode: 'edge', plots: unowned }, labels: [] };
  const forSale = unowned.filter((p) => buyable(map, p));
  const hover = hoverTile === null ? -1 : map.plotOf(hoverTile);
  return {
    view: {
      mode: 'tool',
      forSale,
      dim: unowned.filter((p) => !buyable(map, p)),
      hover: hover >= 0 && !map.plots[hover] ? hover : -1,
      hoverOk: buyable(map, hover),
    },
    labels: forSale.map((p) => {
      const x = (p % map.plotsWide) * B.PLOT_SIZE + B.PLOT_SIZE / 2;
      const y = Math.floor(p / map.plotsWide) * B.PLOT_SIZE + B.PLOT_SIZE / 2;
      const sea = seaPlot(map, p);
      return {
        x,
        y: Math.min(y, map.limit - 2),
        text: `$${plotPrice(map, p).toLocaleString('en-US')}${sea ? ' seabed' : ''}`,
        tone: p === hover ? 'hot' : '',
      };
    }),
  };
}
