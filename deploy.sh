#!/bin/sh
# Publish the game to harbourmaster.tinetov.net (a Worker serving the built
# game, with the play log's addresses beside it, see wrangler.jsonc). Builds
# what is committed, in a copy of HEAD, so work in progress in the working
# tree never goes out, and brings the play log's database up to date first.
set -e
cd "$(dirname "$0")"
# the personal account tinetov.net lives in; pinned so a work login fails
# loudly instead of publishing there
export CLOUDFLARE_ACCOUNT_ID=5b599c00c72a707712ba9f65977a2acd
here=$(pwd)
# which version this is, for the play log (see scripts/version.mjs)
HM_VERSION=$(git log -1 --format='%cd %h' --date=format:'%Y-%m-%d %H:%M')
export HM_VERSION
build=$(mktemp -d)
trap 'rm -rf "${build:?}"' EXIT
git archive HEAD | tar -x -C "$build"
ln -s "$here/node_modules" "$build/node_modules"
(cd "$build" && npm run build)
rm -rf "$here/dist"
cp -R "$build/dist" "$here/dist"
wrangler d1 migrations apply harbourmaster-log --remote # nothing to do when up to date
wrangler deploy
