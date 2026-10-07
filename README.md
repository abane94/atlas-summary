# dnd-transcribe-summary

Turns D&D session transcripts into campaign notes. An AI client (Cursor by default, or ChatGPT via local Chrome) does the summarization; GitHub Actions builds the Quartz site from the resulting vault data.

## Setup

```bash
nix develop   # or: direnv allow
npm install
```

Copy `.env.example` to `.env` and adjust paths if needed.

## AI provider

The active provider is the instance exported from [`lib/ai.js`](lib/ai.js) (hardcoded to Cursor for this phase). You can also set `AI_PROVIDER=chatgpt` to use ChatGPT instead.

- **Cursor (default):** runs `cursor-agent`. No Chrome debug browser required.
- **ChatGPT:** drives ChatGPT in Chrome via Puppeteer. Requires `npm run chrome:debug` (or launch mode).

## Session workflow

1. Add the new files:

   ```
   transcripts/YYYY-MM-DD/recap.md
   transcripts/YYYY-MM-DD/transcript.md
   ```

2. If using ChatGPT (`AI_PROVIDER=chatgpt`), start Chrome with remote debugging (keeps your ChatGPT login):

   ```bash
   npm run chrome:debug
   ```

   Skip this step when using the default Cursor provider.

3. Run the local pipeline. Completed steps are skipped automatically:

   ```bash
   npm start -- 2026-08-17
   ```

   That runs **chunks → merge**. Vault is skipped by default (it uses a lot of AI calls). When you are ready:

   ```bash
   npm start -- vault 2026-08-17
   # or include it in the same run:
   npm start -- 2026-08-17 --with-vault
   ```

4. After vault data exists, optionally look for duplicate entities (same person/place under different names). This is **not** part of process/vault:

   ```bash
   npm start -- dedup
   npm start -- dedup --interactive
   ```

   `--dry-run` alone prints the entity table that would be sent to the AI. With `--interactive`, the scan and review still run, but merges are only printed (no AI merge / file writes).

5. Assign tags from the closed catalog to existing vault entities (also not part of process/vault):

   ```bash
   npm start -- tags
   npm start -- tags --dry-run
   ```

   Suggestions for new catalog tags are appended to `vault-data/tag-suggestions.json` for human review.

6. Commit `summaries/` and `vault-data/`. CI runs `lib/generate-markdown.ts` and publishes the site.

See current progress without calling the AI:

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
| Chunks + merge + vault | `npm start -- 2026-08-17 --with-vault` |
| Redo vault for a date | `npm start -- vault 2026-08-17 --force` |
| Process every session still missing vault data | `npm start -- vault` |
| List likely duplicate vault entities | `npm start -- dedup` |
| Preview the entity table without AI | `npm start -- dedup --dry-run` |
| Interactively confirm and merge duplicates | `npm start -- dedup --interactive` |
| Assign closed-catalog tags to vault entities | `npm start -- tags` |
| Preview the tags table without AI | `npm start -- tags --dry-run` |

`--force` overwrites that step’s output. For **vault**, it re-reads `merged.json`, re-runs the AI prompts, **replaces** that date’s entry on each entity log (does not append a second entry), and **deletes** entity files whose log only contained that date. Vault `--force` requires a session date (`vault 2026-08-17 --force`); it will not redo every session at once. Without `--force`, existing `summary-N.json`, `merged.json`, and finished vault entity/session logs are left alone.

`npm start -- 2026-08-17 --dry-run` prints the steps that would run without calling the AI. With vault `--force --dry-run`, the preview shows how many entity logs would be replaced and how many entity files would be deleted.

Website markdown (`vault/**/*.md`) is **not** part of the local pipeline. Preview it with `npm run markdown` if you want; CI still generates it on push to `main`.

## Chrome modes (ChatGPT provider only)

These apply when `lib/ai.js` exports the ChatGPT client (`AI_PROVIDER=chatgpt`).

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
   AI_PROVIDER=chatgpt npm start -- 2026-08-17
   ```

   Default Puppeteer mode is `connect` — it attaches to that Chrome instance.

### Alternative: launch mode

Spawns Chrome with your profile. **Close all Chrome windows first** (profile lock).

```bash
AI_PROVIDER=chatgpt PUPPETEER_MODE=launch npm start -- 2026-08-17
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_PROVIDER` | `cursor` | `cursor` or `chatgpt` (chosen in `lib/ai.js`) |
| `PUPPETEER_MODE` | `connect` | ChatGPT only: `connect` or `launch` |
| `CHROME_PATH` | `/etc/profiles/per-user/aris/bin/google-chrome-stable` | ChatGPT only: Chrome binary |
| `CHROME_USER_DATA_DIR` | `$HOME/.config/google-chrome` | ChatGPT only: profile directory |
| `CHROME_DEBUG_URL` | `http://127.0.0.1:9222` | ChatGPT only: remote debugging URL |
| `HEADLESS` | `false` | ChatGPT only: launch mode |
