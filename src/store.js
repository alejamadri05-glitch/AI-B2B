// Event log per client: one JSON object per line in data/<slug>.jsonl.
// Good enough for demos and the first few clients; swap for a real database
// (or let n8n write to a Google Sheet / CRM through the webhook) later.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, "..");
const CLIENTS_DIR = path.join(ROOT_DIR, "clients");

function dataDir() {
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
  const file = path.join(CLIENTS_DIR, `${slug}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function appendEvent(slug, event) {
  const record = { id: newId(), at: new Date().toISOString(), ...event };
  fs.appendFileSync(path.join(dataDir(), `${slug}.jsonl`), JSON.stringify(record) + "\n");
  return record;
}

export function readEvents(slug) {
  const file = path.join(dataDir(), `${slug}.jsonl`);
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
