import puppeteer from "puppeteer-core";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CHROME =
  "/etc/profiles/per-user/aris/bin/google-chrome-stable";

/**
 * Connect to or launch Chrome using your existing install and profile.
 *
 * connect mode (default): attach to Chrome started with remote debugging.
 *   Your normal Chrome session stays open — cookies and logins are already there.
 *
 * launch mode: spawn Chrome with your profile directory.
 *   Close all Chrome windows first (profile lock).
 */
export async function getBrowser(options = {}) {
  const mode = process.env.PUPPETEER_MODE ?? "connect";

  if (mode === "connect") {
    const browserURL =
      process.env.CHROME_DEBUG_URL ?? "http://127.0.0.1:9222";
    return puppeteer.connect({
      browserURL,
      defaultViewport: null,
      ...options,
    });
  }

  if (mode !== "launch") {
    throw new Error(
      `Unknown PUPPETEER_MODE="${mode}". Use "connect" or "launch".`,
    );
  }

  const executablePath =
    process.env.CHROME_PATH ?? DEFAULT_CHROME;
  const userDataDir =
    process.env.CHROME_USER_DATA_DIR ??
    join(homedir(), ".config/google-chrome");
  const headless = process.env.HEADLESS === "true";

  return puppeteer.launch({
    executablePath,
    userDataDir,
    headless,
    defaultViewport: null,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    ...options,
  });
}
