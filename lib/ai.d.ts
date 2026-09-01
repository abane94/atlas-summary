export type AiEffort = "low" | "medium" | "high";

/**
 * Shared prompt options. Every implementation accepts the same fields;
 * unused fields are ignored.
 */
export type AiPromptOptions = {
  /** ChatGPT: wait after submit before polling for completion. Cursor: ignored. */
  timeout?: number;
  /**
   * Portable quality hint. Cursor maps this to `--model`; ChatGPT ignores it.
   * Omit to use the implementation default (ChatGPT UI model / Cursor `auto`).
   */
  effort?: AiEffort;
  /** Cursor `--model` slug. Overrides `effort` when set. ChatGPT ignores it. */
  model?: string;
};

export function runJsonPrompt(
  page: unknown,
  ai_prompt: string,
  options?: AiPromptOptions,
): Promise<string>;

export function runProsePrompt(
  page: unknown,
  ai_prompt: string,
  options?: AiPromptOptions,
): Promise<string>;
