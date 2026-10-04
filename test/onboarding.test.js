import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "receptionist-onboarding-test-"));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLIENTS_DIR = path.join(tmp, "clients");
process.env.PUBLIC_URL = "https://app.example.com";

const ob = await import("../src/onboarding.js");
const { loadClientConfig } = await import("../src/store.js");

// Collect what would be sent to n8n.
const notifications = [];
let hook;
before(async () => {
  hook = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    notifications.push(JSON.parse(body));
    res.end("ok");
  });
  await new Promise((r) => hook.listen(0, r));
  process.env.ONBOARDING_WEBHOOK_URL = `http://127.0.0.1:${hook.address().port}/hook`;
});
after(() => hook.close());

const fakeQa = (passed = 11) => async () => ({ passed, total: 11, failures: [], report_file: "x.json", at: new Date().toISOString() });

function validForm(over = {}) {
  const hours = Object.fromEntries(ob.DAYS.map((d) => [d, { open: !["Saturday", "Sunday"].includes(d), from: "08:00", to: "17:00" }]));
  return {
    business_name: "Bayou Plumbing",
    trade: "plumbing",
    city_state: "Houston, TX",
    timezone: "America/Chicago",
    phone: "(713) 555-0100",
    website: "https://bayouplumbing.com",
    agent_name: "",
    brand_color: "#0a7f5a",
    office_hours: hours,
    service_area_description: "Houston and Katy",
    zip_codes: "77002, 77003\n77494 and 7700 (typo)",
    services: [{ name: "Drain cleaning", description: "Kitchen and main lines" }, { name: "", description: "" }],
    diagnostic_fee: "$79",
    how_we_quote: "Upfront price after diagnosis",
    after_hours_fee: "",
    other_prices: "Water heater flush: $150\n\n",
    never_share: "Discounts",
    financing: "",
    warranties: "1 year on labor",
    emergency_24_7: true,
    emergency_examples: "Burst pipes",
    on_call_response: "",
    alerts_phone: "713-555-0111",
    transfer_phone: "",
    arrival_windows: [{ label: "8-12", start_hour: "8" }, { label: "12-4", start_hour: "12" }],
    closed_days: ["Sunday"],
    days_ahead: "7",
    jobs_per_window: "3",
    scheduling_software: "Housecall Pro",
    faqs: [{ q: "Do you do sewer cameras?", a: "Yes." }],
    alerts_email: "office@bayouplumbing.com",
    report_email: "owner@bayouplumbing.com",
    avg_ticket: 300,
    consent_name: "Carlos Ruiz",
    consent_title: "Owner",
    consent: true,
    ...over,
  };
}

test("formToConfig builds a complete client config", () => {
  const { config, errors } = ob.formToConfig(validForm(), { slug: "bayou-plumbing" });
  assert.equal(errors, undefined);
  assert.equal(config.slug, "bayou-plumbing");
  assert.equal(config.demo, false);
  assert.equal(config.agent_name, "Riley");
  assert.match(config.greeting, /Riley, the virtual assistant for Bayou Plumbing/);
  assert.deepEqual(config.service_area.zip_codes, ["77002", "77003", "77494"]);
  assert.deepEqual(config.office_hours.Monday, ["08:00", "17:00"]);
  assert.equal(config.office_hours.Saturday, null);
  assert.match(config.hours, /Monday 08:00-17:00.*Closed Saturday, Sunday\. 24\/7 emergency service\./);
  assert.equal(config.services.length, 1);
  assert.deepEqual(config.booking.arrival_windows, [{ label: "8-12", start_hour: 8 }, { label: "12-4", start_hour: 12 }]);
  assert.equal(config.booking.jobs_per_window, 3);
  assert.deepEqual(config.pricing.other_prices, ["Water heater flush: $150"]);
  assert.equal(config.pricing.how_we_quote, "Upfront price after diagnosis");
  assert.ok(config.pricing.notes.includes("Never share: Discounts"));
  assert.equal(config.escalation.transfer_phone, "(713) 555-0100");
  assert.equal(config.report.avg_ticket, 300);
  assert.equal(config._onboarding.consent.name, "Carlos Ruiz");
});

test("formToConfig reports every problem by field", () => {
  const { errors } = ob.formToConfig(
    validForm({
      phone: "",
      timezone: "Europe/Madrid",
      services: [],
      report_email: "nope",
      consent: false,
      office_hours: { ...validForm().office_hours, Monday: { open: true, from: "18:00", to: "08:00" } },
      arrival_windows: [{ label: "late", start_hour: "25" }],
    }),
    { slug: "x" },
  );
  for (const field of ["phone", "timezone", "services", "report_email", "consent", "office_hours.Monday", "arrival_windows"]) {
    assert.ok(errors[field], field);
  }
});

