import { execFile } from "node:child_process";
import { promisify } from "node:util";
import TurndownService from "turndown";

const execFileAsync = promisify(execFile);
const turndown = new TurndownService();

const POLL_INTERVAL_MS = 1000;
const SNAPSHOT_INTERVAL_MS = 30_000;
const MAX_GENERATION_WAIT_MS = 5 * 60 * 1000;
const MAX_PROMPT_RETRIES = 3;
const SUBMIT_CONFIRM_TIMEOUT_MS = 10_000;
const COMPOSER_READY_TIMEOUT_MS = 30_000;
const INSERT_TEXT_MAX_CHARS = 4000;
const MIN_PROMPT_GAP_MS = 5_000;
const CHATGPT_NAV = { waitUntil: "domcontentloaded", timeout: 60_000 };

/** In-memory only; reset each process. Timestamp of last retrieved assistant content. */
let lastContentRetrievedAt = 0;
/** Serializes prompt runs so two ChatGPT prompts never overlap. */
let promptLock = Promise.resolve();

const acquirePromptLock = () => {
  let release;
  const previous = promptLock;
  promptLock = new Promise((resolve) => {
    release = resolve;
  });
  return previous.then(() => release);
};

const waitForMinPromptGap = async () => {
  if (!lastContentRetrievedAt) {
    return;
  }
  const remainingMs = MIN_PROMPT_GAP_MS - (Date.now() - lastContentRetrievedAt);
  if (remainingMs > 0) {
    console.log(
      `Waiting ${Math.ceil(remainingMs / 1000)}s before next ChatGPT prompt`
    );
    await new Promise((resolve) => setTimeout(resolve, remainingMs));
  }
};

const getMessageCounts = async (page) =>
  page.evaluate(() => ({
    assistant: document.querySelectorAll(
      '[data-message-author-role="assistant"]'
    ).length,
    user: document.querySelectorAll('[data-message-author-role="user"]').length,
  }));

const waitForComposerReady = async (page) => {
  // Only wait for the composer itself. The send button stays disabled until
  // text is entered, so do not require it to be enabled here.
  await page.waitForSelector("#prompt-textarea", {
    visible: true,
    timeout: COMPOSER_READY_TIMEOUT_MS,
  });
  await page.waitForFunction(
    () => {
      const textarea = document.querySelector("#prompt-textarea");
      return Boolean(textarea && !textarea.closest("[aria-busy='true']"));
    },
    { timeout: COMPOSER_READY_TIMEOUT_MS }
  );
};

const fillPromptTextarea = async (page, ai_prompt) => {
  await page.focus("#prompt-textarea");

  const chunks = [];
  if (ai_prompt.length <= INSERT_TEXT_MAX_CHARS) {
    chunks.push(ai_prompt);
  } else {
    console.log(`Filling composer in chunks (${ai_prompt.length} chars)`);
    for (let i = 0; i < ai_prompt.length; i += INSERT_TEXT_MAX_CHARS) {
      chunks.push(ai_prompt.slice(i, i + INSERT_TEXT_MAX_CHARS));
    }
  }

  for (let i = 0; i < chunks.length; i++) {
    await page.$eval(
      "#prompt-textarea",
      (element, chunk, first) => {
        element.focus();
        if (first) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(element);
          selection.removeAllRanges();
          selection.addRange(range);
        }

        // Prefer execCommand so contenteditable/React editors register the change.
        const inserted = document.execCommand("insertText", false, chunk);
        if (!inserted) {
          if (first) {
            element.innerHTML = chunk;
          } else {
            element.append(chunk);
          }
        }

        element.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: chunk,
          })
        );
        element.dispatchEvent(new Event("change", { bubbles: true }));
      },
      chunks[i],
      i === 0
    );
  }

  const filled = await page.$eval(
    "#prompt-textarea",
    (element) => (element.innerText ?? "").trim().length > 0
  );
  if (!filled) {
    throw new Error("Failed to fill ChatGPT prompt textarea");
  }
};

const trySubmitPrompt = async (page) => {
  const submitSelectors = [
    '[data-testid="send-button"]',
    "#composer-submit-button",
    'button[aria-label="Send prompt"]',
  ];

  try {
    await page.waitForFunction(
      (selectors) =>
        selectors.some((selector) => {
          const button = document.querySelector(selector);
          return button && !button.disabled;
        }),
      { timeout: 3000 },
      submitSelectors
    );
  } catch {
    // React may not have enabled send yet; fall through to click/Enter attempts.
  }

  for (const selector of submitSelectors) {
    const button = await page.$(selector);
    if (!button) {
      continue;
    }
    const isDisabled = await button.evaluate((element) => element.disabled);
    if (!isDisabled) {
      await button.click();
      return;
    }
  }

  await page.focus("#prompt-textarea");
  await page.keyboard.press("Enter");
};

