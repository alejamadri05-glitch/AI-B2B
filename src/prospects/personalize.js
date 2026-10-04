// Writes the personal first line of the cold email for one lead, from its
// Google Maps facts and recent reviews about calls and response time.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.MODEL || "claude-opus-5-5";

const SCHEMA = {
  type: "object",
  properties: {
    fit: { type: "string", enum: ["strong", "medium", "weak"] },
    pain_quotes: {
      type: "array",
      items: { type: "string" },
      description: "Short verbatim excerpts (under 20 words) from the reviews that show customers struggling to reach the business. Empty if none.",
    },
    first_line: { type: "string" },
    spanish_angle: { type: "boolean" },
    note_es: { type: "string" },
  },
  required: ["fit", "pain_quotes", "first_line", "spanish_angle", "note_es"],
  additionalProperties: false,
};

const SYSTEM = `You help a founder who sells an AI receptionist to US home-services companies (HVAC, plumbing, electrical, roofing). The receptionist answers website chats 24/7, books jobs into arrival windows, captures leads and texts the owner about emergencies, in English or Spanish.

For one business, you get facts from its Google Maps listing and up to 10 recent reviews that mention calls or response time. Return:
- fit: "strong" if reviews show customers struggling to reach them, or the business promises 24/7 or emergency service; "weak" if it looks like a large company with a call center or a business that rarely gets urgent calls; otherwise "medium".
- pain_quotes: short excerpts copied exactly from the reviews (no edits) that show trouble reaching the business. Never use praise as pain.
- first_line: the first sentence of a cold email to the owner, in English, at most 30 words. It must mention one specific, true detail from the facts or reviews (the city, the number of reviews, 24-hour service, a pattern in reviews). If you reference complaints, be tactful ("a couple of reviews mention trouble reaching the office"), never quote a customer insulting them. If reviews praise fast replies, frame the demo as keeping that up after hours. No flattery, no exclamation marks, no claims that the founder called them or used their service, no statistics, no invented facts.
- spanish_angle: true when the business or its customers likely speak Spanish (Latino-owned, Spanish name, or Spanish reviews).
- note_es: one sentence in Spanish for the founder: why this lead is or isn't worth it.`;

export async function personalizeLead(lead, reviews, client = new Anthropic()) {
  const facts = {
    name: lead.name,
    category: lead.category,
    other_categories: lead.subtypes,
    city: lead.city,
    google_rating: lead.rating,
    google_reviews: lead.reviews,
    one_star_reviews: lead.one_star,
    lists_open_24_hours: lead.hours_24,
    latino_owned: lead.latino_owned,
    has_online_booking_link: lead.has_booking_link,
    website: lead.website,
  };
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    // Same instructions for every lead in a batch: cached after the first one.
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: `Business facts (JSON):\n${JSON.stringify(facts, null, 2)}\n\nRecent reviews mentioning calls or response time (JSON):\n${JSON.stringify(reviews, null, 2)}`,
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error(`Declined for ${lead.name}`);
  const text = response.content.find((b) => b.type === "text")?.text;
  const result = JSON.parse(text);

  // Keep only quotes that really appear in the reviews, so nothing invented reaches an email.
  const corpus = reviews.map((r) => r.text.toLowerCase()).join("\n");
  result.pain_quotes = result.pain_quotes.filter((q) => q.trim() && corpus.includes(q.trim().toLowerCase()));
  return result;
}
