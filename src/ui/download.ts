import type { SaveData } from '../sim/world';
import { TICKS_PER_DAY } from '../sim/types';
import { pushMessage, seed, snapshot } from './store';

/** Hand the player the game as a file to keep, named for the port and the day. */
export function downloadSave(save: SaveData): void {
  const s = snapshot.peek();
  const day = s ? Math.floor(s.tick / TICKS_PER_DAY) + 1 : 1;
  const port = (s?.town?.name ?? `port ${seed.peek()}`).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const url = URL.createObjectURL(new Blob([JSON.stringify(save)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `harbourmaster-${port}-day-${day}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  pushMessage(`Saved to ${a.download}.`, 'good');
}
