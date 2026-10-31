import type { Command } from '../protocol';

/** What the UI can do to the game and the view; wired up in main.ts. */
export interface Actions {
  send(cmd: Command): void;
  setSpeed(speed: number): void;
  togglePause(): void;
  /** Point the camera at a tile. */
  focus(x: number, y: number): void;
  /** Turn the view a quarter round, as Q and E do. */
  rotateView(dir: 1 | -1): void;
  /** Zoom the view: below 1 in, above 1 out. */
  zoom(factor: number): void;
  /** Turn the building being placed, as a right-click does. */
  rotateBuilding(): void;
}
