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

The page opens on the title screen (`src/ui/loading.ts`): the worker reads
the autosave and waits for Carry on, New port or a save file while the
models load. `?continue` skips it and carries on (a new port if none is
saved), for a driver or a tab you reload a lot; `/__debug/load` starts the
game from the title screen too.

Automated and headless browsers don't mirror (so tests can't overwrite the
player's files) unless the URL has `?bridge`; `?nodebug` turns it off in any tab.

## Debug overlays

On the dev server only (never built), Settings > Debug overlays, the `
key or the Debug button in the bottom bar opens a menu (`src/debug/`) that draws over the
map: the selected worker's, machine's or truck's planned path and its job
field by field, the view's own plan for a forklift or dockhand working a
load, every agent's path and state, tile passability for dockhands,
machines, forklifts or trucks (green ok, amber costly, red blocked), a finer
grid the view works out round the middle of the view (`fine.ts`, where a
finer path-finding grid plugs in), the trucks' road graph as arrows, crate
slots used and kept in bays and storage with bays cut off, crane reach, land
plots and the tile under the pointer. It also picks the ship pathing
(`src/sim/systems/boats/pilots.ts`: Navigator by default, or the older
classic, drift, patient and lookout pilots for comparison), for the game and the
dev lab alike; kept in the browser and sent to the sim, never saved. The sim side is `collect.ts`, run in
the worker on a `debugView` command (or on the page in the dev lab);
`window.__debug` sets it from a driver.

## Players' games: the play log

The published game (only the built one, never `npm run dev`, an automated
browser or `?nolog`) tells how players get on, with nothing about who they
are (random ids, no IP): `src/log/` sends each page load (`visit.ts`), each
day of each game as it ends (`days.ts`: money, tier, the difficulty, the town, how much of
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

## The dev lab

`dev.html` on the dev server (http://localhost:5199/dev.html, never built)
shows the game's parts on their own, `src/dev/`:

- Models: everything drawn, each built from its seed, on a turntable
  (`models.ts`, `stage.ts`): boats and ships with their load, trucks, people,
  machines, every tool on its patch of shore as its build menu card pictures
  it (`render/thumbs.ts` `stage()`), the town's buildings, the train's cars,
  the Kenney scenery and the cargo. `#models/<group>/<name>` opens one.
- Animations: what moves in place, run by the game's own code with its
  inputs on sliders (`animations.ts`): a dockhand's pose, fidgets and seat, a
  forklift's forks, a reach stacker's boom, a trailer's fold, a boat under
  way, cranes slewing, the gate, the lights, a buoy, a train going by.
- Scenes: the whole game with the sim run on the page (`scenes.ts`), started
  from a preset (`situations.ts`: a new port, a busy harbour, a port the
  playthrough bot built; `#scenes/busy` starts one), the dev game's
  `.debug/save.json` or a save file; paused, sped up or stepped a tick at a
  time, with fishing, lobster, coaster and feeder boats, a tug and the train
  sent in on a button, every boat's course drawn and a table of what each is
  doing and held up by. The build bar and panels are the game's own.
- Mini scenarios, on the Scenes tab (`scenario.ts`, `scenarioPanel.ts`): a
  new game's bit of shore cleared of boats and hands, built on from the
  build bar or the lab's tools (crates set down in a bay or storage, a
  dockhand put down, a boat with crates sent in, to a berth of its own or
  one given, or put down lying alongside, trucks called), each step
  recorded at its tick; saved as JSON and replayed the same. Presets: the
  bare patch, two dockhands with a boat and a truck bay, one forklift with
  a storage tile and a truck, a jib crane at a quay, two coasters off a
  pier's end that wait on each other for good (a knot from a player's port,
  to try ways of pathing on); `tests/scenario.test.ts` checks they do what
  they say, retaining the classic pilot's knot as an expected failure.
  `window.__scenario` drives them.
- Sounds: the sound lab (`src/audio/lab.ts`, also `sounds.html`).

