import type { EntityData, SessionData } from "./vault-data.ts";
import fs from 'fs/promises';
import path from 'path';
import { isDirectRun } from "./is-main.ts";
import {
    copyLeftoverExistingFiles,
    existingNoteRelativePath,
    mergeEntityFrontmatter,
    mergeIndexFrontmatter,
    readExistingNote,
    rewriteWikilinks,
    serializeFrontmatter,
    splitFrontmatter,
    buildEntityLinkIndex,
} from "./existing-vault.ts";

export async function generateMarkdown(vaultDataFolder: string, vaultOutputFolder: string) {
    const existingRoot = path.join(vaultDataFolder, 'existing');

    // ensure the output folder and sub folders exist
    await fs.mkdir(vaultOutputFolder, { recursive: true });
    await fs.mkdir(path.join(vaultOutputFolder, 'log'), { recursive: true });

    // load all entity data into list
    const entityDataList: EntityData[] = [];
    const entitiesPaths = await fs.readdir(path.join(vaultDataFolder, 'entities'), { withFileTypes: true });
    for (const entityPath of entitiesPaths) {
        if (!entityPath.isFile() || !entityPath.name.endsWith('.json')) continue;
        const entityData = JSON.parse(await fs.readFile(path.join(vaultDataFolder, 'entities', entityPath.name), 'utf8')) as EntityData;
        entityDataList.push(entityData);
    }

    const linkIndex = buildEntityLinkIndex(entityDataList);

    const sessionsPaths = await fs.readdir(path.join(vaultDataFolder, 'log'), { withFileTypes: true });
    const sessions: SessionData[] = [];
    for (const sessionPath of sessionsPaths) {
        if (!sessionPath.isFile() || !sessionPath.name.endsWith('.json')) continue;
        const sessionData = JSON.parse(await fs.readFile(path.join(vaultDataFolder, 'log', sessionPath.name), 'utf8')) as SessionData;
        sessions.push(sessionData);
    }
    sessions.sort((a, b) => b.date.localeCompare(a.date));

    const writtenRelativePaths = new Set<string>();

    let sessionsMarkdown = '## Sessions\n\n';
    for (const sessionData of sessions) {
        const sessionSummary = await generateSessionFile(sessionData, vaultOutputFolder, entityDataList);
        sessionsMarkdown += `## [[log/${sessionData.date}|${sessionData.date}]]\n`;
        sessionsMarkdown += `${insertWikiLinks(sessionSummary, entityDataList)}\n`;
    }

    for (const entityData of entityDataList) {
        await generateEntityFile(entityData, vaultOutputFolder, entityDataList, existingRoot, linkIndex);
        writtenRelativePaths.add(entityData.filename.replaceAll('\\', '/'));
        const existingRel = existingNoteRelativePath(entityData);
        if (existingRel !== entityData.filename.replaceAll('\\', '/')) {
            writtenRelativePaths.add(existingRel);
        }
    }

    await generateIndexFile({
        existingRoot,
        vaultOutputFolder,
        sessionsMarkdown,
        entityDataList,
        linkIndex,
    });
    writtenRelativePaths.add('index.md');

    // Copy unmatched notes and images after entity/index writes so they never overwrite merges.
    await copyLeftoverExistingFiles({
        existingRoot,
        vaultOutputFolder,
        skipRelativePaths: writtenRelativePaths,
        entities: entityDataList,
    });
}

async function generateIndexFile(options: {
    existingRoot: string;
    vaultOutputFolder: string;
    sessionsMarkdown: string;
    entityDataList: EntityData[];
    linkIndex: ReturnType<typeof buildEntityLinkIndex>;
}) {
    const { existingRoot, vaultOutputFolder, sessionsMarkdown, entityDataList, linkIndex } = options;
    const defaultFrontmatter = { title: 'Archesof Atlas!' };
    const fallbackBody =
        '# Welcome to the world of Atlas!\n\n' +
        'Join our party as we seek to collect all of the keystones and unlock their anient secrets.\n\n';

    const existingText = await readExistingNote(existingRoot, 'index.md');
    let frontmatter: Record<string, unknown> = { ...defaultFrontmatter };
    let body = fallbackBody;

    if (existingText != null) {
        const split = splitFrontmatter(existingText);
        frontmatter = mergeIndexFrontmatter(split.frontmatter, defaultFrontmatter);
        const existingBody = rewriteWikilinks(split.body, entityDataList, linkIndex).trimEnd();
        body = existingBody ? `${existingBody}\n\n` : fallbackBody;
    }

    const indexMarkdown = `${serializeFrontmatter(frontmatter)}\n${body}${sessionsMarkdown}`;
    await fs.writeFile(path.join(vaultOutputFolder, 'index.md'), indexMarkdown);
}

