import { getBrowser } from "../lib/browser.js";
import fs from 'fs';

import { generateTranscriptChunks, loadTranscript } from "../lib/transcript.js";
import { runJsonPrompt } from "../lib/chatgpt.js";
import { generateSessionData, mergeSessionData } from "../lib/session-data-gen.ts";

const date = process.argv[2] ?? "2026-08-03";

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



// iterate over transcript chunks
let latestSummary = ''; // recapSummary;
let i = 0;
console.log(`Generating summaries for ${date}...`);
for (const chunk of generateTranscriptChunks(transcript)) {
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
  fs.writeFileSync(`summaries/${date}/summary-${i}.json`, summary);
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
