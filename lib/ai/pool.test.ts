import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AiClient } from "../ai.js";
import { aiPoolSize, createAiPool, withAiPool } from "./pool.js";
import { CursorClient } from "./cursor.js";

const originalConcurrency = process.env.AI_CONCURRENCY;

afterEach(() => {
  if (originalConcurrency === undefined) delete process.env.AI_CONCURRENCY;
  else process.env.AI_CONCURRENCY = originalConcurrency;
});

function fakeClient(events: string[], id: string): AiClient {
  return {
    async open() {},
    async close() {},
    async resetConversation() {
      events.push(`${id}:reset`);
    },
    async runJsonPrompt(prompt: string) {
      events.push(`${id}:${prompt}`);
      return prompt;
    },
    async runProsePrompt(prompt: string) {
      events.push(`${id}:${prompt}`);
      return prompt;
    },
  };
}

describe("ai pool", () => {
  it("keeps one client's conversation until the job finishes", async () => {
    const events: string[] = [];
    const pool = createAiPool({
      size: 1,
      createClient: () => fakeClient(events, "1"),
    });

    await pool.map(["a", "b"], async (item, ai) => {
      await ai.runJsonPrompt(`${item}1`);
      await ai.runJsonPrompt(`${item}2`);
    });

    assert.deepEqual(events, ["1:a1", "1:a2", "1:reset", "1:b1", "1:b2", "1:reset"]);
  });

  it("runs at most n jobs at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const pool = createAiPool({
      size: 2,
      createClient: () => ({
        async open() {},
        async close() {},
        async resetConversation() {},
        async runJsonPrompt() {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 30));
          inFlight--;
          return "";
        },
        async runProsePrompt() {
          return "";
        },
      }),
    });

    await pool.map([1, 2, 3, 4, 5], async (_item, ai) => {
      await ai.runJsonPrompt("x");
    });

    assert.equal(maxInFlight, 2);
    assert.equal(inFlight, 0);
  });

  it("stops claiming new jobs after a failure and still finishes the one in flight", async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pool = createAiPool({
      size: 2,
      createClient: () => ({
        async open() {},
        async close() {},
        async resetConversation() {},
        async runJsonPrompt() {
          return "";
        },
        async runProsePrompt() {
          return "";
        },
      }),
    });

    const running = pool.map(["a", "b", "c", "d"], async (item) => {
      started.push(item);
      await hold;
      if (item === "a") throw new Error("boom");
      return item;
    });

    while (started.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(started, ["a", "b"]);
    release();
    await assert.rejects(running, /boom/);
    assert.deepEqual(started, ["a", "b"]);
  });

  it("settle waits for every job before rejecting", async () => {
    const pool = createAiPool({
      size: 2,
      createClient: () => ({
        async open() {},
        async close() {},
        async resetConversation() {},
        async runJsonPrompt() {
          return "";
        },
        async runProsePrompt() {
          return "";
        },
      }),
    });
    let releaseSlow: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowFinished = false;
    const settled = pool.settle([
      pool.run(async () => {
        throw new Error("boom");
      }),
      pool.run(async () => {
        await slow;
        slowFinished = true;
        return "ok";
      }),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(slowFinished, false);
    releaseSlow();
    await assert.rejects(settled, /boom/);
    assert.equal(slowFinished, true);
  });

  it("closes clients after a job rejects", async () => {
    let closed = 0;
    await assert.rejects(
      withAiPool(
        async (pool) => {
          await pool.run(async () => {
            throw new Error("nope");
          });
        },
        {
          size: 2,
          createClient: () => ({
            async open() {},
            async close() {
              closed++;
            },
            async resetConversation() {},
            async runJsonPrompt() {
              return "";
            },
            async runProsePrompt() {
              return "";
            },
          }),
        },
      ),
      /nope/,
    );
    assert.equal(closed, 2);
  });

  it("reads AI_CONCURRENCY", () => {
    process.env.AI_CONCURRENCY = "3";
    assert.equal(aiPoolSize(), 3);
    process.env.AI_CONCURRENCY = "0";
    assert.throws(() => aiPoolSize(), /AI_CONCURRENCY/);
  });
});

describe("CursorClient", () => {
  it("gives each client its own workspace", () => {
    const a = new CursorClient();
    const b = new CursorClient();
    assert.notEqual(a.workspace, b.workspace);
    assert.notEqual(a.id, b.id);
  });
});
