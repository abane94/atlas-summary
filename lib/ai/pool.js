import { CursorClient } from "./cursor.js";

/** How many Cursor clients to run at once. Override with AI_CONCURRENCY. */
export function aiPoolSize() {
  const raw = process.env.AI_CONCURRENCY;
  if (raw == null || raw === "") return 4;
  const size = Number(raw);
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(
      `AI_CONCURRENCY must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return size;
}

/**
 * n clients, one queue. A job borrows one client for every prompt it needs
 * (including a follow-up that depends on that conversation), then the client
 * is cleared and returned to the queue.
 *
 * Do not call pool.run or pool.map from inside a job. The client for that
 * job is the argument passed to the job.
 *
 * @param {{ size?: number, createClient?: () => import("../ai.js").AiClient }} [options]
 */
export function createAiPool(options = {}) {
  const size = options.size ?? aiPoolSize();
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`AI pool size must be a positive integer, got ${size}`);
  }
  const createClient = options.createClient ?? (() => new CursorClient());
  const clients = Array.from({ length: size }, () => createClient());
  /** @type {import("../ai.js").AiClient[]} */
  const idle = [...clients];
  /** @type {((client: import("../ai.js").AiClient) => void)[]} */
  const waiters = [];

  const acquire = () => {
    const client = idle.pop();
    if (client) return Promise.resolve(client);
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  };

  /** @param {import("../ai.js").AiClient} client */
  const release = (client) => {
    const waiter = waiters.shift();
    if (waiter) waiter(client);
    else idle.push(client);
  };

  /**
   * @template T
   * @param {(client: import("../ai.js").AiClient) => Promise<T>} job
   * @returns {Promise<T>}
   */
  const run = async (job) => {
    const client = await acquire();
    try {
      return await job(client);
    } finally {
      try {
        await client.resetConversation();
      } finally {
        release(client);
      }
    }
  };

  /**
   * Workers pull items until the queue is empty. One failure stops new claims.
   * Jobs already running still finish, and every client is cleared, before this rejects.
   *
   * @template T, R
   * @param {readonly T[]} items
   * @param {(item: T, client: import("../ai.js").AiClient, index: number) => Promise<R>} job
   * @returns {Promise<R[]>}
   */
  const map = async (items, job) => {
    if (items.length === 0) return [];
    const queue = items.map((item, index) => ({ item, index }));
    /** @type {R[]} */
    const results = new Array(items.length);
    /** @type {unknown[]} */
    const errors = [];
    let stop = false;
    const workerCount = Math.min(size, items.length);

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        const client = await acquire();
        try {
          while (!stop) {
            const next = queue.shift();
            if (!next) break;
            try {
              results[next.index] = await job(next.item, client, next.index);
            } catch (error) {
              errors.push(error);
              stop = true;
            } finally {
              await client.resetConversation();
            }
          }
        } finally {
          release(client);
        }
      }),
    );

    throwIfAny(errors);
    return results;
  };

  /**
   * Wait for every promise, then reject if any failed.
   * Use this when jobs were started with pool.run and must all settle
   * before the pool closes.
   *
   * @template T
   * @param {Promise<T>[]} promises
   * @returns {Promise<T[]>}
   */
  const settle = async (promises) => {
    const results = await Promise.allSettled(promises);
    /** @type {unknown[]} */
    const errors = [];
    /** @type {T[]} */
    const values = [];
    for (const result of results) {
      if (result.status === "fulfilled") values.push(result.value);
      else errors.push(result.reason);
    }
    throwIfAny(errors);
    return values;
  };

  return {
    size,
    async open() {
      await Promise.all(clients.map((client) => client.open()));
    },
    async close() {
      await Promise.all(clients.map((client) => client.close()));
    },
    run,
    map,
    settle,
  };
}

/**
 * @param {unknown[]} errors
 */
function throwIfAny(errors) {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `${errors.length} AI jobs failed`);
  }
}

/**
 * Open n Cursor clients, run fn, then close them.
 * @template T
 * @param {(pool: ReturnType<typeof createAiPool>) => Promise<T>} fn
 * @param {{ size?: number, createClient?: () => import("../ai.js").AiClient }} [options]
 * @returns {Promise<T>}
 */
export async function withAiPool(fn, options) {
  const pool = createAiPool(options);
  console.log(`[ai] ${pool.size} Cursor client${pool.size === 1 ? "" : "s"}`);
  await pool.open();
  try {
    return await fn(pool);
  } finally {
    await pool.close();
  }
}
