import type { EntityData, SessionData } from "./vault-data.ts";
import fs from 'fs/promises';
import path from 'path';

export async function generateMarkdown(vaultDataFolder: string, vaultOutputFolder: string) {
    let indexMarkdown = `# Welcome to the world of Atlas!\n\n`;
    indexMarkdown += 'Join our party as we seek to collect all of the keystones and unlock their anient secrets.\n\n';
    indexMarkdown += '## Sessions\n\n';

    // ensure the output folder and sub folders     exist
    await fs.mkdir(vaultOutputFolder, { recursive: true });
    await fs.mkdir(path.join(vaultOutputFolder, 'log'), { recursive: true });


    const sessionsPaths = await fs.readdir(path.join(vaultDataFolder, 'log'), { withFileTypes: true });
    for (const sessionPath of sessionsPaths) {
        const sessionData = JSON.parse(await fs.readFile(path.join(vaultDataFolder, 'log', sessionPath.name), 'utf8')) as SessionData;
        const sessionSummary = await generateSessionFile(sessionData, vaultOutputFolder);
        indexMarkdown += `## [${sessionData.date}](${path.join('log', sessionPath.name)})\n`;
        indexMarkdown += `${sessionSummary}\n`;
    }

    const entitiesPaths = await fs.readdir(path.join(vaultDataFolder, 'entities'), { withFileTypes: true });
    for (const entityPath of entitiesPaths) {
        const entityData = JSON.parse(await fs.readFile(path.join(vaultDataFolder, 'entities', entityPath.name), 'utf8')) as EntityData;
        await generateEntityFile(entityData, vaultOutputFolder);
    }

    // save the index markdown to the output folder
    await fs.writeFile(path.join(vaultOutputFolder, 'index.md'), indexMarkdown);
}

async function generateSessionFile(sessionData: SessionData, vaultOutputFolder: string) {
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

    // save the markdown to the output folder
    await fs.writeFile(path.join(vaultOutputFolder, 'log', `${sessionData.date}.md`), markdown);


    return sessionData.summary;
}

async function generateEntityFile(entityData: EntityData, vaultOutputFolder: string) {
    let frontmatter = [
        '---',
        `name: ${entityData.name}`,
        `type: ${entityData.type}`,
        `description: ${entityData.description}`,
        `tags:\n${[...entityData.tags, entityData.type.toLowerCase()].map(t => `  - "${t}"`).join(', ')}`,
        `aliases: ${entityData.aliases.map(a => `  - "${a}"`).join(', ')}`,
        `createdAt: ${entityData.createdAt}`,
        `updatedAt: ${entityData.updatedAt}`,
        '---',
    ].join('\n') + '\n\n';

    let markdown = frontmatter;

    markdown += `# ${entityData.name}\n\n${entityData.description}\n\n`;

    markdown += `## Log\n\n`;
    for (const logEntry of entityData.log) {
        markdown += `- ${logEntry.date} - ${logEntry.summary}\n`;
    }

    markdown += `## Open Questions\n\n`;
    for (const openQuestion of entityData.openQuestions) {
        markdown += `- ${openQuestion}\n`;
    }

    // ensure the output folder and sub folders exist
    await fs.mkdir(path.join(vaultOutputFolder, path.dirname(entityData.filename)), { recursive: true });

    // save the markdown to the output folder
    await fs.writeFile(path.join(vaultOutputFolder, entityData.filename), markdown);
}


// run the main function if this file is being run directly using modules
if (import.meta.url === new URL(import.meta.url).href) {
    main();
}

async function main() {
    await generateMarkdown('vault-data', 'vault');
}