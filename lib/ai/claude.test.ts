import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ClaudeClient } from "./claude.js";
import { aiBackend, createAiPool } from "./pool.js";

type Reply = { text?: string; stop_reason?: string; stop_details?: unknown };

/** Fake SDK: records each request body and answers from a script. */
function fakeAnthropic(replies: Reply[]) {
  const requests: any[] = [];
  const anthropic = {
    beta: {
      messages: {
        stream(params: any) {
          // Copy so later appends to the client's history don't change what we recorded.
          requests.push(structuredClone(params));
          const reply = replies.shift() ?? { text: "" };
          return {
            async finalMessage() {
              return {
                stop_reason: reply.stop_reason ?? "end_turn",
                stop_details: reply.stop_details ?? null,
                content: [
                  { type: "thinking", thinking: "", signature: "sig" },
                  { type: "text", text: reply.text ?? "" },
                ],
              };
            },
          };
        },
      },
    },
  };
  return { anthropic: anthropic as any, requests };
}

const originalBackend = process.env.AI_BACKEND;
const originalModel = process.env.CLAUDE_MODEL;
afterEach(() => {
  if (originalBackend === undefined) delete process.env.AI_BACKEND;
  else process.env.AI_BACKEND = originalBackend;
  if (originalModel === undefined) delete process.env.CLAUDE_MODEL;
  else process.env.CLAUDE_MODEL = originalModel;
});

describe("ClaudeClient", () => {
  it("returns parsed JSON and maps effort to output_config", async () => {
    const { anthropic, requests } = fakeAnthropic([{ text: '{"a": 1}' }]);
    const client = new ClaudeClient({ anthropic });

    const result = await client.runJsonPrompt("Give me JSON", { effort: "low" });

    assert.deepEqual(JSON.parse(result), { a: 1 });
    assert.equal(requests[0].model, "claude-opus-5-5");
    assert.deepEqual(requests[0].output_config, { effort: "low" });
    assert.equal(requests[0].fallbacks, "default");
    assert.deepEqual(requests[0].betas, ["server-side-fallback-2026-07-01"]);
  });

  it("retries on the same conversation when the reply is not JSON", async () => {
    const { anthropic, requests } = fakeAnthropic([
      { text: "not json" },
      { text: '["ok"]' },
    ]);
    const client = new ClaudeClient({ anthropic });

    const result = await client.runJsonPrompt("Give me JSON");

    assert.deepEqual(JSON.parse(result), ["ok"]);
    assert.equal(requests.length, 2);
    const second = requests[1].messages;
    assert.equal(second.length, 3);
    assert.deepEqual(
      second.map((m: any) => m.role),
      ["user", "assistant", "user"],
    );
    // Full assistant content (thinking block included) is sent back unchanged.
    assert.equal(second[1].content[0].type, "thinking");
  });

  it("resetConversation and runProsePrompt start fresh", async () => {
    const { anthropic, requests } = fakeAnthropic([
      { text: "{}" },
      { text: "<answer>The party rested.</answer>" },
      { text: "{}" },
    ]);
    const client = new ClaudeClient({ anthropic });

    await client.runJsonPrompt("first");
    const prose = await client.runProsePrompt("second");
    assert.equal(prose, "The party rested.");
    assert.equal(requests[1].messages.length, 1);

    await client.resetConversation();
    await client.runJsonPrompt("third");
    assert.equal(requests[2].messages.length, 1);
  });

  it("uses options.model, skipping fallbacks on models without them", async () => {
    const { anthropic, requests } = fakeAnthropic([{ text: "{}" }]);
    const client = new ClaudeClient({ anthropic });

    await client.runJsonPrompt("x", { model: "claude-haiku-5-5" });

    assert.equal(requests[0].model, "claude-haiku-5-5");
    assert.equal(requests[0].fallbacks, undefined);
    assert.equal(requests[0].betas, undefined);
  });

  it("reads the default model from CLAUDE_MODEL", async () => {
    process.env.CLAUDE_MODEL = "claude-sonnet-5-5";
    const { anthropic, requests } = fakeAnthropic([{ text: "{}" }]);
    await new ClaudeClient({ anthropic }).runJsonPrompt("x");
    assert.equal(requests[0].model, "claude-sonnet-5-5");
  });

  it("throws on refusal", async () => {
    const { anthropic } = fakeAnthropic([
      {
        stop_reason: "refusal",
        stop_details: { category: "bio", explanation: "nope" },
      },
    ]);
    const client = new ClaudeClient({ anthropic });
    await assert.rejects(client.runJsonPrompt("x"), /declined.*bio.*nope/);
  });
});

describe("aiBackend", () => {
  it("defaults to cursor and accepts claude", () => {
    delete process.env.AI_BACKEND;
    assert.equal(aiBackend(), "cursor");
    process.env.AI_BACKEND = "Claude";
    assert.equal(aiBackend(), "claude");
  });

  it("rejects unknown backends", () => {
    process.env.AI_BACKEND = "gpt";
    assert.throws(() => aiBackend(), /AI_BACKEND must be one of/);
    assert.throws(() => createAiPool({ size: 1 }), /AI_BACKEND/);
  });
});
