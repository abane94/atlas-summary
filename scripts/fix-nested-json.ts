import fs from 'fs';
import path from 'path';

// define __dirname for the script
const __dirname = path.dirname(new URL(import.meta.url).pathname);

const vaultDataFolder = path.join(__dirname, '..', 'vault-data');
const vaultDataOutputFolder = path.join(__dirname, '..', 'vault-data-output');


const enetitiesOutputFolder = path.join(vaultDataOutputFolder, 'entities');
if (!fs.existsSync(enetitiesOutputFolder)) {
    fs.mkdirSync(enetitiesOutputFolder, { recursive: true });
}

// read in all entities in vault data folder
const entities = fs.readdirSync(path.join(vaultDataFolder, 'entities'));
for (const entity of entities) {
    const filename = path.join(vaultDataFolder, 'entities', entity);
    const entityData = JSON.parse(fs.readFileSync(filename, 'utf8'));

    const parsed = tryParseField(entityData, entity, 'description');
    if (!parsed) {
        console.error(`Error parsing description for ${entity}: no description found:\n${entityData.description}\n`);
        process.exit(1);
    }
    entityData.description = parsed;

    for (let i = 0; i < entityData.log.length; i++) {
        const log = entityData.log[i];
        const parsed = tryParseField(log, entity, 'summary');
        if (!parsed) {
            console.error(`Error parsing summary for ${entity}: no summary found:\n${log.summary}\n`);
            process.exit(1);
        }
        entityData.log[i].summary = parsed;
    }
    
    fs.writeFileSync(path.join(enetitiesOutputFolder, entity), JSON.stringify(entityData, null, 2));
}

function tryParseField(entityData: any, entity: string, field: string) {
    try {
        const parsedDescription: any = JSON.parse(entityData[field as keyof typeof entityData] as string);
        const jsonType = typeof parsedDescription;

        if (jsonType === 'object') {
            if (parsedDescription[field]) {
                return parsedDescription[field];
            } else {
                if (Object.keys(parsedDescription).length === 1) {
                    return parsedDescription[Object.keys(parsedDescription)[0]];
                } else {
                    console.error(`Error parsing description for ${entity}: unknown format`);
                    process.exit(1);
                }
            }
        } else if (jsonType === 'string') {
            return parsedDescription;
        } else {
            console.error(`Error parsing description for ${entity}: unknown format: ${jsonType}`);
            process.exit(1);
        }
    } catch (error) {
        console.error(`Error parsing description for ${entity}: ${error}`);
        process.exit(1);
    }
}
