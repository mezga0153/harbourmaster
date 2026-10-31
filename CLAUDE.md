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

## Players' games: the play log

The published game (only the built one, never `npm run dev`, an automated
browser or `?nolog`) tells how players get on, with nothing about who they
are (random ids, no IP): `src/log/` sends each page load (`visit.ts`), each
day of each game as it ends (`days.ts`: money, tier, the town, how much of
the port is built and which features are in use (`port.ts`), the plots of land
it owns, what the player did, the red marks on the map, the messages in red,
the advisor's tips, real
time paused or sped up, frames a second) and what goes wrong (`errors.ts`:
uncaught errors, the sim throwing, saves failing, an autosave set aside, the
3D view lost), each stamped with the game's version (its commit's time and
hash, `scripts/version.mjs`). `server/` (the Worker beside the game's files, see
`wrangler.jsonc`) keeps them in D1 (`harbourmaster-log`, tables in
`migrations/`; `deploy.sh` applies new ones).

- `./stats.sh` prints it all as tables, `./stats.sh problems bad` some
  sections, `./stats.sh visits` the visitors, `./stats.sh sql "SELECT ..."`
  your own; the questions are in `stats/queries.mjs`
- `./stats.sh gui` is the stats page (http://127.0.0.1:8798): games by day,
  how far they get, tiers, money, what holds ports back, problems, errors,
  devices, and any game day by day; versions side by side, and a picker to
  narrow it all to one version (`--version '...'` in the terminal)
- `--local` reads the copy `wrangler dev` keeps instead: `npm run build`,
  then `wrangler dev` serves the built game with the log at
  http://localhost:8787
- Players can tell us about a bug or an idea from Settings ("Tell us",
  `src/ui/Feedback.tsx`), with their game and a picture of the view if they
  let it: `./stats.sh feedback` lists them, `./stats.sh feedback-game 12`
  writes report 12's game to `.debug/` to load into the open dev game (as
  above), `./stats.sh feedback-mark 12 done "a note"` marks it; the stats
  page's Feedback tab does all three and shows the picture
- `tests/play-log.test.ts` checks the game sends what the server takes; a
  new column goes in a new migration, `server/api/`, `src/log/` and there

## Running simulations

Run the game's simulation in a Node process (vitest, as above, or a script
that loads a save into `World`), never by starting Chrome or another browser.
Only drive a browser when asked to fix animations or what the game looks
like, where screenshots of the drawn game are needed.

## Progression

How the town and the port grow, step by step (landmarks the town opens as
the port supplies it, each lifting the town's size cap and unlocking
contracts, cargo or buildings), is in `progression.md`. Keep it up to date
when changing tiers, town growth, contracts or what unlocks what.

## How the code is laid out

- `src/sim/world.ts` is the `World`: its state (typed in `state.ts`), making
  and saving, `step()`, `command()`, and a page of one-line queries the
  systems answer through it so a test can stand in for one. The rules that
  move it are functions over it in `src/sim/systems/`, one file a subject
  (`boats/`, `cranes`, `roads/`, `workforce/`, `cargo/`, `economy`,
  `building`, `townBusiness`, `tugs`, `output`, `snapshot`), each taking the
  world as its first argument. Nothing is private: the systems reach what
  they need.
- The rules of the map (what may be built where, how it stands, how trucks
  find their way) are pure functions in `src/sim/rules/`, exported from
  `rules.ts`; tuning numbers are in `balance.ts`; the bits of a tile's
  `orient` in `orient.ts`.
- `src/protocol.ts` exports the messages between the threads
  (`protocol/messages.ts`) and what the view sees (`protocol/views.ts`).
- The renderer: `src/render/structures/` (tiles, cranes, stock, furniture),
  `entities/` and `motion.ts` for moving things, `util/` for shared maths,
  `keyed.ts` for keeping keyed objects (and disposing what they own).
- The UI: one file a panel in `src/ui/`, styles by area in `src/ui/styles/`,
  input in `src/input/`, build previews as pure functions in `src/preview/`,
  `main.ts` wiring only.
