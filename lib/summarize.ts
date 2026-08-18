import fs from "fs";
import path from "path";
import type { Page } from "puppeteer-core";
import { runJsonPrompt } from "./chatgpt.js";
import { generateSessionData, mergeSessionData } from "./session-data-gen.ts";
import {
  divideTranscriptIntoChunks,
  generateTranscriptChunks,
  loadTranscript,
} from "./transcript.js";

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const PROCESS_STEPS = ["recap", "chunks", "merge"] as const;
export const PIPELINE_STEPS = [...PROCESS_STEPS, "vault"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

const CHATGPT_URL = "https://chatgpt.com";

export function summariesDir(date: string): string {
  return path.join("summaries", date);
}

export function recapJsonPath(date: string): string {
  return path.join(summariesDir(date), "recap.json");
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
  const recapPath = recapMarkdownPath(date);
  const transcriptPath = transcriptMarkdownPath(date);
  const missing: string[] = [];
  if (!fs.existsSync(recapPath)) missing.push(recapPath);
  if (!fs.existsSync(transcriptPath)) missing.push(transcriptPath);
  if (missing.length > 0) {
    throw new Error(
      `Missing transcript files for ${date}:\n  ${missing.join("\n  ")}\n\nAdd recap.md and transcript.md under transcripts/${date}/ first.`,
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
  recapJson: boolean;
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
    recapJson: fs.existsSync(recapJsonPath(date)),
    chunksDone: countExistingChunks(date),
    chunksExpected: expectedChunkCount(date),
    mergedJson: fs.existsSync(mergedJsonPath(date)),
    vaultLog: fs.existsSync(path.join("vault-data", "log", `${date}.json`)),
  };
}

export function formatSessionStatus(status: SessionStatus): string {
  const recap = status.recapJson ? "✓" : "✗";
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
  return `${status.date}  recap ${recap}  chunks ${chunks}  merge ${merge}  vault ${vault}${inputs}`;
}

function buildExistingEntitiesTable(): string {
  const entitiesDir = path.join("vault-data", "entities");
  const rows =
    fs.existsSync(entitiesDir)
      ? fs
          .readdirSync(entitiesDir)
          .filter((name) => name.endsWith(".json"))
          .map((filename) => {
            const entity = JSON.parse(
              fs.readFileSync(path.join(entitiesDir, filename), "utf8"),
            ) as { name?: string; type?: string; slug?: string };
            return `| ${entity.name ?? filename} | ${entity.type ?? ""} | ${entity.slug ?? ""} |`;
          })
      : [];
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

export function recapNeedsWork(date: string, force: boolean): boolean {
  return force || !fs.existsSync(recapJsonPath(date));
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

export async function generateRecap(
  page: Page,
  date: string,
  options: { force?: boolean } = {},
): Promise<"wrote" | "skipped"> {
  const outPath = recapJsonPath(date);
  if (!options.force && fs.existsSync(outPath)) {
    console.log(`[recap] ${outPath} already exists, skipping (use --force to redo)`);
    return "skipped";
  }

  ensureTranscripts(date);
  ensureSummariesFolder(date);

  const recapPrompt = buildRecapPrompt();
  const { recap } = await loadTranscript(date);
  const aiPrompt = `
# Input
This is section is a recap of the DND session.
<br/>
<br/>
${toPromptHtml(recapPrompt)}
<br/>
<br/>

${toPromptHtml(recap)}
`;

  console.log(`[recap] Generating ${outPath} ...`);
  const recapSummary = await runJsonPrompt(page, aiPrompt);
  fs.writeFileSync(outPath, recapSummary);
  console.log(`[recap] Wrote ${outPath}`);
  return "wrote";
}

export async function generateChunks(
  page: Page,
  date: string,
  options: { force?: boolean } = {},
): Promise<"wrote" | "skipped"> {
  ensureTranscripts(date);
  ensureSummariesFolder(date);

  const recapPrompt = buildRecapPrompt();
  const { transcript } = await loadTranscript(date);
  const expected = divideTranscriptIntoChunks(transcript).length;
  let wrote = 0;
  let skipped = 0;
  let i = 0;

  console.log(`[chunks] Generating summaries for ${date} (${expected} chunks)...`);
  await page.goto(CHATGPT_URL, { waitUntil: "networkidle2" });

  for (const chunk of generateTranscriptChunks(transcript)) {
    const fileName = summaryChunkPath(date, i);
    if (!options.force && fs.existsSync(fileName)) {
      console.log(`[chunks] ${fileName} already exists, skipping...`);
      skipped++;
      i++;
      continue;
    }
    console.log(`[chunks] Generating ${fileName} ...`);
    const aiPrompt = `
  # Input
  This is ${i ? "a" : "the first"} sub- section of the DND session.
  <br/>
  <br/>
  ${toPromptHtml(recapPrompt)}
  <br/>
  <br/>

  ${chunk.replaceAll("\n", "<br/>")}
  `;
    const summary = await runJsonPrompt(page, aiPrompt);
    fs.writeFileSync(fileName, summary);
    wrote++;
    await page.goto(CHATGPT_URL, { waitUntil: "networkidle2" });
    i++;
  }

  if (wrote === 0) {
    console.log(`[chunks] All ${skipped} chunk summaries already exist`);
    return "skipped";
  }
  console.log(`[chunks] Wrote ${wrote} chunk(s), skipped ${skipped}`);
  return "wrote";
}

export async function generateMerged(
  page: Page,
  date: string,
  options: { force?: boolean } = {},
): Promise<"wrote" | "skipped"> {
  const outPath = mergedJsonPath(date);
  if (!options.force && fs.existsSync(outPath)) {
    console.log(`[merge] ${outPath} already exists, skipping (use --force to redo)`);
    return "skipped";
  }

  if (!fs.existsSync(recapJsonPath(date))) {
    throw new Error(
      `Cannot merge ${date}: missing ${recapJsonPath(date)}. Run the recap step first.`,
    );
  }
  if (countExistingChunks(date) === 0) {
    throw new Error(
      `Cannot merge ${date}: no summary-*.json files in ${summariesDir(date)}. Run the chunks step first.`,
    );
  }

  ensureSummariesFolder(date);
  console.log(`[merge] Merging recap + chunk summaries for ${date} ...`);
  const allData = await generateSessionData(date);
  const mergedData = await mergeSessionData(page, allData);
  fs.writeFileSync(outPath, JSON.stringify(mergedData, null, 2));
  console.log(`[merge] Wrote ${outPath}`);
  return "wrote";
}
