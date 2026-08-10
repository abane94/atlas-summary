import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// import { MergedSessionData, SessionChunkSummary } from './types/session.ts';
import { runJsonPrompt } from './chatgpt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));


//#region types
export interface SessionChunkSummary {
    /**
     * a conprehensive summary with important plot points of the events of the DND session. Formatted in a way that could be pasted into my notes
     * Thematic plot summary (the ### sections at the top).
     * Prefer sections over a flat list so themes survive merging.
     */
    plotSections: PlotSection[];
  
    /** Numbered chronological beat list — plain strings, already flattened. */
    chronologicalEvents: string[];
  
    /**
     * Character / concept / place / faction updates keyed by canonical name.
     * Use the best spelling you know (e.g. "Gerk", "Plymouth Gawater", "Mother's Prayer").
     * Do not include any entities that do not have any useful ifonrmation to go along with them. Or entites that the party already knows of and know all relevant information on.
     */
    entities: Record<string, EntityUpdate>;
  
    /** Likely ASR / spelling issues. Do not include any known misspellings/transcription issues */
    misTranscriptions: MisTranscription[];
  
    /** Session-level questions still open after this chunk. */
    openQuestions: string[];
  
    /** Newly introduced terms/concepts worth adding to campaign notes. */
    newTerms: NewTerm[];
  }
  
  export interface PlotSection {
    /** Section heading; use "Overview" if the source had no thematic headers. */
    title: string;
    /** Flatten nested bullets into one string each (include sub-detail in the same string if needed). */
    bullets: string[];
  }
  
  export interface EntityUpdate {
    /**
     * One-line prior context if the model restates known identity
     * (e.g. "Half-orc barbarian, party ambassador"). Empty string if none.
     */
    existing: string;
  
    /** Entity type that is being described **/
    entityType: 'Location' | 'NPC' | 'ITEM' | 'GROUP' | 'PLAYER' | 'CONCEPT' | 'OTHER';
  
    /** A description of the entity if it does not match an existing entityType option **/
    otherEntityType?: string;
  
    /**
     * Facts established or reinforced in this chunk.
     * Covers "New Information", "Updates", and "Confirmed Information".
     */
    notes: string[];
  
    /** Titles, roles, epithets gained or confirmed (e.g. "Child of the Tree"). */
    titles: string[];
  
    /** Personality, philosophy, motives stated this chunk. */
    personality: string[];
  
    /** Notable quotes or recurring themes attributed to this entity. */
    quotesThemes: string[];
  
    /** Unresolved questions specifically about this entity. */
    openQuestions: string[];
  }
  
  export interface MisTranscription {
    /** What the transcript said. */
    heard: string;
    /** Best guess for the intended term; empty string if unknown. */
    likely: string;
    /** Why / context. Empty string if none. */
    notes: string;
  }
  
  export interface NewTerm {
    name: string;
    /** Short definition / why it matters. */
    notes: string[];
  }



    export type MergedSessionData = SessionChunkSummary & {
        dedupedEntities: Record<string, EntityUpdate>;
    }
//#endregion

// function to parse recap and all summary-*.json files in the summaries folder in order into a list of objects, given the date string
// it looks in the dir, grabs the recap adds it to the list, then looks for summary-0,json, if it fings it, continue, otherwise check if the next summary exsits, to check for bad processing, or contine

function loadAllSummaries(date: string): SessionChunkSummary[] {
    let hasNext = true;
    let summaries = [];
    let i = 0;
    while (hasNext) {
        const summaryPath = path.join(__dirname, '..', 'summaries', `${date}`, `summary-${i}.json`);
        if (fs.existsSync(summaryPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
                summaries.push(data);
            } catch (error) {
                console.error(`Error parsing summary-${i}.json: ${error}`);
                hasNext = false;
                process.exit(1);
            }
            i++;

        } else {
            let next = i + 1;
            if (fs.existsSync(path.join(__dirname, '..', 'summaries', `${date}`, `summary-${next}.json`))) {
                i = next;
            } else {
                hasNext = false;
            }
        }
    }
    console.log(`Loaded ${summaries.length} summaries for ${date}`);
    return summaries;
}

function loadRecap(date: string): SessionChunkSummary {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'summaries', `${date}`, `recap.json`), 'utf8'));
}

