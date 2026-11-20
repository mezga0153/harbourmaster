import { TICKS_PER_DAY } from '../sim/types';

/** The game's day, counted from the first: 1, 2, 3 … */
export function dayNumber(tick: number): number {
  return Math.floor(tick / TICKS_PER_DAY) + 1;
}

/** The date as the game counts it: "Day 12". */
export function formatDate(tick: number): string {
  return `Day ${dayNumber(tick)}`;
}

/** Fraction of the current day elapsed, 0..1. */
export function dayProgress(tick: number): number {
  return (tick % TICKS_PER_DAY) / TICKS_PER_DAY;
}

/** A stretch of game time, roughly: "about 40 min", "about 3 h". */
export function duration(ticks: number): string {
  const minutes = (ticks * 24 * 60) / TICKS_PER_DAY;
  if (minutes < 90) return `about ${Math.max(10, Math.round(minutes / 10) * 10)} min`;
  return `about ${Math.round(minutes / 60)} h`;
}

export function money(n: number): string {
  const sign = n < 0 ? '−' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
}
