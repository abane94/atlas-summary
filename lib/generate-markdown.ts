import type { EntityData, SessionData } from "./vault-data.ts";
import fs from 'fs/promises';
import path from 'path';

export async function generateMarkdown(vaultDataFolder: string, vaultOutputFolder: string) {
    let indexFrontmatter = [
        '---',
        'title: Archesof Atlas!',
        '---',
    ].join('\n') + '\n\n';
    let indexMarkdown = `${indexFrontmatter} # Welcome to the world of Atlas!\n\n`;
    indexMarkdown += 'Join our party as we seek to collect all of the keystones and unlock their anient secrets.\n\n';
    indexMarkdown += '## Sessions\n\n';

    // ensure the output folder and sub folders     exist
    await fs.mkdir(vaultOutputFolder, { recursive: true });
    await fs.mkdir(path.join(vaultOutputFolder, 'log'), { recursive: true });

    // load all entity data into list
    const entityDataList: EntityData[] = [];
    const entitiesPaths = await fs.readdir(path.join(vaultDataFolder, 'entities'), { withFileTypes: true });
    for (const entityPath of entitiesPaths) {
        const entityData = JSON.parse(await fs.readFile(path.join(vaultDataFolder, 'entities', entityPath.name), 'utf8')) as EntityData;
        entityDataList.push(entityData);
    }


    const sessionsPaths = await fs.readdir(path.join(vaultDataFolder, 'log'), { withFileTypes: true });
    for (const sessionPath of sessionsPaths) {
        const sessionData = JSON.parse(await fs.readFile(path.join(vaultDataFolder, 'log', sessionPath.name), 'utf8')) as SessionData;
        const sessionSummary = await generateSessionFile(sessionData, vaultOutputFolder, entityDataList);
        indexMarkdown += `## [[log/${sessionData.date}|${sessionData.date}]]\n`;
        indexMarkdown += `${insertWikiLinks(sessionSummary, entityDataList)}\n`;
    }

    // const entitiesPaths = await fs.readdir(path.join(vaultDataFolder, 'entities'), { withFileTypes: true });
    // for (const entityPath of entitiesPaths) {
    //     const entityData = JSON.parse(await fs.readFile(path.join(vaultDataFolder, 'entities', entityPath.name), 'utf8')) as EntityData;
    //     await generateEntityFile(entityData, vaultOutputFolder);
    // }

    for (const entityData of entityDataList) {
        await generateEntityFile(entityData, vaultOutputFolder, entityDataList);
    }

    // save the index markdown to the output folder
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

async function generateEntityFile(entityData: EntityData, vaultOutputFolder: string, entityDataList: EntityData[]) {
    let frontmatter = [
        '---',
        `name: ${entityData.name}`,
        `title: ${entityData.name}`,
        `type: ${entityData.type}`,
        `description: ${entityData.description.replaceAll('\n', ' ').replaceAll(/[*\#\-_`~:|]/g, '')}`,
        `tags:\n${[...entityData.tags, entityData.type.toLowerCase()].map(t => `  - "${t}"`).join(', ')}`,
        `aliases: ${entityData.aliases.map(a => `  - "${a}"`).join(', ')}`,
        `createdAt: ${entityData.createdAt}`,
        `updatedAt: ${entityData.updatedAt}`,
        '---',
    ].join('\n') + '\n\n';

    let markdown = '';

    markdown += `# ${entityData.name}\n\n${entityData.description}\n\n`;

    markdown += `## Log\n\n`;
    for (const logEntry of entityData.log) {
        markdown += `### [[log/${logEntry.date}|${logEntry.date}]]\n ${logEntry.notes.map(note => `- ${note}`).join('\n')}\n`;
    }

    markdown += `## Open Questions\n\n`;
    for (const openQuestion of entityData.openQuestions) {
        markdown += `- ${openQuestion}\n`;
    }

    // ensure the output folder and sub folders exist
    await fs.mkdir(path.join(vaultOutputFolder, path.dirname(entityData.filename)), { recursive: true });

    markdown = insertWikiLinks(markdown, entityDataList);

    markdown = frontmatter + markdown;

    // save the markdown to the output folder
    await fs.writeFile(path.join(vaultOutputFolder, entityData.filename), markdown);
}

function insertWikiLinks(text: string, entityDataList: EntityData[]) {
    for (const entityData of entityDataList) {
        const targetList = [...entityData.linkTargets, entityData.name];
        for (const target of targetList) {
            text = text.replaceAll(new RegExp(escapeRegExp(target), 'gi'), `[[${entityData.filename.replace('.md', '')}|${entityData.name}]]`);
        }
    }
    return text;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }


// run the main function if this file is being run directly using modules
if (import.meta.url === new URL(import.meta.url).href) {
    main();
}

async function main() {
    await generateMarkdown('vault-data', 'vault');
}