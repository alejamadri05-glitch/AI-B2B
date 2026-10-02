// Small client for the two Outscraper endpoints the pipeline pays for:
// contacts (emails + named people) per website, and recent reviews per place.
// Docs: https://app.outscraper.cloud/api-docs (auth with the X-API-KEY header).

const BASE_URL = process.env.OUTSCRAPER_BASE_URL || "https://api.outscraper.cloud";
const POLL_MS = 5000;
const MAX_WAIT_MS = 10 * 60 * 1000;

export class OutscraperClient {
  constructor({ apiKey = process.env.OUTSCRAPER_API_KEY, fetchImpl = fetch, pollMs = POLL_MS } = {}) {
    if (!apiKey) throw new Error("Set OUTSCRAPER_API_KEY to call the Outscraper API.");
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.pollMs = pollMs;
  }

  async get(pathname, params) {
    const url = new URL(pathname, BASE_URL);
    for (const [key, value] of Object.entries(params)) {
      for (const v of [value].flat()) if (v !== undefined && v !== null) url.searchParams.append(key, String(v));
    }
    const res = await this.fetch(url, { headers: { "X-API-KEY": this.apiKey } });
    if (res.status === 401) throw new Error("Outscraper rejected the API key (401).");
    if (res.status === 402) throw new Error("Outscraper balance is too low (402). Add credits and run again.");
    if (!res.ok && res.status !== 202) throw new Error(`Outscraper ${pathname} failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    return res.status === 202 || body.status === "Pending" ? this.waitFor(body.results_location ?? `${BASE_URL}/requests/${body.id}`) : body;
  }

  async waitFor(location) {
    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      const res = await this.fetch(location, { headers: { "X-API-KEY": this.apiKey } });
      const body = await res.json();
      if (body.status === "Success") return body;
      if (body.status && body.status !== "Pending") throw new Error(`Outscraper request ended with status ${body.status}`);
    }
    throw new Error(`Outscraper request did not finish in ${MAX_WAIT_MS / 60000} minutes: ${location}`);
  }

  // One result per domain, in the same order: { domain, emails, contacts }.
  async contactsFor(domains) {
    const results = [];
    for (let i = 0; i < domains.length; i += 100) {
      const batch = domains.slice(i, i + 100);
      const body = await this.get("/leads-and-contacts", { query: batch, contactsPerCompany: 3, async: true });
      const byQuery = new Map(body.data.flat().map((d) => [d.query, d]));
      results.push(...batch.map((domain) => byQuery.get(domain) ?? { query: domain, emails: [], contacts: [] }));
    }
    return results;
  }

  // Up to `limit` recent reviews that mention calls, answers or response time.
  async responsivenessReviews(placeId, limit = 10) {
    const body = await this.get("/google-maps-reviews", {
      query: placeId,
      reviewsLimit: limit,
      reviewsQuery: "call | called | answer | voicemail | respond | response | reach | callback | phone",
      sort: "newest",
      ignoreEmpty: true,
      async: false,
    });
    const place = body.data?.flat()[0];
    return (place?.reviews_data ?? []).map((r) => ({
      rating: r.review_rating,
      date: r.review_datetime_utc,
      text: String(r.review_text ?? "").slice(0, 600),
    }));
  }
}

const GENERIC_PREFIXES = /^(info|contact|office|service|sales|support|admin|hello|help|team|customerservice|dispatch|billing)@/i;
const OWNER_TITLES = /owner|founder|president|ceo|principal|partner|general manager/i;

// Picks the best address to email: a named owner > any named person > a general inbox.
export function pickContact(result) {
  const named = (result.contacts ?? [])
    .map((c) => ({ name: c.full_name ?? null, title: c.title ?? null, email: c.emails?.[0]?.value ?? null }))
    .filter((c) => c.email);
  const owner = named.find((c) => OWNER_TITLES.test(c.title ?? ""));
  const person = owner ?? named[0];
  if (person) return { ...person, first_name: firstName(person.name), email_type: owner ? "owner" : "person" };

  const emails = (result.emails ?? []).map((e) => e.value).filter(Boolean);
  const personal = emails.find((e) => !GENERIC_PREFIXES.test(e));
  const email = personal ?? emails[0] ?? null;
  return email ? { name: null, title: null, email, first_name: null, email_type: personal ? "person" : "general" } : null;
}

function firstName(fullName) {
  const first = String(fullName ?? "").trim().split(/\s+/)[0];
  if (!first || first.length < 2) return null;
  return first[0].toUpperCase() + first.slice(1).toLowerCase();
}
