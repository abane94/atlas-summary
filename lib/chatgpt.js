import TurndownService from "turndown";

const turndown = new TurndownService();

export const runJsonPrompt = async (page, ai_prompt) => {
//   const assistantCountBefore = await page.evaluate(
//     () => document.querySelectorAll('[data-message-author-role="assistant"]').length
//   );

//   await page.$eval("#prompt-textarea", (element, my_prompt) => {
//     element.innerHTML = my_prompt;
//   }, ai_prompt);

//   await page.click("#composer-submit-button");

//   // wait for 20 seconds
//   await new Promise(resolve => setTimeout(resolve, 30000));

//   await page.waitForFunction(
//     (count) =>
//       document.querySelectorAll('[data-message-author-role="assistant"]').length >
//       count,
//     {},
//     assistantCountBefore
//   );

//   await page.waitForSelector('[data-testid="copy-turn-action-button"]');

//   const {html, text} = await page.evaluate(() => {
//     const messages = document.querySelectorAll(
//       '[data-message-author-role="assistant"]'
//     );
//     const lastMessage = messages[messages.length - 1];
//     return {html:lastMessage?.innerHTML ?? "", text: lastMessage?.innerText ?? ""};
//   });


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
        (count) =>
          document.querySelectorAll('[data-message-author-role="assistant"]').length >
          count,
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