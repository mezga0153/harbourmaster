# Harbourmaster

## Seeing the player's game

While `npm run dev` is running and the game is open in a browser tab, the tab
mirrors itself into `.debug/` (gitignored, see `src/debug/bridge.ts` and
`scripts/debug-bridge.mjs`):

- `report.txt`: readable summary (cash, capacity, every boat, truck and worker
  with what it is doing, bays, yards, recent messages and errors, what the
  player has selected), every 5 s; `snapshot.json` is the raw snapshot
- `save.json`: the full game, every minute
- `log.txt`: game messages, console errors and warnings as they happen
- `curl 'localhost:5199/__debug/capture?what=state|save|screenshot'` asks the
  open tab for a fresh copy and prints the file path (`screenshot.png` is the
  3D view without the UI)
- `curl -X POST --data-binary @some-save.json localhost:5199/__debug/load`
  makes the open tab carry on from that save (as `save.json` is written);
  build one with `World.fromSave` … `toSave()` to change the player's game

`HM_SAVE=1 HM_DAYS=1 npx vitest run tests/debug-save.test.ts --silent=false`
loads `save.json` into the sim, runs it on and prints the report.

Automated browsers don't mirror (so tests can't overwrite the player's files)
unless the URL has `?bridge`; `?nodebug` turns it off in any tab.