const isPromptStillInComposer = async (page) => {
  const promptTextarea = await page.$("#prompt-textarea");
  if (!promptTextarea) {
    return false;
  }
  const value = await promptTextarea.evaluate(
    (element) => element.innerText ?? ""
  );
  return value.trim() !== "";
};

/** @returns {Promise<boolean>} */
const waitForPromptSubmitted = async (page, countsBefore, timeoutMs) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const stopButtonPresent = await page.evaluate(
      () => document.querySelector('[data-testid="stop-button"]') !== null
    );
    if (stopButtonPresent) {
      return true;
    }

    const counts = await getMessageCounts(page);
    if (counts.user > countsBefore.user) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  // If the prompt is still sitting in the box, submit definitely failed.
  if (await isPromptStillInComposer(page)) {
    return false;
  }

  // Composer cleared without a stop button / user bubble — treat as submitted.
  return true;
};

const getLatestAssistantMessage = async (page) =>
  page.evaluate(() => {
    const messages = document.querySelectorAll(
      '[data-message-author-role="assistant"]'
    );
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) {
      return { id: null, text: "", html: "" };
    }
    return {
      id: lastMessage.getAttribute("data-message-id"),
      text: lastMessage.innerText ?? "",
      html: lastMessage.innerHTML ?? "",
    };
  });

