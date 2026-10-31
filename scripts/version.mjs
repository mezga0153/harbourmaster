// Which version of the game a build is, for the play log to tell versions
// apart (src/log/): the commit's time and hash, which sort in the order they
// were made, e.g. '2026-10-31 00:51 3b839e2'. deploy.sh builds a copy without
// git, so it works it out there and passes it as HM_VERSION.
import { execSync } from 'node:child_process';

export function version() {
  if (process.env.HM_VERSION) return process.env.HM_VERSION;
  try {
    return execSync("git log -1 --format='%cd %h' --date=format:'%Y-%m-%d %H:%M'", {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}
