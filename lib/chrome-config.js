import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_CHROME =
  "/etc/profiles/per-user/aris/bin/google-chrome-stable";

/** Where Chrome stores your everyday profile on Linux. */
export const defaultProfileDir = join(homedir(), ".config/google-chrome");

/**
 * Chrome 136+ ignores --remote-debugging-port (and --remote-debugging-pipe)
 * whenever it runs out of its default profile directory, so automation gets a
 * directory of its own. `npm run chrome:seed` copies logins into it.
 */
export const automationProfileDir = join(
  homedir(),
  ".config/google-chrome-automation",
);

export const chromePath = process.env.CHROME_PATH ?? DEFAULT_CHROME;

export const userDataDir =
  process.env.CHROME_USER_DATA_DIR ?? automationProfileDir;

export const debugPort = process.env.CHROME_DEBUG_PORT ?? "9222";

export const debugURL =
  process.env.CHROME_DEBUG_URL ?? `http://127.0.0.1:${debugPort}`;

export const profileName = process.env.CHROME_PROFILE ?? "Default";

export function isDefaultProfileDir(dir) {
  return resolve(dir) === resolve(defaultProfileDir);
}
