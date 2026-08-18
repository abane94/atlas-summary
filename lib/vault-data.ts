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
import { getBrowser } from './browser.js';
import { Page } from 'puppeteer-core';
import { runProsePrompt } from './chatgpt.js';

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

async function saveEntity(vaultDataFolder: string, entity: EntityData): Promise<void> {
    const filename = entityJsonFilename(entity);
    const filepath = path.join(vaultDataFolder, 'entities', filename);
    console.log(`Saved entity ${entity.name} to ${filepath}`);
    await fs.writeFile(filepath, JSON.stringify(entity, null, 2));
}


export async function generateVaultData(page: Page, summariesFolder: string, vaultDataFolder: string) {
    // create the log folder if it doesn't exist
    await fs.mkdir(path.join(vaultDataFolder, 'log'), { recursive: true });
    // create the entities folder if it doesn't exist
    await fs.mkdir(path.join(vaultDataFolder, 'entities'), { recursive: true });


    const sessionFolders = (await fs.readdir(summariesFolder, { withFileTypes: true })).filter(dirent => dirent.isDirectory())
    .filter(dirent => dirent.name.match(/^\d{4}-\d{2}-\d{2}$/))
    .sort((a, b) => a.name.localeCompare(b.name));

    // load existing vault data
    console.log('Loading existing vault entities...');
    const existingSessions = await fs.readdir(path.join(vaultDataFolder, 'log'), { withFileTypes: true });
    // read all json files and create a map of session dates to session data
    const existingSessionsMap: Record<string, SessionData> = {};
    for (const file of existingSessions) {
        const sessionData = JSON.parse(await fs.readFile(path.join(vaultDataFolder, 'log', file.name), 'utf8')) as SessionData;
        existingSessionsMap[sessionData.date] = sessionData;
    }

    // load existing entities
    const existingEntities = await fs.readdir(path.join(vaultDataFolder, 'entities'), { withFileTypes: true });
    // read all json files and create a list of entity data
    const existingEntitiesList: EntityData[] = [];
    for (const file of existingEntities) {
        console.log(`Loading existing entity ${file.name}`);
        const entityData = JSON.parse(await fs.readFile(path.join(vaultDataFolder, 'entities', file.name), 'utf8')) as EntityData;
        existingEntitiesList.push(entityData);
    }

    // for any sessions that don't have a corresponding session data, create a new session data object
    for (const sessionFolder of sessionFolders) {
        const sessionDate = sessionFolder.name;
        if (!existingSessionsMap[sessionDate]) {
            const sessionData = await parseSessionData(page, sessionDate, path.join(summariesFolder, sessionFolder.name), existingEntitiesList, vaultDataFolder);
            existingSessionsMap[sessionDate] = sessionData;
            await fs.writeFile(path.join(vaultDataFolder, 'log', `${sessionDate}.json`), JSON.stringify(sessionData, null, 2));
        }
    }

    console.log('Vault data generation complete');
    
}


async function parseSessionData(page: Page, date: string, sessionFolder: string, existingEntitiesList: EntityData[], vaultDataFolder: string): Promise<SessionData> {
    const sessionData = JSON.parse(await fs.readFile(path.join(sessionFolder, 'merged.json'), 'utf8')) as SessionChunkSummary;

    console.log(`Parsing session data for ${date}`);
    console.log(`Session data: ${JSON.stringify(sessionData, null, 2)}`);

    for (const newEntityName of Object.keys(sessionData.entities)) {
        // await page.goto('https://chatgpt.com', { waitUntil: "networkidle2", timeout: 60000 });
        console.log(`Parsing entity ${newEntityName}`);
        const newEntity = sessionData.entities[newEntityName];
        // look for an existing entity, check name, and aliases
        console.log(`Looking for existing entity ${newEntityName}`);
        const existingEntity = existingEntitiesList.find(entity => entity.name === newEntityName || entity.aliases.includes(newEntityName));

        if (existingEntity && entityProcessedForSession(existingEntity, date)) {
            console.log(`Skipping entity ${newEntityName} — already processed for ${date}`);
            continue;
        }

        if (existingEntity) {
            // update the existing entity
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
            // create a new entity
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
            // delete log from the data passed to the prompt without modifying the original data
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

    const sessionDataForPrompt = JSON.parse(JSON.stringify(sessionData));
    delete sessionDataForPrompt.misTranscriptions;
    delete sessionDataForPrompt.openQuestions;
    delete sessionDataForPrompt.newTerms;

    // update the session data
    const sessionDataToSave: SessionData = {
        date: date,
        // summary: '', // TODO: generate summary
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
        log: sessionData.chronologicalEvents, // TODO: generate log
        openQuestions: sessionData.openQuestions,
    };

    return sessionDataToSave;
}

async function main() {
    console.log('Starting vault data generation...');
    const browser = await getBrowser();
    const pages = await browser.pages();
    const page = pages[0] ?? await browser.newPage();

    const url = "https://chatgpt.com";
    await page.goto(url, { waitUntil: "networkidle2" });
    console.log('Generating vault data...');
    await generateVaultData(page, 'summaries', 'vault-data');
}

// run the main function if this file is being run directly using modules
if (import.meta.url === new URL(import.meta.url).href) {
    main();
}
