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
    entityType: 'LOCATION' | 'NPC' | 'ITEM' | 'GROUP' | 'PLAYER' | 'CONCEPT' | 'OTHER';
  
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