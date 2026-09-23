import TurndownService from "turndown";
import { chromeConnectHint, getBrowser } from "../browser.js";

const turndown = new TurndownService();

const POLL_INTERVAL_MS = 1000;
const SNAPSHOT_INTERVAL_MS = 30_000;
const MAX_GENERATION_WAIT_MS = 5 * 60 * 1000;
const MAX_PROMPT_RETRIES = 3;
const SUBMIT_CONFIRM_TIMEOUT_MS = 10_000;
const COMPOSER_READY_TIMEOUT_MS = 30_000;
const INSERT_TEXT_MAX_CHARS = 4000;
const MIN_PROMPT_GAP_MS = 5_000;
const CHATGPT_URL = "https://chatgpt.com";
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
      `Waiting ${Math.ceil(remainingMs / 1000)}s before next ChatGPT prompt`,
    );
    await new Promise((resolve) => setTimeout(resolve, remainingMs));
  }
};

const getMessageCounts = async (page) =>
  page.evaluate(() => ({
    assistant: document.querySelectorAll(
      '[data-message-author-role="assistant"]',
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
    { timeout: COMPOSER_READY_TIMEOUT_MS },
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
          }),
        );
        element.dispatchEvent(new Event("change", { bubbles: true }));
      },
      chunks[i],
      i === 0,
    );
  }

  const filled = await page.$eval(
    "#prompt-textarea",
    (element) => (element.innerText ?? "").trim().length > 0,
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
      submitSelectors,
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
    (element) => element.innerText ?? "",
  );
  return value.trim() !== "";
};

