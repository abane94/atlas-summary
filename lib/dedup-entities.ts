import type { Page } from "puppeteer-core";
import fs from "fs/promises";
import path from "path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runJsonPrompt } from "./chatgpt.js";
import { isDirectRun } from "./is-main.ts";
import { withChatGptPage } from "./browser.js";
import { unionTags, validateEntityTags } from "./entity-tags.ts";
import {
    entityJsonFilename,
    entityMarkdownFilename,
    loadEntityFiles,
    normalizeEntityType,
    saveEntity,
    withNormalizedAliases,
    type EntityData,
    type EntityType,
    type LoadedEntity,
} from "./vault-data.ts";

const DESCRIPTION_MAX_CHARS = 240;
const CHATGPT_URL = "https://chatgpt.com";

export interface DuplicateEntityRef {
    path: string;
    name: string;
    type: string;
}

export interface DuplicateGroup {
    entities: DuplicateEntityRef[];
    /** Likelihood these records are the same entity, 0–100. */
    confidence: number;
    /** Why they look like the same thing (shorter vs longer name, overlapping description, etc.). */
    reason: string;
    /** Preferred name if they were merged. */
    suggestedCanonicalName?: string;
    /** Preferred JSON path to keep if they were merged. */
    suggestedCanonicalPath?: string;
}

export interface DedupResult {
    duplicates: DuplicateGroup[];
}

export interface ApprovedMerge {
    paths: string[];
    canonicalName: string;
    canonicalType: EntityType;
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

export function buildEntityTable(loaded: LoadedEntity[]): string {
    const sorted = [...loaded].sort((a, b) => {
        const typeCmp = typeLabel(a.entity.type).localeCompare(typeLabel(b.entity.type));
        if (typeCmp !== 0) return typeCmp;
        return a.entity.name.localeCompare(b.entity.name);
    });

    const rows = [
        "| Path | Name | Aliases | Type | Description |",
        "| --- | --- | --- | --- | --- |",
    ];
    for (const { filepath, entity } of sorted) {
        const aliases = entity.aliases?.length ? entity.aliases.join("; ") : "";
        rows.push(
            `| ${cell(filepath)} | ${cell(entity.name)} | ${cell(aliases)} | ${cell(typeLabel(entity.type))} | ${clipDescription(entity.description ?? "")} |`,
        );
    }
    return rows.join("\n");
}

function asString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function asConfidence(value: unknown): number {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return 0;
    const scaled = n > 0 && n <= 1 ? n * 100 : n;
    return Math.max(0, Math.min(100, Math.round(scaled)));
}

function parseDuplicateGroup(raw: unknown, knownPaths: Set<string>): DuplicateGroup | null {
    if (!raw || typeof raw !== "object") return null;
    const group = raw as Record<string, unknown>;
    const entitiesRaw = Array.isArray(group.entities) ? group.entities : [];
    const entities: DuplicateEntityRef[] = [];
    for (const item of entitiesRaw) {
        if (!item || typeof item !== "object") continue;
        const ref = item as Record<string, unknown>;
        const entityPath = asString(ref.path);
        if (!entityPath) continue;
        entities.push({
            path: entityPath,
            name: asString(ref.name),
            type: asString(ref.type),
        });
    }
    if (entities.length < 2) return null;

    const unknown = entities.filter((entity) => !knownPaths.has(entity.path));
    if (unknown.length > 0) {
        console.warn(
            `[dedup] Skipping group with unknown path(s): ${unknown.map((entity) => entity.path).join(", ")}`,
        );
        return null;
    }

    return {
        entities,
        confidence: asConfidence(group.confidence),
        reason: asString(group.reason),
        suggestedCanonicalName: asString(group.suggestedCanonicalName) || undefined,
        suggestedCanonicalPath: asString(group.suggestedCanonicalPath) || undefined,
    };
}

export function parseDedupResult(raw: string, knownPaths: Set<string>): DedupResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`dedup response was not valid JSON:\n${raw}`);
    }

    const root =
        parsed && typeof parsed === "object" && Array.isArray((parsed as { duplicates?: unknown }).duplicates)
            ? (parsed as { duplicates: unknown[] })
            : Array.isArray(parsed)
              ? { duplicates: parsed }
              : { duplicates: [] };

    const duplicates = root.duplicates
        .map((group) => parseDuplicateGroup(group, knownPaths))
        .filter((group): group is DuplicateGroup => group !== null)
        .sort((a, b) => b.confidence - a.confidence);

    return { duplicates };
}

