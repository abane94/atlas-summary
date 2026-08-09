import { cp, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  defaultProfileDir,
  isDefaultProfileDir,
  profileName,
  userDataDir,
} from "../lib/chrome-config.js";

const TOP_LEVEL_ITEMS = ["Local State"];

const PROFILE_ITEMS = [
  "Cookies",
  "Cookies-journal",
  "Login Data",
  "Login Data For Account",
  "Preferences",
  "Secure Preferences",
  "Web Data",
  "Local Storage",
  "Session Storage",
  "IndexedDB",
];

if (isDefaultProfileDir(userDataDir)) {
  console.error(
    `Source and destination are the same directory (${userDataDir}) — nothing to do.`,
  );
  process.exit(1);
}

if (await isInUse(userDataDir)) {
  console.error(`Chrome is running on ${userDataDir}.`);
  console.error("Quit it first, otherwise it will overwrite what we copy.");
  process.exit(1);
}

if (await isInUse(defaultProfileDir)) {
  console.warn(
    `Warning: your everyday Chrome is running, so very recent logins may not be ` +
      `flushed to disk yet. Quit it and re-run if something is missing.\n`,
  );
}

console.log(`Copying login state`);
console.log(`  from ${join(defaultProfileDir, profileName)}`);
console.log(`  to   ${join(userDataDir, profileName)}\n`);

await mkdir(join(userDataDir, profileName), { recursive: true });

const copied = [];
const skipped = [];

for (const item of TOP_LEVEL_ITEMS) {
  await copyItem(join(defaultProfileDir, item), join(userDataDir, item), item);
}

for (const item of PROFILE_ITEMS) {
  await copyItem(
    join(defaultProfileDir, profileName, item),
    join(userDataDir, profileName, item),
    item,
  );
}

console.log(`Copied: ${copied.join(", ")}`);
if (skipped.length > 0) console.log(`Not present in source: ${skipped.join(", ")}`);
console.log("\nStart Chrome with: npm run chrome:debug");

async function copyItem(from, to, label) {
  try {
    await cp(from, to, { recursive: true, force: true });
    copied.push(label);
  } catch (error) {
    if (error.code === "ENOENT") {
      skipped.push(label);
      return;
    }
    throw error;
  }
}

/** Chrome keeps a SingletonLock symlink in the profile while it is running. */
async function isInUse(dir) {
  try {
    await lstat(join(dir, "SingletonLock"));
    return true;
  } catch {
    return false;
  }
}
