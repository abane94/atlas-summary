import type { Page } from "puppeteer-core";
import { runJsonPrompt } from "./chatgpt.js";
import { isDirectRun } from "./is-main.ts";
import { withChatGptPage } from "./browser.js";
import {
    buildTagCatalogPromptSection,
    mergeSuggestedTags,
    parseSuggestedTags,
    validateEntityTags,
    type SuggestedTag,
} from "./entity-tags.ts";
import {
    loadEntityFiles,
    type LoadedEntity,
} from "./vault-data.ts";
import fs from "fs/promises";
import path from "path";

const DESCRIPTION_MAX_CHARS = 240;
const CHATGPT_URL = "https://chatgpt.com";

export interface EntityTagAssignment {
    path: string;
    name: string;
    tags: string[];
}

export interface TagsBackfillResult {
    assignments: EntityTagAssignment[];
    suggestedTags: SuggestedTag[];
}

function cell(value: string): string {
    return value
        .replaceAll("|", "/")
        .replaceAll(/[\r\n]+/g, " ")
        .replaceAll(/\s+/g, " ")
        .trim();
}

function clipDescription(description: string): string {
    const cleaned = cell(description.replace(/^Edit\s*/i, ""));
    if (cleaned.length <= DESCRIPTION_MAX_CHARS) return cleaned;
    return `${cleaned.slice(0, DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`;
}

function typeLabel(type: string): string {
    return (type || "OTHER").toUpperCase();
}

export function buildTagsEntityTable(loaded: LoadedEntity[]): string {
    const sorted = [...loaded].sort((a, b) => {
        const typeCmp = typeLabel(a.entity.type).localeCompare(typeLabel(b.entity.type));
        if (typeCmp !== 0) return typeCmp;
        return a.entity.name.localeCompare(b.entity.name);
    });

    const rows = [
        "| Path | Name | Type | Current Tags | Description |",
        "| --- | --- | --- | --- | --- |",
    ];
    for (const { filepath, entity } of sorted) {
        const tags = entity.tags?.length ? entity.tags.join("; ") : "";
        rows.push(
            `| ${cell(filepath)} | ${cell(entity.name)} | ${cell(typeLabel(entity.type))} | ${cell(tags)} | ${clipDescription(entity.description ?? "")} |`,
        );
    }
    return rows.join("\n");
}

function buildTagsBackfillPrompt(table: string, entityCount: number): string {
    return `
The markdown table below lists ${entityCount} campaign vault entities.
Each row is one entity JSON file. Columns are Path, Name, Type, Current Tags, and a short Description.

${buildTagCatalogPromptSection()}

Assign tags to entities that clearly need them. Prefer 0–3 tags. Skip when nothing fits.
Prefer the closed list. Extra tags only when a real facet is missing.
Do not invent tags for the sake of tagging. Do not use entity types as tags.
If Current Tags already look correct, you may keep them (still return the path).

Return JSON only, matching this interface:
\`\`\`typescript
export interface EntityTagAssignment {
    path: string;   // must be copied exactly from the Path column
    name: string;
    tags: string[]; // 0–3, closed-list preferred
}
export interface SuggestedTag {
    tag: string;
    reason: string;
    exampleEntities: string[];
}
export interface Output {
    assignments: EntityTagAssignment[];
    suggestedTags: SuggestedTag[];
}
\`\`\`
Do not invent paths. Copy Path values exactly from the table.
If no tags apply to any entity, return {"assignments":[],"suggestedTags":[]}.

${table}
`.trim();
}

export function parseTagsBackfillResult(
    raw: string,
    knownPaths: Set<string>,
): TagsBackfillResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`tags backfill response was not valid JSON:\n${raw}`);
    }

    const root =
        parsed && typeof parsed === "object"
            ? (parsed as { assignments?: unknown; suggestedTags?: unknown })
            : {};

    const assignmentsRaw = Array.isArray(root.assignments) ? root.assignments : [];
    const assignments: EntityTagAssignment[] = [];
    const implicit: SuggestedTag[] = [];

    for (const item of assignmentsRaw) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        const entityPath = typeof row.path === "string" ? row.path.trim() : "";
        if (!entityPath) continue;
        if (!knownPaths.has(entityPath)) {
            console.warn(`[tags] Skipping unknown path: ${entityPath}`);
            continue;
        }
        const name = typeof row.name === "string" ? row.name.trim() : "";
        const validated = validateEntityTags(row.tags, { entityName: name });
        assignments.push({
            path: entityPath,
            name,
            tags: validated.tags,
        });
        implicit.push(...validated.implicitSuggestions);
    }

    const suggestedTags = mergeSuggestedTags(
        parseSuggestedTags(root.suggestedTags),
        implicit,
    );

    return { assignments, suggestedTags };
}

