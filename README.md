# dnd-transcribe-summary

Turns D&D session transcripts into campaign notes. Cursor agents do the summarization; GitHub Actions builds the Quartz site from the resulting vault data.

## Setup

```bash
nix develop   # or: direnv allow
npm install
```

Copy `.env.example` to `.env` if you want a different `AI_CONCURRENCY`.

## AI

Summaries run through `cursor-agent` by default. Set `AI_BACKEND=claude` to call the Claude API directly (needs `ANTHROPIC_API_KEY`), or `AI_BACKEND=claude-cli` to spawn `claude -p` processes (uses your Claude Code login). A pool of clients (default 4, set `AI_CONCURRENCY`) pulls jobs off a queue. Each client keeps its conversation for the whole job, including a chunk's shape-check retry, then clears it before taking the next job.

Every AI call in the last run is logged to `.ai-log/` (gitignored, set `AI_LOG_DIR` to move it). It is emptied when a command that uses AI starts. `index.log` has one line per call; each call's folder has `prompt.txt` (exact input), `response.txt` (raw output, before JSON/prose extraction) and `meta.json` (options, session, timing, stderr, error).

Chunks in one session run at the same time. The merge prompts for one session do too. Vault entity writes for one session do too. Sessions still run one date after another, because a new entity has to be in the catalog before the next session is matched.

## Session workflow

1. Add the new files:

   ```
   transcripts/YYYY-MM-DD/recap.md
   transcripts/YYYY-MM-DD/transcript.md
   ```

2. Run the local pipeline. Completed steps are skipped automatically:

   ```bash
   npm start -- 2026-08-17
   ```

   That runs **chunks → merge**. Vault is skipped by default (it uses a lot of AI calls). When you are ready:

   ```bash
   npm start -- vault 2026-08-17
   # or include it in the same run:
   npm start -- 2026-08-17 --with-vault
   ```

3. After vault data exists, optionally look for duplicate entities (same person/place under different names). This is **not** part of process/vault:

   ```bash
   npm start -- dedup
   npm start -- dedup --interactive
   ```

   `--dry-run` alone prints the entity table that would be sent to the AI. With `--interactive`, the scan and review still run, but merges are only printed (no AI merge / file writes).

4. Assign tags from the closed catalog to existing vault entities (also not part of process/vault):

   ```bash
   npm start -- tags
   npm start -- tags --dry-run
   ```

   Suggestions for new catalog tags are appended to `vault-data/tag-suggestions.json` for human review.

5. Commit `summaries/` and `vault-data/`. CI runs `lib/generate-markdown.ts` and publishes the site.

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

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_CONCURRENCY` | `4` | How many AI clients run at once. Each keeps its own conversation. |
| `AI_BACKEND` | `cursor` | `cursor` (cursor-agent CLI), `claude` (Claude API), or `claude-cli` (Claude Code CLI). |
| `ANTHROPIC_API_KEY` | — | API key for the `claude` backend. |
| `CLAUDE_MODEL` | `claude-opus-5-5` (API) / CLI default | Default model for the `claude` and `claude-cli` backends. |
| `CLAUDE_CLI_PATH` | `claude` | Executable for the `claude-cli` backend. |
| `AI_LOG_DIR` | `.ai-log/` | Where the last run's prompt log goes. |
