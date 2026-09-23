import { CursorClient } from "./ai/cursor.js";
import { ChatGptClient } from "./ai/chatgpt.js";

// Switch provider here for this phase (or use AI_PROVIDER=chatgpt).
const provider = process.env.AI_PROVIDER ?? "cursor";
if (provider !== "cursor" && provider !== "chatgpt") {
  throw new Error(
    `Unknown AI_PROVIDER="${provider}". Use "cursor" or "chatgpt".`,
  );
}
const Provider = provider === "chatgpt" ? ChatGptClient : CursorClient;

/** @type {import("./ai.js").AiClient} */
export const ai = new Provider();

/**
 * Open the shared AI client, run `fn`, then close.
 * @template T
 * @param {(client: import("./ai.js").AiClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withAi(fn) {
  await ai.open();
  try {
    return await fn(ai);
  } finally {
    await ai.close();
  }
}

export { CursorClient } from "./ai/cursor.js";
export { ChatGptClient } from "./ai/chatgpt.js";
