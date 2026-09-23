import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// import { MergedSessionData, SessionChunkSummary } from './types/session.ts';
import type { AiClient } from './ai.js';

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
  
  /** One hearing from a single chunk. Grouping happens when the session is merged. */
  export interface MisTranscription {
    /** What the transcript said. One spelling, not a slash-joined list. */
    heard: string;
    /** Best guess for the intended term; empty string if unknown. */
    likely: string;
    /** Why / context. Empty string if none. */
    notes: string;
  }

  /** Same intended term across chunks, with every distinct hearing collected. */
  export interface DedupedMisTranscription {
    /** Best guess for the intended term. Empty string if still unknown. */
    likely: string;
    /** Distinct transcript spellings of this one term. */
    heard: string[];
    /** Combined context for the term and its hearings. */
    notes: string;
  }
  
  export interface NewTerm {
    name: string;
    /** Short definition / why it matters. */
    notes: string[];
  }



    export type MergedSessionData = Omit<SessionChunkSummary, "misTranscriptions"> & {
        dedupedEntities: Record<string, EntityUpdate>;
        misTranscriptions: DedupedMisTranscription[];
    }
//#endregion

// Parse all summary-*.json files in summaries/<date> in order.
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

export function generateSessionData(date: string): { summaries: SessionChunkSummary[] } {
    const summaries = loadAllSummaries(date);
    return { summaries };
}

export async function mergeSessionData(ai: AiClient, sessionData: { summaries: SessionChunkSummary[] }): Promise<MergedSessionData> {
    const flatMisTranscriptions: MisTranscription[] = [];
    const merged: MergedSessionData = {
        plotSections: [],
        chronologicalEvents: [],
        entities: {},
        dedupedEntities: {},
        misTranscriptions: [],
        openQuestions: [],
        newTerms: [],
    }

    for (const summary of sessionData.summaries) {
        merged.plotSections.push(...summary.plotSections);
        merged.chronologicalEvents.push(...summary.chronologicalEvents);
        flatMisTranscriptions.push(...summary.misTranscriptions);
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

    await ai.resetConversation();
    const plotSections = await ai.runJsonPrompt(`
        This json blob below is a list of plot sections that have been updated in the session.
        They were the outcome of baches of transcription summerization that was done prgramatically,
        There are likely many duplicates in the list, that may have similar but different names, or descriptions, or other information.
        and you are tasked with reviewing the list and combining any plot sections that are similar and removing any duplicates.
        and making sure that the plot sections are correct and the information is consistent, not duplicated, and concise.
        Can you please return a new json blob that matches the original format, but mergeing any common plot sections and removing any duplicate information
        The out put should be json and only json following this iterface
        \`\`\`typescript
        export interface PlotSection {
            /** Section heading; use "Overview" if the source had no thematic headers. */
            title: string;
            /** Flatten nested bullets into one string each (include sub-detail in the same string if needed). */
            bullets: string[];
        }
        export interface Output{
            plotSections: PlotSection[];
        }
        \`\`\`
        ${JSON.stringify(merged.plotSections, null, 4)}
    `, { timeout: 60_000, effort: "medium" });
    console.log(plotSections);
    merged.plotSections = JSON.parse(plotSections).plotSections;

    await ai.resetConversation();
    const chronologicalEvents = await ai.runJsonPrompt(`
        This json blob below is a list of chronological events that have been updated in the session. This merge was done prgramatically,
        Can you please return a new json blob that matches the original format, but mergeing any common chronological events and removing any duplicate information
        The out put should be json and only json following this iterface
        \`\`\`typescript
        export interface ChronologicalEvent {
            events: string[];
        }
        \`\`\`
        ${JSON.stringify(merged.chronologicalEvents, null, 4)}  
    `, { timeout: 60_000, effort: "medium" });
    merged.chronologicalEvents = JSON.parse(chronologicalEvents).events;


    await ai.resetConversation();
    const entities = await ai.runJsonPrompt(`
        This json blob below is a list of entities that have been updated in the session.
        They were the outcome of baches of transcription summerization that was done prgramatically,
        There are likely many duplicates in the list, that may have similar but different names, or descriptions, or other information.
        and you are tasked with reviewing the list and combining any entities that are similar and removing any duplicates.
        and making sure that the entities are correct and the information is consistent, not duplicated, and concise.
        Can you please return a new json blob that matches the original format,
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
            entities: Record<string, EntityUpdate>;
        }
        \`\`\`

        ${JSON.stringify(merged.entities, null, 4)}
    `, { timeout: 60_000, effort: "medium" });

    await ai.resetConversation();
    const terms = await ai.runJsonPrompt(`
        This json blob below is a list of terms that have been updated in the session.
        They were the outcome of baches of transcription summerization that was done prgramatically,
        There are likely many duplicates in the list, that may have similar but different names, or descriptions, or other information.
        and you are tasked with reviewing the list and combining any terms that are similar and removing any duplicates.
        and making sure that the terms are correct and the information is consistent, not duplicated, and concise.
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

        ${JSON.stringify(merged.newTerms, null, 4)}
    `, { timeout: 60_000, effort: "medium" });

    await ai.resetConversation();
    const misTranscriptions = await ai.runJsonPrompt(`
        This json blob is every mis-transcription reported from the chunk summaries of one session.
        Each row is one hearing: what the transcript said (heard), the best guess (likely, or "" if unknown), and why (notes).
        The same term was often reported more than once, with a different heard spelling and a repeated or conflicting note.

        Group rows that are the same intended term. Return one object per term, not one object per hearing.

        Rules:
        - Group by the intended term, not by the heard string. "Carlton", "Carl can", and "Carla Kid" with likely "Carlkin" are one group.
        - Treat likely values as the same term when they differ only by case, spacing, or punctuation.
        - If one row stuffed several terms into heard and likely with slashes (heard "horde room / Haven Horde", likely "hoard room / Haven Hold"), split them into separate groups. Pair each heard fragment with the likely fragment in the same position.
        - Rows with an empty likely stay unknown. Group those only when they are the same phrase or obvious variants of one unknown. Do not put every unknown into one group.
        - heard is the list of distinct transcript strings for that one term. Drop exact duplicates. Keep meaningfully different spellings.
        - likely is the best spelling already present in the inputs. Use "" when the inputs never named one. Do not invent a correction.
        - notes is a single string. Join the useful context, drop repeated sentences, and keep disagreements when the inputs conflict.
        - Leave out rows that are not transcription issues.

        The output should be json and only json following this interface
        \`\`\`typescript
        export interface DedupedMisTranscription {
            /** Best guess for the intended term. Empty string if still unknown. */
            likely: string;
            /** Distinct transcript spellings of this one term. */
            heard: string[];
            /** Combined context for the term and its hearings. */
            notes: string;
        }

        export interface Output {
            misTranscriptions: DedupedMisTranscription[];
        }
        \`\`\`

        ${JSON.stringify(flatMisTranscriptions, null, 4)}
    `, { timeout: 90_000, effort: "medium" });

    merged.entities = JSON.parse(entities).entities;
    merged.newTerms = JSON.parse(terms).terms;
    merged.misTranscriptions = JSON.parse(misTranscriptions).misTranscriptions;
    return merged;
}