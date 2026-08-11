# DND Recap Transcription summarization

The following is chunk from a trascription of a discrod session for a DND session.
I want to note up top that the transcription can be faulty, escpeccially since we are using un common or made up. The names of characters might especcially be misheard.
We have a tendency to get off topic, so please do not include anything that is not dnd related or related to the story.

## Characters

In this transcript we have a set of users who play characters, and our Dongeon Master (tongatank) who narrerates and voices several non-player characters

### Player charactrers

The transcription uses discord screen names, but here is a table mapping users screen name to real in person name, and DND charactrer name. The players some times switch between first person and third person when voicing what there character says or does.


| Screen name          | real name | character name  | Notes                                                             |
| -------------------- | --------- | --------------- | ----------------------------------------------------------------- |
| tongatank            | k         | *variouse* *dm* | DM                                                                |
| Skeletorrrrrrrrrr    | Ian       | Gerk            | Half Orc barbarian, party ambassedor                              |
| "Triple Champ"-E-Tan | Theron    | Sylan           | Las name: Ivellio. Half elf rouge                                                    |
| bbobrien             | Brennan   | Walker          | Half elf dragon rider & fighter. Glimmen is his mind lined dragon |
| Kyle                 | Kyle      | Ciri            | Half elf rouge (Ciri is a girl, kyle is not)                      |
| abane94              | Aris      | Ord             | Dragon born paladin                                               |
| Beccaaaaa            | Becca     | Dana            | Half elf cleric, most knowledgeable of the group                  |




### Non-Player Characters

These characters would be all voiced by tongatank the DM. It maybe difficult to determin which character is speaking through tongatank at any given time, but try to pick up form context clues.


| Character        | notes                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------- |
| Ben              | AKA Ballard - minor diety. Our friend who runs the travelling bar. Keeper of the watchers   |
| Mahali           | Elder god. Our chef                                                                         |
| Narul            | AKA the stranger. Elder god. Previous god of death                                          |
| Raven Queen      | AKA Nira. God of the dead. Elder god                                                        |
| Vecna            | God of liches. Elder god                                                                    |
| Elrus            |                                                                                             |
| Araden           |                                                                                             |
| Kit Anger        |                                                                                             |
| Juten Prime      | one of the original keepers of the key stones                                               |
| Plymouth Gawater | Gnome artificer, friend of the party.                                                       |
| Kar              | a very power entity. we are not entirly sure but he seems to be the main antagonist         |
| Grixto           | A proxy of Kar. Also know as "Karr the enlightened one" "the enlightened one" "The emporer" |
| Galixtar         | The dragon of grixto                                                                        |
| Nevarr           | A writer and explorer. We have never met, but we know of this tombs (books)                 |


### Vocab & Concepts

Some these may be useful in identifying incorrect transcripton (based on spelling) or concepts that have meaning that could help determin context. Use these and character names to understand transcriptions errors.

- key stones - physical stones that open doors to the different realms
- atlas - the world - includes all realms
- Juten, Jotunheim - a reace and their home land
- Navi - an acient race
- Atlas - the name of the world. It is made up the following "archs" (realms)
- - The Reach
- - La-rel
- - Pitel
- - Feldspar
- - Gilbrick
- - Mitgar
- - Lith
- Astral Sea the space around and between the arches
- Langdale - the region that the party calls home
- Arch a realm in Atlas


## Output

- a discrete list of any characters or vocab/conncepts that I did not list that should be called out. For any Character or concept that was discussed include a discrete section for any updates/information uncovered during the session. as I will keep note pages for them and will updates the note pages
- Include a list of terms that you think maybe mis-transcribed that I can provide clarity on for next time
- Always return JSON matching SessionChunkSummary; every array/object field present even when empty.
- Canonicalize entity keys (Gerk not Girk / Burke when you know better); put ASR confusion in misTranscriptions.
- Put plot under plotSections, not only under chronology — chronology is the beat list, plot is the thematic write-up.
- Prefer flat strings in bullets / notes (no nested objects) so merging is just concat + optional dedupe.
- Do not invent empty entity entries for characters who didn’t appear; only keys with real content.
- return only the json.
- character/concepts updates should be in both summaries (prose and bullets) as well as the character/concept updates sections

```typescript
/** One chunk summary (e.g. summary-0 … summary-13). Always emit every field; use [] / {} when empty. */
export interface SessionChunkSummary {
  /**
   * a conprehensive summary with important plot points of the events of the DND session. Formatted in a way that could be pasted into my notes
   * Thematic plot summary (the ### sections at the top).
   * Prefer sections over a flat list so themes survive merging.
   * Keep this section for important information, do not be more verbose than needed.
   */
  plotSections: PlotSection[];

  /** Numbered chronological beat list — plain strings, already flattened. Do not include unneeded infomration or small things that seem irrelavant */
  chronologicalEvents: string[];

  /**
   * Character / concept / place / faction updates keyed by canonical name.
   * Use the best spelling you know (e.g. "Gerk", "Plymouth Gawater", "Mother's Prayer").
   * Do not include any entities that do not have any useful ifonrmation to go along with them. Or entites that the party already knows of and know all relevant information on.
   */
  entities: Record<string, EntityUpdate>;

  /** Likely ASR / spelling issues. Do not include any known misspellings/transcription issues */
  misTranscriptions: MisTranscription[];

  /** Session-level questions still open after this chunk. These should be questions that expecitly come up, not questions that you come up with because of missing information*/
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

  /** Unresolved questions specifically about this entity. These should be questions that explicitly come up, no questions that you use for filling in unknown information. */
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

```



# Transcript

