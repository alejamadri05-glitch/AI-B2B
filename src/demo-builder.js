// Builds a demo client config from a prospect's public website: Claude reads
// the site with the web fetch tool and returns a structured business profile.
// Used by scripts/new-prospect.js (one prospect) and scripts/prospects.js (a batch).
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ROOT_DIR } from "./store.js";

const MODEL = process.env.MODEL || "claude-opus-5-5";

const nullableString = { type: ["string", "null"] };
const saveProfileTool = {
  name: "save_business_profile",
  description: "Save the business profile extracted from the website. Call exactly once, when you are done reading.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      business_name: { type: "string" },
      trade: { type: "string", description: "Main trade, e.g. 'plumbing', 'HVAC (heating and air conditioning)', 'roofing'." },
      city_state: { type: "string", description: "Main city and state, e.g. 'Tampa, FL'." },
      phone: nullableString,
      timezone: { type: "string", description: "IANA time zone of the business, e.g. America/New_York." },
      brand_color: { ...nullableString, description: "Main brand color as #rrggbb if evident, else null." },
      hours: nullableString,
      service_area_description: { type: "string" },
      zip_codes: { type: "array", items: { type: "string" }, description: "Only ZIP codes explicitly listed on the site." },
      services: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, description: { type: "string" } },
          required: ["name", "description"],
          additionalProperties: false,
        },
      },
      diagnostic_fee: nullableString,
      pricing_notes: { type: "array", items: { type: "string" } },
      financing: nullableString,
      warranties: nullableString,
      emergency_service_24_7: { type: "boolean" },
      faqs: {
        type: "array",
        items: {
          type: "object",
          properties: { q: { type: "string" }, a: { type: "string" } },
          required: ["q", "a"],
          additionalProperties: false,
        },
      },
      review_notes: {
        type: "array",
        items: { type: "string" },
        description: "Anything uncertain or missing that a human should verify.",
      },
    },
    required: [
      "business_name", "trade", "city_state", "phone", "timezone", "brand_color", "hours",
      "service_area_description", "zip_codes", "services", "diagnostic_fee", "pricing_notes",
      "financing", "warranties", "emergency_service_24_7", "faqs", "review_notes",
    ],
    additionalProperties: false,
  },
};

// Returns the extracted profile, or null if Claude never saved one.
export async function extractProfile(url, client = new Anthropic()) {
  const messages = [
    {
      role: "user",
      content: `Read the website of this home-services business: ${url}
  Fetch the home page and, if needed, up to a few linked pages such as services, service area, about, FAQ or financing.
  Then call save_business_profile with what you found. Use only facts stated on the site; use null or empty lists for anything not stated, and list doubts in review_notes. Do not invent prices, ZIP codes or policies.`,
    },
  ];

  let profile = null;
  for (let round = 0; round < 10 && !profile; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      tools: [{ type: "web_fetch_20260209", name: "web_fetch", max_uses: 6 }, saveProfileTool],
      messages,
    });
    if (response.stop_reason === "refusal") {
      throw new Error("The request was declined. Try a different page of the site.");
    }
    messages.push({ role: "assistant", content: response.content });
    const save = response.content.find((b) => b.type === "tool_use" && b.name === "save_business_profile");
    if (save) profile = save.input;
    else if (response.stop_reason === "pause_turn") continue;
    else messages.push({ role: "user", content: "Please call save_business_profile now with what you found." });
  }
  return profile;
}

export function profileToConfig(profile, slug, url) {
  const template = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "clients", "_template.json"), "utf8"));
  const agentName = template.agent_name;
  return {
    ...template,
    slug,
    demo: true,
    business_name: profile.business_name,
    trade: profile.trade,
    city_state: profile.city_state,
    phone: profile.phone ?? "",
    website: url,
    timezone: profile.timezone,
    brand_color: /^#[0-9a-f]{6}$/i.test(profile.brand_color ?? "") ? profile.brand_color : template.brand_color,
    greeting: `Hi! I'm ${agentName}, the virtual assistant for ${profile.business_name}. How can I help you today?`,
    hours: profile.hours ?? "",
    service_area: { description: profile.service_area_description, zip_codes: profile.zip_codes },
    services: profile.services,
    pricing: {
      diagnostic_fee: profile.diagnostic_fee ?? "",
      notes: [...profile.pricing_notes, "Never quote a repair or installation total in chat."],
    },
    financing: profile.financing ?? "",
    warranties: profile.warranties ?? "",
    emergency: { ...template.emergency, available_24_7: profile.emergency_service_24_7 },
    faqs: profile.faqs,
    escalation: { transfer_phone: profile.phone ?? "" },
    _review_before_demo: profile.review_notes,
  };
}

export function writeClientConfig(config) {
  const file = path.join(ROOT_DIR, "clients", `${config.slug}.json`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return file;
}
