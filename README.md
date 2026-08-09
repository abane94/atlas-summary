# dnd-transcribe-summary

Puppeteer scripts that use your **existing Chrome install and profile** — no bundled browser, no fighting NixOS, and your existing logins work.

Uses `puppeteer-core` (no Chromium download).

## Setup

```bash
nix develop   # or: direnv allow
npm install
```

Copy `.env.example` to `.env` and adjust paths if needed.

## Usage

### Recommended: connect to your running Chrome

This keeps your normal Chrome session (cookies, logins, extensions).

1. Start Chrome with remote debugging (uses your real profile):

   ```bash
   npm run chrome:debug
   ```

   Or manually:

   ```bash
   google-chrome-stable \
     --remote-debugging-port=9222 \
     --user-data-dir="$HOME/.config/google-chrome"
   ```

2. Run a script:

   ```bash
   npm start https://some-site-youre-logged-into.com
   ```

   Default mode is `connect` — Puppeteer attaches to that Chrome instance.

### Alternative: launch mode

Spawns Chrome with your profile. **Close all Chrome windows first** (profile lock).

```bash
PUPPETEER_MODE=launch npm start https://example.com
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PUPPETEER_MODE` | `connect` | `connect` or `launch` |
| `CHROME_PATH` | `/etc/profiles/per-user/aris/bin/google-chrome-stable` | Chrome binary |
| `CHROME_USER_DATA_DIR` | `$HOME/.config/google-chrome` | Profile directory |
| `CHROME_DEBUG_URL` | `http://127.0.0.1:9222` | Remote debugging URL |
| `HEADLESS` | `false` | Only for launch mode |

## Writing scripts

```js
import { getBrowser } from "../lib/browser.js";

const browser = await getBrowser();
const page = (await browser.pages())[0] ?? await browser.newPage();
await page.goto("https://...");
// ...
browser.disconnect(); // connect mode — don't close the user's Chrome
```
