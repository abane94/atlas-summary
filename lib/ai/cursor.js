import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  extractProseAnswer,
  parseJsonResponse,
  wrapJsonPrompt,
  wrapProsePrompt,
} from "./response-text.js";

const execFileAsync = promisify(execFile);

/** @type {Record<import("../ai.js").AiEffort, string>} */
const EFFORT_TO_MODEL = {
  low: "grok-4.7-low",
  medium: "grok-4.7-medium",
  high: "grok-4.7-high",
};

/** @param {import("../ai.js").AiPromptOptions} [options] */
const modelFromOptions = (options = {}) => {
  if (typeof options.model === "string" && options.model) {
    return options.model;
  }
  if (options.effort && EFFORT_TO_MODEL[options.effort]) {
    return EFFORT_TO_MODEL[options.effort];
  }
  return undefined;
};

/**
 * Empty directory so the agent cannot open this repo and narrate that it is
 * checking earlier notes. Every prompt already inlines the source text.
 * Each client gets its own directory so concurrent agents do not share one.
 */
const WORKSPACE_ROOT = path.join(os.tmpdir(), "dnd-transcribe-summary-cursor");

let nextClientId = 0;

export class CursorClient {
  /** @type {string | undefined} */
  sessionId = undefined;

  /** @type {number} */
  id = ++nextClientId;

  /** @type {string} */
  workspace = path.join(WORKSPACE_ROOT, String(this.id));

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

    let [markdown, html, text] = await this.#runPrompt(
      wrapJsonPrompt(ai_prompt),
      options,
    );
    let json = parseJsonResponse(markdown, text);
    let i = 0;
    while (json == null && i < 10) {
      console.log(`Trying to parse json ${i} times`);
      [markdown, html, text] = await this.#runPrompt(
        wrapJsonPrompt(
          "Reply with one JSON value only. No markdown fences and no other text.",
        ),
        {
          ...options,
          timeout: 0,
        },
      );
      json = parseJsonResponse(markdown, text);
      i++;
    }
    if (json) return json;
    return markdown;
  }

  /**
   * Cursor-agent prompt that returns prose (plain text / markdown), not JSON.
   * @param {string} ai_prompt
   * @param {import("../ai.js").AiPromptOptions} [options]
   */
  async runProsePrompt(ai_prompt, options = {}) {
    this.sessionId = undefined;
    const [markdown, _html, text] = await this.#runPrompt(
      wrapProsePrompt(ai_prompt),
      options,
    );
    return extractProseAnswer(markdown || text || "");
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
      "--mode",
      "ask",
      "--trust",
      "--workspace",
      this.workspace,
    ];
    const model = modelFromOptions(options);
    if (model) {
      args.push("--model", model);
    }
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }
    args.push(ai_prompt);

    const { stdout } = await execFileAsync("cursor-agent", args, {
      maxBuffer: 50 * 1024 * 1024,
    });

    const envelope = JSON.parse(stdout);
    if (envelope.is_error || envelope.subtype !== "success") {
      throw new Error(`cursor-agent failed: ${envelope.result ?? stdout}`);
    }

    if (envelope.session_id) {
      this.sessionId = envelope.session_id;
    }

    const text = envelope.result ?? "";
    return [text, text, text];
  }
}
