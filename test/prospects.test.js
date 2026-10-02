import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanWebsite, rankLeads } from "../src/prospects/score.js";
import { parseCsv, toCsv } from "../src/prospects/load.js";
import { OutscraperClient, pickContact } from "../src/prospects/outscraper.js";
import { personalizeLead } from "../src/prospects/personalize.js";

const HOUSTON = { latitude: 29.76, longitude: -95.37 };
let n = 0;
const row = (over) => ({
  name: "Bayou Plumbing",
  type: "Plumber",
  subtypes: "Plumber, Drainage service",
  ...HOUSTON,
  city: "Houston",
  phone: "+1 713-555-0100",
  website: `https://www.plumber${++n}.com/`,
  rating: 4.8,
  reviews: 120,
  reviews_per_score_1: 2,
  business_status: "OPERATIONAL",
  place_id: `id-${Math.random()}`,
  ...over,
});

test("cleanWebsite strips URL-encoded tracking params", () => {
  assert.deepEqual(cleanWebsite("https://txhydrojet.com/%3Futm_source%3Dgoogle"), {
    url: "https://txhydrojet.com/",
    domain: "txhydrojet.com",
  });
  assert.equal(cleanWebsite("not a url"), null);
});

test("rankLeads scores the niche and excludes poor fits with a reason", () => {
  const leads = rankLeads([
    row({ name: "Software Inc", type: "Software company", subtypes: "Software company" }),
    row({ name: "Dallas Plumbing", latitude: 32.78, longitude: -96.8 }),
    row({ name: "Huge Plumbing", reviews: 9000 }),
    row({ name: "Roto-Rooter Plumbing" }),
    row({ name: "No Phone Plumbing", phone: null }),
    row({ name: "Bayou Plumbing", website: "https://www.bayouplumbing.com/" }),
    row({ name: "Bayou Plumbing Copy", website: "https://bayouplumbing.com/contact" }),
    row({
      name: "Plomería Garza",
      about: '{"Other": {"Identifies as Latino-owned": true}}',
      working_hours: JSON.stringify(Object.fromEntries(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => [d, ["Open 24 hours"]]))),
      website: "https://plomeriagarza.com",
    }),
  ]);
  const byName = Object.fromEntries(leads.map((l) => [l.name, l]));
  assert.match(byName["Software Inc"].excluded, /fuera del nicho/);
  assert.match(byName["Dallas Plumbing"].excluded, /Fuera de Houston/);
  assert.match(byName["Huge Plumbing"].excluded, /Empresa grande/);
  assert.equal(byName["Roto-Rooter Plumbing"].excluded, "Franquicia nacional");
  assert.equal(byName["No Phone Plumbing"].excluded, "Sin teléfono");
  assert.equal(byName["Bayou Plumbing Copy"].excluded, "Duplicado");

  assert.equal(byName["Bayou Plumbing"].score, 30 + 25 + 10);
  assert.equal(byName["Plomería Garza"].score, 30 + 25 + 10 + 10 + 8);
  assert.equal(leads[0].name, "Plomería Garza", "best lead first");
  assert.equal(leads[0].priority, "A");
  assert.ok(leads.at(-1).excluded, "excluded leads last");
});

test("CSV round trip keeps commas, quotes and newlines", () => {
  const rows = [{ a: 'He said "hi", twice', b: "line1\nline2", c: null }];
  const parsed = parseCsv(toCsv(rows, ["a", "b", "c"]));
  assert.deepEqual(parsed[0], ["a", "b", "c"]);
  assert.deepEqual(parsed[1], ['He said "hi", twice', "line1\nline2", null]);
});

test("pickContact prefers a named owner, then a person, then a personal inbox", () => {
  const owner = pickContact({
    contacts: [
      { full_name: "jane doe", title: "Office Manager", emails: [{ value: "jane@x.com" }] },
      { full_name: "CARLOS RUIZ", title: "Owner", emails: [{ value: "carlos@x.com" }] },
    ],
  });
  assert.deepEqual(owner, { name: "CARLOS RUIZ", title: "Owner", email: "carlos@x.com", first_name: "Carlos", email_type: "owner" });
  assert.equal(pickContact({ emails: [{ value: "info@x.com" }, { value: "mike@x.com" }] }).email, "mike@x.com");
  assert.equal(pickContact({ emails: [{ value: "info@x.com" }] }).email_type, "general");
  assert.equal(pickContact({ emails: [], contacts: [] }), null);
});

test("OutscraperClient sends the key, repeats query params and polls async requests", async () => {
  const calls = [];
  const replies = [
    { status: 202, body: { id: "r1", status: "Pending", results_location: "https://api.outscraper.cloud/requests/r1" } },
    { status: 200, body: { id: "r1", status: "Pending" } },
    { status: 200, body: { id: "r1", status: "Success", data: [{ query: "a.com", emails: [{ value: "bob@a.com" }] }, { query: "b.com", emails: [] }] } },
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), key: init.headers["X-API-KEY"] });
    const r = replies.shift();
    return { status: r.status, ok: r.status < 300, json: async () => r.body, text: async () => "" };
  };
  const client = new OutscraperClient({ apiKey: "k", fetchImpl, pollMs: 1 });
  const results = await client.contactsFor(["a.com", "b.com"]);
  assert.equal(results[0].emails[0].value, "bob@a.com");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.key === "k"));
  assert.match(calls[0].url, /leads-and-contacts\?query=a\.com&query=b\.com/);
});

test("personalizeLead drops review quotes that are not in the reviews", async () => {
  const fake = {
    beta: {
      messages: {
        create: async (params) => {
          assert.equal(params.output_config.format.type, "json_schema");
          return {
            stop_reason: "end_turn",
            content: [{
              type: "text",
              text: JSON.stringify({
                fit: "strong",
                pain_quotes: ["never called me back", "they ignored me for weeks"],
                first_line: "A couple of reviews mention trouble reaching the office after hours.",
                spanish_angle: false,
                note_es: "Buen prospecto.",
              }),
            }],
          };
        },
      },
    },
  };
  const lead = { name: "Bayou Plumbing", category: "Plumber", reviews: 120 };
  const result = await personalizeLead(lead, [{ rating: 1, text: "Left a voicemail, they never called me back." }], fake);
  assert.deepEqual(result.pain_quotes, ["never called me back"]);
  assert.equal(result.fit, "strong");
});
