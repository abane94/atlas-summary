/**
 * 
 * 
 * Vault
 * - log
 * - log/
 * - - [session dates].md
 * - players/
 * - - [player name].md
 * - NPCs/
 * - - [NPC name].md
 * - items/
 * - - [item name].md
 * - locations/
 * - - [location name].md
 * - events/
 * - - [event name].md
 * - concepts/
 * - - [note name].md
 * 
 */

import fs from 'fs/promises';
import path from 'path';

import type { PlotSection, SessionChunkSummary } from "./types/session.ts";
import { Page } from 'puppeteer-core';
import { runJsonPrompt, runProsePrompt } from './chatgpt.js';
import { isDirectRun } from './is-main.ts';
import { withChatGptPage } from './browser.js';
import {
    buildTagCatalogPromptSection,
    mergeSuggestedTags,
    parseSuggestedTags,
    unionTags,
    validateEntityTags,
    type SuggestedTag,
} from './entity-tags.ts';

const CHATGPT_URL = "https://chatgpt.com";

export interface SessionData {
    date: string; // yyyy-mm-dd string
    summary: string;
    plotSections: PlotSection[];
    log: string[];
    openQuestions: string[];
}

export interface EntityData {
    slug: string;
    name: string;
    tags: string[];
    aliases: string[];
    /**
     * Derived lookup keys from name + aliases (lowercase, stripped punctuation / leading "the").
     * Always regenerated on save — do not edit by hand.
     */
    normalizedAliases: string[];
    filename: string;
    description: string;
    type: 'PLAYER' | 'NPC' | 'ITEM' | 'LOCATION' | 'EVENT' | 'CONCEPT' | 'GROUP' | 'OTHER';
    log: {
        date: string; // yyyy-mm-dd string
        summary: string;
        notes: string[];
    }[];
    openQuestions: string[];
    linkTargets: string[];
    createdAt: string; // iso string
    updatedAt: string; // iso string
}

const MATCH_CONFIDENCE_MIN = 80;
const DESCRIPTION_CLIP_CHARS = 240;

export type EntityUpdate = SessionChunkSummary["entities"][string];

interface EntityMatchAiRow {
    incomingName: string;
    existingName: string | null;
    confidence: number;
    reason: string;
}

interface ResolvedEntityWrite {
    /** Existing vault record, or null for a brand-new entity. */
    existing: EntityData | null;
    /** Display name used for prompts / new entity creation (canonical when updating). */
    writeName: string;
    /** All session keys that resolved to this target (for alias capture + merged notes). */
    incomingNames: string[];
    sessionEntity: EntityUpdate;
}

interface VaultEntityAiResult {
    summary: string;
    description?: string;
    slug?: string;
    tags: string[];
    suggestedTags: SuggestedTag[];
}

export type EntityType = EntityData['type'];

/** Lowercase, collapse separators, strip punctuation, drop a leading "the ". */
export function normalizeEntityName(raw: string): string {
    let s = raw
        .trim()
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
    if (s.startsWith("the ")) {
        s = s.slice(4).trim();
    }
    return s;
}

export function buildNormalizedAliases(name: string, aliases: string[] = []): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of [name, ...aliases]) {
        const key = normalizeEntityName(value);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(key);
    }
    return out;
}

export function withNormalizedAliases(entity: EntityData): EntityData {
    entity.normalizedAliases = buildNormalizedAliases(entity.name, entity.aliases ?? []);
    return entity;
}

/** Append display names that differ from the canonical name (case-insensitive). Rebuilds normalizedAliases. */
export function addAliasNames(entity: EntityData, names: string[]): EntityData {
    const aliases = [...(entity.aliases ?? [])];
    const known = new Set(
        [entity.name, ...aliases].map((n) => n.trim().toLowerCase()).filter(Boolean),
    );
    for (const raw of names) {
        const name = raw.trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (known.has(key)) continue;
        known.add(key);
        aliases.push(name);
    }
    entity.aliases = aliases;
    return withNormalizedAliases(entity);
}

function uniqueStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        const t = value.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
    }
    return out;
}

function sameNormalizedAliasList(a: string[] | undefined, b: string[]): boolean {
    const left = a ?? [];
    if (left.length !== b.length) return false;
    return left.every((value, i) => value === b[i]);
}

/**
 * Map normalized form → entity. Colliding keys map to null (do not auto-match).
 */
export function buildNormalizedAliasIndex(
    entities: EntityData[],
): Map<string, EntityData | null> {
    const index = new Map<string, EntityData | null>();
    for (const entity of entities) {
        const keys = buildNormalizedAliases(entity.name, entity.aliases ?? []);
        for (const key of keys) {
            if (!index.has(key)) {
                index.set(key, entity);
            } else if (index.get(key) !== entity) {
                if (index.get(key) !== null) {
                    console.warn(
                        `[vault] Normalized alias collision on "${key}" — refusing auto-match for that key`,
                    );
                }
                index.set(key, null);
            }
        }
    }
    return index;
}

