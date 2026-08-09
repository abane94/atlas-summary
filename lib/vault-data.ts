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

export interface SessionData {
    date: string; // yyyy-mm-dd string
    summary: string;
    plotSections: PlotSection[];
    log: string[];
    openQuestions: string[];
}

export interface EntityData {
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


export async function generateVaultData(summariesFolder: string, vaultDataFolder: string) {
    // create the log folder if it doesn't exist
    await fs.mkdir(path.join(vaultDataFolder, 'log'), { recursive: true });
    // create the entities folder if it doesn't exist
    await fs.mkdir(path.join(vaultDataFolder, 'entities'), { recursive: true });


    const sessionFolders = (await fs.readdir(summariesFolder, { withFileTypes: true })).filter(dirent => dirent.isDirectory())
    .filter(dirent => dirent.name.match(/^\d{4}-\d{2}-\d{2}$/))
    .sort((a, b) => a.name.localeCompare(b.name));

    // load existing vault data
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
        const entityData = JSON.parse(await fs.readFile(path.join(vaultDataFolder, 'entities', file.name), 'utf8')) as EntityData;
        existingEntitiesList.push(entityData);
    }

    // for any sessions that don't have a corresponding session data, create a new session data object
    for (const sessionFolder of sessionFolders) {
        const sessionDate = sessionFolder.name;
        if (!existingSessionsMap[sessionDate]) {
            const {sessionData, entitiesToSave} = await parseSessionData(sessionDate, path.join(summariesFolder, sessionFolder.name), existingEntitiesList);
            existingSessionsMap[sessionDate] = sessionData;
            await fs.writeFile(path.join(vaultDataFolder, 'log', `${sessionDate}.json`), JSON.stringify(sessionData, null, 2));

            // write out all the entities using their filenames
            for (const entity of entitiesToSave) {
                console.log(`Writing entity ${entity.name} to ${path.join(vaultDataFolder, 'entities', `${entity.type.toLowerCase()}--${entity.name.toLowerCase().replaceAll(' ', '_').replace(/[/\\?%*:|"<>]/g, '__')}.json`)}`);  
                await fs.writeFile(path.join(vaultDataFolder, 'entities', `${entity.type.toLowerCase()}--${entity.name.toLowerCase().replaceAll(' ', '_').replace(/[/\\?%*:|"<>]/g, '__')}.json`), JSON.stringify(entity, null, 2));
            }
        }
    }

    // // write out all the entities using their filenames
    // for (const entity of existingEntitiesList) {
    //     console.log(`Writing entity ${entity.name} to ${path.join(vaultDataFolder, 'entities', `${entity.type.toLowerCase()}--${entity.name.toLowerCase().replaceAll(' ', '_').replace(/[/\\?%*:|"<>]/g, '__')}.json`)}`);  
    //     await fs.writeFile(path.join(vaultDataFolder, 'entities', `${entity.type.toLowerCase()}--${entity.name.toLowerCase().replaceAll(' ', '_').replace(/[/\\?%*:|"<>]/g, '__')}.json`), JSON.stringify(entity, null, 2));
    // }
    
}


async function parseSessionData(date: string, sessionFolder: string, existingEntitiesList: EntityData[]) {
    const sessionData = JSON.parse(await fs.readFile(path.join(sessionFolder, 'merged.json'), 'utf8')) as SessionChunkSummary;

    console.log(`Parsing session data for ${date}`);
    console.log(`Session data: ${JSON.stringify(sessionData, null, 2)}`);

    const newAndUpdatedEntities: EntityData[] = [];

    for (const newEntityName of Object.keys(sessionData.entities)) {
        console.log(`Parsing entity ${newEntityName}`);
        const newEntity = sessionData.entities[newEntityName];
        // look for an existing entity, check name, and aliases
        const existingEntity = existingEntitiesList.find(entity => entity.name === newEntityName || entity.aliases.includes(newEntityName));
        if (existingEntity) {
            // update the existing entity
            existingEntity.log.push({
                date: date,
                summary: '',
                notes: newEntity.notes.map(note => insertWikiLinks(note, existingEntitiesList)),
            });
            existingEntity.updatedAt = new Date().toISOString();
            newAndUpdatedEntities.push(existingEntity);
        } else {
            // create a new entity
            const newEntityData: EntityData = {
                name: newEntityName,
                tags: [],
                aliases: [],
                filename: path.join('entities', newEntity.entityType.toLowerCase(), newEntityName.toLowerCase().replaceAll(' ', '_').replace(/[/\\?%*:|"<>]/g, '__') + '.md'),
                description: '',
                type: newEntity.entityType,
                log: [{
                    date: sessionFolder,
                    summary: '',
                    notes: newEntity.notes.map(note => insertWikiLinks(note, existingEntitiesList)),
                }],
                openQuestions: newEntity.openQuestions,
                linkTargets: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            existingEntitiesList.push(newEntityData);
            newAndUpdatedEntities.push(newEntityData);
        }
    }

    // update the session data
    const sessionDataToSave: SessionData = {
        date: date,
        summary: '', // TODO: generate summary
        plotSections: sessionData.plotSections.map(section => ({
            title: section.title,
            bullets: section.bullets.map(bullet => insertWikiLinks(bullet, existingEntitiesList)),
        })),
        log: sessionData.chronologicalEvents.map(event => insertWikiLinks(event, existingEntitiesList)), // TODO: generate log
        openQuestions: sessionData.openQuestions.map(question => insertWikiLinks(question, existingEntitiesList)),
    };

    return { sessionData: sessionDataToSave, entitiesToSave: newAndUpdatedEntities };
}


function insertWikiLinks(text: string, entityData: EntityData[]) {
    for (const entity of entityData) {
        for (const linkTarget of entity.linkTargets) {
            text = text.replaceAll(linkTarget, `[[${entity.filename}|${linkTarget}]]`);
        }
    }
    return text;
}


async function main() {
    generateVaultData('summaries', 'vault-data');
}

// run the main function if this file is being run directly using modules
if (import.meta.url === new URL(import.meta.url).href) {
    main();
}