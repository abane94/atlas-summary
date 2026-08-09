import { spawn } from "node:child_process";
import {
  automationProfileDir,
  chromePath,
  debugPort,
  debugURL,
  isDefaultProfileDir,
  userDataDir,
} from "../lib/chrome-config.js";

if (isDefaultProfileDir(userDataDir)) {
  console.error(`Chrome's default profile directory can't be used: ${userDataDir}`);
  console.error(
    "Chrome 136+ ignores --remote-debugging-port there, so the port never opens.",
  );
  console.error(
    `Unset CHROME_USER_DATA_DIR to use ${automationProfileDir}, then run: npm run chrome:seed`,
  );
  process.exit(1);
}

const args = [
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${userDataDir}`,
  "--no-first-run",
  "--no-default-browser-check",
];

console.log(`Starting Chrome with remote debugging on port ${debugPort}`);
console.log(`Profile: ${userDataDir}`);

const child = spawn(chromePath, args, {
  detached: true,
  stdio: "ignore",
});

child.on("error", (error) => {
  console.error(`Could not run ${chromePath}: ${error.message}`);
  process.exit(1);
});

child.unref();

const version = await waitForDevTools(debugURL, 30_000);

if (!version) {
  console.error(`\nChrome never opened ${debugURL}.`);
  console.error(
    "If a Chrome instance was already using this profile, it took over the launch " +
      "and kept its own (non-debug) settings — quit it and try again.",
  );
  process.exit(1);
}

console.log(`\n${version.Browser} ready at ${debugURL}`);
console.log("Run a script with: npm start <url>");

async function waitForDevTools(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return await response.json();
    } catch {
      // Chrome is still starting up.
    }
    await new Promise((done) => setTimeout(done, 250));
  }

  return null;
}