/** @returns {Promise<boolean>} */
const waitForPromptSubmitted = async (page, countsBefore, timeoutMs) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const stopButtonPresent = await page.evaluate(
      () => document.querySelector('[data-testid="stop-button"]') !== null,
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
      '[data-message-author-role="assistant"]',
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
      () => document.querySelector('[data-testid="stop-button"]') !== null,
    );
    if (!stopButtonPresent) {
      return "complete";
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= MAX_GENERATION_WAIT_MS) {
      console.warn(
        `Generation wait exceeded ${MAX_GENERATION_WAIT_MS / 1000}s`,
      );
      return "timeout";
    }

    if (!snapshot && elapsedMs >= SNAPSHOT_INTERVAL_MS) {
      const current = await getLatestAssistantMessage(page);
      snapshot = { id: current.id, text: current.text, takenAt: elapsedMs };
      console.log(
        `Generation snapshot at ${Math.round(elapsedMs / 1000)}s: id=${snapshot.id}, textLength=${snapshot.text.length}`,
      );
    } else if (
      snapshot &&
      elapsedMs - snapshot.takenAt >= SNAPSHOT_INTERVAL_MS
    ) {
      const current = await getLatestAssistantMessage(page);
      if (current.id !== snapshot.id) {
        snapshot = { id: current.id, text: current.text, takenAt: elapsedMs };
        console.log(
          `Generation progress at ${Math.round(elapsedMs / 1000)}s: new id=${snapshot.id}, textLength=${snapshot.text.length}`,
        );
      } else if (current.text !== snapshot.text) {
        snapshot = { id: current.id, text: current.text, takenAt: elapsedMs };
        console.log(
          `Generation progress at ${Math.round(elapsedMs / 1000)}s: id=${snapshot.id}, textLength=${snapshot.text.length}`,
        );
      } else {
        console.warn(
          `Generation stalled at ${Math.round(elapsedMs / 1000)}s: id=${snapshot.id}, textLength=${snapshot.text.length}`,
        );
        return "stalled";
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
};

const tryJsonParse = (markdown, text) => {
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
};

export class ChatGptClient {
  /** @type {import("puppeteer-core").Browser | null} */
  browser = null;
  /** @type {import("puppeteer-core").Page | null} */
  page = null;

  async open() {
    try {
      this.browser = await getBrowser();
      const pages = await this.browser.pages();
      this.page = pages[0] ?? (await this.browser.newPage());
      await this.page.goto(CHATGPT_URL, CHATGPT_NAV);
    } catch (error) {
      await this.close();
      const message = error instanceof Error ? error.message : String(error);
      if (
        /ECONNREFUSED|ERR_CONNECTION_REFUSED|fetch failed|webSocket URL/i.test(
          message,
        )
      ) {
        throw new Error(chromeConnectHint());
      }
      throw error;
    }
  }

  async close() {
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    if (!browser) {
      return;
    }
    if (process.env.PUPPETEER_MODE === "connect") {
      browser.disconnect();
    } else {
      await browser.close();
    }
  }

  async resetConversation() {
    if (!this.page) {
      throw new Error("ChatGptClient is not open");
    }
    await this.page.goto(CHATGPT_URL, CHATGPT_NAV);
  }

  /**
   * @param {string} ai_prompt
   * @param {import("../ai.js").AiPromptOptions} [options]
   */
  async runJsonPrompt(ai_prompt, options = {}) {
    console.log(
      `Prompting: ${ai_prompt.split("\n").filter((line) => line.trim() !== "")[0]}`,
    );

    let [markdown, html, text] = await this.#runPrompt(ai_prompt, options);

    try {
      return JSON.stringify(JSON.parse(markdown), null, 4);
    } catch {
      try {
        return JSON.stringify(JSON.parse(text), null, 4);
      } catch {
        let json = false;
        let i = 0;
        while (json == false && i < 10) {
          console.log(`Trying to parse json ${i} times`);
          [markdown, html, text] = await this.#runPrompt(
            "Please respond with valid json",
            {
              ...options,
              timeout: 0,
            },
          );
          json = tryJsonParse(markdown, text);
          i++;
        }
        if (json) {
          return JSON.stringify(json, null, 4);
        }
        return markdown;
      }
    }
  }

  /**
   * Page-based prompt that returns prose (plain text / markdown), not JSON.
   * @param {string} ai_prompt
   * @param {import("../ai.js").AiPromptOptions} [options]
   */
  async runProsePrompt(ai_prompt, options = {}) {
    await this.resetConversation();
    const [markdown, _html, text] = await this.#runPrompt(ai_prompt, options);
    return (markdown || text || "").trim();
  }

  /**
   * @param {string} ai_prompt
   * @param {import("../ai.js").AiPromptOptions} [options]
   */
  async #runPrompt(ai_prompt, options = {}) {
    const timeout = options.timeout ?? 30000;
    const release = await acquirePromptLock();
    try {
      return await this.#runPromptAttempt(ai_prompt, timeout, 0);
    } finally {
      release();
    }
  }

  /**
   * @param {string} ai_prompt
   * @param {number} timeout
   * @param {number} attempt
   */
  async #runPromptAttempt(ai_prompt, timeout, attempt) {
    const page = this.page;
    if (!page) {
      throw new Error("ChatGptClient is not open");
    }

    await waitForComposerReady(page);

    const countsBefore = await getMessageCounts(page);

    try {
      await fillPromptTextarea(page, ai_prompt);
    } catch (error) {
      if (attempt >= MAX_PROMPT_RETRIES) {
        throw error;
      }
      console.warn(
        `Prompt fill failed (${error.message}); reloading and retrying (attempt ${attempt + 1}/${MAX_PROMPT_RETRIES})`,
      );
      await page.reload(CHATGPT_NAV);
      return this.#runPromptAttempt(ai_prompt, timeout, attempt + 1);
    }

    await waitForMinPromptGap();
    await trySubmitPrompt(page);

    let submitted = await waitForPromptSubmitted(
      page,
      countsBefore,
      SUBMIT_CONFIRM_TIMEOUT_MS,
    );

    if (!submitted) {
      console.warn("Prompt may not have been submitted; retrying submit");
      await trySubmitPrompt(page);
      submitted = await waitForPromptSubmitted(
        page,
        countsBefore,
        SUBMIT_CONFIRM_TIMEOUT_MS,
      );
    }

    if (!submitted) {
      if (attempt >= MAX_PROMPT_RETRIES) {
        throw new Error(
          `ChatGPT prompt was not submitted after ${attempt + 1} attempt(s)`,
        );
      }
      console.warn(
        `Prompt not submitted; reloading and retrying (attempt ${attempt + 1}/${MAX_PROMPT_RETRIES})`,
      );
      await page.reload(CHATGPT_NAV);
      return this.#runPromptAttempt(ai_prompt, timeout, attempt + 1);
    }

    await new Promise((resolve) => setTimeout(resolve, timeout));

    const waitResult = await waitForGenerationComplete(page);

    if (waitResult === "stalled" || waitResult === "timeout") {
      if (attempt >= MAX_PROMPT_RETRIES) {
        throw new Error(
          `ChatGPT generation ${waitResult} after ${attempt + 1} attempt(s)`,
        );
      }
      console.warn(
        `Generation ${waitResult}; reloading and retrying (attempt ${attempt + 1}/${MAX_PROMPT_RETRIES})`,
      );
      await page.reload(CHATGPT_NAV);
      return this.#runPromptAttempt(ai_prompt, timeout, attempt + 1);
    }

    await page.waitForFunction(
      (count) => {
        const assistantCount = document.querySelectorAll(
          '[data-message-author-role="assistant"]',
        ).length;
        console.log(
          `Assistant count: ${assistantCount}, waiting for ${count} assistants`,
        );
        return assistantCount > count;
      },
      { timeout: MAX_GENERATION_WAIT_MS },
      countsBefore.assistant,
    );

    await page.waitForSelector('[data-testid="copy-turn-action-button"]');

    const { html, text } = await getLatestAssistantMessage(page);
    lastContentRetrievedAt = Date.now();

    const markdown = turndown.turndown(html).replaceAll("JSON\n", "");
    return [markdown, html, text];
  }
}
