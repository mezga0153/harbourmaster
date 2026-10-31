-- The play log: how players get on, for tuning the game and finding what goes
-- wrong. Nothing about who: random ids kept in the browser, no IP, no cookie.
-- server/ takes them in; stats.sh and the stats page (stats/) read them.

-- One row per page load of the game, sent by src/log/visit.ts to /api/visits:
-- where the visitor came from, where they are, on what, and how far they got.
-- The first beacon makes the row; later ones (the game known, the page put
-- away) bring the columns from game on up to date.
CREATE TABLE visits (
  id         INTEGER PRIMARY KEY,
  visit      TEXT    NOT NULL UNIQUE,   -- random, per page load
  version    TEXT,                      -- the game's version: its commit's time and hash, e.g. '2026-10-31 00:51 3b839e2'
  page       TEXT    NOT NULL,          -- the address it landed on: path and query (click ids taken out), no #view
  referrer   TEXT,                      -- the page it came from: host and path, and any utm_ tags; null if none
  ref_host   TEXT,                      -- the referrer's host alone, for counting
  lang       TEXT,                      -- the browser's language, e.g. 'sl-SI'
  screen_w   INTEGER,                   -- the screen, in CSS pixels
  screen_h   INTEGER,
  dpr        REAL,                      -- device pixels to a CSS pixel
  touch      INTEGER,                   -- 1 when the main pointer is a finger (a phone or tablet)
  graphics   TEXT,                      -- the graphics settings as it opened: water/shadows/resolution
  gpu        TEXT,                      -- the graphics card, as WebGL names it
  device     TEXT,                      -- a short name from the user agent (server/where.js)
  ua         TEXT,                      -- the user agent (trimmed)
  country    TEXT,                      -- from Cloudflare: two letters
  region     TEXT,
  city       TEXT,
  game       TEXT,                      -- the game played (days.game), once it has started
  seed       INTEGER,                   -- its map's seed
  day0       INTEGER,                   -- the game's day when the page opened it (1: a new game)
  day        INTEGER,                   -- the day it had got to, at the last beacon
  actions    INTEGER NOT NULL DEFAULT 0,  -- things the player did: built, hired, signed, ... (see days.actions)
  new_games  INTEGER NOT NULL DEFAULT 0,  -- games started afresh on this page (New game, or a save loaded)
  seconds    REAL    NOT NULL DEFAULT 0,  -- how long the page was looked at (while in view), to the last beacon
  created_at INTEGER NOT NULL,          -- ms since epoch
  updated_at INTEGER NOT NULL
);
CREATE INDEX visits_created ON visits (created_at);
CREATE INDEX visits_game ON visits (game);
CREATE INDEX visits_version ON visits (version);

-- One row per day of a game, sent by src/log/days.ts to /api/days when the day
-- ends (done = 1), and while it is under way when the page is put away
-- (done = 0, replaced by the finished day later). A game is a random id kept
-- in the browser beside the autosave. The port as the day ended: money,
-- progress, the town, what the player did that day and what went wrong.
CREATE TABLE days (
  id         INTEGER PRIMARY KEY,
  game       TEXT    NOT NULL,          -- random, per game
  visit      TEXT,                      -- the page load that sent it (visits.visit)
  version    TEXT,                      -- the game's version the day was played on (a game can go over to the next)
  seed       INTEGER NOT NULL,
  day        INTEGER NOT NULL,          -- 1 is the first day
  done       INTEGER NOT NULL,          -- 1: the day ended; 0: under way when the page was put away
  tier       INTEGER NOT NULL,          -- the port's tier (0, the fishing harbour, up)
  cash       INTEGER NOT NULL,
  loan       INTEGER NOT NULL,
  income     INTEGER NOT NULL,          -- money in that day
  spend      INTEGER NOT NULL,          -- money out that day (a positive number)
  ledger     TEXT,                      -- JSON: the day's money by category
  in_red     INTEGER NOT NULL,          -- days in a row ended in the red
  bankrupt   INTEGER NOT NULL,
  earned     INTEGER NOT NULL,          -- the game so far: money earned
  crates     INTEGER NOT NULL,          --   crates handled
  containers INTEGER NOT NULL,          --   containers handled
  boats      INTEGER NOT NULL,          --   boats served
  trucks     INTEGER NOT NULL,          --   trucks served
  exported   INTEGER NOT NULL,          --   crates and containers shipped out
  penalties  INTEGER NOT NULL,          --   demurrage, breaches and buyouts paid
  staff      INTEGER NOT NULL,          -- dockhands employed
  machines   TEXT,                      -- JSON: machines by kind
  contracts  INTEGER NOT NULL,          -- contracts signed and running
  can_up     INTEGER NOT NULL,          -- 1 when the next tier could be bought (the town big enough), and has not been
  town_pop   INTEGER,                   -- people in the town
  town_stage INTEGER,                   -- index into TOWN_STAGES
  town       TEXT,                      -- JSON: its homes, the people it would grow to (target), jobs, goods a day sent out
                                        --   and supplied to it, businesses
  size       INTEGER NOT NULL,          -- tiles the player has built on, all told (src/log/port.ts)
  port       TEXT,                      -- JSON: what is built, {road: tiles, quay: tiles, truckBay: 2, jibCrane: 1, oneWay: 4, ...}
  capacity   TEXT,                      -- JSON: crates a day wanted, unloaded, trucked; containers; congestion
  problems   TEXT,                      -- JSON: red marks on the map as the day ended, {what: how many}
  bad        TEXT,                      -- JSON: the day's bad news and refusals, {what: how many} (names and numbers taken out)
  actions    TEXT,                      -- JSON: what the player did that day, {build:road: 12, hire: 1, open:finance: 2, ...}
  tips       TEXT,                      -- JSON: the advisor's tips that came up that day
  seconds    REAL    NOT NULL,          -- real seconds the day took, with the page in view
  paused     REAL    NOT NULL,          -- of them, paused
  fast       REAL    NOT NULL,          -- of them, sped up (2× and more)
  fps        REAL,                      -- frames drawn a second, on average, while in view
  created_at INTEGER NOT NULL,          -- ms since epoch
  UNIQUE (game, day)
);
CREATE INDEX days_created ON days (created_at);
CREATE INDEX days_version ON days (version);

-- What went wrong in players' browsers, sent by src/log/errors.ts to
-- /api/errors: an error nothing caught, a promise nobody waited on, the
-- simulation throwing (the game pauses), saves failing, the 3D view lost.
CREATE TABLE errors (
  id         INTEGER PRIMARY KEY,
  visit      TEXT,
  game       TEXT,
  day        INTEGER,
  version    TEXT,
  kind       TEXT    NOT NULL,          -- error | rejection | worker | sim | save | autosave | webgl
  message    TEXT    NOT NULL,
  stack      TEXT,                      -- where, as the browser gave it (trimmed)
  page       TEXT,
  device     TEXT,                      -- JSON: window, pixel ratio, memory, cores, GPU
  country    TEXT,
  region     TEXT,
  city       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX errors_created ON errors (created_at);