function buildDedupPrompt(table: string, entityCount: number): string {
    return `
The markdown table below lists ${entityCount} campaign vault entities.
Each row is one entity JSON file. Columns are Path (the file to keep or merge), Name, Aliases, Type, and a short Description.

These records were extracted from session transcripts, so the same person/place/item/concept often appears more than once under a shorter name, a longer name, a nickname, or a slight spelling variant.

Please find groups of rows that are likely the SAME entity. Typical cases:
- a short name vs a longer name ("Training Grounds" vs "Dragon Rider Training Grounds")
- a generic name vs a more specific one ("Gate" vs "Gate spell")
- spelling or spacing variants
- an alias on one row matching the name of another

Do NOT group entities that merely share a word or theme if they are distinct (e.g. "Gate" vs "Gatehouse", or two NPCs who happen to have similar first names). Prefer same type, but different types can still be duplicates if the descriptions clearly match.

Return JSON only, matching this interface:
\`\`\`typescript
export interface DuplicateEntityRef {
    path: string;   // must be copied exactly from the Path column
    name: string;
    type: string;
}
export interface DuplicateGroup {
    entities: DuplicateEntityRef[]; // at least 2
    confidence: number;             // 0-100, how sure you are they are the same entity
    reason: string;                 // brief explanation
    suggestedCanonicalName?: string;
    suggestedCanonicalPath?: string;
}
export interface Output {
    duplicates: DuplicateGroup[];
}
\`\`\`
If nothing looks like a duplicate, return {"duplicates":[]}.
Do not invent paths. Copy Path values exactly from the table.

${table}
`.trim();
}

export function formatDuplicateGroup(group: DuplicateGroup, index: number): string {
    const lines: string[] = [];
    const names = group.entities.map((entity) => entity.name || entity.path).join("  ≈  ");
    lines.push(`${index + 1}. ${group.confidence}%  ${names}`);
    for (const entity of group.entities) {
        const type = entity.type ? ` [${entity.type}]` : "";
        lines.push(`   - ${entity.path}${type}${entity.name ? `  (${entity.name})` : ""}`);
    }
    if (group.reason) {
        lines.push(`   reason: ${group.reason}`);
    }
    if (group.suggestedCanonicalName || group.suggestedCanonicalPath) {
        const keep = [group.suggestedCanonicalName, group.suggestedCanonicalPath].filter(Boolean).join(" — ");
        lines.push(`   suggested keep: ${keep}`);
    }
    return lines.join("\n");
}

export function formatDedupReport(result: DedupResult): string {
    const lines: string[] = [];
    if (result.duplicates.length === 0) {
        lines.push("No likely duplicate entities found.");
        return lines.join("\n");
    }

    lines.push(`Likely duplicate entities (${result.duplicates.length} group${result.duplicates.length === 1 ? "" : "s"}):`);
    lines.push("");

    result.duplicates.forEach((group, index) => {
        lines.push(formatDuplicateGroup(group, index));
        lines.push("");
    });

    lines.push("JSON:");
    lines.push(JSON.stringify(result, null, 2));
    return lines.join("\n");
}

export async function findDuplicateEntities(
    page: Page,
    vaultDataFolder = "vault-data",
): Promise<DedupResult> {
    const loaded = await loadEntityFiles(vaultDataFolder);
    if (loaded.length === 0) {
        console.log("[dedup] No entity files found");
        return { duplicates: [] };
    }

    const table = buildEntityTable(loaded);
    const knownPaths = new Set(loaded.map((item) => item.filepath));
    console.log(`[dedup] Asking ChatGPT to review ${loaded.length} entities...`);

    await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const raw = await runJsonPrompt(page, buildDedupPrompt(table, loaded.length), 60_000);
    return parseDedupResult(raw, knownPaths);
}

export async function previewEntityTable(vaultDataFolder = "vault-data"): Promise<string> {
    const loaded = await loadEntityFiles(vaultDataFolder);
    const table = buildEntityTable(loaded);
    return `Would send ${loaded.length} entit${loaded.length === 1 ? "y" : "ies"} to ChatGPT:\n\n${table}`;
}

function longestName(names: string[]): string {
    return [...names].sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? "";
}

