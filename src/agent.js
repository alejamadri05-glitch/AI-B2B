// One conversation turn: send the customer's message, run any tools Claude asks
// for, and return the text reply. The history array is append-only (thinking
// blocks are tied to the conversation, so earlier turns must never be edited).
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "./prompt.js";
import { TOOLS, executeTool } from "./tools.js";
import { describeNow } from "./calendar.js";

export const MODEL = process.env.MODEL || "claude-opus-5-5";
// Short, chatty replies don't need deep reasoning; raise to "medium" if quality suffers.
const EFFORT = process.env.EFFORT || "low";
// How long the fixed part of the prompt (tools + business instructions) stays
// cached. New website chats usually arrive 5-60 minutes apart, where the 1-hour
// cache pays off; set "5m" for clients with constant traffic.
const PROMPT_CACHE = { type: "ephemeral", ttl: process.env.PROMPT_CACHE_TTL === "5m" ? "5m" : "1h" };
// The tool definitions are the same for every client, so they get their own
// cache point and are shared across clients. Built once so the bytes never change.
const CACHED_TOOLS = TOOLS.map((tool, i) => (i === TOOLS.length - 1 ? { ...tool, cache_control: PROMPT_CACHE } : tool));
const MAX_TOOL_ROUNDS = 8;
// If the model declines a request, the API retries it on Anthropic's recommended
// fallback model inside the same call.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

const SAFE_REPLY = (config) =>
  `Sorry, I can't help with that here. Please call us at ${config.phone} and our team will take care of you.`;

let defaultClient;
function getClient() {
  defaultClient ??= new Anthropic();
  return defaultClient;
}

export async function runTurn({ config, history, userText, sessionId, channel = "web", now = new Date(), client = getClient() }) {
  const turnStart = history.length;
  const ctx = { config, sessionId, channel, now };
  const system = buildSystemPrompt(config);
  const replies = [];

  history.push({ role: "user", content: userText });
  history.push({
    role: "system",
    content: `Current date and time at the business: ${describeNow(now, config.timezone)}.`,
  });

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        output_config: { effort: EFFORT },
        // Three cache points, longest-lived first: the tools (shared by all clients),
        // this client's instructions (shared by its conversations), and the
        // automatic 5-minute one for the growing conversation.
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: system, cache_control: PROMPT_CACHE }],
        tools: CACHED_TOOLS,
        messages: history,
      });
      logUsage(config.slug, response);

      if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
        history.length = turnStart;
        return { reply: SAFE_REPLY(config) };
      }

      history.push({ role: "assistant", content: response.content });
      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) replies.push(block.text.trim());
      }

      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason !== "tool_use") return { reply: replies.join("\n\n") || SAFE_REPLY(config) };

      // Run every tool call from this response and return all results in one message.
      const toolUses = response.content.filter((b) => b.type === "tool_use");
      const results = await Promise.all(
        toolUses.map(async (use) => {
          const { content, isError } = await executeTool(use.name, use.input, ctx);
          return { type: "tool_result", tool_use_id: use.id, content, is_error: isError };
        }),
      );
      history.push({ role: "user", content: results });
    }
    history.length = turnStart;
    return { reply: SAFE_REPLY(config) };
  } catch (err) {
    // Drop the unanswered turn so the next message starts from a valid history.
    history.length = turnStart;
    throw err;
  }
}

function logUsage(slug, response) {
  const u = response.usage ?? {};
  console.log(
    `[claude] ${slug} model=${response.model} stop=${response.stop_reason} in=${u.input_tokens} ` +
      `cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens}`,
  );
}
