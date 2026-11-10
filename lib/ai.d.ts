export type AiEffort = "low" | "medium" | "high";

/** Selected with the AI_BACKEND env var. */
export type AiBackend = "cursor" | "claude" | "claude-cli";

/**
 * Shared prompt options. Every implementation accepts the same fields;
 * unused fields are ignored.
 */
export type AiPromptOptions = {
  /** Unused by every client. Kept so older call sites still type-check. */
  timeout?: number;
  /**
   * Portable quality hint. Cursor maps this to `--model`; the Claude API maps it
   * to `output_config.effort`; the Claude CLI to `--effort`. Omit to use the
   * backend's default.
   */
  effort?: AiEffort;
  /**
   * Backend model id: a Cursor `--model` slug (overrides `effort`), or a Claude
   * model id or CLI alias such as `claude-opus-5-5` / `sonnet` (used alongside
   * `effort`).
   */
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

export interface AiPool {
  readonly size: number;
  open(): Promise<void>;
  close(): Promise<void>;
  /**
   * Borrow one client for this job. The conversation is cleared after the job
   * settles, including when it throws.
   */
  run<T>(job: (client: AiClient) => Promise<T>): Promise<T>;
  /**
   * n workers pull jobs off the queue. Each job keeps its client until it
   * finishes, so follow-up prompts still see that conversation.
   */
  map<T, R>(
    items: readonly T[],
    job: (item: T, client: AiClient, index: number) => Promise<R>,
  ): Promise<R[]>;
  /** Wait until every promise has settled, then reject if any failed. */
  settle<T>(promises: Promise<T>[]): Promise<T[]>;
}

export interface AiPoolOptions {
  size?: number;
  createClient?: () => AiClient;
}

export function aiBackend(): AiBackend;

export function aiPoolSize(): number;

export function createAiPool(options?: AiPoolOptions): AiPool;

export function withAiPool<T>(
  fn: (pool: AiPool) => Promise<T>,
  options?: AiPoolOptions,
): Promise<T>;

export declare class CursorClient implements AiClient {
  readonly id: number;
  readonly workspace: string;
  open(): Promise<void>;
  close(): Promise<void>;
  resetConversation(): Promise<void>;
  runJsonPrompt(prompt: string, options?: AiPromptOptions): Promise<string>;
  runProsePrompt(prompt: string, options?: AiPromptOptions): Promise<string>;
}

export declare class ClaudeClient implements AiClient {
  readonly id: number;
  constructor(options?: { anthropic?: import("@anthropic-ai/sdk").default });
  open(): Promise<void>;
  close(): Promise<void>;
  resetConversation(): Promise<void>;
  runJsonPrompt(prompt: string, options?: AiPromptOptions): Promise<string>;
  runProsePrompt(prompt: string, options?: AiPromptOptions): Promise<string>;
}

export declare class ClaudeCliClient implements AiClient {
  readonly id: number;
  readonly workspace: string;
  /** Executable to spawn; defaults to CLAUDE_CLI_PATH or `claude`. */
  command: string;
  open(): Promise<void>;
  close(): Promise<void>;
  resetConversation(): Promise<void>;
  runJsonPrompt(prompt: string, options?: AiPromptOptions): Promise<string>;
  runProsePrompt(prompt: string, options?: AiPromptOptions): Promise<string>;
}
