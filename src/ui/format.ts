import { START_YEAR } from '../sim/balance';
import { TICKS_PER_DAY } from '../sim/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function formatDate(tick: number): string {
  const day = Math.floor(tick / TICKS_PER_DAY);
  const year = START_YEAR + Math.floor(day / 365);
  let d = day % 365;
  let m = 0;
  while (d >= MONTH_DAYS[m]) d -= MONTH_DAYS[m++];
  return `${d + 1} ${MONTHS[m]} ${year}`;
}

/** Fraction of the current day elapsed, 0..1. */
export function dayProgress(tick: number): number {
  return (tick % TICKS_PER_DAY) / TICKS_PER_DAY;
}

export function money(n: number): string {
  const sign = n < 0 ? '−' : '';
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
}
