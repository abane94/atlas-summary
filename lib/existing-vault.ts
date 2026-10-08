import fs from 'fs/promises';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
    normalizeEntityName,
    type EntityData,
} from './vault-data.ts';

export type Frontmatter = Record<string, unknown>;

export interface SplitNote {
    frontmatter: Frontmatter;
    body: string;
    /** True when a `---` block was present (even if it failed to parse as an object). */
    hadFrontmatter: boolean;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Split optional YAML frontmatter from a markdown note. Never throws. */
export function splitFrontmatter(text: string): SplitNote {
    const match = text.match(FRONTMATTER_RE);
    if (!match) {
        return { frontmatter: {}, body: text, hadFrontmatter: false };
    }
    const raw = match[1] ?? '';
    const body = text.slice(match[0].length);
    try {
        const parsed = parseYaml(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return {
                frontmatter: parsed as Frontmatter,
                body,
                hadFrontmatter: true,
            };
        }
    } catch {
        // keep body; ignore invalid YAML
    }
    return { frontmatter: {}, body, hadFrontmatter: true };
}

function asStringList(value: unknown): string[] {
    if (value == null) return [];
    if (Array.isArray(value)) {
        return value.map((v) => String(v).trim()).filter(Boolean);
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed ? [trimmed] : [];
    }
    return [];
}

function unionStrings(...lists: string[][]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const list of lists) {
        for (const item of list) {
            const key = item.trim();
            if (!key) continue;
            const lower = key.toLowerCase();
            if (seen.has(lower)) continue;
            seen.add(lower);
            out.push(key);
        }
    }
    return out;
}

/** One-line description suitable for YAML frontmatter. */
export function oneLineDescription(description: string): string {
    return description.replaceAll('\n', ' ').trim();
}

/** Merge entity-derived fields over existing frontmatter. Entity scalars win. */
export function mergeEntityFrontmatter(
    existing: Frontmatter,
    entity: EntityData,
): Frontmatter {
    const typeTag = String(entity.type).toLowerCase();
    return {
        ...existing,
        name: entity.name,
        title: entity.name,
        type: entity.type,
        description: oneLineDescription(entity.description),
        tags: unionStrings(asStringList(existing.tags), entity.tags ?? [], [typeTag]),
        aliases: unionStrings(asStringList(existing.aliases), entity.aliases ?? []),
        createdAt: entity.createdAt,
        updatedAt: entity.updatedAt,
        slug: entity.slug,
    };
}

/**
 * Merge index frontmatter. Generated defaults fill only missing keys
 * (hand-written title wins).
 */
export function mergeIndexFrontmatter(
    existing: Frontmatter,
    defaults: Frontmatter,
): Frontmatter {
    const out: Frontmatter = { ...defaults, ...existing };
    return out;
}

/** Serialize frontmatter to a `---` YAML block ending with a trailing newline. */
export function serializeFrontmatter(data: Frontmatter): string {
    const yaml = stringifyYaml(data, {
        lineWidth: 0,
        defaultKeyType: 'PLAIN',
        defaultStringType: 'PLAIN',
    }).trimEnd();
    return `---\n${yaml}\n---\n`;
}

export function entityLinkPath(entity: EntityData): string {
    return entity.filename.replace(/\.md$/i, '').replaceAll('\\', '/');
}

interface WikilinkMatch {
    target: string;
    alias: string | null;
    heading: string;
}

function parseWikilinkInner(inner: string): WikilinkMatch {
    let alias: string | null = null;
    let rest = inner;
    const pipe = rest.indexOf('|');
    if (pipe >= 0) {
        alias = rest.slice(pipe + 1);
        rest = rest.slice(0, pipe);
    }
    let heading = '';
    const hash = rest.indexOf('#');
    if (hash >= 0) {
        heading = rest.slice(hash);
        rest = rest.slice(0, hash);
    }
    return { target: rest.trim(), alias, heading };
}

function basenameKey(target: string): string {
    const base = target.replace(/\\/g, '/').split('/').pop() ?? target;
    return normalizeEntityName(base.replace(/\.md$/i, ''));
}

