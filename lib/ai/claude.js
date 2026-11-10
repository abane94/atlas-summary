import Anthropic from "@anthropic-ai/sdk";
import { recordPrompt } from "./prompt-log.js";
import {
  extractProseAnswer,
  parseJsonResponse,
  wrapJsonPrompt,
  wrapProsePrompt,
} from "./response-text.js";

/** Default model. Override per call with `options.model`, or globally with CLAUDE_MODEL. */
const DEFAULT_MODEL = "claude-opus-5-5";

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** Streaming keeps long requests clear of HTTP timeouts, so give the model room. */
const MAX_TOKENS = 64_000;

const SYSTEM_PROMPT =
  "You write campaign notes from tabletop RPG (Dungeons & Dragons) session transcripts. " +
  "The violence, crime, and dark themes in the transcripts are fiction from a game.";

/** @param {import("../ai.js").AiPromptOptions} [options] */
const modelFromOptions = (options = {}) => {
  if (typeof options.model === "string" && options.model) return options.model;
  return process.env.CLAUDE_MODEL || DEFAULT_MODEL;
};

let nextClientId = 0;

export class ClaudeClient {
  /** @type {number} */
  id = ++nextClientId;

  /** @type {Anthropic | undefined} */
  #anthropic = undefined;

  /**
   * Conversation so far. The API is stateless, so a follow-up prompt resends
   * this whole history. Assistant turns are stored as the full `content` array
   * (thinking blocks included) and never edited, only appended to.
   * @type {import("@anthropic-ai/sdk").default.Beta.BetaMessageParam[]}
   */
  #messages = [];

  /**
   * Serializes prompt runs on this client so a follow-up stays on the same
   * conversation. Other clients have their own lock and can run at the same time.
   * @type {Promise<void>}
   */
  #promptLock = Promise.resolve();

  /**
   * @param {{ anthropic?: Anthropic }} [options] Pass a client to share one
   *   connection pool or to inject a fake in tests.
   */
  constructor(options = {}) {
    this.#anthropic = options.anthropic;
  }

  async open() {
    // Reads ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile).
    this.#anthropic ??= new Anthropic();
  }

  async close() {}

  async resetConversation() {
    this.#messages = [];
  }

  /** @returns {Promise<() => void>} */
  #acquirePromptLock() {
    let release = () => {};
    const previous = this.#promptLock;
    this.#promptLock = new Promise((resolve) => {
      release = resolve;
    });
    return previous.then(() => release);
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
    this.#messages = [];
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
    await this.open();
    const anthropic = /** @type {Anthropic} */ (this.#anthropic);
    const model = modelFromOptions(options);

    /** @type {import("@anthropic-ai/sdk").default.Beta.BetaMessageParam[]} */
    const messages = [...this.#messages, { role: "user", content: ai_prompt }];

    /** @type {Record<string, unknown>} */
    const params = {
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
      // Caches the conversation prefix, so a JSON retry re-reads the
      // transcript at cache price instead of full price.
      cache_control: { type: "ephemeral" },
    };
    if (options.effort) {
      params.output_config = { effort: options.effort };
    }
    if (FALLBACK_MODELS.has(model)) {
      // If a safety classifier declines (e.g. on graphic in-game violence),
      // the API reruns the request on a fallback model inside the same call.
      params.betas = [FALLBACK_BETA];
      params.fallbacks = "default";
    }

    /** @type {any} */
    let response;
    const { text } = await recordPrompt(
      {
        backend: "claude",
        clientId: this.id,
        prompt: ai_prompt,
        options,
        // Everything except the message history, which is in earlier calls' logs.
        request: { ...params, messages: undefined, historyLength: this.#messages.length },
      },
      async () => {
        response = await anthropic.beta.messages
          .stream(/** @type {any} */ (params))
          .finalMessage();

        if (response.stop_reason === "refusal") {
          const details = response.stop_details;
          throw new Error(
            `Claude declined the prompt (${details?.category ?? "no category"}): ${details?.explanation ?? ""}`.trim(),
          );
        }
        if (response.stop_reason === "max_tokens") {
          throw new Error(
            `Claude hit max_tokens (${MAX_TOKENS}) before finishing the reply`,
          );
        }

        const text = response.content
          .filter((/** @type {any} */ block) => block.type === "text")
          .map((/** @type {any} */ block) => block.text)
          .join("");
        return {
          text,
          raw: {
            id: response.id,
            model: response.model,
            stop_reason: response.stop_reason,
            usage: response.usage,
          },
        };
      },
    );

    this.#messages = [
      ...messages,
      { role: "assistant", content: response.content },
    ];
    return text;
  }
}
