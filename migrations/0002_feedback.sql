-- What players tell us from the game (src/ui/Feedback.tsx, sent by
-- src/log/feedback.ts to /api/feedback): a bug, an idea or anything else, in
-- their words, with what the game was doing, and if they let it, their game
-- (to load and see the bug for ourselves) and a picture of the view.
-- ./stats.sh feedback lists them; the stats page's Feedback tab reads and
-- answers them.
CREATE TABLE feedback (
  id         INTEGER PRIMARY KEY,
  kind       TEXT    NOT NULL,          -- bug | idea | other
  text       TEXT    NOT NULL,          -- what they wrote
  contact    TEXT,                      -- an email or a name to answer, if they gave one
  visit      TEXT,                      -- the page load (visits.visit), game (days.game) and day it came from
  game       TEXT,
  day        INTEGER,
  version    TEXT,                      -- the game's version
  context    TEXT,                      -- JSON: the port as it was (seed, tier, cash), the window, the settings,
                                        --   the last messages and errors, what was selected
  save       TEXT,                      -- their game, gzipped JSON in base64, if they sent it
  save_bytes INTEGER,                   -- its size unzipped
  picture    TEXT,                      -- the view, as a JPEG data: URL, if they sent it
  device     TEXT,                      -- from the request (server/where.js), never the IP
  ua         TEXT,
  country    TEXT,
  city       TEXT,
  status     TEXT    NOT NULL DEFAULT 'new',   -- new | seen | done | wontfix, set from the stats page
  note       TEXT,                      -- ours, about it
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX feedback_created ON feedback (created_at);
