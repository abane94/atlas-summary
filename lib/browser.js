import puppeteer from "puppeteer-core";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CHROME =
  "/etc/profiles/per-user/aris/bin/google-chrome-stable";
const PROTOCOL_TIMEOUT_MS = 5 * 60 * 1000;

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
      protocolTimeout: PROTOCOL_TIMEOUT_MS,
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
    protocolTimeout: PROTOCOL_TIMEOUT_MS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    ...options,
  });
}

const CHATGPT_URL = "https://chatgpt.com";

/**
 * Open ChatGPT in the attached/launched Chrome, run `fn`, then disconnect
 * (connect mode) or close (launch mode).
 */
export async function withChatGptPage(fn) {
  const browser = await getBrowser();
  try {
    const pages = await browser.pages();
    const page = pages[0] ?? (await browser.newPage());
    await page.goto(CHATGPT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    return await fn(page);
  } finally {
    if (process.env.PUPPETEER_MODE === "connect") {
      browser.disconnect();
    } else {
      await browser.close();
    }
  }
}

export function chromeConnectHint() {
  return [
    "Could not connect to Chrome.",
    "Start it with remote debugging first:",
    "",
    "  npm run chrome:debug",
  ].join("\n");
}