test("full lifecycle: submit, test, request changes, resubmit, publish", async () => {
  const { invite } = ob.createInvite({ business_name: "Bayou Plumbing", contact_email: "owner@bayouplumbing.com" });
  assert.equal(invite.status, "open");
  assert.equal(ob.publicInvite(invite).approve_key, undefined);
  assert.equal(ob.publicInvite(invite).form.report_email, "owner@bayouplumbing.com");

  const bad = await ob.submitForm(invite.token, { business_name: "x" }, { runQa: fakeQa() });
  assert.equal(bad.status, 400);

  const ok = await ob.submitForm(invite.token, validForm(), { runQa: fakeQa(10) });
  assert.equal(ok.status, 200);
  await ok.done;
  let current = ob.loadInvite(invite.token);
  assert.equal(current.status, "review");
  assert.equal(current.qa.passed, 10);
  assert.equal((await ob.submitForm(invite.token, validForm(), { runQa: fakeQa() })).status, 409, "no double submit");

  assert.equal((await ob.publish(invite.token, "wrong-key")).status, 401);
  assert.equal((await ob.requestChanges(invite.token, current.approve_key, "Please add your Saturday hours.")).status, 200);
  current = ob.loadInvite(invite.token);
  assert.equal(current.status, "changes_requested");
  assert.equal(ob.publicInvite(current).changes_requested, "Please add your Saturday hours.");

  const resubmit = await ob.submitForm(invite.token, validForm({ office_hours: { ...validForm().office_hours, Saturday: { open: true, from: "09:00", to: "13:00" } } }), { runQa: fakeQa() });
  await resubmit.done;
  const published = await ob.publish(invite.token, current.approve_key);
  assert.equal(published.status, 200);

  const live = loadClientConfig(invite.slug);
  assert.ok(fs.existsSync(path.join(process.env.CLIENTS_DIR, `${invite.slug}.json`)), "written to CLIENTS_DIR");
  assert.deepEqual(live.office_hours.Saturday, ["09:00", "13:00"]);
  assert.ok(live.dashboard_token.length > 20, "client gets its own dashboard token");
  assert.equal(ob.loadInvite(invite.token).status, "live");

  const types = notifications.filter((n) => n.slug === invite.slug).map((n) => n.type);
  assert.deepEqual(types, ["submitted", "ready_for_review", "changes_requested", "submitted", "ready_for_review", "live"]);
  const liveNote = notifications.find((n) => n.slug === invite.slug && n.type === "live");
  assert.match(liveNote.links.widget, new RegExp(`data-client="${invite.slug}"`));
  assert.match(liveNote.links.dashboard, new RegExp(`token=${live.dashboard_token}`));
  assert.match(liveNote.links.form, /^https:\/\/app\.example\.com\/onboarding\.html\?invite=/);
});

test("slugs stay unique across invites and live clients", () => {
  const a = ob.createInvite({ business_name: "Bayou Plumbing" }).invite;
  assert.notEqual(a.slug, "bayou-plumbing");
  assert.match(a.slug, /^bayou-plumbing-\d+$/);
});

test("a late website prefill never overwrites a submitted form", async () => {
  let release;
  const slowPrefill = () => new Promise((r) => (release = () => r({ trade: "plumbing" })));
  const { invite, ready } = ob.createInvite({ business_name: "Slow Site Co", website: "https://slow.example.com" }, { prefill: slowPrefill });
  assert.equal(invite.status, "prefilling");
  const sub = await ob.submitForm(invite.token, validForm({ business_name: "Slow Site Co" }), { runQa: fakeQa() });
  await sub.done;
  release();
  await ready;
  assert.equal(ob.loadInvite(invite.token).status, "review");
});

test("a QA crash still lands in review with the error shown", async () => {
  const { invite } = ob.createInvite({ business_name: "Crashy HVAC" });
  const sub = await ob.submitForm(invite.token, validForm({ business_name: "Crashy HVAC" }), {
    runQa: async () => {
      throw new Error("no API key");
    },
  });
  await sub.done;
  const current = ob.loadInvite(invite.token);
  assert.equal(current.status, "review");
  assert.equal(current.qa.error, "no API key");
});