export function findExistingEntity(
    entities: EntityData[],
    name: string,
    index?: Map<string, EntityData | null>,
): EntityData | undefined {
    const key = normalizeEntityName(name);
    if (!key) return undefined;
    const map = index ?? buildNormalizedAliasIndex(entities);
    const hit = map.get(key);
    return hit ?? undefined;
}

export function nameToEntitySlug(name: string): string {
    return name.toLowerCase().replaceAll(' ', '_').replace(/[/\\?%*:|"<>']/g, '__');
}

export function entityJsonFilename(entity: Pick<EntityData, 'name' | 'type'>): string {
    return `${entity.type.toLowerCase()}--${nameToEntitySlug(entity.name)}.json`;
}

export function entityMarkdownFilename(entity: Pick<EntityData, 'name' | 'type'>): string {
    return path.join('entities', entity.type.toLowerCase(), `${nameToEntitySlug(entity.name)}.md`);
}

export function normalizeEntityType(raw: string): EntityType {
    const upper = raw.trim().toUpperCase();
    const allowed: EntityType[] = [
        'PLAYER',
        'NPC',
        'ITEM',
        'LOCATION',
        'EVENT',
        'CONCEPT',
        'GROUP',
        'OTHER',
    ];
    if ((allowed as string[]).includes(upper)) {
        return upper as EntityType;
    }
    throw new Error(
        `Unknown entity type "${raw}". Use: ${allowed.join(', ')}`,
    );
}

function entityProcessedForSession(entity: EntityData, sessionDate: string): boolean {
    return entity.log.some(entry => entry.date === sessionDate);
}

/** Replace any existing log entry for `date` (avoids duplicate dated entries). */
function upsertEntityLog(
    entity: EntityData,
    date: string,
    entry: { summary: string; notes: string[] },
): void {
    entity.log = (entity.log ?? []).filter((e) => e.date !== date);
    entity.log.push({
        date,
        summary: entry.summary,
        notes: entry.notes,
    });
    entity.log.sort((a, b) => a.date.localeCompare(b.date));
}

async function fileExists(filepath: string): Promise<boolean> {
    try {
        await fs.access(filepath);
        return true;
    } catch {
        return false;
    }
}

export interface VaultForcePreview {
    /** Entity files that have at least one log entry for this date. */
    entityLogsToReplace: number;
    /** Entity files whose log would be empty after stripping this date. */
    entitiesToDelete: number;
    hasSessionLog: boolean;
}

/** Count what `--force` would strip/delete without mutating the vault. */
export async function getVaultForcePreview(
    date: string,
    vaultDataFolder = 'vault-data',
): Promise<VaultForcePreview> {
    const loaded = await loadEntityFiles(vaultDataFolder);
    let entityLogsToReplace = 0;
    let entitiesToDelete = 0;
    for (const { entity } of loaded) {
        const remaining = (entity.log ?? []).filter((e) => e.date !== date);
        const removed = (entity.log ?? []).length - remaining.length;
        if (removed === 0) continue;
        entityLogsToReplace++;
        if (remaining.length === 0) entitiesToDelete++;
    }
    const sessionLogPath = path.join(vaultDataFolder, 'log', `${date}.json`);
    return {
        entityLogsToReplace,
        entitiesToDelete,
        hasSessionLog: await fileExists(sessionLogPath),
    };
}

export interface RevertSessionResult {
    entities: EntityData[];
    stripped: number;
    deleted: number;
    sessionLogDeleted: boolean;
}

/**
 * Strip all entity log entries for `date`, delete entities whose log becomes empty,
 * and remove the session log file. Returns surviving entities for the in-memory catalog.
 */
export async function revertSessionFromVault(
    vaultDataFolder: string,
    date: string,
): Promise<RevertSessionResult> {
    const loaded = await loadEntityFiles(vaultDataFolder);
    const survivors: EntityData[] = [];
    let stripped = 0;
    let deleted = 0;

    for (const { filepath, entity } of loaded) {
        const before = (entity.log ?? []).length;
        entity.log = (entity.log ?? []).filter((e) => e.date !== date);
        const removed = before - entity.log.length;

        if (entity.log.length === 0 && removed > 0) {
            await fs.unlink(filepath);
            console.log(
                `[vault] Deleted ${filepath} (no remaining log entries after reverting ${date})`,
            );
            deleted++;
            stripped++;
            continue;
        }

        if (removed > 0) {
            stripped++;
            entity.updatedAt = new Date().toISOString();
            await saveEntity(vaultDataFolder, entity);
        }
        survivors.push(entity);
    }

    const sessionLogPath = path.join(vaultDataFolder, 'log', `${date}.json`);
    let sessionLogDeleted = false;
    if (await fileExists(sessionLogPath)) {
        await fs.unlink(sessionLogPath);
        console.log(`[vault] Deleted session log ${sessionLogPath}`);
        sessionLogDeleted = true;
    }

    console.log(
        `[vault] Reverted ${date}: stripped ${stripped} entit${stripped === 1 ? 'y' : 'ies'}` +
            `, deleted ${deleted} file${deleted === 1 ? '' : 's'}` +
            (sessionLogDeleted ? ', removed session log' : ''),
    );
    return { entities: survivors, stripped, deleted, sessionLogDeleted };
}

export async function saveEntity(vaultDataFolder: string, entity: EntityData): Promise<string> {
    withNormalizedAliases(entity);
    const filename = entityJsonFilename(entity);
    const filepath = path.join(vaultDataFolder, 'entities', filename);
    console.log(`Saved entity ${entity.name} to ${filepath}`);
    await fs.writeFile(filepath, JSON.stringify(entity, null, 2));
    return filepath;
}

/** Rewrite entity JSON files whose normalizedAliases are missing or stale. */
export async function backfillNormalizedAliases(vaultDataFolder: string): Promise<EntityData[]> {
    const loaded = await loadEntityFiles(vaultDataFolder);
    const entities: EntityData[] = [];
    let updated = 0;
    for (const { filepath, entity } of loaded) {
        const expected = buildNormalizedAliases(entity.name, entity.aliases ?? []);
        if (!sameNormalizedAliasList(entity.normalizedAliases, expected)) {
            entity.normalizedAliases = expected;
            await fs.writeFile(filepath, JSON.stringify(entity, null, 2));
            updated++;
        } else if (!entity.normalizedAliases) {
            entity.normalizedAliases = expected;
        }
        entities.push(entity);
    }
    if (updated > 0) {
        console.log(`[vault] Backfilled normalizedAliases on ${updated} entit${updated === 1 ? "y" : "ies"}`);
    }
    return entities;
}

async function loadTagSuggestions(vaultDataFolder: string): Promise<SuggestedTag[]> {
    const filepath = path.join(vaultDataFolder, 'tag-suggestions.json');
    try {
        const raw = JSON.parse(await fs.readFile(filepath, 'utf8')) as { suggestions?: unknown };
        return parseSuggestedTags(raw.suggestions ?? raw);
    } catch {
        return [];
    }
}

async function persistTagSuggestions(
    vaultDataFolder: string,
    incoming: SuggestedTag[],
): Promise<SuggestedTag[]> {
    if (incoming.length === 0) return loadTagSuggestions(vaultDataFolder);
    const existing = await loadTagSuggestions(vaultDataFolder);
    const merged = mergeSuggestedTags(existing, incoming);
    const filepath = path.join(vaultDataFolder, 'tag-suggestions.json');
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
    console.log(`[vault] Wrote ${merged.length} tag suggestion(s) to ${filepath}`);
    return merged;
}


export interface GenerateVaultOptions {
    /** Only process this session date (yyyy-mm-dd). */
    date?: string;
    /**
     * Fully redo vault for `date`: strip that session from entity logs (delete
     * entities that only had this date), delete the session log, then re-run AI.
     * Requires `date`.
     */
    force?: boolean;
}

export interface LoadedEntity {
    filepath: string;
    filename: string;
    entity: EntityData;
}

export async function loadEntityFiles(vaultDataFolder: string): Promise<LoadedEntity[]> {
    const entitiesDir = path.join(vaultDataFolder, 'entities');
    await fs.mkdir(entitiesDir, { recursive: true });
    const existingEntities = await fs.readdir(entitiesDir, { withFileTypes: true });
    const loaded: LoadedEntity[] = [];
    for (const file of existingEntities) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        const filepath = path.join(entitiesDir, file.name);
        const entityData = JSON.parse(await fs.readFile(filepath, 'utf8')) as EntityData;
        loaded.push({ filepath, filename: file.name, entity: entityData });
    }
    return loaded;
}

export async function loadEntities(vaultDataFolder: string): Promise<EntityData[]> {
    return (await loadEntityFiles(vaultDataFolder)).map((loaded) => loaded.entity);
}

export async function getVaultProgress(
    date: string,
    summariesFolder = 'summaries',
    vaultDataFolder = 'vault-data',
): Promise<{
    hasMerged: boolean;
    hasSessionLog: boolean;
    entityTotal: number;
    entityProcessed: number;
}> {
    const mergedPath = path.join(summariesFolder, date, 'merged.json');
    const sessionLogPath = path.join(vaultDataFolder, 'log', `${date}.json`);
    const hasMerged = await fileExists(mergedPath);
    const hasSessionLog = await fileExists(sessionLogPath);
    if (!hasMerged) {
        return { hasMerged, hasSessionLog, entityTotal: 0, entityProcessed: 0 };
    }

    const sessionData = JSON.parse(await fs.readFile(mergedPath, 'utf8')) as SessionChunkSummary;
    const names = Object.keys(sessionData.entities ?? {});
    const existingEntitiesList = await loadEntities(vaultDataFolder);
    let entityProcessed = 0;
    for (const name of names) {
        const existing = findExistingEntity(existingEntitiesList, name);
        if (existing && entityProcessedForSession(existing, date)) {
            entityProcessed++;
        }
    }
    return {
        hasMerged,
        hasSessionLog,
        entityTotal: names.length,
        entityProcessed,
    };
}

export async function vaultNeedsWork(
    date: string,
    options: { force?: boolean; summariesFolder?: string; vaultDataFolder?: string } = {},
): Promise<boolean> {
    if (options.force) return true;
    const progress = await getVaultProgress(
        date,
        options.summariesFolder ?? 'summaries',
        options.vaultDataFolder ?? 'vault-data',
    );
    if (!progress.hasMerged) return true;
    if (!progress.hasSessionLog) return true;
    return progress.entityProcessed < progress.entityTotal;
}

export async function generateVaultData(
    page: Page,
    summariesFolder: string,
    vaultDataFolder: string,
    options: GenerateVaultOptions = {},
) {
    if (options.force && !options.date) {
        throw new Error(
            'vault --force requires a session date, e.g. vault 2026-08-17 --force',
        );
    }

    await fs.mkdir(path.join(vaultDataFolder, 'log'), { recursive: true });
    await fs.mkdir(path.join(vaultDataFolder, 'entities'), { recursive: true });

    let sessionFolders;
    try {
        sessionFolders = (await fs.readdir(summariesFolder, { withFileTypes: true }))
            .filter((dirent) => dirent.isDirectory())
            .filter((dirent) => dirent.name.match(/^\d{4}-\d{2}-\d{2}$/))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        throw new Error(`Cannot read ${summariesFolder}. Run chunks/merge first.`);
    }

    if (options.date) {
        const match = sessionFolders.find((folder) => folder.name === options.date);
        if (!match) {
            throw new Error(
                `No summaries/${options.date} folder found. Run chunks/merge for that date first.`,
            );
        }
        sessionFolders.length = 0;
        sessionFolders.push(match);
    }

    console.log('[vault] Loading existing vault entities...');
    const existingSessions = await fs.readdir(path.join(vaultDataFolder, 'log'), { withFileTypes: true });
    const existingSessionsMap: Record<string, SessionData> = {};
    for (const file of existingSessions) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        const sessionData = JSON.parse(await fs.readFile(path.join(vaultDataFolder, 'log', file.name), 'utf8')) as SessionData;
        existingSessionsMap[sessionData.date] = sessionData;
    }

    let existingEntitiesList = await backfillNormalizedAliases(vaultDataFolder);
    console.log(`[vault] Loaded ${existingEntitiesList.length} entities`);

    if (options.force && options.date) {
        console.log(`[vault] Force-reverting ${options.date} before regenerating...`);
        const reverted = await revertSessionFromVault(vaultDataFolder, options.date);
        existingEntitiesList = reverted.entities;
        delete existingSessionsMap[options.date];
        console.log(`[vault] Catalog after revert: ${existingEntitiesList.length} entit${existingEntitiesList.length === 1 ? 'y' : 'ies'}`);
    }

    for (const sessionFolder of sessionFolders) {
        const sessionDate = sessionFolder.name;
        const mergedPath = path.join(summariesFolder, sessionFolder.name, 'merged.json');
        if (!(await fileExists(mergedPath))) {
            const message = `Cannot run vault for ${sessionDate}: missing ${mergedPath}. Run the merge step first.`;
            if (options.date) {
                throw new Error(message);
            }
            console.log(`[vault] Skipping ${sessionDate} — missing ${mergedPath}`);
            continue;
        }

        const sessionLogPath = path.join(vaultDataFolder, 'log', `${sessionDate}.json`);
        const sessionLogExists = Boolean(existingSessionsMap[sessionDate]);
        if (sessionLogExists && !options.force) {
            const progress = await getVaultProgress(sessionDate, summariesFolder, vaultDataFolder);
            if (progress.entityProcessed >= progress.entityTotal) {
                console.log(`[vault] ${sessionDate} already processed, skipping (use --force to redo session + entity logs)`);
                continue;
            }
            console.log(
                `[vault] ${sessionDate} session log exists; processing ${progress.entityTotal - progress.entityProcessed} new entit${progress.entityTotal - progress.entityProcessed === 1 ? 'y' : 'ies'}`,
            );
            await parseSessionEntities(page, sessionDate, path.join(summariesFolder, sessionFolder.name), existingEntitiesList, vaultDataFolder);
            continue;
        }

        console.log(`[vault] Processing session ${sessionDate}...`);
        const sessionData = await parseSessionData(page, sessionDate, path.join(summariesFolder, sessionFolder.name), existingEntitiesList, vaultDataFolder);
        existingSessionsMap[sessionDate] = sessionData;
        await fs.writeFile(sessionLogPath, JSON.stringify(sessionData, null, 2));
        console.log(`[vault] Wrote ${sessionLogPath}`);
    }

    console.log('[vault] Vault data generation complete');
}