/** Build lookup from normalized name / alias / path basename → entity (unique only). */
export function buildEntityLinkIndex(
    entities: EntityData[],
): Map<string, EntityData> {
    const candidates = new Map<string, EntityData | null>();

    const add = (key: string, entity: EntityData) => {
        if (!key) return;
        if (!candidates.has(key)) {
            candidates.set(key, entity);
            return;
        }
        if (candidates.get(key) !== entity) {
            candidates.set(key, null);
        }
    };

    for (const entity of entities) {
        add(normalizeEntityName(entity.name), entity);
        for (const alias of entity.aliases ?? []) {
            add(normalizeEntityName(alias), entity);
        }
        add(basenameKey(entityLinkPath(entity)), entity);
        add(normalizeEntityName(entityLinkPath(entity)), entity);
    }

    const index = new Map<string, EntityData>();
    for (const [key, entity] of candidates) {
        if (entity) index.set(key, entity);
    }
    return index;
}

/**
 * Rewrite display-name / old-path wikilinks to canonical entity paths.
 * Keeps the original display label. Leaves images and unmatched targets alone.
 * Already-canonical links are left unchanged.
 */
export function rewriteWikilinks(
    text: string,
    entities: EntityData[],
    linkIndex?: Map<string, EntityData>,
): string {
    const index = linkIndex ?? buildEntityLinkIndex(entities);
    return text.replace(/\[\[([^\]]+)\]\]/g, (full, inner: string) => {
        const { target, alias, heading } = parseWikilinkInner(inner);
        if (!target) return full;

        // Image / attachment links: leave alone
        if (/\.[a-z0-9]{2,5}$/i.test(target) && !/\.md$/i.test(target)) {
            return full;
        }

        const entity =
            index.get(normalizeEntityName(target)) ??
            index.get(basenameKey(target));
        if (!entity) return full;

        const canonical = entityLinkPath(entity);
        const canonicalNorm = normalizeEntityName(canonical);
        const targetNorm = normalizeEntityName(target.replace(/\.md$/i, ''));
        const targetBaseNorm = basenameKey(target);

        // Already pointing at this entity's path (with or without .md)
        if (
            targetNorm === canonicalNorm ||
            target.replace(/\.md$/i, '').replaceAll('\\', '/') === canonical
        ) {
            return full;
        }
        // Path that already ends with the canonical basename and folder — treat as canonical-ish
        if (targetBaseNorm === basenameKey(canonical) && target.includes('/')) {
            const withoutMd = target.replace(/\.md$/i, '').replaceAll('\\', '/');
            if (withoutMd === canonical) return full;
        }

        // Prefer an explicit alias; otherwise keep the original note title casing
        // (basename of the target), e.g. La-Rel / New Navel — not the entity JSON name.
        const label =
            alias ??
            (target.replace(/\\/g, '/').split('/').pop() ?? target).replace(/\.md$/i, '');
        return `[[${canonical}${heading}|${label}]]`;
    });
}

/** Relative path under `vault-data/existing` for an entity note, if any. */
export function existingNoteRelativePath(entity: EntityData): string {
    if (entity.existingFile) {
        return entity.existingFile.replaceAll('\\', '/');
    }
    return entity.filename.replaceAll('\\', '/');
}

export async function readExistingNote(
    existingRoot: string,
    relativePath: string,
): Promise<string | null> {
    const filepath = path.join(existingRoot, relativePath);
    try {
        return await fs.readFile(filepath, 'utf8');
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return null;
        throw err;
    }
}

async function walkFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return out;
        throw err;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '.obsidian') continue;
            out.push(...(await walkFiles(full)));
        } else if (entry.isFile()) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Copy files from the existing vault into the output folder, skipping
 * `.obsidian/`, entity notes already written, and `index.md`.
 * Markdown bodies get an in-memory wikilink rewrite; sources are never written.
 */
export async function copyLeftoverExistingFiles(options: {
    existingRoot: string;
    vaultOutputFolder: string;
    skipRelativePaths: Set<string>;
    entities: EntityData[];
}): Promise<void> {
    const { existingRoot, vaultOutputFolder, skipRelativePaths, entities } = options;
    const linkIndex = buildEntityLinkIndex(entities);
    const files = await walkFiles(existingRoot);

    for (const full of files) {
        const relative = path.relative(existingRoot, full).replaceAll('\\', '/');
        if (skipRelativePaths.has(relative)) continue;

        const dest = path.join(vaultOutputFolder, relative);
        await fs.mkdir(path.dirname(dest), { recursive: true });

        if (relative.toLowerCase().endsWith('.md')) {
            const text = await fs.readFile(full, 'utf8');
            const rewritten = rewriteWikilinks(text, entities, linkIndex);
            await fs.writeFile(dest, rewritten);
        } else {
            await fs.copyFile(full, dest);
        }
    }
}
