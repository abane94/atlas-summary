import { getBrowser } from "../lib/browser.js";
import fs from 'fs';

import { generateTranscriptChunks, loadTranscript } from "../lib/transcript.js";
import { runJsonPrompt } from "../lib/chatgpt.js";
import { generateSessionData, mergeSessionData } from "../lib/session-data-gen.ts";

const date = process.argv[2] ?? "2026-08-17";

const url = process.argv[2] ?? "https://chatgpt.com";

const browser = await getBrowser();
const pages = await browser.pages();
const page = pages[0] ?? await browser.newPage();

// ensure summaries folder exists
fs.mkdirSync(`summaries/${date}`, { recursive: true });

console.log(`Navigating to ${url} ...`);
await page.goto(url, { waitUntil: "networkidle2" });

const title = await page.title();
// console.log(`Page title: ${title}`);








// const allData = await generateSessionData(date);
// const mergedData = await mergeSessionData(page, allData);

// fs.writeFileSync(`summaries/${date}/merged.json`, JSON.stringify(mergedData, null, 2));

// process.exit(0);




// load recap prompt
const recapPrompt = fs.readFileSync('prompts/recap-prompt.md', 'utf8');
// load existing entiies from vault-data folder. Create a table with the entity name, type, and slug, to insert into the prompt
const existingEntities = fs.readdirSync('vault-data/entities');
const existingEntitiesTable = existingEntities.map(entity => {
  const entityData = JSON.parse(fs.readFileSync(`vault-data/entities/${entity}`, 'utf8'));
  return `| ${entityData.name} | ${entityData.type} | ${entityData.slug} |`;
}).join('\n');
const existingEntitiesTablePrompt = `
## Existing entites, concepts, NPCs, locations, items

| Name | Type | Slug |
|------|------|------|
${existingEntitiesTable}
`;

recapPrompt.replace('## Existing entites, concepts, NPCs, locations, items', existingEntitiesTablePrompt);

// load recap transcript
// const transcript = fs.readFileSync(`transcripts/${date}/recap.md`, 'utf8');
const { recap, transcript } = await loadTranscript(date);

const ai_prompt = `
# Input
This is section is a recap of the DND session.
<br/>
<br/>
${recapPrompt.replaceAll('\n', '<br/>')}
<br/>
<br/>

${recap.replaceAll('\n', '<br/>')}
`

const recapSummary = await runJsonPrompt(page, ai_prompt);

fs.writeFileSync(`summaries/${date}/recap.json`, recapSummary);







// process.exit(0);

await page.goto(url, { waitUntil: "networkidle2" });



// iterate over transcript chunks
let latestSummary = ''; // recapSummary;
let i = 0;
console.log(`Generating summaries for ${date}...`);
for (const chunk of generateTranscriptChunks(transcript)) {
  const fileName = `summaries/${date}/summary-${i}.json`;
  if (fs.existsSync(fileName)) {
    console.log(`Summary for chunk ${i} already exists, skipping...`);
    i++;
    continue;
  }
  console.log(`Generating summary for chunk ${i}...`);
  const ai_prompt = `
  # Input
  This is ${i ? 'a' : 'the first'} sub- section of the DND session.
  <br/>
  <br/>
  ${recapPrompt.replaceAll('\n', '<br/>')}
  <br/>
  <br/>

  ${chunk.replaceAll('\n', '<br/>')}
  `
  const summary = await runJsonPrompt(page, ai_prompt);
  latestSummary = `${summary}`;
  fs.writeFileSync(fileName, summary);
  await page.goto(url, { waitUntil: "networkidle2" });
  i++;
}


const allData = await generateSessionData(date);
const mergedData = await mergeSessionData(page, allData);

fs.writeFileSync(`summaries/${date}/merged.json`, JSON.stringify(mergedData, null, 2));


// output to summaries folder

if (process.env.PUPPETEER_MODE === "connect") {
  browser.disconnect();
} else {
  await browser.close();
}
