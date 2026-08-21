/**
 * Shared closed tag catalog for vault entities.
 * Do not duplicate entity types (npc, location, …) — markdown already appends type.
 */

export const CLOSED_ENTITY_TAGS = [
    // People
    "deity",
    "companion",
    "antagonist",
    // Lore / roles
    "title",
    "prophecy",
    "spell",
    // Places
    "realm",
    "settlement",
    "landmark",
    // Objects / groups
    "artifact",
    "people",
    "order",
] as const;

export type ClosedEntityTag = (typeof CLOSED_ENTITY_TAGS)[number];

export const CLOSED_ENTITY_TAG_SET: ReadonlySet<string> = new Set(CLOSED_ENTITY_TAGS);

export const MAX_ENTITY_TAGS = 3;

export interface SuggestedTag {
    tag: string;
    reason: string;
    exampleEntities: string[];
}

export interface TagValidationResult {
    /** Normalized unique tags (closed first, then extras). Prefer ≤ MAX_ENTITY_TAGS. */
    tags: string[];
    /** Tags not in the closed list (still kept on the entity). */
    extras: string[];
    /**
     * Implicit suggestions for unknown tags when the model omitted suggestedTags.
     * Caller may merge these into session-level suggestions.
     */
    implicitSuggestions: SuggestedTag[];
}

/** Lowercase kebab-case; empty string if nothing useful remains. */
export function normalizeTag(raw: string): string {
    return raw
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

export function isClosedTag(tag: string): boolean {
    return CLOSED_ENTITY_TAG_SET.has(tag);
}

/**
 * Normalize, dedupe, and split closed vs extra tags.
 * Empty / duplicate inputs are dropped. Prefer ≤ MAX_ENTITY_TAGS (closed first).
 * Never invent tags — only keep what was provided.
 */
export function validateEntityTags(
    rawTags: unknown,
    options: { entityName?: string; maxTags?: number } = {},
): TagValidationResult {
    const maxTags = options.maxTags ?? MAX_ENTITY_TAGS;
    const entityName = options.entityName ?? "";
    const list = Array.isArray(rawTags) ? rawTags : [];

    const closed: string[] = [];
    const extras: string[] = [];
    const seen = new Set<string>();

    for (const item of list) {
        if (typeof item !== "string") continue;
        const tag = normalizeTag(item);
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        if (isClosedTag(tag)) {
            closed.push(tag);
        } else {
            extras.push(tag);
        }
    }

    // Prefer closed tags when trimming to max.
    const ordered = [...closed, ...extras];
    const tags = ordered.slice(0, maxTags);
    const keptExtras = tags.filter((t) => !isClosedTag(t));

    const implicitSuggestions: SuggestedTag[] = keptExtras.map((tag) => ({
        tag,
        reason: "Used on an entity but not in the closed catalog; consider promoting if it recurs.",
        exampleEntities: entityName ? [entityName] : [],
    }));

    return { tags, extras: keptExtras, implicitSuggestions };
}

/** Union tags without wiping; never replace a non-empty set with empty input. */
export function unionTags(existing: string[], incoming: unknown): string[] {
    const incomingList = Array.isArray(incoming) ? incoming : [];
    if (incomingList.length === 0) {
        return validateEntityTags(existing).tags;
    }
    return validateEntityTags([...existing, ...incomingList]).tags;
}

export function mergeSuggestedTags(
    existing: SuggestedTag[],
    incoming: SuggestedTag[],
): SuggestedTag[] {
    const byTag = new Map<string, SuggestedTag>();

    const add = (item: SuggestedTag) => {
        const tag = normalizeTag(item.tag);
        if (!tag) return;
        const prev = byTag.get(tag);
        if (!prev) {
            byTag.set(tag, {
                tag,
                reason: (item.reason || "").trim(),
                exampleEntities: uniqueStrings(item.exampleEntities ?? []),
            });
            return;
        }
        const reasons = [prev.reason, (item.reason || "").trim()].filter(Boolean);
        byTag.set(tag, {
            tag,
            reason: uniqueStrings(reasons).join("; "),
            exampleEntities: uniqueStrings([
                ...prev.exampleEntities,
                ...(item.exampleEntities ?? []),
            ]),
        });
    };

    for (const item of existing) add(item);
    for (const item of incoming) add(item);
    return [...byTag.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}

export function parseSuggestedTags(raw: unknown): SuggestedTag[] {
    if (!Array.isArray(raw)) return [];
    const out: SuggestedTag[] = [];
    for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const tag = typeof obj.tag === "string" ? normalizeTag(obj.tag) : "";
        if (!tag) continue;
        const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
        const examples = Array.isArray(obj.exampleEntities)
            ? obj.exampleEntities.filter((e): e is string => typeof e === "string")
            : [];
        out.push({ tag, reason, exampleEntities: uniqueStrings(examples) });
    }
    return out;
}

function uniqueStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of values) {
        const t = v.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
    }
    return out;
}

/** Markdown snippet for AI prompts (vault entity tagging, tags backfill). */
export function buildTagCatalogPromptSection(): string {
    const lines = [
        "## Entity tags (closed catalog)",
        "",
        "Assign 0–3 tags per entity from this closed list when they clearly apply.",
        "Skip tags when nothing fits. Do not invent tags for the sake of tagging.",
        "Prefer the closed list. Extra tags are allowed only when a real facet is missing.",
        "Do **not** use entity types as tags (npc, location, item, group, player, concept, other) — type is stored separately.",
        "",
        "Closed tags:",
        ...CLOSED_ENTITY_TAGS.map((t) => `- \`${t}\``),
        "",
        "Also return session-level `suggestedTags` for terms that should be **considered for promotion** into this closed list (not automatic adds).",
        "Each suggestion: `{ tag, reason, exampleEntities }`. Use `[]` when none.",
    ];
    return lines.join("\n");
}
