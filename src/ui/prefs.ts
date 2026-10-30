import { signal } from '@preact/signals';
import { readGraphics, type Graphics } from '../render/graphics';

const KEY = 'harbourmaster.graphics';

function load(): Graphics {
  try {
    const raw = localStorage.getItem(KEY);
    return readGraphics(raw ? JSON.parse(raw) : null);
  } catch {
    return readGraphics(null);
  }
}

/** How the game is drawn, as the player set it; kept in this browser. */
export const graphics = signal<Graphics>(load());
graphics.subscribe((g) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(g));
  } catch {
    // Kept for this visit only.
  }
});