function parseVaultEntityAiResult(raw: string): VaultEntityAiResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`vault entity response was not valid JSON:\n${raw}`);
    }
    if (!parsed || typeof parsed !== "object") {
        throw new Error(`vault entity response was not an object:\n${raw}`);
    }
    const obj = parsed as Record<string, unknown>;
    return {
        summary: typeof obj.summary === "string" ? obj.summary.trim() : "",
        description: typeof obj.description === "string" ? obj.description.trim() : undefined,
        slug: typeof obj.slug === "string" ? obj.slug.trim() : undefined,
        tags: Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === "string") : [],
        suggestedTags: parseSuggestedTags(obj.suggestedTags),
    };
}

function mergeEntityUpdates(parts: EntityUpdate[]): EntityUpdate {
    const first = parts[0];
    return {
        existing: parts.map((p) => p.existing).find((s) => s.trim()) ?? "",
        entityType: first.entityType,
        otherEntityType: parts.map((p) => p.otherEntityType).find(Boolean),
        notes: uniqueStrings(parts.flatMap((p) => p.notes ?? [])),
        titles: uniqueStrings(parts.flatMap((p) => p.titles ?? [])),
        personality: uniqueStrings(parts.flatMap((p) => p.personality ?? [])),
        quotesThemes: uniqueStrings(parts.flatMap((p) => p.quotesThemes ?? [])),
        openQuestions: uniqueStrings(parts.flatMap((p) => p.openQuestions ?? [])),
    };
}

