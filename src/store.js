// Event log per client: one JSON object per line in data/<slug>.jsonl.
// Good enough for demos and the first few clients; swap for a real database
// (or let n8n write to a Google Sheet / CRM through the webhook) later.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, "..");
// Demo and template configs ship with the repo (clients/). Clients published
// through onboarding go to CLIENTS_DIR, which should be a persistent disk in
// production; it is checked first.
const REPO_CLIENTS_DIR = path.join(ROOT_DIR, "clients");

export function liveClientsDir() {
  const dir = process.env.CLIENTS_DIR || REPO_CLIENTS_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function clientDirs() {
  return [...new Set([liveClientsDir(), REPO_CLIENTS_DIR])];
}

export function dataDir() {
  const dir = process.env.DATA_DIR || path.join(ROOT_DIR, "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidSlug(slug) {
  return typeof slug === "string" && SLUG_RE.test(slug);
}

export function loadClientConfig(slug) {
  if (!isValidSlug(slug)) return null;
  for (const dir of clientDirs()) {
    const file = path.join(dir, `${slug}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  }
  return null;
}

export function listClientSlugs() {
  const slugs = clientDirs().flatMap((dir) =>
    fs.readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_")).map((f) => f.slice(0, -5)),
  );
  return [...new Set(slugs)].filter(isValidSlug);
}

export function appendEvent(slug, event) {
  const record = { id: newId(), at: new Date().toISOString(), ...event };
  fs.appendFileSync(path.join(dataDir(), `${slug}.jsonl`), JSON.stringify(record) + "\n");
  return record;
}

export function readEvents(slug) {
  return readJsonl(path.join(dataDir(), `${slug}.jsonl`));
}

// Conversation log: one line per message in data/<slug>.messages.jsonl.
// Holds customers' names and phone numbers: keep data/ private and out of git.
export function appendMessage(slug, message) {
  const record = { at: new Date().toISOString(), ...message };
  fs.appendFileSync(path.join(dataDir(), `${slug}.messages.jsonl`), JSON.stringify(record) + "\n");
  return record;
}

export function readMessages(slug) {
  return readJsonl(path.join(dataDir(), `${slug}.messages.jsonl`));
}

// Groups messages by session: [{ session_id, channel, started_at, last_at, messages }], newest first.
export function readConversations(slug) {
  const bySession = new Map();
  for (const m of readMessages(slug)) {
    if (!bySession.has(m.session_id)) {
      bySession.set(m.session_id, { session_id: m.session_id, channel: m.channel, started_at: m.at, last_at: m.at, messages: [] });
    }
    const c = bySession.get(m.session_id);
    c.last_at = m.at;
    c.messages.push({ at: m.at, role: m.role, text: m.text, ...(m.error ? { error: true } : {}) });
  }
  return [...bySession.values()].sort((a, b) => b.last_at.localeCompare(a.last_at));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function countBookings(slug, date, windowLabel) {
  return readEvents(slug).filter(
    (e) => e.type === "booking" && e.data.date === date && e.data.arrival_window === windowLabel,
  ).length;
}

function newId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
