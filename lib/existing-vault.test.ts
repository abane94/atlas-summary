import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    mergeEntityFrontmatter,
    mergeIndexFrontmatter,
    rewriteWikilinks,
    serializeFrontmatter,
    splitFrontmatter,
    oneLineDescription,
} from './existing-vault.ts';
import type { EntityData } from './vault-data.ts';

function makeEntity(overrides: Partial<EntityData> = {}): EntityData {
    return {
        slug: 'test-slug',
        name: 'New Navel',
        tags: ['settlement'],
        aliases: ['Navel'],
        normalizedAliases: ['new navel', 'navel'],
        filename: 'entities/location/new_navel.md',
        description: 'A familiar stop: traders come here.',
        type: 'LOCATION',
        log: [],
        openQuestions: [],
        linkTargets: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        ...overrides,
    };
}

describe('splitFrontmatter', () => {
    it('returns empty frontmatter when none present', () => {
        const split = splitFrontmatter('Hello\n\nWorld');
        assert.deepEqual(split.frontmatter, {});
        assert.equal(split.body, 'Hello\n\nWorld');
        assert.equal(split.hadFrontmatter, false);
    });

    it('parses YAML frontmatter', () => {
        const split = splitFrontmatter('---\ntitle: Hi\ntags:\n  - a\n---\n\nBody');
        assert.equal(split.frontmatter.title, 'Hi');
        assert.deepEqual(split.frontmatter.tags, ['a']);
        assert.equal(split.body, '\nBody');
        assert.equal(split.hadFrontmatter, true);
    });

    it('keeps body when YAML is not an object', () => {
        const split = splitFrontmatter('---\n- just\n- a list\n---\nBody');
        assert.deepEqual(split.frontmatter, {});
        assert.equal(split.body, 'Body');
        assert.equal(split.hadFrontmatter, true);
    });
});

describe('mergeEntityFrontmatter', () => {
    it('lets entity scalars win and unions tags/aliases', () => {
        const merged = mergeEntityFrontmatter(
            {
                title: 'Old Title',
                custom: 'keep-me',
                tags: ['map'],
                aliases: ['Rita'],
            },
            makeEntity(),
        );
        assert.equal(merged.name, 'New Navel');
        assert.equal(merged.title, 'New Navel');
        assert.equal(merged.type, 'LOCATION');
        assert.equal(merged.custom, 'keep-me');
        assert.deepEqual(merged.tags, ['map', 'settlement', 'location']);
        assert.deepEqual(merged.aliases, ['Rita', 'Navel']);
        assert.equal(merged.slug, 'test-slug');
        assert.equal(merged.description, oneLineDescription(makeEntity().description));
    });

    it('works with missing frontmatter', () => {
        const merged = mergeEntityFrontmatter({}, makeEntity({ tags: [], aliases: [] }));
        assert.deepEqual(merged.tags, ['location']);
        assert.deepEqual(merged.aliases, []);
    });
});

describe('mergeIndexFrontmatter', () => {
    it('keeps hand-written title over default', () => {
        const merged = mergeIndexFrontmatter(
            { title: 'My Atlas' },
            { title: 'Archesof Atlas!' },
        );
        assert.equal(merged.title, 'My Atlas');
    });

    it('fills title when missing', () => {
        const merged = mergeIndexFrontmatter({}, { title: 'Archesof Atlas!' });
        assert.equal(merged.title, 'Archesof Atlas!');
    });
});

describe('rewriteWikilinks', () => {
    const entities = [
        makeEntity(),
        makeEntity({
            name: 'La-rel',
            aliases: [],
            filename: 'entities/location/la-rel.md',
            tags: [],
            normalizedAliases: ['la rel'],
        }),
        makeEntity({
            name: 'Langdale Stronghold',
            aliases: ['Stronghold'],
            filename: 'entities/location/langdale_stronghold.md',
            tags: [],
            normalizedAliases: ['langdale stronghold', 'stronghold'],
        }),
    ];

    it('rewrites display names while keeping the original label', () => {
        const out = rewriteWikilinks('See [[New Navel]] and [[La-Rel]]', entities);
        assert.equal(
            out,
            'See [[entities/location/new_navel|New Navel]] and [[entities/location/la-rel|La-Rel]]',
        );
    });

    it('rewrites old folder paths using the original basename as the label', () => {
        const out = rewriteWikilinks('[[locations/New Navel]]', entities);
        assert.equal(out, '[[entities/location/new_navel|New Navel]]');
    });

    it('preserves heading suffixes', () => {
        const out = rewriteWikilinks('[[New Navel#History]]', entities);
        assert.equal(out, '[[entities/location/new_navel#History|New Navel]]');
    });

    it('leaves images and unmatched notes alone', () => {
        const text = '[[atlas.png]] [[Mit-Gar]] [[Rita]] [[dalhurst.png]]';
        assert.equal(rewriteWikilinks(text, entities), text);
    });

    it('leaves already-canonical links unchanged', () => {
        const text = '[[entities/location/new_navel|New Navel]]';
        assert.equal(rewriteWikilinks(text, entities), text);
    });
});

describe('serializeFrontmatter', () => {
    it('emits a YAML block that round-trips colons in description', () => {
        const block = serializeFrontmatter({
            description: 'A stop: traders come here.',
            tags: ['location'],
        });
        assert.match(block, /^---\n/);
        assert.match(block, /---\n$/);
        const split = splitFrontmatter(`${block}\nBody`);
        assert.equal(split.frontmatter.description, 'A stop: traders come here.');
    });
});