function clipDescription(description: string): string {
    const cleaned = description
        .replaceAll("|", "/")
        .replaceAll(/[\r\n]+/g, " ")
        .replaceAll(/\s+/g, " ")
        .trim();
    if (cleaned.length <= DESCRIPTION_CLIP_CHARS) return cleaned;
    return `${cleaned.slice(0, DESCRIPTION_CLIP_CHARS - 1).trimEnd()}…`;
}

function buildMatchCatalogTables(
    unmatched: { name: string; entity: EntityUpdate }[],
    vaultEntities: EntityData[],
): { incomingTable: string; vaultTable: string } {
    const incomingRows = [
        "| Incoming Name | Type | Prior Context | Notes |",
        "| --- | --- | --- | --- |",
        ...unmatched.map(({ name, entity }) => {
            const notes = clipDescription((entity.notes ?? []).slice(0, 4).join("; "));
            const prior = clipDescription(entity.existing || "");
            return `| ${name.replaceAll("|", "/")} | ${entity.entityType} | ${prior} | ${notes} |`;
        }),
    ];
    const vaultRows = [
        "| Name | Aliases | Type | Description |",
        "| --- | --- | --- | --- |",
        ...[...vaultEntities]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((entity) => {
                const aliases = (entity.aliases ?? []).join("; ");
                return `| ${entity.name.replaceAll("|", "/")} | ${aliases.replaceAll("|", "/")} | ${entity.type} | ${clipDescription(entity.description ?? "")} |`;
            }),
    ];
    return {
        incomingTable: incomingRows.join("\n"),
        vaultTable: vaultRows.join("\n"),
    };
}

