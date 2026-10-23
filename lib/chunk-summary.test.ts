import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkChunkSummary, chunkSummaryProblems } from "./chunk-summary.ts";

function entity(name = "Sylan") {
  return {
    [name]: {
      existing: "",
      entityType: "PLAYER",
      notes: [],
      titles: [],
      personality: [],
      quotesThemes: [],
      openQuestions: [],
    },
  };
}

function validSummary() {
  return {
    plotSections: [{ title: "Opening", bullets: ["The lantern blinded Gerk."] }],
    chronologicalEvents: ["1. They tested the lantern."],
    entities: entity(),
    misTranscriptions: [],
    openQuestions: [],
    newTerms: [],
  };
}

describe("chunkSummaryProblems", () => {
  it("accepts a chunk with the merge fields", () => {
    assert.deepEqual(chunkSummaryProblems(validSummary()), []);
  });

  it("rejects an entity map sitting at the top level", () => {
    const problems = chunkSummaryProblems(entity("Fused lantern-staff"));
    assert.ok(problems.some((problem) => problem.includes("plotSections")));
    assert.ok(problems.some((problem) => problem.includes("chronologicalEvents")));
    assert.ok(problems.some((problem) => problem.includes("entities must be an object")));
  });

  it("rejects an entity that is missing the arrays merge spreads", () => {
    const summary = validSummary();
    summary.entities.Sylan = { existing: "", entityType: "PLAYER", notes: [] } as typeof summary.entities.Sylan;
    const problems = chunkSummaryProblems(summary);
    assert.ok(problems.some((problem) => problem.includes(".titles")));
  });
});

describe("checkChunkSummary", () => {
  it("parses a valid payload", () => {
    const result = checkChunkSummary(JSON.stringify(validSummary()));
    assert.equal(result.ok, true);
  });

  it("reports invalid JSON", () => {
    const result = checkChunkSummary("{");
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.problems[0], /invalid JSON/);
  });
});
