#!/bin/sh
# How players get on, from the play log (src/log/ sends it, server/ keeps it
# in D1): their games day by day, what they do and what goes wrong, and the
# visitors. The questions are in stats/queries.mjs; this reads the live
# database, --local the one wrangler dev keeps.
#   ./stats.sh              everything, as tables
#   ./stats.sh problems     some sections: overview reach tiers curve money limits
#                           problems bad actions firstday tips pace slow errors (and daily
#                           retention errorlog games gamewhere, which read best on the page)
#   ./stats.sh visits       the visitors: where they come from, where they are, on what,
#                           and whether they play
#   ./stats.sh sql "..."    a question of your own
#   ./stats.sh feedback     what players have told us from the game, the new first;
#                           feedback-game 12 writes report 12's game to .debug/ to load,
#                           feedback-mark 12 done "a note" marks it (new seen done wontfix)
#   ./stats.sh gui          the stats page, at http://127.0.0.1:8798
set -e
cd "$(dirname "$0")"
LOCAL=
if [ "$1" = "--local" ]; then LOCAL=--local; shift; fi
if [ "$1" = "gui" ]; then shift; exec node stats/server.mjs $LOCAL "$@"; fi
exec node stats/cli.mjs $LOCAL "$@"
