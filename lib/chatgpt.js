import { execFile } from "node:child_process";
import { promisify } from "node:util";
import TurndownService from "turndown";

const execFileAsync = promisify(execFile);
const turndown = new TurndownService();

export const ___runJsonPrompt = async (page, ai_prompt) => {

//   const markdown = turndown.turndown(html).replaceAll('JSON\n', '');

    let [markdown, html, text] = await _runPrompt(page, ai_prompt);

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


const _runPrompt = async (page, ai_prompt) => {
    const assistantCountBefore = await page.evaluate(
        () => document.querySelectorAll('[data-message-author-role="assistant"]').length
      );
    
      await page.$eval("#prompt-textarea", (element, my_prompt) => {
        element.innerHTML = my_prompt;
      }, ai_prompt);

      // send enter key
      await page.keyboard.press('Enter');

    //   try {
    //     await page.click("#composer-submit-button");
    //   } catch (error) {
    //     console.error(`Error clicking submit button: ${error}`);
    //     // send enter key
    //     await page.keyboard.press('Enter');
    //   }
    
    
      // wait for 20 seconds
    //   await new Promise(resolve => setTimeout(resolve, 30000));

    // sleep until stop button does not exist
    while (await page.evaluate(() => document.querySelector('[data-testid="stop-button"]') !== null)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
      await page.waitForFunction(
        (count) => {
            const assistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
            console.log(`Assistant count: ${assistantCount}, waiting for ${count} assistants`);
              return assistantCount > count;
          },
        {},
        assistantCountBefore
      );
    
      await page.waitForSelector('[data-testid="copy-turn-action-button"]');
    
      const {html, text} = await page.evaluate(() => {
        const messages = document.querySelectorAll(
          '[data-message-author-role="assistant"]'
        );
        const lastMessage = messages[messages.length - 1];
        return {html:lastMessage?.innerHTML ?? "", text: lastMessage?.innerText ?? ""};
      });
    
    
      const markdown = turndown.turndown(html).replaceAll('JSON\n', '');
      return [markdown, html, text];
}

const tryJsonParse = (markdown, text) => {
    let isJson = false;
    
    try {
        return JSON.parse(markdown);
    } catch (error) {
        try {
            return JSON.parse(text);
        } catch (error) {
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
export const runJsonPrompt = async (_page, ai_prompt) => {
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