export function formatTagsBackfillReport(result: TagsBackfillResult): string {
    const lines: string[] = [];
    lines.push(
        `Tag assignments: ${result.assignments.length} entit${result.assignments.length === 1 ? "y" : "ies"}`,
    );
    lines.push("");
    for (const assignment of result.assignments) {
        const tags = assignment.tags.length ? assignment.tags.join(", ") : "(none)";
        lines.push(`- ${assignment.name || assignment.path}: ${tags}`);
        lines.push(`  ${assignment.path}`);
    }
    if (result.suggestedTags.length > 0) {
        lines.push("");
        lines.push(`Catalog suggestions (${result.suggestedTags.length}):`);
        for (const suggestion of result.suggestedTags) {
            lines.push(
                `- ${suggestion.tag}: ${suggestion.reason || "(no reason)"}` +
                    (suggestion.exampleEntities.length
                        ? ` [${suggestion.exampleEntities.slice(0, 5).join(", ")}]`
                        : ""),
            );
        }
    }
    lines.push("");
    lines.push("JSON:");
    lines.push(JSON.stringify(result, null, 2));
    return lines.join("\n");
}

async function persistTagSuggestionsFile(
    vaultDataFolder: string,
    incoming: SuggestedTag[],
): Promise<void> {
    if (incoming.length === 0) return;
    const filepath = path.join(vaultDataFolder, "tag-suggestions.json");
    let existing: SuggestedTag[] = [];
    try {
        const raw = JSON.parse(await fs.readFile(filepath, "utf8")) as {
            suggestions?: unknown;
        };
        existing = parseSuggestedTags(raw.suggestions ?? raw);
    } catch {
        existing = [];
    }
    const merged = mergeSuggestedTags(existing, incoming);
    await fs.writeFile(
        filepath,
        JSON.stringify(
            {
                updatedAt: new Date().toISOString(),
                suggestions: merged,
            },
            null,
            2,
        ),
    );
    console.log(`[tags] Wrote ${merged.length} suggestion(s) to ${filepath}`);
}

export async function applyTagsBackfill(
    result: TagsBackfillResult,
    loaded: LoadedEntity[],
    vaultDataFolder: string,
): Promise<{ updated: number; skipped: number }> {
    const byPath = new Map(loaded.map((item) => [item.filepath, item]));
    let updated = 0;
    let skipped = 0;

    for (const assignment of result.assignments) {
        const loadedEntity = byPath.get(assignment.path);
        if (!loadedEntity) {
            skipped++;
            continue;
        }
        const nextTags = validateEntityTags(assignment.tags, {
            entityName: assignment.name || loadedEntity.entity.name,
        }).tags;
        const prev = [...(loadedEntity.entity.tags ?? [])].sort().join("\0");
        const next = [...nextTags].sort().join("\0");
        if (prev === next) {
            skipped++;
            continue;
        }
        loadedEntity.entity.tags = nextTags;
        loadedEntity.entity.updatedAt = new Date().toISOString();
        await fs.writeFile(
            loadedEntity.filepath,
            JSON.stringify(loadedEntity.entity, null, 2),
        );
        updated++;
        console.log(
            `[tags] Updated ${loadedEntity.entity.name}: [${nextTags.join(", ")}]`,
        );
    }

    await persistTagSuggestionsFile(vaultDataFolder, result.suggestedTags);
    return { updated, skipped };
}

export async function backfillEntityTags(
    page: Page,
    vaultDataFolder = "vault-data",
): Promise<TagsBackfillResult> {
    const loaded = await loadEntityFiles(vaultDataFolder);
    if (loaded.length === 0) {
        console.log("[tags] No entity files found");
        return { assignments: [], suggestedTags: [] };
    }

    const table = buildTagsEntityTable(loaded);
    const knownPaths = new Set(loaded.map((item) => item.filepath));
    console.log(`[tags] Asking ChatGPT to tag ${loaded.length} entities...`);

    await page.goto(CHATGPT_URL, { waitUntil: "networkidle2", timeout: 60_000 });
    const raw = await runJsonPrompt(page, buildTagsBackfillPrompt(table, loaded.length), 90_000);
    const result = parseTagsBackfillResult(raw, knownPaths);
    const { updated, skipped } = await applyTagsBackfill(result, loaded, vaultDataFolder);
    console.log(`[tags] Wrote tags to ${updated} file(s), skipped ${skipped}`);
    return result;
}

export async function previewTagsEntityTable(vaultDataFolder = "vault-data"): Promise<string> {
    const loaded = await loadEntityFiles(vaultDataFolder);
    const table = buildTagsEntityTable(loaded);
    return `Would send ${loaded.length} entit${loaded.length === 1 ? "y" : "ies"} to ChatGPT for tagging:\n\n${table}`;
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");
    if (dryRun) {
        console.log(await previewTagsEntityTable());
        return;
    }
    await withChatGptPage(async (page: Page) => {
        const result = await backfillEntityTags(page);
        console.log(formatTagsBackfillReport(result));
    });
}

if (isDirectRun(import.meta.url)) {
    main();
}
