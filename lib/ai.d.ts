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

export interface AiClient {
  open(): Promise<void>;
  close(): Promise<void>;
  /** Next prompt starts a new conversation. */
  resetConversation(): Promise<void>;
  runJsonPrompt(prompt: string, options?: AiPromptOptions): Promise<string>;
  runProsePrompt(prompt: string, options?: AiPromptOptions): Promise<string>;
}

export declare const ai: AiClient;

export declare function withAi<T>(
  fn: (client: AiClient) => Promise<T>,
): Promise<T>;

export declare class CursorClient implements AiClient {
  open(): Promise<void>;
  close(): Promise<void>;
  resetConversation(): Promise<void>;
  runJsonPrompt(prompt: string, options?: AiPromptOptions): Promise<string>;
  runProsePrompt(prompt: string, options?: AiPromptOptions): Promise<string>;
}

export declare class ChatGptClient implements AiClient {
  open(): Promise<void>;
  close(): Promise<void>;
  resetConversation(): Promise<void>;
  runJsonPrompt(prompt: string, options?: AiPromptOptions): Promise<string>;
  runProsePrompt(prompt: string, options?: AiPromptOptions): Promise<string>;
}