`window.__lab` (the gallery's stage and item) and `window.__scene` (the
runner: `world`, `renderer`, `step(ticks)`, `send(cmd)`) are there for the
console or a driver; `__lab.stage.png()` and `__scene.renderer.picture()`
give pictures, which headless Chrome's `--screenshot` does not of a canvas.

## Running simulations

Run the game's simulation in a Node process (vitest, as above, or a script
that loads a save into `World`), never by starting Chrome or another browser.
Only drive a browser when asked to fix animations or what the game looks
like, where screenshots of the drawn game are needed.

Ship navigation uses the existing water-grid routes, predictive traffic rules
and hull-aware steering. Pier corners have wider cost bands for longer hulls;
occupied berths and ships handling nearby add a tapered passing-room cost.
Large ships follow their curved approach route to the alignment point instead
of aiming straight at it. The lead can replan when another hull occupies its
route, while keeping the final alignment along the dock. These cases are in
`tests/boat-clearance.test.ts`, including the approach to (37,92) past (52,89).
Navigator adds sampled whole-hull departure planning
(`src/sim/systems/boats/navigation.ts`): it checks both directions and passing
lanes up to three tiles off the berth, follows the sideways and along-dock legs
in order, and replans from the ship's current position when held up. Recovery
keeps collision checks; old saves with intersecting hulls are separated by
reducing total penetration without making new contacts. Pilot selection is a
debug override, not saved; new and restored games default to Navigator.

`tests/boat-navigation.test.ts` covers exits, replanning, sternway, collision
checks, old-save recovery and the pier-end scenario with several blocker
timings, including saved-game departures creeping at negligible speeds while
holding the next ship's fairway. Compare pilots against the same mirrored save and RNG seeds with
`HM_PROBE=1 HM_PILOTS=classic,lookout,navigator HM_DAYS=2 HM_RUNS=2 npx vitest run tests/boat-probe.test.ts --silent=false`.
The probe reports departures, held-up time, near misses and contacts, including
which contacts were already present in the save. It is opt-in because the save
is local and long runs are expensive.
It also tracks unfinished departures and run-outs that were present at the
start, so new boats getting through cannot hide an existing deadlock.

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
- Every crate and container is one record (`Crate` in `state.ts`) in the
  cells of what holds it, a cell for each place as the view draws it:
  storage, truck bays and quay heaps (`cargo/places.ts`), yards and crane
  stacks (`cargo/stores.ts`, `cranes.ts`), truck beds (`cargo/beds.ts`), a
  ship's deck; workers carry theirs as a list. Move records whole with the
  holder's put/take functions (see `cargo/hold.ts`), never fees alone, and
  the view gets cells too (`CellsView`). Dockhands and forklifts go cell by
  cell (`workforce/forkCells.ts`) to a free place beside the crate, facing
  it (`workforce/stands.ts`), and work it from there, one at a time at
  each stack (a jib crane swinging onto one holds it too: `locks`); the
  view draws them just where the game has them, bending or putting the
  forks in.
- `src/protocol.ts` exports the messages between the threads
  (`protocol/messages.ts`) and what the view sees (`protocol/views.ts`).
- The renderer: `src/render/structures/` (tiles, cranes, stock, furniture),
  `entities/` and `motion.ts` for moving things, `util/` for shared maths,
  `keyed.ts` for keeping keyed objects (and disposing what they own).
- The guides (`src/ui/Guide.tsx`, steps in `src/ui/guides.ts`): a few
  steps over the game, each with a picture the game's own renderer draws
  of a bit of port built up a beat at a time (`src/render/guides.ts`,
  on `thumbs.ts`'s patches), played as a flip book with a hand showing
  where to click and drag. The Coastal Wharf's opens on the upgrade; a
  crane's when its red mark is clicked, on the step for its `fix`.
  `__hm.openGuide('wharf', 2)` opens one on the dev server.
- The UI: one file a panel in `src/ui/`, styles by area in `src/ui/styles/`,
  input in `src/input/`, build previews as pure functions in `src/preview/`,
  `main.ts` wiring only.