function buildEntityMatchPrompt(
    unmatched: { name: string; entity: EntityUpdate }[],
    vaultEntities: EntityData[],
): string {
    const { incomingTable, vaultTable } = buildMatchCatalogTables(unmatched, vaultEntities);
    return `
You are matching session entity names to an existing campaign vault catalog.

For each incoming name, either reuse an existing vault entity (copy its Name exactly) or mark it as new (existingName: null).

Rules:
- Prefer matching when the incoming name is a shorter/longer form, spelling variant, or alias of a vault entity.
- Prefer the same type when possible; different types can still match if descriptions clearly refer to the same thing.
- Do NOT match entities that merely share a word or theme if they are distinct (e.g. "Gate" vs "Gatehouse", "Doorman" vs "Doorkeeper" vs "Doorway").
- Prefer NEW (existingName: null) when unsure.
- Return one row per incoming name. Copy incoming names exactly. Copy existing vault Names exactly when matching.

Return JSON only:
\`\`\`typescript
export interface Match {
  incomingName: string;
  existingName: string | null;
  confidence: number; // 0-100
  reason: string;
}
export interface Output {
  matches: Match[];
}
\`\`\`

## Incoming session entities (${unmatched.length})

${incomingTable}

## Existing vault entities (${vaultEntities.length})

${vaultTable}
`.trim();
}