async function generateSessionFile(sessionData: SessionData, vaultOutputFolder: string, entityDataList: EntityData[]) {
    let markdown = `# ${sessionData.date}\n\n${sessionData.summary}\n\n## Session Overview\n\n`;
    for (const plotSection of sessionData.plotSections) {
        markdown += `### ${plotSection.title}\n\n${plotSection.bullets.map(bullet => `- ${bullet}`).join('\n')}\n\n`;
    }

    markdown += `## Log\n\n`;
    for (const logEntry of sessionData.log) {
        markdown += `- ${logEntry}\n`;
    }

    markdown += `## Open Questions\n\n`;
    for (const openQuestion of sessionData.openQuestions) {
        markdown += `- ${openQuestion}\n`;
    }

    markdown = insertWikiLinks(markdown, entityDataList);

    // save the markdown to the output folder
    await fs.writeFile(path.join(vaultOutputFolder, 'log', `${sessionData.date}.md`), markdown);


    return sessionData.summary;
}

async function generateEntityFile(
    entityData: EntityData,
    vaultOutputFolder: string,
    entityDataList: EntityData[],
    existingRoot: string,
    linkIndex: ReturnType<typeof buildEntityLinkIndex>,
) {
    const existingRel = existingNoteRelativePath(entityData);
    const existingText = await readExistingNote(existingRoot, existingRel);

    let existingFrontmatter = {};
    let existingBody = '';
    if (existingText != null) {
        const split = splitFrontmatter(existingText);
        existingFrontmatter = split.frontmatter;
        existingBody = rewriteWikilinks(split.body, entityDataList, linkIndex).trimEnd();
    }

    const frontmatter = serializeFrontmatter(
        mergeEntityFrontmatter(existingFrontmatter, entityData),
    );

    let generated = '';
    generated += `# ${entityData.name}\n\n${entityData.description}\n\n`;

    generated += `## Log\n\n`;
    const logEntries = [...entityData.log].sort((a, b) => b.date.localeCompare(a.date));
    for (const logEntry of logEntries) {
        generated += `### [[log/${logEntry.date}|${logEntry.date}]]\n ${logEntry.notes.map(note => `- ${note}`).join('\n')}\n`;
    }

    generated += `## Open Questions\n\n`;
    for (const openQuestion of entityData.openQuestions) {
        generated += `- ${openQuestion}\n`;
    }

    generated = insertWikiLinks(generated, entityDataList);

    const body = existingBody
        ? `${existingBody}\n\n${generated}`
        : generated;

    // ensure the output folder and sub folders exist
    await fs.mkdir(path.join(vaultOutputFolder, path.dirname(entityData.filename)), { recursive: true });

    const markdown = `${frontmatter}\n${body}`;

    // save the markdown to the output folder
    await fs.writeFile(path.join(vaultOutputFolder, entityData.filename), markdown);
}

function insertWikiLinks(text: string, entityDataList: EntityData[]) {
    for (const entityData of entityDataList) {
        const targetList = [...entityData.linkTargets, ...entityData.aliases, entityData.name]
            .map((t) => t.trim())
            .filter(Boolean);
        for (const target of targetList) {
            text = text.replaceAll(new RegExp(`\\b${escapeRegExp(target)}\\b`, 'gi'), `[[${entityData.filename.replace('.md', '')}|${entityData.name}]]`);
        }
    }
    return text;
}

function escapeRegExp(text: string): string {

    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }


async function main() {
    await generateMarkdown('vault-data', 'vault');
}

if (isDirectRun(import.meta.url)) {
    main();
}
