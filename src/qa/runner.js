// Runs one QA scenario: a simulated customer talks to the real receptionist,
// then deterministic checks (events created) and a grader model judge it.
import Anthropic from "@anthropic-ai/sdk";
import { runTurn } from "../agent.js";
import { readEvents } from "../store.js";
import { weekdayOf } from "../calendar.js";

const MODEL = process.env.MODEL || "claude-opus-5-5";
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
const END = "[END]";

function formatTranscript(transcript) {
  return transcript.map((m) => `${m.role === "customer" ? "Customer" : "Assistant"}: ${m.text}`).join("\n\n");
}

async function simulateCustomer(client, scenario, transcript) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 1000,
    ...FALLBACK,
    output_config: { effort: "low" },
    system: `You are role-playing a customer texting a home-services company's website chat, to test their virtual assistant. Your situation and goal: ${scenario.goal}
Write only the customer's next message: short and casual, like a real text. Answer what the assistant asks. When your goal is met, the conversation has clearly ended, or you have nothing left to say, reply with exactly ${END}.`,
    messages: [{ role: "user", content: `Conversation so far:\n\n${formatTranscript(transcript)}\n\nWrite the customer's next message.` }],
  });
  const text = response.content.find((b) => b.type === "text")?.text?.trim() ?? END;
  return text.includes(END) ? null : text;
}

const GRADE_SCHEMA = {
  type: "object",
  properties: { pass: { type: "boolean" }, reason: { type: "string" } },
  required: ["pass", "reason"],
  additionalProperties: false,
};

// Every tool call the assistant made, in order, so the grader sees checks that
// leave no event behind (like check_availability).
function toolCalls(history) {
  return history
    .filter((m) => m.role === "assistant" && Array.isArray(m.content))
    .flatMap((m) => m.content.filter((b) => b.type === "tool_use").map((b) => ({ tool: b.name, input: b.input })));
}

async function grade(client, config, scenario, transcript, events, calls = []) {
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    ...FALLBACK,
    output_config: { effort: "medium", format: { type: "json_schema", schema: GRADE_SCHEMA } },
    // Instructions + business information are identical for every scenario of a
    // run, so they are cached once and read by the other graders.
    system: [
      {
        type: "text",
        text: `You review conversations between a home-services company's AI receptionist and a customer. Judge only against the rubric. Fail the conversation if any part of the rubric is clearly not met, or if the assistant states a fact (price, policy, availability) that is not in the business information. Give the reason in one or two sentences in Spanish.\n\nBusiness information (JSON):\n${JSON.stringify(config, null, 2)}`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: `Rubric: ${scenario.rubric}\n\nConversation:\n\n${formatTranscript(transcript)}\n\nTools the assistant called, in order (JSON):\n${JSON.stringify(calls, null, 2)}\n\nRecords those tools created (JSON):\n${JSON.stringify(events.map((e) => ({ type: e.type, ...e.data })), null, 2)}`,
      },
    ],
  });
  const text = response.content.find((b) => b.type === "text")?.text;
  if (response.stop_reason === "refusal" || !text) return { pass: false, reason: "El calificador no respondió." };
  return JSON.parse(text);
}

export function checkEvents(expect, events) {
  const matches = (e, want) => e.type === want.type && (!want.urgency || e.data.urgency === want.urgency);
  const checks = [];
  for (const want of expect.events ?? []) {
    const ok = events.some((e) => matches(e, want));
    checks.push({ ok, what: `Crea un evento ${want.type}${want.urgency ? ` (${want.urgency})` : ""}` });
  }
  for (const banned of expect.forbid ?? []) {
    const ok = !events.some((e) => matches(e, banned));
    checks.push({ ok, what: `No crea un evento ${banned.type}` });
  }
  if (expect.forbidBookingOn) {
    const ok = !events.some((e) => e.type === "booking" && weekdayOf(e.data.date) === expect.forbidBookingOn);
    checks.push({ ok, what: `No agenda en ${expect.forbidBookingOn}` });
  }
  return checks;
}

export async function runScenario({ config, scenario, botClient, judgeClient = new Anthropic(), now = new Date(), maxTurns = 8 }) {
  const sessionId = `qa-${scenario.id}-${Math.random().toString(36).slice(2, 8)}`;
  const history = [];
  const transcript = [];
  let customerText = scenario.opening;
  try {
    for (let turn = 0; turn < maxTurns && customerText; turn++) {
      transcript.push({ role: "customer", text: customerText });
      const { reply } = await runTurn({ config, history, userText: customerText, sessionId, now, client: botClient });
      transcript.push({ role: "assistant", text: reply });
      customerText = turn + 1 < maxTurns ? await simulateCustomer(judgeClient, scenario, transcript) : null;
    }
  } catch (err) {
    return { id: scenario.id, title: scenario.title, pass: false, checks: [], grade: { pass: false, reason: `Error: ${err.message}` }, transcript, events: [] };
  }
  const events = readEvents(config.slug).filter((e) => e.session_id === sessionId);
  const checks = checkEvents(scenario.expect, events);
  const verdict = await grade(judgeClient, config, scenario, transcript, events, toolCalls(history));
  return {
    id: scenario.id,
    title: scenario.title,
    pass: checks.every((c) => c.ok) && verdict.pass,
    checks,
    grade: verdict,
    transcript,
    events,
  };
}
