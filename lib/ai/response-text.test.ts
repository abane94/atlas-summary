import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractJsonText,
  extractProseAnswer,
  isProcessPreamble,
  stripProcessPreamble,
} from "./response-text.js";

describe("stripProcessPreamble", () => {
  it("drops a style-check sentence glued to the real summary", () => {
    const raw =
      "I'll check how earlier session summaries are written so this one matches the project's style.On the seventh day, Walker flew.";
    assert.equal(
      stripProcessPreamble(raw),
      "On the seventh day, Walker flew.",
    );
  });

  it("drops the other session-log preambles", () => {
    assert.equal(
      stripProcessPreamble(
        "I'll check how this project formats session summaries so the paragraph matches that style.The party remains split.",
      ),
      "The party remains split.",
    );
    assert.equal(
      stripProcessPreamble(
        "I'll look at how earlier session summaries are written so this one matches the project's format.After the fight in Carlkin's lighthouse, the door is gone.",
      ),
      "After the fight in Carlkin's lighthouse, the door is gone.",
    );
  });

  it("leaves in-world first person alone", () => {
    const line = "Let me check the lantern. The light became a beacon.";
    assert.equal(isProcessPreamble("Let me check the lantern."), false);
    assert.equal(stripProcessPreamble(line), line);
    assert.equal(
      stripProcessPreamble("I'll check the door for traps. Walker waited."),
      "I'll check the door for traps. Walker waited.",
    );
  });

  it("leaves a normal summary untouched", () => {
    const summary = "On the seventh day, Walker flew with Plymouth.";
    assert.equal(stripProcessPreamble(summary), summary);
  });
});

describe("extractJsonText", () => {
  it("reads JSON after process narration", () => {
    const raw = `I'll check how earlier session summaries are written so this one matches the project's style.

{"summary":"On the seventh day, Walker flew."}`;
    assert.deepEqual(JSON.parse(extractJsonText(raw) ?? ""), {
      summary: "On the seventh day, Walker flew.",
    });
  });

  it("reads a fenced JSON object with text around it", () => {
    const raw = "Here is the result:\n```json\n{\"plotSections\":[]}\n```\nDone.";
    assert.deepEqual(JSON.parse(extractJsonText(raw) ?? ""), {
      plotSections: [],
    });
  });

  it("prefers the larger JSON value over a smaller example", () => {
    const raw = `Example: {"duplicates":[]}
{"duplicates":[{"confidence":90,"reason":"same place"}]}`;
    const parsed = JSON.parse(extractJsonText(raw) ?? "");
    assert.equal(parsed.duplicates.length, 1);
  });
});

describe("extractProseAnswer", () => {
  it("keeps only the answer tag and strips a preamble inside it", () => {
    const raw = `I'll look at the files first.
<answer>
I'll check how this project formats session summaries so the paragraph matches that style.The party remains split.
</answer>
I hope that matches.`;
    assert.equal(extractProseAnswer(raw), "The party remains split.");
  });
});
