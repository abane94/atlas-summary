export type AiEffort = "low" | "medium" | "high";

/**
 * Shared prompt options. Every implementation accepts the same fields;
 * unused fields are ignored.
 */
export type AiPromptOptions = {
  /** Unused by the Cursor client. Kept so older call sites still type-check. */
  timeout?: number;
  /**
   * Portable quality hint. Cursor maps this to `--model`.
   * Omit to use the Cursor default model.
   */
  effort?: AiEffort;
  /** Cursor `--model` slug. Overrides `effort` when set. */
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