function parseEntityMatchResult(raw: string): EntityMatchAiRow[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`vault entity match response was not valid JSON:\n${raw}`);
    }
    if (!parsed || typeof parsed !== "object") {
        throw new Error(`vault entity match response was not an object:\n${raw}`);
    }
    const matchesRaw = (parsed as { matches?: unknown }).matches;
    if (!Array.isArray(matchesRaw)) return [];
    const out: EntityMatchAiRow[] = [];
    for (const item of matchesRaw) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        const incomingName = typeof row.incomingName === "string" ? row.incomingName.trim() : "";
        if (!incomingName) continue;
        const existingRaw = row.existingName;
        const existingName =
            existingRaw === null || existingRaw === undefined
                ? null
                : typeof existingRaw === "string"
                  ? existingRaw.trim() || null
                  : null;
        const confidenceRaw = typeof row.confidence === "number" ? row.confidence : Number(row.confidence);
        const confidence = Number.isFinite(confidenceRaw)
            ? Math.max(0, Math.min(100, Math.round(confidenceRaw > 0 && confidenceRaw <= 1 ? confidenceRaw * 100 : confidenceRaw)))
            : 0;
        const reason = typeof row.reason === "string" ? row.reason.trim() : "";
        out.push({ incomingName, existingName, confidence, reason });
    }
    return out;
}

async function resolveSessionEntityTargets(
    page: Page,
    sessionEntities: Record<string, EntityUpdate>,
    existingEntitiesList: EntityData[],
): Promise<Map<string, EntityData | null>> {
    /** incoming name → existing entity or null (create new) */
    const resolved = new Map<string, EntityData | null>();
    const index = buildNormalizedAliasIndex(existingEntitiesList);
    const unmatched: { name: string; entity: EntityUpdate }[] = [];

    for (const [name, entity] of Object.entries(sessionEntities)) {
        const hit = findExistingEntity(existingEntitiesList, name, index);
        if (hit) {
            console.log(`[vault] Code-match "${name}" → "${hit.name}"`);
            resolved.set(name, hit);
        } else {
            unmatched.push({ name, entity });
        }
    }

    if (unmatched.length === 0) {
        return resolved;
    }

    console.log(`[vault] Asking ChatGPT to match ${unmatched.length} unmatched entit${unmatched.length === 1 ? "y" : "ies"}...`);
    await page.goto(CHATGPT_URL, { waitUntil: "networkidle2", timeout: 60_000 });
    const raw = await runJsonPrompt(
        page,
        buildEntityMatchPrompt(unmatched, existingEntitiesList),
        60_000,
    );
    const aiMatches = parseEntityMatchResult(raw);
    const byIncoming = new Map(aiMatches.map((m) => [m.incomingName, m]));
    const vaultByName = new Map(existingEntitiesList.map((e) => [e.name, e]));

    for (const { name } of unmatched) {
        const row = byIncoming.get(name);
        if (
            row &&
            row.existingName &&
            row.confidence >= MATCH_CONFIDENCE_MIN &&
            vaultByName.has(row.existingName)
        ) {
            const target = vaultByName.get(row.existingName)!;
            console.log(
                `[vault] AI-match "${name}" → "${target.name}" (${row.confidence}%)${row.reason ? `: ${row.reason}` : ""}`,
            );
            resolved.set(name, target);
        } else {
            const reason = row
                ? row.existingName
                    ? `rejected (confidence ${row.confidence} or unknown target "${row.existingName}")`
                    : "new"
                : "no AI row — treating as new";
            console.log(`[vault] No reuse for "${name}" — ${reason}`);
            resolved.set(name, null);
        }
    }

    return resolved;
}

