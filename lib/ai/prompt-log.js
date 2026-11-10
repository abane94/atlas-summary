import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Prompt log: the exact input and output of every AI call in the last run.
 *
 * `startPromptLog()` (called once at program start) empties the directory.
 * Every backend call then writes one folder:
 *
 *   .ai-log/0007-claude-cli-c2/
 *     prompt.txt    exact text sent to the model (written before the call)
 *     response.txt  raw model text, before JSON/prose extraction
 *     meta.json     backend, client, options, session, timing, raw envelope,
 *                   stderr, and the error if the call failed
 *
 * plus one line per call in `.ai-log/index.log`.
 *
 * Until `startPromptLog()` runs (e.g. under `npm test`), recording is a no-op.
 */

const DEFAULT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.ai-log",
);

/** @type {string | undefined} */
let logDir;
let callCount = 0;

/** Directory the current run logs to, or undefined when logging is off. */
export function promptLogDir() {
  return logDir;
}

/**
 * Empty the log directory and start recording. Override the location with
 * AI_LOG_DIR. Safe to call more than once; only the first call clears.
 */
export function startPromptLog(dir = process.env.AI_LOG_DIR || DEFAULT_DIR) {
  if (logDir) return logDir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  logDir = dir;
  callCount = 0;
  return dir;
}

/** Stop recording. For tests. */
export function stopPromptLog() {
  logDir = undefined;
}

/**
 * @typedef {{
 *   backend: string,
 *   clientId: number | string,
 *   prompt: string,
 *   options?: object,
 *   sessionId?: string,
 *   request?: unknown,
 * }} PromptCallInfo
 *
 * @typedef {{ text: string, raw?: unknown, sessionId?: string }} PromptCallResult
 */

/**
 * Run one backend call and record its input and output.
 * The prompt is written before the call, so a hang or crash still leaves it.
 *
 * @param {PromptCallInfo} info
 * @param {() => Promise<PromptCallResult>} call
 * @returns {Promise<PromptCallResult>}
 */
export async function recordPrompt(info, call) {
  const dir = logDir;
  if (!dir) return call();

  const id = String(++callCount).padStart(4, "0");
  const name = `${id}-${info.backend}-c${info.clientId}`;
  const callDir = path.join(dir, name);
  const startedAt = new Date();
  fs.mkdirSync(callDir, { recursive: true });
  fs.writeFileSync(path.join(callDir, "prompt.txt"), info.prompt);

  /** @param {object} extra */
  const writeMeta = (extra) => {
    const meta = {
      backend: info.backend,
      clientId: info.clientId,
      options: info.options ?? {},
      sessionIdBefore: info.sessionId ?? null,
      request: info.request,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      promptChars: info.prompt.length,
      ...extra,
    };
    safeWrite(path.join(callDir, "meta.json"), JSON.stringify(meta, null, 2));
    return meta;
  };

  try {
    const result = await call();
    safeWrite(path.join(callDir, "response.txt"), result.text);
    const meta = writeMeta({
      ok: true,
      sessionIdAfter: result.sessionId ?? null,
      responseChars: result.text.length,
      raw: result.raw,
    });
    appendIndex(dir, `${name}  ok     ${meta.durationMs}ms  ${firstLine(info.prompt)}`);
    return result;
  } catch (error) {
    const e = /** @type {any} */ (error);
    if (typeof e?.stdout === "string" && e.stdout) {
      safeWrite(path.join(callDir, "response.txt"), e.stdout);
    }
    const meta = writeMeta({
      ok: false,
      error: {
        name: e?.name,
        message: e?.message ?? String(error),
        stderr: e?.stderr,
        stdout: e?.stdout,
        status: e?.status,
        stack: e?.stack,
      },
    });
    appendIndex(
      dir,
      `${name}  ERROR  ${meta.durationMs}ms  ${firstLine(e?.message ?? String(error))}`,
    );
    throw error;
  }
}

/** @param {string} text */
function firstLine(text) {
  const line = String(text).split("\n").find((l) => l.trim() !== "") ?? "";
  return line.trim().slice(0, 160);
}

/**
 * @param {string} dir
 * @param {string} line
 */
function appendIndex(dir, line) {
  try {
    fs.appendFileSync(path.join(dir, "index.log"), `${line}\n`);
  } catch {
    // Logging must never break a run.
  }
}

/**
 * @param {string} file
 * @param {string} content
 */
function safeWrite(file, content) {
  try {
    fs.writeFileSync(file, content);
  } catch {
    // Logging must never break a run.
  }
}
