import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

/** Serializes prompt runs so two Cursor prompts never overlap. */
let promptLock = Promise.resolve();

const acquirePromptLock = () => {
  let release;
  const previous = promptLock;
  promptLock = new Promise((resolve) => {
    release = resolve;
  });
  return previous.then(() => release);
};

const stripJsonFences = (text) =>
  text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

const tryJsonParse = (markdown, text) => {
  try {
    return JSON.parse(markdown);
  } catch (error) {
    console.error(`Error parsing markdown: ${error}`);
    try {
      return JSON.parse(text);
    } catch (error) {
      console.error(`Error parsing text: ${error}`);
      return false;
    }
  }
};

export class CursorClient {
  /** @type {string | undefined} */
  sessionId = undefined;

  async open() {}

  async close() {}

  async resetConversation() {
    this.sessionId = undefined;
  }

  /**
   * @param {string} ai_prompt
   * @param {import("../ai.js").AiPromptOptions} [options]
   */
  async runJsonPrompt(ai_prompt, options = {}) {
    console.log(
      `Prompting: ${ai_prompt.split("\n").filter((line) => line.trim() !== "")[0]}`,
    );

    let [markdown, html, text] = await this.#runPrompt(ai_prompt, options);

    try {
      return JSON.stringify(JSON.parse(markdown), null, 4);
    } catch {
      try {
        return JSON.stringify(JSON.parse(text), null, 4);
      } catch {
        let json = false;
        let i = 0;
        while (json == false && i < 10) {
          console.log(`Trying to parse json ${i} times`);
          [markdown, html, text] = await this.#runPrompt(
            "Please respond with valid json",
            {
              ...options,
              timeout: 0,
            },
          );
          json = tryJsonParse(markdown, text);
          i++;
        }
        if (json) {
          return JSON.stringify(json, null, 4);
        }
        return markdown;
      }
    }
  }

  /**
   * Cursor-agent prompt that returns prose (plain text / markdown), not JSON.
   * @param {string} ai_prompt
   * @param {import("../ai.js").AiPromptOptions} [options]
   */
  async runProsePrompt(ai_prompt, options = {}) {
    this.sessionId = undefined;
    const [markdown, _html, text] = await this.#runPrompt(ai_prompt, options);
    return (markdown || text || "").trim();
  }

  /**
   * @param {string} ai_prompt
   * @param {import("../ai.js").AiPromptOptions} [options]
   */
  async #runPrompt(ai_prompt, options = {}) {
    const release = await acquirePromptLock();
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
    const args = [
      "-p",
      "--output-format",
      "json",
      "--mode",
      "ask",
      "--trust",
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
    const markdown = stripJsonFences(text);
    return [markdown, text, text];
  }
}
