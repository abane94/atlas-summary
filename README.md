# dnd-transcribe-summary

Turns D&D session transcripts into campaign notes. ChatGPT (via your local Chrome) does the summarization; GitHub Actions builds the Quartz site from the resulting vault data.

## Setup

```bash
nix develop   # or: direnv allow
npm install
```

Copy `.env.example` to `.env` and adjust paths if needed.

## Session workflow

1. Add the new files:

   ```
   transcripts/YYYY-MM-DD/recap.md
   transcripts/YYYY-MM-DD/transcript.md
   ```

2. Start Chrome with remote debugging (keeps your ChatGPT login):

   ```bash
   npm run chrome:debug
   ```

3. Run the local pipeline. Completed steps are skipped automatically:

   ```bash
   npm start -- 2026-08-17
   ```

   That runs **recap → chunks → merge**. Vault is skipped by default (it uses a lot of ChatGPT calls). When you are ready:

   ```bash
   npm start -- vault 2026-08-17
   # or include it in the same run:
   npm start -- 2026-08-17 --with-vault
   ```

4. Commit `summaries/` and `vault-data/`. CI runs `lib/generate-markdown.ts` and publishes the site.

See current progress without calling ChatGPT:

```bash
npm start
# or
npm start -- status
```

### Re-running one stage

| Goal | Command |
| --- | --- |
| Only merge existing chunk JSON | `npm start -- 2026-08-17 --only merge` |
| Redo chunk summaries | `npm start -- 2026-08-17 --only chunks --force` |
| Start at vault for one date | `npm start -- vault 2026-08-17` |
| Recap + chunks + merge + vault | `npm start -- 2026-08-17 --with-vault` |
| Redo vault session log | `npm start -- vault 2026-08-17 --force` |
| Process every session still missing vault data | `npm start -- vault` |

`--force` overwrites that step’s output. Without it, existing `recap.json`, `summary-N.json`, `merged.json`, and finished vault entity/session logs are left alone.

`npm start -- 2026-08-17 --dry-run` prints the steps that would run without calling ChatGPT.

Website markdown (`vault/**/*.md`) is **not** part of the local pipeline. Preview it with `npm run markdown` if you want; CI still generates it on push to `main`.

## Chrome modes

### Recommended: connect to your running Chrome

This keeps your normal Chrome session (cookies, logins, extensions).

1. Start Chrome with remote debugging (uses your automation profile):

   ```bash
   npm run chrome:debug
   ```

   Or manually:

   ```bash
   google-chrome-stable \
     --remote-debugging-port=9222 \
     --user-data-dir="$HOME/.config/google-chrome-automation"
   ```

2. Run a script:

   ```bash
   npm start -- 2026-08-17
   ```

   Default mode is `connect` — Puppeteer attaches to that Chrome instance.

### Alternative: launch mode

Spawns Chrome with your profile. **Close all Chrome windows first** (profile lock).

```bash
PUPPETEER_MODE=launch npm start -- 2026-08-17
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
