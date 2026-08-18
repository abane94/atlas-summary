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
import { runProsePrompt } from './chatgpt.js';
import { isDirectRun } from './is-main.ts';
import { withChatGptPage } from './browser.js';

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

function entityJsonFilename(entity: EntityData): string {
    const slug = entity.name.toLowerCase().replaceAll(' ', '_').replace(/[/\\?%*:|"<>]/g, '__');
    return `${entity.type.toLowerCase()}--${slug}.json`;
}

function entityProcessedForSession(entity: EntityData, sessionDate: string): boolean {
    return entity.log.some(entry => entry.date === sessionDate);
}

async function fileExists(filepath: string): Promise<boolean> {
    try {
        await fs.access(filepath);
        return true;
    } catch {
        return false;
    }
}

function findExistingEntity(entities: EntityData[], name: string): EntityData | undefined {
    return entities.find((entity) => entity.name === name || entity.aliases.includes(name));
}

async function saveEntity(vaultDataFolder: string, entity: EntityData): Promise<void> {
    const filename = entityJsonFilename(entity);
    const filepath = path.join(vaultDataFolder, 'entities', filename);
    console.log(`Saved entity ${entity.name} to ${filepath}`);
    await fs.writeFile(filepath, JSON.stringify(entity, null, 2));
}


export interface GenerateVaultOptions {
    /** Only process this session date (yyyy-mm-dd). */
    date?: string;
    /** Rewrite the session log even if it already exists. Already-processed entity log entries are still skipped. */
    force?: boolean;
}

export async function loadEntities(vaultDataFolder: string): Promise<EntityData[]> {
    const entitiesDir = path.join(vaultDataFolder, 'entities');
    await fs.mkdir(entitiesDir, { recursive: true });
    const existingEntities = await fs.readdir(entitiesDir, { withFileTypes: true });
    const existingEntitiesList: EntityData[] = [];
    for (const file of existingEntities) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        const entityData = JSON.parse(await fs.readFile(path.join(entitiesDir, file.name), 'utf8')) as EntityData;
        existingEntitiesList.push(entityData);
    }
    return existingEntitiesList;
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
    await fs.mkdir(path.join(vaultDataFolder, 'log'), { recursive: true });
    await fs.mkdir(path.join(vaultDataFolder, 'entities'), { recursive: true });

    let sessionFolders;
    try {
        sessionFolders = (await fs.readdir(summariesFolder, { withFileTypes: true }))
            .filter((dirent) => dirent.isDirectory())
            .filter((dirent) => dirent.name.match(/^\d{4}-\d{2}-\d{2}$/))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        throw new Error(`Cannot read ${summariesFolder}. Run recap/chunks/merge first.`);
    }

    if (options.date) {
        const match = sessionFolders.find((folder) => folder.name === options.date);
        if (!match) {
            throw new Error(
                `No summaries/${options.date} folder found. Run recap/chunks/merge for that date first.`,
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

    const existingEntitiesList = await loadEntities(vaultDataFolder);
    console.log(`[vault] Loaded ${existingEntitiesList.length} entities`);

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
                console.log(`[vault] ${sessionDate} already processed, skipping (use --force to regenerate the session log)`);
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


async function parseSessionEntities(
    page: Page,
    date: string,
    sessionFolder: string,
    existingEntitiesList: EntityData[],
    vaultDataFolder: string,
): Promise<SessionChunkSummary> {
    const sessionData = JSON.parse(await fs.readFile(path.join(sessionFolder, 'merged.json'), 'utf8')) as SessionChunkSummary;
    const entityNames = Object.keys(sessionData.entities ?? {});
    console.log(`[vault] Parsing ${entityNames.length} entities for ${date}`);

    for (const newEntityName of entityNames) {
        console.log(`[vault] Entity ${newEntityName}`);
        const newEntity = sessionData.entities[newEntityName];
        const existingEntity = findExistingEntity(existingEntitiesList, newEntityName);

        if (existingEntity && entityProcessedForSession(existingEntity, date)) {
            console.log(`[vault] Skipping ${newEntityName} — already processed for ${date}`);
            continue;
        }

        if (existingEntity) {
            existingEntity.log.push({
                date: date,
                summary: await runProsePrompt(page, `
                    This is the entity data for ${newEntityName} from the session on ${date}.
                    Please generate a summary of the entity.
                    The summary should be a single paragraph that captures the main points of the entity's new notes.
                    The summary should be in the same language as the entity data.
                    The summary should be no more than 200 words.
                    The summary should be in markdown format.

                    ${newEntity.existing}

                    ${existingEntity.description}

                    The entity's new notes are:

                    ${newEntity.notes.join('\n')}`),
                notes: newEntity.notes,
            });
            existingEntity.updatedAt = new Date().toISOString();
            await saveEntity(vaultDataFolder, existingEntity);
        } else {
            const newEntityData: EntityData = {
                name: newEntityName,
                tags: [],
                slug: '',
                aliases: [],
                filename: path.join('entities', newEntity.entityType.toLowerCase(), newEntityName.toLowerCase().replaceAll(' ', '_').replace(/[/\\?%*:|"<>]/g, '__') + '.md'),
                description: await runProsePrompt(page, `
                    This is the entity data for ${newEntityName} from the session on ${date}.
                    Please generate a description of the entity to the best of your ability.
                    The description should be information that is always relevant to the entity, not simply details about the entity's new notes.
                    Do not include information that you are not confident about. If there is any doubt, do not include it.
                    If there is not a lot of information, do not make things up, it is ok if the description is short.
                    The description should be a single paragraph that captures the main points of the entity's new notes.
                    The description should be in the same language as the entity data.
                    The description should be no more than 200 words.
                    The description should be in plain text format, no markdown.

                    ${newEntity.existing}

                    The entity's new notes are:

                    ${newEntity.notes.join('\n')}`),
                type: newEntity.entityType,
                log: [{
                    date: date,
                    summary: await runProsePrompt(page, `
                        This is the entity data for ${newEntityName} from the session on ${date}.
                        Please generate a summary of what happened to the entity in the session.
                        It does not need to rehash the entity's existing notes, but should instead focus on what happened to the entity in the session.
                        The summary should be a single paragraph that captures the main points of the entity's new notes.
                        The summary should be in the same language as the entity data.
                        The summary should be no more than 200 words.
                        The summary should be in markdown format.

                        ${newEntity.existing}

                        The entity's new notes are:

                        ${newEntity.notes.join('\n')}`),
                    notes: newEntity.notes,
                }],
                openQuestions: newEntity.openQuestions,
                linkTargets: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            const newEntityDataForPrompt = JSON.parse(JSON.stringify(newEntityData));
            delete newEntityDataForPrompt.log;
            newEntityData.slug = await runProsePrompt(page, `
                This is the entity data for ${newEntityName}.
                Please generate a slug for the entity.
                The slug should be a single short phrase (1 sentance) that captures the main essence of the entity.
                The slug should be in the same language as the entity data.
                The slug should be in plain text format, no markdown.

                ${JSON.stringify(newEntityDataForPrompt, null, 2)}
            `);
            existingEntitiesList.push(newEntityData);
            await saveEntity(vaultDataFolder, newEntityData);
        }
    }

    return sessionData;
}

async function parseSessionData(page: Page, date: string, sessionFolder: string, existingEntitiesList: EntityData[], vaultDataFolder: string): Promise<SessionData> {
    const sessionData = await parseSessionEntities(page, date, sessionFolder, existingEntitiesList, vaultDataFolder);

    const sessionDataForPrompt = JSON.parse(JSON.stringify(sessionData));
    delete sessionDataForPrompt.misTranscriptions;
    delete sessionDataForPrompt.openQuestions;
    delete sessionDataForPrompt.newTerms;

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
    console.log(`[vault] Starting vault data generation${dateArg ? ` for ${dateArg}` : ' for all sessions'}...`);
    await withChatGptPage(async (page: Page) => {
        await generateVaultData(page, 'summaries', 'vault-data', { date: dateArg, force });
    });
}

if (isDirectRun(import.meta.url)) {
    main();
}