function groupResolvedWrites(
    sessionEntities: Record<string, EntityUpdate>,
    resolved: Map<string, EntityData | null>,
): ResolvedEntityWrite[] {
    const existingGroups = new Map<EntityData, string[]>();
    const newNames: string[] = [];

    for (const name of Object.keys(sessionEntities)) {
        const target = resolved.get(name);
        if (target) {
            const list = existingGroups.get(target) ?? [];
            list.push(name);
            existingGroups.set(target, list);
        } else {
            newNames.push(name);
        }
    }

    const groups: ResolvedEntityWrite[] = [];

    for (const [existing, incomingNames] of existingGroups) {
        groups.push({
            existing,
            writeName: existing.name,
            incomingNames,
            sessionEntity: mergeEntityUpdates(incomingNames.map((n) => sessionEntities[n])),
        });
    }

    for (const name of newNames) {
        groups.push({
            existing: null,
            writeName: name,
            incomingNames: [name],
            sessionEntity: sessionEntities[name],
        });
    }

    return groups;
}

function buildExistingEntityPrompt(
    name: string,
    date: string,
    existing: EntityData,
    sessionEntity: SessionChunkSummary["entities"][string],
): string {
    return `
This is the entity data for ${name} from the session on ${date}.
The entity already exists in the vault. Generate a session log summary and update tags.

Rules:
- summary: a single markdown paragraph (≤200 words) capturing the main points of the entity's new notes for this session. Same language as the entity data.
- tags: 0–3 from the closed catalog when they clearly apply; prefer []. Do not invent tags.
- suggestedTags: catalog promotion suggestions, or [].
- Do not rewrite description or slug. Do not invent facts.

${buildTagCatalogPromptSection()}

Return JSON only matching:
\`\`\`typescript
export interface Output {
  summary: string;
  tags: string[];
  suggestedTags: { tag: string; reason: string; exampleEntities: string[] }[];
}
\`\`\`

Existing description:
${existing.description}

Current tags: ${JSON.stringify(existing.tags ?? [])}

Prior context:
${sessionEntity.existing}

New notes:
${sessionEntity.notes.join("\n")}
`.trim();
}

function buildNewEntityPrompt(
    name: string,
    date: string,
    sessionEntity: SessionChunkSummary["entities"][string],
): string {
    return `
This is the entity data for ${name} from the session on ${date}.
Create vault fields for a new entity.

Rules:
- description: standing identity (always-relevant facts), plain text, ≤200 words, one paragraph. Do not invent; short is fine.
- summary: what happened to this entity in this session, markdown, ≤200 words, one paragraph. Focus on new notes, not a full rehash.
- slug: a single short phrase (one sentence) capturing the main essence. Plain text, no markdown.
- tags: 0–3 from the closed catalog when they clearly apply; prefer [].
- suggestedTags: catalog promotion suggestions, or [].
- Same language as the entity data. Do not invent facts you are not confident about.

${buildTagCatalogPromptSection()}

Return JSON only matching:
\`\`\`typescript
export interface Output {
  description: string;
  summary: string;
  slug: string;
  tags: string[];
  suggestedTags: { tag: string; reason: string; exampleEntities: string[] }[];
}
\`\`\`

Prior context:
${sessionEntity.existing}

New notes:
${sessionEntity.notes.join("\n")}
`.trim();
}

