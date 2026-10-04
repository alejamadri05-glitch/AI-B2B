import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "receptionist-test-"));

const { loadClientConfig, readEvents } = await import("../src/store.js");
const { availableWindows, isWindowBookable } = await import("../src/calendar.js");
const { runTurn } = await import("../src/agent.js");
const { executeTool } = await import("../src/tools.js");

// Friday, October 2, 2026, 3:00 PM in Austin (CDT, UTC-5).
const NOW = new Date("2026-10-02T20:00:00Z");
let config;

before(() => {
  config = { ...loadClientConfig("demo-hvac"), slug: `test-${Date.now()}` };
});

function fakeClient(steps) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (params) => {
          calls.push(structuredClone(params));
          const step = steps.shift();
          if (step instanceof Error) throw step;
          return { model: params.model, usage: {}, ...step };
        },
      },
    },
  };
}

test("availability skips past windows today and closed days", () => {
  const slots = availableWindows(config, NOW, null, 20);
  assert.ok(slots.length > 0);
  assert.ok(!slots.some((s) => s.date === "2026-10-02"), "today's windows have all started");
  assert.ok(!slots.some((s) => s.weekday === "Sunday"), "closed on Sundays");
  assert.deepEqual(slots[0], { date: "2026-10-03", weekday: "Saturday", arrival_window: "8-11 AM" });
  assert.equal(isWindowBookable(config, "2026-10-20", "8-11 AM", NOW).ok, false, "beyond days_ahead");
});

test("booking a full turn: check availability, book, reply", async () => {
  const history = [];
  const client = fakeClient([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "check_availability", input: { preferred_date: null } }] },
    {
      stop_reason: "tool_use",
      content: [{
        type: "tool_use", id: "t2", name: "book_appointment",
        input: {
          customer_name: "Ana Lopez", phone: "512-555-0199", address: "100 Main St", zip_code: "78704",
          service_type: "AC repair", issue_description: "AC blowing warm air",
          date: "2026-10-03", arrival_window: "8-11 AM", notes: null,
        },
      }],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "You're booked for Saturday 8-11 AM." }] },
  ]);

  const { reply } = await runTurn({ config, history, userText: "My AC is blowing warm air", sessionId: "s-123456", now: NOW, client });
  assert.equal(reply, "You're booked for Saturday 8-11 AM.");
  assert.deepEqual(history.map((m) => m.role), ["user", "system", "assistant", "user", "assistant", "user", "assistant"]);
  assert.match(history[1].content, /Friday, October 2, 2026/);

  const first = client.calls[0];
  assert.equal(first.fallbacks, "default");
  assert.equal(first.tools.length, 4);
  assert.match(first.system[0].text, /Bluebonnet Heating & Air/);
  assert.doesNotMatch(first.system[0].text, /webhook_url/);
  assert.deepEqual(first.system[0].cache_control, { type: "ephemeral", ttl: "1h" }, "fixed instructions get their own 1-hour cache point");
  assert.deepEqual(first.tools.at(-1).cache_control, { type: "ephemeral", ttl: "1h" }, "tools are cached too");
  assert.equal(first.tools.filter((t) => t.cache_control).length, 1, "only one marker on the tools");
  assert.deepEqual(first.cache_control, { type: "ephemeral" }, "conversation tail keeps the 5-minute automatic cache");

  const bookings = readEvents(config.slug).filter((e) => e.type === "booking");
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].data.customer_name, "Ana Lopez");

  // The second turn appends to the same history; the system prompt is identical (cacheable).
  const client2 = fakeClient([{ stop_reason: "end_turn", content: [{ type: "text", text: "Anything else?" }] }]);
  await runTurn({ config, history, userText: "thanks", sessionId: "s-123456", now: NOW, client: client2 });
  assert.deepEqual(client2.calls[0].system, first.system);
  assert.equal(history.length, 10);
});

test("window capacity and service area are enforced", async () => {
  const ctx = { config, sessionId: "s-cap", channel: "web", now: NOW };
  const input = {
    customer_name: "X", phone: "1", address: "a", zip_code: "78704", service_type: "AC repair",
    issue_description: "x", date: "2026-10-05", arrival_window: "2-5 PM", notes: null,
  };
  assert.equal((await executeTool("book_appointment", input, ctx)).isError, false);
  assert.equal((await executeTool("book_appointment", input, ctx)).isError, false);
  const full = await executeTool("book_appointment", input, ctx);
  assert.equal(full.isError, true);
  assert.match(full.content, /fully booked/);

  const outside = await executeTool("book_appointment", { ...input, date: "2026-10-06", zip_code: "10001" }, ctx);
  assert.equal(outside.isError, true);
  assert.match(outside.content, /outside the service area/);
});

test("API errors and refusals roll back the unanswered turn", async () => {
  const history = [];
  await assert.rejects(
    runTurn({ config, history, userText: "hi", sessionId: "s-err", now: NOW, client: fakeClient([new Error("boom")]) }),
  );
  assert.equal(history.length, 0);

  const { reply } = await runTurn({
    config, history, userText: "hi", sessionId: "s-err", now: NOW,
    client: fakeClient([{ stop_reason: "refusal", content: [] }]),
  });
  assert.match(reply, /call us/);
  assert.equal(history.length, 0);
});
