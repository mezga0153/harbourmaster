// Messages between the main thread and the sim worker, and what the view
// sees of the game: see protocol/messages.ts and protocol/views.ts. The
// ledger, statistics and cargo counts are the sim's own (sim/state.ts).

export type * from './protocol/messages';
export type * from './protocol/views';
export type {
  CargoIn,
  CargoOut,
  CargoSample,
  CargoStats,
  FinanceDay,
  Ledger,
  LedgerCategory,
  Stats,
} from './sim/state';