function suggestedCanonicalName(group: DuplicateGroup): string {
    if (group.suggestedCanonicalName) return group.suggestedCanonicalName;
    return longestName(group.entities.map((entity) => entity.name).filter(Boolean));
}

function suggestedCanonicalType(group: DuplicateGroup): EntityType {
    if (group.suggestedCanonicalPath) {
        const match = group.entities.find((entity) => entity.path === group.suggestedCanonicalPath);
        if (match?.type) {
            try {
                return normalizeEntityType(match.type);
            } catch {
                // fall through
            }
        }
    }
    const types = group.entities.map((entity) => {
        try {
            return normalizeEntityType(entity.type || "OTHER");
        } catch {
            return "OTHER" as EntityType;
        }
    });
    return types[0] ?? "OTHER";
}

function uniqueStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

export async function reviewDuplicateGroups(
    groups: DuplicateGroup[],
): Promise<ApprovedMerge[]> {
    if (groups.length === 0) return [];

    const rl = readline.createInterface({ input, output });
    const approved: ApprovedMerge[] = [];

    try {
        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            console.log("");
            console.log(formatDuplicateGroup(group, i));
            console.log(`(${i + 1}/${groups.length})`);

            const answer = (await rl.question("Dedup this group? [y/n/q] ")).trim().toLowerCase();
            if (answer === "q" || answer === "quit") {
                console.log("[dedup] Quit — no further groups will be merged.");
                break;
            }
            if (answer !== "y" && answer !== "yes") {
                console.log("[dedup] Skipped.");
                continue;
            }

            const nameDefault = suggestedCanonicalName(group);
            const nameAnswer = (await rl.question(`Canonical name [${nameDefault}]: `)).trim();
            const canonicalName = nameAnswer || nameDefault;
            if (!canonicalName) {
                console.log("[dedup] No canonical name; skipping group.");
                continue;
            }

            const distinctTypes = uniqueStrings(
                group.entities.map((entity) => typeLabel(entity.type || "OTHER")),
            );
            let canonicalType = suggestedCanonicalType(group);
            if (distinctTypes.length > 1) {
                console.log(
                    `[dedup] Types differ: ${distinctTypes.join(", ")}. Filename uses type--name.`,
                );
                const typeAnswer = (
                    await rl.question(`Canonical type [${canonicalType}]: `)
                ).trim();
                if (typeAnswer) {
                    try {
                        canonicalType = normalizeEntityType(typeAnswer);
                    } catch (error) {
                        console.log(error instanceof Error ? error.message : error);
                        console.log("[dedup] Invalid type; skipping group.");
                        continue;
                    }
                }
            }

            approved.push({
                paths: group.entities.map((entity) => entity.path),
                canonicalName,
                canonicalType,
            });
            console.log(
                `[dedup] Queued merge → ${canonicalType} "${canonicalName}" (${approved.length} pending)`,
            );
        }
    } finally {
        rl.close();
    }

    return approved;
}

function collectAliases(members: EntityData[], canonicalName: string): string[] {
    const aliases: string[] = [];
    for (const member of members) {
        if (member.name !== canonicalName) aliases.push(member.name);
        for (const alias of member.aliases ?? []) {
            if (alias !== canonicalName) aliases.push(alias);
        }
    }
    return uniqueStrings(aliases);
}

function earliestIso(...values: string[]): string {
    const valid = values.filter(Boolean).sort();
    return valid[0] ?? new Date().toISOString();
}

function buildMergePrompt(
    members: EntityData[],
    merge: ApprovedMerge,
    aliases: string[],
): string {
    return `
You are merging duplicate campaign vault entity JSON records into one.

Canonical name: ${JSON.stringify(merge.canonicalName)}
Canonical type: ${JSON.stringify(merge.canonicalType)}
Aliases to keep (unused names + existing aliases; do not invent new ones): ${JSON.stringify(aliases)}

Merge rules:
- Combine description into one accurate paragraph. Do not invent facts.
- Combine slug into one short plain-text phrase.
- Merge log entries by date: one entry per date with a single summary and deduplicated notes.
- Union openQuestions (unique strings). Union tags (0–3 preferred).
- Preserve original spellings in aliases.

Return JSON only matching EntityData (fields below). name/type/aliases/filename/createdAt/updatedAt will be overwritten by code — still fill them reasonably.
\`\`\`typescript
export interface EntityData {
    slug: string;
    name: string;
    tags: string[];
    aliases: string[];
    filename: string;
    description: string;
    type: string;
    log: { date: string; summary: string; notes: string[] }[];
    openQuestions: string[];
    linkTargets: string[];
    createdAt: string;
    updatedAt: string;
}
\`\`\`

Source entities:
${JSON.stringify(members, null, 2)}
`.trim();
}