export function generateSessionData(date: string): { recap: SessionChunkSummary, summaries: SessionChunkSummary[] } {
    const recap = loadRecap(date);
    const summaries = loadAllSummaries(date);
    return { recap, summaries };
}

export async function mergeSessionData(page: any, sessionData: { recap: SessionChunkSummary, summaries: SessionChunkSummary[] }): Promise<SessionChunkSummary> {
    const merged: MergedSessionData = {
        plotSections: [],
        chronologicalEvents: [],
        entities: {},
        dedupedEntities: {},
        misTranscriptions: [],
        openQuestions: [],
        newTerms: []
    }

    for (const summary of sessionData.summaries) {
        merged.plotSections.push(...summary.plotSections);
        merged.chronologicalEvents.push(...summary.chronologicalEvents);
        merged.misTranscriptions.push(...summary.misTranscriptions);
        merged.openQuestions.push(...summary.openQuestions);
        merged.newTerms.push(...summary.newTerms);  //// -------------


        for (const [key, value] of Object.entries(summary.entities)) {
            if (merged.entities[key]) {
                merged.entities[key].notes.push(...value.notes);
                merged.entities[key].titles.push(...value.titles);
                merged.entities[key].personality.push(...value.personality);
                merged.entities[key].quotesThemes.push(...value.quotesThemes);
                merged.entities[key].openQuestions.push(...value.openQuestions);
            } else {
                merged.entities[key] = value;
            }
        }
        const dedupedNewTerms: NewTerm[] = [];
        for (const newTerm of merged.newTerms) {
            let existing = dedupedNewTerms.find(term => term.name === newTerm.name);
            if (existing) {
                existing.notes.push(...newTerm.notes);
            } else {
                dedupedNewTerms.push({name: newTerm.name, notes: newTerm.notes});
            }
        }
        merged.newTerms = dedupedNewTerms;
    }

    const url = "https://chatgpt.com";
    await page.goto(url, { waitUntil: "networkidle2" });
    const entities = await runJsonPrompt(page, `
        This json blob below is a list of entities that have been updated in the session. This merge was done prgramatically, and you are tasked with reviewing the list and making sure that the entities are correct.
        Can you please return a new json blob that matches the original format, but mergeing any common etities and removing any duplicate information
        The out put should be json and only json following this iterface
        \`\`\`typescript
        export interface EntityUpdate {
            /**
             * One-line prior context if the model restates known identity
             * (e.g. "Half-orc barbarian, party ambassador"). Empty string if none.
             */
            existing: string;
        
            /** Entity type that is being described **/
            entityType: 'Location' | 'NPC' | 'ITEM' | 'GROUP' | 'PLAYER' | 'CONCEPT' | 'OTHER';
        
            /** A description of the entity if it does not match an existing entityType option **/
            otherEntityType?: string;
        
            /**
             * Facts established or reinforced in this chunk.
             * Covers "New Information", "Updates", and "Confirmed Information".
             */
            notes: string[];
        
            /** Titles, roles, epithets gained or confirmed (e.g. "Child of the Tree"). */
            titles: string[];
        
            /** Personality, philosophy, motives stated this chunk. */
            personality: string[];
        
            /** Notable quotes or recurring themes attributed to this entity. */
            quotesThemes: string[];
        
            /** Unresolved questions specifically about this entity. */
            openQuestions: string[];
        }

        export interface Output{
            entities: Record<string: EntityName, EntityUpdate>;
        }
        \`\`\`

        ${JSON.stringify(merged.entities, null, 4)}
    `);

    await page.goto(url, { waitUntil: "networkidle2" });
    const terms = await runJsonPrompt(page, `
        This json blob below is a list of terms that have been updated in the session. This merge was done prgramatically,
        Can you please return a new json blob that matches the original format, but mergeing any common terms and removing any duplicate information
        The out put should be json and only json following this iterface
        \`\`\`typescript
        export interface Term {
            /** The name of the term or concept, normalized if possible **/
            name: string;
            /** Short definition / why it matters.  List could have duplicate information, remove any thing that is repeated, but keep the most important information*/
            notes: string[];
        }

        export interface Output{
            terms: Term[];
        }
        \`\`\`

        ${JSON.stringify(merged.entities, null, 4)}
    `);
    merged.dedupedEntities = entities.entities;
    (merged as any).dedupedTerms = terms.terms;
    return merged;
}