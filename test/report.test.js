import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "receptionist-report-test-"));

const { appendEvent, appendMessage, loadClientConfig, readConversations } = await import("../src/store.js");
const { isAfterHours } = await import("../src/calendar.js");
const { buildReport, computeMetrics, previousMonth } = await import("../src/report.js");

const config = { ...loadClientConfig("demo-hvac"), slug: `report-${Date.now()}` };

// Write records with a fixed timestamp (the store stamps "now" otherwise).
function at(iso, fn) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) {
      super(...(a.length ? a : [iso]));
    }
  };
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

test("after-hours uses the client's office hours and time zone", () => {
  // demo-hvac: Mon-Fri 7-18, Sat 8-14, closed Sunday (America/Chicago, UTC-5 in October).
  assert.equal(isAfterHours(config, "2026-10-02T20:00:00Z"), false, "Fri 3 PM");
  assert.equal(isAfterHours(config, "2026-10-03T01:30:00Z"), true, "Fri 8:30 PM");
  assert.equal(isAfterHours(config, "2026-10-03T18:00:00Z"), false, "Sat 1 PM");
  assert.equal(isAfterHours(config, "2026-10-04T17:00:00Z"), true, "Sunday");
});

test("previousMonth wraps the year", () => {
  assert.equal(previousMonth(new Date("2026-01-10T18:00:00Z"), "America/Chicago"), "2025-12");
  assert.equal(previousMonth(new Date("2026-11-01T18:00:00Z"), "America/Chicago"), "2026-10");
});

test("conversation log groups messages by session, newest first", () => {
  const slug = `${config.slug}-log`;
  at("2026-10-05T15:00:00Z", () => appendMessage(slug, { session_id: "a", channel: "web", role: "customer", text: "hi" }));
  at("2026-10-05T15:00:05Z", () => appendMessage(slug, { session_id: "a", channel: "web", role: "assistant", text: "hello" }));
  at("2026-10-06T15:00:00Z", () => appendMessage(slug, { session_id: "b", channel: "sms", role: "customer", text: "AC broken" }));
  const convs = readConversations(slug);
  assert.deepEqual(convs.map((c) => c.session_id), ["b", "a"]);
  assert.equal(convs[1].messages.length, 2);
});

test("monthly metrics count only the month, in the client's time zone", () => {
  // In October: one daytime conversation with a booking, one after-hours conversation with a lead.
  at("2026-10-05T15:00:00Z", () => appendMessage(config.slug, { session_id: "s1", channel: "web", role: "customer", text: "Need AC repair" }));
  at("2026-10-05T15:01:00Z", () => appendEvent(config.slug, { type: "booking", session_id: "s1", data: { date: "2026-10-06", arrival_window: "8-11 AM", customer_name: "<script>Ana</script>", service_type: "AC repair" } }));
  at("2026-10-08T03:00:00Z", () => appendMessage(config.slug, { session_id: "s2", channel: "web", role: "customer", text: "How much is a tune-up?" }));
  at("2026-10-08T03:02:00Z", () => appendEvent(config.slug, { type: "lead", session_id: "s2", data: { phone: "512-555-0100", reason: "quote_request" } }));
  // Sept 30, 11 PM in Austin is Oct 1 in UTC: belongs to September.
  at("2026-10-01T04:00:00Z", () => appendMessage(config.slug, { session_id: "s3", channel: "web", role: "customer", text: "hello" }));

  const m = computeMetrics(config, "2026-10");
  assert.equal(m.conversations, 2);
  assert.equal(m.after_hours_conversations, 1);
  assert.equal(m.bookings, 1);
  assert.equal(m.leads_with_phone, 1);
  assert.equal(m.estimated_revenue, 350);
  assert.equal(computeMetrics(config, "2026-09").conversations, 1);
});

test("the report email escapes customer text and keeps internal notes out", async () => {
  const fake = {
    beta: {
      messages: {
        create: async (params) => {
          assert.match(params.messages[0].content, /Need AC repair/);
          return {
            stop_reason: "end_turn",
            content: [{ type: "text", text: JSON.stringify({ highlights: ["Most chats were about AC repairs."], faq_gaps: ["Do you service tankless water heaters?"], suggestions_es: ["Agregar precios de mantenimiento."] }) }],
          };
        },
      },
    },
  };
  const report = await buildReport(config, "2026-10", { client: fake });
  assert.equal(report.subject, "Bluebonnet Heating & Air: your AI receptionist in October 2026");
  assert.match(report.html, /\$350 in estimated revenue from 1 booked job/);
  assert.match(report.html, /Do you service tankless water heaters\?/);
  assert.match(report.html, /&lt;script&gt;Ana&lt;\/script&gt;/);
  assert.doesNotMatch(report.html, /<script>/);
  assert.doesNotMatch(report.html, /Agregar precios/);
  assert.deepEqual(report.internal_suggestions_es, ["Agregar precios de mantenimiento."]);
  assert.equal(report.metrics.conversation_list, undefined);
});
