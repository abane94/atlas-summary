/**
 * Shared reply handling for Cursor.
 *
 * Cursor's CLI is a tool-using agent. Its reply often starts with process
 * narration ("I'll check how earlier session summaries are written…") and then
 * the actual notes, sometimes with no space between them. Prompts forbid that,
 * JSON extraction drops text outside the value, and this preamble strip is only
 * a backstop for the known shape of that narration.
 */

const JSON_OUTPUT_RULES = `
Output rules:
- Everything you need is in this message. Do not use tools. Do not read files, search the workspace, or look at other sessions, prompts, or notes.
- Do not narrate. Do not say what you are about to do. No preamble, no postscript, and no mention of style, format, files, or matching other writeups.
- String values are the notes themselves. Do not start one with a sentence about checking, reading, or matching other writeups.
- Reply with one JSON value only. No markdown fences and no text before or after the JSON.
`.trim();

const PROSE_OUTPUT_RULES = `
Output rules:
- Everything you need is in this message. Do not use tools. Do not read files, search the workspace, or look at other sessions, prompts, or notes.
- Do not narrate. Do not say what you are about to do. No preamble and no postscript.
- Put the answer inside <answer> and </answer>. Write nothing outside those tags.
- The answer is in-world notes. Start with the events themselves.
`.trim();

const PROCESS_START =
  /^(?:sure[,!]?\s+)?(?:i['’]ll|i will|let me|i['’]m going to|i am going to|i need to|i should|looking|checking|reading|searching)\b/i;

const PROCESS_TOPIC =
  /\b(summar(?:y|ies)|styles?|formats?|prompts?|workspace|earlier sessions?|projects?|vault-data|files?|writeups?|matching)\b/i;

/** @param {string} prompt */
export function wrapJsonPrompt(prompt) {
  return `${prompt.trim()}\n\n${JSON_OUTPUT_RULES}\n`;
}

/** @param {string} prompt */
export function wrapProsePrompt(prompt) {
  return `${prompt.trim()}\n\n${PROSE_OUTPUT_RULES}\n`;
}

/**
 * First-person process sentence at the start of a stored paragraph.
 * Requires both an assistant-style opening and a word about the writing task,
 * so in-world lines like "Let me check the door" stay put.
 * @param {string} sentence
 */
export function isProcessPreamble(sentence) {
  const text = sentence.trim();
  if (!text || text.length > 500) return false;
  return PROCESS_START.test(text) && PROCESS_TOPIC.test(text);
}

/**
 * Drop leading process sentences. Returns the original text if stripping would
 * leave it empty.
 * @param {string} text
 */
export function stripProcessPreamble(text) {
  let rest = String(text ?? "").trim();
  if (!rest) return rest;

  for (let i = 0; i < 4; i++) {
    const sentenceMatch = rest.match(/^([\s\S]{1,500}?[.!?])(?=\s|[A-Z]|$)/);
    if (sentenceMatch && isProcessPreamble(sentenceMatch[1])) {
      rest = rest.slice(sentenceMatch[1].length).trimStart();
      continue;
    }

    const lineMatch = rest.match(/^[^\n]{1,500}/);
    const line = lineMatch?.[0] ?? "";
    if (line && !line.includes(".") && isProcessPreamble(line)) {
      rest = rest.slice(line.length).trimStart();
      continue;
    }
    break;
  }

  const trimmed = rest.trim();
  return trimmed || String(text ?? "").trim();
}

/** @param {string} text */
function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Index of the closing brace/bracket for the value starting at `start`, or -1.
 * @param {string} text
 * @param {number} start
 */
function findJsonEnd(text, start) {
  /** @type {string[]} */
  const stack = [];
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      const open = stack.pop();
      if (!open) return -1;
      if ((open === "{") !== (ch === "}")) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** @param {string} text */
function jsonCandidates(text) {
  /** @type {string[]} */
  const candidates = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fence)) {
    if (match[1].trim()) candidates.push(match[1].trim());
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    const end = findJsonEnd(text, i);
    if (end === -1) continue;
    candidates.push(text.slice(i, end + 1));
    i = end;
  }
  return candidates;
}

/**
 * Pull one JSON value out of a reply that may include narration or fences.
 * Returns pretty-printed JSON, or null.
 * @param {string} raw
 */
export function extractJsonText(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  /** @type {{ value: unknown, length: number } | null} */
  let best = null;
  const consider = (candidate) => {
    const parsed = tryParse(candidate.trim());
    if (parsed === undefined || parsed === null || typeof parsed !== "object") return;
    const length = candidate.trim().length;
    if (!best || length >= best.length) best = { value: parsed, length };
  };

  consider(text);
  consider(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""));
  for (const candidate of jsonCandidates(text)) consider(candidate);

  return best ? JSON.stringify(best.value, null, 4) : null;
}

/**
 * @param {string} markdown
 * @param {string} [text]
 */
export function parseJsonResponse(markdown, text) {
  return extractJsonText(markdown) ?? extractJsonText(text ?? "");
}

/** @param {string} raw */
export function extractProseAnswer(raw) {
  const text = String(raw ?? "").trim();
  const tagged = text.match(/<answer>([\s\S]*?)<\/answer>/i);
  return stripProcessPreamble(tagged ? tagged[1] : text);
}
