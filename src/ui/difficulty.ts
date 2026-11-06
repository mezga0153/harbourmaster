import { DIFFICULTIES } from '../sim/balance';
import { snapshot } from './store';

// The numbers the panels show, at the game's difficulty: what cargo pays and
// penalties cost go up or down from the contracts' rates (see payout and fine
// in the sim's economy).

function rates() {
  return DIFFICULTIES[snapshot.value?.difficulty ?? 'hard'];
}

/** What cargo worth `n` at the contract's rates pays in this game. */
export function paid(n: number): number {
  return Math.round(n * rates().pay);
}

/** What a penalty of `n` at the usual rates costs in this game. */
export function fined(n: number): number {
  return Math.round(n * rates().penalties);
}

/** How much a penalty is of the usual, as a factor: 1 on Force Nine. */
export function fineRate(): number {
  return rates().penalties;
}