function parseMergedEntity(raw: string): Partial<EntityData> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`merge response was not valid JSON:\n${raw}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`merge response must be an EntityData object:\n${raw}`);
    }
    return parsed as Partial<EntityData>;
}

function stampMergedEntity(
    ai: Partial<EntityData>,
    merge: ApprovedMerge,
    members: EntityData[],
    aliases: string[],
): EntityData {
    const validated = validateEntityTags(
        unionTags(
            members.flatMap((member) => member.tags ?? []),
            ai.tags ?? [],
        ),
        { entityName: merge.canonicalName },
    );

    const openQuestions = uniqueStrings([
        ...members.flatMap((member) => member.openQuestions ?? []),
        ...(Array.isArray(ai.openQuestions) ? ai.openQuestions.filter((q): q is string => typeof q === "string") : []),
    ]);

    const linkTargets = uniqueStrings([
        ...members.flatMap((member) => member.linkTargets ?? []),
        ...(Array.isArray(ai.linkTargets) ? ai.linkTargets.filter((t): t is string => typeof t === "string") : []),
    ]);

    const stamped: EntityData = {
        name: merge.canonicalName,
        type: merge.canonicalType,
        aliases,
        normalizedAliases: [],
        tags: validated.tags,
        slug: asString(ai.slug) || longestName(members.map((m) => m.slug).filter(Boolean)) || merge.canonicalName,
        description: asString(ai.description) || members.map((m) => m.description).filter(Boolean).join(" "),
        filename: entityMarkdownFilename({
            name: merge.canonicalName,
            type: merge.canonicalType,
        }),
        log: Array.isArray(ai.log) && ai.log.length > 0
            ? ai.log
                .filter((entry): entry is EntityData["log"][number] =>
                    Boolean(entry && typeof entry === "object" && typeof (entry as { date?: unknown }).date === "string"),
                )
                .map((entry) => ({
                    date: entry.date,
                    summary: typeof entry.summary === "string" ? entry.summary : "",
                    notes: Array.isArray(entry.notes)
                        ? uniqueStrings(entry.notes.filter((n): n is string => typeof n === "string"))
                        : [],
                }))
                .sort((a, b) => a.date.localeCompare(b.date))
            : mergeLogsLocally(members),
        openQuestions,
        linkTargets,
        createdAt: earliestIso(...members.map((m) => m.createdAt)),
        updatedAt: new Date().toISOString(),
    };
    return withNormalizedAliases(stamped);
}

function mergeLogsLocally(members: EntityData[]): EntityData["log"] {
    const byDate = new Map<string, { summary: string; notes: string[] }>();
    for (const member of members) {
        for (const entry of member.log ?? []) {
            const existing = byDate.get(entry.date);
            if (!existing) {
                byDate.set(entry.date, {
                    summary: entry.summary || "",
                    notes: [...(entry.notes ?? [])],
                });
            } else {
                if (entry.summary && !existing.summary.includes(entry.summary)) {
                    existing.summary = [existing.summary, entry.summary].filter(Boolean).join(" ");
                }
                existing.notes = uniqueStrings([...existing.notes, ...(entry.notes ?? [])]);
            }
        }
    }
    return [...byDate.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, value]) => ({ date, summary: value.summary, notes: value.notes }));
}

async function loadEntityAtPath(filepath: string): Promise<EntityData | null> {
    try {
        return JSON.parse(await fs.readFile(filepath, "utf8")) as EntityData;
    } catch {
        return null;
    }
}

export async function applyApprovedMerges(
    page: Page,
    approved: ApprovedMerge[],
    vaultDataFolder = "vault-data",
    options: { dryRun?: boolean } = {},
): Promise<void> {
    if (approved.length === 0) {
        console.log("[dedup] No merges approved.");
        return;
    }

    /** Paths that were deleted or renamed → current surviving path. */
    const pathRemap = new Map<string, string>();
    const resolvePath = (filepath: string): string => {
        let current = filepath;
        const seen = new Set<string>();
        while (pathRemap.has(current) && !seen.has(current)) {
            seen.add(current);
            current = pathRemap.get(current)!;
        }
        return current;
    };

    for (let i = 0; i < approved.length; i++) {
        const merge = approved[i];
        const resolvedPaths = uniqueStrings(merge.paths.map(resolvePath));
        if (resolvedPaths.length < 2) {
            console.log(
                `[dedup] Skipping merge ${i + 1}/${approved.length} — fewer than 2 remaining files after earlier merges`,
            );
            continue;
        }

        const members: EntityData[] = [];
        const memberPaths: string[] = [];
        for (const filepath of resolvedPaths) {
            const entity = await loadEntityAtPath(filepath);
            if (!entity) {
                console.warn(`[dedup] Missing file ${filepath}; skipping that member`);
                continue;
            }
            members.push(entity);
            memberPaths.push(filepath);
        }
        if (members.length < 2) {
            console.log(
                `[dedup] Skipping merge ${i + 1}/${approved.length} — could not load enough members`,
            );
            continue;
        }

        const aliases = collectAliases(members, merge.canonicalName);
        console.log(
            `[dedup] Merging ${members.map((m) => m.name).join(" + ")} → ${merge.canonicalType} "${merge.canonicalName}"`,
        );

        if (options.dryRun) {
            const keepPath = path.join(
                vaultDataFolder,
                "entities",
                entityJsonFilename({ name: merge.canonicalName, type: merge.canonicalType }),
            );
            console.log(`[dedup] dry-run would write ${keepPath}`);
            console.log(`[dedup] dry-run aliases: ${aliases.join("; ") || "(none)"}`);
            for (const filepath of memberPaths) {
                if (path.resolve(filepath) !== path.resolve(keepPath)) {
                    console.log(`[dedup] dry-run would delete ${filepath}`);
                }
            }
            continue;
        }

        await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
        const raw = await runJsonPrompt(
            page,
            buildMergePrompt(members, merge, aliases),
            60_000,
        );
        const stamped = stampMergedEntity(parseMergedEntity(raw), merge, members, aliases);
        const keepPath = await saveEntity(vaultDataFolder, stamped);

        for (const filepath of memberPaths) {
            if (path.resolve(filepath) === path.resolve(keepPath)) continue;
            try {
                await fs.unlink(filepath);
                console.log(`[dedup] Deleted ${filepath}`);
                pathRemap.set(filepath, keepPath);
            } catch (error) {
                console.warn(
                    `[dedup] Could not delete ${filepath}: ${error instanceof Error ? error.message : error}`,
                );
            }
        }
        for (const filepath of memberPaths) {
            pathRemap.set(filepath, keepPath);
        }
    }
}

export async function runInteractiveDedup(
    options: { dryRun?: boolean; vaultDataFolder?: string } = {},
): Promise<void> {
    const vaultDataFolder = options.vaultDataFolder ?? "vault-data";
    if (!input.isTTY || !output.isTTY) {
        throw new Error(
            "dedup --interactive requires a TTY (interactive terminal). Run it in a terminal, not a pipe.",
        );
    }

    let result: DedupResult;
    try {
        result = await withChatGptPage(async (page) => findDuplicateEntities(page, vaultDataFolder));
    } catch (error) {
        throw error;
    }

    console.log(formatDedupReport(result));
    if (result.duplicates.length === 0) return;

    const approved = await reviewDuplicateGroups(result.duplicates);
    if (approved.length === 0) {
        console.log("[dedup] No merges approved.");
        return;
    }

    console.log(`[dedup] ${approved.length} group(s) approved for merge.`);
    if (options.dryRun) {
        console.log("[dedup] dry-run: skipping ChatGPT merge and file writes.");
        await applyApprovedMerges(
            null as unknown as Page,
            approved,
            vaultDataFolder,
            { dryRun: true },
        );
        return;
    }

    await withChatGptPage(async (page) => {
        await applyApprovedMerges(page, approved, vaultDataFolder);
    });
    console.log("[dedup] Interactive dedup complete.");
}

async function main() {
    const dryRun = process.argv.includes("--dry-run");
    const interactive = process.argv.includes("--interactive");
    if (interactive) {
        await runInteractiveDedup({ dryRun });
        return;
    }
    if (dryRun) {
        console.log(await previewEntityTable());
        return;
    }
    await withChatGptPage(async (page: Page) => {
        const result = await findDuplicateEntities(page);
        console.log(formatDedupReport(result));
    });
}

if (isDirectRun(import.meta.url)) {
    main();
}