/** @returns {Promise<'complete' | 'stalled' | 'timeout'>} */
const waitForGenerationComplete = async (page) => {
  const startedAt = Date.now();
  let snapshot = null;

  while (true) {
    const stopButtonPresent = await page.evaluate(
      () => document.querySelector('[data-testid="stop-button"]') !== null
    );
    if (!stopButtonPresent) {
      return "complete";
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= MAX_GENERATION_WAIT_MS) {
      console.warn(
        `Generation wait exceeded ${MAX_GENERATION_WAIT_MS / 1000}s`
      );
      return "timeout";
    }

    if (!snapshot && elapsedMs >= SNAPSHOT_INTERVAL_MS) {
      const current = await getLatestAssistantMessage(page);
      snapshot = { id: current.id, text: current.text, takenAt: elapsedMs };
      console.log(
        `Generation snapshot at ${Math.round(elapsedMs / 1000)}s: id=${snapshot.id}, textLength=${snapshot.text.length}`
      );
    } else if (
      snapshot &&
      elapsedMs - snapshot.takenAt >= SNAPSHOT_INTERVAL_MS
    ) {
      const current = await getLatestAssistantMessage(page);
      if (current.id !== snapshot.id) {
        snapshot = { id: current.id, text: current.text, takenAt: elapsedMs };
        console.log(
          `Generation progress at ${Math.round(elapsedMs / 1000)}s: new id=${snapshot.id}, textLength=${snapshot.text.length}`
        );
      } else if (current.text !== snapshot.text) {
        snapshot = { id: current.id, text: current.text, takenAt: elapsedMs };
        console.log(
          `Generation progress at ${Math.round(elapsedMs / 1000)}s: id=${snapshot.id}, textLength=${snapshot.text.length}`
        );
      } else {
        console.warn(
          `Generation stalled at ${Math.round(elapsedMs / 1000)}s: id=${snapshot.id}, textLength=${snapshot.text.length}`
        );
        return "stalled";
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
};

export const runJsonPrompt = async (page, ai_prompt, timeout = 30000) => {
  console.log(`Prompting: ${ai_prompt.split('\n').filter(line => line.trim() !== '')[0]}`);

//   const markdown = turndown.turndown(html).replaceAll('JSON\n', '');

    let [markdown, html, text] = await _runPrompt(page, ai_prompt, timeout);

//   console.log(`Markdown: ${markdown}`);

  try {
    return JSON.stringify(JSON.parse(markdown), null, 4);
  } catch (error) {
    try {
      return JSON.stringify(JSON.parse(text), null, 4);
    } catch (error) {

      let json = false;
      let i = 0;
      while (json == false && i < 10) {
        console.log(`Trying to parse json ${i} times`);
        [markdown, html, text] = await _runPrompt(page, 'Please respond with valid json', false);
        json = tryJsonParse(markdown, text);
        i++;
      }
      if (json) {
        return JSON.stringify(json, null, 4);
      }
      return markdown;
    }
    return markdown;
  }
  return markdown;
};

/** Page-based prompt that returns prose (plain text / markdown), not JSON. */
export const runProsePrompt = async (page, ai_prompt) => {
  await page.goto('https://chatgpt.com', CHATGPT_NAV);
  const [markdown, _html, text] = await _runPrompt(page, ai_prompt);
  return (markdown || text || "").trim();
};


const _runPrompt = async (page, ai_prompt, timeout = 30000) => {
  const release = await acquirePromptLock();
  try {
    return await _runPromptAttempt(page, ai_prompt, timeout, 0);
  } finally {
    release();
  }
};

const _runPromptAttempt = async (page, ai_prompt, timeout, attempt) => {
  await waitForComposerReady(page);

  const countsBefore = await getMessageCounts(page);

  try {
    await fillPromptTextarea(page, ai_prompt);
  } catch (error) {
    if (attempt >= MAX_PROMPT_RETRIES) {
      throw error;
    }
    console.warn(
      `Prompt fill failed (${error.message}); reloading and retrying (attempt ${attempt + 1}/${MAX_PROMPT_RETRIES})`
    );
    await page.reload(CHATGPT_NAV);
    return _runPromptAttempt(page, ai_prompt, timeout, attempt + 1);
  }

  await waitForMinPromptGap();
  await trySubmitPrompt(page);

  let submitted = await waitForPromptSubmitted(
    page,
    countsBefore,
    SUBMIT_CONFIRM_TIMEOUT_MS
  );

  if (!submitted) {
    console.warn("Prompt may not have been submitted; retrying submit");
    await trySubmitPrompt(page);
    submitted = await waitForPromptSubmitted(
      page,
      countsBefore,
      SUBMIT_CONFIRM_TIMEOUT_MS
    );
  }

  if (!submitted) {
    if (attempt >= MAX_PROMPT_RETRIES) {
      throw new Error(
        `ChatGPT prompt was not submitted after ${attempt + 1} attempt(s)`
      );
    }
    console.warn(
      `Prompt not submitted; reloading and retrying (attempt ${attempt + 1}/${MAX_PROMPT_RETRIES})`
    );
    await page.reload(CHATGPT_NAV);
    return _runPromptAttempt(page, ai_prompt, timeout, attempt + 1);
  }

  await new Promise((resolve) => setTimeout(resolve, timeout));

  const waitResult = await waitForGenerationComplete(page);

  if (waitResult === "stalled" || waitResult === "timeout") {
    if (attempt >= MAX_PROMPT_RETRIES) {
      throw new Error(
        `ChatGPT generation ${waitResult} after ${attempt + 1} attempt(s)`
      );
    }
    console.warn(
      `Generation ${waitResult}; reloading and retrying (attempt ${attempt + 1}/${MAX_PROMPT_RETRIES})`
    );
    await page.reload(CHATGPT_NAV);
    return _runPromptAttempt(page, ai_prompt, timeout, attempt + 1);
  }

  await page.waitForFunction(
    (count) => {
      const assistantCount = document.querySelectorAll(
        '[data-message-author-role="assistant"]'
      ).length;
      console.log(
        `Assistant count: ${assistantCount}, waiting for ${count} assistants`
      );
      return assistantCount > count;
    },
    { timeout: MAX_GENERATION_WAIT_MS },
    countsBefore.assistant
  );

  await page.waitForSelector('[data-testid="copy-turn-action-button"]');

  const { html, text } = await getLatestAssistantMessage(page);
  lastContentRetrievedAt = Date.now();

  const markdown = turndown.turndown(html).replaceAll("JSON\n", "");
  return [markdown, html, text];
};

const tryJsonParse = (markdown, text) => {
    let isJson = false;
    
    try {
        return JSON.parse(markdown);
    } catch (error) {
        console.error(`Error parsing markdown: ${error}`);
        try {
            return JSON.parse(text);
        } catch (error) {
            console.error(`Error parsing text: ${error}`);
            return false;
        }
    }
}

const stripJsonFences = (text) =>
  text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

const _runCursorPrompt = async (ai_prompt, sessionId) => {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--mode",
    "ask",
    "--trust",
  ];
  if (sessionId) {
    args.push("--resume", sessionId);
  }
  args.push(ai_prompt);

  const { stdout } = await execFileAsync("cursor-agent", args, {
    maxBuffer: 50 * 1024 * 1024,
  });

  const envelope = JSON.parse(stdout);
  if (envelope.is_error || envelope.subtype !== "success") {
    throw new Error(`cursor-agent failed: ${envelope.result ?? stdout}`);
  }

  return {
    text: stripJsonFences(envelope.result ?? ""),
    sessionId: envelope.session_id,
  };
};

/** @param {unknown} _page unused; kept for API parity with runJsonPrompt */
export const runCursorJsonPrompt = async (_page, ai_prompt) => {
  let { text, sessionId } = await _runCursorPrompt(ai_prompt);

  try {
    return JSON.stringify(JSON.parse(text), null, 4);
  } catch {
    let json = false;
    let i = 0;
    while (json === false && i < 10) {
      console.log(`Trying to parse json ${i} times`);
      ({ text, sessionId } = await _runCursorPrompt(
        "Please respond with valid json only. No markdown fences.",
        sessionId
      ));
      json = tryJsonParse(text, text);
      i++;
    }
    if (json) {
      return JSON.stringify(json, null, 4);
    }
    return text;
  }
};

/**
 * Cursor-agent prompt that returns prose (plain text), not JSON.
 * @param {unknown} _page unused; kept for API parity with runJsonPrompt
 */
export const runCursorProsePrompt = async (_page, ai_prompt) => {
  const { text } = await _runCursorPrompt(ai_prompt);
  return (text || "").trim();
};
