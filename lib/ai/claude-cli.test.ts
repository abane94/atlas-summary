import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ClaudeCliClient } from "./claude-cli.js";
import { startPromptLog, stopPromptLog } from "./prompt-log.js";

/**
 * Fake `claude` executable. Logs each call (args, cwd, stdin) to LOG and
 * answers with the next line from REPLIES as the envelope's `result`.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const { LOG, REPLIES } = process.env;
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  const calls = fs.existsSync(LOG) ? JSON.parse(fs.readFileSync(LOG, "utf8")) : [];
  calls.push({ args: process.argv.slice(2), cwd: process.cwd(), stdin });
  fs.writeFileSync(LOG, JSON.stringify(calls));
  const replies = JSON.parse(fs.readFileSync(REPLIES, "utf8"));
  const reply = replies[calls.length - 1] ?? { result: "" };
  if (reply.exit) {
    process.stderr.write("boom");
    process.exit(reply.exit);
  }
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: reply.subtype ?? "success",
    is_error: reply.is_error ?? false,
    stop_reason: reply.stop_reason ?? "end_turn",
    result: reply.result,
    session_id: "session-" + calls.length,
  }));
});
`;

let dir = "";
let fakePath = "";

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-test-"));
  fakePath = path.join(dir, "fake-claude.cjs");
  fs.writeFileSync(fakePath, FAKE_CLAUDE, { mode: 0o755 });
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function setup(replies: object[]) {
  const log = path.join(dir, `log-${Math.random()}.json`);
  const repliesPath = path.join(dir, `replies-${Math.random()}.json`);
  fs.writeFileSync(repliesPath, JSON.stringify(replies));
  process.env.LOG = log;
  process.env.REPLIES = repliesPath;
  const client = new ClaudeCliClient();
  client.command = fakePath;
  const calls = () =>
    JSON.parse(fs.readFileSync(log, "utf8")) as {
      args: string[];
      cwd: string;
      stdin: string;
    }[];
  return { client, calls };
}

function flag(args: string[], name: string) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

describe("ClaudeCliClient", () => {
  it("sends the prompt on stdin with no tools and maps effort/model", async () => {
    const { client, calls } = setup([{ result: '{"a": 1}' }]);

    const result = await client.runJsonPrompt("Give me JSON", {
      effort: "low",
      model: "sonnet",
    });

    assert.deepEqual(JSON.parse(result), { a: 1 });
    const [call] = calls();
    assert.match(call.stdin, /^Give me JSON/);
    assert.equal(flag(call.args, "--output-format"), "json");
    assert.equal(flag(call.args, "--tools"), "");
    assert.equal(flag(call.args, "--effort"), "low");
    assert.equal(flag(call.args, "--model"), "sonnet");
    assert.equal(flag(call.args, "--resume"), undefined);
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(client.workspace));
  });

  it("resumes the session for the JSON retry", async () => {
    const { client, calls } = setup([{ result: "not json" }, { result: "[1]" }]);

    const result = await client.runJsonPrompt("Give me JSON");

    assert.deepEqual(JSON.parse(result), [1]);
    assert.equal(flag(calls()[1].args, "--resume"), "session-1");
  });

  it("resetConversation and runProsePrompt start fresh", async () => {
    const { client, calls } = setup([
      { result: "{}" },
      { result: "<answer>The party rested.</answer>" },
      { result: "{}" },
    ]);

    await client.runJsonPrompt("first");
    assert.equal(await client.runProsePrompt("second"), "The party rested.");
    assert.equal(flag(calls()[1].args, "--resume"), undefined);

    await client.resetConversation();
    await client.runJsonPrompt("third");
    assert.equal(flag(calls()[2].args, "--resume"), undefined);
  });

  it("throws on an error envelope, a refusal, or a non-zero exit", async () => {
    let { client } = setup([{ is_error: true, subtype: "error", result: "bad" }]);
    await assert.rejects(client.runJsonPrompt("x"), /claude failed \(error\): bad/);

    ({ client } = setup([{ stop_reason: "refusal", result: "no" }]));
    await assert.rejects(client.runJsonPrompt("x"), /declined/);

    ({ client } = setup([{ exit: 2 }]));
    await assert.rejects(client.runJsonPrompt("x"), /exited with code 2: boom/);
  });

  it("records each call's exact input and output in the prompt log", async () => {
    const logDir = path.join(dir, "ai-log");
    fs.mkdirSync(logDir);
    fs.writeFileSync(path.join(logDir, "stale.txt"), "from last run");
    startPromptLog(logDir);
    try {
      const { client } = setup([{ result: "not json" }, { exit: 3 }]);
      await assert.rejects(client.runJsonPrompt("Give me JSON"), /code 3/);
    } finally {
      stopPromptLog();
    }

    assert.ok(!fs.existsSync(path.join(logDir, "stale.txt")));
    const calls = fs.readdirSync(logDir).filter((f) => f !== "index.log").sort();
    assert.equal(calls.length, 2);

    const first = path.join(logDir, calls[0]);
    assert.match(fs.readFileSync(path.join(first, "prompt.txt"), "utf8"), /^Give me JSON/);
    assert.equal(fs.readFileSync(path.join(first, "response.txt"), "utf8"), "not json");
    const firstMeta = JSON.parse(fs.readFileSync(path.join(first, "meta.json"), "utf8"));
    assert.equal(firstMeta.ok, true);
    assert.equal(firstMeta.sessionIdAfter, "session-1");

    const secondMeta = JSON.parse(
      fs.readFileSync(path.join(logDir, calls[1], "meta.json"), "utf8"),
    );
    assert.equal(secondMeta.ok, false);
    assert.equal(secondMeta.sessionIdBefore, "session-1");
    assert.equal(secondMeta.error.stderr, "boom");

    const index = fs.readFileSync(path.join(logDir, "index.log"), "utf8");
    assert.match(index, /ok .*\n.*ERROR .*code 3/);
  });
});
