import fs from "fs";
import path from "path";
import type { AiPool } from "./ai.js";
import { checkChunkSummary } from "./chunk-summary.ts";
import { generateSessionData, mergeSessionData } from "./session-data-gen.ts";
import {
  divideTranscriptIntoChunks,
  generateTranscriptChunks,
  loadTranscript,
} from "./transcript.js";
import { ENTITY_TYPE_FOLDER_NAMES } from "./vault-data.ts";

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const PROCESS_STEPS = ["chunks", "merge"] as const;
export const PIPELINE_STEPS = [...PROCESS_STEPS, "vault"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export function summariesDir(date: string): string {
  return path.join("summaries", date);
}

export function mergedJsonPath(date: string): string {
  return path.join(summariesDir(date), "merged.json");
}

export function summaryChunkPath(date: string, index: number): string {
  return path.join(summariesDir(date), `summary-${index}.json`);
}

export function transcriptDir(date: string): string {
  return path.join("transcripts", date);
}

export function recapMarkdownPath(date: string): string {
  return path.join(transcriptDir(date), "recap.md");
}

export function transcriptMarkdownPath(date: string): string {
  return path.join(transcriptDir(date), "transcript.md");
}

export function isSessionDate(name: string): boolean {
  return DATE_RE.test(name);
}

export function listDatedFolders(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isSessionDate(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function latestTranscriptDate(): string | undefined {
  const dates = listDatedFolders("transcripts");
  return dates.at(-1);
}

export function ensureSummariesFolder(date: string): void {
  fs.mkdirSync(summariesDir(date), { recursive: true });
}

export function ensureTranscripts(date: string): void {
  const transcriptPath = transcriptMarkdownPath(date);
  if (!fs.existsSync(transcriptPath)) {
    throw new Error(
      `Missing transcript file for ${date}:\n  ${transcriptPath}\n\nAdd transcript.md under transcripts/${date}/ first.`,
    );
  }
}

function countExistingChunks(date: string): number {
  const dir = summariesDir(date);
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir)
    .filter((name) => /^summary-\d+\.json$/.test(name)).length;
}

function expectedChunkCount(date: string): number | null {
  const transcriptPath = transcriptMarkdownPath(date);
  if (!fs.existsSync(transcriptPath)) return null;
  const transcript = fs.readFileSync(transcriptPath, "utf8");
  return divideTranscriptIntoChunks(transcript).length;
}

export interface SessionStatus {
  date: string;
  recapMd: boolean;
  transcriptMd: boolean;
  chunksDone: number;
  chunksExpected: number | null;
  mergedJson: boolean;
  vaultLog: boolean;
}

export function getSessionStatus(date: string): SessionStatus {
  return {
    date,
    recapMd: fs.existsSync(recapMarkdownPath(date)),
    transcriptMd: fs.existsSync(transcriptMarkdownPath(date)),
    chunksDone: countExistingChunks(date),
    chunksExpected: expectedChunkCount(date),
    mergedJson: fs.existsSync(mergedJsonPath(date)),
    vaultLog: fs.existsSync(path.join("vault-data", "log", `${date}.json`)),
  };
}

export function formatSessionStatus(status: SessionStatus): string {
  const chunkPart =
    status.chunksExpected == null
      ? `${status.chunksDone}/?`
      : `${status.chunksDone}/${status.chunksExpected}`;
  const chunks =
    status.chunksExpected != null &&
    status.chunksDone >= status.chunksExpected &&
    status.chunksExpected > 0
      ? `✓ ${chunkPart}`
      : chunkPart;
  const merge = status.mergedJson ? "✓" : "✗";
  const vault = status.vaultLog ? "✓" : "✗";
  const inputs =
    status.recapMd && status.transcriptMd
      ? ""
      : `  (missing ${[
          !status.recapMd ? "recap.md" : null,
          !status.transcriptMd ? "transcript.md" : null,
        ]
          .filter(Boolean)
          .join(", ")})`;
  return `${status.date}  chunks ${chunks}  merge ${merge}  vault ${vault}${inputs}`;
}

function buildExistingEntitiesTable(): string {
  const rows: string[] = [];
  for (const folder of ENTITY_TYPE_FOLDER_NAMES) {
    const typeDir = path.join("vault-data", folder);
    if (!fs.existsSync(typeDir)) continue;
    for (const filename of fs.readdirSync(typeDir)) {
      if (!filename.endsWith(".json")) continue;
      const entity = JSON.parse(
        fs.readFileSync(path.join(typeDir, filename), "utf8"),
      ) as { name?: string; type?: string; slug?: string };
      rows.push(
        `| ${entity.name ?? filename} | ${entity.type ?? ""} | ${entity.slug ?? ""} |`,
      );
    }
  }
  return ["| Name | Type | Slug |", "|------|------|------|", ...rows].join("\n");
}

export function buildRecapPrompt(): string {
  const template = fs.readFileSync("prompts/recap-prompt.md", "utf8");
  const section = `## Existing entites, concepts, NPCs, locations, items

${buildExistingEntitiesTable()}`;
  if (template.includes("## Existing entites, concepts, NPCs, locations, items")) {
    return template.replace(
      "## Existing entites, concepts, NPCs, locations, items",
      section,
    );
  }
  return `${template}\n\n${section}`;
}

function toPromptHtml(text: string): string {
  return text.replaceAll("\n", "<br/>");
}

export function chunksNeedWork(date: string, force: boolean): boolean {
  if (force) return true;
  const expected = expectedChunkCount(date);
  if (expected == null) return true;
  return countExistingChunks(date) < expected;
}

export function mergeNeedsWork(date: string, force: boolean): boolean {
  return force || !fs.existsSync(mergedJsonPath(date));
}

const SHAPE_ATTEMPTS = 3;

export interface ChunkShapeRetry {
  file: string;
  attempts: number;
  recovered: boolean;
  problems: string[];
}

function shapeRetryLogPath(date: string): string {
  return path.join(summariesDir(date), "shape-retries.json");
}

function recordShapeRetries(date: string, retried: ChunkShapeRetry[]): void {
  const logPath = shapeRetryLogPath(date);
  if (retried.length === 0) {
    if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
    console.log("[chunks] Shape check: no retries");
    return;
  }
  fs.writeFileSync(logPath, `${JSON.stringify({ date, retried }, null, 2)}\n`);
  const recovered = retried.filter((entry) => entry.recovered).length;
  const failed = retried.length - recovered;
  console.warn(
    `[chunks] Shape check: ${recovered} retried and recovered, ${failed} still invalid. See ${logPath}`,
  );
}

const SHAPE_RETRY_PROMPT = (problems: string[]) =>
  [
    "The previous JSON is not a SessionChunkSummary.",
    `Problems: ${problems.join("; ")}.`,
    "Return one JSON object with these keys: plotSections, chronologicalEvents, entities, misTranscriptions, openQuestions, newTerms.",
    "Put character and item updates under entities. Do not return the entities object by itself.",
  ].join(" ");

export async function generateChunks(
  pool: AiPool,
  date: string,
  options: { force?: boolean } = {},
): Promise<"wrote" | "skipped"> {
  ensureTranscripts(date);
  ensureSummariesFolder(date);

  const recapPath = recapMarkdownPath(date);
  if (!fs.existsSync(recapPath)) {
    console.warn(`[chunks] Warning: ${recapPath} is missing, skipping recap input`);
  }

  const recapPrompt = buildRecapPrompt();
  const { transcript } = await loadTranscript(date);
  const expected = divideTranscriptIntoChunks(transcript).length;
  let skipped = 0;
  let index = 0;
  const pending: { index: number; fileName: string; chunk: string }[] = [];

  for (const chunk of generateTranscriptChunks(transcript)) {
    const fileName = summaryChunkPath(date, index);
    if (!options.force && fs.existsSync(fileName)) {
      console.log(`[chunks] ${fileName} already exists, skipping...`);
      skipped++;
    } else {
      pending.push({ index, fileName, chunk });
    }
    index++;
  }

  console.log(
    `[chunks] Generating summaries for ${date} (${pending.length} of ${expected} chunks, ${pool.size} at a time)...`,
  );
  if (pending.length === 0) {
    console.log(`[chunks] All ${skipped} chunk summaries already exist`);
    return "skipped";
  }

  const shapeRetries: ChunkShapeRetry[] = [];
  let wrote = 0;
  let started = 0;
  let finished = 0;

  try {
    await pool.map(pending, async (job, ai) => {
      const startedAt = ++started;
      console.log(
        `[chunks] Generating ${job.fileName} (started ${startedAt}, finished ${finished} of ${pending.length})`,
      );
      const aiPrompt = `
  # Input
  This is ${job.index ? "a" : "the first"} sub- section of the DND session.
  <br/>
  <br/>
  ${toPromptHtml(recapPrompt)}
  <br/>
  <br/>

  ${job.chunk.replaceAll("\n", "<br/>")}
  `;
      let summary = await ai.runJsonPrompt(aiPrompt, { effort: "low" });
      let check = checkChunkSummary(summary);
      let attempts = 1;
      const firstProblems = check.ok ? [] : check.problems;
      while (!check.ok && attempts < SHAPE_ATTEMPTS) {
        console.warn(
          `[chunks] ${job.fileName} failed shape check (attempt ${attempts}/${SHAPE_ATTEMPTS}): ${check.problems.join("; ")}`,
        );
        summary = await ai.runJsonPrompt(SHAPE_RETRY_PROMPT(check.problems), {
          effort: "low",
          timeout: 0,
        });
        attempts++;
        check = checkChunkSummary(summary);
      }
      if (attempts > 1) {
        shapeRetries.push({
          file: path.basename(job.fileName),
          attempts,
          recovered: check.ok,
          problems: firstProblems,
        });
      }
      if (!check.ok) {
        throw new Error(
          `${job.fileName} is not a SessionChunkSummary after ${attempts} attempts:\n- ${check.problems.join("\n- ")}`,
        );
      }
      fs.writeFileSync(job.fileName, summary);
      wrote++;
      finished++;
      console.log(
        `[chunks] Wrote ${job.fileName} (started ${started}, finished ${finished} of ${pending.length})`,
      );
    });
  } catch (error) {
    if (shapeRetries.length > 0) recordShapeRetries(date, shapeRetries);
    throw error;
  }

  recordShapeRetries(date, shapeRetries);
  console.log(`[chunks] Wrote ${wrote} chunk(s), skipped ${skipped}`);
  return "wrote";
}

export async function generateMerged(
  pool: AiPool,
  date: string,
  options: { force?: boolean } = {},
): Promise<"wrote" | "skipped"> {
  const outPath = mergedJsonPath(date);
  if (!options.force && fs.existsSync(outPath)) {
    console.log(`[merge] ${outPath} already exists, skipping (use --force to redo)`);
    return "skipped";
  }

  if (countExistingChunks(date) === 0) {
    throw new Error(
      `Cannot merge ${date}: no summary-*.json files in ${summariesDir(date)}. Run the chunks step first.`,
    );
  }

  ensureSummariesFolder(date);
  console.log(`[merge] Merging chunk summaries for ${date} (${pool.size} at a time)...`);
  const allData = await generateSessionData(date);
  const mergedData = await mergeSessionData(pool, allData);
  fs.writeFileSync(outPath, JSON.stringify(mergedData, null, 2));
  console.log(`[merge] Wrote ${outPath}`);
  return "wrote";
}
