import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordPrompt } from "./prompt-log.js";
import {
  extractProseAnswer,
  parseJsonResponse,
  wrapJsonPrompt,
  wrapProsePrompt,
} from "./response-text.js";

/**
 * Replaces Claude Code's coding-agent system prompt. Every prompt already
 * inlines the source text, so the model needs no tools or repo context.
 */
const SYSTEM_PROMPT =
  "You write campaign notes from tabletop RPG (Dungeons & Dragons) session transcripts. " +
  "The violence, crime, and dark themes in the transcripts are fiction from a game. " +
  "Answer from the message alone.";

/** @param {import("../ai.js").AiPromptOptions} [options] */
const modelFromOptions = (options = {}) => {
  if (typeof options.model === "string" && options.model) return options.model;
  return process.env.CLAUDE_MODEL || undefined;
};

/**
 * Empty working directory so Claude Code does not pick up this repo's
 * CLAUDE.md or settings. Saved sessions (needed for --resume) also land under
 * this path in ~/.claude/projects instead of mixing with the repo's own.
 * Each client gets its own directory so concurrent processes do not share one.
 */
const WORKSPACE_ROOT = path.join(os.tmpdir(), "dnd-transcribe-summary-claude");

let nextClientId = 0;

export class ClaudeCliClient {
  /** @type {string | undefined} */
  sessionId = undefined;

  /** @type {number} */
  id = ++nextClientId;

  /** @type {string} */
  workspace = path.join(WORKSPACE_ROOT, String(this.id));

  /** Executable to spawn. Override with CLAUDE_CLI_PATH. */
  command = process.env.CLAUDE_CLI_PATH || "claude";

  /**
   * Serializes prompt runs on this client so a follow-up stays on the same
   * conversation. Other clients have their own lock and can run at the same time.
   * @type {Promise<void>}
   */
  #promptLock = Promise.resolve();

  async open() {
    fs.mkdirSync(this.workspace, { recursive: true });
  }

  async close() {}

  /** @returns {Promise<() => void>} */
  #acquirePromptLock() {
    let release = () => {};
    const previous = this.#promptLock;
    this.#promptLock = new Promise((resolve) => {
      release = resolve;
    });
    return previous.then(() => release);
  }

  async resetConversation() {
    this.sessionId = undefined;
  }

  /**
   * @param {string} ai_prompt
   * @param {import("../ai.js").AiPromptOptions} [options]
   */
  async runJsonPrompt(ai_prompt, options = {}) {
    console.log(
      `[ai ${this.id}] Prompting: ${ai_prompt.split("\n").filter((line) => line.trim() !== "")[0]}`,
    );

    let text = await this.#runPrompt(wrapJsonPrompt(ai_prompt), options);
    let json = parseJsonResponse(text);
    let i = 0;
    while (json == null && i < 10) {
      console.log(`Trying to parse json ${i} times`);
      text = await this.#runPrompt(
        wrapJsonPrompt(
          "Reply with one JSON value only. No markdown fences and no other text.",
        ),
        options,
      );
      json = parseJsonResponse(text);
      i++;
    }
    if (json) return json;
    return text;
  }

  /**
   * Prompt that returns prose (plain text / markdown), not JSON.
   * Starts a fresh conversation, matching the Cursor client.
   * @param {string} ai_prompt
   * @param {import("../ai.js").AiPromptOptions} [options]
   */
  async runProsePrompt(ai_prompt, options = {}) {
    this.sessionId = undefined;
    const text = await this.#runPrompt(wrapProsePrompt(ai_prompt), options);
    return extractProseAnswer(text);
  }

  /**
   * @param {string} ai_prompt
   * @param {import("../ai.js").AiPromptOptions} [options]
   */
  async #runPrompt(ai_prompt, options = {}) {
    const release = await this.#acquirePromptLock();
    try {
      return await this.#runPromptAttempt(ai_prompt, options);
    } finally {
      release();
    }
  }

  /**
   * @param {string} ai_prompt
   * @param {import("../ai.js").AiPromptOptions} [options]
   */
  async #runPromptAttempt(ai_prompt, options = {}) {
    fs.mkdirSync(this.workspace, { recursive: true });
    const args = [
      "-p",
      "--output-format",
      "json",
      // No built-in tools, MCP servers, or slash commands: a plain text model.
      "--tools",
      "",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--system-prompt",
      SYSTEM_PROMPT,
    ];
    const model = modelFromOptions(options);
    if (model) args.push("--model", model);
    if (options.effort) args.push("--effort", options.effort);
    if (this.sessionId) args.push("--resume", this.sessionId);

    const { text, sessionId } = await recordPrompt(
      {
        backend: "claude-cli",
        clientId: this.id,
        prompt: ai_prompt,
        options,
        sessionId: this.sessionId,
        request: { command: this.command, args, cwd: this.workspace },
      },
      async () => {
        // The prompt goes on stdin: Linux caps a single argv entry at 128 KiB,
        // which a long transcript chunk can exceed.
        const { stdout, stderr } = await runProcess(this.command, args, {
          cwd: this.workspace,
          input: ai_prompt,
        });
        const envelope = parseEnvelope(stdout, stderr);
        return {
          text: envelope.result ?? "",
          raw: { envelope, stderr },
          sessionId: envelope.session_id,
        };
      },
    );

    if (sessionId) this.sessionId = sessionId;
    return text;
  }
}

/**
 * Parse `claude -p --output-format json` output and throw on failure.
 * @param {string} stdout
 * @param {string} stderr
 */
function parseEnvelope(stdout, stderr) {
  /** @type {any} */
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw processError(
      `claude returned non-JSON output: ${stdout.slice(0, 500) || stderr.slice(0, 500)}`,
      stdout,
      stderr,
    );
  }
  if (envelope.is_error || envelope.subtype !== "success") {
    throw processError(
      `claude failed (${envelope.subtype ?? "error"}): ${envelope.result ?? stdout.slice(0, 500)}`,
      stdout,
      stderr,
    );
  }
  if (envelope.stop_reason === "refusal") {
    throw processError(
      `Claude declined the prompt: ${envelope.result ?? ""}`,
      stdout,
      stderr,
    );
  }
  return envelope;
}

/**
 * Error that carries the process output, so callers and the prompt log see it.
 * @param {string} message
 * @param {string} stdout
 * @param {string} stderr
 */
function processError(message, stdout, stderr) {
  return Object.assign(new Error(message), { stdout, stderr });
}

/**
 * Spawn a process, write `input` to its stdin, and resolve with its output.
 * Exit code 1 with a JSON envelope on stdout still resolves, so the envelope's
 * own error message is reported. Any other non-zero exit rejects.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, input: string }} options
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runProcess(command, args, { cwd, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8").trim();
      if (code === 0 || (code === 1 && stdout.trimStart().startsWith("{"))) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        processError(
          `${command} exited with ${signal ?? `code ${code}`}: ${stderr || stdout.slice(0, 500)}`,
          stdout,
          stderr,
        ),
      );
    });
    child.stdin.on("error", () => {}); // reported through "close" instead
    child.stdin.end(input);
  });
}
