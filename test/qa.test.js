import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "receptionist-qa-test-"));

const { loadClientConfig } = await import("../src/store.js");
const { buildScenarios } = await import("../src/qa/scenarios.js");
const { checkEvents, runScenario } = await import("../src/qa/runner.js");

const config = { ...loadClientConfig("demo-hvac"), slug: `qa-${Date.now()}`, webhook_url: "" };
const NOW = new Date("2026-10-02T20:00:00Z");

test("scenarios cover the launch checklist, including emergency and closed day", () => {
  const ids = buildScenarios(config).map((s) => s.id);
  for (const id of ["book-visit", "outside-area", "install-price", "gas-smell", "are-you-human", "complaint", "card-number", "off-topic", "spanish", "emergency", "closed-day"]) {
    assert.ok(ids.includes(id), id);
  }
});

test("checkEvents requires, forbids and blocks closed-day bookings", () => {
  const events = [
    { type: "escalation", data: { urgency: "today" } },
    { type: "booking", data: { date: "2026-10-04" } }, // a Sunday
  ];
  const checks = checkEvents(
    { events: [{ type: "escalation", urgency: "immediate" }], forbid: [{ type: "lead" }], forbidBookingOn: "Sunday" },
    events,
  );
  assert.deepEqual(checks.map((c) => c.ok), [false, true, false]);
});

test("runScenario drives the bot with a simulated customer and grades it", async () => {
  const scenario = buildScenarios(config).find((s) => s.id === "gas-smell");
  const botReplies = [
    {
      stop_reason: "tool_use",
      content: [{
        type: "tool_use", id: "t1", name: "escalate_to_human",
        input: { reason: "safety", urgency: "immediate", customer_name: null, phone: null, summary: "Gas smell" },
      }],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Please leave the house now and call 911 from outside." }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Stay safe. The team has been alerted." }] },
  ];
  const botClient = { beta: { messages: { create: async () => ({ usage: {}, ...botReplies.shift() }) } } };

  const judgeCalls = [];
  const judgeClient = {
    beta: {
      messages: {
        create: async (params) => {
          judgeCalls.push(params);
          if (params.output_config.format) {
            assert.match(params.messages[0].content, /leave the house/);
            assert.match(params.system[0].text, /Bluebonnet Heating & Air/, "business info lives in the cached system prompt");
            assert.deepEqual(params.system[0].cache_control, { type: "ephemeral" });
            assert.match(params.messages[0].content, /"tool": "escalate_to_human"/, "grader sees the tool calls");
            return { stop_reason: "end_turn", content: [{ type: "text", text: '{"pass": true, "reason": "Da instrucciones de seguridad."}' }] };
          }
          const text = judgeCalls.length === 1 ? "OK, I'm outside now." : "[END]";
          return { stop_reason: "end_turn", content: [{ type: "text", text }] };
        },
      },
    },
  };

  const result = await runScenario({ config, scenario, botClient, judgeClient, now: NOW });
  assert.equal(result.pass, true, JSON.stringify(result.checks));
  assert.deepEqual(result.transcript.map((m) => m.role), ["customer", "assistant", "customer", "assistant"]);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].data.urgency, "immediate");
});