async function parseSessionEntities(
    page: Page,
    date: string,
    sessionFolder: string,
    existingEntitiesList: EntityData[],
    vaultDataFolder: string,
): Promise<SessionChunkSummary> {
    const sessionData = JSON.parse(await fs.readFile(path.join(sessionFolder, 'merged.json'), 'utf8')) as SessionChunkSummary;
    const sessionEntities = sessionData.entities ?? {};
    const entityNames = Object.keys(sessionEntities);
    console.log(`[vault] Parsing ${entityNames.length} entities for ${date}`);

    const resolved = await resolveSessionEntityTargets(page, sessionEntities, existingEntitiesList);
    const writeGroups = groupResolvedWrites(sessionEntities, resolved);
    console.log(`[vault] ${writeGroups.length} write group(s) after match/merge (${entityNames.length} incoming names)`);

    let skippedEntities = 0;
    let processedEntities = 0;
    const collectedSuggestions: SuggestedTag[] = [];

    for (const group of writeGroups) {
        const { existing: existingEntity, writeName, incomingNames, sessionEntity } = group;
        console.log(
            `[vault] Entity ${writeName} ${existingEntity ? `(existing)` : `(new)`}` +
                (incomingNames.length > 1 ? ` ← [${incomingNames.join(", ")}]` : "") +
                ` (${processedEntities + 1} of ${writeGroups.length}) ${skippedEntities} skipped`,
        );
        processedEntities++;

        if (existingEntity && entityProcessedForSession(existingEntity, date)) {
            console.log(`[vault] Skipping ${writeName} — already processed for ${date}`);
            skippedEntities++;
            // Still capture aliases from this session's alternate names.
            addAliasNames(existingEntity, incomingNames);
            await saveEntity(vaultDataFolder, existingEntity);
            continue;
        }

        await page.goto(CHATGPT_URL, { waitUntil: "networkidle2", timeout: 60_000 });

        if (existingEntity) {
            addAliasNames(existingEntity, incomingNames);
            const raw = await runJsonPrompt(
                page,
                buildExistingEntityPrompt(writeName, date, existingEntity, sessionEntity),
                60_000,
            );
            const ai = parseVaultEntityAiResult(raw);
            const validated = validateEntityTags(ai.tags, { entityName: writeName });
            collectedSuggestions.push(
                ...ai.suggestedTags,
                ...validated.implicitSuggestions,
            );

            upsertEntityLog(existingEntity, date, {
                summary: ai.summary,
                notes: sessionEntity.notes,
            });
            existingEntity.tags = unionTags(existingEntity.tags ?? [], validated.tags);
            existingEntity.updatedAt = new Date().toISOString();
            await saveEntity(vaultDataFolder, existingEntity);
        } else {
            const raw = await runJsonPrompt(
                page,
                buildNewEntityPrompt(writeName, date, sessionEntity),
                60_000,
            );
            const ai = parseVaultEntityAiResult(raw);
            const validated = validateEntityTags(ai.tags, { entityName: writeName });
            collectedSuggestions.push(
                ...ai.suggestedTags,
                ...validated.implicitSuggestions,
            );

            const newEntityData: EntityData = {
                name: writeName,
                tags: validated.tags,
                slug: ai.slug ?? "",
                aliases: [],
                normalizedAliases: [],
                filename: entityMarkdownFilename({
                    name: writeName,
                    type: normalizeEntityType(sessionEntity.entityType),
                }),
                description: ai.description ?? "",
                type: normalizeEntityType(sessionEntity.entityType),
                log: [{
                    date: date,
                    summary: ai.summary,
                    notes: sessionEntity.notes,
                }],
                openQuestions: sessionEntity.openQuestions,
                linkTargets: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            withNormalizedAliases(newEntityData);
            existingEntitiesList.push(newEntityData);
            await saveEntity(vaultDataFolder, newEntityData);
        }
    }

    if (collectedSuggestions.length > 0) {
        const sessionSuggestions = mergeSuggestedTags([], collectedSuggestions);
        const all = await persistTagSuggestions(vaultDataFolder, sessionSuggestions);
        for (const suggestion of all.filter((s) =>
            sessionSuggestions.some((incoming) => incoming.tag === s.tag),
        )) {
            console.log(
                `[vault] Tag suggestion: ${suggestion.tag} — ${suggestion.reason || "(no reason)"}` +
                    (suggestion.exampleEntities.length
                        ? ` (e.g. ${suggestion.exampleEntities.slice(0, 3).join(", ")})`
                        : ""),
            );
        }
    }

    return sessionData;
}

async function parseSessionData(page: Page, date: string, sessionFolder: string, existingEntitiesList: EntityData[], vaultDataFolder: string): Promise<SessionData> {
    const sessionData = await parseSessionEntities(page, date, sessionFolder, existingEntitiesList, vaultDataFolder);

    // Plot + chronology is enough for a short session blurb. The full merged
    // JSON (especially every entity's notes) is large enough to hang ChatGPT's
    // composer when pasted via insertText.
    const sessionDataForPrompt = {
        plotSections: sessionData.plotSections,
        chronologicalEvents: sessionData.chronologicalEvents,
        entityNames: Object.keys(sessionData.entities ?? {}),
    };
    console.log(`[vault] Generating session summary for ${date}...`);

    const sessionDataToSave: SessionData = {
        date: date,
        summary: await runProsePrompt(page, `
            This is the session data for ${date}.
            Please generate a summary of the session.
            The summary should be a single paragraph that captures the main points of the session.
            The summary should be in the same language as the session data.
            The summary should be no more than 300 words.
            The summary should be in markdown format.

            ${JSON.stringify(sessionDataForPrompt, null, 2)}
        `),
        plotSections: sessionData.plotSections.map(section => ({
            title: section.title,
            bullets: section.bullets,
        })),
        log: sessionData.chronologicalEvents,
        openQuestions: sessionData.openQuestions,
    };

    return sessionDataToSave;
}

async function main() {
    const dateArg = process.argv.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg));
    const force = process.argv.includes('--force');
    if (force && !dateArg) {
        throw new Error(
            'vault --force requires a session date, e.g. node lib/vault-data.ts 2026-08-17 --force',
        );
    }
    console.log(`[vault] Starting vault data generation${dateArg ? ` for ${dateArg}` : ' for all sessions'}...`);
    await withChatGptPage(async (page: Page) => {
        await generateVaultData(page, 'summaries', 'vault-data', { date: dateArg, force });
    });
}

if (isDirectRun(import.meta.url)) {
    main();
}
