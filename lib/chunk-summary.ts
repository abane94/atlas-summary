import type { SessionChunkSummary } from "./types/session.ts";

const ENTITY_ARRAY_FIELDS = [
  "notes",
  "titles",
  "personality",
  "quotesThemes",
  "openQuestions",
] as const;

const PROBLEM_LIMIT = 8;

export type ChunkSummaryCheck =
  | { ok: true; summary: SessionChunkSummary }
  | { ok: false; problems: string[] };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Fields the merge step reads. A bare entity map (the chunk-0 failure) fails here.
 * Returns at most a few problems so a retry prompt stays short.
 */
export function chunkSummaryProblems(value: unknown): string[] {
  const problems: string[] = [];
  const push = (problem: string) => {
    if (problems.length < PROBLEM_LIMIT) problems.push(problem);
  };

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["response was not a JSON object"];
  }
  const obj = value as Record<string, unknown>;

  if (!Array.isArray(obj.plotSections)) {
    push("plotSections must be an array");
  } else {
    obj.plotSections.forEach((section, index) => {
      if (!section || typeof section !== "object" || Array.isArray(section)) {
        push(`plotSections[${index}] must be an object`);
        return;
      }
      const row = section as Record<string, unknown>;
      if (typeof row.title !== "string") push(`plotSections[${index}].title must be a string`);
      if (!isStringArray(row.bullets)) {
        push(`plotSections[${index}].bullets must be an array of strings`);
      }
    });
  }

  if (!isStringArray(obj.chronologicalEvents)) {
    push("chronologicalEvents must be an array of strings");
  }

  if (!obj.entities || typeof obj.entities !== "object" || Array.isArray(obj.entities)) {
    push("entities must be an object keyed by name");
  } else {
    for (const [name, entity] of Object.entries(obj.entities)) {
      if (!entity || typeof entity !== "object" || Array.isArray(entity)) {
        push(`entities[${JSON.stringify(name)}] must be an object`);
        continue;
      }
      const row = entity as Record<string, unknown>;
      for (const field of ENTITY_ARRAY_FIELDS) {
        if (!Array.isArray(row[field])) {
          push(`entities[${JSON.stringify(name)}].${field} must be an array`);
        }
      }
    }
  }

  if (!Array.isArray(obj.misTranscriptions)) push("misTranscriptions must be an array");
  if (!isStringArray(obj.openQuestions)) push("openQuestions must be an array of strings");

  if (!Array.isArray(obj.newTerms)) {
    push("newTerms must be an array");
  } else {
    obj.newTerms.forEach((term, index) => {
      if (!term || typeof term !== "object" || Array.isArray(term)) {
        push(`newTerms[${index}] must be an object`);
        return;
      }
      const row = term as Record<string, unknown>;
      if (typeof row.name !== "string") push(`newTerms[${index}].name must be a string`);
      if (!Array.isArray(row.notes)) push(`newTerms[${index}].notes must be an array`);
    });
  }

  return problems;
}

export function checkChunkSummary(raw: string): ChunkSummaryCheck {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [`invalid JSON: ${message}`] };
  }
  const problems = chunkSummaryProblems(value);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, summary: value as SessionChunkSummary };
}
